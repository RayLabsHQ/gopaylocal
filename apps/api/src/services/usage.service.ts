// ── API-call usage (monthly quota) ──────────────────────────────────────────
// Enforces the apiHitsPerMonth cap (Free: 10K live API calls/month; Pro and
// self-hosted: unlimited) on the banner hot path without a database read per
// request.
//
// What is counted: banner config requests that carry a valid public key and
// reach campaign resolution, metered server-side into api_usage_daily by the
// banner endpoint (services/usage-meter.ts). Browser-reported impressions feed
// analytics only; they no longer drive the quota (anyone holding a public key
// could post them, or not post them).
//
// Design: a cron (see index.ts `scheduled`) sums each org's month-to-date LIVE
// calls from api_usage_daily and writes a small per-org snapshot to KV under
// `usage:{orgId}:{YYYYMM}`. The banner endpoint reads that snapshot (one cheap
// KV read it already does) and stops serving when `over` is set. Enforcement
// lags by up to the cron interval, which is fine for a billing cap. The month
// is in the key, so usage resets each month. Unlimited orgs get
// `limit: null, over: false` (null, not Infinity, so it survives JSON).

import { sql } from "drizzle-orm";
import { hasReachedLimit } from "@gopaylocal/shared";
import type { Limit } from "@gopaylocal/shared";
import {
  apiUsageDaily,
  subscriptions,
  organizationLimitOverrides,
} from "../db/schema";
import type { Database } from "../db";
import { isSelfHosted, resolveEntitlements, type DeploymentEnv } from "../lib/entitlements";
import { meteredApiCallsSince, utcMonthStart } from "../lib/limits";
import { errorSummary } from "../lib/log";
import { pushBannerConfigForOrg } from "./banner-cache.service";

export interface UsageSnapshot {
  count: number;
  /** null = unlimited. */
  limit: Limit;
  over: boolean;
  updatedAt: string;
}

/** `YYYYMM` for the given instant, in UTC (the Workers runtime timezone). */
function monthStamp(now: Date): string {
  return `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** KV key holding an org's month-to-date usage snapshot. */
export function usageKey(orgId: string, now: Date = new Date()): string {
  return `usage:${orgId}:${monthStamp(now)}`;
}

/** What the banner endpoint needs from the usage snapshot. */
export interface QuotaState {
  /** Stop serving: the org is over its monthly cap. */
  over: boolean;
  /**
   * The org has a finite cap, or its cap is not known yet (no snapshot this
   * month, unreadable snapshot). Decides how exactly usage is metered.
   */
  limited: boolean;
}

/**
 * Hot-path read used by the banner endpoint. Fails OPEN on `over`: a
 * metering/KV hiccup must never suppress a customer's banner (the quota is a
 * billing cap, not a security control). Self-hosted deployments are never
 * over quota and never limited, without a KV read, whatever a snapshot says.
 */
export async function getQuotaState(
  kv: KVNamespace,
  orgId: string,
  env: DeploymentEnv | null | undefined,
): Promise<QuotaState> {
  if (isSelfHosted(env)) return { over: false, limited: false };
  try {
    const raw = await kv.get(usageKey(orgId));
    if (!raw) return { over: false, limited: true };
    const snapshot = JSON.parse(raw) as Partial<UsageSnapshot>;
    return { over: snapshot.over === true, limited: snapshot.limit !== null };
  } catch {
    return { over: false, limited: true };
  }
}

/** Is this org over its monthly cap? (getQuotaState(...).over) */
export async function isOverQuota(
  kv: KVNamespace,
  orgId: string,
  env?: DeploymentEnv | null,
): Promise<boolean> {
  return (await getQuotaState(kv, orgId, env)).over;
}

/**
 * Cron job: recompute month-to-date usage for every org with live API calls
 * this month and write the snapshot to KV. Pass the Worker `env` so
 * self-hosted deployments resolve as unlimited; the banner endpoint also skips
 * the quota check when self-hosted, so a missing env can't block banners.
 */
export async function recomputeUsageForAllOrgs(
  db: Database,
  kv: KVNamespace,
  env?: DeploymentEnv | null,
): Promise<void> {
  const now = new Date();
  const monthStart = utcMonthStart(now);

  const [usageRows, subs, overrides] = await Promise.all([
    db
      .select({
        organizationId: apiUsageDaily.organizationId,
        calls: sql<number>`COALESCE(SUM(${apiUsageDaily.count}), 0)`,
      })
      .from(apiUsageDaily)
      .where(meteredApiCallsSince(monthStart))
      .groupBy(apiUsageDaily.organizationId),
    db
      .select({
        organizationId: subscriptions.organizationId,
        plan: subscriptions.plan,
        status: subscriptions.status,
        currentPeriodEnd: subscriptions.currentPeriodEnd,
      })
      .from(subscriptions),
    db
      .select({
        organizationId: organizationLimitOverrides.organizationId,
        maxApiHitsPerMonth: organizationLimitOverrides.maxApiHitsPerMonth,
      })
      .from(organizationLimitOverrides),
  ]);

  const subByOrg = new Map(subs.map((s) => [s.organizationId, s]));
  const overrideByOrg = new Map(
    overrides.map((o) => [o.organizationId, o.maxApiHitsPerMonth]),
  );

  // ~45-day TTL so a prior month's snapshot self-expires after rollover.
  const expirationTtl = 45 * 24 * 60 * 60;
  // pushBannerConfigForOrg needs an env; a missing one means hosted.
  const deployment: DeploymentEnv = env ?? {};

  await Promise.all(
    usageRows.map(async (row) => {
      const ent = resolveEntitlements(
        subByOrg.get(row.organizationId) ?? null,
        env,
        { maxApiHitsPerMonth: overrideByOrg.get(row.organizationId) ?? null },
      );
      const limit = ent.limits.apiHitsPerMonth;
      const count = Number(row.calls) || 0;

      const snapshot: UsageSnapshot = {
        count,
        limit,
        over: hasReachedLimit(count, limit),
        updatedAt: now.toISOString(),
      };

      await kv.put(usageKey(row.organizationId, now), JSON.stringify(snapshot), {
        expirationTtl,
      });

      // Reconcile plan-derived banner branding. The banner document only
      // rebuilds on dashboard edits and on the upgrade webhook, so a downgrade
      // at subscription period-end (no Dodo event fires then) has no rebuild
      // trigger of its own. Here it is bounded to one cron interval for orgs
      // with live traffic, the only orgs whose stale branding anyone would
      // see. A tiny per-org marker tracks the last-applied branding bit so we
      // rebuild ONLY when it diverges, and it is written only after a
      // successful rebuild, so a failed one is retried on the next run.
      const marker = ent.showBranding ? "1" : "0";
      const markerKey = `branding:${row.organizationId}`;
      const prevMarker = await kv.get(markerKey).catch(() => null);
      if (prevMarker !== marker) {
        const rebuilt = await pushBannerConfigForOrg(db, kv, row.organizationId, deployment).then(
          () => true,
          (err: unknown) => {
            console.error("usage: branding rebuild failed; retrying next run", {
              orgId: row.organizationId,
              error: errorSummary(err),
            });
            return false;
          },
        );
        if (rebuilt) await kv.put(markerKey, marker, { expirationTtl }).catch(() => {});
      }
    }),
  );
}
