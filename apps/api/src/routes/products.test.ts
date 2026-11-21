import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";
import { createTestClient, mountRoutes } from "../test/helpers";
import { createSqlRecorder, type SqlRecorder } from "../lib/sql-recorder-test-helpers";

// Product routes under the permission table: owners and admins manage the
// catalog, members only see and edit the products in their product access.
// No database: createDb() returns a recorder that builds the real Drizzle SQL
// and answers with canned rows.

const state = vi.hoisted(() => ({
  recorder: null as unknown as SqlRecorder,
  push: null as unknown as Mock<(...args: unknown[]) => Promise<void>>,
}));
vi.mock("../db", () => ({ createDb: () => state.recorder.db }));
// Banner document rebuilds are asserted, not run (banner-cache.service.test.ts
// covers the builder).
vi.mock("../services/banner-cache.service", () => ({
  pushBannerConfigForOrg: (...args: unknown[]) => state.push(...args),
}));

const { default: productsRoute } = await import("./products");

const ORG = "org_a";
const PRODUCT = "prod_1";
const NEW_PRODUCT = { name: "Course", url: "https://example.com/course", basePrice: 10 };

function clientAs(role: "owner" | "admin" | "member", userId = `u_${role}`) {
  return createTestClient(mountRoutes(productsRoute, { userId, role }));
}

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  state.push = vi.fn(async (..._args: unknown[]) => {});
});
afterEach(() => vi.restoreAllMocks());

describe("POST /v1/teams/:orgId/products", () => {
  it("is refused to a member before anything is read or written", async () => {
    state.recorder = createSqlRecorder();
    const res = await clientAs("member").request(`/v1/teams/${ORG}/products`, { method: "POST", json: NEW_PRODUCT });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "forbidden_role", permission: "products.create" });
    expect(state.recorder.queries).toEqual([]);
  });

  it("no longer writes a product grant for the creator", async () => {
    // getProductLimitInfo reads the plan and counts, then the insert.
    state.recorder = createSqlRecorder();
    const res = await clientAs("admin").request(`/v1/teams/${ORG}/products`, { method: "POST", json: NEW_PRODUCT });
    expect(res.status).not.toBe(403);
    expect(state.recorder.queries.some((q) => q.sql.includes("member_product_access"))).toBe(false);
  });
});

describe("DELETE /v1/teams/:orgId/products/:id", () => {
  it("is refused to a member, even for a product in their access", async () => {
    state.recorder = createSqlRecorder();
    const res = await clientAs("member").request(`/v1/teams/${ORG}/products/${PRODUCT}`, { method: "DELETE" });
    expect(res.status).toBe(403);
    expect(state.recorder.queries).toEqual([]);
  });

  it("deletes in one org-scoped statement (grants cascade; no last-grant guard is needed now)", async () => {
    state.recorder = createSqlRecorder([[{ id: PRODUCT }]]);
    const res = await clientAs("admin").request(`/v1/teams/${ORG}/products/${PRODUCT}`, { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(state.recorder.queries.map((q) => q.sql)).toEqual([
      'delete from "products" where ("products"."id" = $1 and "products"."organization_id" = $2) returning "id"',
    ]);
    expect(state.recorder.queries[0]!.params).toEqual([PRODUCT, ORG]);
  });

  it("answers 404 when nothing in the org matched", async () => {
    state.recorder = createSqlRecorder([[]]);
    const res = await clientAs("owner").request(`/v1/teams/${ORG}/products/${PRODUCT}`, { method: "DELETE" });
    expect(res.status).toBe(404);
  });

  it("answers 409 product_in_use when campaigns still reference the product (FK 23503)", async () => {
    const fkViolation = Object.assign(new Error("Failed query"), {
      query: "delete from products ...",
      params: [],
      cause: Object.assign(new Error("violates foreign key constraint"), { code: "23503" }),
    });
    state.recorder = createSqlRecorder([fkViolation]);
    const res = await clientAs("owner").request(`/v1/teams/${ORG}/products/${PRODUCT}`, { method: "DELETE" });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "product_in_use" });
  });
});

describe("member product access on reads and edits", () => {
  it("a member with an empty listed scope lists nothing (never everything)", async () => {
    // getAllowedProductIds: membership with all_products=false and no grants.
    state.recorder = createSqlRecorder([[{ memberId: "m1", allProducts: false, productId: null }], []]);
    const res = await clientAs("member").request(`/v1/teams/${ORG}/products`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: [] });
    expect(state.recorder.queries[1]!.sql).toContain("false");
  });

  it("a member cannot edit a product outside their access (404, no write)", async () => {
    state.recorder = createSqlRecorder([[{ memberId: "m1", allProducts: false, productId: "prod_other" }]]);
    const res = await clientAs("member").request(`/v1/teams/${ORG}/products/${PRODUCT}`, {
      method: "PATCH",
      json: { name: "Renamed" },
    });
    expect(res.status).toBe(404);
    expect(state.recorder.queries.some((q) => q.sql.startsWith("update"))).toBe(false);
  });

  it("a member can edit a product in their access (no environment change: no campaign check)", async () => {
    state.recorder = createSqlRecorder([
      [{ memberId: "m1", allProducts: false, productId: PRODUCT }],
      [{ id: PRODUCT, name: "Renamed" }],
    ]);
    const res = await clientAs("member").request(`/v1/teams/${ORG}/products/${PRODUCT}`, {
      method: "PATCH",
      json: { name: "Renamed" },
    });
    expect(res.status).toBe(200);
    const update = state.recorder.queries.find((q) => q.sql.startsWith("update"))!;
    expect(update.sql).not.toContain("campaigns");
  });
});

describe("PATCH /v1/teams/:orgId/products/:id environment", () => {
  const patch = (json: unknown) =>
    clientAs("owner").request(`/v1/teams/${ORG}/products/${PRODUCT}`, { method: "PATCH", json });

  it("checks for campaigns in the same statement as the write", async () => {
    state.recorder = createSqlRecorder([[{ id: PRODUCT, environment: "test" }]]);
    const res = await patch({ environment: "test" });
    expect(res.status).toBe(200);
    const [update] = state.recorder.queries;
    expect(update!.sql).toMatch(/^update "products" set "environment" = \$1, "updated_at" = \$2 where /);
    expect(update!.sql).toContain(
      '("products"."environment" = $5 or not exists (select 1 from "campaigns" where "campaigns"."product_id" = "products"."id"))',
    );
    expect(update!.params[4]).toBe("test");
    expect(state.recorder.queries).toHaveLength(1);
  });

  it("answers 409 product_has_campaigns, and writes nothing, when the product has campaigns", async () => {
    // The guarded update matches no row; the product does exist in the org.
    state.recorder = createSqlRecorder([[], [{ id: PRODUCT }]]);
    const res = await patch({ environment: "test", name: "Renamed too" });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: "Move or delete this product's campaigns before changing its environment.",
      code: "product_has_campaigns",
    });
    expect(state.recorder.queries[1]!.sql).toBe(
      'select "id" from "products" where ("products"."id" = $1 and "products"."organization_id" = $2) limit $3',
    );
  });

  it("answers 404 when the product is not in the org", async () => {
    state.recorder = createSqlRecorder([[], []]);
    expect((await patch({ environment: "live" })).status).toBe(404);
  });
});

// B-9: the banner document carries each campaign's product price and currency
// (local prices), so a product edit or delete must rebuild it like every other
// change that affects the banner. Before this, a price or currency change kept
// serving the old local price until some unrelated change rebuilt the document.
describe("B-9: product changes rebuild the banner document", () => {
  const patch = (json: unknown) =>
    clientAs("owner").request(`/v1/teams/${ORG}/products/${PRODUCT}`, { method: "PATCH", json });

  it("a successful update hands the rebuild to waitUntil", async () => {
    state.recorder = createSqlRecorder([[{ id: PRODUCT, basePrice: 29, currency: "EUR" }]]);
    const client = clientAs("owner");
    const res = await client.request(`/v1/teams/${ORG}/products/${PRODUCT}`, {
      method: "PATCH",
      json: { basePrice: 29, currency: "EUR" },
    });
    expect(res.status).toBe(200);
    expect(state.push).toHaveBeenCalledTimes(1);
    const [db, kv, orgId, env] = state.push.mock.calls[0]!;
    expect(db).toBe(state.recorder.db);
    expect(kv).toBe(client.env.CACHE);
    expect(orgId).toBe(ORG);
    expect(env).toBe(client.env);
  });

  it("a refused or failed update does not rebuild", async () => {
    state.recorder = createSqlRecorder();
    expect((await patch({ basePrice: -1 })).status).toBe(400);
    state.recorder = createSqlRecorder([[], []]);
    expect((await patch({ basePrice: 29 })).status).toBe(404);
    state.recorder = createSqlRecorder([[], [{ id: PRODUCT }]]);
    expect((await patch({ environment: "test" })).status).toBe(409);
    expect(state.push).not.toHaveBeenCalled();
  });

  it("a failing rebuild is logged and never fails the update", async () => {
    state.push = vi.fn(async () => {
      throw new Error("kv down");
    });
    // The first rows answer the price check (stored currency), the second the update.
    state.recorder = createSqlRecorder([[{ basePrice: 20, currency: "USD" }], [{ id: PRODUCT, basePrice: 29 }]]);
    expect((await patch({ basePrice: 29 })).status).toBe(200);
    expect(console.error).toHaveBeenCalled();
  });

  it("a successful delete hands the rebuild to waitUntil", async () => {
    state.recorder = createSqlRecorder([[{ id: PRODUCT }]]);
    const res = await clientAs("admin").request(`/v1/teams/${ORG}/products/${PRODUCT}`, { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(state.push).toHaveBeenCalledTimes(1);
    expect(state.push.mock.calls[0]![2]).toBe(ORG);
  });

  it("a delete that matched nothing, or was refused by a campaign, does not rebuild", async () => {
    state.recorder = createSqlRecorder([[]]);
    expect((await clientAs("owner").request(`/v1/teams/${ORG}/products/${PRODUCT}`, { method: "DELETE" })).status).toBe(404);
    const fkViolation = Object.assign(new Error("Failed query"), {
      query: "delete from products ...",
      params: [],
      cause: Object.assign(new Error("violates foreign key constraint"), { code: "23503" }),
    });
    state.recorder = createSqlRecorder([fkViolation]);
    expect((await clientAs("owner").request(`/v1/teams/${ORG}/products/${PRODUCT}`, { method: "DELETE" })).status).toBe(409);
    expect(state.push).not.toHaveBeenCalled();
  });
});

// Price-maths review F7a: a product's price is a whole number of its currency's
// minor units and at least one. A patch that sends only the price or only the
// currency is checked against the stored other.
describe("PATCH /v1/teams/:orgId/products/:id price in its currency", () => {
  const patch = (json: unknown) =>
    clientAs("owner").request(`/v1/teams/${ORG}/products/${PRODUCT}`, { method: "PATCH", json });
  const wrote = () => state.recorder.queries.some((q) => q.sql.startsWith("update"));

  it("refuses a fractional yen price against the stored JPY currency, without writing", async () => {
    state.recorder = createSqlRecorder([[{ basePrice: 1999, currency: "JPY" }]]);
    const res = await patch({ basePrice: 1999.5 });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "Validation failed",
      details: { formErrors: [], fieldErrors: { basePrice: ["JPY prices are whole numbers of at least 1"] } },
    });
    expect(wrote()).toBe(false);
  });

  it("refuses a currency change the stored price does not fit (USD 19.99 to JPY)", async () => {
    state.recorder = createSqlRecorder([[{ basePrice: 19.99, currency: "USD" }]]);
    expect((await patch({ currency: "JPY" })).status).toBe(400);
    expect(wrote()).toBe(false);
  });

  it("accepts a valid one-sided change and writes it", async () => {
    state.recorder = createSqlRecorder([[{ basePrice: 1999, currency: "JPY" }], [{ id: PRODUCT, basePrice: 2499 }]]);
    expect((await patch({ basePrice: 2499 })).status).toBe(200);
    expect(wrote()).toBe(true);
  });

  it("checks a patch with both in the schema, before any query", async () => {
    state.recorder = createSqlRecorder();
    expect((await patch({ basePrice: 0.001, currency: "USD" })).status).toBe(400);
    expect(state.recorder.queries).toEqual([]);
  });

  it("a patch with neither runs no price check", async () => {
    state.recorder = createSqlRecorder([[{ id: PRODUCT, name: "Renamed" }]]);
    expect((await patch({ name: "Renamed" })).status).toBe(200);
    expect(state.recorder.queries.filter((q) => q.sql.startsWith("select"))).toEqual([]);
  });
});
