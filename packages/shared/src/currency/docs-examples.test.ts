// Every price example quoted in the docs and the landing pages comes from this
// file. Change an example here first, then copy the number into the page; a page
// must never show a price this file does not produce.
//
// Rates: fawazahmed0/exchange-api for 2026-11-18 (./fx-test-fixture.ts).
//
// Quoted in: apps/docs/src/content/docs/guides/multi-currency.mdx,
// guides/charm-pricing.mdx, api/banner.mdx, getting-started/introduction.mdx,
// and apps/web/src/lib/landing-data.ts / use-case-data.ts.

import { describe, expect, it } from "vitest";
import { CHARM_STRATEGIES, charm, type CharmStrategy } from "./charm";
import { FIXTURE_NOW, fixtureFxDoc } from "./fx-test-fixture";
import { localPricing } from "./local-price";

const fx = fixtureFxDoc();
const price = (basePrice: number, discountPercent: number, country: string, strategy: CharmStrategy, baseCurrency = "USD") =>
  localPricing({ basePrice, baseCurrency, discountPercent, country, strategy, fx, now: FIXTURE_NOW })!;

describe("docs: a $19 product with round_x9, by visitor country", () => {
  it.each<[string, number, string, number, number]>([
    ["IN", 60, "INR", 719, 1769],
    ["BR", 50, "BRL", 54.99, 109],
    ["NG", 65, "NGN", 8999, 24999],
    ["ID", 55, "IDR", 159999, 346999],
    ["DE", 20, "EUR", 13.99, 17.3],
  ])("%s at %d%% off -> %s %d (was %d)", (country, discount, currency, local, original) => {
    const r = price(19, discount, country, "round_x9");
    expect([r.currencyCode, r.localPrice, r.localOriginalPrice, r.fxAsOf]).toEqual([currency, local, original, "2026-11-18"]);
  });

  it.each<[string, number, number]>([
    ["IN", 60, 59.4],
    ["BR", 50, 49.6],
    ["NG", 65, 64.0],
    ["ID", 55, 53.9],
    ["DE", 20, 19.1],
  ])("%s: the two prices imply %d%% -> %d%%, never more than the coupon nor more than 2 points less", (country, discount, implied) => {
    const r = price(19, discount, country, "round_x9");
    const shown = (1 - r.localPrice / r.localOriginalPrice) * 100;
    expect(Math.round(shown * 10) / 10).toBe(implied);
    expect(shown).toBeLessThanOrEqual(discount);
    expect(shown).toBeGreaterThanOrEqual(Math.max(discount - 2, discount * 0.8));
  });

  it("the worked example: 1 USD = 93.32614706 INR, $7.60 -> ₹709.28 -> ₹719, $19 -> ₹1,773.20 -> ₹1,769 (₹1,699 would imply only 57.7%)", () => {
    const r = price(19, 60, "IN", "round_x9");
    expect(r.fxRate).toBe(93.32614706);
    expect((19 * (1 - 60 / 100) * r.fxRate).toFixed(2)).toBe("709.28");
    expect((19 * r.fxRate).toFixed(2)).toBe("1773.20");
    expect([r.localPrice, r.localOriginalPrice]).toEqual([719, 1769]);
    expect(Math.round((1 - 719 / 1699) * 1000) / 10).toBe(57.7);
  });
});

describe("docs: the same $19 product without a conversion", () => {
  it("a US visitor at 60% off sees exactly $7.60 (was $19)", () => {
    const r = price(19, 60, "US", "round_x9");
    expect([r.currencyCode, r.localPrice, r.localOriginalPrice, r.fxRate, r.fxAsOf]).toEqual(["USD", 7.6, 19, 1, undefined]);
  });

  it("a Nigerian visitor at 65% off with stale rates sees exactly $6.65 (was $19)", () => {
    const r = localPricing({ basePrice: 19, baseCurrency: "USD", discountPercent: 65, country: "NG", strategy: "round_x9", fx: fixtureFxDoc({ asOf: "2026-11-10" }), now: FIXTURE_NOW })!;
    expect([r.currencyCode, r.localPrice, r.localOriginalPrice, r.fxAsOf]).toEqual(["USD", 6.65, 19, undefined]);
  });
});

describe("docs: a $19.99 product at 40% off for an Indian visitor, by strategy", () => {
  const expected: Record<CharmStrategy, [number, number]> = {
    none: [1119.36, 1865.58],
    dot99: [1119.99, 1864.99],
    round_x9: [1129, 1859],
    nearest_5: [1150, 1865.58],
    region_aware: [1129, 1859],
  };
  for (const s of CHARM_STRATEGIES) {
    it(`${s}: ₹${expected[s][0]} (was ₹${expected[s][1]})`, () => {
      const r = price(19.99, 40, "IN", s);
      expect([r.localPrice, r.localOriginalPrice]).toEqual(expected[s]);
    });
  }
});

describe("docs: api/banner.mdx response example", () => {
  it("$19 at 30% off, round_x9, Indian visitor -> ₹1,249 (was ₹1,769), fxRate 93.32614706", () => {
    const r = price(19, 30, "IN", "round_x9");
    expect(r).toEqual({
      baseCurrencyCode: "USD",
      baseCurrencySymbol: "$",
      currencyCode: "INR",
      currencySymbol: "₹",
      fxRate: 93.32614706,
      fxAsOf: "2026-11-18",
      localPrice: 1249,
      localOriginalPrice: 1769,
    });
  });
});

describe("docs: a EUR product", () => {
  it("€20 at 60% off for an Indian visitor -> ₹829 (was ₹1,999), fxRate 102.4654853", () => {
    const r = price(20, 60, "IN", "round_x9", "EUR");
    expect([r.fxRate, r.localPrice, r.localOriginalPrice]).toEqual([102.4654853, 829, 1999]);
  });
});

describe("docs and landing: single charm roundings", () => {
  it("₹1,583.75 rounds up to ₹1,599 (round_x9), never down to ₹1,499", () => {
    expect(charm(1583.75, "INR", "round_x9")).toBe(1599);
  });

  it("KRW 13,550 -> ₩13,900 and IDR 112,345.67 -> Rp119.000 (region_aware)", () => {
    expect(charm(13550, "KRW", "region_aware")).toBe(13900);
    expect(charm(112345.67, "IDR", "region_aware")).toBe(119000);
  });
});

describe("docs: guides/charm-pricing.mdx strategy table (rounding up)", () => {
  // [currency, converted price, none, dot99, round_x9, nearest_5, region_aware]
  it.each<[string, number, number, number, number, number, number]>([
    ["INR", 1583.75, 1583.75, 1583.99, 1599, 1600, 1599],
    ["USD", 29.2, 29.2, 29.99, 29.99, 30, 29.99],
    ["JPY", 1234.57, 1235, 1299, 1299, 1250, 1299],
    ["KRW", 13550, 13550, 13999, 13999, 14000, 13900],
    // IDR prices are shown in whole rupiah, so dot99 behaves like round_x9 there.
    ["IDR", 112345.67, 112346, 119999, 119999, 115000, 119000],
    ["KWD", 5.912, 5.912, 5.99, 5.99, 6, 5.99],
  ])("%s %d", (currency, amount, ...expected) => {
    expect(CHARM_STRATEGIES.map((s) => charm(amount, currency, s, "up"))).toEqual(expected);
  });

  it("the pattern examples: round_x9 29, 639, 1,599, 12,999, 119,999; nearest_5 30, 650, 1,600, 115,000", () => {
    expect([27, 638.1, 1583.75].map((v) => charm(v, "INR", "round_x9"))).toEqual([29, 639, 1599]);
    expect(charm(12100, "JPY", "round_x9")).toBe(12999);
    expect(charm(112345.67, "IDR", "round_x9")).toBe(119999);
    expect(charm(29.2, "USD", "nearest_5")).toBe(30);
    expect([638.1, 1583.75].map((v) => charm(v, "INR", "nearest_5"))).toEqual([650, 1600]);
    expect(charm(112345.67, "IDR", "nearest_5")).toBe(115000);
  });
});

describe("landing: $59.99 at 30% off for an Indian visitor", () => {
  it("shows ₹3,999 (was ₹5,589) with round_x9", () => {
    const r = price(59.99, 30, "IN", "round_x9");
    expect([r.localPrice, r.localOriginalPrice]).toEqual([3999, 5589]);
  });
});

describe("price-maths review F6: the five examples that implied far less than the coupon", () => {
  // Before: ₴950/₴1,000 (5.0%), ₦95,000/₦100,000 (5.0%), ₹1,599/₹1,699 (5.9%),
  // ₹2,000/₹2,500 (20.0%), ₴450/₴500 (10.0%).
  it.each<[number, number, string, CharmStrategy, string, number, number]>([
    [24, 17, "UA", "nearest_5", "UAH", 905, 1085],
    [79, 14, "NG", "nearest_5", "NGN", 92000, 105000],
    [19, 15, "IN", "round_x9", "INR", 1509, 1769],
    [29, 31, "IN", "nearest_5", "INR", 1900, 2700],
    [12, 23, "UA", "nearest_5", "UAH", 420, 540],
  ])("$%d at %d%% off in %s (%s) -> %s %d instead of %d", (basePrice, discount, country, strategy, currency, local, original) => {
    const r = price(basePrice, discount, country, strategy);
    expect([r.currencyCode, r.localPrice, r.localOriginalPrice]).toEqual([currency, local, original]);
    const implied = (1 - local / original) * 100;
    expect(implied).toBeGreaterThanOrEqual(Math.max(discount - 2, discount * 0.8));
    expect(implied).toBeLessThanOrEqual(discount);
  });
});

describe("price-maths review F5: what a visitor sees is the number in the JSON", () => {
  it("$19 at 65% for a Pakistani visitor: PKR 1,839 instead of PKR 5,251 (whole rupees)", () => {
    const r = price(19, 65, "PK", "none");
    expect([r.currencyCode, r.localPrice, r.localOriginalPrice]).toEqual(["PKR", 1839, 5251]);
  });

  it("$19 at 55% for an Indonesian visitor: Rp159,999 instead of Rp346,999 (no .99 ending in IDR)", () => {
    const r = price(19, 55, "ID", "round_x9");
    expect([r.localPrice, r.localOriginalPrice]).toEqual([159999, 346999]);
  });
});

describe("docs: the edges of conversion (multi-currency.mdx, api/banner.mdx)", () => {
  it("100% off converts: an Indian visitor sees ₹0 (was ₹1,699)", () => {
    const r = price(19, 100, "IN", "round_x9");
    expect([r.currencyCode, r.localPrice, r.localOriginalPrice, r.fxAsOf]).toEqual(["INR", 0, 1699, "2026-11-18"]);
  });

  it("$2.44 at 1% for a UK visitor: the two pound prices would be equal, so the exact $2.42 (was $2.44)", () => {
    const r = price(2.44, 1, "GB", "none");
    expect([r.currencyCode, r.localPrice, r.localOriginalPrice, r.fxAsOf]).toEqual(["USD", 2.42, 2.44, undefined]);
  });
});
