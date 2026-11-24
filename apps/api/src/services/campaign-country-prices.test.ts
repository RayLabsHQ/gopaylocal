import { describe, expect, it } from "vitest";
import { dodoProductProblem, existingRulesProblem, wantsCountryPrices } from "./campaign-country-prices.service";

// GET /products/{id} as Dodo returns it (only the fields the check reads).
const dodoProduct = (price: Record<string, unknown>) => ({
  product_id: "pdt_FAKE1",
  pricing_mode: null,
  price: { type: "recurring_price", price: 1900, currency: "USD", purchasing_power_parity: false, ...price },
});

describe("dodoProductProblem", () => {
  const product = { basePrice: 19, currency: "USD" };

  it("accepts a product that costs the same, with Dodo's PPP off", () => {
    expect(dodoProductProblem(dodoProduct({}), product)).toBeNull();
    expect(dodoProductProblem(dodoProduct({ type: "one_time_price", pay_what_you_want: false }), product)).toBeNull();
    expect(dodoProductProblem(dodoProduct({ price: 99900, currency: "INR" }), { basePrice: 999, currency: "INR" })).toBeNull();
    expect(dodoProductProblem(dodoProduct({ price: 2000, currency: "JPY" }), { basePrice: 2000, currency: "JPY" })).toBeNull();
  });

  it("refuses Dodo's PPP, pay-what-you-want and usage-based prices", () => {
    expect(dodoProductProblem(dodoProduct({ purchasing_power_parity: true }), product)).toMatch(/Purchasing Power Parity is on/);
    expect(dodoProductProblem(dodoProduct({ type: "one_time_price", pay_what_you_want: true }), product)).toMatch(/pay-what-you-want/);
    expect(dodoProductProblem(dodoProduct({ type: "usage_based_price" }), product)).toMatch(/usage-based/);
  });

  it("refuses a different price or currency, and says both", () => {
    expect(dodoProductProblem(dodoProduct({ price: 2900 }), product)).toBe(
      "The Dodo product costs 29 USD, but the GoPayLocal product costs 19 USD. Make them the same.",
    );
    expect(dodoProductProblem(dodoProduct({ currency: "EUR" }), product)).toMatch(/costs 19 EUR, but the GoPayLocal product costs 19 USD/);
    expect(dodoProductProblem({ product_id: "pdt_FAKE1" }, product)).toBe("Dodo returned the product without a price.");
  });
});

describe("existingRulesProblem", () => {
  it("lets an empty product through and names the rules a product already has", () => {
    expect(existingRulesProblem([])).toBeNull();
    expect(existingRulesProblem([{ id: "lcp_1", country_code: "IN", currency: "INR", amount: 99900 }])).toMatch(
      /^This Dodo product already has 1 price rule\. Remove them in Dodo/,
    );
    expect(
      existingRulesProblem([
        { id: "lcp_1", country_code: null, currency: "INR", amount: 99900 },
        { id: "lcp_2", country_code: null, currency: "EUR", amount: 1500 },
      ]),
    ).toMatch(/already has 2 price rules by currency/);
  });
});

describe("wantsCountryPrices", () => {
  const campaign = {
    id: "cmp_1",
    organizationId: "org_1",
    status: "active" as const,
    discountDelivery: "provider_price" as const,
    integrationId: "int_1",
    providerProductId: "pdt_FAKE1",
    environment: "live" as const,
  };

  it("wants them only while active, set to provider_price, on Dodo, with a product", () => {
    expect(wantsCountryPrices(campaign, "dodopayments")).toBe(true);
    expect(wantsCountryPrices({ ...campaign, status: "paused" }, "dodopayments")).toBe(false);
    expect(wantsCountryPrices({ ...campaign, discountDelivery: "banner_coupon" }, "dodopayments")).toBe(false);
    expect(wantsCountryPrices({ ...campaign, providerProductId: null }, "dodopayments")).toBe(false);
    expect(wantsCountryPrices({ ...campaign, integrationId: null }, "dodopayments")).toBe(false);
    expect(wantsCountryPrices(campaign, "stripe")).toBe(false);
  });
});
