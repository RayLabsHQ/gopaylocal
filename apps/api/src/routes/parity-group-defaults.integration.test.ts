import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import worker from "../index";
import { bannerDocKey, isCurrentBannerDoc } from "../services/banner-cache.service";
import { getDiscountForCountry } from "../services/parity.service";
import { createMockKV, createTestBindings, createTestClient, type TestClient } from "../test/helpers";
import { as, seedTenant, type TestTenant } from "../test/auth";
import { cleanupTestDb, closeTestDb, getTestDb } from "../test/setup";

// index.ts pulls in the banner route, which imports the browser bundle as a
// wrangler text module; stub it so browser code never runs under Node.
vi.mock("../../../../packages/banner/dist/banner.js", () => ({ default: "" }));

/**
 * Group-mode campaigns in a workspace without parity groups of its own serve the
 * default tiers; once the workspace has any group, only its groups are used
 * (banner-core; the unit versions are in services/parity-group-defaults.test.ts).
 *
 * The database fallback's single-country query (parity_groups LEFT JOIN this
 * country's mapping, mapped rows first, then sort order, then id, LIMIT 1) is
 * unit-tested only against recorded SQL. Here every case runs on real Postgres
 * through the full Worker, on three paths that must agree:
 *  - the KV banner document the routes write (its countries, with tiers),
 *  - GET /v1/banner/config served from that document,
 *  - the same request with the document deleted (the route's database path),
 * plus getDiscountForCountry itself with an empty cache, which always runs the
 * query and returns the tier the banner response does not carry.
 *
 * Every campaign: max 70%, no integration. Setup goes through the dashboard
 * routes, so the documents under test are the ones those routes write.
 */

let client: TestClient;
let t: TestTenant;

type TestResponse = Awaited<ReturnType<TestClient["request"]>>;
type Served = Record<string, { discount: number; tier: number }>;
interface Setup {
  campaignId: string;
  apiKeyId: string;
  publicKey: string;
}

const NO_BANNER = { show: false, reason: "no_discount" };

const api = (path: string, init: Parameters<TestClient["request"]>[1] = {}) =>
  client.request(`/v1/teams/${t.orgId}${path}`, { ...init, headers: as(t) });

async function created(res: TestResponse): Promise<{ id: string; key?: string }> {
  expect(res.status).toBe(201);
  return (await res.json()).data;
}

/** A $19 product, an active campaign (max 70%, no integration) and a public key. */
async function setup(pricing: Record<string, unknown>): Promise<Setup> {
  const product = await created(
    await api("/products", {
      method: "POST",
      json: { name: "Course", url: "https://shop.example.com/course", basePrice: 19, currency: "USD" },
    }),
  );
  const campaign = await created(
    await api("/campaigns", {
      method: "POST",
      json: { productId: product.id, name: "PPP", status: "active", maxDiscountPercent: 70, ...pricing },
    }),
  );
  const key = await created(await api("/api-keys", { method: "POST", json: { name: "Site", keyType: "public" } }));
  return { campaignId: campaign.id, apiKeyId: key.id, publicKey: key.key! };
}

/** A parity group through the routes (each call rebuilds the document). */
async function addGroup(discountPercent: number, sortOrder: number, countries: string[]): Promise<string> {
  const group = await created(
    await api("/parity-groups", {
      method: "POST",
      json: { name: `Group ${sortOrder}-${discountPercent}`, discountPercent, sortOrder },
    }),
  );
  if (countries.length > 0) {
    const res = await api(`/parity-groups/${group.id}/countries`, { method: "PUT", json: { countries } });
    expect(res.status).toBe(200);
  }
  return group.id;
}

async function currentDoc(s: Setup) {
  const raw = await client.env.CACHE.get(bannerDocKey(s.apiKeyId));
  expect(raw).not.toBeNull();
  const doc = JSON.parse(raw as string);
  expect(isCurrentBannerDoc(doc)).toBe(true);
  return doc;
}

async function config(s: Setup, country: string) {
  const res = await client.request(`/v1/banner/config/${s.publicKey}`, { cf: { country } });
  expect(res.status).toBe(200);
  return { cc: country, ...(await res.json()) };
}

/** Served from the current KV document. */
async function fromKv(s: Setup, country: string) {
  await currentDoc(s);
  return config(s, country);
}

/**
 * Served from Postgres: with the document deleted the route answers from the
 * database (and schedules one rebuild per organization per minute, so the
 * document is deleted again before every call).
 */
async function fromDb(s: Setup, country: string) {
  await client.env.CACHE.delete(bannerDocKey(s.apiKeyId));
  return config(s, country);
}

/** The database fallback itself, with an empty discount cache: always runs the single-country query. */
async function fallback(s: Setup, country: string) {
  const result = await getDiscountForCountry(getTestDb(), client.env, t.orgId, s.campaignId, country, createMockKV());
  return { cc: country, ...result };
}

/**
 * The document, the KV answer, the database answer and the fallback's own
 * result all give `served`, and nothing in the countries of `none`. Document
 * and KV answers are read first, while the document is the one the routes wrote.
 */
async function expectEverywhere(s: Setup, served: Served, none: string[]) {
  const countries = (await currentDoc(s)).campaigns[s.campaignId].countries;
  for (const [cc, want] of Object.entries(served)) {
    expect({ cc, ...countries[cc] }).toMatchObject({ cc, discount: want.discount, tier: want.tier, code: null });
  }
  for (const cc of none) expect(countries).not.toHaveProperty(cc);

  for (const [cc, want] of Object.entries(served)) {
    expect(await fromKv(s, cc)).toMatchObject({ cc, show: true, country: cc, discount: want.discount, code: null });
  }
  for (const cc of none) expect(await fromKv(s, cc)).toMatchObject({ cc, ...NO_BANNER });

  for (const [cc, want] of Object.entries(served)) {
    expect(await fromDb(s, cc)).toMatchObject({ cc, show: true, country: cc, discount: want.discount, code: null });
    expect(await fallback(s, cc)).toEqual({ cc, discount: want.discount, tier: want.tier, code: null });
  }
  for (const cc of none) {
    expect(await fromDb(s, cc)).toMatchObject({ cc, ...NO_BANNER });
    expect(await fallback(s, cc)).toMatchObject({ cc, discount: 0, code: null });
  }
}

describe("Group mode and the default tiers (full Worker, real Postgres)", () => {
  beforeEach(async () => {
    await cleanupTestDb();
    client = createTestClient(worker, createTestBindings());
    // A new organization per test: the config endpoint throttles its
    // background rebuilds per organization per isolate.
    t = await seedTenant(client, "Parity Org");
  });

  afterAll(async () => {
    await cleanupTestDb();
    await closeTestDb();
  });

  it("no parity groups: the default tiers (IN 65 tier 5, BR 35 tier 3, PT 20 tier 2, US none)", async () => {
    const s = await setup({ pricingMode: "group" });
    await expectEverywhere(
      s,
      { IN: { discount: 65, tier: 5 }, BR: { discount: 35, tier: 3 }, PT: { discount: 20, tier: 2 } },
      ["US"],
    );
  });

  it("one group (40%, sort 1, [IN]): IN 40 tier 1, and nothing from the default tiers", async () => {
    const s = await setup({ pricingMode: "group" });
    await addGroup(40, 1, ["IN"]);
    await expectEverywhere(s, { IN: { discount: 40, tier: 1 } }, ["BR", "PT", "US"]);
  });

  it("one group with no countries: no banner anywhere (the default tiers are off)", async () => {
    const s = await setup({ pricingMode: "group" });
    await addGroup(40, 1, []);
    expect((await currentDoc(s)).campaigns[s.campaignId].countries).toEqual({});
    await expectEverywhere(s, {}, ["IN", "BR", "PT", "US"]);
  });

  it("deleting the last group (DELETE route) brings the default tiers back on every path", async () => {
    const s = await setup({ pricingMode: "group" });
    const groupId = await addGroup(40, 1, []);
    expect(await fromKv(s, "IN")).toMatchObject(NO_BANNER);
    // Also caches "0% for IN" under the current discount-cache epoch; the
    // rebuild after the DELETE writes a new epoch, so it must not be served.
    expect(await fromDb(s, "IN")).toMatchObject(NO_BANNER);

    const res = await api(`/parity-groups/${groupId}`, { method: "DELETE" });
    expect(res.status).toBe(200);

    await expectEverywhere(s, { IN: { discount: 65, tier: 5 }, BR: { discount: 35, tier: 3 } }, ["US"]);
  });

  it("custom mode with overrides {IN: 40} and no groups: BR gets no banner (no default tiers)", async () => {
    const s = await setup({ pricingMode: "custom", discountOverrides: { IN: 40 } });
    const countries = (await currentDoc(s)).campaigns[s.campaignId].countries;
    expect(countries.IN).toMatchObject({ discount: 40 });
    expect(Object.keys(countries)).toEqual(["IN"]);

    for (const read of [fromKv, fromDb]) {
      expect(await read(s, "IN")).toMatchObject({ cc: "IN", show: true, discount: 40 });
      expect(await read(s, "BR")).toMatchObject({ cc: "BR", ...NO_BANNER });
    }
    expect(await fallback(s, "IN")).toMatchObject({ cc: "IN", discount: 40, code: null });
    expect(await fallback(s, "BR")).toMatchObject({ cc: "BR", discount: 0, code: null });
  });

  // Not in banner-core's list: the query's ORDER BY on real Postgres. A mapped
  // row must beat an unmapped group with a lower sort order, then the lowest
  // sort order wins, then the lowest id (the KV builder compares ids in
  // JavaScript, Postgres under the database's collation; they must agree).
  it("a country in several groups: mapped first, then the lowest sort order, then the lowest id", async () => {
    const s = await setup({ pricingMode: "group" });
    const idB = await addGroup(30, 2, ["IN", "BR"]);
    await addGroup(50, 1, ["IN"]);
    const idC = await addGroup(25, 2, ["BR"]);
    const br = idB < idC ? { discount: 30, tier: 2 } : { discount: 25, tier: 2 };
    await expectEverywhere(s, { IN: { discount: 50, tier: 1 }, BR: br }, ["PT", "US"]);
  });

  // Not in banner-core's list: the query is scoped to the organization. Another
  // workspace's group must neither turn this workspace's default tiers off nor
  // price its countries.
  it("another workspace's group does not affect this workspace's default tiers", async () => {
    const other = await seedTenant(client, "Other Parity Org");
    const res = await client.request(`/v1/teams/${other.orgId}/parity-groups`, {
      method: "POST",
      headers: as(other),
      json: { name: "Theirs", discountPercent: 10, sortOrder: 1 },
    });
    const theirs = await created(res);
    const put = await client.request(`/v1/teams/${other.orgId}/parity-groups/${theirs.id}/countries`, {
      method: "PUT",
      headers: as(other),
      json: { countries: ["IN"] },
    });
    expect(put.status).toBe(200);

    const s = await setup({ pricingMode: "group" });
    await expectEverywhere(s, { IN: { discount: 65, tier: 5 }, BR: { discount: 35, tier: 3 } }, ["US"]);
  });
});
