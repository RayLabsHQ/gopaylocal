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
 * flush promise to ctx.waitUntil. Counts are coalesced per isolate and
 * flushed from inside the waitUntil of the request that opened the window, so
 * the database I/O runs in that request's context (a Worker cannot use an I/O
 * object created by another request) and a window never outlives the 30 s
 * waitUntil budget.
 *
 * Two flush policies, picked per request from the `usage:` KV snapshot the
 * route already reads for the quota check:
 *
 *  - Limited organizations (a finite monthly cap, or no snapshot yet): flush
 *    at once (delay 0). While a write is in flight, further requests only
 *    increment memory; the same flush drains them when its write returns, so a
 *    burst costs ~2 statements, not one per request. Exact to within whatever
 *    is in memory when an isolate dies mid-write. The Free cap is 10,000 calls
 *    a month, so even one statement per request is at most ~10K writes per
 *    organization per month (plus up to one cron interval of overshoot).
 *  - Unlimited organizations (Pro, self-hosted): one statement per
 *    (organization, day, environment) per isolate per 15 s window, or sooner
 *    once 1,000 calls are buffered. 15 s keeps window + one retry backoff +
 *    the write well inside the 30 s waitUntil limit; the only consumers are the
 *    dashboard meter and the 20M/month fair-use alert, which tolerate the lag.
 *
 * A failed write puts its counts back in memory and holds every flush for 5 s
 * (no hot retry loop against a database that is down). Nothing here throws to
 * the caller: a metering fault never suppresses a banner.
 */

import { sql } from "drizzle-orm";
import type { Database } from "../db";
import { apiUsageDaily } from "../db/schema";
import { errorSummary } from "../lib/log";

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

interface Flush {
  /** Ends the window sleep early (not the failure backoff). */
  wake(): void;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class UsageMeter {
  private readonly pending = new Map<string, UsageRow>();
  private readonly flushing = new Map<string, Flush>();
  private retryAfter = 0;
  private options: UsageMeterOptions;

  constructor(options: Partial<UsageMeterOptions> = {}) {
    this.options = { ...DEFAULT_USAGE_METER_OPTIONS, ...options };
  }

  /** Test hook (integration tests set the unlimited window to 0). */
  configure(options: Partial<UsageMeterOptions>): void {
    this.options = { ...this.options, ...options };
  }

  /** Test hook: drop buffered counts and state. */
  reset(): void {
    this.pending.clear();
    this.flushing.clear();
    this.retryAfter = 0;
  }

  /** Buffered, not yet written calls (tests and diagnostics). */
  bufferedCount(): number {
    let total = 0;
    for (const row of this.pending.values()) total += row.count;
    return total;
  }

  /** Count one call. Synchronous; never throws on account of the database. */
  record(event: UsageRecord, hooks: UsageMeterHooks): void {
    const day = utcDay(event.now ?? new Date());
    const key = `${event.organizationId}\u0000${day}\u0000${event.environment}`;
    let row = this.pending.get(key);
    if (!row) {
      row = { organizationId: event.organizationId, day, environment: event.environment, count: 0 };
      this.pending.set(key, row);
    }
    row.count += 1;

    const urgent = event.limited || row.count >= this.options.unlimitedFlushThreshold;
    const running = this.flushing.get(key);
    if (running) {
      if (urgent) running.wake();
      return;
    }
    const delay = urgent ? 0 : this.options.unlimitedFlushDelayMs;
    hooks.waitUntil(this.flush(key, delay, hooks.write));
  }

  private async flush(key: string, delayMs: number, write: UsageMeterHooks["write"]): Promise<void> {
    const flush: Flush = { wake: () => {} };
    this.flushing.set(key, flush);
    try {
      if (delayMs > 0) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, delayMs);
          flush.wake = () => {
            clearTimeout(timer);
            resolve();
          };
        });
      }
      const backoff = this.retryAfter - Date.now();
      if (backoff > 0) await sleep(backoff);

      // Drain: counts recorded while a write was in flight go out next.
      for (;;) {
        const row = this.pending.get(key);
        if (!row || row.count <= 0) break;
        this.pending.delete(key);
        try {
          await write([row]);
        } catch (err) {
          this.requeue(key, row);
          this.retryAfter = Date.now() + this.options.failureBackoffMs;
          console.error("usage-meter: write failed; counts kept for the next flush", {
            organizationId: row.organizationId,
            day: row.day,
            environment: row.environment,
            count: row.count,
            error: errorSummary(err),
          });
          break;
        }
      }
    } catch (err) {
      console.error("usage-meter: flush failed", { error: errorSummary(err) });
    } finally {
      this.flushing.delete(key);
    }
  }

  private requeue(key: string, row: UsageRow): void {
    const current = this.pending.get(key);
    if (current) current.count += row.count;
    else this.pending.set(key, { ...row });
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
