import { describe, it, expect, beforeEach, afterAll, afterEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { getTestDb, cleanupTestDb, closeTestDb } from "../test/setup";
import { createTestBindings } from "../test/helpers";
import { apiKeys, campaignCountryPrices, campaigns, integrations, products } from "../db/schema";
import { encrypt, tokenEncryptionSecret } from "../lib/crypto";
import { insertCampaignWithBanner } from "../routes/campaigns";
import { bannerDocKey, loadServingInputs, type CachedBannerConfig } from "./banner-cache.service";
import type { DodoRule } from "./dodo-country-prices";
import {
  countryPricesLeft,
  dueCountryPriceRows,
  markCountryPricesDue,
  productTakenByAnotherCampaign,
  reconcileCampaignCountryPrices,
  removeCountryPricesBeforeDisconnect,
  syncCountryPriceRow,
} from "./campaign-country-prices.service";

// Real SQL for the campaign_country_prices rows (migrations 0007 and 0008).
// No Dodo key is stored anywhere here: nothing in these tests reaches Dodo.

const ORG = "test-org-country-prices";
const db = () => getTestDb();

async function seed(campaign: Partial<typeof campaigns.$inferInsert> = {}) {
  await db().insert(products).values({ id: "prod_1", organizationId: ORG, name: "Pro", url: "https://example.com", basePrice: 19, currency: "USD" });
  await db().insert(integrations).values({ id: "int_1", organizationId: ORG, provider: "dodopayments" });
  await db()
    .insert(campaigns)
    .values({
      id: "cmp_1",
      organizationId: ORG,
      productId: "prod_1",
      integrationId: "int_1",
      name: "Country prices",
      status: "active",
      discountDelivery: "provider_price",
      providerProductId: "pdt_FAKE1",
      environment: "live",
      ...campaign,
    });
}

async function campaignRow() {
  const [row] = await db().select().from(campaigns).where(eq(campaigns.id, "cmp_1"));
  return row!;
}

async function rows() {
  return db()
    .select({ id: campaignCountryPrices.id, providerProductId: campaignCountryPrices.providerProductId, wanted: campaignCountryPrices.wanted })
    .from(campaignCountryPrices)
    .orderBy(campaignCountryPrices.providerProductId);
}

describe("campaign_country_prices", () => {
  beforeEach(async () => {
    await cleanupTestDb();
  });

  afterAll(async () => {
    await cleanupTestDb();
    await closeTestDb();
  });

  it("reconcile adds the row an active campaign wants, once, and marks it 'none' when the campaign stops wanting it", async () => {
    await seed();
    const first = await reconcileCampaignCountryPrices(db(), "cmp_1", await campaignRow());
    const again = await reconcileCampaignCountryPrices(db(), "cmp_1", await campaignRow());
    expect(first).toHaveLength(1);
    expect(again).toEqual(first);
    expect(await rows()).toEqual([{ id: first[0], providerProductId: "pdt_FAKE1", wanted: "prices" }]);

    await db().update(campaigns).set({ providerProductId: "pdt_FAKE2" }).where(eq(campaigns.id, "cmp_1"));
    await reconcileCampaignCountryPrices(db(), "cmp_1", await campaignRow());
    expect((await rows()).map((r) => [r.providerProductId, r.wanted])).toEqual([
      ["pdt_FAKE1", "none"],
      ["pdt_FAKE2", "prices"],
    ]);

    await reconcileCampaignCountryPrices(db(), "cmp_1", null); // deleted
    expect((await rows()).map((r) => r.wanted)).toEqual(["none", "none"]);
  });

  it("removes a row never verified without calling Dodo, and the campaign's current product gets its row", async () => {
    await seed();
    const [id] = await reconcileCampaignCountryPrices(db(), "cmp_1", await campaignRow());
    // Same product id, other environment: the old row goes first (one row per product id).
    await db().update(campaigns).set({ environment: "test" }).where(eq(campaigns.id, "cmp_1"));
    await reconcileCampaignCountryPrices(db(), "cmp_1", await campaignRow());
    expect((await rows()).map((r) => r.wanted)).toEqual(["none"]);

    const result = await syncCountryPriceRow(db(), createTestBindings(), id!, { budget: 20, trigger: "schedule" });

    expect(result).toMatchObject({ outcome: "synced", removed: true });
    const after = await db().select().from(campaignCountryPrices);
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ providerProductId: "pdt_FAKE1", environment: "test", wanted: "prices" });
  });

  it("serves the published prices of the campaign's current row only", async () => {
    await seed();
    await db().insert(campaignCountryPrices).values([
      {
        id: "ccp_current",
        campaignId: "cmp_1",
        organizationId: ORG,
        integrationId: "int_1",
        environment: "live",
        providerProductId: "pdt_FAKE1",
        wanted: "prices",
        published: { IN: { currency: "INR", minorAmount: 52900, discount: 70 } },
      },
      {
        id: "ccp_old",
        campaignId: "cmp_1",
        organizationId: ORG,
        integrationId: "int_1",
        environment: "live",
        providerProductId: "pdt_FAKE0",
        wanted: "none",
        published: { IN: { currency: "INR", minorAmount: 100, discount: 70 } },
      },
    ]);

    const inputs = await loadServingInputs(db(), ORG);

    expect(inputs.campaigns[0]).toMatchObject({
      discountDelivery: "provider_price",
      countryPrices: { IN: { currency: "INR", minorAmount: 52900, discount: 70 } },
    });
  });

  it("knows a product another campaign prices, the prices left at Dodo, and which rows are due", async () => {
    await seed();
    await db().insert(campaignCountryPrices).values({
      id: "ccp_1",
      campaignId: "cmp_1",
      organizationId: ORG,
      integrationId: "int_1",
      environment: "live",
      providerProductId: "pdt_FAKE1",
      wanted: "prices",
      published: {
        IN: { currency: "INR", minorAmount: 52900, discount: 70 },
        DE: { currency: "EUR", minorAmount: 1500, discount: null },
      },
      verifiedAt: new Date(),
      syncedAt: new Date(),
    });
    const product = { organizationId: ORG, integrationId: "int_1", providerProductId: "pdt_FAKE1" };

    expect(await productTakenByAnotherCampaign(db(), { ...product, campaignId: "cmp_2" })).toBe(true);
    expect(await productTakenByAnotherCampaign(db(), { ...product, campaignId: "cmp_1" })).toBe(false);
    expect(await countryPricesLeft(db(), "cmp_1")).toBe(1); // DE is the merchant's rule

    const now = Date.now();
    expect(await dueCountryPriceRows(db(), now, 5)).toEqual([]);
    await markCountryPricesDue(db(), ORG);
    expect(await dueCountryPriceRows(db(), now, 5)).toEqual(["ccp_1"]);
  });

  it("before a disconnect, pauses the campaign, drops rows that never wrote a price, and nothing adds them back", async () => {
    await seed();
    await reconcileCampaignCountryPrices(db(), "cmp_1", await campaignRow());

    const out = await removeCountryPricesBeforeDisconnect(db(), createTestBindings(), ORG, "int_1");

    expect(out).toEqual({ pending: 0, stuck: 0, paused: 1 });
    expect((await campaignRow()).status).toBe("paused");
    expect(await db().select().from(campaignCountryPrices)).toHaveLength(0);
  });
});

/**
 * A Dodo live-mode API for one product (pdt_FAKE1, $19 a month), in memory.
 * Stands in for fetch, so the sync runs exactly as in production.
 */
function fakeDodo() {
  const dodo = { pricingMode: null as string | null, rules: [] as DodoRule[], next: 1, calls: [] as string[] };
  const reply = (status: number, body: unknown = {}) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    dodo.calls.push(`${method} ${url.pathname}`);
    if (url.origin !== "https://live.dodopayments.com") return reply(404, { message: "unexpected host" });
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    if (url.pathname === "/products/pdt_FAKE1") {
      if (method === "GET") {
        return reply(200, {
          product_id: "pdt_FAKE1",
          pricing_mode: dodo.pricingMode,
          price: { type: "recurring_price", price: 1900, currency: "USD", purchasing_power_parity: false },
        });
      }
      if (method === "PATCH") {
        dodo.pricingMode = String(body.pricing_mode);
        return reply(200);
      }
    }
    if (url.pathname === "/products/pdt_FAKE1/localized-prices") {
      if (method === "GET") return reply(200, { items: dodo.rules });
      if (method === "POST") {
        const rule = { id: `lp_${dodo.next++}`, country_code: String(body.country_code), currency: String(body.currency), amount: Number(body.amount) };
        dodo.rules.push(rule);
        return reply(200, rule);
      }
    }
    const one = url.pathname.match(/^\/products\/pdt_FAKE1\/localized-prices\/([^/]+)$/);
    if (one) {
      const id = decodeURIComponent(one[1]!);
      if (method === "DELETE") {
        dodo.rules = dodo.rules.filter((r) => r.id !== id);
        return reply(200);
      }
      if (method === "PATCH") {
        dodo.rules = dodo.rules.map((r) => (r.id === id ? { ...r, amount: Number(body.amount) } : r));
        return reply(200);
      }
    }
    return reply(404, { message: "not found" });
  };
  return { dodo, fetchImpl };
}

describe("country prices at Dodo, end to end", () => {
  const env = createTestBindings();

  beforeEach(async () => {
    await cleanupTestDb();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function seedMerchant() {
    await db().insert(apiKeys).values({
      id: "key_pub",
      organizationId: ORG,
      name: "Public",
      keyType: "public",
      keyHash: "hash_FAKE_public",
      keyPrefix: "pk_FAKE",
    });
    await db().insert(products).values({ id: "prod_1", organizationId: ORG, name: "Pro", url: "https://example.com", basePrice: 19, currency: "USD" });
    await db().insert(integrations).values({
      id: "int_1",
      organizationId: ORG,
      provider: "dodopayments",
      liveAccessTokenEnc: await encrypt("dodo_FAKE_key", tokenEncryptionSecret(env)),
    });
    await insertCampaignWithBanner(
      db(),
      {
        id: "cmp_1",
        organizationId: ORG,
        productId: "prod_1",
        integrationId: "int_1",
        name: "Country prices",
        status: "active",
        pricingMode: "custom",
        discountOverrides: { IN: 50, BR: 40 },
        maxDiscountPercent: 70,
        charmPricingStrategy: "none",
        discountDelivery: "provider_price",
        providerProductId: "pdt_FAKE1",
        environment: "live",
      },
      "banner_1",
    );
  }

  it("refuses a product with rules of its own, writes the prices once it has none, serves them, and removes only its own", async () => {
    await seedMerchant();
    const { dodo, fetchImpl } = fakeDodo();
    vi.stubGlobal("fetch", fetchImpl);
    dodo.rules = [{ id: "lp_theirs", country_code: "DE", currency: "EUR", amount: 1500 }];

    // 1. The product has a price rule of the merchant's: nothing is written.
    const [rowId] = await reconcileCampaignCountryPrices(db(), "cmp_1", await campaignRow());
    const refused = await syncCountryPriceRow(db(), env, rowId!, { budget: 30, trigger: "change" });
    expect(refused).toMatchObject({ outcome: "problem", problem: expect.stringMatching(/already has 1 price rule/) });
    expect(dodo.calls.filter((c) => !c.startsWith("GET"))).toEqual([]);
    expect(dodo.pricingMode).toBeNull();

    // 2. The merchant removes it: the prices are written and recorded.
    dodo.rules = [];
    const synced = await syncCountryPriceRow(db(), env, rowId!, { budget: 30, trigger: "manual" });
    expect(synced).toMatchObject({ outcome: "synced", record: { created: 2, failures: [], remaining: 0 } });
    expect(dodo.pricingMode).toBe("by_country");
    const [row] = await db().select().from(campaignCountryPrices).where(eq(campaignCountryPrices.id, rowId!));
    expect(row!.verifiedAt).not.toBeNull();
    const byCountry = Object.fromEntries(dodo.rules.map((r) => [r.country_code, r]));
    expect(row!.published).toEqual({
      IN: { currency: byCountry.IN!.currency, minorAmount: byCountry.IN!.amount, discount: 50 },
      BR: { currency: byCountry.BR!.currency, minorAmount: byCountry.BR!.amount, discount: 40 },
    });

    // 3. The banner serves exactly what Dodo charges (no exchange rates here: dollars).
    const doc = JSON.parse((await env.CACHE.get(bannerDocKey("key_pub")))!) as CachedBannerConfig;
    expect(doc.campaigns.cmp_1!.countries.IN).toMatchObject({ discount: 50, code: null, charge: { currency: "USD", amount: 9.5 } });
    expect(doc.campaigns.cmp_1!.countries.BR).toMatchObject({ discount: 40, code: null, charge: { currency: "USD", amount: 11.4 } });

    // 4. The merchant adds a rule of their own, then pauses the campaign:
    //    GoPayLocal removes its two rules and leaves theirs.
    dodo.rules.push({ id: "lp_theirs2", country_code: "DE", currency: "EUR", amount: 1500 });
    await db().update(campaigns).set({ status: "paused" }).where(eq(campaigns.id, "cmp_1"));
    const [removal] = await reconcileCampaignCountryPrices(db(), "cmp_1", await campaignRow());
    const removed = await syncCountryPriceRow(db(), env, removal!, { budget: 30, trigger: "change" });
    expect(removed).toMatchObject({ outcome: "synced", removed: true, record: { archived: 2 } });
    expect(dodo.rules.map((r) => r.id)).toEqual(["lp_theirs2"]);
    expect(await db().select().from(campaignCountryPrices)).toHaveLength(0);
  });
});
