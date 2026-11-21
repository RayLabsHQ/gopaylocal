// Test fixture (not exported from the package): real rates, so the worked examples
// in tests, docs and landing copy are reproducible.
//
// A subset of fawazahmed0/exchange-api
// https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@2026-11-18/v1/currencies/usd.json
// (CC0 1.0), "date": "2026-11-18", upper-cased.

import type { FxRatesDoc } from "./fx";

export const FIXTURE_RATES_2026_11_18: Record<string, number> = {
  USD: 1,
  INR: 93.32614706,
  BRL: 5.77828238,
  NGN: 1350.55082508,
  PKR: 276.41190323,
  BDT: 124.78644117,
  EGP: 53.73934758,
  VND: 25687.00391491,
  IDR: 18263.97004598,
  TRY: 50.43278606,
  ARS: 1552.2114862,
  EUR: 0.91080569,
  GBP: 0.75809074,
  JPY: 159.29003817,
  KWD: 0.31163423,
  MXN: 18.45420564,
  PHP: 63.7283752,
  KES: 130.00517288,
  UAH: 45.20838848,
  ZAR: 16.96902142,
  COP: 3307.41731781,
};

/** 2026-11-19T12:00:00Z: 36 hours after the fixture's date, well inside 96 h. */
export const FIXTURE_NOW = Date.parse("2026-11-19T12:00:00Z");

export function fixtureFxDoc(overrides: Partial<FxRatesDoc> = {}): FxRatesDoc {
  return {
    v: 1,
    base: "USD",
    asOf: "2026-11-18",
    fetchedAt: "2026-11-18T06:40:00.000Z",
    source: "primary",
    rates: { ...FIXTURE_RATES_2026_11_18 },
    held: [],
    ...overrides,
  };
}
