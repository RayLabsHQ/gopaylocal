// Postgres-backed checks for the wave C provider plumbing (provider-shared):
// the statements unit tests can only assert the shape of. Run by test-infra
// against the local test database once the schema is synced.
//  - S4: revenue_saved_by_currency upsert adds per currency, never across them
//  - revenue.service per-currency read (jsonb_each_text, LATERAL)
//  - S3: integrations.health conditional UPDATE (record, dedupe, clear)
//  - FK review: campaigns.integration_id SET NULL, coupons.integration_id CASCADE
//  - S7: one active coupon per (campaign, country), partial on status
//  - B-12: campaign + banner config insert is one transaction

import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { getTestDb, cleanupTestDb, closeTestDb } from "../test/setup";
import { analyticsRollups, bannerConfigs, campaigns, coupons, integrations, products } from "../db/schema";
import type { Database } from "../db";
import { handleRedemption } from "../services/redemption.service";
import { ALL, revenueSavedByCurrency } from "../services/revenue.service";
import {
  REWRITE_AFTER_MS,
  clearIntegrationIssue,
  integrationHealthOf,
  recordIntegrationIssue,
} from "../services/integration-health.service";
import { insertCampaignWithBanner } from "./campaigns";

const ORG = "org-provider-plumbing";
const INTEGRATION = "int_plumbing";
const PRODUCT = "prod_plumbing";
const CAMPAIGN = "camp_plumbing";

const db = () => getTestDb() as unknown as Database;

async function seed() {
  const now = new Date();
  await getTestDb().insert(products).values({ id: PRODUCT, organizationId: ORG, name: "P", url: "https://example.com/p", basePrice: 100 });
  await getTestDb().insert(integrations).values({ id: INTEGRATION, organizationId: ORG, provider: "polar", liveAccessTokenEnc: "enc" });
  await getTestDb().insert(campaigns).values({
    id: CAMPAIGN,
    organizationId: ORG,
    productId: PRODUCT,
    integrationId: INTEGRATION,
    name: "C",
    status: "active",
    createdAt: now,
    updatedAt: now,
  });
}

async function addCoupon(id: string, code: string, countryCode: string, extra: Partial<typeof coupons.$inferInsert> = {}) {
  await getTestDb().insert(coupons).values({
    id,
    campaignId: CAMPAIGN,
    integrationId: INTEGRATION,
    countryCode,
    code,
    discountPercent: 40,
    ...extra,
  });
}

const redemption = (eventId: string, code: string, chargedMinor: number, taxMinor: number | null, currency: string) => ({
  eventId,
  code,
  providerCouponId: null,
  providerPromoCodeId: null,
  chargedAmountCents: chargedMinor,
  taxAmountCents: taxMinor,
  discountAmountCents: null,
  currency,
});

describe("provider plumbing on Postgres", () => {
  beforeEach(async () => {
    await cleanupTestDb();
    await seed();
  });

  afterAll(async () => {
    await cleanupTestDb();
    await closeTestDb();
  });

  it("S4: the per-currency upsert adds within a currency and keeps currencies apart", async () => {
    await addCoupon("cp_in", "PPPIN40AAAA", "IN");
    // 40% off: paid 6000 pre-tax => saved 4000 minor units each time.
    expect(await handleRedemption(db(), INTEGRATION, ORG, redemption("e1", "PPPIN40AAAA", 6000, 0, "INR"))).toBe(true);
    expect(await handleRedemption(db(), INTEGRATION, ORG, redemption("e2", "PPPIN40AAAA", 7200, 1200, "INR"))).toBe(true);
    expect(await handleRedemption(db(), INTEGRATION, ORG, redemption("e3", "PPPIN40AAAA", 600, 0, "USD"))).toBe(true);
    // Tax unknown: counted, no savings.
    expect(await handleRedemption(db(), INTEGRATION, ORG, redemption("e4", "PPPIN40AAAA", 600, null, "USD"))).toBe(true);

    const [row] = await getTestDb().select().from(analyticsRollups).where(eq(analyticsRollups.campaignId, CAMPAIGN));
    expect(row!.redemptions).toBe(4);
    expect(row!.revenueSavedByCurrency).toEqual({ INR: 8000, USD: 400 });
    expect(row!.revenueSaved).toBeCloseTo(4); // USD only, dollars

    const totals = await revenueSavedByCurrency(db(), eq(analyticsRollups.organizationId, ORG));
    expect(totals.get(ALL)).toEqual({ INR: 80, USD: 4 });
    const byCountry = await revenueSavedByCurrency(db(), eq(analyticsRollups.organizationId, ORG), analyticsRollups.countryCode);
    expect(byCountry.get("IN")).toEqual({ INR: 80, USD: 4 });
  });

  it("S3: health is recorded once per issue within ten minutes, rewritten after, and cleared per area", async () => {
    const at = new Date("2026-11-18T10:00:00Z");
    await recordIntegrationIssue(db(), INTEGRATION, { area: "coupon_sync", message: "boom", environment: "live" }, at);
    await recordIntegrationIssue(db(), INTEGRATION, { area: "coupon_sync", message: "boom", environment: "live" }, new Date(at.getTime() + 60_000));
    await recordIntegrationIssue(db(), INTEGRATION, { area: "credentials", message: "rejected" }, at);

    let [row] = await getTestDb().select().from(integrations).where(eq(integrations.id, INTEGRATION));
    let health = integrationHealthOf(row);
    expect(health.coupon_sync).toEqual({ area: "coupon_sync", message: "boom", environment: "live", at: at.toISOString() });
    expect(health.credentials?.message).toBe("rejected");

    const later = new Date(at.getTime() + REWRITE_AFTER_MS + 1);
    await recordIntegrationIssue(db(), INTEGRATION, { area: "coupon_sync", message: "boom", environment: "live" }, later);
    [row] = await getTestDb().select().from(integrations).where(eq(integrations.id, INTEGRATION));
    expect(integrationHealthOf(row).coupon_sync?.at).toBe(later.toISOString());

    await clearIntegrationIssue(db(), INTEGRATION, "coupon_sync");
    [row] = await getTestDb().select().from(integrations).where(eq(integrations.id, INTEGRATION));
    health = integrationHealthOf(row);
    expect(health.coupon_sync).toBeUndefined();
    expect(health.credentials).toBeDefined();
  });

  it("FKs: deleting an integration unlinks its campaigns and deletes its coupon rows", async () => {
    await addCoupon("cp_br", "PPPBR40AAAA", "BR");

    await getTestDb().delete(integrations).where(eq(integrations.id, INTEGRATION));

    const [campaign] = await getTestDb().select().from(campaigns).where(eq(campaigns.id, CAMPAIGN));
    expect(campaign!.integrationId).toBeNull();
    expect(await getTestDb().select().from(coupons)).toHaveLength(0);
  });

  it("FKs: a campaign or coupon can't point at a missing integration", async () => {
    await expect(
      getTestDb().update(campaigns).set({ integrationId: "int_missing" }).where(eq(campaigns.id, CAMPAIGN)),
    ).rejects.toThrow();
    await expect(addCoupon("cp_x", "PPPXX40AAAA", "XX", { integrationId: "int_missing" })).rejects.toThrow();
  });

  it("S7: a second ACTIVE coupon for the same campaign and country is refused; retired ones don't count", async () => {
    await addCoupon("cp_1", "PPPMX40AAAA", "MX");
    await expect(addCoupon("cp_2", "PPPMX40BBBB", "MX")).rejects.toMatchObject({
      cause: expect.objectContaining({ code: "23505", constraint_name: "coupons_one_active_per_country_idx" }),
    });
    await addCoupon("cp_3", "PPPMX40CCCC", "MX", { status: "retiring" });
    await addCoupon("cp_4", "PPPAR40AAAA", "AR");
    expect(await getTestDb().select().from(coupons)).toHaveLength(3);
  });

  it("B-12: a failing banner insert leaves no campaign behind", async () => {
    // A duplicate banner id makes the second insert fail after the campaign insert.
    const first = await insertCampaignWithBanner(
      db(),
      { id: "camp_b12_a", organizationId: ORG, productId: PRODUCT, name: "A" },
      "banner_b12",
    );
    expect(first.id).toBe("camp_b12_a");

    await expect(
      insertCampaignWithBanner(db(), { id: "camp_b12_b", organizationId: ORG, productId: PRODUCT, name: "B" }, "banner_b12"),
    ).rejects.toThrow();

    expect(await getTestDb().select().from(campaigns).where(eq(campaigns.id, "camp_b12_b"))).toHaveLength(0);
    expect(await getTestDb().select().from(bannerConfigs).where(eq(bannerConfigs.campaignId, "camp_b12_a"))).toHaveLength(1);
  });
});
