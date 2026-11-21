import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { createTestClient, mountRoutes } from "../test/helpers";
import { cleanupTestDb, closeTestDb } from "../test/setup";
import productsRoute from "./products";

const TEST_ORG_ID = "test-org-products";
const OTHER_ORG_ID = "other-org-products";

function createTestApp() {
  return createTestClient(mountRoutes(productsRoute));
}

describe("Products API", () => {
  const app = createTestApp();

  beforeEach(async () => {
    await cleanupTestDb();
  });

  afterAll(async () => {
    await cleanupTestDb();
    await closeTestDb();
  });

  it("GET /v1/teams/:orgId/products returns empty array initially", async () => {
    const res = await app.request(`/v1/teams/${TEST_ORG_ID}/products`);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data).toEqual([]);
  });

  it("POST /v1/teams/:orgId/products creates a product and returns it with id", async () => {
    const body = {
      name: "My SaaS Product",
      url: "https://example.com/product",
      currency: "USD",
      basePrice: 49.99,
    };

    const res = await app.request(`/v1/teams/${TEST_ORG_ID}/products`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.data).toBeDefined();
    expect(json.data.id).toBeDefined();
    expect(json.data.name).toBe("My SaaS Product");
    expect(json.data.url).toBe("https://example.com/product");
    expect(json.data.currency).toBe("USD");
    expect(json.data.basePrice).toBe(49.99);
    expect(json.data.organizationId).toBe(TEST_ORG_ID);
  });

  it("GET /v1/teams/:orgId/products lists the created product", async () => {
    // Create a product first
    await app.request(`/v1/teams/${TEST_ORG_ID}/products`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Listed Product",
        url: "https://example.com/listed",
        basePrice: 29.99,
      }),
    });

    const res = await app.request(`/v1/teams/${TEST_ORG_ID}/products`);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data).toHaveLength(1);
    expect(json.data[0].name).toBe("Listed Product");
  });

  it("GET /v1/teams/:orgId/products/:id returns a single product", async () => {
    const createRes = await app.request(`/v1/teams/${TEST_ORG_ID}/products`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Single Product",
        url: "https://example.com/single",
        basePrice: 19.99,
      }),
    });

    const { data: created } = await createRes.json();

    const res = await app.request(`/v1/teams/${TEST_ORG_ID}/products/${created.id}`);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.id).toBe(created.id);
    expect(json.data.name).toBe("Single Product");
  });

  it("PATCH /v1/teams/:orgId/products/:id updates product name and price", async () => {
    const createRes = await app.request(`/v1/teams/${TEST_ORG_ID}/products`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Original Name",
        url: "https://example.com/original",
        basePrice: 10.0,
      }),
    });

    const { data: created } = await createRes.json();

    const res = await app.request(`/v1/teams/${TEST_ORG_ID}/products/${created.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Updated Name", basePrice: 25.0 }),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.name).toBe("Updated Name");
    expect(json.data.basePrice).toBe(25.0);
    expect(json.data.url).toBe("https://example.com/original"); // unchanged
  });

  it("PATCH with only a name keeps currency and environment (no schema defaults re-applied)", async () => {
    const { data: created } = await (
      await app.request(`/v1/teams/${TEST_ORG_ID}/products`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Euro Product",
          url: "https://example.com/eur",
          currency: "EUR",
          basePrice: 30,
          environment: "test",
        }),
      })
    ).json();

    const res = await app.request(`/v1/teams/${TEST_ORG_ID}/products/${created.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Renamed" }),
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data).toMatchObject({
      name: "Renamed",
      currency: "EUR",
      environment: "test",
      basePrice: 30,
    });
  });

  it("POST is refused once a Free org has its one product (403 with the cap)", async () => {
    const first = await app.request(`/v1/teams/${TEST_ORG_ID}/products`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "One", url: "https://example.com/1", basePrice: 10 }),
    });
    expect(first.status).toBe(201);

    const second = await app.request(`/v1/teams/${TEST_ORG_ID}/products`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Two", url: "https://example.com/2", basePrice: 10 }),
    });
    expect(second.status).toBe(403);
    expect(await second.json()).toEqual({
      error: "Product limit reached",
      plan: "free",
      maxProducts: 1,
      currentCount: 1,
    });
  });

  it("DELETE /v1/teams/:orgId/products/:id deletes product", async () => {
    const createRes = await app.request(`/v1/teams/${TEST_ORG_ID}/products`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "To Delete",
        url: "https://example.com/delete",
        basePrice: 5.0,
      }),
    });

    const { data: created } = await createRes.json();

    const deleteRes = await app.request(`/v1/teams/${TEST_ORG_ID}/products/${created.id}`, {
      method: "DELETE",
    });
    expect(deleteRes.status).toBe(200);
    const deleteJson = await deleteRes.json();
    expect(deleteJson.success).toBe(true);

    // Verify it is gone
    const getRes = await app.request(`/v1/teams/${TEST_ORG_ID}/products/${created.id}`);
    expect(getRes.status).toBe(404);
  });

  it("POST with invalid data (missing name) returns 400", async () => {
    const res = await app.request(`/v1/teams/${TEST_ORG_ID}/products`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: "https://example.com/no-name",
        basePrice: 10.0,
      }),
    });

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("Validation failed");
  });

  it("GET with wrong orgId returns empty array (isolation)", async () => {
    // Create a product under TEST_ORG_ID
    await app.request(`/v1/teams/${TEST_ORG_ID}/products`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Isolated Product",
        url: "https://example.com/isolated",
        basePrice: 15.0,
      }),
    });

    // Query with a different orgId
    const res = await app.request(`/v1/teams/${OTHER_ORG_ID}/products`);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data).toEqual([]);
  });
});
