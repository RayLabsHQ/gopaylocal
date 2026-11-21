import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { ulid } from "ulid";
import { createTestClient } from "../test/helpers";
import { getTestDb, cleanupTestDb, closeTestDb } from "../test/setup";
import {
  products,
  campaigns,
  bannerConfigs,
  apiKeys,
  parityGroups,
  countryParityMappings,
} from "../db/schema";
import { DEFAULT_BANNER_MESSAGE, DEFAULT_CTA_TEXT } from "@gopaylocal/shared/constants";
import { BANNER_HOT_CACHE_TTL_MS, configureBannerHotCache } from "../services/banner-hot-cache";
import bannerScriptRoute from "./banner-script";

// The route imports the browser bundle as a wrangler text module; stub it so
// the browser code never runs under Node (same as the unit tests).
vi.mock("../../../../packages/banner/dist/banner.js", () => ({ default: "" }));

/**
 * The banner-script route (/v1/banner/config/:publicKey) is a public endpoint
 * that resolves the visitor's country, validates the API key, and returns
 * the discount + banner config. The country comes ONLY from `request.cf.country`
 * (set by Cloudflare's edge); the `cf-ipcountry` header is client-controlled
 * and deliberately ignored, so tests set a `cf` object on the request.
 *
 * These tests start with an empty KV, so they exercise the DB fallback path.
 */

const TEST_ORG_ID = "test-org-banner";

/** Hash a key string with SHA-256 (same algorithm as the api-keys route). */
async function hashKey(key: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(key);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Seed all required data directly through the test DB so the banner endpoint
 * has something to look up. Returns the raw public API key string.
 */
async function seedBannerData(opts?: { campaignStatus?: "active" | "paused" | "draft" }) {
  const db = getTestDb();

  // 1. Create a product
  const productId = ulid();
  await db.insert(products).values({
    id: productId,
    organizationId: TEST_ORG_ID,
    name: "Banner Test Product",
    url: "https://example.com/banner-product",
    currency: "USD",
    basePrice: 49.99,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  // 2. Create a parity group with countries
  const groupId = ulid();
  await db.insert(parityGroups).values({
    id: groupId,
    organizationId: TEST_ORG_ID,
    name: "Discount Tier",
    discountPercent: 40,
    sortOrder: 1,
    createdAt: new Date(),
  });

  await db.insert(countryParityMappings).values([
    { id: ulid(), parityGroupId: groupId, countryCode: "IN" },
    { id: ulid(), parityGroupId: groupId, countryCode: "BR" },
  ]);

  // 3. Create a campaign (active by default)
  const campaignId = ulid();
  await db.insert(campaigns).values({
    id: campaignId,
    organizationId: TEST_ORG_ID,
    productId,
    name: "Banner Campaign",
    status: opts?.campaignStatus ?? "active",
    pricingMode: "group",
    discountDelivery: "banner_coupon",
    charmPricingStrategy: "none",
    maxDiscountPercent: 70,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  // 4. Create a banner config for the campaign
  const bannerId = ulid();
  await db.insert(bannerConfigs).values({
    id: bannerId,
    campaignId,
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

  // 5. Create a public API key
  const rawKey = `gpl_pk_test${ulid()}`;
  const keyHash = await hashKey(rawKey);
  const apiKeyId = ulid();
  await db.insert(apiKeys).values({
    id: apiKeyId,
    organizationId: TEST_ORG_ID,
    name: "Banner Test Key",
    keyType: "public",
    keyHash,
    keyPrefix: rawKey.substring(0, 15) + "...",
    createdAt: new Date(),
  });

  return { rawKey, productId, campaignId, groupId };
}

function createBannerTestApp() {
  // A fresh client (and KV) per test so caching does not leak between tests.
  return createTestClient(bannerScriptRoute);
}

const bannerUrl = (rawKey: string) => `/v1/banner/config/${encodeURIComponent(rawKey)}`;

describe("Banner Script API", () => {
  beforeEach(async () => {
    await cleanupTestDb();
  });

  afterAll(async () => {
    await cleanupTestDb();
    await closeTestDb();
  });

  it("GET /v1/banner/config/:publicKey returns banner data for a country in a parity group", async () => {
    const { rawKey } = await seedBannerData();
    const app = createBannerTestApp();

    const res = await app.request(bannerUrl(rawKey), { cf: { country: "IN" } });

    expect(res.status).toBe(200);
    const json = await res.json() as any;
    expect(json.show).toBe(true);
    expect(json.country).toBe("IN");
    expect(json.countryName).toBe("India");
    expect(json.discount).toBe(40);
    expect(json.banner).toBeDefined();
    expect(json.banner.position).toBe("bottom");
    expect(json.banner.showFlag).toBe(true);
    expect(json.currencySymbol).toBe("$");
    expect(json.showBranding).toBe(true); // no subscription = Free
  });

  it("returns show=false for country not in any parity group", async () => {
    const { rawKey } = await seedBannerData();
    const app = createBannerTestApp();

    const res = await app.request(bannerUrl(rawKey), { cf: { country: "JP" } });

    expect(res.status).toBe(200);
    const json = await res.json() as any;
    expect(json.show).toBe(false);
    expect(json.reason).toBe("no_discount");
  });

  it("returns show=false for unknown/missing country", async () => {
    const { rawKey } = await seedBannerData();
    const app = createBannerTestApp();

    // No request.cf at all (a request that did not come through Cloudflare)
    const res = await app.request(bannerUrl(rawKey));

    expect(res.status).toBe(200);
    const json = await res.json() as any;
    expect(json.show).toBe(false);
    expect(json.reason).toBe("unknown_country");
  });

  it("returns 401 for invalid API key", async () => {
    await seedBannerData();
    const app = createBannerTestApp();

    const res = await app.request("/v1/banner/config/gpl_pk_invalid_key_here", { cf: { country: "IN" } });

    expect(res.status).toBe(401);
    const json = await res.json() as any;
    expect(json.error).toBe("Invalid API key");
  });

  it("returns show=false when no active campaign exists", async () => {
    const { rawKey } = await seedBannerData({ campaignStatus: "draft" });
    const app = createBannerTestApp();

    const res = await app.request(bannerUrl(rawKey), { cf: { country: "IN" } });

    expect(res.status).toBe(200);
    const json = await res.json() as any;
    expect(json.show).toBe(false);
    expect(json.reason).toBe("no_active_campaign");
  });

  it("returns correct discount for BR (another country in the group)", async () => {
    const { rawKey } = await seedBannerData();
    const app = createBannerTestApp();

    const res = await app.request(bannerUrl(rawKey), { cf: { country: "BR" } });

    expect(res.status).toBe(200);
    const json = await res.json() as any;
    expect(json.show).toBe(true);
    expect(json.country).toBe("BR");
    expect(json.countryName).toBe("Brazil");
    expect(json.discount).toBe(40);
  });

  it("ignores a spoofed cf-ipcountry header: no request.cf means unknown country", async () => {
    const { rawKey } = await seedBannerData();
    const app = createBannerTestApp();

    const res = await app.request(bannerUrl(rawKey), { headers: { "cf-ipcountry": "IN" } });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ show: false, reason: "unknown_country" });
  });

  it("request.cf wins over a cf-ipcountry header claiming a discounted country", async () => {
    const { rawKey } = await seedBannerData();
    const app = createBannerTestApp();

    const res = await app.request(bannerUrl(rawKey), {
      cf: { country: "US" },
      headers: { "cf-ipcountry": "IN" },
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.show).toBe(false);
    expect(json.reason).toBe("no_discount");
  });

  it("the DB fallback backfills the key -> org mapping into KV (background work)", async () => {
    const { rawKey } = await seedBannerData();
    const app = createBannerTestApp();
    const cacheKey = `apikey:${await hashKey(rawKey)}`;
    expect(await app.env.CACHE.get(cacheKey)).toBeNull();

    const res = await app.request(bannerUrl(rawKey), { cf: { country: "IN" } });
    expect(res.status).toBe(200);

    const cached = JSON.parse((await app.env.CACHE.get(cacheKey))!);
    expect(cached.organizationId).toBe(TEST_ORG_ID);
    expect(typeof cached.apiKeyId).toBe("string");
  });

  it("remembers an unknown key in memory so repeat lookups skip the database, and writes nothing to KV", async () => {
    await seedBannerData();
    const app = createBannerTestApp();
    const badKey = `gpl_pk_test${ulid()}`;
    const put = vi.spyOn(app.env.CACHE, "put");
    // The memory is off in integration tests unless a test turns it on.
    configureBannerHotCache({ ttlMs: BANNER_HOT_CACHE_TTL_MS });
    try {
      expect((await app.request(bannerUrl(badKey), { cf: { country: "IN" } })).status).toBe(401);
      expect(put).not.toHaveBeenCalled();

      // Give the key a row in Postgres. The remembered miss still answers, so
      // the second request cannot have asked the database.
      await getTestDb().insert(apiKeys).values({
        id: ulid(),
        organizationId: TEST_ORG_ID,
        name: "Created after the miss",
        keyType: "public",
        keyHash: await hashKey(badKey),
        keyPrefix: `${badKey.substring(0, 15)}...`,
        createdAt: new Date(),
      });
      expect((await app.request(bannerUrl(badKey), { cf: { country: "IN" } })).status).toBe(401);
      expect(put).not.toHaveBeenCalled();

      // Once the miss is forgotten (a minute later in production) the key is found.
      configureBannerHotCache({ ttlMs: BANNER_HOT_CACHE_TTL_MS });
      expect((await app.request(bannerUrl(badKey), { cf: { country: "IN" } })).status).toBe(200);
    } finally {
      configureBannerHotCache({ ttlMs: 0 });
      put.mockRestore();
    }
  });
});
