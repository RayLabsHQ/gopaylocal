import { describe, it, expect, beforeEach, afterAll, afterEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { ulid } from "ulid";
import worker from "../index";
import {
  analyticsRollups,
  apiKeys,
  bannerConfigs,
  campaigns,
  products,
  subscriptions,
  users,
} from "../db/schema";
import { createTestBindings, createTestClient, type TestClient } from "../test/helpers";
import { as, seedOrg, seedTenant, seedUser, signIn, type TestUser } from "../test/auth";
import { cleanupTestDb, closeTestDb, getTestDb } from "../test/setup";

/**
 * The admin's revenue, activation, audit log and internal flag, and the
 * regional Pro price synced to a stand-in for Dodo's Localized Pricing API.
 * Exchange rates are off, so every country is charged in USD.
 */

const PRO_PRODUCT = "pdt_FAKE_PRO";

async function platformAdmin(client: TestClient): Promise<{ user: TestUser; cookie: string }> {
  const user = await seedUser(client.env, "Platform Admin");
  await getTestDb().update(users).set({ role: "admin" }).where(eq(users.id, user.id));
  return { user, cookie: await signIn(client, user) };
}

/** A display-only campaign for a $19 product: no payment platform, PPP factor, capped at 70%. */
async function seedHouse(ownerId: string) {
  const db = getTestDb();
  const orgId = await seedOrg(ownerId, "House");
  const productId = ulid();
  const campaignId = ulid();
  await db.insert(products).values({ id: productId, organizationId: orgId, name: "Pro", url: "https://example.com", currency: "USD", basePrice: 19 });
  await db.insert(campaigns).values({
    id: campaignId,
    organizationId: orgId,
    productId,
    name: "Pro regional price",
    status: "active",
    pricingMode: "ppp_factor",
    maxDiscountPercent: 70,
  });
  await db.insert(bannerConfigs).values({ id: ulid(), campaignId, messageTemplate: "{{discount}}% off Pro in {{country}}" });
  await db.insert(apiKeys).values({
    id: ulid(),
    organizationId: orgId,
    name: "Site",
    keyType: "public",
    keyHash: `hash-${ulid()}`,
    keyPrefix: "gpl_pk_live_FAKE",
  });
  return { orgId, campaignId };
}

/** Dodo's product and Localized Pricing endpoints, in memory. */
function fakeDodo() {
  const state = { pricingMode: null as string | null, rules: [] as Array<{ id: string; country_code: string; currency: string; amount: number }>, calls: 0 };
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.hostname !== "test.dodopayments.com") throw new Error(`unexpected fetch to ${url.hostname}`);
    state.calls++;
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    const base = `/products/${PRO_PRODUCT}`;
    if (url.pathname === base && method === "GET") return json({ product_id: PRO_PRODUCT, pricing_mode: state.pricingMode });
    if (url.pathname === base && method === "PATCH") {
      state.pricingMode = body.pricing_mode;
      return json({});
    }
    if (url.pathname === `${base}/localized-prices` && method === "GET") return json({ items: state.rules });
    if (url.pathname === `${base}/localized-prices` && method === "POST") {
      if (state.pricingMode !== "by_country") return json({ message: "pricing_mode is not by_country" }, 422);
      if (state.rules.some((r) => r.country_code === body.country_code)) return json({ message: "Active rule already exists" }, 409);
      const rule = { id: `lcp_${state.rules.length + 1}`, country_code: body.country_code, currency: body.currency, amount: body.amount };
      state.rules.push(rule);
      return json(rule);
    }
    const one = url.pathname.match(/\/localized-prices\/([^/]+)$/);
    const rule = one ? state.rules.find((r) => r.id === one[1]) : undefined;
    if (rule && method === "PATCH") {
      rule.amount = body.amount;
      return json(rule);
    }
    if (rule && method === "DELETE") {
      state.rules = state.rules.filter((r) => r !== rule);
      return json({});
    }
    return json({ message: "not found" }, 404);
  });
  return { state, fetchMock };
}

describe("admin insights and the regional Pro price", () => {
  let client: TestClient;

  beforeEach(async () => {
    await cleanupTestDb();
    client = createTestClient(
      worker,
      createTestBindings({
        DODO_API_KEY: "dodo_test_FAKE",
        DODO_ENVIRONMENT: "test_mode",
        DODO_PRICE_ID_PRO_MONTHLY: PRO_PRODUCT,
        FX_RATES_URL: "off",
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  afterAll(async () => {
    await closeTestDb();
  });

  it("syncs the house campaign's prices to Dodo in batches, and keeps them in step when the campaign changes", async () => {
    const admin = await platformAdmin(client);
    const house = await seedHouse(admin.user.id);
    const dodo = fakeDodo();
    vi.stubGlobal("fetch", dodo.fetchMock);

    // Only a campaign of an internal workspace can price Pro.
    const refused = await client.request("/v1/admin/house-pricing", { method: "PUT", headers: as(admin), json: { campaignId: house.campaignId } });
    expect(refused.status).toBe(400);
    const marked = await client.request(`/v1/admin/organizations/${house.orgId}/internal`, {
      method: "PUT",
      headers: as(admin),
      json: { internal: true, note: "house" },
    });
    expect(marked.status).toBe(200);
    const set = await client.request("/v1/admin/house-pricing", { method: "PUT", headers: as(admin), json: { campaignId: house.campaignId } });
    expect(set.status).toBe(200);

    // Before any sync: every discounted country is missing at Dodo.
    const before = (await (await client.request("/v1/admin/house-pricing", { headers: as(admin) })).json()).data;
    expect(before.table.ok).toBe(true);
    const rows = before.table.rows as Array<{ country: string; discount: number; currency: string; amount: number; dodo: { status: string } }>;
    expect(rows.length).toBeGreaterThan(40);
    expect(rows.every((r) => r.dodo.status === "missing")).toBe(true);
    const india = rows.find((r) => r.country === "IN")!;
    expect(india).toMatchObject({ discount: 70, currency: "USD", amount: 5.7 });

    // Push until nothing is left; each request stays within its call budget.
    let batches = 0;
    for (;;) {
      const callsBefore = dodo.state.calls;
      const res = await client.request("/v1/admin/house-pricing/sync", { method: "POST", headers: as(admin) });
      const result = (await res.json()).data;
      expect(result.outcome).toBe("synced");
      expect(result.record.failures).toEqual([]);
      expect(dodo.state.calls - callsBefore).toBeLessThanOrEqual(35);
      batches++;
      if (result.record.remaining === 0) break;
      expect(batches).toBeLessThan(10);
    }
    expect(batches).toBeGreaterThan(1);
    expect(dodo.state.pricingMode).toBe("by_country");
    expect(dodo.state.rules).toHaveLength(rows.length);
    expect(dodo.state.rules.find((r) => r.country_code === "IN")).toMatchObject({ currency: "USD", amount: 570 });

    const synced = (await (await client.request("/v1/admin/house-pricing", { headers: as(admin) })).json()).data;
    expect(synced.table.rows.every((r: { dodo: { status: string } }) => r.dodo.status === "match")).toBe(true);
    expect(synced.dodo).toEqual({ ok: true, extraRules: 0 });

    // A lower cap: changed amounts are updated in place, nothing is created.
    await getTestDb().update(campaigns).set({ maxDiscountPercent: 50 }).where(eq(campaigns.id, house.campaignId));
    let update;
    do {
      update = (await (await client.request("/v1/admin/house-pricing/sync", { method: "POST", headers: as(admin) })).json()).data;
      expect(update.record.created).toBe(0);
    } while (update.record.remaining > 0);
    expect(dodo.state.rules.find((r) => r.country_code === "IN")).toMatchObject({ currency: "USD", amount: 950 });
    expect(dodo.state.rules).toHaveLength(rows.length);

    // The house workspace stays internal while it prices Pro.
    const unmark = await client.request(`/v1/admin/organizations/${house.orgId}/internal`, {
      method: "PUT",
      headers: as(admin),
      json: { internal: false },
    });
    expect(unmark.status).toBe(409);

    const audit = (await (await client.request("/v1/admin/audit", { headers: as(admin) })).json()).data as Array<{ action: string }>;
    const actions = audit.map((a) => a.action);
    expect(actions).toContain("mark_internal");
    expect(actions).toContain("set_house_pricing");
    expect(actions).toContain("sync_house_pricing");
  });

  it("revenue and activation leave out internal workspaces and test-mode subscriptions", async () => {
    const admin = await platformAdmin(client);
    const db = getTestDb();
    const house = await seedHouse(admin.user.id);
    await client.request(`/v1/admin/organizations/${house.orgId}/internal`, { method: "PUT", headers: as(admin), json: { internal: true } });

    const buyer = await seedTenant(client, "Buyer");
    const tester = await seedTenant(client, "Tester");
    const signedUp = await seedTenant(client, "Just Signed Up");
    await db.insert(subscriptions).values([
      { id: ulid(), organizationId: buyer.orgId, plan: "pro", status: "active", environment: "live", recurringAmount: 47_900, currency: "INR", billingCountry: "IN" },
      { id: ulid(), organizationId: tester.orgId, plan: "pro", status: "active", environment: "test", recurringAmount: 1900, currency: "USD" },
      { id: ulid(), organizationId: house.orgId, plan: "pro", status: "active", environment: "live", recurringAmount: 1900, currency: "USD" },
    ]);
    // The buyer went all the way: a live product, an active campaign, live banner views.
    const productId = ulid();
    await db.insert(products).values({ id: productId, organizationId: buyer.orgId, name: "App", url: "https://example.com", basePrice: 10 });
    await db.insert(campaigns).values({ id: ulid(), organizationId: buyer.orgId, productId, name: "PPP", status: "active", pricingMode: "ppp_factor" });
    await db.insert(analyticsRollups).values({
      id: ulid(),
      organizationId: buyer.orgId,
      period: "day",
      periodStart: new Date(),
      impressions: 12,
      environment: "live",
    });

    const revenue = (await (await client.request("/v1/admin/revenue", { headers: as(admin) })).json()).data.summary;
    expect(revenue).toMatchObject({
      active: 1,
      mrrByCurrency: { INR: 479 },
      estimatedMRR: 0,
      leftOut: { test: 1, internal: 1 },
    });
    expect(revenue.byCountry).toEqual([{ country: "IN", countryName: "India", subscriptions: 1, mrrByCurrency: { INR: 479 } }]);

    const activation = (await (await client.request("/v1/admin/activation", { headers: as(admin) })).json()).data;
    // House is internal: buyer, tester and the new sign-up remain.
    expect(activation.totalOrganizations).toBe(3);
    const steps = Object.fromEntries(
      (activation.funnel as Array<{ key: string; reached: number; stuck: Array<{ id: string }> }>).map((s) => [s.key, s]),
    );
    expect(steps.signedUp!.reached).toBe(3);
    expect(steps.hasProduct!.reached).toBe(1);
    expect(steps.hasProduct!.stuck.map((s) => s.id).sort()).toEqual([signedUp.orgId, tester.orgId].sort());
    expect(steps.isPro!.reached).toBe(1);
    expect(activation.adoption.pricingModes).toEqual({ ppp_factor: 1 });

    const stats = (await (await client.request("/v1/admin/stats", { headers: as(admin) })).json()).data;
    expect(stats).toMatchObject({ totalOrganizations: 3, internalOrganizations: 1, testSubscriptions: 1, mrrByCurrency: { INR: 479 } });
    expect(stats.platformFunnel.impressions).toBe(12);
  });
});
