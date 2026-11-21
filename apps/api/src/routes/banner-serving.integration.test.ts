import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { ulid } from "ulid";
import { and, eq } from "drizzle-orm";
import { createTestBindings, createTestClient, type TestClient } from "../test/helpers";
import { getTestDb, cleanupTestDb, closeTestDb } from "../test/setup";
import {
  analyticsRollups,
  apiKeys,
  apiUsageDaily,
  bannerConfigs,
  campaigns,
  experiments,
  products,
  subscriptions,
} from "../db/schema";
import type { Database } from "../db";
import { DEFAULT_BANNER_MESSAGE, DEFAULT_CTA_TEXT, PLAN_LIMITS } from "@gopaylocal/shared/constants";
import { assignVariant, visitorKey } from "../services/banner-selection";
import { bannerDocKey, isCurrentBannerDoc } from "../services/banner-cache.service";
import { usageMeter, utcDay } from "../services/usage-meter";
import { writeImpressionRows } from "../services/impression-meter";
import { BANNER_HOT_CACHE_TTL_MS, bannerDocCache, configureBannerHotCache } from "../services/banner-hot-cache";
import { recomputeUsageForAllOrgs, usageKey } from "../services/usage.service";
import bannerScriptRoute from "./banner-script";

// The route imports the browser bundle as a wrangler text module; stub it so
// the browser code never runs under Node (same as the unit tests).
vi.mock("../../../../packages/banner/dist/banner.js", () => ({ default: "" }));

/**
 * Banner serving end to end against Postgres: product-aware selection,
 * experiment arms, and server-side metering into api_usage_daily through the
 * usage cron to the quota check. Owned by banner-core; run by test-infra.
 *
 * Each test starts with an empty KV, so the first request takes the database
 * path and its background rebuild (settled by createTestClient) writes the
 * version-2 document; later requests in the same test use the document.
 */

// A new organization per test: the endpoint throttles background rebuilds per
// organization per isolate (60 s), and every test should get its own.
let ORG = "";
const IP = "203.0.113.20";
const UA = "Mozilla/5.0 (integration)";

async function sha256Hex(value: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

const db = () => getTestDb() as unknown as Database;

async function seedProduct(org: string, name: string): Promise<string> {
  const id = ulid();
  await getTestDb().insert(products).values({
    id,
    organizationId: org,
    name,
    url: `https://example.com/${name}`,
    currency: "USD",
    basePrice: 49,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return id;
}

/** An active campaign with a banner and a custom discount for India. */
async function seedCampaign(
  org: string,
  productId: string,
  opts: { discountIN: number; environment?: "live" | "test"; createdAt?: Date; status?: string },
): Promise<string> {
  const id = ulid();
  const createdAt = opts.createdAt ?? new Date();
  await getTestDb().insert(campaigns).values({
    id,
    organizationId: org,
    productId,
    name: `Campaign ${opts.discountIN}`,
    status: (opts.status ?? "active") as "active",
    environment: opts.environment ?? "live",
    pricingMode: "custom",
    discountOverrides: { IN: opts.discountIN },
    discountDelivery: "banner_coupon",
    charmPricingStrategy: "none",
    maxDiscountPercent: 70,
    createdAt,
    updatedAt: createdAt,
  });
  await getTestDb().insert(bannerConfigs).values({
    id: ulid(),
    campaignId: id,
    position: "bottom",
    messageTemplate: DEFAULT_BANNER_MESSAGE,
    ctaText: DEFAULT_CTA_TEXT,
    backgroundColor: "#1a1a2e",
    textColor: "#ffffff",
    ctaColor: "#e94560",
    ctaTextColor: "#ffffff",
    showFlag: true,
    showCloseBtn: true,
    updatedAt: new Date(),
  });
  return id;
}

async function seedKey(org: string): Promise<{ rawKey: string; apiKeyId: string }> {
  const rawKey = `gpl_pk_test${ulid()}`;
  const apiKeyId = ulid();
  await getTestDb().insert(apiKeys).values({
    id: apiKeyId,
    organizationId: org,
    name: "Serving key",
    keyType: "public",
    keyHash: await sha256Hex(rawKey),
    keyPrefix: `${rawKey.slice(0, 15)}...`,
    createdAt: new Date(),
  });
  return { rawKey, apiKeyId };
}

async function setPro(org: string) {
  await getTestDb().insert(subscriptions).values({
    id: ulid(),
    organizationId: org,
    plan: "pro",
    status: "active",
    currentPeriodEnd: new Date(Date.now() + 30 * 86_400_000),
  });
}

async function banner(
  client: TestClient,
  rawKey: string,
  query: Record<string, string> = {},
  opts: { ip?: string; ua?: string } = {},
) {
  const params = new URLSearchParams(query).toString();
  const res = await client.request(`/v1/banner/config/${rawKey}${params ? `?${params}` : ""}`, {
    cf: { country: "IN", asOrganization: "Example ISP" },
    headers: { "cf-connecting-ip": opts.ip ?? IP, "user-agent": opts.ua ?? UA },
  });
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, unknown>;
}

async function rollupRows(org: string) {
  return getTestDb().select().from(analyticsRollups).where(eq(analyticsRollups.organizationId, org));
}

async function usageRows(org: string) {
  return getTestDb()
    .select()
    .from(apiUsageDaily)
    .where(eq(apiUsageDaily.organizationId, org));
}

describe("banner serving (Postgres)", () => {
  beforeEach(async () => {
    await cleanupTestDb();
    ORG = `org-serving-${ulid()}`;
    usageMeter.reset();
    // Write unlimited orgs' counts at once so assertions don't wait 15 s.
    usageMeter.configure({ unlimitedFlushDelayMs: 0 });
  });

  afterAll(async () => {
    await cleanupTestDb();
    await closeTestDb();
  });

  it("two products on one key each get their own campaign, from Postgres and from the rebuilt document", async () => {
    const p1 = await seedProduct(ORG, "one");
    const p2 = await seedProduct(ORG, "two");
    const c1 = await seedCampaign(ORG, p1, { discountIN: 30, createdAt: new Date(Date.now() - 60_000) });
    const c2 = await seedCampaign(ORG, p2, { discountIN: 50 });
    const { rawKey, apiKeyId } = await seedKey(ORG);
    const client = createTestClient(bannerScriptRoute);

    // Database path (empty KV); its background rebuild writes the document.
    expect(await banner(client, rawKey, { product: p1 })).toMatchObject({ show: true, campaignId: c1, discount: 30 });
    const doc = JSON.parse((await client.env.CACHE.get(bannerDocKey(apiKeyId)))!);
    expect(isCurrentBannerDoc(doc)).toBe(true);
    expect(doc.products).toEqual({
      [p1]: { kind: "campaign", campaignId: c1 },
      [p2]: { kind: "campaign", campaignId: c2 },
    });

    // Document path: same answers.
    expect(await banner(client, rawKey, { product: p1 })).toMatchObject({ show: true, campaignId: c1, discount: 30 });
    expect(await banner(client, rawKey, { product: p2 })).toMatchObject({ show: true, campaignId: c2, discount: 50 });
    // No product: the product of the newest servable campaign (p2).
    expect(await banner(client, rawKey)).toMatchObject({ campaignId: c2 });
    // Unknown product: nothing, never another product's campaign.
    expect(await banner(client, rawKey, { product: ulid() })).toEqual({ show: false, reason: "no_active_campaign" });
  });

  it("a running experiment assigns a sticky arm through the real route", async () => {
    const p1 = await seedProduct(ORG, "exp");
    const a = await seedCampaign(ORG, p1, { discountIN: 40 });
    const b = await seedCampaign(ORG, p1, { discountIN: 20 });
    const experimentId = ulid();
    await getTestDb().insert(experiments).values({
      id: experimentId,
      organizationId: ORG,
      productId: p1,
      environment: "live",
      name: "40 vs 20",
      status: "running",
      campaignAId: a,
      campaignBId: b,
      campaignAName: "Campaign 40",
      campaignBName: "Campaign 20",
      trafficSplitB: 50,
    });
    const { rawKey } = await seedKey(ORG);
    const client = createTestClient(bannerScriptRoute);

    const seen = new Set<string>();
    for (let i = 0; i < 12; i++) {
      const vid = `integration-visitor-${String(i).padStart(4, "0")}`;
      const expected = await assignVariant(experimentId, visitorKey(vid, IP, UA), 50);
      const first = await banner(client, rawKey, { product: p1, vid });
      expect(first).toMatchObject({
        show: true,
        experimentId,
        variant: expected,
        campaignId: expected === "b" ? b : a,
        discount: expected === "b" ? 20 : 40,
      });
      // Sticky by vid, whatever the IP and browser.
      const again = await banner(client, rawKey, { product: p1, vid }, { ip: "198.51.100.1", ua: "Other" });
      expect(again.variant).toBe(expected);
      seen.add(expected);
    }
    expect(seen).toEqual(new Set(["a", "b"]));

    // Without a vid: keyed on IP + user agent.
    const fallback = await assignVariant(experimentId, visitorKey(null, IP, UA), 50);
    expect((await banner(client, rawKey, { product: p1 })).variant).toBe(fallback);

    // Arm B paused: the experiment no longer splits; arm A serves everyone, untagged.
    await getTestDb().update(campaigns).set({ status: "paused" }).where(eq(campaigns.id, b));
    const fresh = createTestClient(bannerScriptRoute); // empty KV: database path
    const out = await banner(fresh, rawKey, { product: p1, vid: "integration-visitor-0000" });
    expect(out).toMatchObject({ show: true, campaignId: a });
    expect(out).not.toHaveProperty("experimentId");
  });

  it("metered calls reach api_usage_daily and, through the usage cron, the quota snapshot (live only)", async () => {
    const live = await seedProduct(ORG, "live");
    const sandbox = await seedProduct(ORG, "sandbox");
    await seedCampaign(ORG, live, { discountIN: 40 });
    await seedCampaign(ORG, sandbox, { discountIN: 40, environment: "test" });
    const { rawKey } = await seedKey(ORG);
    const client = createTestClient(bannerScriptRoute);

    for (let i = 0; i < 3; i++) await banner(client, rawKey, { product: live });
    await banner(client, rawKey, { product: sandbox });
    await banner(client, rawKey, { product: ulid() }); // nothing to serve: counts as live

    const today = utcDay(new Date());
    const rows = await usageRows(ORG);
    expect(rows.map((r) => ({ day: r.day, environment: r.environment, count: r.count })).sort((x, y) => x.environment.localeCompare(y.environment))).toEqual([
      { day: today, environment: "live", count: 4 },
      { day: today, environment: "test", count: 1 },
    ]);

    await recomputeUsageForAllOrgs(db(), client.env.CACHE, client.env);
    const snapshot = JSON.parse((await client.env.CACHE.get(usageKey(ORG)))!);
    expect(snapshot).toMatchObject({ count: 4, limit: PLAN_LIMITS.free.apiHitsPerMonth, over: false });
  });

  // Impressions are counted here, by the request that serves the offer, not
  // posted by the browser (services/impression-meter.ts).
  describe("impressions", () => {
    const todayStart = () => {
      const now = new Date();
      return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    };

    it("every served offer adds one impression to the campaign's daily rollup row; a request with nothing to serve adds none", async () => {
      const product = await seedProduct(ORG, "p");
      const campaignId = await seedCampaign(ORG, product, { discountIN: 40 });
      const { rawKey } = await seedKey(ORG);
      const client = createTestClient(bannerScriptRoute);

      // First from Postgres (empty KV), then from the rebuilt document.
      for (let i = 0; i < 3; i++) expect((await banner(client, rawKey, { product })).show).toBe(true);
      expect(await banner(client, rawKey, { product: ulid() })).toMatchObject({ show: false });

      const rows = await rollupRows(ORG);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        campaignId,
        countryCode: "IN",
        period: "day",
        environment: "live",
        impressions: 3,
        clicks: 0,
        copies: 0,
        redemptions: 0,
      });
      expect(rows[0]!.periodStart.toISOString()).toBe(todayStart().toISOString());
    });

    it("requests answered from the remembered document are still metered and counted, one each", async () => {
      const product = await seedProduct(ORG, "p");
      const campaignId = await seedCampaign(ORG, product, { discountIN: 40 });
      const { rawKey } = await seedKey(ORG);
      const client = createTestClient(bannerScriptRoute);
      await banner(client, rawKey); // from Postgres; its rebuild writes the document
      configureBannerHotCache({ ttlMs: BANNER_HOT_CACHE_TTL_MS });

      const kvGet = vi.spyOn(client.env.CACHE, "get");
      const answers = [];
      for (let i = 0; i < 4; i++) answers.push(await banner(client, rawKey));
      // One read of the document (by the first of the four), then memory.
      expect(kvGet.mock.calls.filter(([key]) => String(key).startsWith("banner-config:"))).toHaveLength(1);
      expect(bannerDocCache.size()).toBe(1);
      for (const answer of answers) expect(answer).toEqual(answers[0]);
      expect(answers[0]).toMatchObject({ show: true, campaignId, discount: 40 });

      const [usage] = await usageRows(ORG);
      expect(usage!.count).toBe(5);
      const rows = await rollupRows(ORG);
      expect(rows.map((r) => ({ campaignId: r.campaignId, impressions: r.impressions }))).toEqual([
        { campaignId, impressions: 5 },
      ]);
    });

    it("a Pro organization's impressions (the buffered path) are written too", async () => {
      const product = await seedProduct(ORG, "p");
      const campaignId = await seedCampaign(ORG, product, { discountIN: 40 });
      const { rawKey } = await seedKey(ORG);
      await setPro(ORG);
      const client = createTestClient(bannerScriptRoute);
      await banner(client, rawKey); // the first call creates the usage row the cron reads
      await recomputeUsageForAllOrgs(db(), client.env.CACHE, client.env); // snapshot: unlimited
      await banner(client, rawKey);
      await banner(client, rawKey);

      const rows = await rollupRows(ORG);
      expect(rows.map((r) => ({ campaignId: r.campaignId, impressions: r.impressions }))).toEqual([
        { campaignId, impressions: 3 },
      ]);
    });

    it("the upsert adds to existing rows, several rows in one statement", async () => {
      const day = utcDay(new Date());
      const row = (campaignId: string, countryCode: string, count: number) => ({
        organizationId: ORG,
        campaignId,
        countryCode,
        day,
        count,
      });
      await writeImpressionRows(db(), [row("camp_a", "IN", 5), row("camp_a", "BR", 2), row("camp_b", "IN", 1)]);
      await writeImpressionRows(db(), [row("camp_a", "IN", 10), row("camp_b", "NG", 4)]);

      const rows = await rollupRows(ORG);
      expect(
        rows
          .map((r) => `${r.campaignId}/${r.countryCode}=${r.impressions}`)
          .sort(),
      ).toEqual(["camp_a/BR=2", "camp_a/IN=15", "camp_b/IN=1", "camp_b/NG=4"]);
    });
  });

  describe("over quota", () => {
    async function overQuotaOrg(org: string) {
      const product = await seedProduct(org, "p");
      await seedCampaign(org, product, { discountIN: 40 });
      const { rawKey } = await seedKey(org);
      await getTestDb().insert(apiUsageDaily).values({
        organizationId: org,
        day: utcDay(new Date()),
        environment: "live",
        count: PLAN_LIMITS.free.apiHitsPerMonth as number,
      });
      return rawKey;
    }

    it("stops a Free organization once the cron sees its live calls at the cap", async () => {
      const rawKey = await overQuotaOrg(ORG);
      const client = createTestClient(bannerScriptRoute);
      await recomputeUsageForAllOrgs(db(), client.env.CACHE, client.env);

      expect(await banner(client, rawKey)).toEqual({ show: false, reason: "quota_exceeded" });
      // A refused request is not metered.
      const [row] = await usageRows(ORG);
      expect(row!.count).toBe(PLAN_LIMITS.free.apiHitsPerMonth);
    });

    it("never stops a Pro organization (fair use), and keeps metering it", async () => {
      const rawKey = await overQuotaOrg(ORG);
      await setPro(ORG);
      const client = createTestClient(bannerScriptRoute);
      await recomputeUsageForAllOrgs(db(), client.env.CACHE, client.env);

      expect(await banner(client, rawKey)).toMatchObject({ show: true, showBranding: false });
      const [row] = await getTestDb()
        .select()
        .from(apiUsageDaily)
        .where(and(eq(apiUsageDaily.organizationId, ORG), eq(apiUsageDaily.environment, "live")));
      expect(row!.count).toBe((PLAN_LIMITS.free.apiHitsPerMonth as number) + 1);
    });

    it("never stops a self-hosted organization, even with an over-quota snapshot", async () => {
      const rawKey = await overQuotaOrg(ORG);
      const hosted = createTestClient(bannerScriptRoute);
      await recomputeUsageForAllOrgs(db(), hosted.env.CACHE, hosted.env);
      // Same KV (snapshot says over), self-hosted deployment.
      const selfHosted = createTestClient(
        bannerScriptRoute,
        createTestBindings({ CACHE: hosted.env.CACHE, SELF_HOSTED: "true" }),
      );
      expect(await banner(selfHosted, rawKey)).toMatchObject({ show: true, showBranding: false });
    });
  });
});
