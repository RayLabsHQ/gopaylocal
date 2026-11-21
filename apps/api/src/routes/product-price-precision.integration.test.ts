import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { eq } from "drizzle-orm";
import worker from "../index";
import { products } from "../db/schema";
import { createTestBindings, createTestClient, type TestClient } from "../test/helpers";
import { as, seedTenant } from "../test/auth";
import { cleanupTestDb, closeTestDb, getTestDb } from "../test/setup";

vi.mock("../../../../packages/banner/dist/banner.js", () => ({ default: "" }));

/**
 * products.base_price is double precision (full Worker, real Postgres). It was
 * float4 (real), which keeps about 7 significant digits: IDR 17,999,999 came
 * back as 18,000,000 and 1,234,567.89 as 1,234,567.9. Every read path returns
 * the exact price: the create response, GET, and the stored row. Each price is
 * a whole number of its currency's minor units, which product create requires.
 */
describe("product base price precision (full Worker)", () => {
  let client: TestClient;

  beforeEach(async () => {
    await cleanupTestDb();
    client = createTestClient(worker, createTestBindings());
  });

  afterAll(async () => {
    await cleanupTestDb();
    await closeTestDb();
  });

  // One product per workspace: the Free plan allows one.
  it.each([
    ["IDR", 17999999],
    ["USD", 1234567.89],
    ["VND", 123456789],
  ])("a %s product created at %d reads back exactly", async (currency, basePrice) => {
    const t = await seedTenant(client, `${currency} Org`);
    const created = await client.request(`/v1/teams/${t.orgId}/products`, {
      method: "POST",
      headers: as(t),
      json: { name: "Course", url: "https://example.com/course", currency, basePrice },
    });
    expect(created.status).toBe(201);
    const product = (await created.json()).data as { id: string; basePrice: number };
    expect(product.basePrice).toBe(basePrice);

    const read = await client.request(`/v1/teams/${t.orgId}/products/${product.id}`, { headers: as(t) });
    expect(read.status).toBe(200);
    expect((await read.json()).data.basePrice).toBe(basePrice);

    const [row] = await getTestDb().select({ basePrice: products.basePrice }).from(products).where(eq(products.id, product.id));
    expect(row!.basePrice).toBe(basePrice);
  });

  it("refuses VND 1234567.89: VND has no minor units, so a price must be whole", async () => {
    const t = await seedTenant(client, "VND Decimals Org");
    const res = await client.request(`/v1/teams/${t.orgId}/products`, {
      method: "POST",
      headers: as(t),
      json: { name: "Course", url: "https://example.com/course", currency: "VND", basePrice: 1234567.89 },
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Validation failed");
    expect(body.details.fieldErrors.basePrice).toEqual(["VND prices are whole numbers of at least 1"]);
    expect(await getTestDb().select().from(products).where(eq(products.organizationId, t.orgId))).toHaveLength(0);
  });
});
