import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import worker from "../index";
import { analyticsRollups, coupons, integrations, webhookEvents } from "../db/schema";
import type { CachedBannerConfig } from "../services/banner-cache.service";
import type { CreateDiscountParams, ProviderConfig } from "../services/providers/types";
import { retryPendingRedemptions } from "../services/redemption-webhook.service";
import { createExecutionContext, createTestBindings, createTestClient, type TestClient } from "../test/helpers";
import { as, seedTenant, type TestTenant } from "../test/auth";
import { cleanupTestDb, closeTestDb, getTestDb } from "../test/setup";

vi.mock("../../../../packages/banner/dist/banner.js", () => ({ default: "" }));

/**
 * The whole campaign lifecycle through the real Worker with a fake payment
 * provider standing in for Stripe & co. (no network):
 *   connect integration (webhook auto-provisioned) -> parity groups -> API key
 *   -> campaign (draft) -> activate -> coupons created in the provider and
 *   stored -> banner serves the visitor's country code -> provider webhook
 *   records the redemption -> analytics roll it up.
 *
 * The fake is installed by mocking the provider factory (createProvider), the
 * single seam every provider call goes through (coupon service, integrations
 * route, webhook route).
 */

const fake = vi.hoisted(() => {
  const state = {
    webhookSecret: "fake-webhook-signing-secret",
    created: [] as Array<{ provider: string; config: unknown; params: unknown; id: string }>,
    provisioned: [] as string[],
    /** Make the next N parseRedemption calls throw (a transient provider failure). */
    failParse: 0,
  };
  function createFakeProvider(name: string, config: { apiKey: string; environment?: string }) {
    return {
      name,
      async createDiscount(params: { code: string; amount: number }) {
        const id = `fake_disc_${state.created.length + 1}`;
        state.created.push({ provider: name, config, params, id });
        return { providerDiscountId: id, code: params.code, discountPercent: params.amount, provider: name };
      },
      async deleteDiscount() {},
      async listDiscounts() {
        return [];
      },
      async buildCheckoutUrl() {
        return "https://checkout.fake.test";
      },
      async provisionWebhook(callbackUrl: string) {
        state.provisioned.push(callbackUrl);
        return { endpointId: "fake_endpoint_1", secret: state.webhookSecret };
      },
      async deleteWebhook() {},
      async verifyWebhook(input: { headers: Headers; secret: string | null }) {
        return input.secret !== null && input.headers.get("x-fake-signature") === input.secret;
      },
      parseRedemption(rawBody: string) {
        if (state.failParse > 0) {
          state.failParse--;
          throw new Error("provider API timed out");
        }
        const body = JSON.parse(rawBody) as {
          type: string;
          id: string;
          code?: string;
          charged?: number;
          discount?: number;
          currency?: string;
        };
        if (body.type !== "order.paid") return null;
        return {
          eventId: body.id,
          code: body.code ?? null,
          providerCouponId: null,
          providerPromoCodeId: null,
          chargedAmountCents: body.charged ?? null,
          discountAmountCents: body.discount ?? null,
          currency: body.currency ?? null,
        };
      },
    };
  }
  return { state, createFakeProvider };
});

vi.mock("../services/providers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/providers")>();
  return { ...actual, createProvider: fake.createFakeProvider };
});

let client: TestClient;
let t: TestTenant;

async function api(path: string, init: Parameters<TestClient["request"]>[1] = {}) {
  return client.request(`/v1/teams/${t.orgId}${path}`, { ...init, headers: as(t) });
}

async function connectIntegration(tenant: TestTenant = t): Promise<string> {
  const res = await client.request(`/v1/teams/${tenant.orgId}/integrations`, {
    method: "POST",
    headers: as(tenant),
    json: { provider: "stripe", accessToken: "sk_test_fake_key", environment: "live" },
  });
  expect(res.status).toBe(201);
  return (await res.json()).data.id;
}

function sendWebhook(integrationId: string, body: unknown, signature: string = fake.state.webhookSecret) {
  return client.request(`/v1/webhooks/stripe/${integrationId}`, {
    method: "POST",
    headers: { "x-fake-signature": signature },
    json: body,
  });
}

/** Integration + product + parity groups + public key + draft campaign. */
async function setUpDraftCampaign() {
  const integrationId = await connectIntegration();
  const product = await (
    await api("/products", { method: "POST", json: { name: "Course", url: "https://shop.example.com", basePrice: 99 } })
  ).json();
  const discounted = await (
    await api("/parity-groups", { method: "POST", json: { name: "Tier 3", discountPercent: 40, sortOrder: 3 } })
  ).json();
  await api(`/parity-groups/${discounted.data.id}/countries`, { method: "PUT", json: { countries: ["IN", "BR"] } });
  const parity = await (
    await api("/parity-groups", { method: "POST", json: { name: "Tier 1", discountPercent: 0, sortOrder: 1 } })
  ).json();
  await api(`/parity-groups/${parity.data.id}/countries`, { method: "PUT", json: { countries: ["US"] } });
  const key = await (await api("/api-keys", { method: "POST", json: { name: "Site", keyType: "public" } })).json();

  const campaignRes = await api("/campaigns", {
    method: "POST",
    json: { productId: product.data.id, integrationId, name: "Launch PPP", couponPrefix: "PPP" },
  });
  expect(campaignRes.status).toBe(201);
  const campaign = (await campaignRes.json()).data;
  return { integrationId, campaignId: campaign.id as string, keyId: key.data.id as string, rawKey: key.data.key as string };
}

async function activate(campaignId: string) {
  const res = await api(`/campaigns/${campaignId}`, { method: "PATCH", json: { status: "active" } });
  expect(res.status).toBe(200);
}

/** One run of the 10-minute cron (usage snapshots + webhook retry), background work settled. */
async function runTenMinuteCron() {
  const ctx = createExecutionContext();
  await worker.scheduled(
    { cron: "*/10 * * * *", scheduledTime: Date.now(), noRetry() {} } as unknown as ScheduledController,
    client.env,
    ctx,
  );
  await ctx.settle();
}

async function couponFor(campaignId: string, countryCode: string) {
  const [row] = await getTestDb()
    .select()
    .from(coupons)
    .where(and(eq(coupons.campaignId, campaignId), eq(coupons.countryCode, countryCode)));
  return row;
}

describe("Campaign lifecycle with a fake payment provider (full Worker)", () => {
  beforeEach(async () => {
    await cleanupTestDb();
    fake.state.created.length = 0;
    fake.state.provisioned.length = 0;
    fake.state.failParse = 0;
    client = createTestClient(worker, createTestBindings());
    t = await seedTenant(client, "Merchant");
  });

  afterAll(async () => {
    await cleanupTestDb();
    await closeTestDb();
  });

  it("connecting an integration encrypts the token and auto-provisions the redemption webhook", async () => {
    const integrationId = await connectIntegration();

    expect(fake.state.provisioned).toEqual([`http://localhost/v1/webhooks/stripe/${integrationId}`]);
    const [row] = await getTestDb().select().from(integrations).where(eq(integrations.id, integrationId));
    expect(row).toMatchObject({ organizationId: t.orgId, provider: "stripe", status: "active", webhookEndpointId: "fake_endpoint_1" });
    expect(row!.liveAccessTokenEnc).toBeTruthy();
    expect(row!.liveAccessTokenEnc).not.toContain("sk_test_fake_key");
    expect(row!.webhookSecretEnc).toBeTruthy();
    expect(row!.webhookSecretEnc).not.toContain(fake.state.webhookSecret);

    const list = await (await api("/integrations")).json();
    expect(list.data).toEqual([
      expect.objectContaining({ id: integrationId, hasLiveCredentials: true, hasTestCredentials: false }),
    ]);
    expect(JSON.stringify(list)).not.toContain("Enc");
  });

  it("activation creates provider coupons for discounted countries, stores them, and the banner serves them", async () => {
    const { integrationId, campaignId, keyId, rawKey } = await setUpDraftCampaign();

    // A draft campaign creates nothing in the provider.
    expect(fake.state.created).toHaveLength(0);

    await activate(campaignId);

    // Provider calls: one percentage discount per discounted country, made
    // with the decrypted merchant key. US (0%) gets none.
    const calls = fake.state.created.map((c) => ({
      ...(c.params as CreateDiscountParams),
      apiKey: (c.config as ProviderConfig).apiKey,
      environment: (c.config as ProviderConfig).environment,
    }));
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call).toMatchObject({ discountType: "percentage", amount: 40, apiKey: "sk_test_fake_key", environment: "live" });
    }

    const india = await couponFor(campaignId, "IN");
    const brazil = await couponFor(campaignId, "BR");
    expect(await couponFor(campaignId, "US")).toBeUndefined();
    for (const coupon of [india, brazil]) {
      expect(coupon).toMatchObject({ integrationId, discountPercent: 40, status: "active" });
      expect(coupon!.providerCouponId).toMatch(/^fake_disc_/);
    }
    // The stored code is exactly what the provider accepted.
    expect(calls.map((c) => c.code).sort()).toEqual([india!.code, brazil!.code].sort());
    expect(india!.code).not.toBe(brazil!.code);

    // The precomputed KV banner config carries the codes.
    const cached = JSON.parse((await client.env.CACHE.get(`banner-config:${keyId}`))!) as CachedBannerConfig;
    expect(Object.values(cached.products)).toEqual([{ kind: "campaign", campaignId }]);
    expect(cached.campaigns[campaignId]!.countries.IN).toMatchObject({ discount: 40, code: india!.code });
    expect(cached.campaigns[campaignId]!.countries.BR).toMatchObject({ discount: 40, code: brazil!.code });

    // Banner endpoint, KV fast path.
    const inBanner = await (await client.request(`/v1/banner/config/${rawKey}`, { cf: { country: "IN" } })).json();
    expect(inBanner).toMatchObject({ show: true, country: "IN", discount: 40, code: india!.code, campaignId });
    const usBanner = await (await client.request(`/v1/banner/config/${rawKey}`, { cf: { country: "US" } })).json();
    expect(usBanner).toEqual({ show: false, reason: "no_discount" });

    // Banner endpoint, DB fallback (cold KV): same code, no new provider coupon.
    const cold = createTestClient(worker, createTestBindings());
    const coldBanner = await (await cold.request(`/v1/banner/config/${rawKey}`, { cf: { country: "BR" } })).json();
    expect(coldBanner).toMatchObject({ show: true, discount: 40, code: brazil!.code });
    expect(fake.state.created).toHaveLength(2);

    // Re-activating an already active campaign does not mint new coupons.
    await activate(campaignId);
    expect(fake.state.created).toHaveLength(2);
  });

  it("a country in two parity groups gets one coupon at activation, at the percent the banner serves", async () => {
    // IN is in both groups: the lower sort order (50%) prices it, on the banner
    // and in coupon pre-generation alike. BR is only in the 30% group.
    const integrationId = await connectIntegration();
    const product = await (
      await api("/products", { method: "POST", json: { name: "Course", url: "https://shop.example.com", basePrice: 99 } })
    ).json();
    const groups: Array<[number, number, string[]]> = [
      [30, 2, ["IN", "BR"]],
      [50, 1, ["IN"]],
    ];
    for (const [discountPercent, sortOrder, countries] of groups) {
      const res = await api("/parity-groups", {
        method: "POST",
        json: { name: `Tier ${sortOrder}`, discountPercent, sortOrder },
      });
      expect(res.status).toBe(201);
      const put = await api(`/parity-groups/${(await res.json()).data.id}/countries`, { method: "PUT", json: { countries } });
      expect(put.status).toBe(200);
    }
    const key = await (await api("/api-keys", { method: "POST", json: { name: "Site", keyType: "public" } })).json();
    const campaignRes = await api("/campaigns", {
      method: "POST",
      json: { productId: product.data.id, integrationId, name: "Launch PPP", couponPrefix: "PPP" },
    });
    expect(campaignRes.status).toBe(201);
    const campaignId = (await campaignRes.json()).data.id as string;

    await activate(campaignId);

    const rows = await getTestDb()
      .select({ countryCode: coupons.countryCode, discountPercent: coupons.discountPercent, code: coupons.code })
      .from(coupons)
      .where(eq(coupons.campaignId, campaignId))
      .orderBy(coupons.countryCode);
    expect(rows.map(({ countryCode, discountPercent }) => ({ countryCode, discountPercent }))).toEqual([
      { countryCode: "BR", discountPercent: 30 },
      { countryCode: "IN", discountPercent: 50 },
    ]);
    expect(fake.state.created.map((c) => (c.params as CreateDiscountParams).amount).sort()).toEqual([30, 50]);
    const india = rows.find((r) => r.countryCode === "IN")!;

    // The banner serves that one code, from KV and from the database.
    const rawKey = key.data.key as string;
    const fromKv = await (await client.request(`/v1/banner/config/${rawKey}`, { cf: { country: "IN" } })).json();
    expect(fromKv).toMatchObject({ show: true, discount: 50, code: india.code });
    const cold = createTestClient(worker, createTestBindings());
    const fromDb = await (await cold.request(`/v1/banner/config/${rawKey}`, { cf: { country: "IN" } })).json();
    expect(fromDb).toMatchObject({ show: true, discount: 50, code: india.code });
    expect(fake.state.created).toHaveLength(2);
  });

  it("a verified redemption webhook is recorded once and rolled up into analytics", async () => {
    const { integrationId, campaignId } = await setUpDraftCampaign();
    await activate(campaignId);
    const india = (await couponFor(campaignId, "IN"))!;
    const order = { type: "order.paid", id: "evt_1001", code: india.code, charged: 5940, discount: 3960, currency: "USD" };

    // Bad signature: rejected, nothing recorded.
    const forged = await sendWebhook(integrationId, order, "not-the-secret");
    expect(forged.status).toBe(401);

    const res = await sendWebhook(integrationId, order);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true });

    // Provider retries the same event: acknowledged as a duplicate, not double counted.
    const replay = await sendWebhook(integrationId, order);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ received: true, duplicate: true });

    // A verified event that is not a redemption, and a code that is not ours.
    expect((await sendWebhook(integrationId, { type: "customer.created", id: "evt_1002" })).status).toBe(200);
    expect(
      (await sendWebhook(integrationId, { ...order, id: "evt_1003", code: "SOMEONE-ELSES-CODE" })).status,
    ).toBe(200);

    const db = getTestDb();
    const rollups = await db.select().from(analyticsRollups).where(eq(analyticsRollups.campaignId, campaignId));
    expect(rollups).toHaveLength(1);
    expect(rollups[0]).toMatchObject({ organizationId: t.orgId, countryCode: "IN", period: "day", redemptions: 1 });
    expect(rollups[0]!.revenueSaved).toBeCloseTo(39.6, 2);

    const [event] = await db
      .select()
      .from(webhookEvents)
      .where(eq(webhookEvents.webhookId, `stripe:${integrationId}:evt_1001`));
    expect(event).toMatchObject({ provider: "stripe", eventType: "redemption", processed: true, errorMessage: null });

    // Dashboard analytics.
    const overview = await (await api("/analytics/overview")).json();
    expect(overview.data).toMatchObject({ totalRedemptions: 1 });
    expect(overview.data.totalRevenueSaved).toBeCloseTo(39.6, 2);
    const byCountry = await (await api("/analytics/by-country")).json();
    expect(byCountry.data).toEqual([expect.objectContaining({ countryCode: "IN", redemptions: 1 })]);
    const byCampaign = await (await api("/analytics/by-campaign")).json();
    expect(byCampaign.data).toEqual([expect.objectContaining({ campaignId, redemptions: 1 })]);
  });

  it("a webhook to another org's integration cannot credit this org's coupon", async () => {
    const { campaignId } = await setUpDraftCampaign();
    await activate(campaignId);
    const india = (await couponFor(campaignId, "IN"))!;

    const other = await seedTenant(client, "Other Merchant");
    const otherIntegrationId = await connectIntegration(other);
    const res = await sendWebhook(otherIntegrationId, {
      type: "order.paid",
      id: "evt_cross",
      code: india.code,
      charged: 5940,
      currency: "USD",
    });
    expect(res.status).toBe(200);
    expect(await getTestDb().select().from(analyticsRollups)).toHaveLength(0);
  });

  it("unknown integrations and provider/path mismatches are 404", async () => {
    const { integrationId } = await setUpDraftCampaign();
    expect((await sendWebhook("01HZZZZZZZZZZZZZZZZZZZZZZZ", { type: "order.paid", id: "x" })).status).toBe(404);
    const mismatch = await client.request(`/v1/webhooks/paddle/${integrationId}`, {
      method: "POST",
      headers: { "x-fake-signature": fake.state.webhookSecret },
      json: { type: "order.paid", id: "x" },
    });
    expect(mismatch.status).toBe(404);
  });

  // Regression tests (bug found 2026-11-18, fixed the same day): the retry query in
  // services/redemption-webhook.service.ts compared a raw sql expression with a
  // JS Date (`lte(sql`(...->>'nextAttemptAt')::timestamptz`, now)`). Drizzle bound
  // the Date unencoded and postgres-js threw ERR_INVALID_ARG_TYPE, so the SELECT
  // failed on every run, even on an empty queue; the cron caught and logged it
  // (index.ts), so nothing was ever retried. Only real Postgres catches this.
  it("retryPendingRedemptions runs against Postgres (empty queue)", async () => {
    await expect(retryPendingRedemptions(getTestDb() as never, client.env)).resolves.toEqual({
      attempted: 0,
      recovered: 0,
      failed: 0,
      skipped: 0,
    });
  });

  it("a webhook whose parsing failed is stored and recovered by the */10 cron retry", async () => {
    const { integrationId, campaignId } = await setUpDraftCampaign();
    await activate(campaignId);
    const india = (await couponFor(campaignId, "IN"))!;
    const order = { type: "order.paid", id: "evt_retry_1", code: india.code, charged: 5940, discount: 3960, currency: "USD" };
    const db = getTestDb();

    fake.state.failParse = 1;
    await sendWebhook(integrationId, order);
    const parked = await db.select().from(webhookEvents).where(eq(webhookEvents.eventType, "redemption_unparsed"));
    expect(parked).toHaveLength(1);
    expect(parked[0]).toMatchObject({ processed: false });
    expect(await db.select().from(analyticsRollups).where(eq(analyticsRollups.campaignId, campaignId))).toEqual([]);

    // Age the row past the retry job's 2-minute grace period, then let the cron run.
    await db
      .update(webhookEvents)
      .set({ createdAt: new Date(Date.now() - 5 * 60_000) })
      .where(eq(webhookEvents.id, parked[0]!.id));
    await runTenMinuteCron();

    const rollups = await db.select().from(analyticsRollups).where(eq(analyticsRollups.campaignId, campaignId));
    expect(rollups).toHaveLength(1);
    expect(rollups[0]).toMatchObject({ countryCode: "IN", redemptions: 1 });
    const [after] = await db.select().from(webhookEvents).where(eq(webhookEvents.id, parked[0]!.id));
    expect(after).toMatchObject({ processed: true });
  });
});
