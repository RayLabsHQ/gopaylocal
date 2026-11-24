import { describe, expect, it } from "vitest";
import { DODO_CURRENCY_MINIMUMS, regionalCharge, regionalOfferFromProPrice } from "./regional-charge";

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

describe("regionalOfferFromProPrice", () => {
  const body = {
    data: {
      country: "IN",
      countryName: "India",
      listPrice: 19,
      listCurrency: "USD",
      offer: { discount: 70, currency: "INR", amount: 529, minorAmount: 52900 },
    },
  };

  it("reads the offer the pricing endpoint serves", () => {
    expect(regionalOfferFromProPrice(body)).toEqual({
      country: "IN",
      countryName: "India",
      discount: 70,
      currency: "INR",
      amount: 529,
      minorAmount: 52900,
    });
  });

  it("keeps a price whose discount isn't known", () => {
    const unknown = { data: { ...body.data, offer: { ...body.data.offer, discount: null } } };
    expect(regionalOfferFromProPrice(unknown)?.discount).toBeNull();
  });

  it("is null for the list price and for anything malformed", () => {
    expect(regionalOfferFromProPrice({ data: { ...body.data, offer: null } })).toBeNull();
    expect(regionalOfferFromProPrice({ data: { ...body.data, country: null } })).toBeNull();
    expect(regionalOfferFromProPrice({ data: { ...body.data, offer: { ...body.data.offer, amount: 0 } } })).toBeNull();
    expect(regionalOfferFromProPrice({ data: { ...body.data, offer: { ...body.data.offer, currency: "inr" } } })).toBeNull();
    expect(regionalOfferFromProPrice({ data: { ...body.data, offer: { ...body.data.offer, discount: 100 } } })).toBeNull();
    expect(regionalOfferFromProPrice({ show: true, discount: 70 })).toBeNull();
    expect(regionalOfferFromProPrice(null)).toBeNull();
  });
});
