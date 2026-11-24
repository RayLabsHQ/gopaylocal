import { and, eq, gte, sql } from "drizzle-orm";
import {
  LIMIT_ALERT_THRESHOLD,
  PRO_FAIR_USE_API_HITS_PER_MONTH,
  limitUsageRatio,
} from "@gopaylocal/shared";
import type { Limit, Plan } from "@gopaylocal/shared";
import {
  subscriptions,
  products,
  members,
  invitations,
  apiUsageDaily,
  organizationLimitOverrides,
} from "../db/schema";
import type { Database } from "../db";
import { resolveEntitlements, type DeploymentEnv, type Entitlements } from "./entitlements";

// All caps below use `null` for unlimited (see the shared `Limit` type).
//
// Every function that resolves limits takes an optional trailing `env`. It
// decides self-hosted mode (SELF_HOSTED="true" means unlimited for everyone).
// Omitting it means hosted behavior, so callers MUST pass the Worker env
// (`c.env`) for self-hosted deployments to get unlimited caps.

export interface ProductLimitInfo {
  plan: Plan;
  /** Effective product cap; null = unlimited. Safe to serialize. */
  maxProducts: Limit;
  currentCount: number;
  /**
   * Headroom for in-process arithmetic only: `Infinity` when unlimited, so
   * gates like `remaining <= 0` and `imported >= remaining` stay correct
   * without null checks. Do NOT put this field in a JSON response (Infinity
   * serializes to null); use remainingUnder(maxProducts, currentCount).
   */
  remaining: number;
}

export interface UsageMeter {
  current: number;
  /** null = unlimited. */
  max: Limit;
}

export interface UsageSummary {
  plan: Plan;
  selfHosted: boolean;
  billingEnabled: boolean;
  products: UsageMeter;
  apiHits: UsageMeter;
  teamMembers: UsageMeter;
}

/** UTC start of the calendar month containing `now`: the API-hit metering window. */
export function utcMonthStart(now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/**
 * WHERE clause selecting metered API calls: LIVE rows of api_usage_daily on or
 * after the UTC day of `since`. The single definition shared by the quota
 * cron, the dashboard meter and admin alerts, so all three count the same
 * thing. Rows are written server-side by the banner config endpoint
 * (services/usage-meter.ts); browser-reported impressions are not involved.
 */
export function meteredApiCallsSince(since: Date) {
  return and(
    eq(apiUsageDaily.environment, "live"),
    gte(apiUsageDaily.day, since.toISOString().slice(0, 10)),
  );
}

/** SUM of api_usage_daily.count as a number (Postgres returns bigint as a string). */
export const sumApiCalls = () =>
  sql<number>`COALESCE(SUM(${apiUsageDaily.count}), 0)`.mapWith(Number);

function subscriptionForOrg(db: Database, orgId: string) {
  return db
    .select({
      plan: subscriptions.plan,
      status: subscriptions.status,
      currentPeriodEnd: subscriptions.currentPeriodEnd,
      environment: subscriptions.environment,
    })
    .from(subscriptions)
    .where(eq(subscriptions.organizationId, orgId))
    .limit(1)
    .then((rows) => rows[0] ?? null);
}

export async function getProductLimitInfo(
  db: Database,
  orgId: string,
  env?: DeploymentEnv | null,
): Promise<ProductLimitInfo> {
  // Fetch plan, product count, and overrides in parallel
  const [sub, productRows, overrideResult] = await Promise.all([
    subscriptionForOrg(db, orgId),
    db
      .select({ id: products.id })
      .from(products)
      .where(eq(products.organizationId, orgId)),
    db
      .select({ maxProducts: organizationLimitOverrides.maxProducts })
      .from(organizationLimitOverrides)
      .where(eq(organizationLimitOverrides.organizationId, orgId))
      .limit(1),
  ]);

  // Status-aware: a canceled/expired/past-due sub no longer grants paid caps.
  const ent = resolveEntitlements(sub, env, overrideResult[0] ?? null);
  const currentCount = productRows.length;
  const maxProducts = ent.limits.products;
  const remaining =
    maxProducts === null ? Number.POSITIVE_INFINITY : Math.max(0, maxProducts - currentCount);

  return { plan: ent.plan, maxProducts, currentCount, remaining };
}

/**
 * Full usage snapshot for the org's three metered resources (products, monthly
 * API hits, team seats), each with its effective cap (null = unlimited). Powers
 * the dashboard billing meters. Caps come from resolveEntitlements: self-hosted
 * is unlimited, otherwise per-org overrides win over the plan's limits.
 * `apiHits.current` is month-to-date LIVE API calls computed fresh from
 * api_usage_daily (the same definition the quota cron meters, so the meter
 * matches what's enforced). `teamMembers.current` counts accepted members
 * PLUS pending invitations, the same "seats consumed" accounting the invite-cap
 * guard (auth.ts beforeCreateInvitation) and the Team settings tab use.
 */
export async function getUsageSummary(
  db: Database,
  orgId: string,
  env?: DeploymentEnv | null,
): Promise<UsageSummary> {
  const monthStart = utcMonthStart();

  const [sub, productRows, memberRows, pendingInviteRows, hitsResult, overrideResult] =
    await Promise.all([
      subscriptionForOrg(db, orgId),
      db
        .select({ id: products.id })
        .from(products)
        .where(eq(products.organizationId, orgId)),
      db
        .select({ id: members.id })
        .from(members)
        .where(eq(members.organizationId, orgId)),
      db
        .select({ id: invitations.id })
        .from(invitations)
        .where(
          and(
            eq(invitations.organizationId, orgId),
            eq(invitations.status, "pending"),
          ),
        ),
      db
        .select({ calls: sumApiCalls() })
        .from(apiUsageDaily)
        .where(
          and(
            eq(apiUsageDaily.organizationId, orgId),
            meteredApiCallsSince(monthStart),
          ),
        ),
      db
        .select({
          maxProducts: organizationLimitOverrides.maxProducts,
          maxApiHitsPerMonth: organizationLimitOverrides.maxApiHitsPerMonth,
          maxTeamMembers: organizationLimitOverrides.maxTeamMembers,
        })
        .from(organizationLimitOverrides)
        .where(eq(organizationLimitOverrides.organizationId, orgId))
        .limit(1),
    ]);

  const ent = resolveEntitlements(sub, env, overrideResult[0] ?? null);
  const apiHits = Number(hitsResult[0]?.calls ?? 0) || 0;

  return {
    plan: ent.plan,
    selfHosted: ent.selfHosted,
    billingEnabled: ent.billingEnabled,
    products: { current: productRows.length, max: ent.limits.products },
    apiHits: { current: apiHits, max: ent.limits.apiHitsPerMonth },
    teamMembers: {
      current: memberRows.length + pendingInviteRows.length,
      max: ent.limits.teamMembers,
    },
  };
}

/**
 * Lookback used by the analytics clamp when retention is unlimited
 * (self-hosted). Large enough to be "everything", small enough that
 * `Date.now() - days * 86_400_000` is still a valid Date for Postgres.
 */
export const UNLIMITED_RETENTION_LOOKBACK_DAYS = 36_500;

/**
 * The analytics retention window (in days) the org may read. Used to clamp
 * analytics queries so Free can't read history beyond its tier. Always a
 * finite number: unlimited retention (self-hosted) maps to
 * UNLIMITED_RETENTION_LOOKBACK_DAYS so the callers' date math stays valid.
 */
export async function getOrgRetentionDays(
  db: Database,
  orgId: string,
  env?: DeploymentEnv | null,
): Promise<number> {
  const sub = await subscriptionForOrg(db, orgId);
  const days = resolveEntitlements(sub, env).limits.analyticsRetentionDays;
  return days ?? UNLIMITED_RETENTION_LOOKBACK_DAYS;
}

// ── Admin usage alerts ──────────────────────────────────────────────────────

export interface LimitWarning {
  metric: "products" | "apiHitsPerMonth" | "teamMembers";
  /** "cap": approaching an enforced cap. "fair_use": unlimited Pro past the fair-use line. */
  kind: "cap" | "fair_use";
  current: number;
  /** The cap (or, for fair_use, the fair-use line). Always finite. */
  limit: number;
  percentage: number;
}

export interface OrgUsageCounts {
  products: number;
  apiHitsPerMonth: number;
  teamMembers: number;
}

/**
 * Admin alert rules for one org. Pure, so it is unit-tested directly.
 *
 * - Unlimited caps never produce a ratio (no division by an unlimited cap).
 * - Structural caps (products, seats) only alert when the cap is > 1: a cap of
 *   1 sitting at 1/1 is the Free plan's steady state, not an emergency.
 * - API hits alert at LIMIT_ALERT_THRESHOLD of any finite cap > 0.
 * - Fair use: a hosted org with unlimited API hits (Pro) that exceeds
 *   PRO_FAIR_USE_API_HITS_PER_MONTH is flagged. Alert only, never enforced.
 * - Self-hosted deployments produce no alerts: nothing is capped and fair use
 *   is a hosted billing policy.
 */
export function computeLimitWarnings(
  ent: Pick<Entitlements, "limits" | "selfHosted">,
  usage: OrgUsageCounts,
): LimitWarning[] {
  if (ent.selfHosted) return [];

  const warnings: LimitWarning[] = [];

  const capWarning = (
    metric: LimitWarning["metric"],
    current: number,
    limit: Limit,
    minCap: number,
  ) => {
    if (limit === null || limit <= minCap) return;
    const ratio = limitUsageRatio(current, limit);
    if (ratio !== null && ratio >= LIMIT_ALERT_THRESHOLD) {
      warnings.push({
        metric,
        kind: "cap",
        current,
        limit,
        percentage: Math.round(ratio * 100),
      });
    }
  };

  capWarning("products", usage.products, ent.limits.products, 1);

  if (ent.limits.apiHitsPerMonth === null) {
    if (usage.apiHitsPerMonth > PRO_FAIR_USE_API_HITS_PER_MONTH) {
      warnings.push({
        metric: "apiHitsPerMonth",
        kind: "fair_use",
        current: usage.apiHitsPerMonth,
        limit: PRO_FAIR_USE_API_HITS_PER_MONTH,
        percentage: Math.round(
          (usage.apiHitsPerMonth / PRO_FAIR_USE_API_HITS_PER_MONTH) * 100,
        ),
      });
    }
  } else {
    capWarning("apiHitsPerMonth", usage.apiHitsPerMonth, ent.limits.apiHitsPerMonth, 0);
  }

  capWarning("teamMembers", usage.teamMembers, ent.limits.teamMembers, 1);

  return warnings;
}
