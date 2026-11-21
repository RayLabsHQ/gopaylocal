import { describe, it, expect } from "vitest";
import {
  FOUR_DECIMAL_CURRENCIES,
  THREE_DECIMAL_CURRENCIES,
  ZERO_DECIMAL_CURRENCIES,
  minorToMajor,
  minorUnitExponent,
  normalizeCurrency,
} from "./currency";
import { ZERO_DECIMAL } from "../services/redemption.service";

describe("minorUnitExponent (ISO 4217)", () => {
  it("is 2 for ordinary currencies, case-insensitively", () => {
    for (const c of ["USD", "usd", " Eur ", "INR", "BRL", "GBP", "MRU"]) {
      expect(minorUnitExponent(c), c).toBe(2);
    }
  });

  it("is 0 for zero-decimal currencies, including ISK and UGX", () => {
    // ISK and UGX were missing from the old redemption ZERO_DECIMAL list, so a
    // 1000 ISK discount was recorded as 10.
    for (const c of ["JPY", "KRW", "VND", "CLP", "ISK", "UGX", "XOF", "MGA"]) {
      expect(minorUnitExponent(c), c).toBe(0);
    }
  });

  it("is 3 for the three-decimal dinars and rials", () => {
    for (const c of ["KWD", "BHD", "OMR", "JOD", "TND", "IQD", "LYD"]) {
      expect(minorUnitExponent(c), c).toBe(3);
    }
  });

  it("is 4 for the unidad de fomento and unidad previsional", () => {
    expect(minorUnitExponent("CLF")).toBe(4);
    expect(minorUnitExponent("UYW")).toBe(4);
  });

  it("falls back to 2 for missing or malformed codes", () => {
    for (const c of [null, undefined, "", "US", "USDD", "12$"]) {
      expect(minorUnitExponent(c), String(c)).toBe(2);
    }
  });

  it("keeps the exponent sets disjoint", () => {
    for (const c of ZERO_DECIMAL_CURRENCIES) {
      expect(THREE_DECIMAL_CURRENCIES.has(c) || FOUR_DECIMAL_CURRENCIES.has(c), c).toBe(false);
    }
    for (const c of THREE_DECIMAL_CURRENCIES) expect(FOUR_DECIMAL_CURRENCIES.has(c), c).toBe(false);
  });
});

describe("minorToMajor", () => {
  it("divides two-decimal amounts by 100", () => {
    expect(minorToMajor(1999, "USD")).toBeCloseTo(19.99, 10);
    expect(minorToMajor(1999, "eur")).toBeCloseTo(19.99, 10);
  });

  it("leaves zero-decimal amounts alone", () => {
    expect(minorToMajor(500, "JPY")).toBe(500);
    expect(minorToMajor(1000, "ISK")).toBe(1000);
  });

  it("divides three-decimal amounts by 1000 (1500 KWD minor = 1.5 KD, not 15)", () => {
    expect(minorToMajor(1500, "KWD")).toBeCloseTo(1.5, 10);
    expect(minorToMajor(12345, "BHD")).toBeCloseTo(12.345, 10);
  });

  it("divides four-decimal amounts by 10000", () => {
    expect(minorToMajor(12345, "CLF")).toBeCloseTo(1.2345, 10);
  });

  it("treats an unknown currency as two-decimal", () => {
    expect(minorToMajor(250, null)).toBeCloseTo(2.5, 10);
  });
});

describe("normalizeCurrency", () => {
  it("upper-cases and trims 3-letter codes", () => {
    expect(normalizeCurrency(" usd ")).toBe("USD");
    expect(normalizeCurrency("Jpy")).toBe("JPY");
  });

  it("rejects anything that isn't a 3-letter code", () => {
    expect(normalizeCurrency("")).toBeNull();
    expect(normalizeCurrency("US")).toBeNull();
    expect(normalizeCurrency("U$D")).toBeNull();
    expect(normalizeCurrency(null)).toBeNull();
    expect(normalizeCurrency(undefined)).toBeNull();
  });
});

describe("ZERO_DECIMAL re-export", () => {
  it("is the same table adapters use (paddle.ts imports it from redemption.service)", () => {
    expect(ZERO_DECIMAL).toBe(ZERO_DECIMAL_CURRENCIES);
  });
});
