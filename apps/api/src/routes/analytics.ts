import { Hono } from "hono";
import { eq, and, gte, sql, desc, inArray } from "drizzle-orm";
import type { AppEnv } from "../bindings";
import { createDb } from "../db";
import { analyticsRollups } from "../db/schema";
import { getOrgRetentionDays } from "../lib/limits";
import { allowedCampaignIdsFor } from "../lib/product-access";
import { requirePermission } from "../middleware/permissions";
import { errorSummary } from "../lib/log";
import { ALL, revenueSavedByCurrency } from "../services/revenue.service";

const app = new Hono<AppEnv>();

const DAY_MS = 86_400_000;

/**
 * Lower bound for an analytics query: the later of `from` and the plan's
 * retention start. An unparseable `from` (e.g. ?from=abc) is ignored rather
 * than becoming an Invalid Date, which fails when the query is serialized
 * and turned every such request into a 500.
 */
export function clampFrom(fromDate: string | undefined, retentionStart: number): Date {
  const requested = fromDate ? new Date(fromDate).getTime() : Number.NaN;
  return new Date(Number.isFinite(requested) ? Math.max(requested, retentionStart) : retentionStart);
}

// Overview summary stats
app.get("/v1/teams/:orgId/analytics/overview", requirePermission("analytics.view"), async (c) => {
  const orgId = c.req.param("orgId");
  const db = createDb(c.env);

  try {
    const period = c.req.query("period") ?? "day";
    const fromDate = c.req.query("from");

    // Clamp the lower bound to the plan's retention window so a Free org can't
    // read history older than its tier allows, regardless of the `from` param.
    const retentionDays = await getOrgRetentionDays(db, orgId, c.env);
    const retentionStart = Date.now() - retentionDays * DAY_MS;
    const effectiveFrom = clampFrom(fromDate, retentionStart);

    const conditions = [
      eq(analyticsRollups.organizationId, orgId),
      eq(analyticsRollups.period, period),
      // gte() maps the Date through the column type; a raw sql param does not
      // (postgres-js rejects Date params in plain sql templates → 500s).
      gte(analyticsRollups.periodStart, effectiveFrom),
    ];

    // Scoped members only see analytics for campaigns in their product scope.
    const allowedCampaigns = await allowedCampaignIdsFor(c, db, orgId);
    if (allowedCampaigns) {
      if (allowedCampaigns.size === 0) {
        return c.json({
          data: {
            totalImpressions: 0,
            totalClicks: 0,
            totalCopies: 0,
            totalRedemptions: 0,
            totalRevenueSaved: 0,
            revenueSavedByCurrency: {},
          },
        });
      }
      conditions.push(inArray(analyticsRollups.campaignId, Array.from(allowedCampaigns)));
    }

    // Revenue saved per currency alongside (totalRevenueSaved is the USD part only).
    const [rows, revenue] = await Promise.all([
      db
      .select({
        totalImpressions: sql<number>`COALESCE(SUM(${analyticsRollups.impressions}), 0)`,
        totalClicks: sql<number>`COALESCE(SUM(${analyticsRollups.clicks}), 0)`,
        totalCopies: sql<number>`COALESCE(SUM(${analyticsRollups.copies}), 0)`,
        totalRedemptions: sql<number>`COALESCE(SUM(${analyticsRollups.redemptions}), 0)`,
        totalRevenueSaved: sql<number>`COALESCE(SUM(${analyticsRollups.revenueSaved}), 0)`,
      })
      .from(analyticsRollups)
      .where(and(...conditions)),
      revenueSavedByCurrency(db, and(...conditions)),
    ]);

    const raw = rows[0] ?? {
      totalImpressions: 0,
      totalClicks: 0,
      totalCopies: 0,
      totalRedemptions: 0,
      totalRevenueSaved: 0,
    };

    // Postgres SUM() over bigint/numeric columns serializes as strings via
    // postgres-js. Coerce to Number so the JSON matches the client's number
    // types (OverviewStats), otherwise the dashboard does string concatenation.
    const summary = {
      totalImpressions: Number(raw.totalImpressions),
      totalClicks: Number(raw.totalClicks),
      totalCopies: Number(raw.totalCopies),
      totalRedemptions: Number(raw.totalRedemptions),
      totalRevenueSaved: Number(raw.totalRevenueSaved),
      revenueSavedByCurrency: revenue.get(ALL) ?? {},
    };

    return c.json({ data: summary });
  } catch (err) {
    console.error("analytics: failed to fetch analytics overview", { error: errorSummary(err) });
    return c.json({ error: "Failed to fetch analytics overview" }, 500);
  }
});

// Breakdown by country
app.get("/v1/teams/:orgId/analytics/by-country", requirePermission("analytics.view"), async (c) => {
  const orgId = c.req.param("orgId");
  const db = createDb(c.env);

  try {
    const period = c.req.query("period") ?? "day";
    const fromDate = c.req.query("from");
    const retentionDays = await getOrgRetentionDays(db, orgId, c.env);
    const retentionStart = Date.now() - retentionDays * DAY_MS;
    const effectiveFrom = clampFrom(fromDate, retentionStart);

    const conditions = [
      eq(analyticsRollups.organizationId, orgId),
      eq(analyticsRollups.period, period),
      gte(analyticsRollups.periodStart, effectiveFrom),
    ];

    const allowedCampaigns = await allowedCampaignIdsFor(c, db, orgId);
    if (allowedCampaigns) {
      if (allowedCampaigns.size === 0) return c.json({ data: [] });
      conditions.push(inArray(analyticsRollups.campaignId, Array.from(allowedCampaigns)));
    }

    const [rows, revenue] = await Promise.all([
      db
      .select({
        countryCode: analyticsRollups.countryCode,
        impressions: sql<number>`COALESCE(SUM(${analyticsRollups.impressions}), 0)`,
        clicks: sql<number>`COALESCE(SUM(${analyticsRollups.clicks}), 0)`,
        copies: sql<number>`COALESCE(SUM(${analyticsRollups.copies}), 0)`,
        redemptions: sql<number>`COALESCE(SUM(${analyticsRollups.redemptions}), 0)`,
        revenueSaved: sql<number>`COALESCE(SUM(${analyticsRollups.revenueSaved}), 0)`,
      })
      .from(analyticsRollups)
      .where(and(...conditions))
      .groupBy(analyticsRollups.countryCode)
      .orderBy(desc(sql`SUM(${analyticsRollups.impressions})`)),
      revenueSavedByCurrency(db, and(...conditions), analyticsRollups.countryCode),
    ]);

    // SUM() aggregates come back as strings from postgres-js — coerce the
    // numeric fields so the response matches CountryAnalytics' number types.
    const data = rows.map((r) => ({
      countryCode: r.countryCode,
      impressions: Number(r.impressions),
      clicks: Number(r.clicks),
      copies: Number(r.copies),
      redemptions: Number(r.redemptions),
      revenueSaved: Number(r.revenueSaved),
      revenueSavedByCurrency: revenue.get(r.countryCode ?? ALL) ?? {},
    }));

    return c.json({ data });
  } catch (err) {
    console.error("analytics: failed to fetch analytics by country", { error: errorSummary(err) });
    return c.json({ error: "Failed to fetch analytics by country" }, 500);
  }
});

// Breakdown by campaign
app.get("/v1/teams/:orgId/analytics/by-campaign", requirePermission("analytics.view"), async (c) => {
  const orgId = c.req.param("orgId");
  const db = createDb(c.env);

  try {
    const period = c.req.query("period") ?? "day";
    const fromDate = c.req.query("from");
    const retentionDays = await getOrgRetentionDays(db, orgId, c.env);
    const retentionStart = Date.now() - retentionDays * DAY_MS;
    const effectiveFrom = clampFrom(fromDate, retentionStart);

    const conditions = [
      eq(analyticsRollups.organizationId, orgId),
      eq(analyticsRollups.period, period),
      gte(analyticsRollups.periodStart, effectiveFrom),
    ];

    const allowedCampaigns = await allowedCampaignIdsFor(c, db, orgId);
    if (allowedCampaigns) {
      if (allowedCampaigns.size === 0) return c.json({ data: [] });
      conditions.push(inArray(analyticsRollups.campaignId, Array.from(allowedCampaigns)));
    }

    const [rows, revenue] = await Promise.all([
      db
      .select({
        campaignId: analyticsRollups.campaignId,
        impressions: sql<number>`COALESCE(SUM(${analyticsRollups.impressions}), 0)`,
        clicks: sql<number>`COALESCE(SUM(${analyticsRollups.clicks}), 0)`,
        copies: sql<number>`COALESCE(SUM(${analyticsRollups.copies}), 0)`,
        redemptions: sql<number>`COALESCE(SUM(${analyticsRollups.redemptions}), 0)`,
        revenueSaved: sql<number>`COALESCE(SUM(${analyticsRollups.revenueSaved}), 0)`,
      })
      .from(analyticsRollups)
      .where(and(...conditions))
      .groupBy(analyticsRollups.campaignId)
      .orderBy(desc(sql`SUM(${analyticsRollups.impressions})`)),
      revenueSavedByCurrency(db, and(...conditions), analyticsRollups.campaignId),
    ]);

    // Same bigint-as-string coercion as the other aggregate endpoints.
    const data = rows.map((r) => ({
      campaignId: r.campaignId,
      impressions: Number(r.impressions),
      clicks: Number(r.clicks),
      copies: Number(r.copies),
      redemptions: Number(r.redemptions),
      revenueSaved: Number(r.revenueSaved),
      revenueSavedByCurrency: revenue.get(r.campaignId ?? ALL) ?? {},
    }));

    return c.json({ data });
  } catch (err) {
    console.error("analytics: failed to fetch analytics by campaign", { error: errorSummary(err) });
    return c.json({ error: "Failed to fetch analytics by campaign" }, 500);
  }
});

export default app;
