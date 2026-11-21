import { describe, expect, it } from "vitest";
import type { CharmStrategy } from "./charm";
import { FX_MAX_AGE_HOURS } from "./fx";
import { FIXTURE_NOW, fixtureFxDoc } from "./fx-test-fixture";
import { currencyForCountry, localPricing, type LocalPricingInput } from "./local-price";

const base = (overrides: Partial<LocalPricingInput> = {}): LocalPricingInput => ({
  basePrice: 19,
  baseCurrency: "USD",
  discountPercent: 60,
  country: "IN",
  strategy: "round_x9" as CharmStrategy,
  fx: fixtureFxDoc(),
  now: FIXTURE_NOW,
  ...overrides,
});

describe("localPricing, converted estimate", () => {
  it("converts, rounds the paid price up and the original down, and dates the estimate", () => {
    expect(localPricing(base())).toEqual({
      baseCurrencyCode: "USD",
      baseCurrencySymbol: "$",
      currencyCode: "INR",
      currencySymbol: "₹",
      fxRate: 93.32614706,
      localPrice: 719,
      localOriginalPrice: 1769, // ₹1,699 would imply 57.7%, under the 58% floor
      fxAsOf: "2026-11-18",
    });
  });

  it("crosses through USD for a product in another currency", () => {
    const r = localPricing(base({ basePrice: 20, baseCurrency: "EUR" }))!;
    // 93.32614706 / 0.91080569, to 10 significant digits.
    expect(r.fxRate).toBe(102.4654853);
    expect([r.baseCurrencyCode, r.baseCurrencySymbol, r.currencyCode]).toEqual(["EUR", "€", "INR"]);
    expect([r.localPrice, r.localOriginalPrice]).toEqual([829, 1999]);
  });

  it("computes from the rounded fxRate it returns, so the SDKs reproduce it from the response", () => {
    const r = localPricing(base({ country: "NG", discountPercent: 65, strategy: "none" }))!;
    expect(r.fxRate).toBe(1350.550825);
    expect(r.localPrice).toBe(Math.ceil(19 * (1 - 65 / 100) * r.fxRate * 100) / 100);
  });

  it("searches finer pairs when the tidiest would cross or imply too little", () => {
    // 1% off: 1,755.47 rounds up to 1,799 while 1,773.20 rounds down to 1,699
    // (they cross); 1,759 / 1,772.99 implies 0.79%, under the 0.8% floor.
    const r = localPricing(base({ discountPercent: 1 }))!;
    expect([r.localPrice, r.localOriginalPrice]).toEqual([1755.99, 1772.99]);
    expect(r.fxAsOf).toBe("2026-11-18");
  });

  it("price-maths review F4: a pair that still crosses after the plain rounding gives the exact price", () => {
    // $2.44 at 1% in GB: £1.8312 up and £1.8497 down are both £1.84 at best.
    expect(localPricing(base({ basePrice: 2.44, discountPercent: 1, country: "GB", strategy: "none" }))).toEqual({
      baseCurrencyCode: "USD",
      baseCurrencySymbol: "$",
      currencyCode: "USD",
      currencySymbol: "$",
      fxRate: 1,
      localPrice: 2.42,
      localOriginalPrice: 2.44,
    });
    expect(localPricing(base({ basePrice: 0.5, discountPercent: 1, country: "DE" }))!.currencyCode).toBe("USD");
  });

  it("price-maths review F7b: 100% off converts to 0 next to the converted original", () => {
    expect(localPricing(base({ discountPercent: 100 }))).toMatchObject({
      currencyCode: "INR",
      fxRate: 93.32614706,
      localPrice: 0,
      localOriginalPrice: 1699,
      fxAsOf: "2026-11-18",
    });
  });

  it("normalises the product currency code", () => {
    expect(localPricing(base({ baseCurrency: " usd " }))!.baseCurrencyCode).toBe("USD");
  });
});

describe("localPricing, exact price in the product's currency", () => {
  it("shows a visitor who pays in the product's currency the exact price, with no charm", () => {
    expect(localPricing(base({ country: "US" }))).toEqual({
      baseCurrencyCode: "USD",
      baseCurrencySymbol: "$",
      currencyCode: "USD",
      currencySymbol: "$",
      fxRate: 1,
      localPrice: 7.6,
      localOriginalPrice: 19,
    });
  });

  it("rounds the exact price half-up to the minor unit", () => {
    // 19.99 * 0.6 = 11.994
    const r = localPricing(base({ country: "US", basePrice: 19.99, discountPercent: 40 }))!;
    expect([r.localPrice, r.localOriginalPrice]).toEqual([11.99, 19.99]);
  });

  // Lead's ruling on F5: whole-unit display digits apply to converted estimates
  // only. The exact case is what the provider charges, to the ISO minor unit.
  it("keeps the exact price at ISO digits in a currency shown without decimals (PKR product, Pakistani visitor)", () => {
    // PKR 5,251.83 at 65% = 1,838.1405 -> 1,838.14, as the provider charges it.
    const r = localPricing(base({ country: "PK", basePrice: 5251.83, baseCurrency: "PKR", discountPercent: 65 }))!;
    expect(r).toEqual({
      baseCurrencyCode: "PKR",
      baseCurrencySymbol: "Rs",
      currencyCode: "PKR",
      currencySymbol: "Rs",
      fxRate: 1,
      localPrice: 1838.14,
      localOriginalPrice: 5251.83,
    });
    // The lead's example: PKR 1,999.50 at 65% is charged 699.83 (699.825 rounded half up).
    const lead = localPricing(base({ country: "PK", basePrice: 1999.5, baseCurrency: "PKR", discountPercent: 65 }))!;
    expect([lead.localPrice, lead.localOriginalPrice, lead.fxAsOf]).toEqual([699.83, 1999.5, undefined]);
  });

  it("converts to whole rupees for a USD product and a Pakistani visitor with a rate", () => {
    const r = localPricing(base({ country: "PK", discountPercent: 65, strategy: "none" }))!;
    expect([r.currencyCode, r.localPrice, r.localOriginalPrice, r.fxAsOf]).toEqual(["PKR", 1839, 5251, "2026-11-18"]);
  });

  it("keeps IQD's three ISO decimals in the exact case", () => {
    const r = localPricing(base({ country: "IQ", basePrice: 6536.9, baseCurrency: "IQD", discountPercent: 37 }))!;
    expect([r.currencyCode, r.localPrice, r.localOriginalPrice]).toEqual(["IQD", 4118.247, 6536.9]);
  });

  // Price-maths review F7c: the one-cent-product edges are known and left as they
  // are (basePrice validation now refuses less than one minor unit). Pinned so a
  // change is noticed.
  it.each<[number, string, string, number, number, number]>([
    [0.01, "USD", "US", 95, 0, 0.01],
    [0.01, "USD", "US", 40, 0.01, 0.01],
    [1, "JPY", "JP", 60, 0, 1],
    [100, "JPY", "JP", 99.6, 0, 100],
    [0.5, "USD", "DE", 1, 0.5, 0.5], // F4 case: falls back to the exact pair, which rounds to equal
  ])("pins the exact answer for %d %s in %s at %d%%: %d / %d", (basePrice, baseCurrency, country, discountPercent, local, original) => {
    const r = localPricing(base({ basePrice, baseCurrency, country, discountPercent }))!;
    expect([r.currencyCode, r.localPrice, r.localOriginalPrice]).toEqual([baseCurrency, local, original]);
  });

  // The lead's rule: every case without a usable rate is answered exactly like the
  // same-currency case, field for field, with no fxAsOf.
  const sameCurrency = localPricing(base({ country: "US" }));
  const noRateCases: Array<[string, Partial<LocalPricingInput>]> = [
    ["no rates document", { fx: null }],
    ["a malformed document", { fx: { v: 2, base: "USD", asOf: "2026-11-18", rates: { USD: 1, INR: 93 } } }],
    ["a document whose USD rate is not 1", { fx: fixtureFxDoc({ rates: { USD: 2, INR: 93 } }) }],
    ["rates older than 96 hours", { fx: fixtureFxDoc({ asOf: "2026-11-14" }) }],
    ["rates dated more than a day ahead", { fx: fixtureFxDoc({ asOf: "2026-11-21" }) }],
    ["an unknown country (XX)", { country: "XX" }],
    ["Tor (T1)", { country: "T1" }],
    ["no country", { country: null }],
    ["a visitor currency missing from the rates (held or absent)", { country: "NG", fx: fixtureFxDoc({ rates: { USD: 1, INR: 93 } }) }],
    ["a product currency missing from the rates", { baseCurrency: "XYZ" }],
    ["an excluded visitor currency", { excludedCurrencies: new Set(["INR"]) }],
  ];
  for (const [name, overrides] of noRateCases) {
    it(`answers ${name} exactly like the same-currency case`, () => {
      const input = base(overrides);
      const r = localPricing(input);
      const expected =
        input.baseCurrency === "XYZ"
          ? { ...sameCurrency, baseCurrencyCode: "XYZ", baseCurrencySymbol: "XYZ", currencyCode: "XYZ", currencySymbol: "XYZ" }
          : sameCurrency;
      expect(r).toEqual(expected);
      expect(r).not.toHaveProperty("fxAsOf");
    });
  }
});

describe("localPricing, freshness boundary", () => {
  const asOfMs = Date.parse("2026-11-18T00:00:00Z");
  it("uses rates exactly 96 hours old", () => {
    expect(localPricing(base({ now: asOfMs + FX_MAX_AGE_HOURS * 3_600_000 }))!.fxAsOf).toBe("2026-11-18");
  });
  it("refuses rates one millisecond older", () => {
    expect(localPricing(base({ now: asOfMs + FX_MAX_AGE_HOURS * 3_600_000 + 1 }))!.fxAsOf).toBeUndefined();
  });
});

describe("localPricing, input guards", () => {
  it.each([0, -5, Number.NaN])("returns null for an impossible base price (%d)", (basePrice) => {
    expect(localPricing(base({ basePrice }))).toBeNull();
  });

  it("clamps the discount to 0-100", () => {
    expect(localPricing(base({ country: "US", discountPercent: 150 }))!.localPrice).toBe(0);
    expect(localPricing(base({ country: "US", discountPercent: -10 }))!.localPrice).toBe(19);
  });
});

describe("currencyForCountry", () => {
  it("looks up ISO country codes, case-insensitively", () => {
    expect(currencyForCountry("in")).toBe("INR");
    expect(currencyForCountry("BG")).toBe("EUR");
    expect(currencyForCountry("XX")).toBeNull();
    expect(currencyForCountry("constructor")).toBeNull();
    expect(currencyForCountry(undefined)).toBeNull();
  });
});
