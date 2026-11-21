import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { eq } from "drizzle-orm";
import worker from "../index";
import { campaigns, products } from "../db/schema";
import { createTestBindings, createTestClient, type TestClient } from "../test/helpers";
import { as, seedTenant } from "../test/auth";
import { cleanupTestDb, closeTestDb, getTestDb } from "../test/setup";

vi.mock("../../../../packages/banner/dist/banner.js", () => ({ default: "" }));

/**
 * A product's environment (live or test) can change only while it has no
 * campaigns: otherwise its campaigns, coupons and A/B tests would be left in
 * the old environment (full Worker, real Postgres).
 */
describe("PATCH product environment (full Worker)", () => {
  let client: TestClient;

  beforeEach(async () => {
    await cleanupTestDb();
    client = createTestClient(worker, createTestBindings());
  });

  afterAll(async () => {
    await cleanupTestDb();
    await closeTestDb();
  });

  it("switches freely without campaigns; refuses (409) once the product has one, leaving it unchanged", async () => {
    const t = await seedTenant(client, "Env Org");
    const created = await client.request(`/v1/teams/${t.orgId}/products`, {
      method: "POST",
      headers: as(t),
      json: { name: "Course", url: "https://example.com/course", basePrice: 10 },
    });
    expect(created.status).toBe(201);
    const productId = (await created.json()).data.id as string;
    const patch = (json: unknown) =>
      client.request(`/v1/teams/${t.orgId}/products/${productId}`, { method: "PATCH", headers: as(t), json });
    const environmentNow = async () =>
      (await getTestDb().select().from(products).where(eq(products.id, productId)))[0]?.environment;

    // No campaigns yet: both directions work.
    expect((await patch({ environment: "test" })).status).toBe(200);
    expect(await environmentNow()).toBe("test");
    expect((await patch({ environment: "live" })).status).toBe(200);
    expect(await environmentNow()).toBe("live");

    const campaign = await client.request(`/v1/teams/${t.orgId}/campaigns`, {
      method: "POST",
      headers: as(t),
      json: { productId, name: "Live campaign" },
    });
    expect(campaign.status).toBe(201);

    const refused = await patch({ environment: "test", name: "Renamed" });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ code: "product_has_campaigns" });
    const [row] = await getTestDb().select().from(products).where(eq(products.id, productId));
    expect(row).toMatchObject({ environment: "live", name: "Course" });
    expect(
      (await getTestDb().select().from(campaigns).where(eq(campaigns.productId, productId))).map((c) => c.environment),
    ).toEqual(["live"]);

    // Other edits, and restating the current environment, still work.
    const rename = await patch({ environment: "live", name: "Course, renamed" });
    expect(rename.status).toBe(200);
    expect((await rename.json()).data).toMatchObject({ environment: "live", name: "Course, renamed" });
  });

  it("answers 404, not 409, for another org's product", async () => {
    const a = await seedTenant(client, "Env Org A");
    const b = await seedTenant(client, "Env Org B");
    const created = await client.request(`/v1/teams/${b.orgId}/products`, {
      method: "POST",
      headers: as(b),
      json: { name: "Theirs", url: "https://example.com/theirs", basePrice: 10 },
    });
    const theirs = (await created.json()).data.id as string;

    const res = await client.request(`/v1/teams/${a.orgId}/products/${theirs}`, {
      method: "PATCH",
      headers: as(a),
      json: { environment: "test" },
    });
    expect(res.status).toBe(404);
    expect((await getTestDb().select().from(products).where(eq(products.id, theirs)))[0]?.environment).toBe("live");
  });
});
