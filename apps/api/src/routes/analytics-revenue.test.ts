import { describe, it, expect, vi } from "vitest";
import { createTestClient, mountRoutes } from "../test/helpers";
import { createSqlRecorder, type SqlRecorder } from "../lib/sql-recorder-test-helpers";

// Revenue saved per currency in the analytics responses. Before S4 every
// currency was summed into one figure the dashboard labelled as dollars; now
// each endpoint also returns `revenueSavedByCurrency` (major units by ISO code)
// and `revenueSaved` / `totalRevenueSaved` hold the USD part only.

const state = vi.hoisted(() => ({ recorder: null as unknown as SqlRecorder }));
vi.mock("../db", () => ({ createDb: () => state.recorder.db }));
vi.mock("../lib/limits", () => ({ getOrgRetentionDays: async () => 365 }));

const { default: analyticsRoute } = await import("./analytics");

const ORG = "org_1";
const isRevenueQuery = (sql: string) => sql.includes("jsonb_each_text");

// Promise.all starts the per-currency query first: revenueSavedByCurrency is an
// async function and runs up to its first await while the arguments are
// evaluated, before Promise.all subscribes to the totals query. So canned
// results go per-currency first, then totals.

describe("GET analytics: revenue saved per currency", () => {
  it("overview returns one total per currency next to the USD-only figure", async () => {
    state.recorder = createSqlRecorder([
      [{ group: "", currency: "USD", amountMinor: "1250" }, { group: "", currency: "INR", amountMinor: "40000" }],
      [{ totalImpressions: "10", totalClicks: "2", totalCopies: "1", totalRedemptions: "2", totalRevenueSaved: 12.5 }],
    ]);
    const res = await createTestClient(mountRoutes(analyticsRoute)).request(`/v1/teams/${ORG}/analytics/overview`);

    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: Record<string, unknown> };
    expect(data.totalRevenueSaved).toBe(12.5);
    expect(data.revenueSavedByCurrency).toEqual({ USD: 12.5, INR: 400 });
    // Same tenant + retention filter on both statements.
    for (const q of state.recorder.queries) expect(q.params).toContain(ORG);
    expect(state.recorder.queries.filter((q) => isRevenueQuery(q.sql))).toHaveLength(1);
  });

  it("by-country attaches each country's per-currency totals", async () => {
    state.recorder = createSqlRecorder([
      [{ group: "IN", currency: "INR", amountMinor: "40000" }],
      [
        { countryCode: "IN", impressions: "5", clicks: "1", copies: "0", redemptions: "1", revenueSaved: 0 },
        { countryCode: "BR", impressions: "3", clicks: "0", copies: "0", redemptions: "0", revenueSaved: 0 },
      ],
    ]);
    const res = await createTestClient(mountRoutes(analyticsRoute)).request(`/v1/teams/${ORG}/analytics/by-country`);

    const { data } = (await res.json()) as { data: Array<Record<string, unknown>> };
    expect(data.map((d) => [d.countryCode, d.revenueSavedByCurrency])).toEqual([
      ["IN", { INR: 400 }],
      ["BR", {}],
    ]);
  });

  it("by-campaign attaches each campaign's per-currency totals", async () => {
    state.recorder = createSqlRecorder([
      [{ group: "c1", currency: "JPY", amountMinor: "500" }],
      [{ campaignId: "c1", impressions: "5", clicks: "1", copies: "0", redemptions: "1", revenueSaved: 0 }],
    ]);
    const res = await createTestClient(mountRoutes(analyticsRoute)).request(`/v1/teams/${ORG}/analytics/by-campaign`);

    const { data } = (await res.json()) as { data: Array<Record<string, unknown>> };
    expect(data[0]!.revenueSavedByCurrency).toEqual({ JPY: 500 });
  });
});

