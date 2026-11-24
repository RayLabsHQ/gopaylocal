import { describe, expect, it } from "vitest";
import { CHARM_STRATEGIES } from "@gopaylocal/shared/currency";
import {
  chargedLocalPrice,
  compareWithDodo,
  dodoErrorMessage,
  houseSyncUnavailable,
  isHouseSyncRun,
  planDodoSync,
  publishedPriceFor,
  publishedPrices,
  type DodoRule,
  type HousePriceRow,
  type HousePublished,
} from "./house-pricing.service";

const row = (country: string, currency: string, minorAmount: number): HousePriceRow => ({
  country,
  countryName: country,
  discount: 50,
  charge: { currency, amount: minorAmount / 100, minorAmount, local: currency !== "USD" },
});
const rule = (id: string, country_code: string | null, currency: string, amount: number): DodoRule => ({ id, country_code, currency, amount });

describe("planDodoSync", () => {
  it("creates a rule for each discounted country Dodo doesn't have", () => {
    expect(planDodoSync([row("IN", "INR", 47_900), row("AR", "USD", 570)], [])).toEqual([
      { kind: "create", country: "IN", currency: "INR", amount: 47_900 },
      { kind: "create", country: "AR", currency: "USD", amount: 570 },
    ]);
  });

  it("leaves matching rules alone, updates a changed amount, and replaces a changed currency", () => {
    const actions = planDodoSync(
      [row("IN", "INR", 47_900), row("BR", "BRL", 2990), row("AR", "USD", 570)],
      [rule("r1", "IN", "INR", 47_900), rule("r2", "br", "BRL", 2490), rule("r3", "AR", "ARS", 600_000)],
    );
    expect(actions).toEqual([
      { kind: "update", ruleId: "r2", country: "BR", currency: "BRL", amount: 2990, from: 2490 },
      { kind: "replace", ruleId: "r3", country: "AR", currency: "USD", amount: 570 },
    ]);
  });

  it("archives rules for countries no longer discounted, rules without a country, and duplicates", () => {
    const actions = planDodoSync(
      [row("IN", "INR", 47_900)],
      [rule("r1", "IN", "INR", 47_900), rule("r2", "IN", "INR", 40_000), rule("r3", "DE", "EUR", 1000), rule("r4", null, "EUR", 1500)],
    );
    expect(actions).toEqual([
      { kind: "archive", ruleId: "r2", country: "IN" },
      { kind: "archive", ruleId: "r3", country: "DE" },
      { kind: "archive", ruleId: "r4", country: null },
    ]);
  });

  it("puts changes first, then new rules, then removals", () => {
    const kinds = planDodoSync(
      [row("IN", "INR", 50_000), row("BR", "BRL", 2990)],
      [rule("r1", "DE", "EUR", 1000), rule("r2", "IN", "INR", 47_900)],
    ).map((a) => a.kind);
    expect(kinds).toEqual(["update", "create", "archive"]);
  });
});

describe("compareWithDodo", () => {
  it("says per country whether Dodo charges the same, and counts rules that shouldn't be there", () => {
    const out = compareWithDodo(
      [row("IN", "INR", 47_900), row("BR", "BRL", 2990), row("AR", "USD", 570)],
      [rule("r1", "IN", "INR", 47_900), rule("r2", "BR", "BRL", 2490), rule("r3", "DE", "EUR", 1000), rule("r4", null, "EUR", 1)],
    );
    expect(out.byCountry).toEqual({
      IN: { status: "match" },
      BR: { status: "differs", currency: "BRL", amount: 2490 },
      AR: { status: "missing" },
    });
    expect(out.extraRules).toBe(2);
  });
});

describe("scheduling and availability", () => {
  it("syncs in the first 10-minute run of hours 1, 7, 13 and 19 UTC (after the :40 rate refresh)", () => {
    expect(isHouseSyncRun(Date.UTC(2026, 10, 24, 1, 0))).toBe(true);
    expect(isHouseSyncRun(Date.UTC(2026, 10, 24, 7, 9, 59))).toBe(true);
    expect(isHouseSyncRun(Date.UTC(2026, 10, 24, 7, 10))).toBe(false);
    expect(isHouseSyncRun(Date.UTC(2026, 10, 24, 6, 0))).toBe(false);
  });

  it("is unavailable when self-hosted or when Dodo isn't set up", () => {
    const base = { DODO_API_KEY: "dodo_test_FAKE", DODO_PRICE_ID_PRO_MONTHLY: "pdt_FAKE" } as Parameters<typeof houseSyncUnavailable>[0];
    expect(houseSyncUnavailable(base)).toBeNull();
    expect(houseSyncUnavailable({ ...base, SELF_HOSTED: "true" })).toMatch(/Self-hosted/);
    expect(houseSyncUnavailable({ ...base, DODO_PRICE_ID_PRO_MONTHLY: undefined })).toMatch(/isn't set up/);
  });

  it("describes a refused Dodo call in one short line", () => {
    expect(dodoErrorMessage({ status: 409, body: { message: "Active rule\nalready exists" } })).toBe(
      "Dodo answered 409: Active rule already exists",
    );
    expect(dodoErrorMessage({ status: 500, body: null })).toBe("Dodo answered 500");
    expect(dodoErrorMessage({ status: 422, body: "x".repeat(500) })).toHaveLength("Dodo answered 422: ".length + 200);
  });
});

describe("publishedPrices", () => {
  it("lists what Dodo charges per country, with the discount when the amount is the one written for it", () => {
    const rows = [row("IN", "INR", 52_900), row("BR", "BRL", 4990)];
    const rules = [rule("r1", "IN", "INR", 52_900), rule("r2", "BR", "BRL", 3990), rule("r3", null, "EUR", 900), rule("r4", "IN", "INR", 1)];
    expect(publishedPrices(rules, rows, null)).toEqual({
      IN: { currency: "INR", minorAmount: 52_900, discount: 50 },
      // An old amount the table no longer wants is still what Dodo charges.
      BR: { currency: "BRL", minorAmount: 3990, discount: null },
    });
  });

  it("keeps the earlier discount for an amount that didn't change", () => {
    const previous = { BR: { currency: "BRL", minorAmount: 3990, discount: 60 } };
    expect(publishedPrices([rule("r2", "br", "brl", 3990)], [row("BR", "BRL", 4990)], previous)).toEqual({
      BR: { currency: "BRL", minorAmount: 3990, discount: 60 },
    });
  });
});

describe("publishedPriceFor", () => {
  const published: HousePublished = {
    at: "2026-11-24T00:00:00.000Z",
    environment: "test_mode",
    productId: "pdt_FAKE",
    prices: { IN: { currency: "INR", minorAmount: 52_900, discount: 70 } },
  };
  const env = { DODO_ENVIRONMENT: "test_mode", DODO_PRICE_ID_PRO_MONTHLY: "pdt_FAKE" } as const;

  it("answers only for the Dodo mode and product the list was recorded for", () => {
    expect(publishedPriceFor(published, env, "IN")).toEqual({ currency: "INR", minorAmount: 52_900, discount: 70 });
    expect(publishedPriceFor(published, env, "US")).toBeNull();
    expect(publishedPriceFor(published, env, "constructor")).toBeNull();
    expect(publishedPriceFor(published, { ...env, DODO_ENVIRONMENT: "live_mode" }, "IN")).toBeNull();
    expect(publishedPriceFor(published, { ...env, DODO_PRICE_ID_PRO_MONTHLY: "pdt_OTHER" }, "IN")).toBeNull();
    expect(publishedPriceFor(undefined, env, "IN")).toBeNull();
  });
});

describe("chargedLocalPrice", () => {
  // Rates as on 2026-11-24: 92.867 INR, 5.935 BRL and 18,229.1 IDR per USD.
  const converted = (currencyCode: string, fxRate: number) => ({ currencyCode, fxRate, fxAsOf: "2026-11-24", localPrice: 0 });

  it("rounds the charged price down, so the stated discount is never more than the real one", () => {
    // Exact 70%-off prices: 529.34 INR, 103,905.87 IDR; 56% off: 49.62 BRL.
    expect(chargedLocalPrice(19, 70, converted("INR", 92.867), "region_aware")).toBe(529);
    expect(chargedLocalPrice(19, 70, converted("IDR", 18229.1), "region_aware")).toBe(99_000);
    expect(chargedLocalPrice(19, 56, converted("BRL", 5.935), "region_aware")).toBe(49);
    expect(chargedLocalPrice(19, 70, converted("INR", 92.867), "nearest_5")).toBe(500);
    expect(chargedLocalPrice(19, 70, converted("INR", 92.867), "none")).toBe(529.34);
  });

  it("stays within 8% under the exact price for every strategy", () => {
    for (const strategy of CHARM_STRATEGIES) {
      for (const [code, rate, discount] of [["INR", 92.867, 70], ["BRL", 5.935, 56], ["IDR", 18229.1, 70], ["MXN", 19.24, 48], ["PLN", 4.07, 35]] as const) {
        const exact = 19 * (1 - discount / 100) * rate;
        const charged = chargedLocalPrice(19, discount, converted(code, rate), strategy)!;
        expect(charged, `${strategy} ${code}`).toBeLessThanOrEqual(exact);
        expect(charged, `${strategy} ${code}`).toBeGreaterThanOrEqual(exact * 0.92);
      }
    }
  });

  it("leaves a price in the product's own currency as the config endpoint gave it", () => {
    expect(chargedLocalPrice(19, 70, { currencyCode: "USD", fxRate: 1, localPrice: 5.7 }, "region_aware")).toBe(5.7);
  });
});
