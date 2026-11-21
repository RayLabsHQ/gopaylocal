import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { and, eq, isNotNull } from "drizzle-orm";
import worker from "../index";
import { analyticsRollups, coupons, deals } from "../db/schema";
import { refreshBannerConfigForOrg, type CachedBannerConfig } from "../services/banner-cache.service";
import { MAX_DEALS_PER_CAMPAIGN } from "@gopaylocal/shared/deals";
import { createExecutionContext, createTestBindings, createTestClient, type TestClient } from "../test/helpers";
import { as, seedTenant, type TestTenant } from "../test/auth";
import { cleanupTestDb, closeTestDb, getTestDb } from "../test/setup";

vi.mock("../../../../packages/banner/dist/banner.js", () => ({ default: "" }));

/**
 * Holiday deals through the real Worker and a real Postgres, with a fake
 * payment provider (no network): a deal gets one code at the provider, the
 * banner offers a visitor the larger of the deal and their country's discount,
 * and the code is removed at the provider when the deal is deleted or over.
 */

const fake = vi.hoisted(() => {
  const state = {
    webhookSecret: "fake-webhook-signing-secret",
    created: [] as Array<{ id: string; code: string; amount: number; name: string }>,
    deleted: [] as string[],
    /** Make the next N createDiscount / deleteDiscount calls fail. */
    failCreate: 0,
    failDelete: 0,
  };
  function createFakeProvider(name: string) {
    return {
      name,
      async createDiscount(params: { code: string; amount: number; name: string }) {
        if (state.failCreate > 0) {
          state.failCreate--;
          throw new Error("provider says no");
        }
        const id = `fake_disc_${state.created.length + 1}`;
        state.created.push({ id, code: params.code, amount: params.amount, name: params.name });
        return { providerDiscountId: id, code: params.code, discountPercent: params.amount, provider: name };
      },
      async deleteDiscount(id: string) {
        if (state.failDelete > 0) {
          state.failDelete--;
          throw new Error("provider is down");
        }
        state.deleted.push(id);
      },
      async listDiscounts() {
        return [];
      },
      async buildCheckoutUrl() {
        return "https://checkout.fake.test";
      },
      async provisionWebhook() {
        return { endpointId: "fake_endpoint_1", secret: state.webhookSecret };
      },
      async deleteWebhook() {},
      async verifyWebhook(input: { headers: Headers; secret: string | null }) {
        return input.secret !== null && input.headers.get("x-fake-signature") === input.secret;
      },
      parseRedemption(rawBody: string) {
        const body = JSON.parse(rawBody) as { type: string; id: string; code?: string; charged?: number; currency?: string };
        if (body.type !== "order.paid") return null;
        return {
          eventId: body.id,
          code: body.code ?? null,
          providerCouponId: null,
          providerPromoCodeId: null,
          chargedAmountCents: body.charged ?? null,
          discountAmountCents: null,
          taxAmountCents: 0,
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

const HOUR = 3_600_000;
const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();

async function api(path: string, init: Parameters<TestClient["request"]>[1] = {}, tenant: TestTenant = t) {
  return client.request(`/v1/teams/${t.orgId}${path}`, { ...init, headers: as(tenant) });
}

/**
 * Product ($99) + parity group (IN and BR at 40%) + public key + an active
 * campaign, with a Stripe integration unless `integration` is false.
 */
async function setUp(options: { integration?: boolean } = {}) {
  let integrationId: string | null = null;
  if (options.integration !== false) {
    const res = await api("/integrations", {
      method: "POST",
      json: { provider: "stripe", accessToken: "sk_test_fake_key", environment: "live" },
    });
    expect(res.status).toBe(201);
    integrationId = (await res.json()).data.id;
  }
  const product = await (
    await api("/products", { method: "POST", json: { name: "Course", url: "https://shop.example.com", basePrice: 99 } })
  ).json();
  const group = await (
    await api("/parity-groups", { method: "POST", json: { name: "Tier 3", discountPercent: 40, sortOrder: 3 } })
  ).json();
  await api(`/parity-groups/${group.data.id}/countries`, { method: "PUT", json: { countries: ["IN", "BR"] } });
  const key = await (await api("/api-keys", { method: "POST", json: { name: "Site", keyType: "public" } })).json();

  const campaignRes = await api("/campaigns", {
    method: "POST",
    json: { productId: product.data.id, name: "Launch", ...(integrationId ? { integrationId } : {}) },
  });
  expect(campaignRes.status).toBe(201);
  const campaignId = (await campaignRes.json()).data.id as string;
  expect((await api(`/campaigns/${campaignId}`, { method: "PATCH", json: { status: "active" } })).status).toBe(200);
  return { integrationId, campaignId, keyId: key.data.id as string, rawKey: key.data.key as string };
}

function createDeal(campaignId: string, json: Record<string, unknown>) {
  return api(`/campaigns/${campaignId}/deals`, { method: "POST", json });
}

const runningDeal = (overrides: Record<string, unknown> = {}) => ({
  name: "Flash Sale",
  discountPercent: 50,
  startsAt: iso(-HOUR),
  endsAt: iso(24 * HOUR),
  ...overrides,
});

async function banner(rawKey: string, country: string, from: TestClient = client) {
  return (await from.request(`/v1/banner/config/${rawKey}`, { cf: { country } })).json();
}

/** One run of the 10-minute scheduled job, background work settled. */
async function runTenMinuteCron() {
  const ctx = createExecutionContext();
  await worker.scheduled(
    { cron: "*/10 * * * *", scheduledTime: Date.now(), noRetry() {} } as unknown as ScheduledController,
    client.env,
    ctx,
  );
  await ctx.settle();
}

function dealCoupons() {
  return getTestDb().select().from(coupons).where(isNotNull(coupons.dealId));
}

describe("Holiday deals (full Worker, real Postgres, fake payment provider)", () => {
  beforeEach(async () => {
    await cleanupTestDb();
    fake.state.created.length = 0;
    fake.state.deleted.length = 0;
    fake.state.failCreate = 0;
    fake.state.failDelete = 0;
    client = createTestClient(worker, createTestBindings());
    t = await seedTenant(client, "Merchant");
  });

  afterAll(async () => {
    await cleanupTestDb();
    await closeTestDb();
  });

  it("a deal gets one code at the provider and is offered to every visitor it beats or equals", async () => {
    const { integrationId, campaignId, keyId, rawKey } = await setUp();
    const before = fake.state.created.length;

    const res = await createDeal(campaignId, runningDeal());
    expect(res.status).toBe(201);
    const deal = (await res.json()).data;

    // One percentage discount at the provider, named after the deal.
    const made = fake.state.created.slice(before);
    expect(made).toHaveLength(1);
    expect(made[0]).toMatchObject({ amount: 50, name: "Flash Sale 50%" });
    // Stripe codes are alphanumeric: the name, the percentage, four random characters.
    expect(made[0]!.code).toMatch(/^FLASHSALE50[A-Z2-9]{4}$/);

    expect(deal).toMatchObject({
      campaignId,
      name: "Flash Sale",
      discountPercent: 50,
      codeSource: "provider",
      code: made[0]!.code,
      codeReady: true,
      phase: "live",
      messageTemplate: "{{deal}}: {{discount}}% off with code {{code}}. Ends {{ends}}.",
    });

    // Stored as a coupon of the campaign without a country.
    const rows = await dealCoupons();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      dealId: deal.id,
      campaignId,
      integrationId,
      countryCode: null,
      code: made[0]!.code,
      discountPercent: 50,
      status: "active",
      providerCouponId: made[0]!.id,
    });

    // The stored document carries the deal.
    const doc = JSON.parse((await client.env.CACHE.get(`banner-config:${keyId}`))!) as CachedBannerConfig;
    expect(doc.campaigns[campaignId]!.deals).toEqual([
      expect.objectContaining({ id: deal.id, name: "Flash Sale", discount: 50, code: made[0]!.code }),
    ]);

    // A visitor whose country has no discount gets the deal.
    const us = await banner(rawKey, "US");
    expect(us).toMatchObject({
      show: true,
      country: "US",
      countryName: "United States",
      discount: 50,
      code: made[0]!.code,
      campaignId,
      deal: { id: deal.id, name: "Flash Sale", endsAt: deal.endsAt },
      localPrice: 49.5,
      localOriginalPrice: 99,
    });
    // The deal's message with its name and end filled in, and no flag.
    expect(us.banner.showFlag).toBe(false);
    expect(us.banner.messageTemplate).toMatch(/^Flash Sale: \{\{discount\}\}% off with code \{\{code\}\}\. Ends \d{1,2} [A-Z][a-z]+\.$/);

    // A visitor whose country has a smaller discount (40%) gets the deal too.
    const india = await banner(rawKey, "IN");
    expect(india).toMatchObject({ show: true, country: "IN", discount: 50, code: made[0]!.code, deal: { id: deal.id } });

    // Cold KV (database path): the same answer.
    const cold = createTestClient(worker, createTestBindings());
    expect(await banner(rawKey, "US", cold)).toMatchObject({ show: true, discount: 50, code: made[0]!.code, deal: { id: deal.id } });
  });

  it("a visitor whose country discount is larger keeps it; the others get the deal", async () => {
    const { campaignId, rawKey } = await setUp();
    const deal = (await (await createDeal(campaignId, runningDeal({ name: "Spring", discountPercent: 30 }))).json()).data;

    const india = await banner(rawKey, "IN");
    expect(india).toMatchObject({ show: true, country: "IN", discount: 40 });
    expect(india.deal).toBeUndefined();
    expect(india.code).not.toBe(deal.code);
    expect(india.banner.showFlag).toBe(true);

    expect(await banner(rawKey, "US")).toMatchObject({ show: true, discount: 30, code: deal.code, deal: { id: deal.id } });
  });

  it("two deals of one campaign can run at once, each with its own code; the larger is offered", async () => {
    const { campaignId, rawKey } = await setUp();
    const small = (await (await createDeal(campaignId, runningDeal({ name: "Small", discountPercent: 45 }))).json()).data;
    const big = (await (await createDeal(campaignId, runningDeal({ name: "Big", discountPercent: 70 }))).json()).data;

    const rows = await dealCoupons();
    expect(rows.map((r) => r.dealId).sort()).toEqual([small.id, big.id].sort());
    expect(rows.every((r) => r.status === "active" && r.countryCode === null)).toBe(true);
    expect(small.code).not.toBe(big.code);

    expect(await banner(rawKey, "IN")).toMatchObject({ discount: 70, code: big.code, deal: { id: big.id } });

    // Without the larger one, the smaller is offered.
    expect((await api(`/campaigns/${campaignId}/deals/${big.id}`, { method: "DELETE" })).status).toBe(200);
    expect(await banner(rawKey, "IN")).toMatchObject({ discount: 45, code: small.code, deal: { id: small.id } });
  });

  it("on a tie the deal is offered", async () => {
    const { campaignId, rawKey } = await setUp();
    const deal = (await (await createDeal(campaignId, runningDeal({ discountPercent: 40 }))).json()).data;
    expect(await banner(rawKey, "IN")).toMatchObject({ discount: 40, code: deal.code, deal: { id: deal.id } });
  });

  it("a deal is offered only between its start and its end, and its code is removed once it is over", async () => {
    const { campaignId, rawKey } = await setUp();

    // Scheduled: not offered yet, but its code already exists.
    const created = await createDeal(campaignId, runningDeal({ startsAt: iso(HOUR), endsAt: iso(2 * HOUR) }));
    const deal = (await created.json()).data;
    expect(deal).toMatchObject({ phase: "scheduled", codeReady: true });
    expect(await banner(rawKey, "US")).toEqual({ show: false, reason: "no_discount" });
    expect(await banner(rawKey, "IN")).toMatchObject({ show: true, discount: 40 });

    // Started.
    const path = `/campaigns/${campaignId}/deals/${deal.id}`;
    let patched = await api(path, { method: "PATCH", json: { startsAt: iso(-HOUR) } });
    expect(patched.status).toBe(200);
    expect((await patched.json()).data).toMatchObject({ phase: "live", code: deal.code });
    expect(await banner(rawKey, "US")).toMatchObject({ show: true, discount: 50, code: deal.code });

    // Over: not offered from that moment, whatever the stored document says.
    patched = await api(path, { method: "PATCH", json: { endsAt: iso(-1000) } });
    expect(patched.status).toBe(200);
    expect((await patched.json()).data).toMatchObject({ phase: "ended" });
    expect(await banner(rawKey, "US")).toEqual({ show: false, reason: "no_discount" });

    // The scheduled job removes the code at the provider and its row.
    const [row] = await dealCoupons();
    expect(fake.state.deleted).not.toContain(row!.providerCouponId);
    await runTenMinuteCron();
    expect(fake.state.deleted).toContain(row!.providerCouponId);
    expect(await dealCoupons()).toEqual([]);
    const listed = (await (await api(`/campaigns/${campaignId}/deals`)).json()).data;
    expect(listed).toEqual([expect.objectContaining({ id: deal.id, phase: "ended", code: null, codeReady: false })]);

    // Running it again makes a new code.
    const createdBefore = fake.state.created.length;
    patched = await api(path, { method: "PATCH", json: { endsAt: iso(HOUR) } });
    expect(patched.status).toBe(200);
    const again = (await patched.json()).data;
    expect(fake.state.created).toHaveLength(createdBefore + 1);
    expect(again).toMatchObject({ phase: "live", codeReady: true });
    expect(again.code).not.toBe(deal.code);
    expect(await banner(rawKey, "US")).toMatchObject({ show: true, discount: 50, code: again.code });
  });

  it("when the provider refuses the code, no deal is stored and the integration shows why", async () => {
    const { integrationId, campaignId, rawKey } = await setUp();
    fake.state.failCreate = 1;

    const res = await createDeal(campaignId, runningDeal());
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({
      error: "Couldn't create the deal's code at stripe: provider says no",
      code: "provider_error",
    });
    expect(await getTestDb().select().from(deals)).toEqual([]);
    expect(await dealCoupons()).toEqual([]);
    expect(await banner(rawKey, "US")).toEqual({ show: false, reason: "no_discount" });

    const list = (await (await api("/integrations")).json()).data;
    expect(JSON.stringify(list.find((i: { id: string }) => i.id === integrationId))).toContain('the deal \\"Flash Sale\\"');
  });

  it("deleting a deal removes its code at the provider; a refusal is reported and retried", async () => {
    const { campaignId, rawKey } = await setUp();
    const first = (await (await createDeal(campaignId, runningDeal())).json()).data;
    const [row] = await dealCoupons();

    let res = await api(`/campaigns/${campaignId}/deals/${first.id}`, { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    expect(fake.state.deleted).toEqual([row!.providerCouponId]);
    expect(await dealCoupons()).toEqual([]);
    expect(await getTestDb().select().from(deals)).toEqual([]);
    expect(await banner(rawKey, "US")).toEqual({ show: false, reason: "no_discount" });

    // The provider refuses the removal: the deal is gone, the code is parked
    // (never shown) and the merchant is told.
    const second = (await (await createDeal(campaignId, runningDeal({ name: "Second" }))).json()).data;
    const [secondRow] = await dealCoupons();
    fake.state.failDelete = 1;
    res = await api(`/campaigns/${campaignId}/deals/${second.id}`, { method: "DELETE" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.warning).toContain(second.code);
    expect(await getTestDb().select().from(deals)).toEqual([]);
    expect(await dealCoupons()).toEqual([expect.objectContaining({ id: secondRow!.id, status: "retiring" })]);
    expect(await banner(rawKey, "US")).toEqual({ show: false, reason: "no_discount" });

    // The scheduled job tries again and finishes the removal.
    await runTenMinuteCron();
    expect(fake.state.deleted).toContain(secondRow!.providerCouponId);
    expect(await dealCoupons()).toEqual([]);
  });

  it("a purchase with the deal's code is counted on the campaign", async () => {
    const { integrationId, campaignId } = await setUp();
    const deal = (await (await createDeal(campaignId, runningDeal())).json()).data;

    const res = await client.request(`/v1/webhooks/stripe/${integrationId}`, {
      method: "POST",
      headers: { "x-fake-signature": fake.state.webhookSecret },
      json: { type: "order.paid", id: "evt_deal_1", code: deal.code.toLowerCase(), charged: 4950, currency: "usd" },
    });
    expect(res.status).toBe(200);

    const rollups = await getTestDb()
      .select()
      .from(analyticsRollups)
      .where(and(eq(analyticsRollups.campaignId, campaignId), eq(analyticsRollups.redemptions, 1)));
    // A deal's code has no country: its purchases are counted under "XX".
    expect(rollups).toEqual([expect.objectContaining({ countryCode: "XX", redemptions: 1, revenueSaved: 49.5 })]);
  });

  it("a campaign without a payment integration takes a code you made yourself, or none", async () => {
    const { campaignId, rawKey } = await setUp({ integration: false });

    const manual = await createDeal(campaignId, runningDeal({ name: "Manual", discountPercent: 25, code: "MYCODE25" }));
    expect(manual.status).toBe(201);
    expect((await manual.json()).data).toMatchObject({ codeSource: "manual", code: "MYCODE25", codeReady: true });
    expect(fake.state.created).toEqual([]);
    expect(await dealCoupons()).toEqual([]);
    expect(await banner(rawKey, "US")).toMatchObject({ show: true, discount: 25, code: "MYCODE25" });

    const none = await createDeal(campaignId, runningDeal({ name: "No code", discountPercent: 60 }));
    expect(none.status).toBe(201);
    expect((await none.json()).data).toMatchObject({
      codeSource: "none",
      code: null,
      codeReady: true,
      messageTemplate: "{{deal}}: {{discount}}% off. Ends {{ends}}.",
    });
    // The larger of the two running deals is the one offered.
    const us = await banner(rawKey, "US");
    expect(us).toMatchObject({ show: true, discount: 60, code: null, deal: { name: "No code" } });
    expect(us.banner.messageTemplate).toMatch(/^No code: \{\{discount\}\}% off\. Ends /);
  });

  it("refuses a typed code on a campaign that creates its codes at the provider", async () => {
    const { campaignId } = await setUp();
    const res = await createDeal(campaignId, runningDeal({ code: "MYCODE" }));
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("code_not_allowed");
    expect(await getTestDb().select().from(deals)).toEqual([]);
  });

  it("refuses a deal that is already over, a bad window, and more than the limit", async () => {
    const { campaignId } = await setUp({ integration: false });

    let res = await createDeal(campaignId, runningDeal({ startsAt: iso(-2 * HOUR), endsAt: iso(-HOUR) }));
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("deal_in_the_past");

    res = await createDeal(campaignId, runningDeal({ startsAt: iso(2 * HOUR), endsAt: iso(HOUR) }));
    expect(res.status).toBe(400);

    res = await createDeal(campaignId, runningDeal({ discountPercent: 0 }));
    expect(res.status).toBe(400);

    for (let i = 0; i < MAX_DEALS_PER_CAMPAIGN; i++) {
      expect((await createDeal(campaignId, runningDeal({ name: `Deal ${i}`, discountPercent: 10 }))).status).toBe(201);
    }
    res = await createDeal(campaignId, runningDeal({ name: "One too many" }));
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("deal_limit");

    // An update cannot make the window invalid either.
    const [first] = (await (await api(`/campaigns/${campaignId}/deals`)).json()).data;
    res = await api(`/campaigns/${campaignId}/deals/${first.id}`, { method: "PATCH", json: { endsAt: iso(-3 * HOUR) } });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("invalid_window");
  });

  it("another workspace cannot see, create, change or delete a campaign's deals", async () => {
    const { campaignId } = await setUp();
    const deal = (await (await createDeal(campaignId, runningDeal())).json()).data;
    const other = await seedTenant(client, "Other");
    const asOther = (path: string, init: Parameters<TestClient["request"]>[1] = {}) =>
      client.request(`/v1/teams/${other.orgId}${path}`, { ...init, headers: as(other) });

    expect((await asOther(`/campaigns/${campaignId}/deals`)).status).toBe(404);
    expect((await asOther(`/campaigns/${campaignId}/deals`, { method: "POST", json: runningDeal() })).status).toBe(404);
    expect((await asOther(`/campaigns/${campaignId}/deals/${deal.id}`, { method: "PATCH", json: { name: "x" } })).status).toBe(404);
    expect((await asOther(`/campaigns/${campaignId}/deals/${deal.id}`, { method: "DELETE" })).status).toBe(404);
    // And not through the first workspace's path with their own session.
    expect((await api(`/campaigns/${campaignId}/deals`, {}, other)).status).toBeGreaterThanOrEqual(401);

    expect(await getTestDb().select().from(deals)).toHaveLength(1);
    expect(fake.state.deleted).toEqual([]);
  });

  it("deleting the campaign removes its deals", async () => {
    const { campaignId } = await setUp();
    await createDeal(campaignId, runningDeal());
    expect(await getTestDb().select().from(deals)).toHaveLength(1);

    expect((await api(`/campaigns/${campaignId}`, { method: "DELETE" })).status).toBe(200);
    expect(await getTestDb().select().from(deals)).toEqual([]);
    expect(await dealCoupons()).toEqual([]);
  });

  it("unlinking the integration stops the deal being offered; linking one again brings it back with a new code", async () => {
    const { integrationId, campaignId, rawKey } = await setUp();
    const deal = (await (await createDeal(campaignId, runningDeal())).json()).data;
    const [row] = await dealCoupons();

    expect((await api(`/campaigns/${campaignId}`, { method: "PATCH", json: { integrationId: null } })).status).toBe(200);
    // The old code is removed at the provider, and the deal has none.
    expect(fake.state.deleted).toContain(row!.providerCouponId);
    expect(await dealCoupons()).toEqual([]);
    let [listed] = (await (await api(`/campaigns/${campaignId}/deals`)).json()).data;
    expect(listed).toMatchObject({ id: deal.id, code: null, codeReady: false });
    expect(await banner(rawKey, "US")).toEqual({ show: false, reason: "no_discount" });

    expect((await api(`/campaigns/${campaignId}`, { method: "PATCH", json: { integrationId } })).status).toBe(200);
    [listed] = (await (await api(`/campaigns/${campaignId}/deals`)).json()).data;
    expect(listed).toMatchObject({ id: deal.id, codeReady: true });
    expect(listed.code).not.toBe(deal.code);
    expect(await banner(rawKey, "US")).toMatchObject({ show: true, discount: 50, code: listed.code });
  });

  it("the stored document is left alone while its deals match Postgres, and rewritten once a deal is over", async () => {
    const { campaignId, keyId } = await setUp();
    const deal = (await (await createDeal(campaignId, runningDeal())).json()).data;
    const db = getTestDb();
    const stored = () => client.env.CACHE.get(`banner-config:${keyId}`);

    const before = await stored();
    expect(await refreshBannerConfigForOrg(db, client.env.CACHE, t.orgId, client.env)).toBe("current");
    expect(await stored()).toBe(before);

    // Ended behind the document's back (as time passing does).
    await db.update(deals).set({ startsAt: new Date(Date.now() - 2 * HOUR), endsAt: new Date(Date.now() - HOUR) }).where(eq(deals.id, deal.id));
    expect(await refreshBannerConfigForOrg(db, client.env.CACHE, t.orgId, client.env)).toBe("rebuilt");
    const after = JSON.parse((await stored())!) as CachedBannerConfig;
    expect(after.campaigns[campaignId]!.deals).toBeUndefined();
    expect(await refreshBannerConfigForOrg(db, client.env.CACHE, t.orgId, client.env)).toBe("current");
  });
});
