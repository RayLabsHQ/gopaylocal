import { describe, expect, it } from "vitest";
import {
  compareWithDodo,
  dodoErrorMessage,
  houseSyncUnavailable,
  isHouseSyncRun,
  planDodoSync,
  type DodoRule,
  type HousePriceRow,
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
