import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { ulid } from "ulid";
import { createTestClient, mountRoutes } from "../test/helpers";
import { getTestDb, cleanupTestDb, closeTestDb } from "../test/setup";
import { apiKeys, bannerConfigs, campaigns, products } from "../db/schema";
import { DEFAULT_BANNER_MESSAGE } from "@gopaylocal/shared/constants";
import type { CachedBannerConfig } from "../services/banner-cache.service";
import parityGroupsRoute from "./parity-groups";

const TEST_ORG_ID = "test-org-parity";

function createTestApp() {
  return createTestClient(mountRoutes(parityGroupsRoute));
}

describe("Parity Groups API", () => {
  let app = createTestApp();

  beforeEach(async () => {
    await cleanupTestDb();
    app = createTestApp();
  });

  afterAll(async () => {
    await cleanupTestDb();
    await closeTestDb();
  });

  it("POST /v1/teams/:orgId/parity-groups creates a group", async () => {
    const res = await app.request(`/v1/teams/${TEST_ORG_ID}/parity-groups`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Tier 1",
        discountPercent: 20,
        sortOrder: 1,
      }),
    });

    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.data.id).toBeDefined();
    expect(json.data.name).toBe("Tier 1");
    expect(json.data.discountPercent).toBe(20);
    expect(json.data.sortOrder).toBe(1);
    expect(json.data.countries).toEqual([]);
  });

  it("PUT /v1/teams/:orgId/parity-groups/:id/countries sets countries", async () => {
    // Create a group first
    const createRes = await app.request(`/v1/teams/${TEST_ORG_ID}/parity-groups`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Country Group",
        discountPercent: 30,
        sortOrder: 1,
      }),
    });
    const { data: group } = await createRes.json();

    // Set countries
    const res = await app.request(
      `/v1/teams/${TEST_ORG_ID}/parity-groups/${group.id}/countries`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ countries: ["IN", "BR", "MX"] }),
      },
    );

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.countries).toEqual(expect.arrayContaining(["IN", "BR", "MX"]));
    expect(json.data.countries).toHaveLength(3);
  });

  it("GET /v1/teams/:orgId/parity-groups lists groups with countries", async () => {
    // Create a group and set countries
    const createRes = await app.request(`/v1/teams/${TEST_ORG_ID}/parity-groups`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Listed Group",
        discountPercent: 25,
        sortOrder: 1,
      }),
    });
    const { data: group } = await createRes.json();

    await app.request(
      `/v1/teams/${TEST_ORG_ID}/parity-groups/${group.id}/countries`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ countries: ["US", "CA"] }),
      },
    );

    // List groups
    const res = await app.request(`/v1/teams/${TEST_ORG_ID}/parity-groups`);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data).toHaveLength(1);
    expect(json.data[0].name).toBe("Listed Group");
    expect(json.data[0].countries).toEqual(expect.arrayContaining(["US", "CA"]));
    expect(json.data[0].countries).toHaveLength(2);
  });

  it("POST /v1/teams/:orgId/parity-groups/seed-defaults seeds 5 default tiers", async () => {
    const res = await app.request(
      `/v1/teams/${TEST_ORG_ID}/parity-groups/seed-defaults`,
      { method: "POST" },
    );

    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.data).toHaveLength(5);

    // Verify tier names and ordering
    expect(json.data[0].name).toContain("Tier 1");
    expect(json.data[1].name).toContain("Tier 2");
    expect(json.data[2].name).toContain("Tier 3");
    expect(json.data[3].name).toContain("Tier 4");
    expect(json.data[4].name).toContain("Tier 5");

    // Verify each tier has countries
    for (const tier of json.data) {
      expect(tier.countries.length).toBeGreaterThan(0);
    }

    // Verify discount percentages
    expect(json.data[0].discountPercent).toBe(0);   // Tier 1 -- Parity
    expect(json.data[4].discountPercent).toBe(65);   // Tier 5 -- Maximum

    // Verify listing returns them
    const listRes = await app.request(`/v1/teams/${TEST_ORG_ID}/parity-groups`);
    const listJson = await listRes.json();
    expect(listJson.data).toHaveLength(5);
  });

  it("POST seed-defaults returns 409 if groups already exist", async () => {
    // Seed once
    await app.request(`/v1/teams/${TEST_ORG_ID}/parity-groups/seed-defaults`, {
      method: "POST",
    });

    // Try seeding again
    const res = await app.request(
      `/v1/teams/${TEST_ORG_ID}/parity-groups/seed-defaults`,
      { method: "POST" },
    );
    expect(res.status).toBe(409);
  });

  it("PUT countries replaces existing countries", async () => {
    // Create group and set initial countries
    const createRes = await app.request(`/v1/teams/${TEST_ORG_ID}/parity-groups`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Replace Group",
        discountPercent: 15,
        sortOrder: 1,
      }),
    });
    const { data: group } = await createRes.json();

    await app.request(
      `/v1/teams/${TEST_ORG_ID}/parity-groups/${group.id}/countries`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ countries: ["IN", "BR"] }),
      },
    );

    // Replace with different countries
    const replaceRes = await app.request(
      `/v1/teams/${TEST_ORG_ID}/parity-groups/${group.id}/countries`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ countries: ["JP", "KR", "DE"] }),
      },
    );

    expect(replaceRes.status).toBe(200);
    const json = await replaceRes.json();
    expect(json.data.countries).toEqual(expect.arrayContaining(["JP", "KR", "DE"]));
    expect(json.data.countries).toHaveLength(3);
    // Old countries should be gone
    expect(json.data.countries).not.toContain("IN");
    expect(json.data.countries).not.toContain("BR");
  });

  it("changing a group's countries rebuilds the cached banner config (background work)", async () => {
    // An active campaign and a public key, so there is a banner config to cache.
    const db = getTestDb();
    const productId = ulid();
    await db.insert(products).values({
      id: productId,
      organizationId: TEST_ORG_ID,
      name: "P",
      url: "https://example.com/p",
      basePrice: 10,
    });
    const campaignId = ulid();
    await db.insert(campaigns).values({
      id: campaignId,
      organizationId: TEST_ORG_ID,
      productId,
      name: "Live",
      status: "active",
    });
    await db.insert(bannerConfigs).values({
      id: ulid(),
      campaignId,
      messageTemplate: DEFAULT_BANNER_MESSAGE,
    });
    const keyId = ulid();
    await db.insert(apiKeys).values({
      id: keyId,
      organizationId: TEST_ORG_ID,
      name: "Public",
      keyType: "public",
      keyHash: `hash-${keyId}`,
      keyPrefix: "gpl_pk_xxxx...",
    });

    const { data: group } = await (
      await app.request(`/v1/teams/${TEST_ORG_ID}/parity-groups`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Tier", discountPercent: 35, sortOrder: 2 }),
      })
    ).json();

    await app.request(`/v1/teams/${TEST_ORG_ID}/parity-groups/${group.id}/countries`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ countries: ["IN"] }),
    });
    let cached = JSON.parse((await app.env.CACHE.get(`banner-config:${keyId}`))!) as CachedBannerConfig;
    expect(cached.campaigns[campaignId]!.countries.IN?.discount).toBe(35);
    expect(cached.campaigns[campaignId]!.countries.MX).toBeUndefined();

    await app.request(`/v1/teams/${TEST_ORG_ID}/parity-groups/${group.id}/countries`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ countries: ["MX"] }),
    });
    cached = JSON.parse((await app.env.CACHE.get(`banner-config:${keyId}`))!) as CachedBannerConfig;
    expect(cached.campaigns[campaignId]!.countries.IN).toBeUndefined();
    expect(cached.campaigns[campaignId]!.countries.MX?.discount).toBe(35);
  });
});
