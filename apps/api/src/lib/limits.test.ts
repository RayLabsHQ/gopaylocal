import { describe, it, expect } from "vitest";
import { PRO_FAIR_USE_API_HITS_PER_MONTH } from "@gopaylocal/shared";
import {
  subscriptions,
  products,
  members,
  invitations,
  apiUsageDaily,
  organizationLimitOverrides,
} from "../db/schema";
import type { Database } from "../db";
import {
  computeLimitWarnings,
  getOrgRetentionDays,
  getProductLimitInfo,
  getUsageSummary,
  meteredApiCallsSince,
  sumApiCalls,
  UNLIMITED_RETENTION_LOOKBACK_DAYS,
  utcMonthStart,
} from "./limits";
import { createSqlRecorder } from "./sql-recorder-test-helpers";
import { resolveEntitlements, type SubscriptionLike } from "./entitlements";

// ── Fake Drizzle DB ──────────────────────────────────────────────────────────
// Returns canned rows per table for any select chain (where/limit/groupBy are
// ignored). Enough to exercise the plan/limit wiring without Postgres.

type Rows = Map<object, unknown[]>;

function fakeDb(rows: Rows): Database {
  const chain = (result: unknown[]) => {
    const builder: Record<string, unknown> = {
      where: () => builder,
      limit: () => builder,
      groupBy: () => builder,
      orderBy: () => builder,
      then: (resolve: (v: unknown[]) => unknown, reject?: (e: unknown) => unknown) =>
        Promise.resolve(result).then(resolve, reject),
    };
    return builder;
  };
  return {
    select: () => ({ from: (table: object) => chain(rows.get(table) ?? []) }),
  } as unknown as Database;
}

const DAY = 86_400_000;
const activePro: SubscriptionLike = {
  plan: "pro",
  status: "active",
  currentPeriodEnd: new Date(Date.now() + 10 * DAY),
};
const legacyBusiness: SubscriptionLike = { ...activePro, plan: "business" };

function orgRows(opts: {
  sub?: SubscriptionLike | null;
  productCount?: number;
  memberCount?: number;
  pendingInvites?: number;
  hits?: number | string;
  override?: Record<string, number | null> | null;
}): Rows {
  const n = (count = 0, prefix: string) =>
    Array.from({ length: count }, (_, i) => ({ id: `${prefix}${i}` }));
  return new Map<object, unknown[]>([
    [subscriptions, opts.sub ? [opts.sub] : []],
    [products, n(opts.productCount, "p")],
    [members, n(opts.memberCount, "m")],
    [invitations, n(opts.pendingInvites, "i")],
    [apiUsageDaily, [{ calls: opts.hits ?? 0 }]],
    [organizationLimitOverrides, opts.override ? [opts.override] : []],
  ]);
}

const HOSTED = { SELF_HOSTED: "false" };
const SELF = { SELF_HOSTED: "true" };

// ── getProductLimitInfo ──────────────────────────────────────────────────────

describe("getProductLimitInfo", () => {
  it("free org with no products has 1 slot", async () => {
    const info = await getProductLimitInfo(fakeDb(orgRows({})), "org", HOSTED);
    expect(info).toEqual({ plan: "free", maxProducts: 1, currentCount: 0, remaining: 1 });
  });

  it("free org at 1 product is at its limit", async () => {
    const info = await getProductLimitInfo(fakeDb(orgRows({ productCount: 1 })), "org", HOSTED);
    expect(info.remaining).toBe(0);
    expect(info.remaining <= 0).toBe(true);
  });

  it("free org grandfathered above the cap never goes negative", async () => {
    const info = await getProductLimitInfo(fakeDb(orgRows({ productCount: 3 })), "org");
    expect(info.maxProducts).toBe(1);
    expect(info.remaining).toBe(0);
  });

  it("pro org is unlimited: maxProducts null, gates never trip", async () => {
    const info = await getProductLimitInfo(
      fakeDb(orgRows({ sub: activePro, productCount: 500 })),
      "org",
      HOSTED,
    );
    expect(info.plan).toBe("pro");
    expect(info.maxProducts).toBeNull();
    // The route gates in products.ts / integrations.ts:
    expect(info.remaining <= 0).toBe(false);
    expect(10_000 >= info.remaining).toBe(false);
  });

  it("legacy business org is unlimited like pro", async () => {
    const info = await getProductLimitInfo(fakeDb(orgRows({ sub: legacyBusiness })), "org");
    expect(info.plan).toBe("pro");
    expect(info.maxProducts).toBeNull();
  });

  it("self-hosted free org is unlimited", async () => {
    const info = await getProductLimitInfo(fakeDb(orgRows({ productCount: 40 })), "org", SELF);
    expect(info.maxProducts).toBeNull();
    expect(info.remaining <= 0).toBe(false);
  });

  it("a hosted override caps products", async () => {
    const info = await getProductLimitInfo(
      fakeDb(orgRows({ productCount: 2, override: { maxProducts: 5 } })),
      "org",
      HOSTED,
    );
    expect(info.maxProducts).toBe(5);
    expect(info.remaining).toBe(3);
  });
});

// ── getUsageSummary ──────────────────────────────────────────────────────────

describe("getUsageSummary", () => {
  it("free org: finite caps, hits coerced from the SUM string", async () => {
    const summary = await getUsageSummary(
      fakeDb(orgRows({ productCount: 1, memberCount: 1, hits: "8421" })),
      "org",
      HOSTED,
    );
    expect(summary).toEqual({
      plan: "free",
      selfHosted: false,
      billingEnabled: true,
      products: { current: 1, max: 1 },
      apiHits: { current: 8421, max: 10_000 },
      teamMembers: { current: 1, max: 1 },
    });
  });

  it("seats count members plus pending invites", async () => {
    const summary = await getUsageSummary(
      fakeDb(orgRows({ sub: activePro, memberCount: 2, pendingInvites: 3 })),
      "org",
    );
    expect(summary.teamMembers).toEqual({ current: 5, max: null });
  });

  it("pro org: every meter is unlimited (null) and survives JSON", async () => {
    const summary = await getUsageSummary(
      fakeDb(orgRows({ sub: activePro, productCount: 12, hits: 3_000_000 })),
      "org",
      HOSTED,
    );
    expect(summary.products.max).toBeNull();
    expect(summary.apiHits.max).toBeNull();
    expect(summary.teamMembers.max).toBeNull();
    expect(JSON.parse(JSON.stringify(summary))).toEqual(summary);
  });

  it("self-hosted: flags selfHosted, billing off, unlimited meters", async () => {
    const summary = await getUsageSummary(fakeDb(orgRows({ hits: 99_999 })), "org", SELF);
    expect(summary.selfHosted).toBe(true);
    expect(summary.billingEnabled).toBe(false);
    expect(summary.apiHits).toEqual({ current: 99_999, max: null });
  });
});

// ── getOrgRetentionDays ──────────────────────────────────────────────────────

describe("getOrgRetentionDays", () => {
  it("free = 7 days, pro = 365 days, legacy business = 365 days", async () => {
    expect(await getOrgRetentionDays(fakeDb(orgRows({})), "org", HOSTED)).toBe(7);
    expect(await getOrgRetentionDays(fakeDb(orgRows({ sub: activePro })), "org", HOSTED)).toBe(365);
    expect(await getOrgRetentionDays(fakeDb(orgRows({ sub: legacyBusiness })), "org")).toBe(365);
  });

  it("self-hosted maps unlimited retention to a finite lookback that yields a valid Date", async () => {
    const days = await getOrgRetentionDays(fakeDb(orgRows({})), "org", SELF);
    expect(days).toBe(UNLIMITED_RETENTION_LOOKBACK_DAYS);
    // The analytics route computes Date.now() - days * DAY_MS; it must stay valid.
    const start = new Date(Date.now() - days * DAY);
    expect(Number.isNaN(start.getTime())).toBe(false);
    expect(start.getUTCFullYear()).toBeLessThan(1970);
  });
});

// ── meteredApiCallsSince ─────────────────────────────────────────────────────

describe("meteredApiCallsSince (quota cron, dashboard meter, admin alerts)", () => {
  it("sums LIVE api_usage_daily rows from the UTC day of `since`, never analytics impressions", () => {
    const r = createSqlRecorder();
    const { sql, params } = r.db
      .select({ calls: sumApiCalls() })
      .from(apiUsageDaily)
      .where(meteredApiCallsSince(new Date("2026-11-01T00:00:00Z")))
      .toSQL();
    expect(sql).toBe(
      // Single-table select: Drizzle leaves the summed column unqualified.
      'select COALESCE(SUM("count"), 0) from "api_usage_daily" ' +
        'where ("api_usage_daily"."environment" = $1 and "api_usage_daily"."day" >= $2)',
    );
    expect(params).toEqual(["live", "2026-11-01"]);
  });
});

// ── utcMonthStart ────────────────────────────────────────────────────────────

describe("utcMonthStart", () => {
  it("returns midnight UTC on the first of the month", () => {
    expect(utcMonthStart(new Date("2026-11-18T23:59:59Z")).toISOString()).toBe(
      "2026-11-01T00:00:00.000Z",
    );
  });
});

// ── computeLimitWarnings (admin alerts) ──────────────────────────────────────

describe("computeLimitWarnings", () => {
  const free = resolveEntitlements(null, HOSTED);
  const pro = resolveEntitlements(activePro, HOSTED);
  const selfHosted = resolveEntitlements(null, SELF);

  it("free org at 1/1 product and 1/1 seat does not alert (steady state)", () => {
    expect(computeLimitWarnings(free, { products: 1, apiHitsPerMonth: 0, teamMembers: 1 })).toEqual([]);
  });

  it("free org at 80% of 10K API calls alerts", () => {
    expect(computeLimitWarnings(free, { products: 0, apiHitsPerMonth: 8_000, teamMembers: 1 })).toEqual([
      { metric: "apiHitsPerMonth", kind: "cap", current: 8_000, limit: 10_000, percentage: 80 },
    ]);
  });

  it("free org below 80% of API calls does not alert", () => {
    expect(computeLimitWarnings(free, { products: 0, apiHitsPerMonth: 7_999, teamMembers: 1 })).toEqual([]);
  });

  it("pro org never alerts on unlimited caps (no division by an unlimited cap)", () => {
    const warnings = computeLimitWarnings(pro, {
      products: 10_000,
      apiHitsPerMonth: PRO_FAIR_USE_API_HITS_PER_MONTH,
      teamMembers: 500,
    });
    expect(warnings).toEqual([]);
    for (const w of warnings) expect(Number.isFinite(w.percentage)).toBe(true);
  });

  it("pro org past 20M API calls gets a fair-use alert", () => {
    const warnings = computeLimitWarnings(pro, {
      products: 3,
      apiHitsPerMonth: 25_000_000,
      teamMembers: 2,
    });
    expect(warnings).toEqual([
      {
        metric: "apiHitsPerMonth",
        kind: "fair_use",
        current: 25_000_000,
        limit: 20_000_000,
        percentage: 125,
      },
    ]);
  });

  it("legacy business org is held to the same fair-use line", () => {
    const ent = resolveEntitlements(legacyBusiness, HOSTED);
    expect(computeLimitWarnings(ent, { products: 0, apiHitsPerMonth: 20_000_001, teamMembers: 0 })).toHaveLength(1);
  });

  it("raised overrides above 1 re-enable structural alerts", () => {
    const ent = resolveEntitlements(null, HOSTED, { maxProducts: 5, maxTeamMembers: 5 });
    const warnings = computeLimitWarnings(ent, { products: 4, apiHitsPerMonth: 0, teamMembers: 5 });
    expect(warnings.map((w) => [w.metric, w.percentage])).toEqual([
      ["products", 80],
      ["teamMembers", 100],
    ]);
  });

  it("a zero API-hit override does not alert (and does not divide by zero)", () => {
    const ent = resolveEntitlements(null, HOSTED, { maxApiHitsPerMonth: 0 });
    expect(computeLimitWarnings(ent, { products: 0, apiHitsPerMonth: 50, teamMembers: 0 })).toEqual([]);
  });

  it("self-hosted produces no alerts, even past the fair-use line", () => {
    expect(
      computeLimitWarnings(selfHosted, {
        products: 1_000,
        apiHitsPerMonth: 100_000_000,
        teamMembers: 1_000,
      }),
    ).toEqual([]);
  });
});
