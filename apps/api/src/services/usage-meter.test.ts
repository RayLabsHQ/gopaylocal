import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createSqlRecorder } from "../lib/sql-recorder-test-helpers";
import { UsageMeter, buildUsageUpsert, utcDay, writeUsageRows, type UsageRow } from "./usage-meter";

/** Collects waitUntil promises and written rows; `failNext` makes writes reject. */
function harness() {
  const pending: Promise<unknown>[] = [];
  const writes: UsageRow[][] = [];
  const state = { failNext: 0, delayMs: 0 };
  const hooks = {
    waitUntil: (p: Promise<unknown>) => {
      pending.push(p);
    },
    write: async (rows: UsageRow[]) => {
      // Snapshot: the meter must not mutate a row after handing it over.
      const copy = rows.map((r) => ({ ...r }));
      if (state.delayMs) await new Promise((r) => setTimeout(r, state.delayMs));
      if (state.failNext > 0) {
        state.failNext--;
        throw new Error("db down");
      }
      writes.push(copy);
    },
  };
  const settle = async () => {
    while (pending.length) await Promise.all(pending.splice(0));
  };
  const total = () => writes.flat().reduce((n, r) => n + r.count, 0);
  return { hooks, writes, state, settle, total, pending };
}

const NOW = new Date("2026-11-18T10:00:00Z");
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("UsageMeter: limited organizations (finite cap)", () => {
  it("writes the first call at once, as one row keyed by org, UTC day and environment", async () => {
    const meter = new UsageMeter();
    const h = harness();
    meter.record({ organizationId: "org_free", environment: "live", limited: true, now: NOW }, h.hooks);
    await h.settle();
    expect(h.writes).toEqual([[{ organizationId: "org_free", day: "2026-11-18", environment: "live", count: 1 }]]);
  });

  it("coalesces calls that arrive while a write is in flight, and loses none", async () => {
    const meter = new UsageMeter();
    const h = harness();
    h.state.delayMs = 5;
    for (let i = 0; i < 50; i++) {
      meter.record({ organizationId: "org_free", environment: "live", limited: true, now: NOW }, h.hooks);
    }
    await h.settle();
    expect(h.total()).toBe(50);
    // One flush in flight per key: the first call, then the 49 that queued behind it.
    expect(h.writes.length).toBe(2);
    expect(h.pending.length).toBe(0);
    expect(meter.bufferedCount()).toBe(0);
  });

  it("keeps live and test, and different days, in separate rows", async () => {
    const meter = new UsageMeter();
    const h = harness();
    meter.record({ organizationId: "o", environment: "live", limited: true, now: NOW }, h.hooks);
    meter.record({ organizationId: "o", environment: "test", limited: true, now: NOW }, h.hooks);
    meter.record(
      { organizationId: "o", environment: "live", limited: true, now: new Date("2026-11-19T00:00:01Z") },
      h.hooks,
    );
    await h.settle();
    expect(h.writes.flat()).toEqual(
      expect.arrayContaining([
        { organizationId: "o", day: "2026-11-18", environment: "live", count: 1 },
        { organizationId: "o", day: "2026-11-18", environment: "test", count: 1 },
        { organizationId: "o", day: "2026-11-19", environment: "live", count: 1 },
      ]),
    );
  });
});

describe("UsageMeter: unlimited organizations", () => {
  it("buffers a window of calls into one write", async () => {
    vi.useFakeTimers();
    const meter = new UsageMeter({ unlimitedFlushDelayMs: 15_000 });
    const h = harness();
    for (let i = 0; i < 300; i++) {
      meter.record({ organizationId: "org_pro", environment: "live", limited: false, now: NOW }, h.hooks);
    }
    expect(h.writes).toHaveLength(0);
    expect(h.pending).toHaveLength(1); // one waitUntil for the whole window
    await vi.advanceTimersByTimeAsync(15_000);
    await h.settle();
    expect(h.writes).toEqual([[{ organizationId: "org_pro", day: "2026-11-18", environment: "live", count: 300 }]]);
  });

  it("flushes early once the threshold is buffered", async () => {
    vi.useFakeTimers();
    const meter = new UsageMeter({ unlimitedFlushDelayMs: 15_000, unlimitedFlushThreshold: 100 });
    const h = harness();
    for (let i = 0; i < 100; i++) {
      meter.record({ organizationId: "org_pro", environment: "live", limited: false, now: NOW }, h.hooks);
    }
    await vi.advanceTimersByTimeAsync(0);
    await h.settle();
    expect(h.total()).toBe(100);
  });

  it("a limited call for a key in an open window ends the window (plan downgrade)", async () => {
    vi.useFakeTimers();
    const meter = new UsageMeter({ unlimitedFlushDelayMs: 15_000 });
    const h = harness();
    meter.record({ organizationId: "o", environment: "live", limited: false, now: NOW }, h.hooks);
    meter.record({ organizationId: "o", environment: "live", limited: true, now: NOW }, h.hooks);
    await vi.advanceTimersByTimeAsync(0);
    await h.settle();
    expect(h.total()).toBe(2);
  });
});

describe("UsageMeter: failures (fail open, nothing lost)", () => {
  it("never throws to the caller and keeps the counts for the next flush", async () => {
    vi.useFakeTimers();
    const meter = new UsageMeter({ failureBackoffMs: 5_000 });
    const h = harness();
    h.state.failNext = 1;
    expect(() =>
      meter.record({ organizationId: "o", environment: "live", limited: true, now: NOW }, h.hooks),
    ).not.toThrow();
    await vi.advanceTimersByTimeAsync(0);
    await h.settle();
    expect(h.writes).toHaveLength(0);
    expect(meter.bufferedCount()).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith(
      "usage-meter: write failed; counts kept for the next flush",
      expect.objectContaining({ organizationId: "o", count: 1, error: expect.stringContaining("db down") }),
    );

    // Next call retries after the backoff, with both counts.
    meter.record({ organizationId: "o", environment: "live", limited: true, now: NOW }, h.hooks);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(h.writes).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    await h.settle();
    expect(h.writes).toEqual([[{ organizationId: "o", day: "2026-11-18", environment: "live", count: 2 }]]);
  });

  it("a write that throws synchronously is contained too", async () => {
    const meter = new UsageMeter();
    const pending: Promise<unknown>[] = [];
    meter.record(
      { organizationId: "o", environment: "live", limited: true, now: NOW },
      {
        waitUntil: (p) => pending.push(p),
        write: () => {
          throw new Error("createDb exploded");
        },
      },
    );
    await expect(Promise.all(pending)).resolves.toBeDefined();
    expect(meter.bufferedCount()).toBe(1);
  });
});

describe("api_usage_daily upsert", () => {
  it("adds to the stored count on the (organization, day, environment) key", () => {
    const r = createSqlRecorder();
    const { sql, params } = buildUsageUpsert(r.db, [
      { organizationId: "o", day: "2026-11-18", environment: "live", count: 7 },
    ]).toSQL();
    expect(sql).toContain('insert into "api_usage_daily" ("organization_id", "day", "environment", "count")');
    expect(sql).toContain('on conflict ("organization_id","day","environment") do update set "count" = "api_usage_daily"."count" + excluded."count"');
    expect(params).toEqual(["o", "2026-11-18", "live", 7]);
  });

  it("writeUsageRows sends nothing for an empty batch", async () => {
    const r = createSqlRecorder();
    await writeUsageRows(r.db, []);
    expect(r.queries).toHaveLength(0);
  });

  it("utcDay uses the UTC calendar day", () => {
    expect(utcDay(new Date("2026-11-18T23:59:59-05:00"))).toBe("2026-11-19");
  });
});
