/**
 * Counts kept in the isolate's memory and written to the database in batches,
 * off the response path. Used by the banner config endpoint for the two things
 * it counts per request: API calls (services/usage-meter.ts) and impressions
 * (services/impression-meter.ts).
 *
 * Rows are grouped. A group is written as one batch: one statement for all of
 * its rows. add() only updates memory and, when the group has no flush
 * running, hands a flush promise to ctx.waitUntil. The flush runs inside the
 * waitUntil of the request that started it, so the database I/O belongs to
 * that request (a Worker cannot use an I/O object created by another request)
 * and a window never outlives the 30 s waitUntil budget.
 *
 * Two flush speeds, chosen per add():
 *
 *  - urgent: flush at once (delay 0). While a write is in flight, further
 *    adds only increment memory; the same flush drains them when its write
 *    returns, so a burst costs about two statements, not one per request.
 *  - not urgent: one batch per group per isolate per `flushDelayMs` window,
 *    or sooner once `flushThreshold` counts are buffered for the group.
 *
 * A failed write puts its counts back in memory and holds every flush for
 * `failureBackoffMs` (no hot retry loop against a database that is down).
 * Nothing here throws to the caller.
 */

import { errorSummary } from "../lib/log";

export interface CountedRow {
  count: number;
}

export interface CountBufferOptions {
  /** Window for adds that are not urgent. */
  flushDelayMs: number;
  /** Buffered counts of one group that end its window early. */
  flushThreshold: number;
  /** Hold after a failed write before the next attempt. */
  failureBackoffMs: number;
}

export interface CountBufferHooks<Row> {
  /** ctx.waitUntil of the current request. */
  waitUntil(promise: Promise<unknown>): void;
  /** Persist one group's rows; called inside the promise handed to waitUntil. */
  write(rows: Row[]): Promise<void>;
}

export interface CountBufferAdd<Row> {
  /** Rows of one group are written together. */
  group: string;
  /** Identifies the row inside its group. */
  rowKey: string;
  /** The row with `count: 0`, built the first time `rowKey` is seen. */
  create(): Row;
  urgent: boolean;
}

interface Batch<Row> {
  rows: Map<string, Row>;
  total: number;
}

interface Flush {
  /** Ends the window sleep early (not the failure backoff). */
  wake(): void;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class CountBuffer<Row extends CountedRow> {
  private readonly pending = new Map<string, Batch<Row>>();
  private readonly flushing = new Map<string, Flush>();
  private retryAfter = 0;
  private readonly label: string;
  private options: CountBufferOptions;
  private readonly describe: (rows: Row[]) => Record<string, unknown>;

  /**
   * `label` starts every log line; `describe` adds fields that identify a
   * failed batch (the counts and the error are added here).
   */
  constructor(label: string, options: CountBufferOptions, describe: (rows: Row[]) => Record<string, unknown>) {
    this.label = label;
    this.options = options;
    this.describe = describe;
  }

  configure(options: Partial<CountBufferOptions>): void {
    this.options = { ...this.options, ...options };
  }

  /** Drop buffered counts and state. */
  reset(): void {
    this.pending.clear();
    this.flushing.clear();
    this.retryAfter = 0;
  }

  /** Buffered, not yet written counts. */
  bufferedCount(): number {
    let total = 0;
    for (const batch of this.pending.values()) total += batch.total;
    return total;
  }

  /** Count one. Synchronous; never throws on account of the database. */
  add(entry: CountBufferAdd<Row>, hooks: CountBufferHooks<Row>): void {
    let batch = this.pending.get(entry.group);
    if (!batch) {
      batch = { rows: new Map(), total: 0 };
      this.pending.set(entry.group, batch);
    }
    let row = batch.rows.get(entry.rowKey);
    if (!row) {
      row = entry.create();
      batch.rows.set(entry.rowKey, row);
    }
    row.count += 1;
    batch.total += 1;

    const urgent = entry.urgent || batch.total >= this.options.flushThreshold;
    const running = this.flushing.get(entry.group);
    if (running) {
      if (urgent) running.wake();
      return;
    }
    const delay = urgent ? 0 : this.options.flushDelayMs;
    hooks.waitUntil(this.flush(entry.group, delay, hooks.write));
  }

  private async flush(group: string, delayMs: number, write: CountBufferHooks<Row>["write"]): Promise<void> {
    const flush: Flush = { wake: () => {} };
    this.flushing.set(group, flush);
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

      // Drain: counts added while a write was in flight go out next.
      for (;;) {
        const batch = this.pending.get(group);
        if (!batch || batch.total <= 0) break;
        this.pending.delete(group);
        const rows = [...batch.rows.values()];
        try {
          await write(rows);
        } catch (err) {
          this.requeue(group, batch);
          this.retryAfter = Date.now() + this.options.failureBackoffMs;
          console.error(`${this.label}: write failed; counts kept for the next flush`, {
            ...this.describe(rows),
            count: batch.total,
            error: errorSummary(err),
          });
          break;
        }
      }
    } catch (err) {
      console.error(`${this.label}: flush failed`, { error: errorSummary(err) });
    } finally {
      this.flushing.delete(group);
    }
  }

  /**
   * Put a failed batch back, added to whatever arrived meanwhile. Rows are
   * copied: a row handed to write() is never changed afterwards.
   */
  private requeue(group: string, failed: Batch<Row>): void {
    let current = this.pending.get(group);
    if (!current) {
      current = { rows: new Map(), total: 0 };
      this.pending.set(group, current);
    }
    for (const [rowKey, row] of failed.rows) {
      const existing = current.rows.get(rowKey);
      if (existing) existing.count += row.count;
      else current.rows.set(rowKey, { ...row });
    }
    current.total += failed.total;
  }
}
