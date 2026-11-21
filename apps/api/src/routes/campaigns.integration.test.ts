import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { ulid } from "ulid";
import { createTestClient, mountRoutes, type TestClient } from "../test/helpers";
import { getTestDb, cleanupTestDb, closeTestDb } from "../test/setup";
import {
  apiKeys,
  bannerConfigs,
  campaigns,
  countryParityMappings,
  coupons,
  parityGroups,
  subscriptions,
} from "../db/schema";
import type { CachedBannerConfig } from "../services/banner-cache.service";
import productsRoute from "./products";
import campaignsRoute from "./campaigns";
import bannerConfigsRoute from "./banner-configs";

const TEST_ORG_ID = "test-org-campaigns";

function createTestApp(): TestClient {
  return createTestClient(mountRoutes([productsRoute, campaignsRoute, bannerConfigsRoute]));
}

/** Helper to create a product and return its id */
async function createProduct(app: TestClient, orgId: string, environment: "live" | "test" = "live"): Promise<string> {
  const res = await app.request(`/v1/teams/${orgId}/products`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "Campaign Test Product",
      url: "https://example.com/campaign-product",
      basePrice: 99.0,
      environment,
    }),
  });
  expect(res.status).toBe(201);
  const json = await res.json();
  return json.data.id;
}

describe("Campaigns API", () => {
  let app = createTestApp();

  beforeEach(async () => {
    await cleanupTestDb();
    app = createTestApp();
  });

  afterAll(async () => {
    await cleanupTestDb();
    await closeTestDb();
  });

  it("POST /v1/teams/:orgId/campaigns creates campaign and auto-creates banner config", async () => {
    const productId = await createProduct(app, TEST_ORG_ID);

    const res = await app.request(`/v1/teams/${TEST_ORG_ID}/campaigns`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        productId,
        name: "My Campaign",
      }),
    });

    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.data).toBeDefined();
    expect(json.data.id).toBeDefined();
    expect(json.data.name).toBe("My Campaign");
    expect(json.data.productId).toBe(productId);
    expect(json.data.organizationId).toBe(TEST_ORG_ID);
    expect(json.data.status).toBe("draft");
    expect(json.data.pricingMode).toBe("group");

    // Verify the banner config was auto-created
    const bannerRes = await app.request(
      `/v1/teams/${TEST_ORG_ID}/banner-configs/${json.data.id}`,
    );
    expect(bannerRes.status).toBe(200);
    const bannerJson = await bannerRes.json();
    expect(bannerJson.data.campaignId).toBe(json.data.id);
    expect(bannerJson.data.position).toBe("bottom");
  });

  it("GET /v1/teams/:orgId/campaigns lists campaigns", async () => {
    const productId = await createProduct(app, TEST_ORG_ID);

    // Initially empty
    const emptyRes = await app.request(`/v1/teams/${TEST_ORG_ID}/campaigns`);
    expect(emptyRes.status).toBe(200);
    const emptyJson = await emptyRes.json();
    expect(emptyJson.data).toHaveLength(0);

    // Create a campaign
    await app.request(`/v1/teams/${TEST_ORG_ID}/campaigns`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        productId,
        name: "Listed Campaign",
      }),
    });

    // Now it lists one campaign
    const res = await app.request(`/v1/teams/${TEST_ORG_ID}/campaigns`);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data).toHaveLength(1);
    expect(json.data[0].name).toBe("Listed Campaign");
  });

  it("PATCH /v1/teams/:orgId/campaigns/:id updates status to active", async () => {
    const productId = await createProduct(app, TEST_ORG_ID);

    const createRes = await app.request(`/v1/teams/${TEST_ORG_ID}/campaigns`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        productId,
        name: "Status Campaign",
      }),
    });

    const { data: created } = await createRes.json();
    expect(created.status).toBe("draft");

    const patchRes = await app.request(`/v1/teams/${TEST_ORG_ID}/campaigns/${created.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "active" }),
    });

    expect(patchRes.status).toBe(200);
    const patchJson = await patchRes.json();
    expect(patchJson.data.status).toBe("active");
    expect(patchJson.data.name).toBe("Status Campaign"); // unchanged
  });

  it("PATCH with only a name leaves every other field as it was (no schema defaults re-applied)", async () => {
    // A test campaign needs a test product (a campaign lives in its product's environment).
    const productId = await createProduct(app, TEST_ORG_ID, "test");
    const { data: created } = await (
      await app.request(`/v1/teams/${TEST_ORG_ID}/campaigns`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          productId,
          name: "Before",
          status: "paused",
          pricingMode: "custom",
          charmPricingStrategy: "dot99",
          maxDiscountPercent: 55,
          discountOverrides: { IN: 30 },
          environment: "test",
        }),
      })
    ).json();

    const res = await app.request(`/v1/teams/${TEST_ORG_ID}/campaigns/${created.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "After" }),
    });
    expect(res.status).toBe(200);
    const [row] = await getTestDb().select().from(campaigns).where(eq(campaigns.id, created.id));
    expect(row).toMatchObject({
      name: "After",
      status: "paused",
      pricingMode: "custom",
      discountDelivery: "banner_coupon",
      charmPricingStrategy: "dot99",
      maxDiscountPercent: 55,
      discountOverrides: { IN: 30 },
      environment: "test",
    });
  });

  it("DELETE /v1/teams/:orgId/campaigns/:id deletes campaign", async () => {
    const productId = await createProduct(app, TEST_ORG_ID);

    const createRes = await app.request(`/v1/teams/${TEST_ORG_ID}/campaigns`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        productId,
        name: "To Delete Campaign",
      }),
    });

    const { data: created } = await createRes.json();

    // The route deletes the campaign's coupons and banner config with it.
    const db = getTestDb();
    await db.insert(coupons).values({
      id: ulid(),
      campaignId: created.id,
      countryCode: "IN",
      code: `DEL-${ulid()}`,
      discountPercent: 40,
    });

    const deleteRes = await app.request(`/v1/teams/${TEST_ORG_ID}/campaigns/${created.id}`, {
      method: "DELETE",
    });
    expect(deleteRes.status).toBe(200);
    const deleteJson = await deleteRes.json();
    expect(deleteJson.success).toBe(true);

    // Verify it is gone, with its banner config and coupons
    const getRes = await app.request(`/v1/teams/${TEST_ORG_ID}/campaigns/${created.id}`);
    expect(getRes.status).toBe(404);
    expect(
      await db.select().from(bannerConfigs).where(eq(bannerConfigs.campaignId, created.id)),
    ).toHaveLength(0);
    expect(await db.select().from(coupons).where(eq(coupons.campaignId, created.id))).toHaveLength(0);
  });

  it("activating a campaign pushes the precomputed banner config to KV for each public key", async () => {
    const db = getTestDb();
    const productId = await createProduct(app, TEST_ORG_ID);
    const groupId = ulid();
    await db.insert(parityGroups).values({
      id: groupId,
      organizationId: TEST_ORG_ID,
      name: "Tier",
      discountPercent: 40,
      sortOrder: 3,
    });
    await db.insert(countryParityMappings).values([
      { id: ulid(), parityGroupId: groupId, countryCode: "IN" },
      { id: ulid(), parityGroupId: groupId, countryCode: "BR" },
    ]);
    const keyId = ulid();
    await db.insert(apiKeys).values({
      id: keyId,
      organizationId: TEST_ORG_ID,
      name: "Public",
      keyType: "public",
      keyHash: `hash-${keyId}`,
      keyPrefix: "gpl_pk_xxxx...",
    });

    const { data: created } = await (
      await app.request(`/v1/teams/${TEST_ORG_ID}/campaigns`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ productId, name: "Cached Campaign" }),
      })
    ).json();
    // A draft campaign serves nothing: the rebuild writes either no document or
    // a v2 document with no servable product (banner-core writes the latter).
    const draftDoc = await app.env.CACHE.get(`banner-config:${keyId}`);
    const draft = draftDoc === null ? null : (JSON.parse(draftDoc) as CachedBannerConfig);
    expect(draft?.products ?? {}).toEqual({});
    expect(draft?.defaultProductId ?? null).toBeNull();

    const patchRes = await app.request(`/v1/teams/${TEST_ORG_ID}/campaigns/${created.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "active" }),
    });
    expect(patchRes.status).toBe(200);

    const raw = await app.env.CACHE.get(`banner-config:${keyId}`);
    expect(raw).not.toBeNull();
    const cached = JSON.parse(raw!) as CachedBannerConfig;
    // v2 document: product -> what serves it, campaign id -> its countries.
    expect(cached.products).toEqual({ [productId]: { kind: "campaign", campaignId: created.id } });
    expect(cached.defaultProductId).toBe(productId); // the org's only product
    const countries = cached.campaigns[created.id]!.countries;
    expect(countries.IN).toMatchObject({ discount: 40, countryName: "India", code: null });
    expect(countries.BR?.discount).toBe(40);
    expect(countries.US).toBeUndefined(); // not in any group: no discount
    expect(cached.showBranding).toBe(true); // no subscription = Free
  });

  it("puts a campaign in its product's environment and refuses a mismatch", async () => {
    // Two products: Free allows one, so this org is on Pro for this test
    // (beforeEach's cleanup truncates subscriptions again).
    await getTestDb().insert(subscriptions).values({
      id: ulid(),
      organizationId: TEST_ORG_ID,
      plan: "pro",
      status: "active",
      currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    });
    const testProduct = await createProduct(app, TEST_ORG_ID, "test");
    const liveProduct = await createProduct(app, TEST_ORG_ID, "live");
    const post = (json: unknown) =>
      app.request(`/v1/teams/${TEST_ORG_ID}/campaigns`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(json),
      });
    const patch = (id: string, json: unknown) =>
      app.request(`/v1/teams/${TEST_ORG_ID}/campaigns/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(json),
      });

    // No environment in the body: the product's.
    const created = await post({ productId: testProduct, name: "Sandbox" });
    expect(created.status).toBe(201);
    const { data: campaign } = await created.json();
    expect(campaign.environment).toBe("test");

    // An explicit environment that differs from the product's.
    const mismatched = await post({ productId: testProduct, name: "Wrong", environment: "live" });
    expect(mismatched.status).toBe(400);
    expect(await mismatched.json()).toMatchObject({ code: "environment_mismatch" });

    // Switching the campaign to live, or moving it to a live product alone.
    expect((await patch(campaign.id, { environment: "live" })).status).toBe(400);
    expect((await patch(campaign.id, { productId: liveProduct })).status).toBe(400);
    const [row] = await getTestDb().select().from(campaigns).where(eq(campaigns.id, campaign.id));
    expect(row).toMatchObject({ environment: "test", productId: testProduct });

    // Both together is a consistent move.
    expect((await patch(campaign.id, { productId: liveProduct, environment: "live" })).status).toBe(200);
  });

  it("refuses to activate an auto-apply campaign that has no payment integration", async () => {
    const productId = await createProduct(app, TEST_ORG_ID);
    const { data: created } = await (
      await app.request(`/v1/teams/${TEST_ORG_ID}/campaigns`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ productId, name: "Auto", discountDelivery: "auto_apply" }),
      })
    ).json();

    const res = await app.request(`/v1/teams/${TEST_ORG_ID}/campaigns/${created.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "active" }),
    });
    expect(res.status).toBe(400);
    const [row] = await getTestDb().select().from(campaigns).where(eq(campaigns.id, created.id));
    expect(row!.status).toBe("draft");
  });

  it("POST with missing productId returns 400", async () => {
    const res = await app.request(`/v1/teams/${TEST_ORG_ID}/campaigns`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "No Product Campaign",
      }),
    });

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("Validation failed");
  });
});
