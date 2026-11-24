import { describe, expect, it } from "vitest";
import { DODO_CURRENCY_MINIMUMS, regionalCharge, regionalOfferFromAnswer } from "./regional-charge";

const PRO = { basePrice: 19, baseCurrency: "USD" };

describe("regionalCharge", () => {
  it("charges the local price the visitor was shown when Dodo can charge that currency", () => {
    expect(regionalCharge({ ...PRO, discount: 70, local: { currencyCode: "INR", localPrice: 479 } })).toEqual({
      currency: "INR",
      amount: 479,
      minorAmount: 47_900,
      local: true,
    });
  });

  it("uses the currency's own minor unit", () => {
    expect(regionalCharge({ ...PRO, discount: 40, local: { currencyCode: "JPY", localPrice: 1780 } })).toMatchObject({
      currency: "JPY",
      minorAmount: 1780,
    });
  });

  it("charges and shows the exact discounted USD price where Dodo has no local currency", () => {
    // ARS is not in Dodo's Adaptive Currency list.
    expect(Object.hasOwn(DODO_CURRENCY_MINIMUMS, "ARS")).toBe(false);
    expect(regionalCharge({ ...PRO, discount: 70, local: { currencyCode: "ARS", localPrice: 6999 } })).toEqual({
      currency: "USD",
      amount: 5.7,
      minorAmount: 570,
      local: false,
    });
  });

  it("falls back to USD when the local amount is under Dodo's minimum for the currency", () => {
    expect(regionalCharge({ ...PRO, discount: 50, local: { currencyCode: "IDR", localPrice: 8000 } })).toMatchObject({
      currency: "USD",
      amount: 9.5,
    });
  });

  it("falls back to USD when there is no converted price", () => {
    expect(regionalCharge({ ...PRO, discount: 30, local: null })).toMatchObject({ currency: "USD", amount: 13.3, minorAmount: 1330 });
    expect(regionalCharge({ ...PRO, discount: 30, local: { currencyCode: "INR", localPrice: null } })).toMatchObject({ currency: "USD" });
  });

  it("is null without a discount, and under Dodo's USD subscription minimum", () => {
    expect(regionalCharge({ ...PRO, discount: 0, local: { currencyCode: "INR", localPrice: 1599 } })).toBeNull();
    expect(regionalCharge({ basePrice: 1, baseCurrency: "USD", discount: 50, local: null })).toBeNull();
    expect(regionalCharge({ basePrice: 0, baseCurrency: "USD", discount: 50, local: null })).toBeNull();
  });
});

describe("regionalOfferFromAnswer", () => {
  const answer = {
    show: true,
    country: "IN",
    countryName: "India",
    discount: 70,
    code: null,
    baseCurrencyCode: "USD",
    currencyCode: "INR",
    localPrice: 479,
    fxAsOf: "2026-11-24",
  };

  it("reads the price the config endpoint served", () => {
    expect(regionalOfferFromAnswer(answer, 19, "USD")).toEqual({
      currency: "INR",
      amount: 479,
      minorAmount: 47_900,
      local: true,
      discount: 70,
      country: "IN",
      countryName: "India",
    });
  });

  it("ignores no-discount answers, deals, A/B arms, codes and a product in another currency", () => {
    expect(regionalOfferFromAnswer({ show: false, reason: "no_discount" }, 19, "USD")).toBeNull();
    expect(regionalOfferFromAnswer({ ...answer, deal: { id: "d" } }, 19, "USD")).toBeNull();
    expect(regionalOfferFromAnswer({ ...answer, experimentId: "e", variant: "b" }, 19, "USD")).toBeNull();
    expect(regionalOfferFromAnswer({ ...answer, baseCurrencyCode: "EUR" }, 19, "USD")).toBeNull();
    expect(regionalOfferFromAnswer({ ...answer, code: "PPP70" }, 19, "USD")).toBeNull();
    expect(regionalOfferFromAnswer(null, 19, "USD")).toBeNull();
  });
});
