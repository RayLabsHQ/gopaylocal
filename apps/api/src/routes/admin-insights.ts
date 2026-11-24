/**
 * Admin: revenue, activation, health and the audit log, and marking a
 * workspace internal. Mounted under /v1/admin/*, behind the session and
 * admin-role middleware. Internal workspaces and test-mode data are left out
 * of every figure (lib/revenue.ts).
 */

import { Hono } from "hono";
import { and, count, desc, eq, gt, isNotNull, ne, or, sql } from "drizzle-orm";
import { ulid } from "ulid";
import type { AppEnv } from "../bindings";
import { createDb } from "../db";
import {
  adminAuditLog,
  analyticsRollups,
  apiKeys,
  campaigns,
  deals,
  experiments,
  integrations,
  internalOrganizations,
  members,
  organizations,
  products,
  subscriptions,
  users,
  webhookEvents,
} from "../db/schema";
import { usableFxRates } from "@gopaylocal/shared/currency";
import { activationFunnel, notInternal, signupsByWeek, summarizeRevenue } from "../lib/revenue";
import { integrationHealthOf } from "../services/integration-health.service";
import { loadFxRates } from "../services/fx-cache";
import { fxDisabled } from "../services/fx-refresh.service";
import { loadHouseSettings } from "../services/house-pricing.service";

const app = new Hono<AppEnv>();

// ── Revenue ─────────────────────────────────────────────────────────────────

app.get("/v1/admin/revenue", async (c) => {
  const db = createDb(c.env);
  try {
    const rows = await db
      .select({
        organizationId: subscriptions.organizationId,
        organizationName: organizations.name,
        plan: subscriptions.plan,
        status: subscriptions.status,
        environment: subscriptions.environment,
        recurringAmount: subscriptions.recurringAmount,
        currency: subscriptions.currency,
        billingCountry: subscriptions.billingCountry,
        createdAt: subscriptions.createdAt,
        updatedAt: subscriptions.updatedAt,
        currentPeriodEnd: subscriptions.currentPeriodEnd,
        internal: sql<boolean>`(${internalOrganizations.organizationId} IS NOT NULL)`,
      })
      .from(subscriptions)
      .leftJoin(organizations, eq(organizations.id, subscriptions.organizationId))
      .leftJoin(internalOrganizations, eq(internalOrganizations.organizationId, subscriptions.organizationId))
      .orderBy(desc(subscriptions.updatedAt));

    return c.json({
      data: {
        summary: summarizeRevenue(rows),
        subscriptions: rows.slice(0, 200).map((r) => ({
          ...r,
          createdAt: r.createdAt.toISOString(),
          updatedAt: r.updatedAt.toISOString(),
          currentPeriodEnd: r.currentPeriodEnd?.toISOString() ?? null,
        })),
      },
    });
  } catch (err) {
    console.error("Failed to load revenue:", err);
    return c.json({ error: "Failed to load revenue" }, 500);
  }
});

// ── Activation and feature adoption ─────────────────────────────────────────

app.get("/v1/admin/activation", async (c) => {
  const db = createDb(c.env);
  try {
    const live = (col: typeof campaigns.environment) => eq(col, "live");
    const [orgs, byMode, byDelivery, charmCount, providers, running, upcomingDeals, teams, serverApi] = await Promise.all([
      db
        .select({
          id: organizations.id,
          name: organizations.name,
          createdAt: organizations.createdAt,
          ownerEmail: sql<string | null>`(SELECT ${users.email} FROM ${members} INNER JOIN ${users} ON ${users.id} = ${members.userId} WHERE ${members.organizationId} = ${organizations.id} AND ${members.role} = 'owner' ORDER BY ${members.createdAt} LIMIT 1)`,
          hasProduct: sql<boolean>`EXISTS (SELECT 1 FROM ${products} WHERE ${products.organizationId} = ${organizations.id} AND ${products.environment} = 'live')`,
          hasActiveCampaign: sql<boolean>`EXISTS (SELECT 1 FROM ${campaigns} WHERE ${campaigns.organizationId} = ${organizations.id} AND ${campaigns.status} = 'active' AND ${campaigns.environment} = 'live')`,
          hasLiveViews: sql<boolean>`EXISTS (SELECT 1 FROM ${analyticsRollups} WHERE ${analyticsRollups.organizationId} = ${organizations.id} AND ${analyticsRollups.environment} = 'live' AND ${analyticsRollups.period} = 'day' AND ${analyticsRollups.impressions} > 0)`,
          isPro: sql<boolean>`EXISTS (SELECT 1 FROM ${subscriptions} WHERE ${subscriptions.organizationId} = ${organizations.id} AND ${subscriptions.environment} = 'live' AND ${subscriptions.status} = 'active' AND ${subscriptions.plan} IN ('pro', 'business'))`,
        })
        .from(organizations)
        .where(notInternal(organizations.id))
        .orderBy(desc(organizations.createdAt))
        .limit(5000),
      db
        .select({ key: campaigns.pricingMode, count: count() })
        .from(campaigns)
        .where(and(eq(campaigns.status, "active"), live(campaigns.environment), notInternal(campaigns.organizationId)))
        .groupBy(campaigns.pricingMode),
      db
        .select({ key: campaigns.discountDelivery, count: count() })
        .from(campaigns)
        .where(and(eq(campaigns.status, "active"), live(campaigns.environment), notInternal(campaigns.organizationId)))
        .groupBy(campaigns.discountDelivery),
      db
        .select({ total: count() })
        .from(campaigns)
        .where(
          and(
            eq(campaigns.status, "active"),
            live(campaigns.environment),
            ne(campaigns.charmPricingStrategy, "none"),
            notInternal(campaigns.organizationId),
          ),
        ),
      db
        .select({ key: integrations.provider, count: count() })
        .from(integrations)
        .where(and(eq(integrations.status, "active"), notInternal(integrations.organizationId)))
        .groupBy(integrations.provider),
      db
        .select({ total: count(), orgs: sql<number>`COUNT(DISTINCT ${experiments.organizationId})`.mapWith(Number) })
        .from(experiments)
        .where(and(eq(experiments.status, "running"), notInternal(experiments.organizationId))),
      db
        .select({ total: count(), orgs: sql<number>`COUNT(DISTINCT ${deals.organizationId})`.mapWith(Number) })
        .from(deals)
        .where(and(gt(deals.endsAt, sql`NOW()`), notInternal(deals.organizationId))),
      db
        .select({ total: count() })
        .from(
          db
            .select({ org: members.organizationId })
            .from(members)
            .where(notInternal(members.organizationId))
            .groupBy(members.organizationId)
            .having(sql`COUNT(*) > 1`)
            .as("teams"),
        ),
      db
        .select({ total: sql<number>`COUNT(DISTINCT ${apiKeys.organizationId})`.mapWith(Number) })
        .from(apiKeys)
        .where(
          and(
            eq(apiKeys.keyType, "secret"),
            sql`${apiKeys.lastUsedAt} >= NOW() - INTERVAL '30 days'`,
            notInternal(apiKeys.organizationId),
          ),
        ),
    ]);

    const now = new Date();
    const tally = (rows: Array<{ key: string; count: number }>) => Object.fromEntries(rows.map((r) => [r.key, r.count]));
    const day = 86_400_000;
    return c.json({
      data: {
        totalOrganizations: orgs.length,
        signupsLast7Days: orgs.filter((o) => now.getTime() - o.createdAt.getTime() < 7 * day).length,
        signupsLast30Days: orgs.filter((o) => now.getTime() - o.createdAt.getTime() < 30 * day).length,
        signupsByWeek: signupsByWeek(orgs.map((o) => o.createdAt), now),
        funnel: activationFunnel(orgs, now),
        adoption: {
          pricingModes: tally(byMode),
          discountDelivery: tally(byDelivery),
          charmPricing: charmCount[0]?.total ?? 0,
          activeCampaigns: byMode.reduce((a, r) => a + r.count, 0),
          integrations: tally(providers),
          runningAbTests: { tests: running[0]?.total ?? 0, organizations: running[0]?.orgs ?? 0 },
          dealsNotEnded: { deals: upcomingDeals[0]?.total ?? 0, organizations: upcomingDeals[0]?.orgs ?? 0 },
          teamsOfTwoOrMore: teams[0]?.total ?? 0,
          serverApiLast30Days: serverApi[0]?.total ?? 0,
        },
      },
    });
  } catch (err) {
    console.error("Failed to load activation:", err);
    return c.json({ error: "Failed to load activation" }, 500);
  }
});

// ── Health ──────────────────────────────────────────────────────────────────

app.get("/v1/admin/health", async (c) => {
  const db = createDb(c.env);
  try {
    const [failedWebhooks, backlog, troubled, fxDoc, house] = await Promise.all([
      db
        .select({
          provider: webhookEvents.provider,
          eventType: webhookEvents.eventType,
          count: count(),
          lastAt: sql<string>`MAX(${webhookEvents.createdAt})`,
          lastError: sql<string | null>`(ARRAY_AGG(${webhookEvents.errorMessage} ORDER BY ${webhookEvents.createdAt} DESC))[1]`,
        })
        .from(webhookEvents)
        .where(and(isNotNull(webhookEvents.errorMessage), sql`${webhookEvents.createdAt} >= NOW() - INTERVAL '7 days'`))
        .groupBy(webhookEvents.provider, webhookEvents.eventType)
        .orderBy(desc(sql`MAX(${webhookEvents.createdAt})`))
        .limit(50),
      db
        .select({ total: count(), oldest: sql<string | null>`MIN(${webhookEvents.createdAt})` })
        .from(webhookEvents)
        .where(eq(webhookEvents.processed, false)),
      db
        .select({
          id: integrations.id,
          provider: integrations.provider,
          status: integrations.status,
          health: integrations.health,
          organizationId: integrations.organizationId,
          organizationName: organizations.name,
          internal: sql<boolean>`(${internalOrganizations.organizationId} IS NOT NULL)`,
        })
        .from(integrations)
        .innerJoin(organizations, eq(organizations.id, integrations.organizationId))
        .leftJoin(internalOrganizations, eq(internalOrganizations.organizationId, integrations.organizationId))
        .where(or(ne(integrations.status, "active"), sql`${integrations.health} <> '{}'::jsonb`))
        .orderBy(desc(integrations.updatedAt))
        .limit(100),
      fxDisabled(c.env) ? Promise.resolve(null) : loadFxRates(c.env.CACHE),
      loadHouseSettings(db),
    ]);

    const fx = usableFxRates(fxDoc, Date.now());
    const storedAsOf = fxDoc && typeof (fxDoc as { asOf?: unknown }).asOf === "string" ? (fxDoc as { asOf: string }).asOf : null;
    return c.json({
      data: {
        failedWebhooks,
        webhookBacklog: { unprocessed: backlog[0]?.total ?? 0, oldest: backlog[0]?.oldest ?? null },
        integrations: troubled.map((i) => ({
          id: i.id,
          provider: i.provider,
          status: i.status,
          organizationId: i.organizationId,
          organizationName: i.organizationName,
          internal: i.internal,
          issues: Object.values(integrationHealthOf(i)),
        })),
        fxRates: fxDisabled(c.env) ? { state: "off" } : { state: fx ? "fresh" : storedAsOf ? "stale" : "missing", asOf: storedAsOf },
        housePricing: house ? { lastSync: house.lastSync ?? null } : null,
      },
    });
  } catch (err) {
    console.error("Failed to load health:", err);
    return c.json({ error: "Failed to load health" }, 500);
  }
});

// ── Audit log ───────────────────────────────────────────────────────────────

app.get("/v1/admin/audit", async (c) => {
  const db = createDb(c.env);
  const page = Math.max(1, Number.parseInt(c.req.query("page") ?? "", 10) || 1);
  const limit = 50;
  try {
    const [rows, total] = await Promise.all([
      db
        .select({
          id: adminAuditLog.id,
          action: adminAuditLog.action,
          targetType: adminAuditLog.targetType,
          targetId: adminAuditLog.targetId,
          details: adminAuditLog.details,
          createdAt: adminAuditLog.createdAt,
          adminName: users.name,
          adminEmail: users.email,
        })
        .from(adminAuditLog)
        .leftJoin(users, eq(users.id, adminAuditLog.adminUserId))
        .orderBy(desc(adminAuditLog.createdAt))
        .limit(limit)
        .offset((page - 1) * limit),
      db.select({ total: count() }).from(adminAuditLog),
    ]);
    const n = total[0]?.total ?? 0;
    return c.json({ data: rows, pagination: { page, limit, total: n, totalPages: Math.ceil(n / limit) } });
  } catch (err) {
    console.error("Failed to load the audit log:", err);
    return c.json({ error: "Failed to load the audit log" }, 500);
  }
});

// ── Internal workspaces ─────────────────────────────────────────────────────

app.put("/v1/admin/organizations/:id/internal", async (c) => {
  const orgId = c.req.param("id");
  const admin = c.get("user");
  const body = (await c.req.json().catch(() => ({}))) as { internal?: unknown; note?: unknown };
  if (typeof body.internal !== "boolean") return c.json({ error: "internal must be true or false" }, 400);
  const note = typeof body.note === "string" && body.note.trim() ? body.note.trim().slice(0, 200) : null;
  const db = createDb(c.env);
  try {
    const [org] = await db.select({ id: organizations.id }).from(organizations).where(eq(organizations.id, orgId)).limit(1);
    if (!org) return c.json({ error: "Organization not found" }, 404);
    if (body.internal) {
      await db
        .insert(internalOrganizations)
        .values({ organizationId: orgId, note, markedByUserId: admin.id })
        .onConflictDoUpdate({ target: internalOrganizations.organizationId, set: { note } });
    } else {
      const house = await loadHouseSettings(db);
      if (house?.organizationId === orgId) {
        return c.json({ error: "This is the house workspace that prices Pro. Pick another house campaign first." }, 409);
      }
      await db.delete(internalOrganizations).where(eq(internalOrganizations.organizationId, orgId));
    }
    await db.insert(adminAuditLog).values({
      id: ulid(),
      adminUserId: admin.id,
      action: body.internal ? "mark_internal" : "unmark_internal",
      targetType: "organization",
      targetId: orgId,
      details: note ? { note } : null,
      createdAt: new Date(),
    });
    return c.json({ data: { organizationId: orgId, internal: body.internal, note } });
  } catch (err) {
    console.error("Failed to change the internal flag:", err);
    return c.json({ error: "Failed to change the internal flag" }, 500);
  }
});

export default app;
