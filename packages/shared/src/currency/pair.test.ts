import { describe, expect, it } from "vitest";
import { CHARM_MAX_DEVIATION, CHARM_STRATEGIES, type CharmStrategy } from "./charm";
import { displayFractionDigits } from "./exponents";
import { FIXTURE_RATES_2026_11_18 } from "./fx-test-fixture";
import { IMPLIED_DISCOUNT_MAX_SHORTFALL, IMPLIED_DISCOUNT_MIN_SHARE, clampDiscount, pricePair } from "./pair";

const inr = (strategy: CharmStrategy = "round_x9") => ({ currency: "INR", fxRate: 93.32614706, strategy });

describe("pricePair, the exact pair", () => {
  it("without a conversion: half-up in the base currency", () => {
    expect(pricePair(19.99, 40, "USD", null)).toEqual({ price: 11.99, original: 19.99, currencyCode: "USD", converted: false });
  });

  it("the exact pair keeps ISO digits even in a currency shown without decimals; a converted one is whole", () => {
    expect(pricePair(5251.83, 65, "PKR", null)).toEqual({ price: 1838.14, original: 5251.83, currencyCode: "PKR", converted: false });
    expect(pricePair(19, 65, "USD", { currency: "PKR", fxRate: 276.4119032, strategy: "none" })).toEqual({
      price: 1839,
      original: 5251,
      currencyCode: "PKR",
      converted: true,
    });
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])("an unusable fxRate (%d) gives the exact pair", (fxRate) => {
    expect(pricePair(19, 60, "USD", { ...inr(), fxRate })).toEqual({ price: 7.6, original: 19, currencyCode: "USD", converted: false });
  });

  it("clamps the discount to 0-100 and reads non-finite as 0", () => {
    expect([clampDiscount(150), clampDiscount(-5), clampDiscount(Number.NaN), clampDiscount(37.5)]).toEqual([100, 0, 0, 37.5]);
    expect(pricePair(19, 150, "USD", null).price).toBe(0);
  });

  it("a 0% discount has no valid converted pair (the paid price cannot be below the original), so it is exact", () => {
    expect(pricePair(19, 0, "USD", inr())).toEqual({ price: 19, original: 19, currencyCode: "USD", converted: false });
  });
});

describe("pricePair, the converted pair", () => {
  it("takes the tidiest pair that meets every rule", () => {
    expect(pricePair(19, 60, "USD", inr())).toEqual({ price: 719, original: 1769, currencyCode: "INR", converted: true });
    expect(pricePair(19.99, 40, "USD", inr("dot99"))).toEqual({ price: 1119.99, original: 1864.99, currencyCode: "INR", converted: true });
  });

  it("a free plan is free in every currency", () => {
    expect(pricePair(0, 30, "USD", inr())).toEqual({ price: 0, original: 0, currencyCode: "INR", converted: true });
  });

  it("100% off: 0 next to the tidiest converted original", () => {
    expect(pricePair(19, 100, "USD", inr())).toEqual({ price: 0, original: 1699, currencyCode: "INR", converted: true });
  });

  it("price-maths review F4: every crossing case from the review gives the exact pair", () => {
    const cases: Array<[number, string, number, CharmStrategy]> = [
      [0.5, "EUR", FIXTURE_RATES_2026_11_18.EUR!, "round_x9"],
      [0.01, "JPY", FIXTURE_RATES_2026_11_18.JPY!, "none"],
      [0.99, "JPY", FIXTURE_RATES_2026_11_18.JPY!, "round_x9"],
      [1.18, "JPY", FIXTURE_RATES_2026_11_18.JPY!, "none"],
      [2.44, "GBP", FIXTURE_RATES_2026_11_18.GBP!, "none"],
      [0.01, "KWD", FIXTURE_RATES_2026_11_18.KWD!, "none"],
    ];
    for (const [amount, currency, fxRate, strategy] of cases) {
      const r = pricePair(amount, 1, "USD", { currency, fxRate, strategy });
      expect({ amount, currency, converted: r.converted, currencyCode: r.currencyCode }).toEqual({ amount, currency, converted: false, currencyCode: "USD" });
    }
  });

  it("the plain pair is used when no charm pair implies enough, even if it implies a little less (tiny prices)", () => {
    // $0.30 at 10% in EUR: €0.2459 up is €0.25, €0.2732 down is €0.27: 7.4% < 8% floor, still shown.
    expect(pricePair(0.3, 10, "USD", { currency: "EUR", fxRate: FIXTURE_RATES_2026_11_18.EUR!, strategy: "round_x9" })).toEqual({
      price: 0.25,
      original: 0.27,
      currencyCode: "EUR",
      converted: true,
    });
  });
});

// Price-maths review F6: a sweep over realistic prices, discounts, strategies and
// currencies. Every converted pair keeps rules 1-3 and the new floor; nothing
// realistic falls back to the exact pair.
describe("pricePair sweep: realistic prices in 30 currencies", () => {
  const extra: Record<string, number> = {
    AFN: 70.1, ALL: 92.4, HUF: 361.2, IQD: 1310.5, IRR: 1050000, LBP: 89500, LAK: 21800, MMK: 2099.7,
    KRW: 1381.4, CLP: 941.2, CHF: 0.8012, BHD: 0.376, OMR: 0.3845, JOD: 0.709, XOF: 597.5, CAD: 1.38,
  };
  const rates: Record<string, number> = { ...FIXTURE_RATES_2026_11_18, ...extra };
  delete rates.USD;
  const currencies = Object.keys(rates).sort();
  const prices = [0.99, 1.99, 4.99, 9, 12, 19, 24, 29, 39, 49, 79, 99, 149, 199, 499, 999, 2499];
  const discounts = [5, 10, 14, 15, 17, 20, 23, 25, 30, 31, 35, 40, 45, 50, 55, 60, 65, 70, 75, 80, 85, 90];
  const failures: string[] = [];
  const plainShort: string[] = [];
  let checked = 0;

  for (const currency of currencies) {
    const fxRate = rates[currency]!;
    const unit = 10 ** displayFractionDigits(currency);
    for (const amount of prices) {
      for (const d of discounts) {
        for (const strategy of CHARM_STRATEGIES) {
          const r = pricePair(amount, d, "USD", { currency, fxRate, strategy });
          const tag = `${currency} $${amount} ${d}% ${strategy} -> ${r.price}/${r.original}`;
          checked++;
          if (!r.converted) {
            failures.push(`exact: ${tag}`);
            continue;
          }
          const p = amount * (1 - d / 100) * fxRate;
          const o = amount * fxRate;
          const tol = 1e-6 / unit;
          const implied = (1 - r.price / r.original) * 100;
          if (r.price < p - tol) failures.push(`paid below exact: ${tag}`);
          if (p * unit >= 13 && r.price > p * (1 + CHARM_MAX_DEVIATION) + tol) failures.push(`paid over 8%: ${tag}`);
          if (r.original > o + tol) failures.push(`original above exact: ${tag}`);
          if (o * unit >= 13 && r.original < o * (1 - CHARM_MAX_DEVIATION) - tol) failures.push(`original over 8% below: ${tag}`);
          if (!(r.price < r.original)) failures.push(`crossed: ${tag}`);
          if (implied > d + 1e-9) failures.push(`implies more than the coupon: ${tag}`);
          if (implied < Math.max(d - IMPLIED_DISCOUNT_MAX_SHORTFALL, d * IMPLIED_DISCOUNT_MIN_SHARE) - 1e-9) {
            // Allowed only for the plain pair (no charm pair met the floor), which
            // happens at prices of a few dozen display units.
            const plain = Math.ceil(Math.round(p * unit * 1e6) / 1e6) === Math.round(r.price * unit) &&
              Math.floor(Math.round(o * unit * 1e6) / 1e6) === Math.round(r.original * unit);
            if (plain) plainShort.push(tag);
            else failures.push(`implies too little (${implied.toFixed(2)}%): ${tag}`);
          }
          for (const v of [r.price, r.original]) {
            if (Math.abs(Math.round(v * unit) - v * unit) > 1e-6 * Math.max(1, v * unit)) failures.push(`not whole display units: ${tag}`);
          }
        }
      }
    }
  }

  it("covers at least 20 currencies and every strategy", () => {
    expect(currencies.length).toBeGreaterThanOrEqual(20);
    expect(checked).toBe(currencies.length * prices.length * discounts.length * CHARM_STRATEGIES.length);
  });

  it("every pair keeps the 8% windows, never crosses, and implies between max(d - 2, 0.8 d) and d", () => {
    expect(failures.slice(0, 10)).toEqual([]);
  });

  it("only the plain pair of a sub-dollar price may imply a little less than the floor", () => {
    // CHF 0.76 / 0.79 for $0.99 at 5% (3.8% against a 4% floor), in every strategy.
    expect(plainShort).toEqual(CHARM_STRATEGIES.map((s) => `CHF $0.99 5% ${s} -> 0.76/0.79`));
  });
});
