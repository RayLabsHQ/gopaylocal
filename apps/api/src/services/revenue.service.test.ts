import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { createSqlRecorder } from "../lib/sql-recorder-test-helpers";
import { analyticsRollups } from "../db/schema";
import { ALL, revenueSavedByCurrency } from "./revenue.service";

describe("revenueSavedByCurrency", () => {
  it("sums each currency separately (never adds INR to USD) and converts with each currency's exponent", async () => {
    // Before S4, every currency was summed into one figure labelled USD.
    const r = createSqlRecorder([
      [
        { group: "", currency: "USD", amountMinor: "1250" },
        { group: "", currency: "INR", amountMinor: "40000" },
        { group: "", currency: "JPY", amountMinor: "500" },
        { group: "", currency: "KWD", amountMinor: "1500" },
      ],
    ]);

    const totals = await revenueSavedByCurrency(r.db, eq(analyticsRollups.organizationId, "org_1"));

    expect(totals.get(ALL)).toEqual({ USD: 12.5, INR: 400, JPY: 500, KWD: 1.5 });
    const q = r.queries[0]!;
    expect(q.sql).toContain('CROSS JOIN LATERAL jsonb_each_text("analytics_rollups"."revenue_saved_by_currency") AS kv(key, value)');
    expect(q.sql).toContain('where "analytics_rollups"."organization_id" = $1');
    expect(q.sql).toMatch(/group by kv\.key$/);
  });

  it("groups by a rollup column", async () => {
    const r = createSqlRecorder([
      [
        { group: "IN", currency: "INR", amountMinor: 40000 },
        { group: "IN", currency: "USD", amountMinor: 300 },
        { group: "BR", currency: "BRL", amountMinor: 990 },
      ],
    ]);

    const totals = await revenueSavedByCurrency(r.db, undefined, analyticsRollups.countryCode);

    expect(Object.fromEntries(totals)).toEqual({ IN: { INR: 400, USD: 3 }, BR: { BRL: 9.9 } });
    expect(r.queries[0]!.sql).toMatch(/group by "analytics_rollups"\."country_code", kv\.key$/);
  });

  it("skips malformed codes and zero totals", async () => {
    const r = createSqlRecorder([
      [
        { group: "", currency: "usd", amountMinor: "100" },
        { group: "", currency: "not-a-code", amountMinor: "100" },
        { group: "", currency: "EUR", amountMinor: "0" },
      ],
    ]);

    const totals = await revenueSavedByCurrency(r.db, undefined);

    expect(totals.get(ALL)).toEqual({ USD: 1 });
  });
});
