// ── Daily clean-up of old data ───────────────────────────────────────────────
// Runs once a day from the */10 cron (index.ts), in the run scheduled at
// 03:00 UTC. It is not on the daily VPN cron on purpose: that run needs more
// CPU than Workers Free allows and never finishes there, and this job must
// run on every plan. Everything here is database I/O.
//
// What it deletes:
//  - Hosted only: analytics_rollups and api_usage_daily older than
//    ANALYTICS_STORAGE_MONTHS. The privacy policy promises this. A self-hosted
//    deployment keeps both forever (its analytics retention is unlimited).
//  - Everywhere: session rows that expired more than a day ago. A session row
//    holds the IP address and user agent of the sign-in; an expired one can no
//    longer be used, so nothing reads it.
//
// Every statement is "older than a cut-off", so a skipped or failed run is
// made up by the next one.

import { lt } from "drizzle-orm";
import { ANALYTICS_STORAGE_MONTHS } from "@gopaylocal/shared";
import type { Database } from "../db";
import { analyticsRollups, apiUsageDaily, sessions } from "../db/schema";
import { isSelfHosted, type DeploymentEnv } from "../lib/entitlements";

// The run of the */10 cron that also does the clean-up: the one scheduled at
// 03:00 UTC.
export const RETENTION_HOUR_UTC = 3;
/** Expired sessions are kept this long, so clock differences cannot matter. */
export const EXPIRED_SESSION_GRACE_MS = 24 * 3600 * 1000;

export function isRetentionRun(scheduledTime: number): boolean {
  const at = new Date(scheduledTime);
  return at.getUTCHours() === RETENTION_HOUR_UTC && at.getUTCMinutes() < 10;
}

/**
 * Start of the UTC day ANALYTICS_STORAGE_MONTHS before `now`. Data from before
 * it is deleted. When that day does not exist (29 February), the next day is
 * used, so nothing younger than the limit is ever deleted.
 */
export function analyticsCutoff(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - ANALYTICS_STORAGE_MONTHS, now.getUTCDate()));
}

export interface RetentionResult {
  /** Null when the deployment keeps analytics forever (self-hosted). */
  analyticsRollups: number | null;
  apiUsageDaily: number | null;
  sessions: number;
}

export async function runRetention(
  db: Database,
  env: DeploymentEnv | null | undefined,
  now: Date = new Date(),
): Promise<RetentionResult> {
  const result: RetentionResult = { analyticsRollups: null, apiUsageDaily: null, sessions: 0 };

  if (!isSelfHosted(env)) {
    const cutoff = analyticsCutoff(now);
    const rollups = await db
      .delete(analyticsRollups)
      .where(lt(analyticsRollups.periodStart, cutoff))
      .returning({ id: analyticsRollups.id });
    result.analyticsRollups = rollups.length;

    // `day` is a date column read as 'YYYY-MM-DD'.
    const usage = await db
      .delete(apiUsageDaily)
      .where(lt(apiUsageDaily.day, cutoff.toISOString().slice(0, 10)))
      .returning({ day: apiUsageDaily.day });
    result.apiUsageDaily = usage.length;
  }

  const expired = await db
    .delete(sessions)
    .where(lt(sessions.expiresAt, new Date(now.getTime() - EXPIRED_SESSION_GRACE_MS)))
    .returning({ id: sessions.id });
  result.sessions = expired.length;

  if (result.analyticsRollups || result.apiUsageDaily || result.sessions) {
    console.log("retention: deleted old rows", result);
  }
  return result;
}
