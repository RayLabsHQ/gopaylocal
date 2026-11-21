import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { ulid } from "ulid";
import worker from "../index";
import { subscriptions } from "../db/schema";
import { bannerDocKey, isCurrentBannerDoc } from "../services/banner-cache.service";
import { resetFxCacheForTests } from "../services/fx-cache";
import { FX_RATES_KEY } from "../services/fx-refresh.service";
import { FX_DOC_VERSION } from "@gopaylocal/shared/currency";
import { createTestBindings, createTestClient, type TestClient } from "../test/helpers";
import { as, seedTenant, type TestTenant } from "../test/auth";
import { cleanupTestDb, closeTestDb, getTestDb } from "../test/setup";

// index.ts pulls in the banner route, which imports the browser bundle as a
// wrangler text module; stub it so browser code never runs under Node.
vi.mock("../../../../packages/banner/dist/banner.js", () => ({ default: "" }));

/**
 * Local prices on the banner endpoint, through the real Worker and Postgres
 * (banner-core's multi-currency and charm pricing, run by test-infra):
 * converted with fresh rates, exact without them, the v3 banner document and
 * its database fallback, product edits rebuilding the document, and secret keys
 * refused before KV or Postgres. Setup goes through the dashboard routes, so the
 * document under test is the one those routes write.
 *
 * Rates: the USD, EUR, INR and PKR entries of the shared fixture behind the docs
 * examples (FIXTURE_RATES_2026_11_18 in packages/shared/src/currency/
 * fx-test-fixture.ts; the fixture is outside this package's rootDir, so the
 * values are repeated here), re-dated to today so the test does not age
 * out of the 96-hour window.
 */

let client: TestClient;
let t: TestTenant;

const DAY_MS = 86_400_000;
const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const FIXTURE_RATES = { USD: 1, EUR: 0.91080569, INR: 93.32614706, PKR: 276.41190323 };

/**
 * Seed `fx:rates` dated `asOf` (null: no document at all), and forget the
 * per-isolate memo. `extra` adds or replaces fields (held currencies).
 */
async function seedFx(asOf: string | null, extra: Record<string, unknown> = {}) {
  resetFxCacheForTests();
  if (asOf === null) {
    await client.env.CACHE.delete(FX_RATES_KEY);
    return;
  }
  await client.env.CACHE.put(
    FX_RATES_KEY,
    JSON.stringify({
      v: FX_DOC_VERSION,
      base: "USD",
      asOf,
      fetchedAt: `${asOf}T06:40:00.000Z`,
      source: "primary",
      rates: FIXTURE_RATES,
      held: [],
      ...extra,
    }),
  );
}

type TestResponse = Awaited<ReturnType<TestClient["request"]>>;

const api = (path: string, init: Parameters<TestClient["request"]>[1] = {}) =>
  client.request(`/v1/teams/${t.orgId}${path}`, { ...init, headers: as(t) });

async function created(res: TestResponse): Promise<{ id: string; key?: string }> {
  expect(res.status).toBe(201);
  return (await res.json()).data;
}

interface SetupOptions {
  overrides?: Record<string, number>;
  currency?: string;
  basePrice?: number;
  charm?: string;
}

/**
 * A product, an active custom campaign and a public key, all through the routes.
 * Default: €20, 60% for IN, round_x9.
 */
async function setup({ overrides = { IN: 60 }, currency = "EUR", basePrice = 20, charm = "round_x9" }: SetupOptions = {}) {
  const product = await created(
    await api("/products", {
      method: "POST",
      json: { name: "Course", url: "https://shop.example.com/course", basePrice, currency },
    }),
  );
  const campaign = await created(
    await api("/campaigns", {
      method: "POST",
      json: {
        productId: product.id,
        name: "PPP",
        status: "active",
        pricingMode: "custom",
        discountOverrides: overrides,
        charmPricingStrategy: charm,
      },
    }),
  );
  const key = await created(await api("/api-keys", { method: "POST", json: { name: "Site", keyType: "public" } }));
  return { productId: product.id, campaignId: campaign.id, apiKeyId: key.id, publicKey: key.key! };
}

async function bannerFor(publicKey: string, country = "IN") {
  const res = await client.request(`/v1/banner/config/${publicKey}`, { cf: { country } });
  expect(res.status).toBe(200);
  return res.json();
}

async function storedDoc(apiKeyId: string) {
  const raw = await client.env.CACHE.get(bannerDocKey(apiKeyId));
  expect(raw).not.toBeNull();
  return JSON.parse(raw as string);
}

describe("Banner local prices (full Worker)", () => {
  beforeEach(async () => {
    await cleanupTestDb();
    resetFxCacheForTests();
    client = createTestClient(worker, createTestBindings());
    // A new organization per test: the endpoint throttles its background
    // rebuilds per organization per isolate.
    t = await seedTenant(client, "Pricing Org");
  });

  afterAll(async () => {
    resetFxCacheForTests();
    await cleanupTestDb();
    await closeTestDb();
  });

  it("converts €20 at 60% for India with fresh rates: ₹829, was ₹1,999, fxRate 102.4654853", async () => {
    const today = isoDay(Date.now());
    await seedFx(today);
    const { publicKey } = await setup();

    const json = await bannerFor(publicKey);
    expect(json).toMatchObject({
      show: true,
      discount: 60,
      baseCurrencyCode: "EUR",
      baseCurrencySymbol: "€",
      currencyCode: "INR",
      currencySymbol: "₹",
      fxRate: 102.4654853,
      localPrice: 829,
      localOriginalPrice: 1999,
      fxAsOf: today,
      charmPricingStrategy: "round_x9",
    });
  });

  it("serves the exact price in the product's currency when the rates are stale or absent", async () => {
    const { publicKey } = await setup();
    const exact = {
      show: true,
      discount: 60,
      baseCurrencyCode: "EUR",
      currencyCode: "EUR",
      currencySymbol: "€",
      fxRate: 1,
      localPrice: 8,
      localOriginalPrice: 20,
    };

    // Dated five days ago: past the 96-hour window.
    await seedFx(isoDay(Date.now() - 5 * DAY_MS));
    const stale = await bannerFor(publicKey);
    expect(stale).toMatchObject(exact);
    expect(stale).not.toHaveProperty("fxAsOf");

    await seedFx(null);
    const absent = await bannerFor(publicKey);
    expect(absent).toMatchObject(exact);
    expect(absent).not.toHaveProperty("fxAsOf");
  });

  it("a held currency whose baseline is over 96 hours old is not converted; a fresh baseline is", async () => {
    const today = isoDay(Date.now());
    const { publicKey } = await setup({ overrides: { IN: 60, NG: 50 } });
    const heldNgn = (baselineDay: string) => ({
      rates: { ...FIXTURE_RATES, NGN: 1350 },
      held: ["NGN"],
      heldAsOf: { NGN: baselineDay },
    });

    // The document itself is fresh; only NGN's baseline is five days old.
    await seedFx(today, heldNgn(isoDay(Date.now() - 5 * DAY_MS)));
    const stale = await bannerFor(publicKey, "NG");
    expect(stale).toMatchObject({
      show: true,
      discount: 50,
      baseCurrencyCode: "EUR",
      currencyCode: "EUR",
      currencySymbol: "€",
      fxRate: 1,
      localPrice: 10,
      localOriginalPrice: 20,
    });
    expect(stale).not.toHaveProperty("fxAsOf");
    // Other currencies in the same document still convert.
    expect(await bannerFor(publicKey, "IN")).toMatchObject({
      currencyCode: "INR",
      fxRate: 102.4654853,
      localPrice: 829,
      localOriginalPrice: 1999,
      fxAsOf: today,
    });

    // Control: the same held code with today's baseline converts (1350 / 0.91080569).
    // Numbers from banner-core's pricePair: implied 48.3%, inside max(50 - 2, 40).
    await seedFx(today, heldNgn(today));
    const fresh = await bannerFor(publicKey, "NG");
    expect(fresh).toMatchObject({
      show: true,
      discount: 50,
      currencyCode: "NGN",
      fxRate: 1482.204179,
      localPrice: 14999,
      localOriginalPrice: 28999,
      fxAsOf: today,
    });
  });

  it("PKR: an exact PKR price keeps its paise; a converted USD price is whole rupees", async () => {
    const today = isoDay(Date.now());
    await seedFx(today);

    // A product priced in PKR, for a Pakistani visitor: the exact path, ISO digits (2).
    const pkr = await setup({ overrides: { PK: 65 }, currency: "PKR", basePrice: 5251.83, charm: "none" });
    const exact = await bannerFor(pkr.publicKey, "PK");
    expect(exact).toMatchObject({
      show: true,
      discount: 65,
      baseCurrencyCode: "PKR",
      currencyCode: "PKR",
      fxRate: 1,
      localPrice: 1838.14,
      localOriginalPrice: 5251.83,
    });
    expect(exact).not.toHaveProperty("fxAsOf");

    // $19 for the same visitor, in another workspace (Free allows one product):
    // converted at 276.4119032 and rounded to whole rupees.
    t = await seedTenant(client, "Pricing Org USD");
    const usd = await setup({ overrides: { PK: 65 }, currency: "USD", basePrice: 19, charm: "none" });
    expect(await bannerFor(usd.publicKey, "PK")).toMatchObject({
      show: true,
      discount: 65,
      baseCurrencyCode: "USD",
      currencyCode: "PKR",
      fxRate: 276.4119032,
      localPrice: 1839,
      localOriginalPrice: 5251,
      fxAsOf: today,
    });
  });

  it("treats a version-2 document as a miss: answers from Postgres exactly as the v3 document does, then rebuilds it", async () => {
    await seedFx(isoDay(Date.now()));
    const s = await setup();

    // The dashboard routes wrote a v3 document; this answer comes from it.
    const doc = await storedDoc(s.apiKeyId);
    expect(isCurrentBannerDoc(doc)).toBe(true);
    expect(doc.campaigns[s.campaignId].pricing).toEqual({ currency: "EUR", basePrice: 20, charm: "round_x9" });
    const fromDocument = await bannerFor(s.publicKey);

    // What a deploy before v3 left behind: version 2, no campaign pricing, a
    // per-country currency symbol, and an India discount Postgres does not have.
    const v2 = structuredClone(doc);
    v2.v = 2;
    for (const campaign of Object.values(v2.campaigns) as Array<Record<string, any>>) {
      delete campaign.pricing;
      for (const country of Object.values(campaign.countries) as Array<Record<string, unknown>>) {
        country.currencySymbol = "€";
      }
      if (campaign.countries.IN) campaign.countries.IN.discount = 10;
    }
    await client.env.CACHE.put(bannerDocKey(s.apiKeyId), JSON.stringify(v2));

    const fromDatabase = await bannerFor(s.publicKey);
    expect(fromDatabase).toEqual(fromDocument);
    expect(fromDatabase).toMatchObject({ discount: 60, currencyCode: "INR", localPrice: 829 });

    // The answer's background rebuild replaced the old document.
    const rebuilt = await storedDoc(s.apiKeyId);
    expect(isCurrentBannerDoc(rebuilt)).toBe(true);
    expect(rebuilt.campaigns[s.campaignId].pricing).toEqual({ currency: "EUR", basePrice: 20, charm: "round_x9" });
    expect(rebuilt.campaigns[s.campaignId].countries.IN.discount).toBe(60);
  });

  it("a product PATCH (price, then currency) rebuilds the document, and the next answer shows it", async () => {
    await seedFx(null); // exact prices, so the expected numbers are plain arithmetic
    const s = await setup();
    expect(await bannerFor(s.publicKey)).toMatchObject({ currencyCode: "EUR", localPrice: 8, localOriginalPrice: 20 });

    expect((await api(`/products/${s.productId}`, { method: "PATCH", json: { basePrice: 30 } })).status).toBe(200);
    let doc = await storedDoc(s.apiKeyId);
    expect(isCurrentBannerDoc(doc)).toBe(true);
    expect(doc.campaigns[s.campaignId].pricing).toEqual({ currency: "EUR", basePrice: 30, charm: "round_x9" });
    expect(await bannerFor(s.publicKey)).toMatchObject({
      baseCurrencyCode: "EUR",
      currencyCode: "EUR",
      localPrice: 12,
      localOriginalPrice: 30,
    });

    expect((await api(`/products/${s.productId}`, { method: "PATCH", json: { currency: "USD" } })).status).toBe(200);
    doc = await storedDoc(s.apiKeyId);
    expect(doc.campaigns[s.campaignId].pricing).toEqual({ currency: "USD", basePrice: 30, charm: "round_x9" });
    expect(await bannerFor(s.publicKey)).toMatchObject({
      baseCurrencyCode: "USD",
      currencyCode: "USD",
      currencySymbol: "$",
      localPrice: 12,
      localOriginalPrice: 30,
    });
  });

  it("a product DELETE rebuilds the document", async () => {
    await seedFx(null);
    const s = await setup();
    // A second product needs Pro (Free allows one).
    await getTestDb().insert(subscriptions).values({
      id: ulid(),
      organizationId: t.orgId,
      plan: "pro",
      status: "active",
      currentPeriodEnd: new Date(Date.now() + 30 * DAY_MS),
    });
    const spare = await created(
      await api("/products", { method: "POST", json: { name: "Spare", url: "https://shop.example.com/spare", basePrice: 5 } }),
    );

    // Make the stored document out of date, so only a rebuild makes it current.
    const doc = await storedDoc(s.apiKeyId);
    await client.env.CACHE.put(bannerDocKey(s.apiKeyId), JSON.stringify({ ...doc, v: 2 }));
    expect(isCurrentBannerDoc(await storedDoc(s.apiKeyId))).toBe(false);

    expect((await api(`/products/${spare.id}`, { method: "DELETE" })).status).toBe(200);
    const rebuilt = await storedDoc(s.apiKeyId);
    expect(isCurrentBannerDoc(rebuilt)).toBe(true);
    expect(Object.keys(rebuilt.products)).toEqual([s.productId]);
    expect(await bannerFor(s.publicKey)).toMatchObject({ show: true, currencyCode: "EUR", localPrice: 8 });
  });

  it("refuses a secret key on config, script.js and events before any KV or Postgres access", async () => {
    // Probes: every KV call, and every read of the Postgres connection string
    // (createDb reads it once per database handle).
    const bindings = createTestBindings();
    const kvCalls: string[] = [];
    const kv = bindings.CACHE;
    bindings.CACHE = new Proxy(kv, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          kvCalls.push(String(prop));
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      },
    });
    let dbReads = 0;
    bindings.HYPERDRIVE = new Proxy(bindings.HYPERDRIVE, {
      get(target, prop, receiver) {
        if (prop === "connectionString") dbReads++;
        return Reflect.get(target, prop, receiver);
      },
    });
    const probe = createTestClient(worker, bindings);
    const hex = "ab".repeat(32);
    const secret = `gpl_sk_${hex}`;

    const config = await probe.request(`/v1/banner/config/${secret}`, { cf: { country: "IN" } });
    expect(config.status).toBe(401);
    const configText = await config.text();
    expect(JSON.parse(configText)).toEqual({ error: expect.any(String), code: "secret_key_not_allowed" });
    expect(configText).not.toContain(hex);

    const script = await probe.request(`/v1/banner/script.js?key=${secret}`);
    expect(script.status).toBe(400);
    // The route's type for every script.js answer, the loader included.
    expect(script.headers.get("content-type")).toMatch(/^application\/javascript/);
    expect(await script.text()).not.toContain(hex);

    const events = await probe.request("/v1/events", {
      method: "POST",
      json: { key: secret, event: "impression", campaignId: ulid(), countryCode: "IN" },
    });
    expect(events.status).toBe(401);
    const eventsText = await events.text();
    expect(JSON.parse(eventsText)).toEqual({ error: expect.any(String), code: "secret_key_not_allowed" });
    expect(eventsText).not.toContain(hex);

    expect({ kvCalls, dbReads }).toEqual({ kvCalls: [], dbReads: 0 });

    // Control: the same probes see an unknown public key's lookups, so the
    // zeros above are not a probe that cannot fire.
    const unknownPublic = await probe.request(`/v1/banner/config/gpl_pk_${hex}`, { cf: { country: "IN" } });
    expect(unknownPublic.status).toBe(401);
    expect(kvCalls.length).toBeGreaterThan(0);
    expect(dbReads).toBeGreaterThan(0);
  });
});
