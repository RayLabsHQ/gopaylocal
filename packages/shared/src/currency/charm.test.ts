import { describe, expect, it } from "vitest";
import { CHARM_MAX_DEVIATION, CHARM_STRATEGIES, charm, charmCandidates, isCharmStrategy, roundForDisplay, roundToMinorUnit, type CharmStrategy } from "./charm";
import { WHOLE_UNIT_DISPLAY_CURRENCIES, displayFractionDigits, minorUnitExponent } from "./exponents";

// [currency, estimate, none, dot99, round_x9, nearest_5, region_aware] for "up".
const UP_TABLE: Array<[string, number, number, number, number, number, number]> = [
  ["INR", 638.1, 638.1, 638.99, 639, 650, 639],
  ["INR", 1583.75, 1583.75, 1583.99, 1599, 1600, 1599],
  ["INR", 1500, 1500, 1500.99, 1599, 1500, 1599],
  ["INR", 5751.9, 5751.9, 5751.99, 5799, 6000, 5799],
  ["INR", 150, 150, 150.99, 159, 150, 159],
  ["INR", 100.5, 100.5, 100.99, 100.99, 105, 100.99],
  ["USD", 101, 101, 101.99, 109, 105, 109],
  ["USD", 10.5, 10.5, 10.99, 10.99, 10.5, 10.99],
  ["USD", 29.2, 29.2, 29.99, 29.99, 30, 29.99],
  ["USD", 7.6, 7.6, 7.99, 7.99, 8, 7.99],
  ["USD", 19, 19, 19.99, 19, 20, 19],
  ["USD", 19.99, 19.99, 19.99, 19.99, 20, 19.99],
  ["USD", 3.2, 3.2, 3.2, 3.2, 3.2, 3.2],
  ["EUR", 17.31, 17.31, 17.99, 17.99, 17.5, 17.99],
  ["JPY", 1234.567, 1235, 1299, 1299, 1250, 1299],
  ["JPY", 1500, 1500, 1599, 1599, 1500, 1599],
  ["KRW", 13550, 13550, 13999, 13999, 14000, 13900],
  ["KRW", 500, 500, 509, 509, 500, 500],
  // IDR is shown in whole rupiah (display digits 0), so dot99 behaves like round_x9.
  ["IDR", 112345.67, 112346, 119999, 119999, 115000, 119000],
  ["IDR", 120000, 120000, 120999, 120999, 120000, 129000],
  ["VND", 250000, 250000, 259999, 259999, 250000, 259000],
  ["KWD", 5.912, 5.912, 5.99, 5.99, 6, 5.99],
];

describe("charm, rounding up (the price the visitor pays)", () => {
  for (const [cur, amount, ...expected] of UP_TABLE) {
    it(`${cur} ${amount}`, () => {
      const got = CHARM_STRATEGIES.map((s) => charm(amount, cur, s, "up"));
      expect(got).toEqual(expected);
    });
  }

  it("rounds to the currency's own minor unit (0, 2, 3 and 4 decimals)", () => {
    expect(charm(1234.4, "JPY", "none")).toBe(1235);
    expect(charm(1.2345, "KWD", "none")).toBe(1.235);
    expect(charm(0.45671, "CLF", "none")).toBe(0.4568);
    expect(charm(19.001, "USD", "none")).toBe(19.01);
  });

  it("never adds decimals to a zero-decimal currency", () => {
    for (const s of CHARM_STRATEGIES) {
      for (const amount of [1500, 25000, 999.2, 87.4]) {
        expect(Number.isInteger(charm(amount, "VND", s)!)).toBe(true);
        expect(Number.isInteger(charm(amount, "JPY", s)!)).toBe(true);
      }
    }
  });

  it("rounds to whole units in the 15 currencies shown without decimals (price-maths review F5)", () => {
    expect([...WHOLE_UNIT_DISPLAY_CURRENCIES].sort()).toEqual(
      ["AFN", "ALL", "COP", "HUF", "IDR", "IQD", "IRR", "KPW", "LAK", "LBP", "MMK", "PKR", "SOS", "SYP", "YER"],
    );
    expect(charm(1838.139, "PKR", "none")).toBe(1839);
    expect(charm(5251.826, "PKR", "none", "down")).toBe(5251);
    expect(charm(4118.247, "IQD", "none")).toBe(4119);
    expect(charm(156156.3, "IDR", "dot99")).toBe(159999);
    for (const cur of WHOLE_UNIT_DISPLAY_CURRENCIES) {
      expect(displayFractionDigits(cur)).toBe(0);
      for (const s of CHARM_STRATEGIES) {
        for (const amount of [12.34, 1838.139, 99999.5]) expect(Number.isInteger(charm(amount, cur, s)!)).toBe(true);
      }
    }
    // The ISO exponent is unchanged for provider amounts.
    expect(minorUnitExponent("PKR")).toBe(2);
    expect(roundToMinorUnit(1838.139, "PKR", "up")).toBe(1838.14);
    expect(roundForDisplay(1838.139, "PKR", "up")).toBe(1839);
    expect(roundForDisplay(11.405, "USD", "half-up")).toBe(11.41);
  });

  it("charmCandidates lists every choice tidiest first, within the 8% window, ending with the plain rounding", () => {
    expect(charmCandidates(1507.3, "INR", "round_x9", "up")).toEqual({ unit: 100, candidates: [159900, 150900, 150799, 150730] });
    expect(charmCandidates(1773.2, "INR", "round_x9", "down")).toEqual({ unit: 100, candidates: [169900, 176900, 177299, 177320] });
    expect(charmCandidates(0.004, "USD", "none", "down")).toEqual({ unit: 100, candidates: [] });
    expect(charmCandidates(638.1, "INR", "none", "up").candidates).toEqual([63810]);
  });

  it("removes binary floating-point noise before rounding", () => {
    // 19.99 * 100 is 1998.9999999999998; that must not become 20.00.
    expect(charm(19.99, "USD", "none")).toBe(19.99);
    expect(charm(0.1 + 0.2, "USD", "none")).toBe(0.3);
  });
});

describe("charm, rounding down (the struck-through original)", () => {
  it.each<[string, number, number]>([
    ["INR", 1773.1968, 1699],
    ["BRL", 109.7874, 109],
    ["IDR", 347015.4309, 339999],
    ["NGN", 25660.4657, 24999],
    ["EUR", 17.3053, 16.99],
    ["VND", 488053.0744, 479999],
  ])("round_x9 %s %d -> %d", (cur, amount, expected) => {
    expect(charm(amount, cur, "round_x9", "down")).toBe(expected);
  });

  it("none floors to the minor unit", () => {
    expect(charm(1773.1968, "INR", "none", "down")).toBe(1773.19);
    expect(charm(1234.9, "JPY", "none", "down")).toBe(1234);
  });
});

describe("charm, invalid input", () => {
  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])("returns null for %d", (amount) => {
    expect(charm(amount, "USD", "round_x9")).toBeNull();
  });

  it("returns null when rounding down reaches zero", () => {
    expect(charm(0.004, "USD", "none", "down")).toBeNull();
  });

  it("returns null above 1e12 minor units", () => {
    expect(charm(2e10, "USD", "none")).toBeNull();
  });

  it("treats an unknown strategy as none", () => {
    expect(charm(638.1, "INR", "bogus" as CharmStrategy)).toBe(638.1);
  });
});

describe("isCharmStrategy", () => {
  it("accepts exactly the five strategies", () => {
    for (const s of CHARM_STRATEGIES) expect(isCharmStrategy(s)).toBe(true);
    expect(isCharmStrategy("round_down")).toBe(false);
    expect(isCharmStrategy(undefined)).toBe(false);
  });
});

describe("roundToMinorUnit", () => {
  it("rounds up, down and half-up in minor units", () => {
    expect(roundToMinorUnit(11.405, "USD", "up")).toBe(11.41);
    expect(roundToMinorUnit(11.405, "USD", "down")).toBe(11.4);
    expect(roundToMinorUnit(11.405, "USD", "half-up")).toBe(11.41);
    expect(roundToMinorUnit(11.4, "USD", "half-up")).toBe(11.4);
    expect(roundToMinorUnit(1499.5, "JPY", "half-up")).toBe(1500);
    expect(roundToMinorUnit(-1, "USD", "up")).toBeNull();
  });
});

// Deterministic pseudo-random numbers so a failure is reproducible.
function lcg(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };
}

describe("charm guarantees (seeded property test)", () => {
  const currencies = ["USD", "INR", "JPY", "KRW", "IDR", "VND", "KWD", "EUR", "NGN", "BRL"];
  const rnd = lcg(42);
  // 1e-6 of a display unit: the floating-point noise toMinor() removes.
  const tolerance = (cur: string) => 1e-6 / 10 ** displayFractionDigits(cur);
  const failures: string[] = [];

  for (let i = 0; i < 20_000; i++) {
    const cur = currencies[i % currencies.length]!;
    const unit = 10 ** displayFractionDigits(cur);
    const base = Math.exp(rnd() * 14 - 1); // ~0.4 to ~440,000 major units
    const discount = Math.floor(rnd() * 80) + 1;
    const pay = base * (1 - discount / 100);
    for (const s of CHARM_STRATEGIES) {
      const p = charm(pay, cur, s, "up");
      const o = charm(base, cur, s, "down");
      if (p === null) {
        failures.push(`up null ${cur} ${pay} ${s}`);
        continue;
      }
      if (p < pay - tolerance(cur)) failures.push(`below estimate ${cur} ${pay} ${s} -> ${p}`);
      if (pay * unit >= 13 && p > pay * (1 + CHARM_MAX_DEVIATION) + tolerance(cur)) failures.push(`over 8% ${cur} ${pay} ${s} -> ${p}`);
      if (Math.abs(Math.round(p * unit) - p * unit) > 1e-6 * Math.max(1, p * unit)) failures.push(`not whole display units ${cur} ${p}`);
      if (o === null) continue; // only for originals below one minor unit
      if (o > base + tolerance(cur)) failures.push(`original above estimate ${cur} ${base} ${s} -> ${o}`);
      if (base * unit >= 13 && o < base * (1 - CHARM_MAX_DEVIATION) - tolerance(cur)) failures.push(`original over 8% below ${cur} ${base} ${s} -> ${o}`);
      if (1 - p / o > discount / 100 + 1e-12) failures.push(`implied discount above coupon ${cur} ${base} ${discount}% ${s}: ${p}/${o}`);
    }
  }

  it("up: never below the estimate, at most 8% above; down: never above, at most 8% below; shown discount never above the coupon", () => {
    expect(failures.slice(0, 10)).toEqual([]);
  });
});
