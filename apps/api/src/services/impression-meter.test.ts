import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createSqlRecorder } from "../lib/sql-recorder-test-helpers";
import { ImpressionMeter, buildImpressionUpsert, writeImpressionRows, type ImpressionRow } from "./impression-meter";

/** Collects waitUntil promises and written batches; `failNext` makes writes reject. */
function harness() {
  const pending: Promise<unknown>[] = [];
  const writes: ImpressionRow[][] = [];
  const state = { failNext: 0 };
  const hooks = {
    waitUntil: (p: Promise<unknown>) => {
      pending.push(p);
    },
    write: async (rows: ImpressionRow[]) => {
      const copy = rows.map((r) => ({ ...r }));
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
  return { hooks, writes, state, settle };
}

const NOW = new Date("2026-11-21T10:00:00Z");
const base = { organizationId: "org_1", campaignId: "camp_a", countryCode: "IN", now: NOW };

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("ImpressionMeter", () => {
  it("an organization with a cap: the impression is written at once, as one row", async () => {
    const meter = new ImpressionMeter();
    const h = harness();
    meter.record({ ...base, limited: true }, h.hooks);
    await h.settle();
    expect(h.writes).toEqual([
      [{ organizationId: "org_1", campaignId: "camp_a", countryCode: "IN", day: "2026-11-21", count: 1 }],
    ]);
    expect(meter.bufferedCount()).toBe(0);
  });

  it("an unlimited organization: a window of impressions is one batch, one row per campaign, country and day", async () => {
    vi.useFakeTimers();
    const meter = new ImpressionMeter({ flushDelayMs: 15_000 });
    const h = harness();
    meter.record({ ...base, limited: false }, h.hooks);
    meter.record({ ...base, limited: false }, h.hooks);
    meter.record({ ...base, countryCode: "br", limited: false }, h.hooks);
    meter.record({ ...base, campaignId: "camp_b", limited: false }, h.hooks);
    meter.record({ ...base, now: new Date("2026-11-22T00:00:01Z"), limited: false }, h.hooks);
    await vi.advanceTimersByTimeAsync(14_999);
    expect(h.writes).toEqual([]);
    expect(meter.bufferedCount()).toBe(5);

    await vi.advanceTimersByTimeAsync(1);
    await h.settle();
    expect(h.writes).toHaveLength(1);
    expect(h.writes[0]).toEqual([
      { organizationId: "org_1", campaignId: "camp_a", countryCode: "IN", day: "2026-11-21", count: 2 },
      { organizationId: "org_1", campaignId: "camp_a", countryCode: "BR", day: "2026-11-21", count: 1 },
      { organizationId: "org_1", campaignId: "camp_b", countryCode: "IN", day: "2026-11-21", count: 1 },
      { organizationId: "org_1", campaignId: "camp_a", countryCode: "IN", day: "2026-11-22", count: 1 },
    ]);
  });

  it("organizations are written separately", async () => {
    const meter = new ImpressionMeter();
    const h = harness();
    meter.record({ ...base, limited: true }, h.hooks);
    meter.record({ ...base, organizationId: "org_2", limited: true }, h.hooks);
    await h.settle();
    expect(h.writes.map((rows) => rows.map((r) => r.organizationId))).toEqual([["org_1"], ["org_2"]]);
  });

  it("the threshold ends an unlimited window early", async () => {
    vi.useFakeTimers();
    const meter = new ImpressionMeter({ flushDelayMs: 15_000, flushThreshold: 3 });
    const h = harness();
    for (let i = 0; i < 3; i++) meter.record({ ...base, limited: false }, h.hooks);
    await vi.advanceTimersByTimeAsync(0);
    await h.settle();
    expect(h.writes).toEqual([[expect.objectContaining({ count: 3 })]]);
  });

  it("drops an impression without a campaign or a two-letter country", () => {
    const meter = new ImpressionMeter();
    const h = harness();
    for (const bad of [{ campaignId: "" }, { countryCode: "" }, { countryCode: "IND" }, { countryCode: "1N" }, { organizationId: "" }]) {
      meter.record({ ...base, ...bad, limited: true }, h.hooks);
    }
    expect(meter.bufferedCount()).toBe(0);
  });

  it("a failed write keeps its rows for the next flush, added to what arrived meanwhile", async () => {
    vi.useFakeTimers();
    const meter = new ImpressionMeter({ failureBackoffMs: 5_000 });
    const h = harness();
    h.state.failNext = 1;
    meter.record({ ...base, limited: true }, h.hooks); // written at once: this write fails
    meter.record({ ...base, countryCode: "BR", limited: true }, h.hooks); // arrives while it is in flight
    await vi.advanceTimersByTimeAsync(0);
    await h.settle();
    expect(h.writes).toEqual([]);
    expect(meter.bufferedCount()).toBe(2);
    expect(console.error).toHaveBeenCalledWith(
      "impression-meter: write failed; counts kept for the next flush",
      expect.objectContaining({ organizationId: "org_1", rows: 1, count: 1, error: expect.stringContaining("db down") }),
    );

    // The next impression retries after the backoff, with everything kept.
    meter.record({ ...base, limited: true }, h.hooks);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(h.writes).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    await h.settle();
    expect(h.writes).toHaveLength(1);
    expect([...h.writes[0]!].sort((a, b) => a.countryCode.localeCompare(b.countryCode))).toEqual([
      expect.objectContaining({ countryCode: "BR", count: 1 }),
      expect.objectContaining({ countryCode: "IN", count: 2 }),
    ]);
    expect(meter.bufferedCount()).toBe(0);
  });
});

describe("analytics_rollups impression upsert", () => {
  const rows: ImpressionRow[] = [
    { organizationId: "org_1", campaignId: "camp_a", countryCode: "IN", day: "2026-11-21", count: 7 },
    { organizationId: "org_1", campaignId: "camp_a", countryCode: "BR", day: "2026-11-21", count: 2 },
  ];

  it("is one statement that adds each row's count on the 6-column rollup key", () => {
    const { sql, params } = buildImpressionUpsert(createSqlRecorder().db, rows, NOW).toSQL();
    const [insertPart, conflictPart] = sql.split(" on conflict ");
    expect(insertPart).toContain('insert into "analytics_rollups" (');
    // Bare column names in the column list (a table-qualified one is a Postgres error).
    expect(insertPart).not.toContain('"analytics_rollups"."');
    expect(insertPart!.match(/\(\$\d+|\(default/g)!.length).toBeGreaterThanOrEqual(2); // two value tuples
    expect(conflictPart).toBe(
      '("organization_id","campaign_id","country_code","period","period_start","environment") ' +
        'do update set "impressions" = "analytics_rollups"."impressions" + excluded."impressions"',
    );
    // UTC day bucket, the day's count, and 'live', as the click and copy counters use.
    expect(params).toEqual(expect.arrayContaining(["org_1", "camp_a", "IN", "BR", "day", "2026-11-21T00:00:00.000Z", 7, 2, "live"]));
    // No other counter is written.
    for (const other of ["clicks", "copies", "redemptions"]) expect(sql).not.toContain(`"${other}" = `);
    // postgres-js cannot send a raw JS Date.
    expect(params.some((p) => p instanceof Date)).toBe(false);
  });

  it("writeImpressionRows sends nothing for an empty batch", async () => {
    const r = createSqlRecorder();
    await writeImpressionRows(r.db, []);
    expect(r.queries).toHaveLength(0);
  });

  it("writeImpressionRows sends one statement for a batch", async () => {
    const r = createSqlRecorder();
    await writeImpressionRows(r.db, rows);
    expect(r.queries).toHaveLength(1);
  });
});
