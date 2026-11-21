import { describe, it, expect, vi, afterEach } from "vitest";
import { createSqlRecorder } from "../lib/sql-recorder-test-helpers";
import {
  REWRITE_AFTER_MS,
  clearIntegrationIssue,
  describeError,
  integrationHealthOf,
  recordIntegrationIssue,
} from "./integration-health.service";
import { healthClears, healthWrites } from "./integration-health-test-helpers";

// Health lives on the integration row (integrations.health jsonb). The SQL
// recorder shows the exact statements: one conditional UPDATE per recorded
// issue, and no statement at all to "clear" a healthy, already-loaded row.

afterEach(() => vi.restoreAllMocks());

const at = new Date("2026-11-18T10:00:00Z");

describe("recordIntegrationIssue", () => {
  it("writes the issue under its area with one UPDATE scoped to the integration", async () => {
    const r = createSqlRecorder();
    await recordIntegrationIssue(r.db, "int_1", { area: "webhook_setup", message: "boom", environment: "test" }, at);

    expect(healthWrites(r)).toEqual([
      { area: "webhook_setup", message: "boom", environment: "test", at: at.toISOString() },
    ]);
    const q = r.queries[0]!;
    expect(q.sql).toMatch(/^update "integrations" set "health" = "integrations"\."health" \|\| jsonb_build_object\(\$1::text, \$2::jsonb\)/);
    expect(q.sql).toContain('"integrations"."id" = $3');
    expect(q.params[2]).toBe("int_1");
  });

  it("skips the write in SQL when the same issue was recorded in the last ten minutes", async () => {
    const r = createSqlRecorder();
    await recordIntegrationIssue(r.db, "int_1", { area: "coupon_sync", message: "boom" }, at);
    const q = r.queries[0]!;
    // NOT COALESCE(prev.message = msg AND prev.environment = env AND prev.at > cutoff, false)
    expect(q.sql).toContain("NOT COALESCE(");
    expect(q.params).toContain(new Date(at.getTime() - REWRITE_AFTER_MS).toISOString());
    expect(q.params).toContain("boom");
  });

  it("doesn't even query when the loaded row already shows the same recent issue", async () => {
    const r = createSqlRecorder();
    const row = {
      id: "int_1",
      health: { coupon_sync: { area: "coupon_sync", message: "boom", at: new Date(at.getTime() - 60_000).toISOString() } },
    };
    await recordIntegrationIssue(r.db, row, { area: "coupon_sync", message: "boom" }, at);
    expect(r.queries).toHaveLength(0);

    await recordIntegrationIssue(r.db, row, { area: "coupon_sync", message: "different" }, at);
    await recordIntegrationIssue(r.db, row, { area: "coupon_sync", message: "boom" }, new Date(at.getTime() + REWRITE_AFTER_MS));
    expect(r.queries).toHaveLength(2);
  });

  it("stores the message as one short line", async () => {
    const r = createSqlRecorder();
    await recordIntegrationIssue(r.db, "int_1", { area: "credentials", message: "line one\n  line two" }, at);
    expect(healthWrites(r)[0]!.message).toBe("line one line two");
  });

  it("never throws when the write fails, and logs it", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const r = createSqlRecorder([new Error("connection reset")]);
    await expect(recordIntegrationIssue(r.db, "int_1", { area: "coupon_sync", message: "x" })).resolves.toMatchObject({ area: "coupon_sync", message: "x" });
    expect(log).toHaveBeenCalled();
  });
});

describe("clearIntegrationIssue", () => {
  it("costs nothing on a healthy loaded row", async () => {
    const r = createSqlRecorder();
    await clearIntegrationIssue(r.db, { id: "int_1", health: {} }, "coupon_sync");
    await clearIntegrationIssue(r.db, { id: "int_1", health: { credentials: { area: "credentials", message: "x", at: at.toISOString() } } }, "coupon_sync");
    expect(r.queries).toHaveLength(0);
  });

  it("removes just that area, only where it is present", async () => {
    const r = createSqlRecorder();
    await clearIntegrationIssue(r.db, { id: "int_1", health: { coupon_sync: { area: "coupon_sync", message: "x", at: at.toISOString() } } }, "coupon_sync");
    await clearIntegrationIssue(r.db, "int_2", "webhook_delivery");
    expect(healthClears(r)).toEqual(["coupon_sync", "webhook_delivery"]);
    expect(r.queries[0]!.sql).toContain('"integrations"."health" ? $');
  });

  it("never throws when the write fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const r = createSqlRecorder([new Error("db down")]);
    await expect(clearIntegrationIssue(r.db, "int_1", "coupon_sync")).resolves.toBeUndefined();
  });
});

describe("integrationHealthOf", () => {
  it("returns only well-formed issues from the stored jsonb", () => {
    expect(integrationHealthOf({ health: null })).toEqual({});
    expect(integrationHealthOf({ health: [] })).toEqual({});
    expect(
      integrationHealthOf({
        health: {
          credentials: { area: "credentials", message: "rejected", environment: "live", at: "2026-11-18T10:00:00.000Z" },
          coupon_sync: { message: 42 },
          unknown_area: { message: "x", at: "y" },
        },
      }),
    ).toEqual({
      credentials: { area: "credentials", message: "rejected", environment: "live", at: "2026-11-18T10:00:00.000Z" },
    });
  });
});

describe("describeError", () => {
  it("describes errors as one short line", () => {
    expect(describeError(new Error("line one\n  line two"))).toBe("line one line two");
    expect(describeError("plain")).toBe("plain");
    expect(describeError({})).toBe("Unknown error");
    const long = describeError(new Error("x".repeat(1000)));
    expect(long.length).toBe(300);
    expect(long.endsWith("…")).toBe(true);
  });

  it("never repeats a query error's SQL parameters (they can hold a stored webhook body)", () => {
    // Shape of drizzle's DrizzleQueryError: message = SQL + params, cause = driver error.
    const driver = Object.assign(new Error('duplicate key value violates unique constraint "x"'), { code: "23505" });
    const wrapped = Object.assign(
      new Error('Failed query: insert into "webhook_events" ... params: {"email":"buyer@example.com"}'),
      { query: 'insert into "webhook_events" ...', params: ['{"email":"buyer@example.com"}'], cause: driver },
    );
    expect(describeError(wrapped)).toBe('duplicate key value violates unique constraint "x"');

    const noCause = Object.assign(new Error("Failed query: select ... params: secret"), { query: "select ..." });
    expect(describeError(noCause)).toBe("Database query failed");
  });
});
