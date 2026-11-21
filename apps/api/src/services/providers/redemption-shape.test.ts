import { describe, it, expect, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { StripeProvider } from "./stripe";
import { DodoProvider } from "./dodo";
import { ChargebeeProvider } from "./chargebee";
import { PolarProvider } from "./polar";
import { WhopProvider } from "./whop";
import { GumroadProvider } from "./gumroad";
import { PaddleProvider } from "./paddle";
import { CreemProvider } from "./creem";
import { WooCommerceProvider } from "./woocommerce";
import type { RedemptionEvent } from "./types";
import { computeSavingsMinor } from "../redemption.service";

// Cross-adapter checks owned by the shared redemption plumbing: amounts arrive
// in the ISO 4217 minor unit lib/currency.ts defines, and stacked discounts are
// passed on (otherDiscounts) so handleRedemption can find ours in any position.

const fixture = (path: string) => readFileSync(new URL(`./__fixtures__/${path}`, import.meta.url), "utf8");

describe("Stripe amounts in ISO minor units", () => {
  const stripe = new StripeProvider({ apiKey: "sk_test_x" });

  it("converts ISK from Stripe's two-decimal representation to whole krónur", () => {
    // Stripe "special case": ISK amounts are sent with two always-zero decimals;
    // ISO 4217 (and lib/currency) make ISK zero-decimal. 100000 from Stripe = 1000 kr.
    const evt = JSON.parse(fixture("stripe/checkout-session-completed-coupon.json"));
    Object.assign(evt.data.object, {
      currency: "isk",
      amount_total: 600000,
      total_details: { amount_discount: 400000, amount_shipping: 0, amount_tax: 0 },
    });
    expect(stripe.parseRedemption(JSON.stringify(evt))).toMatchObject({
      chargedAmountCents: 6000,
      discountAmountCents: 4000,
      currency: "isk",
    });
  });
});

describe("Stripe stacked discounts (defensive: Checkout allows one today)", () => {
  const stripe = new StripeProvider({ apiKey: "sk_test_x" });

  it("passes on extra session discounts by id, without re-attributing the session-wide amount", () => {
    const evt = JSON.parse(fixture("stripe/checkout-session-completed-coupon.json"));
    const first = evt.data.object.discounts[0];
    evt.data.object.discounts = [first, { coupon: "PPPBR30ABCD", promotion_code: "promo_second" }];
    const r = stripe.parseRedemption(JSON.stringify(evt))!;
    expect(r.code).toBe("PPPIN40K7QX");
    expect(r.otherDiscounts).toEqual([
      { code: "PPPBR30ABCD", providerCouponId: "PPPBR30ABCD", providerPromoCodeId: "promo_second" },
    ]);
  });

  it("omits otherDiscounts for the normal single-discount session", () => {
    expect(stripe.parseRedemption(fixture("stripe/checkout-session-completed-coupon.json"))).not.toHaveProperty(
      "otherDiscounts",
    );
  });
});

describe("Dodo stacked discount codes", () => {
  const dodo = new DodoProvider({ apiKey: "k", environment: "test" });
  const base = JSON.parse(fixture("dodo/payment-succeeded-discounted.json"));
  const ours = base.data.discounts[0];

  it("passes on every other stacked code, in position order", () => {
    const evt = structuredClone(base);
    evt.data.discounts = [
      { ...ours, position: 2, code: "PPP-IN30-K7QX", discount_id: "dsc_ours" },
      { ...ours, position: 0, code: "WELCOME10", discount_id: "dsc_merchant" },
      { ...ours, position: 1, code: "LAUNCH5", discount_id: "dsc_launch" },
    ];
    const r = dodo.parseRedemption(JSON.stringify(evt))!;
    expect(r.code).toBe("WELCOME10");
    expect(r.otherDiscounts).toEqual([
      { code: "LAUNCH5", providerCouponId: "dsc_launch", providerPromoCodeId: null },
      { code: "PPP-IN30-K7QX", providerCouponId: "dsc_ours", providerPromoCodeId: null },
    ]);
  });

  it("omits otherDiscounts for a single code", () => {
    expect(dodo.parseRedemption(fixture("dodo/payment-succeeded-discounted.json"))).not.toHaveProperty("otherDiscounts");
  });
});

describe("Chargebee stacked coupons", () => {
  const chargebee = new ChargebeeProvider({ apiKey: "k", siteId: "acme", environment: "test" });
  const base = JSON.parse(fixture("chargebee/payment_succeeded_coupon.json"));

  it("passes on the other coupons (one entry per coupon, amounts totalled)", () => {
    const evt = structuredClone(base);
    evt.content.invoice.discounts = [
      { amount: 1000, entity_type: "document_level_coupon", entity_id: "MERCHANT10" },
      { amount: 4000, entity_type: "item_level_coupon", entity_id: "PPP-IN40-K7QX", line_item_id: "li_1" },
      { amount: 667, entity_type: "item_level_coupon", entity_id: "PPP-IN40-K7QX", line_item_id: "li_2" },
      { amount: 500, entity_type: "promotional_credits", entity_id: "pc_1" },
    ];
    const r = chargebee.parseRedemption(JSON.stringify(evt))!;
    expect(r.providerCouponId).toBe("MERCHANT10");
    expect(r.otherDiscounts).toEqual([
      { code: null, providerCouponId: "PPP-IN40-K7QX", providerPromoCodeId: null, discountAmountCents: 4667 },
    ]);
  });

  it("omits otherDiscounts when only one coupon was applied", () => {
    expect(chargebee.parseRedemption(fixture("chargebee/payment_succeeded_coupon.json"))).not.toHaveProperty(
      "otherDiscounts",
    );
  });
});

// ── C3: revenue saved is computed from pre-tax amounts, for every adapter ────
// For each adapter, the same purchase with and without tax must yield the same
// savings, and every event states its tax explicitly (0 or a number, or null
// for "not reported"), never leaving the field out.

interface TaxCase {
  provider: string;
  couponPercent: number;
  expectedSavingsMinor: number;
  untaxed: () => Promise<RedemptionEvent | null>;
  taxed: () => Promise<RedemptionEvent | null>;
}

const json = (path: string) => JSON.parse(fixture(path));
const savingsOf = (r: RedemptionEvent, percent: number) =>
  computeSavingsMinor(r.discountAmountCents, r.chargedAmountCents, r.taxAmountCents, percent);

// Placeholder credentials: the adapter only checks the ck_/cs_ shape.
const wooCommerce = () =>
  new WooCommerceProvider({ apiKey: `ck_${"a1".repeat(20)}:cs_${"b2".repeat(20)}`, siteId: "https://shop.example.com" });

function gumroadWithSale(patch: Record<string, unknown>) {
  const sale = json("gumroad/sale-with-offer-code.json");
  vi.stubGlobal("fetch", async () =>
    new Response(JSON.stringify({ ...sale, sale: { ...sale.sale, ...patch } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );
  const ping = new URLSearchParams(json("gumroad/ping-sale.json") as Record<string, string>).toString();
  return new GumroadProvider({ apiKey: "gumroad_token" }).parseRedemption(ping);
}

const TAX_CASES: TaxCase[] = [
  {
    provider: "stripe",
    couponPercent: 40,
    expectedSavingsMinor: 800, // total_details.amount_discount, pre-tax
    untaxed: async () => new StripeProvider({ apiKey: "sk_test_x" }).parseRedemption(fixture("stripe/checkout-session-completed-coupon.json")),
    // Exclusive tax on the discounted subtotal: 2000 − 800 + 240 = 1440.
    taxed: async () => {
      const evt = json("stripe/checkout-session-completed-coupon.json");
      Object.assign(evt.data.object, {
        amount_total: 1440,
        total_details: { amount_discount: 800, amount_shipping: 0, amount_tax: 240 },
      });
      return new StripeProvider({ apiKey: "sk_test_x" }).parseRedemption(JSON.stringify(evt));
    },
  },
  {
    provider: "paddle",
    couponPercent: 40,
    expectedSavingsMinor: 23960, // totals.discount: 40% of subtotal 59900
    untaxed: async () => {
      const evt = json("paddle/transaction-completed-discount.json");
      Object.assign(evt.data.details.totals, { tax: "0", total: "35940", grand_total: "35940", grand_total_tax: "0" });
      return new PaddleProvider({ apiKey: "pdl_sdbx_x", environment: "test" }).parseRedemption(JSON.stringify(evt));
    },
    taxed: async () =>
      new PaddleProvider({ apiKey: "pdl_sdbx_x", environment: "test" }).parseRedemption(fixture("paddle/transaction-completed-discount.json")),
  },
  {
    provider: "creem",
    couponPercent: 30,
    expectedSavingsMinor: 300, // discount_amount on an exclusive-tax product
    untaxed: async () => new CreemProvider({ apiKey: "creem_test_x", environment: "test" }).parseRedemption(fixture("creem/checkout-completed-discount-untaxed.json")),
    taxed: async () => new CreemProvider({ apiKey: "creem_test_x", environment: "test" }).parseRedemption(fixture("creem/checkout-completed-discount.json")),
  },
  {
    provider: "polar",
    couponPercent: 40,
    expectedSavingsMinor: 800, // subtotal 2000 − net 1200
    untaxed: async () => {
      const evt = json("polar/order-paid-purchase-with-discount.json");
      Object.assign(evt.data, { tax_amount: 0, total_amount: 1200 });
      return new PolarProvider({ apiKey: "polar_x" }).parseRedemption(JSON.stringify(evt));
    },
    taxed: async () => new PolarProvider({ apiKey: "polar_x" }).parseRedemption(fixture("polar/order-paid-purchase-with-discount.json")),
  },
  {
    provider: "dodopayments",
    couponPercent: 30,
    expectedSavingsMinor: 300, // pre-tax paid 700 at 30% off ⇒ list 1000
    untaxed: async () => {
      const evt = json("dodo/payment-succeeded-discounted.json");
      Object.assign(evt.data, { tax: 0, total_amount: 700 });
      return new DodoProvider({ apiKey: "dodo_test_x" }).parseRedemption(JSON.stringify(evt));
    },
    taxed: async () => new DodoProvider({ apiKey: "dodo_test_x" }).parseRedemption(fixture("dodo/payment-succeeded-discounted.json")),
  },
  {
    provider: "chargebee",
    couponPercent: 40,
    expectedSavingsMinor: 4667, // discounts[].amount on a tax_exclusive invoice
    untaxed: async () => {
      const evt = json("chargebee/payment_succeeded_coupon.json");
      Object.assign(evt.content.invoice, { tax: 0 });
      return new ChargebeeProvider({ apiKey: "cb_x", siteId: "acme-test" }).parseRedemption(JSON.stringify(evt));
    },
    taxed: async () => {
      const evt = json("chargebee/payment_succeeded_coupon.json");
      Object.assign(evt.content.invoice, { tax: 1260, total: 8260 });
      return new ChargebeeProvider({ apiKey: "cb_x", siteId: "acme-test" }).parseRedemption(JSON.stringify(evt));
    },
  },
  {
    provider: "whop",
    couponPercent: 40,
    expectedSavingsMinor: 2000, // subtotal 50.00 − pre-tax total 30.00
    untaxed: async () => {
      const evt = json("whop/payment_succeeded_promo.json");
      evt.data.tax_amount = null; // "Null when no tax applied"
      evt.data.total.amount = "30.00";
      return new WhopProvider({ apiKey: "whop_x", siteId: "biz_x" }).parseRedemption(JSON.stringify(evt));
    },
    taxed: async () => new WhopProvider({ apiKey: "whop_x", siteId: "biz_x" }).parseRedemption(fixture("whop/payment_succeeded_promo.json")),
  },
  {
    provider: "gumroad",
    couponPercent: 30,
    expectedSavingsMinor: 300, // price 700 at 30% off ⇒ list 1000
    untaxed: () => gumroadWithSale({ price: 700, tax_cents: 0 }),
    // Seller-collected tax sits inside `price`.
    taxed: () =>
      gumroadWithSale({
        price: 805,
        tax_cents: 105,
        buyer_presentment: { seller_tax_cents: 105, gumroad_tax_cents: 0 },
      }),
  },
  {
    provider: "woocommerce",
    couponPercent: 40,
    expectedSavingsMinor: 720, // coupon_lines[].discount, ex tax (7.20)
    // Same order without tax: 10.80 of items + 10.00 shipping.
    untaxed: async () => {
      const evt = json("woocommerce/order-processing-coupon.json");
      Object.assign(evt, { total: "20.80", total_tax: "0.00", cart_tax: "0.00", discount_tax: "0.00" });
      evt.coupon_lines[0].discount_tax = "0.00";
      return wooCommerce().parseRedemption(JSON.stringify(evt));
    },
    // total 21.61 includes 0.81 tax; the coupon line carries 0.54 of discount tax.
    taxed: async () => wooCommerce().parseRedemption(fixture("woocommerce/order-processing-coupon.json")),
  },
];

describe("C3: pre-tax revenue saved, per adapter", () => {
  afterEach(() => vi.unstubAllGlobals());

  for (const c of TAX_CASES) {
    it(`${c.provider}: states the tax and counts the same savings with or without it`, async () => {
      const untaxed = await c.untaxed();
      const taxed = await c.taxed();
      expect(untaxed, "untaxed parse").not.toBeNull();
      expect(taxed, "taxed parse").not.toBeNull();
      expect(untaxed!.taxAmountCents).toBe(0);
      expect(taxed!.taxAmountCents).toEqual(expect.any(Number));
      expect(taxed!.taxAmountCents).toBeGreaterThan(0);
      expect(savingsOf(untaxed!, c.couponPercent)).toBe(c.expectedSavingsMinor);
      expect(savingsOf(taxed!, c.couponPercent)).toBe(c.expectedSavingsMinor);
    });
  }
});

describe("C3: edge rows", () => {
  it("stripe: a discount off tax-inclusive prices is not passed as pre-tax; savings come from the net charge", async () => {
    // 2000 inclusive of 20% VAT, 40% off: the 800 discount contains tax, the
    // customer pays 1200 of which 200 is tax, so 2000 - 800 + 200 !== 1200.
    const evt = json("stripe/checkout-session-completed-coupon.json");
    Object.assign(evt.data.object, {
      amount_subtotal: 2000,
      amount_total: 1200,
      total_details: { amount_discount: 800, amount_shipping: 0, amount_tax: 200 },
    });
    const r = new StripeProvider({ apiKey: "sk_test_x" }).parseRedemption(JSON.stringify(evt));
    expect(r).toMatchObject({ chargedAmountCents: 1200, taxAmountCents: 200, discountAmountCents: null });
    // Net 1000 at 40% off => list 1666.67 net, saved 666.67.
    expect(savingsOf(r!, 40)).toBe(667);
  });

  it("paddle: account credit lowers the charge and its tax but not the pre-tax discount", async () => {
    const evt = json("paddle/transaction-completed-discount.json");
    Object.assign(evt.data.details.totals, { credit: "10000", grand_total: "29134", grand_total_tax: "2378" });
    const r = new PaddleProvider({ apiKey: "pdl_sdbx_x", environment: "test" }).parseRedemption(JSON.stringify(evt));
    expect(r).toMatchObject({ chargedAmountCents: 29134, taxAmountCents: 2378, discountAmountCents: 23960 });
    expect(savingsOf(r!, 40)).toBe(23960);
  });
});
