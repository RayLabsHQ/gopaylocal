import { describe, expect, it } from "vitest";
import { COUNTRY_NAMES } from "../constants";
import { PPP_MULTIPLIERS } from "../parity";
import { COUNTRY_CURRENCY, COUNTRY_CURRENCY_CLDR_VERSION } from "./country-currency";
import { normalizeCurrency } from "./exponents";

// Euro area members as of 2026, Bulgaria included (joined 1 January 2026; euro the
// sole legal tender from 1 February 2026, per the ECB changeover page).
const EURO_AREA = [
  "AT", "BE", "BG", "CY", "DE", "EE", "ES", "FI", "FR", "GR", "HR",
  "IE", "IT", "LT", "LU", "LV", "MT", "NL", "PT", "SI", "SK",
];

describe("COUNTRY_CURRENCY", () => {
  it("is built from CLDR 49 or later", () => {
    expect(Number(COUNTRY_CURRENCY_CLDR_VERSION)).toBeGreaterThanOrEqual(49);
  });

  it("maps every country the product knows about", () => {
    const missing = [...Object.keys(COUNTRY_NAMES), ...Object.keys(PPP_MULTIPLIERS)].filter(
      (cc) => !COUNTRY_CURRENCY[cc],
    );
    expect(missing).toEqual([]);
  });

  it("maps only to well-formed ISO 4217 codes", () => {
    for (const [cc, code] of Object.entries(COUNTRY_CURRENCY)) {
      expect(cc).toMatch(/^[A-Z]{2}$/);
      expect(normalizeCurrency(code)).toBe(code);
    }
  });

  it("maps the whole euro area, Bulgaria included, to EUR", () => {
    for (const cc of EURO_AREA) expect([cc, COUNTRY_CURRENCY[cc]]).toEqual([cc, "EUR"]);
  });

  it("maps countries that use another country's currency to that currency", () => {
    for (const cc of ["AD", "MC", "SM", "VA", "ME", "XK"]) expect(COUNTRY_CURRENCY[cc]).toBe("EUR");
    for (const cc of ["EC", "SV", "TL", "PR"]) expect(COUNTRY_CURRENCY[cc]).toBe("USD");
    for (const cc of ["KI", "TV", "NR"]) expect(COUNTRY_CURRENCY[cc]).toBe("AUD");
  });

  it("pins the reviewed choice for every country with two legal tenders", () => {
    expect({
      PA: COUNTRY_CURRENCY.PA,
      BT: COUNTRY_CURRENCY.BT,
      LS: COUNTRY_CURRENCY.LS,
      NA: COUNTRY_CURRENCY.NA,
      ZW: COUNTRY_CURRENCY.ZW,
      PS: COUNTRY_CURRENCY.PS,
      HT: COUNTRY_CURRENCY.HT,
    }).toEqual({ PA: "USD", BT: "BTN", LS: "LSL", NA: "NAD", ZW: "USD", PS: "ILS", HT: "HTG" });
  });

  it("has no entry for Cloudflare's non-country codes", () => {
    expect(COUNTRY_CURRENCY.XX).toBeUndefined();
    expect(COUNTRY_CURRENCY.T1).toBeUndefined();
  });

  it("covers the currencies the FX feed must provide", () => {
    const codes = new Set(Object.values(COUNTRY_CURRENCY));
    for (const code of ["INR", "BRL", "NGN", "PKR", "BDT", "EGP", "VND", "IDR", "TRY", "ARS", "MXN", "ZAR"]) {
      expect(codes.has(code)).toBe(true);
    }
  });
});
