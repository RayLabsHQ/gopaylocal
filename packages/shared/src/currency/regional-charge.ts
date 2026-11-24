/**
 * What a visitor is charged for a product whose checkout runs on Dodo Payments
 * with per-country prices (Dodo "Localized Pricing", one rule per country),
 * given the discount and local price GoPayLocal serves that visitor.
 *
 * The hosted service sells Pro this way: the price page shows the local price
 * from the config endpoint, and the API writes the same amount to Dodo for each
 * country (apps/api/src/services/house-pricing.service.ts). Both call this
 * function, so the price shown is the price charged.
 *
 * Dodo charges a country in its local currency only when that currency is in
 * Dodo's Adaptive Currency list and the amount is at least Dodo's minimum for
 * it. Anywhere else the visitor is charged, and shown, the exact discounted
 * price in the product's own currency.
 */

import { minorUnitExponent, normalizeCurrency } from "./exponents";
import { pricePair } from "./pair";

/**
 * Dodo Payments' Adaptive Currency list with each currency's minimum charge,
 * in major units. Source: https://docs.dodopayments.com/features/adaptive-currency
 * (the "Supported Currencies" table), read 2026-11-24.
 */
export const DODO_CURRENCY_MINIMUMS: Readonly<Record<string, number>> = {
  AED: 2, ALL: 50, AMD: 500, AUD: 0.5, AWG: 2, AZN: 2, BAM: 2, BDT: 100, BMD: 1, BND: 1,
  BOB: 5, BRL: 0.5, BSD: 1, BWP: 15, BZD: 2, CAD: 0.5, CHF: 0.5, CLP: 500, CNY: 4, CRC: 500,
  CZK: 15, DKK: 2.5, DOP: 100, EGP: 50, ETB: 100, EUR: 0.5, FJD: 2, GBP: 0.3, GEL: 3, GMD: 100,
  GTQ: 10, GYD: 200, HKD: 4, HNL: 25, HUF: 175, IDR: 8500, ILS: 3, INR: 5, JPY: 50, KRW: 50,
  KZT: 500, LKR: 300, LRD: 200, LSL: 20, MAD: 10, MKD: 50, MOP: 10, MUR: 50, MVR: 15, MWK: 2000,
  MXN: 10, MYR: 4, NGN: 2000, NOK: 3, NPR: 150, NZD: 1, PEN: 3, PGK: 4, PHP: 50, PLN: 2,
  PYG: 4000, QAR: 3, RON: 2, RSD: 60, SAR: 2, SBD: 10, SCR: 15, SEK: 3, SGD: 0.5, SZL: 20,
  THB: 25, TOP: 2, TRY: 20, TWD: 20, TZS: 3000, UYU: 50, VND: 12000, WST: 2, XAF: 300, XOF: 300,
  ZAR: 20, ZMW: 30,
};

/** Dodo's minimum for a subscription in USD (its "Minimum Amounts" section). */
export const DODO_MIN_SUBSCRIPTION_USD = 1;

export interface RegionalChargeInput {
  /** The product's price in its own currency, major units. */
  basePrice: number;
  /** The product's currency. */
  baseCurrency: string;
  /** The visitor's country discount, 0-100. */
  discount: number;
  /**
   * The price as the config endpoint serves it to this visitor: `localPricing`
   * on the server, or the SDK's `PPPData` (`currencyCode`, `localPrice`) in the
   * browser. Null when there is none.
   */
  local: { currencyCode: string; localPrice: number | null } | null;
}

export interface RegionalCharge {
  /** ISO 4217 code the visitor is charged in. */
  currency: string;
  /** Major units, as shown. */
  amount: number;
  /** Smallest unit of `currency`, as Dodo takes it. */
  minorAmount: number;
  /** True when this is the visitor's currency, false when it is the product's own. */
  local: boolean;
}

/**
 * The charge for one visitor, or null when there is nothing to charge at a
 * discount: no discount, an impossible price, or a price under Dodo's minimum.
 */
export function regionalCharge(input: RegionalChargeInput): RegionalCharge | null {
  const { basePrice, discount, local } = input;
  if (!Number.isFinite(basePrice) || basePrice <= 0) return null;
  if (!Number.isFinite(discount) || discount <= 0) return null;
  const base = normalizeCurrency(input.baseCurrency) ?? input.baseCurrency.trim().toUpperCase();

  const localCode = local ? normalizeCurrency(local.currencyCode) : null;
  if (local && localCode && localCode !== base && local.localPrice != null && Number.isFinite(local.localPrice)) {
    const min = Object.hasOwn(DODO_CURRENCY_MINIMUMS, localCode) ? DODO_CURRENCY_MINIMUMS[localCode]! : null;
    if (min !== null && local.localPrice >= min) {
      return { currency: localCode, amount: local.localPrice, minorAmount: toMinor(local.localPrice, localCode), local: true };
    }
  }

  const exact = pricePair(basePrice, discount, base, null).price;
  if (base === "USD" && exact < DODO_MIN_SUBSCRIPTION_USD) return null;
  if (!(exact > 0)) return null;
  return { currency: base, amount: exact, minorAmount: toMinor(exact, base), local: false };
}

function toMinor(amount: number, currency: string): number {
  return Math.round(amount * 10 ** minorUnitExponent(currency));
}

export interface RegionalOffer extends RegionalCharge {
  discount: number;
  country: string;
  countryName: string;
}

/**
 * A visitor's charge from the config endpoint's answer for them
 * (`GET /v1/banner/config/{publicKey}`). Null when they get no discount, when
 * the answer is for a product in another currency, and when it is a holiday
 * deal or an A/B test arm: Dodo's per-country prices follow neither.
 */
export function regionalOfferFromAnswer(answer: unknown, basePrice: number, baseCurrency: string): RegionalOffer | null {
  if (!answer || typeof answer !== "object") return null;
  const a = answer as Record<string, unknown>;
  if (a.show !== true || typeof a.discount !== "number" || typeof a.country !== "string") return null;
  if (a.deal || a.experimentId) return null;
  if (typeof a.baseCurrencyCode === "string" && a.baseCurrencyCode !== baseCurrency) return null;
  const charge = regionalCharge({
    basePrice,
    baseCurrency,
    discount: a.discount,
    local:
      typeof a.currencyCode === "string"
        ? { currencyCode: a.currencyCode, localPrice: typeof a.localPrice === "number" ? a.localPrice : null }
        : null,
  });
  if (!charge) return null;
  return { ...charge, discount: a.discount, country: a.country, countryName: typeof a.countryName === "string" ? a.countryName : a.country };
}
