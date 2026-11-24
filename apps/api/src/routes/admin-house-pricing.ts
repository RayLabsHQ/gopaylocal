/**
 * Admin: the regional Pro price (services/house-pricing.service.ts). Mounted
 * under /v1/admin/*, behind the session and admin-role middleware.
 */

import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { ulid } from "ulid";
import type { AppEnv } from "../bindings";
import { createDb } from "../db";
import { adminAuditLog, campaigns, internalOrganizations, organizations, products } from "../db/schema";
import {
  compareWithDodo,
  houseRegionalPrices,
  houseSyncUnavailable,
  listDodoRules,
  loadHouseSettings,
  saveHouseSettings,
  syncHousePrices,
} from "../services/house-pricing.service";

const app = new Hono<AppEnv>();

/** Dodo calls one "Push to Dodo" request may make (Workers Free allows 50 subrequests). */
const ADMIN_SYNC_BUDGET = 35;

app.get("/v1/admin/house-pricing", async (c) => {
  const db = createDb(c.env);
  try {
    const [settings, candidates] = await Promise.all([
      loadHouseSettings(db),
      // Campaigns of internal workspaces: the house workspace must be one, so
      // its own traffic stays out of the metrics.
      db
        .select({
          campaignId: campaigns.id,
          campaignName: campaigns.name,
          status: campaigns.status,
          environment: campaigns.environment,
          maxDiscountPercent: campaigns.maxDiscountPercent,
          pricingMode: campaigns.pricingMode,
          hasIntegration: campaigns.integrationId,
          organizationId: organizations.id,
          organizationName: organizations.name,
          productName: products.name,
          productPrice: products.basePrice,
          productCurrency: products.currency,
        })
        .from(campaigns)
        .innerJoin(internalOrganizations, eq(internalOrganizations.organizationId, campaigns.organizationId))
        .innerJoin(organizations, eq(organizations.id, campaigns.organizationId))
        .innerJoin(products, eq(products.id, campaigns.productId)),
    ]);

    const unavailable = houseSyncUnavailable(c.env);
    const table = settings ? await houseRegionalPrices(db, c.env, settings) : null;
    let dodo: { ok: true; byCountry: Record<string, unknown>; extraRules: number } | { ok: false; message: string } | null = null;
    if (!unavailable && table?.ok) {
      const listed = await listDodoRules(c.env);
      dodo = listed.ok ? { ok: true, ...compareWithDodo(table.rows, listed.rules) } : listed;
    }

    const current = settings ? candidates.find((x) => x.campaignId === settings.campaignId) ?? null : null;
    return c.json({
      data: {
        unavailable,
        dodoEnvironment: c.env.DODO_ENVIRONMENT === "test_mode" ? "test_mode" : "live_mode",
        settings: settings
          ? {
              organizationId: settings.organizationId,
              campaignId: settings.campaignId,
              // Null when the campaign is gone or its workspace is no longer internal.
              campaign: current,
              lastSync: settings.lastSync ?? null,
            }
          : null,
        candidates: candidates.map((x) => ({ ...x, hasIntegration: x.hasIntegration !== null })),
        table: table
          ? table.ok
            ? {
                ok: true,
                fxAsOf: table.fxAsOf,
                charm: table.charm,
                rows: table.rows.map((r) => ({
                  country: r.country,
                  countryName: r.countryName,
                  discount: r.discount,
                  currency: r.charge.currency,
                  amount: r.charge.amount,
                  minorAmount: r.charge.minorAmount,
                  local: r.charge.local,
                  dodo: dodo?.ok ? dodo.byCountry[r.country] ?? null : null,
                })),
              }
            : { ok: false, problem: table.problem }
          : null,
        dodo: dodo ? (dodo.ok ? { ok: true, extraRules: dodo.extraRules } : { ok: false, message: dodo.message }) : null,
      },
    });
  } catch (err) {
    console.error("Failed to load house pricing:", err);
    return c.json({ error: "Failed to load the regional Pro price" }, 500);
  }
});

app.put("/v1/admin/house-pricing", async (c) => {
  const db = createDb(c.env);
  const admin = c.get("user");
  const body = (await c.req.json().catch(() => ({}))) as { campaignId?: unknown };
  if (typeof body.campaignId !== "string" || !body.campaignId) {
    return c.json({ error: "campaignId is required" }, 400);
  }
  try {
    const [campaign] = await db
      .select({ id: campaigns.id, organizationId: campaigns.organizationId, integrationId: campaigns.integrationId })
      .from(campaigns)
      .innerJoin(internalOrganizations, eq(internalOrganizations.organizationId, campaigns.organizationId))
      .where(eq(campaigns.id, body.campaignId))
      .limit(1);
    if (!campaign) {
      return c.json({ error: "Pick a campaign of an internal workspace. Mark the workspace internal first." }, 400);
    }
    if (campaign.integrationId) {
      // Its codes would be taken off the per-country price Dodo already charges.
      return c.json({ error: "The house campaign must have no payment platform, so it shows the price without a code." }, 400);
    }
    const previous = await loadHouseSettings(db);
    await saveHouseSettings(db, { organizationId: campaign.organizationId, campaignId: campaign.id }, admin.id);
    await db.insert(adminAuditLog).values({
      id: ulid(),
      adminUserId: admin.id,
      action: "set_house_pricing",
      targetType: "campaign",
      targetId: campaign.id,
      details: { previousCampaignId: previous?.campaignId ?? null },
      createdAt: new Date(),
    });
    return c.json({ data: { organizationId: campaign.organizationId, campaignId: campaign.id } });
  } catch (err) {
    console.error("Failed to set house pricing:", err);
    return c.json({ error: "Failed to set the house campaign" }, 500);
  }
});

app.post("/v1/admin/house-pricing/sync", async (c) => {
  const db = createDb(c.env);
  const admin = c.get("user");
  try {
    const result = await syncHousePrices(db, c.env, { budget: ADMIN_SYNC_BUDGET, trigger: "admin", userId: admin.id });
    if (result.outcome === "synced") {
      const { created, updated, archived, failures, remaining } = result.record;
      await db.insert(adminAuditLog).values({
        id: ulid(),
        adminUserId: admin.id,
        action: "sync_house_pricing",
        targetType: "dodo_product",
        targetId: result.record.productId,
        details: { environment: result.record.environment, created, updated, archived, failed: failures.length, remaining },
        createdAt: new Date(),
      });
    }
    return c.json({ data: result });
  } catch (err) {
    console.error("House pricing sync failed:", err);
    return c.json({ error: "The sync failed. Nothing more was sent to Dodo." }, 500);
  }
});

export default app;
