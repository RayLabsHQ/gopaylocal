// ── Local prices ────────────────────────────────────────────────────────────
// What the banner endpoint sends a visitor (and the dashboard preview shows): the
// product's price after the discount, in the visitor's currency when a usable
// exchange rate exists, otherwise exactly in the product's own currency.
//
// The rule is "never a wrong price". With no usable rate (missing or stale
// document, unmapped country, missing, held or excluded currency) the visitor
// sees the exact price in the merchant's currency, the same answer as a visitor
// who already pays in that currency. `fxAsOf` is present only on a converted
// estimate.
//
// This module decides whether a usable rate exists (and which); the two prices
// themselves come from pricePair() (./pair.ts), which the SDKs call too with the
// response's fxRate, so they get the same numbers for any other price:
//   discounted         = basePrice * (1 - discount / 100)
//   localPrice         from charm candidates of discounted * fxRate, rounded up
//   localOriginalPrice from charm candidates of basePrice * fxRate, rounded down
// chosen together under the pair rules described in ./pair.ts.

import { CURRENCY_SYMBOLS } from "../constants";
import { type CharmStrategy } from "./charm";
import { COUNTRY_CURRENCY } from "./country-currency";
import { normalizeCurrency } from "./exponents";
import { fxRateOf, usableFxRates, type FxRatesDoc } from "./fx";
import { pricePair, type PairConversion } from "./pair";

export interface LocalPricingInput {
  /** The product's price in its own currency, major units (products.base_price). */
  basePrice: number;
  /** The product's currency (products.currency). */
  baseCurrency: string;
  /** The visitor's discount, 0-100. */
  discountPercent: number;
  /** The visitor's country (ISO 3166-1 alpha-2), or null if unknown. */
  country: string | null;
  /** The served campaign's charm strategy. */
  strategy: CharmStrategy;
  /** The KV rates document as read (validated and age-checked here), or null. */
  fx: FxRatesDoc | null | unknown;
  /** Current time, ms. */
  now: number;
  /** Currencies that never get a converted price (FX_EXCLUDED_CURRENCIES). */
  excludedCurrencies?: ReadonlySet<string>;
}

export interface LocalPricing {
  baseCurrencyCode: string;
  baseCurrencySymbol: string;
  /** The currency of localPrice: the visitor's when converted, else baseCurrencyCode. */
  currencyCode: string;
  currencySymbol: string;
  /** Units of currencyCode per 1 unit of baseCurrencyCode (1 when not converted). */
  fxRate: number;
  localPrice: number;
  localOriginalPrice: number;
  /** The rates' date (YYYY-MM-DD). Present only when the prices are converted estimates. */
  fxAsOf?: string;
}

/** Display symbol for a currency, falling back to the code itself. */
export function currencySymbolOf(code: string): string {
  return CURRENCY_SYMBOLS[code] ?? code;
}

/** ISO code of the currency local prices are shown in for a country, or null. */
export function currencyForCountry(country: string | null | undefined): string | null {
  if (typeof country !== "string") return null;
  const cc = country.trim().toUpperCase();
  return Object.prototype.hasOwnProperty.call(COUNTRY_CURRENCY, cc) ? COUNTRY_CURRENCY[cc]! : null;
}

/** Rates are stored to 10 significant digits of precision; enough, and short in JSON. */
function crossRate(visitorPerUsd: number, basePerUsd: number): number {
  return Number((visitorPerUsd / basePerUsd).toPrecision(10));
}

/**
 * Local prices for one visitor. Returns null only for an impossible product
 * (basePrice not a positive finite number; products.base_price is NOT NULL and
 * validated positive).
 */
export function localPricing(input: LocalPricingInput): LocalPricing | null {
  const { basePrice } = input;
  if (!Number.isFinite(basePrice) || basePrice <= 0) return null;
  const baseCode = normalizeCurrency(input.baseCurrency) ?? input.baseCurrency.trim().toUpperCase();

  let conversion: PairConversion | null = null;
  let fxAsOf: string | undefined;
  const visitor = currencyForCountry(input.country);
  if (visitor && visitor !== baseCode && !input.excludedCurrencies?.has(visitor)) {
    const fx = usableFxRates(input.fx, input.now);
    const visitorPerUsd = fx ? fxRateOf(fx, visitor) : null;
    const basePerUsd = fx ? fxRateOf(fx, baseCode) : null;
    if (fx && visitorPerUsd !== null && basePerUsd !== null) {
      conversion = { currency: visitor, fxRate: crossRate(visitorPerUsd, basePerUsd), strategy: input.strategy };
      fxAsOf = fx.asOf;
    }
  }

  const pair = pricePair(basePrice, input.discountPercent, baseCode, conversion);
  const result: LocalPricing = {
    baseCurrencyCode: baseCode,
    baseCurrencySymbol: currencySymbolOf(baseCode),
    currencyCode: pair.currencyCode,
    currencySymbol: currencySymbolOf(pair.currencyCode),
    fxRate: pair.converted && conversion ? conversion.fxRate : 1,
    localPrice: pair.price,
    localOriginalPrice: pair.original,
  };
  if (pair.converted && fxAsOf !== undefined) result.fxAsOf = fxAsOf;
  return result;
}
