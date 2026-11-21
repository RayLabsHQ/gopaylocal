import { describe, it, expect } from "vitest";
import { createSqlRecorder, type RecordedQuery } from "../lib/sql-recorder-test-helpers";
import {
  REVENUE_SAVED_CURRENCY,
  computeSavingsMinor,
  handleRedemption,
  revenueSavedForRollup,
  savingsByCurrency,
} from "./redemption.service";
import type { RedemptionEvent } from "./providers/types";

// Unit tests for the shared redemption handler. The SQL recorder builds the
// real Drizzle statements and answers with canned rows in order:
//   1. coupon candidates   2. campaign/org check   3. rollup upsert

const INTEGRATION = "int_1";
const ORG = "org_1";

function couponRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "cpn_1",
    campaignId: "cmp_1",
    integrationId: INTEGRATION,
    countryCode: "IN",
    code: "PPPIN40ABCD",
    providerCouponId: "prov_cpn_1",
    providerPromoCodeId: null,
    discountPercent: 40,
    environment: "live",
    status: "active",
    createdAt: new Date(),
    ...overrides,
  };
}

function event(overrides: Partial<RedemptionEvent> = {}): RedemptionEvent {
  return {
    eventId: "evt_1",
    code: "PPPIN40ABCD",
    providerCouponId: null,
    providerPromoCodeId: null,
    discountAmountCents: null,
    chargedAmountCents: null,
    currency: "USD",
    ...overrides,
  } as RedemptionEvent;
}

function rollupInsert(queries: RecordedQuery[]): RecordedQuery {
  const q = queries.find((x) => x.sql.startsWith('insert into "analytics_rollups"'));
  if (!q) throw new Error("no rollup insert recorded");
  return q;
}

/** The dollar amount added to revenue_saved on conflict. */
function revenueAdded(queries: RecordedQuery[]): unknown {
  const q = rollupInsert(queries);
  const m = /"revenue_saved" = "analytics_rollups"\."revenue_saved" \+ \$(\d+)/.exec(q.sql);
  if (!m) throw new Error("no revenue_saved increment in the upsert");
  return q.params[Number(m[1]) - 1];
}

/** The per-currency map inserted for a new rollup row. */
function byCurrencyInserted(queries: RecordedQuery[]): unknown {
  const q = rollupInsert(queries);
  const json = q.params.find((p) => typeof p === "string" && p.startsWith("{"));
  return json === undefined ? undefined : JSON.parse(json as string);
}

describe("handleRedemption: matching", () => {
  it("matches codes case-insensitively (providers echo codes in a different case)", async () => {
    const r = createSqlRecorder([[couponRow()], [{ organizationId: ORG }], []]);

    const ok = await handleRedemption(r.db, INTEGRATION, ORG, event({ code: "pppin40abcd" }));

    expect(ok).toBe(true);
    expect(r.queries[0]!.sql).toContain('lower("coupons"."code") = $');
    expect(r.queries[0]!.params).toContain("pppin40abcd");
    expect(r.queries[0]!.sql).toContain('"coupons"."integration_id" = $');
    expect(r.queries[0]!.params).toContain(INTEGRATION);
  });

  it("finds our coupon among stacked discounts, after the merchant's own code", async () => {
    // The order used the merchant's WELCOME10 first and our PPP code second.
    const ours = couponRow();
    const r = createSqlRecorder([[ours], [{ organizationId: ORG }], []]);

    const ok = await handleRedemption(
      r.db,
      INTEGRATION,
      ORG,
      event({
        code: "WELCOME10",
        discountAmountCents: 500,
        otherDiscounts: [
          { code: "PPPIN40ABCD", providerCouponId: null, providerPromoCodeId: null, discountAmountCents: 1200 },
        ],
      }),
    );

    expect(ok).toBe(true);
    // Both discounts are looked up in one query.
    expect(r.queries[0]!.params).toEqual(expect.arrayContaining(["welcome10", "pppin40abcd"]));
    // Savings come from OUR discount's amount (12.00), not the merchant code's (5.00).
    expect(revenueAdded(r.queries)).toBe(12);
  });

  it("attributes to the first of our discounts in provider order", async () => {
    const first = couponRow({ id: "cpn_a", code: "PPPAAA", countryCode: "BR", campaignId: "cmp_a" });
    const second = couponRow({ id: "cpn_b", code: "PPPBBB", countryCode: "IN", campaignId: "cmp_b" });
    // DB returns them in the "wrong" order; attribution must follow the event.
    const r = createSqlRecorder([[second, first], [{ organizationId: ORG }], []]);

    await handleRedemption(
      r.db,
      INTEGRATION,
      ORG,
      event({
        code: "pppaaa",
        otherDiscounts: [{ code: "PPPBBB", providerCouponId: null, providerPromoCodeId: null }],
      }),
    );

    const campaignCheck = r.queries[1]!;
    expect(campaignCheck.params).toContain("cmp_a");
    expect(rollupInsert(r.queries).params).toContain("BR");
  });

  it("matches on provider coupon id when the provider sends no code", async () => {
    const r = createSqlRecorder([[couponRow()], [{ organizationId: ORG }], []]);

    const ok = await handleRedemption(r.db, INTEGRATION, ORG, event({ code: null, providerCouponId: "prov_cpn_1" }));

    expect(ok).toBe(true);
    expect(r.queries[0]!.sql).toContain('"coupons"."provider_coupon_id" = $');
  });

  it("returns false without writing when no discount is one of ours", async () => {
    const r = createSqlRecorder([[]]);

    const ok = await handleRedemption(r.db, INTEGRATION, ORG, event({ code: "SOMEONEELSE" }));

    expect(ok).toBe(false);
    expect(r.queries).toHaveLength(1);
  });

  it("returns false without writing when the coupon's campaign is in another org", async () => {
    const r = createSqlRecorder([[couponRow()], []]);

    const ok = await handleRedemption(r.db, INTEGRATION, ORG, event());

    expect(ok).toBe(false);
    expect(r.queries.some((q) => q.sql.startsWith("insert"))).toBe(false);
  });

  it("returns false without a query when the event carries no identifiers", async () => {
    const r = createSqlRecorder([]);
    const ok = await handleRedemption(r.db, INTEGRATION, ORG, event({ code: null }));
    expect(ok).toBe(false);
    expect(r.queries).toHaveLength(0);
  });
});

describe("handleRedemption: revenue saved", () => {
  it("adds USD discount amounts in dollars", async () => {
    const r = createSqlRecorder([[couponRow()], [{ organizationId: ORG }], []]);
    await handleRedemption(r.db, INTEGRATION, ORG, event({ discountAmountCents: 1999, currency: "usd" }));
    expect(revenueAdded(r.queries)).toBeCloseTo(19.99, 10);
  });

  it("back-calculates USD savings from the charged amount and the coupon percent", async () => {
    // Charged $60 after 40% off ⇒ list $100 ⇒ saved $40.
    const r = createSqlRecorder([[couponRow({ discountPercent: 40 })], [{ organizationId: ORG }], []]);
    await handleRedemption(r.db, INTEGRATION, ORG, event({ chargedAmountCents: 6000, taxAmountCents: 0 }));
    expect(revenueAdded(r.queries)).toBeCloseTo(40, 10);
  });

  it("back-calculates from the PRE-TAX amount paid (tax is not savings)", async () => {
    // $72 paid = $60 after 40% off + $12 tax ⇒ saved $40, not $48.
    const r = createSqlRecorder([[couponRow({ discountPercent: 40 })], [{ organizationId: ORG }], []]);
    await handleRedemption(r.db, INTEGRATION, ORG, event({ chargedAmountCents: 7200, taxAmountCents: 1200 }));
    expect(revenueAdded(r.queries)).toBeCloseTo(40, 10);
    expect(byCurrencyInserted(r.queries)).toEqual({ USD: 4000 });
  });

  it("counts the redemption but adds no savings when the tax is unknown and no pre-tax discount is given", async () => {
    const r = createSqlRecorder([[couponRow({ discountPercent: 40 })], [{ organizationId: ORG }], []]);
    const ok = await handleRedemption(r.db, INTEGRATION, ORG, event({ chargedAmountCents: 7200, taxAmountCents: null }));
    expect(ok).toBe(true);
    expect(revenueAdded(r.queries)).toBe(0);
    expect(byCurrencyInserted(r.queries)).toEqual({});
    expect(rollupInsert(r.queries).sql).not.toContain("jsonb_build_object");
  });

  it("records every currency, in minor units, under its own ISO code (never summed into dollars)", async () => {
    const r = createSqlRecorder([[couponRow()], [{ organizationId: ORG }], []]);
    await handleRedemption(r.db, INTEGRATION, ORG, event({ discountAmountCents: 1500, currency: "kwd" }));
    expect(byCurrencyInserted(r.queries)).toEqual({ KWD: 1500 });
    const q = rollupInsert(r.queries);
    // On conflict the KWD key is incremented by 1500 (typed params: jsonb_build_object takes "any").
    expect(q.sql).toMatch(/jsonb_build_object\(\$\d+::text, COALESCE\(\("analytics_rollups"\."revenue_saved_by_currency" ->> \$\d+::text\)::bigint, 0\) \+ \$\d+::bigint\)/);
    expect(q.params.slice(-3)).toEqual(["KWD", "KWD", 1500]);
  });

  it("counts a JPY redemption but adds nothing to the dollar total", async () => {
    // Old behavior added 500 (yen) into a figure the dashboard shows with "$".
    const r = createSqlRecorder([[couponRow()], [{ organizationId: ORG }], []]);
    const ok = await handleRedemption(r.db, INTEGRATION, ORG, event({ discountAmountCents: 500, currency: "JPY" }));
    expect(ok).toBe(true);
    expect(revenueAdded(r.queries)).toBe(0);
  });

  it("counts a KWD redemption but adds nothing to the dollar total", async () => {
    // Old behavior added 15 (1500 / 100) for 1.500 KD.
    const r = createSqlRecorder([[couponRow()], [{ organizationId: ORG }], []]);
    await handleRedemption(r.db, INTEGRATION, ORG, event({ discountAmountCents: 1500, currency: "KWD" }));
    expect(revenueAdded(r.queries)).toBe(0);
  });

  it("writes the redemption under the coupon's environment", async () => {
    const r = createSqlRecorder([[couponRow({ environment: "test" })], [{ organizationId: ORG }], []]);
    await handleRedemption(r.db, INTEGRATION, ORG, event());
    expect(rollupInsert(r.queries).params).toContain("test");
  });
});

describe("computeSavingsMinor", () => {
  it("prefers the provider's (pre-tax) discount amount", () => {
    expect(computeSavingsMinor(1500, 6000, 0, 40)).toBe(1500);
    expect(computeSavingsMinor(1500, 6000, null, 40)).toBe(1500);
  });

  it("back-calculates from the charged amount minus tax when no discount amount is given", () => {
    expect(computeSavingsMinor(null, 6000, 0, 40)).toBe(4000);
    expect(computeSavingsMinor(0, 6000, 0, 40)).toBe(4000);
    expect(computeSavingsMinor(null, 7200, 1200, 40)).toBe(4000);
  });

  it("returns null when it can't tell", () => {
    expect(computeSavingsMinor(null, null, 0, 40)).toBeNull();
    expect(computeSavingsMinor(null, 6000, 0, 0)).toBeNull();
    expect(computeSavingsMinor(null, 6000, 0, 100)).toBeNull();
    // Tax unknown: the total might contain tax, so no back-calculation.
    expect(computeSavingsMinor(null, 6000, null, 40)).toBeNull();
    expect(computeSavingsMinor(null, 6000, undefined, 40)).toBeNull();
  });

  it("rounds to a whole minor unit", () => {
    expect(computeSavingsMinor(null, 1000, 0, 33)).toBe(493); // 1000 × 33/67 = 492.5…
  });
});

describe("savingsByCurrency", () => {
  it("keys whole minor units by the normalized ISO code, and skips what can't be keyed", () => {
    expect(savingsByCurrency(1999, " usd ")).toEqual({ currency: "USD", amountMinor: 1999 });
    expect(savingsByCurrency(500, "JPY")).toEqual({ currency: "JPY", amountMinor: 500 });
    expect(savingsByCurrency(500, null)).toBeNull();
    expect(savingsByCurrency(500, "dollars")).toBeNull();
    expect(savingsByCurrency(null, "USD")).toBeNull();
    expect(savingsByCurrency(0, "USD")).toBeNull();
  });
});

describe("revenueSavedForRollup", () => {
  it("is in major units for the rollup currency only", () => {
    expect(REVENUE_SAVED_CURRENCY).toBe("USD");
    expect(revenueSavedForRollup(1999, "USD")).toBeCloseTo(19.99, 10);
    expect(revenueSavedForRollup(1999, "EUR")).toBe(0);
    expect(revenueSavedForRollup(1999, null)).toBe(0);
    expect(revenueSavedForRollup(null, "USD")).toBe(0);
  });
});

describe("handleRedemption: coupons without a country", () => {
  it('rolls them up under "XX" so repeated redemptions increment one row', async () => {
    // A NULL country_code would never hit the upsert's conflict target
    // (NULLs are distinct), so each redemption would add a new rollup row.
    const r = createSqlRecorder([[couponRow({ countryCode: null })], [{ organizationId: ORG }], []]);
    await handleRedemption(r.db, INTEGRATION, ORG, event());
    expect(rollupInsert(r.queries).params).toContain("XX");
    expect(rollupInsert(r.queries).params).not.toContain(null);
  });
});
