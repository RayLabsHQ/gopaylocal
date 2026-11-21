import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { ulid } from "ulid";
import { createTestClient } from "../test/helpers";
import { getTestDb, cleanupTestDb, closeTestDb } from "../test/setup";
import { products, campaigns, apiKeys, analyticsRollups } from "../db/schema";
import analyticsIngestRoute from "./analytics-ingest";

/**
 * Coverage: the analytics-poisoning guard on POST /v1/events. A third party who
 * knows a valid public key (it's in the page source) must NOT be able to write
 * rollups for a campaignId that belongs to a DIFFERENT org, nor for an unknown id.
 *
 * Rollups are written in waitUntil(); the test client waits for that work
 * before returning, so the database assertions below see it.
 *
 * Regression: the rollup upsert once interpolated drizzle column objects into
 * raw SQL, which rendered table-qualified names Postgres rejects; the error was
 * swallowed and no event was ever stored. The happy-path tests below catch
 * that, and they are what keep the "DROPS" tests from passing vacuously.
 */

const ORG_OWNER = "test-org-events-owner";
const ORG_VICTIM = "test-org-events-victim";

async function hashKey(key: string): Promise<string> {
  const data = new TextEncoder().encode(key);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Seed a product + active campaign for `orgId`; return the campaign id. */
async function seedCampaign(orgId: string): Promise<string> {
  const db = getTestDb();
  const productId = ulid();
  await db.insert(products).values({
    id: productId,
    organizationId: orgId,
    name: "Events Test Product",
    url: `https://example.com/${productId}`,
    currency: "USD",
    basePrice: 49.99,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  const campaignId = ulid();
  await db.insert(campaigns).values({
    id: campaignId,
    organizationId: orgId,
    productId,
    name: "Events Campaign",
    status: "active",
    pricingMode: "group",
    discountDelivery: "banner_coupon",
    charmPricingStrategy: "none",
    maxDiscountPercent: 70,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return campaignId;
}

/** Seed a public API key for `orgId`; return the raw key string. */
async function seedKey(orgId: string): Promise<string> {
  const db = getTestDb();
  const rawKey = `gpl_pk_test${ulid()}`;
  await db.insert(apiKeys).values({
    id: ulid(),
    organizationId: orgId,
    name: "Events Test Key",
    keyType: "public",
    keyHash: await hashKey(rawKey),
    keyPrefix: rawKey.substring(0, 15) + "...",
    createdAt: new Date(),
  });
  return rawKey;
}

function createEventsApp() {
  // Public route: no identity. No RL_* bindings, so the rate-limit helper
  // fails open; these tests are about validation.
  return createTestClient(analyticsIngestRoute);
}

/**
 * Sum clicks across all rollups for an org+campaign. (Clicks, not impressions:
 * the API counts impressions itself when it serves an offer, and ignores the
 * ones a client posts here; banner-serving.integration.test.ts covers those.)
 */
async function clicksFor(orgId: string, campaignId: string): Promise<number> {
  const db = getTestDb();
  const [row] = await db
    .select({
      total: sql<number>`COALESCE(SUM(${analyticsRollups.clicks}), 0)`,
    })
    .from(analyticsRollups)
    .where(
      and(
        eq(analyticsRollups.organizationId, orgId),
        eq(analyticsRollups.campaignId, campaignId),
      ),
    );
  return Number(row?.total ?? 0);
}

describe("Analytics Ingest API — campaign-ownership validation", () => {
  beforeEach(async () => {
    await cleanupTestDb();
  });

  afterAll(async () => {
    await cleanupTestDb();
    await closeTestDb();
  });

  it("writes a rollup for an event whose campaignId belongs to the key's org", async () => {
    const campaignId = await seedCampaign(ORG_OWNER);
    const rawKey = await seedKey(ORG_OWNER);
    const app = createEventsApp();

    const res = await app.request("/v1/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        key: rawKey,
        event: "click",
        campaignId,
        countryCode: "IN",
      }),
    });

    expect(res.status).toBe(204);
    expect(await clicksFor(ORG_OWNER, campaignId)).toBe(1);
  });

  it("DROPS (silently, still 2xx) an event whose campaignId belongs to a DIFFERENT org", async () => {
    // Attacker uses ORG_OWNER's valid public key but a victim org's campaignId.
    const victimCampaignId = await seedCampaign(ORG_VICTIM);
    const rawKey = await seedKey(ORG_OWNER);
    const app = createEventsApp();

    const res = await app.request("/v1/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        key: rawKey,
        event: "click",
        campaignId: victimCampaignId,
        countryCode: "IN",
      }),
    });

    // No oracle: same success response as a valid event.
    expect(res.status).toBe(204);
    // Poisoning dropped: neither the attacker's org nor the victim's got a rollup.
    expect(await clicksFor(ORG_VICTIM, victimCampaignId)).toBe(0);
    expect(await clicksFor(ORG_OWNER, victimCampaignId)).toBe(0);
  });

  it("DROPS an event with an unknown campaignId", async () => {
    const rawKey = await seedKey(ORG_OWNER);
    const app = createEventsApp();
    const unknownCampaignId = ulid();

    const res = await app.request("/v1/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        key: rawKey,
        event: "click",
        campaignId: unknownCampaignId,
        countryCode: "IN",
      }),
    });

    expect(res.status).toBe(204);
    expect(await clicksFor(ORG_OWNER, unknownCampaignId)).toBe(0);
  });

  it("in a batch, writes owned items and drops cross-org items", async () => {
    const ownedCampaignId = await seedCampaign(ORG_OWNER);
    const victimCampaignId = await seedCampaign(ORG_VICTIM);
    const rawKey = await seedKey(ORG_OWNER);
    const app = createEventsApp();

    const res = await app.request("/v1/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        key: rawKey,
        events: [
          { eventType: "click", campaignId: ownedCampaignId, countryCode: "IN" },
          { eventType: "click", campaignId: victimCampaignId, countryCode: "IN" },
        ],
      }),
    });

    expect(res.status).toBe(204);
    expect(await clicksFor(ORG_OWNER, ownedCampaignId)).toBe(1);
    expect(await clicksFor(ORG_VICTIM, victimCampaignId)).toBe(0);
  });

  it("clicks and copies increment their own counter on one daily rollup row; impressions, dismissals and browser redemptions are not stored", async () => {
    const campaignId = await seedCampaign(ORG_OWNER);
    const rawKey = await seedKey(ORG_OWNER);
    const app = createEventsApp();

    const send = (event: string) =>
      app.request("/v1/events", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key: rawKey, event, campaignId, countryCode: "BR" }),
      });
    for (const event of ["impression", "impression", "click", "click", "copy", "redemption", "dismiss"]) {
      expect((await send(event)).status).toBe(204);
    }

    const rows = await getTestDb()
      .select()
      .from(analyticsRollups)
      .where(eq(analyticsRollups.campaignId, campaignId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      organizationId: ORG_OWNER,
      countryCode: "BR",
      period: "day",
      environment: "live",
      // A client-posted impression gets its 204 and is not counted: the config
      // endpoint counted the visitor when it served the offer.
      impressions: 0,
      clicks: 2,
      copies: 1,
      // A browser-reported "redemption" still gets 204 but is never counted:
      // redemptions come only from signature-verified provider webhooks, so a
      // visitor cannot inflate a merchant's numbers (banner-core, Wave C).
      redemptions: 0,
    });
  });

  it("rejects an unknown API key with 401 and writes nothing", async () => {
    const campaignId = await seedCampaign(ORG_OWNER);
    const app = createEventsApp();
    const res = await app.request("/v1/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: "gpl_pk_unknown", event: "click", campaignId, countryCode: "IN" }),
    });
    expect(res.status).toBe(401);
    expect(await clicksFor(ORG_OWNER, campaignId)).toBe(0);
  });
});
