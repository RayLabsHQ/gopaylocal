/**
 * Server-side API-call metering for the banner config endpoint.
 *
 * Every banner config request that carries a valid public key and reaches
 * campaign resolution adds 1 to `api_usage_daily` (organization, UTC day,
 * environment). The usage cron sums the live rows for the plan quota, and the
 * dashboard meter and admin alerts read the same rows (lib/limits.ts
 * meteredApiCallsSince).
 *
 * Writes never touch the response: record() only updates memory and hands a
 * flush promise to ctx.waitUntil (services/count-buffer.ts has the mechanics:
 * coalescing per isolate, the flush inside the waitUntil of the request that
 * opened the window, and the hold after a failed write).
 *
 * Two flush policies, picked per request from the `usage:` KV snapshot the
 * route already reads for the quota check:
 *
 *  - Limited organizations (a finite monthly cap, or no snapshot yet): flush
 *    at once. Exact to within whatever is in memory when an isolate dies
 *    mid-write. The Free cap is 10,000 calls a month, so even one statement per
 *    request is at most ~10K writes per organization per month (plus up to one
 *    cron interval of overshoot).
 *  - Unlimited organizations (Pro, self-hosted): one statement per
 *    (organization, day, environment) per isolate per 15 s window, or sooner
 *    once 1,000 calls are buffered. 15 s keeps window + one retry backoff +
 *    the write well inside the 30 s waitUntil limit; the only consumers are the
 *    dashboard meter and the 20M/month fair-use alert, which tolerate the lag.
 *
 * Nothing here throws to the caller: a metering fault never suppresses a
 * banner.
 */

import { sql } from "drizzle-orm";
import type { Database } from "../db";
import { apiUsageDaily } from "../db/schema";
import { CountBuffer } from "./count-buffer";

export type UsageEnvironment = "live" | "test";

export interface UsageRow {
  organizationId: string;
  /** UTC calendar day, YYYY-MM-DD. */
  day: string;
  environment: UsageEnvironment;
  count: number;
}

export interface UsageMeterOptions {
  /** Window for unlimited organizations. */
  unlimitedFlushDelayMs: number;
  /** Buffered calls that end an unlimited window early. */
  unlimitedFlushThreshold: number;
  /** Hold after a failed write before the next attempt. */
  failureBackoffMs: number;
}

export const DEFAULT_USAGE_METER_OPTIONS: UsageMeterOptions = {
  unlimitedFlushDelayMs: 15_000,
  unlimitedFlushThreshold: 1_000,
  failureBackoffMs: 5_000,
};

export interface UsageMeterHooks {
  /** ctx.waitUntil of the current request. */
  waitUntil(promise: Promise<unknown>): void;
  /** Persist rows; called inside the promise handed to waitUntil. */
  write(rows: UsageRow[]): Promise<void>;
}

export interface UsageRecord {
  organizationId: string;
  environment: UsageEnvironment;
  /** The organization has a finite cap (or its cap is not known yet). */
  limited: boolean;
  now?: Date;
}

/** YYYY-MM-DD of `now` in UTC. */
export function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

export class UsageMeter {
  private readonly buffer: CountBuffer<UsageRow>;

  constructor(options: Partial<UsageMeterOptions> = {}) {
    const o = { ...DEFAULT_USAGE_METER_OPTIONS, ...options };
    this.buffer = new CountBuffer<UsageRow>(
      "usage-meter",
      {
        flushDelayMs: o.unlimitedFlushDelayMs,
        flushThreshold: o.unlimitedFlushThreshold,
        failureBackoffMs: o.failureBackoffMs,
      },
      // One row per batch (the group is the row's own key).
      ([row]) => ({ organizationId: row?.organizationId, day: row?.day, environment: row?.environment }),
    );
  }

  /** Test hook (integration tests set the unlimited window to 0). */
  configure(options: Partial<UsageMeterOptions>): void {
    this.buffer.configure({
      ...(options.unlimitedFlushDelayMs !== undefined && { flushDelayMs: options.unlimitedFlushDelayMs }),
      ...(options.unlimitedFlushThreshold !== undefined && { flushThreshold: options.unlimitedFlushThreshold }),
      ...(options.failureBackoffMs !== undefined && { failureBackoffMs: options.failureBackoffMs }),
    });
  }

  /** Test hook: drop buffered counts and state. */
  reset(): void {
    this.buffer.reset();
  }

  /** Buffered, not yet written calls (tests and diagnostics). */
  bufferedCount(): number {
    return this.buffer.bufferedCount();
  }

  /** Count one call. Synchronous; never throws on account of the database. */
  record(event: UsageRecord, hooks: UsageMeterHooks): void {
    const day = utcDay(event.now ?? new Date());
    const key = `${event.organizationId}\u0000${day}\u0000${event.environment}`;
    this.buffer.add(
      {
        group: key,
        rowKey: key,
        create: () => ({ organizationId: event.organizationId, day, environment: event.environment, count: 0 }),
        urgent: event.limited,
      },
      hooks,
    );
  }
}

/** The isolate-wide meter the banner route uses. */
export const usageMeter = new UsageMeter();

/**
 * Add rows to api_usage_daily. One statement; rows must have distinct
 * (organization, day, environment) keys (the meter guarantees it). The SET
 * value adds the incoming count to the stored one.
 */
export function buildUsageUpsert(db: Pick<Database, "insert">, rows: UsageRow[]) {
  return db
    .insert(apiUsageDaily)
    .values(
      rows.map((r) => ({
        organizationId: r.organizationId,
        day: r.day,
        environment: r.environment,
        count: r.count,
      })),
    )
    .onConflictDoUpdate({
      target: [apiUsageDaily.organizationId, apiUsageDaily.day, apiUsageDaily.environment],
      set: { count: sql`${apiUsageDaily.count} + excluded."count"` },
    });
}

export async function writeUsageRows(db: Pick<Database, "insert">, rows: UsageRow[]): Promise<void> {
  if (rows.length === 0) return;
  await buildUsageUpsert(db, rows);
}
