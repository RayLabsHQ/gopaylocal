import { Hono } from "hono";
import { eq, sql, and, or, desc, count, ilike, inArray } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { ulid } from "ulid";
import type { AppEnv } from "../bindings";
import { createDb } from "../db";
import {
  users,
  sessions,
  organizations,
  members,
  subscriptions,
  products,
  campaigns,
  integrations,
  analyticsRollups,
  apiUsageDaily,
  organizationLimitOverrides,
  adminAuditLog,
  internalOrganizations,
} from "../db/schema";
import { PLAN_PRICES_USD, normalizePlan } from "@gopaylocal/shared/constants";
import type { Plan } from "@gopaylocal/shared/types";
import { notInternal, summarizeSubscriptions } from "../lib/revenue";
import { resolveEntitlements } from "../lib/entitlements";
import {
  computeLimitWarnings,
  meteredApiCallsSince,
  sumApiCalls,
  utcMonthStart,
  type LimitWarning,
} from "../lib/limits";

// Stored plan values can include the retired 'business' tier; admin views
// always report the two-plan vocabulary.
const displayPlan = (plan: string | null | undefined): Plan => normalizePlan(plan) ?? "free";

const app = new Hono<AppEnv>();

/**
 * Parse a positive integer query param, clamped to [min, max]. A missing or
 * non-numeric value (e.g. ?page=abc) yields `fallback` instead of NaN, which
 * would otherwise reach Postgres as LIMIT/OFFSET NaN and 500 the request.
 */
function intParam(raw: string | undefined, fallback: number, min: number, max: number): number {
  const n = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

/**
 * SUM/COUNT over integer columns return Postgres bigint, which postgres-js
 * hands back as a string ("123"). Map to Number so the JSON matches the
 * declared number types (the admin UI formats and divides these).
 */
const sumInt = (col: AnyPgColumn) => sql<number>`COALESCE(SUM(${col}), 0)`.mapWith(Number);

// ── List all users (paginated, with search) ─────────────────────────────────

app.get("/v1/admin/users", async (c) => {
  const db = createDb(c.env);
  const page = intParam(c.req.query("page"), 1, 1, Number.MAX_SAFE_INTEGER);
  const limit = intParam(c.req.query("limit"), 50, 1, 100);
  const search = c.req.query("search")?.trim();
  const offset = (page - 1) * limit;

  try {
    const searchCondition = search
      ? or(
          ilike(users.name, `%${search}%`),
          ilike(users.email, `%${search}%`),
        )
      : undefined;

    const [userRows, countResult] = await Promise.all([
      db
        .select({
          id: users.id,
          name: users.name,
          email: users.email,
          image: users.image,
          role: users.role,
          banned: users.banned,
          banReason: users.banReason,
          createdAt: users.createdAt,
          updatedAt: users.updatedAt,
        })
        .from(users)
        .where(searchCondition)
        .orderBy(desc(users.createdAt))
        .limit(limit)
        .offset(offset),
      db
        .select({ total: count() })
        .from(users)
        .where(searchCondition),
    ]);

    const total = countResult[0]?.total ?? 0;

    return c.json({
      data: userRows,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  } catch (err) {
    console.error("Failed to list users:", err);
    return c.json({ error: "Failed to list users" }, 500);
  }
});

// ── Get user details + their orgs ──────────────────────────────────────────

app.get("/v1/admin/users/:id", async (c) => {
  const userId = c.req.param("id");
  const db = createDb(c.env);

  try {
    const [userRows, orgRows] = await Promise.all([
      db
        .select({
          id: users.id,
          name: users.name,
          email: users.email,
          image: users.image,
          role: users.role,
          banned: users.banned,
          banReason: users.banReason,
          createdAt: users.createdAt,
          updatedAt: users.updatedAt,
        })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1),
      db
        .select({
          id: organizations.id,
          name: organizations.name,
          slug: organizations.slug,
          logo: organizations.logo,
          createdAt: organizations.createdAt,
          memberRole: members.role,
        })
        .from(organizations)
        .innerJoin(members, eq(members.organizationId, organizations.id))
        .where(eq(members.userId, userId))
        .orderBy(desc(organizations.createdAt)),
    ]);

    const user = userRows[0];
    if (!user) {
      return c.json({ error: "User not found" }, 404);
    }

    return c.json({ data: { ...user, organizations: orgRows } });
  } catch (err) {
    console.error("Failed to get user:", err);
    return c.json({ error: "Failed to get user details" }, 500);
  }
});

// ── Ban a user ──────────────────────────────────────────────────────────────

app.post("/v1/admin/users/:id/ban", async (c) => {
  const userId = c.req.param("id");
  const adminUser = c.get("user");
  const db = createDb(c.env);

  try {
    // An empty or non-JSON body means "no reason given".
    const body = (await c.req.json().catch(() => ({}))) as { reason?: unknown };
    const reason =
      typeof body.reason === "string" && body.reason.trim()
        ? body.reason.trim().slice(0, 500)
        : "Banned by admin";

    // Flag the user AND end their sessions, atomically. Better Auth here has
    // no admin plugin, so it never reads `banned`: without the session delete
    // a banned user stays signed in (the team and admin middleware also check
    // the flag, which covers the cookie-cache window and any re-sign-in).
    const result = await db.transaction(async (tx) => {
      const updated = await tx
        .update(users)
        .set({
          banned: true,
          banReason: reason,
          updatedAt: new Date(),
        })
        .where(eq(users.id, userId))
        .returning({
          id: users.id,
          name: users.name,
          email: users.email,
          banned: users.banned,
          banReason: users.banReason,
        });
      if (updated.length > 0) {
        await tx.delete(sessions).where(eq(sessions.userId, userId));
      }
      return updated;
    });

    const user = result[0];
    if (!user) {
      return c.json({ error: "User not found" }, 404);
    }

    // Audit log
    await db.insert(adminAuditLog).values({
      id: ulid(),
      adminUserId: adminUser.id,
      action: "ban_user",
      targetType: "user",
      targetId: userId,
      details: { reason },
      createdAt: new Date(),
    });

    return c.json({ data: user });
  } catch (err) {
    console.error("Failed to ban user:", err);
    return c.json({ error: "Failed to ban user" }, 500);
  }
});

// ── Unban a user ────────────────────────────────────────────────────────────

app.post("/v1/admin/users/:id/unban", async (c) => {
  const userId = c.req.param("id");
  const adminUser = c.get("user");
  const db = createDb(c.env);

  try {
    const result = await db
      .update(users)
      .set({
        banned: false,
        banReason: null,
        updatedAt: new Date(),
      })
      .where(eq(users.id, userId))
      .returning({
        id: users.id,
        name: users.name,
        email: users.email,
        banned: users.banned,
        banReason: users.banReason,
      });

    const user = result[0];
    if (!user) {
      return c.json({ error: "User not found" }, 404);
    }

    // Audit log
    await db.insert(adminAuditLog).values({
      id: ulid(),
      adminUserId: adminUser.id,
      action: "unban_user",
      targetType: "user",
      targetId: userId,
      createdAt: new Date(),
    });

    return c.json({ data: user });
  } catch (err) {
    console.error("Failed to unban user:", err);
    return c.json({ error: "Failed to unban user" }, 500);
  }
});

// ── List all organizations (paginated, with search) ────────────────────────

app.get("/v1/admin/organizations", async (c) => {
  const db = createDb(c.env);
  const page = intParam(c.req.query("page"), 1, 1, Number.MAX_SAFE_INTEGER);
  const limit = intParam(c.req.query("limit"), 50, 1, 100);
  const search = c.req.query("search")?.trim();
  const offset = (page - 1) * limit;

  try {
    const searchCondition = search
      ? or(
          ilike(organizations.name, `%${search}%`),
          ilike(organizations.slug, `%${search}%`),
        )
      : undefined;

    const [orgs, countResult] = await Promise.all([
      db
        .select({
          id: organizations.id,
          name: organizations.name,
          slug: organizations.slug,
          logo: organizations.logo,
          createdAt: organizations.createdAt,
          plan: subscriptions.plan,
          subscriptionStatus: subscriptions.status,
          subscriptionEnvironment: subscriptions.environment,
          internal: sql<boolean>`(${internalOrganizations.organizationId} IS NOT NULL)`,
        })
        .from(organizations)
        .leftJoin(subscriptions, eq(subscriptions.organizationId, organizations.id))
        .leftJoin(internalOrganizations, eq(internalOrganizations.organizationId, organizations.id))
        .where(searchCondition)
        .orderBy(desc(organizations.createdAt))
        .limit(limit)
        .offset(offset),
      db
        .select({ total: count() })
        .from(organizations)
        .where(searchCondition),
    ]);

    const total = countResult[0]?.total ?? 0;

    return c.json({
      // plan stays null for orgs without a subscription row (the UI shows Free).
      data: orgs.map((o) => ({ ...o, plan: o.plan == null ? null : displayPlan(o.plan) })),
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  } catch (err) {
    console.error("Failed to list organizations:", err);
    return c.json({ error: "Failed to list organizations" }, 500);
  }
});

// ── Get org details + subscription + usage stats ───────────────────────────

app.get("/v1/admin/organizations/:id", async (c) => {
  const orgId = c.req.param("id");
  const db = createDb(c.env);

  try {
    const [orgRows, subResult, productCountResult, memberCountRows, overrideResult, apiHitsResult, internalRows] =
      await Promise.all([
        db
          .select({
            id: organizations.id,
            name: organizations.name,
            slug: organizations.slug,
            logo: organizations.logo,
            createdAt: organizations.createdAt,
          })
          .from(organizations)
          .where(eq(organizations.id, orgId))
          .limit(1),
        db
          .select()
          .from(subscriptions)
          .where(eq(subscriptions.organizationId, orgId))
          .limit(1),
        db
          .select({ count: count() })
          .from(products)
          .where(eq(products.organizationId, orgId)),
        db
          .select({ count: count() })
          .from(members)
          .where(eq(members.organizationId, orgId)),
        db
          .select()
          .from(organizationLimitOverrides)
          .where(eq(organizationLimitOverrides.organizationId, orgId))
          .limit(1),
        // Metered API calls this month: the same definition the quota cron and
        // the dashboard meter use (live api_usage_daily rows since the UTC
        // month start).
        db
          .select({ totalHits: sumApiCalls() })
          .from(apiUsageDaily)
          .where(
            and(
              eq(apiUsageDaily.organizationId, orgId),
              meteredApiCallsSince(utcMonthStart()),
            ),
          ),
        db
          .select({ note: internalOrganizations.note, createdAt: internalOrganizations.createdAt })
          .from(internalOrganizations)
          .where(eq(internalOrganizations.organizationId, orgId))
          .limit(1),
      ]);

    const org = orgRows[0];
    if (!org) {
      return c.json({ error: "Organization not found" }, 404);
    }

    // Fetch members with user details
    const memberRows = await db
      .select({
        id: members.id,
        role: members.role,
        userId: members.userId,
        name: users.name,
        email: users.email,
        image: users.image,
        createdAt: members.createdAt,
      })
      .from(members)
      .innerJoin(users, eq(users.id, members.userId))
      .where(eq(members.organizationId, orgId));

    const subRow = subResult[0] ?? null;
    const subscription = subRow
      ? { ...subRow, plan: displayPlan(subRow.plan) }
      : { plan: "free" as Plan, status: "active" };
    const override = overrideResult[0] ?? null;
    // Status-aware, deployment-aware caps (null = unlimited).
    const ent = resolveEntitlements(subRow, c.env, override);

    const usage = {
      products: productCountResult[0]?.count ?? 0,
      teamMembers: memberCountRows[0]?.count ?? 0,
      apiHitsThisMonth: Number(apiHitsResult[0]?.totalHits ?? 0) || 0,
    };

    const effectiveLimits = {
      maxProducts: ent.limits.products,
      maxApiHitsPerMonth: ent.limits.apiHitsPerMonth,
      maxTeamMembers: ent.limits.teamMembers,
    };

    return c.json({
      data: {
        ...org,
        members: memberRows,
        subscription,
        effectivePlan: ent.plan,
        selfHosted: ent.selfHosted,
        usage,
        effectiveLimits,
        override,
        // Set when the workspace is internal: left out of every admin metric.
        internal: internalRows[0] ?? null,
      },
    });
  } catch (err) {
    console.error("Failed to get organization:", err);
    return c.json({ error: "Failed to get organization details" }, 500);
  }
});

// ── Override limits for an org ──────────────────────────────────────────────

app.patch("/v1/admin/organizations/:id/limits", async (c) => {
  const orgId = c.req.param("id");
  const adminUser = c.get("user");
  const db = createDb(c.env);

  try {
    const body = await c.req.json();
    const { maxProducts, maxApiHitsPerMonth, maxTeamMembers, note } = body as {
      maxProducts?: number | null;
      maxApiHitsPerMonth?: number | null;
      maxTeamMembers?: number | null;
      note?: string;
    };

    // Each cap: omitted (undefined) = keep the current override, null = clear
    // it (fall back to the plan default, which is unlimited on Pro), or a
    // non-negative integer. Clearing matters now that Pro is unlimited: a stale
    // Free-sized override would otherwise keep capping an org after it upgrades.
    for (const v of [maxProducts, maxApiHitsPerMonth, maxTeamMembers]) {
      if (v !== undefined && v !== null && !(Number.isInteger(v) && v >= 0)) {
        return c.json({ error: "Limits must be non-negative integers or null." }, 400);
      }
    }
    if (note !== undefined && note !== null && typeof note !== "string") {
      return c.json({ error: "Note must be a string." }, 400);
    }
    const pick = (next: number | null | undefined, current: number | null) =>
      next === undefined ? current : next;

    // Verify org exists
    const orgCheck = await db
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .limit(1);
    if (orgCheck.length === 0) {
      return c.json({ error: "Organization not found" }, 404);
    }

    const now = new Date();

    // Upsert override
    const existing = await db
      .select()
      .from(organizationLimitOverrides)
      .where(eq(organizationLimitOverrides.organizationId, orgId))
      .limit(1);

    let result;
    if (existing.length > 0) {
      const current = existing[0]!;
      [result] = await db
        .update(organizationLimitOverrides)
        .set({
          maxProducts: pick(maxProducts, current.maxProducts),
          maxApiHitsPerMonth: pick(maxApiHitsPerMonth, current.maxApiHitsPerMonth),
          maxTeamMembers: pick(maxTeamMembers, current.maxTeamMembers),
          note: note ?? current.note,
          updatedAt: now,
        })
        .where(eq(organizationLimitOverrides.organizationId, orgId))
        .returning();
    } else {
      [result] = await db
        .insert(organizationLimitOverrides)
        .values({
          id: ulid(),
          organizationId: orgId,
          maxProducts: maxProducts ?? null,
          maxApiHitsPerMonth: maxApiHitsPerMonth ?? null,
          maxTeamMembers: maxTeamMembers ?? null,
          note: note ?? null,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
    }

    // Audit log
    await db.insert(adminAuditLog).values({
      id: ulid(),
      adminUserId: adminUser.id,
      action: "override_limits",
      targetType: "organization",
      targetId: orgId,
      details: { maxProducts, maxApiHitsPerMonth, maxTeamMembers, note },
      createdAt: now,
    });

    return c.json({ data: result });
  } catch (err) {
    console.error("Failed to override limits:", err);
    return c.json({ error: "Failed to override limits" }, 500);
  }
});

// ── List all subscriptions ──────────────────────────────────────────────────

app.get("/v1/admin/subscriptions", async (c) => {
  const db = createDb(c.env);
  const page = intParam(c.req.query("page"), 1, 1, Number.MAX_SAFE_INTEGER);
  const limit = intParam(c.req.query("limit"), 50, 1, 100);
  // Unknown values are ignored; 'business' is treated as 'pro'.
  const plan = normalizePlan(c.req.query("plan"));
  const offset = (page - 1) * limit;

  try {
    const conditions = [];
    if (plan === "pro") {
      // Legacy 'business' rows are Pro subscribers now.
      conditions.push(sql`${subscriptions.plan} IN ('pro', 'business')`);
    } else if (plan) {
      conditions.push(eq(subscriptions.plan, plan));
    }

    const where = conditions.length > 0 ? and(...conditions) : undefined;

    const [subs, totalResult] = await Promise.all([
      db
        .select()
        .from(subscriptions)
        .where(where)
        .orderBy(desc(subscriptions.createdAt))
        .limit(limit)
        .offset(offset),
      db.select({ count: count() }).from(subscriptions).where(where),
    ]);

    const total = totalResult[0]?.count ?? 0;

    return c.json({
      data: subs.map((s) => ({ ...s, plan: displayPlan(s.plan) })),
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  } catch (err) {
    console.error("Failed to list subscriptions:", err);
    return c.json({ error: "Failed to list subscriptions" }, 500);
  }
});

// ── Alerts: orgs approaching limits (>80% of any cap) ──────────────────────

app.get("/v1/admin/alerts", async (c) => {
  const db = createDb(c.env);

  try {
    // Fetch all organizations with their subscription (status-aware: a lapsed
    // Pro sub is alerted on Free caps, exactly as it is enforced).
    const orgsWithPlans = await db
      .select({
        id: organizations.id,
        name: organizations.name,
        slug: organizations.slug,
        plan: subscriptions.plan,
        status: subscriptions.status,
        currentPeriodEnd: subscriptions.currentPeriodEnd,
        environment: subscriptions.environment,
      })
      .from(organizations)
      .leftJoin(subscriptions, eq(subscriptions.organizationId, organizations.id));

    if (orgsWithPlans.length === 0) {
      return c.json({ data: [] });
    }

    // Batch-fetch usage data for all orgs
    const [productCounts, memberCounts, apiHitCounts, overrides] = await Promise.all([
      db
        .select({
          organizationId: products.organizationId,
          count: count(),
        })
        .from(products)
        .groupBy(products.organizationId),
      db
        .select({
          organizationId: members.organizationId,
          count: count(),
        })
        .from(members)
        .groupBy(members.organizationId),
      // Metered API calls this month: the same definition the quota cron uses
      // (live api_usage_daily rows since the UTC month start). Drives the
      // Free cap warning and the Pro fair-use (20M/month) alert.
      db
        .select({
          organizationId: apiUsageDaily.organizationId,
          totalHits: sumApiCalls(),
        })
        .from(apiUsageDaily)
        .where(meteredApiCallsSince(utcMonthStart()))
        .groupBy(apiUsageDaily.organizationId),
      db.select().from(organizationLimitOverrides),
    ]);

    // Build lookup maps
    const productMap = new Map(productCounts.map((r) => [r.organizationId, r.count]));
    const memberMap = new Map(
      memberCounts.map((r) => [r.organizationId, r.count]),
    );
    const apiHitMap = new Map(
      apiHitCounts.map((r) => [r.organizationId, Number(r.totalHits) || 0]),
    );
    const overrideMap = new Map(overrides.map((r) => [r.organizationId, r]));

    const alerts: Array<{
      organizationId: string;
      organizationName: string;
      organizationSlug: string;
      plan: Plan;
      warnings: LimitWarning[];
    }> = [];

    for (const org of orgsWithPlans) {
      const sub = org.plan
        ? { plan: org.plan, status: org.status ?? "", currentPeriodEnd: org.currentPeriodEnd, environment: org.environment }
        : null;
      const ent = resolveEntitlements(sub, c.env, overrideMap.get(org.id) ?? null);

      // Rules (unlimited caps, the "cap of 1" steady state, Pro fair use,
      // self-hosted) live in computeLimitWarnings, which is unit-tested.
      const warnings = computeLimitWarnings(ent, {
        products: productMap.get(org.id) ?? 0,
        apiHitsPerMonth: apiHitMap.get(org.id) ?? 0,
        teamMembers: memberMap.get(org.id) ?? 0,
      });

      if (warnings.length > 0) {
        alerts.push({
          organizationId: org.id,
          organizationName: org.name,
          organizationSlug: org.slug ?? "",
          plan: ent.plan,
          warnings,
        });
      }
    }

    // Sort by highest percentage first
    alerts.sort((a, b) => {
      const maxA = Math.max(...a.warnings.map((w) => w.percentage));
      const maxB = Math.max(...b.warnings.map((w) => w.percentage));
      return maxB - maxA;
    });

    return c.json({ data: alerts });
  } catch (err) {
    console.error("Failed to fetch alerts:", err);
    return c.json({ error: "Failed to fetch alerts" }, 500);
  }
});

// ── Platform-wide stats ────────────────────────────────────────────────────

// Live MRR and plan counts (lib/revenue.ts); re-exported for the admin tests.
export { summarizeSubscriptions };

app.get("/v1/admin/stats", async (c) => {
  const db = createDb(c.env);

  try {
    const [
      userCountRows,
      orgCountRows,
      subBreakdown,
      funnelThisMonth,
      totalRevenueSaved,
      activeOrgsRows,
      campaignStats,
      productCount,
      integrationBreakdown,
      internalCountRows,
    ] = await Promise.all([
      // Members of an internal workspace (the people running this deployment) don't count.
      db
        .select({ total: count() })
        .from(users)
        .where(
          sql`NOT EXISTS (SELECT 1 FROM ${members} INNER JOIN ${internalOrganizations} ON ${internalOrganizations.organizationId} = ${members.organizationId} WHERE ${members.userId} = ${users.id})`,
        ),
      db.select({ total: count() }).from(organizations).where(notInternal(organizations.id)),
      // Active subscriptions, with the mode and amount each one is billed at.
      db
        .select({
          plan: subscriptions.plan,
          environment: subscriptions.environment,
          recurringAmount: subscriptions.recurringAmount,
          currency: subscriptions.currency,
        })
        .from(subscriptions)
        .where(and(eq(subscriptions.status, "active"), notInternal(subscriptions.organizationId))),
      db
        .select({
          impressions: sumInt(analyticsRollups.impressions),
          clicks: sumInt(analyticsRollups.clicks),
          copies: sumInt(analyticsRollups.copies),
          redemptions: sumInt(analyticsRollups.redemptions),
          revenueSaved: sql<number>`COALESCE(SUM(${analyticsRollups.revenueSaved}), 0)`.mapWith(Number),
        })
        .from(analyticsRollups)
        .where(
          and(
            eq(analyticsRollups.period, "day"),
            eq(analyticsRollups.environment, "live"),
            notInternal(analyticsRollups.organizationId),
            sql`${analyticsRollups.periodStart} >= date_trunc('month', NOW())`,
          ),
        ),
      db
        .select({ total: sql<number>`COALESCE(SUM(${analyticsRollups.revenueSaved}), 0)`.mapWith(Number) })
        .from(analyticsRollups)
        .where(
          and(
            eq(analyticsRollups.period, "day"),
            eq(analyticsRollups.environment, "live"),
            notInternal(analyticsRollups.organizationId),
          ),
        ),
      db
        .select({ total: sql<number>`COUNT(DISTINCT ${analyticsRollups.organizationId})`.mapWith(Number) })
        .from(analyticsRollups)
        .where(
          and(
            eq(analyticsRollups.period, "day"),
            eq(analyticsRollups.environment, "live"),
            notInternal(analyticsRollups.organizationId),
            sql`${analyticsRollups.periodStart} >= NOW() - INTERVAL '30 days'`,
          ),
        ),
      db
        .select({
          total: count(),
          active: sql<number>`COUNT(*) FILTER (WHERE ${campaigns.status} = 'active')`.mapWith(Number),
        })
        .from(campaigns)
        .where(and(eq(campaigns.environment, "live"), notInternal(campaigns.organizationId))),
      db
        .select({ total: count() })
        .from(products)
        .where(and(eq(products.environment, "live"), notInternal(products.organizationId))),
      db
        .select({ provider: integrations.provider, count: count() })
        .from(integrations)
        .where(and(eq(integrations.status, "active"), notInternal(integrations.organizationId)))
        .groupBy(integrations.provider),
      db.select({ total: count() }).from(internalOrganizations),
    ]);

    // Live subscriptions only: a Dodo test-mode subscription grants Pro but
    // is not revenue. Legacy 'business' rows count as Pro.
    const { planCounts, testSubscriptions, mrrByCurrency, estimatedMRR } = summarizeSubscriptions(subBreakdown);

    const totalOrgs = orgCountRows[0]?.total ?? 0;
    planCounts.free = Math.max(0, totalOrgs - planCounts.pro);

    const funnel = funnelThisMonth[0] ?? { impressions: 0, clicks: 0, copies: 0, redemptions: 0, revenueSaved: 0 };
    const integrationCounts: Record<string, number> = {};
    for (const row of integrationBreakdown) {
      integrationCounts[row.provider] = row.count;
    }

    return c.json({
      data: {
        totalUsers: userCountRows[0]?.total ?? 0,
        totalOrganizations: totalOrgs,
        subscriptionsByPlan: planCounts,
        estimatedMRR,
        mrrByCurrency,
        testSubscriptions,
        activeOrgsLast30Days: (activeOrgsRows[0]?.total as number) ?? 0,
        platformFunnel: funnel,
        revenueSavedThisMonth: funnel.revenueSaved,
        totalRevenueSaved: (totalRevenueSaved[0]?.total as number) ?? 0,
        totalProducts: productCount[0]?.total ?? 0,
        totalCampaigns: campaignStats[0]?.total ?? 0,
        activeCampaigns: (campaignStats[0]?.active as number) ?? 0,
        integrationsByProvider: integrationCounts,
        // Left out of every figure above.
        internalOrganizations: internalCountRows[0]?.total ?? 0,
      },
    });
  } catch (err) {
    console.error("Failed to fetch stats:", err);
    return c.json({ error: "Failed to fetch platform stats" }, 500);
  }
});

// ── Top organizations by usage ─────────────────────────────────────────────

app.get("/v1/admin/stats/top-orgs", async (c) => {
  const db = createDb(c.env);
  const limit = intParam(c.req.query("limit"), 10, 1, 20);

  try {
    const rows = await db
      .select({
        organizationId: analyticsRollups.organizationId,
        name: organizations.name,
        slug: organizations.slug,
        impressions: sumInt(analyticsRollups.impressions),
        clicks: sumInt(analyticsRollups.clicks),
        redemptions: sumInt(analyticsRollups.redemptions),
        revenueSaved: sql<number>`COALESCE(SUM(${analyticsRollups.revenueSaved}), 0)`.mapWith(Number),
      })
      .from(analyticsRollups)
      .innerJoin(organizations, eq(organizations.id, analyticsRollups.organizationId))
      .where(
        and(
          eq(analyticsRollups.period, "day"),
          eq(analyticsRollups.environment, "live"),
          notInternal(analyticsRollups.organizationId),
          sql`${analyticsRollups.periodStart} >= date_trunc('month', NOW())`,
        ),
      )
      .groupBy(analyticsRollups.organizationId, organizations.name, organizations.slug)
      .orderBy(desc(sql`SUM(${analyticsRollups.impressions})`))
      .limit(limit);

    // Fetch plans for these orgs
    const orgIds = rows.map((r) => r.organizationId);
    const planRows = orgIds.length > 0
      ? await db
          .select({ organizationId: subscriptions.organizationId, plan: subscriptions.plan })
          .from(subscriptions)
          .where(and(
            inArray(subscriptions.organizationId, orgIds),
            eq(subscriptions.status, "active"),
            eq(subscriptions.environment, "live"),
          ))
      : [];

    const planMap: Record<string, Plan> = {};
    for (const row of planRows) {
      planMap[row.organizationId] = displayPlan(row.plan);
    }

    return c.json({
      data: rows.map((r) => ({
        ...r,
        plan: planMap[r.organizationId] ?? "free",
      })),
    });
  } catch (err) {
    console.error("Failed to fetch top orgs:", err);
    return c.json({ error: "Failed to fetch top organizations" }, 500);
  }
});

export default app;
