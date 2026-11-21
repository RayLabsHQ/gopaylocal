import { useMemo } from 'react';
import { usePPP } from './use-ppp';
import { formatCurrency } from '../utils';
// Bundled into this package at build time: the same rule as @gopaylocal/js and the API.
import { digitOptions, localPrices, priceParts } from '../../../js-sdk/src/price';

// ── Types ────────────────────────────────────────────────────────────────────

export interface UsePriceOptions {
  /** The base price in your base currency (e.g., 99.99 USD). */
  price: number;
  /**
   * Convert to the visitor's currency when the API converted your product's
   * price and `baseCurrencyCode` is your product's currency. Defaults to true.
   */
  localize?: boolean;
  /**
   * `true` always shows the currency's decimals, `false` never does. By
   * default whole amounts show none ("₹719", "$19") and others keep them ("$7.60").
   */
  showDecimal?: boolean;
  /** Minimum number of decimal digits. */
  minimumDecimalDigits?: number;
  /** Maximum number of decimal digits. */
  maximumDecimalDigits?: number;
}

export interface UsePriceResult {
  /** The base price you passed in (before any discount). */
  originalPrice: number;
  /** The price after the discount, in your base currency, unrounded. */
  discountedPrice: number;
  /**
   * The price after the discount in `currencyCode`: converted and
   * charm-rounded up when `converted`, otherwise exact: rounded to the
   * currency's ISO minor unit (the cent for USD, the whole yen for JPY).
   */
  localPrice: number;
  /** The price before the discount in `currencyCode` (charm-rounded down when `converted`). */
  localOriginalPrice: number;
  /** True when the prices were converted to the visitor's currency; they are then estimates. */
  converted: boolean;
  /** Formatted `localPrice` (e.g., "₹719" or "$69.99"). */
  formatted: string;
  /** Formatted `localOriginalPrice`, for a struck-through display. */
  formattedOriginal: string;
  /** The discount percentage (0-100). */
  discount: number;
  /** Integer part of the formatted price (e.g., "69"). */
  integer: string;
  /** Decimal part of the formatted price (e.g., "99"); empty when it has none. */
  decimal: string;
  /** Currency symbol of the formatted prices (e.g., "₹"). */
  currencySymbol: string;
  /** Currency code of the formatted prices (e.g., "INR"). */
  currencyCode: string;
  /** Whether a discount is currently active. */
  hasDiscount: boolean;
}

// ── Hook ─────────────────────────────────────────────────────────────────────

/**
 * Compute a PPP-adjusted price with all formatting details.
 *
 * Converted prices use the same rule as the API uses for your product's own
 * price (the discounted price charm-rounded up, the original rounded down),
 * so the banner and the price components show the same two numbers. They are
 * estimates: your payment provider charges the exact discounted price in your
 * currency.
 *
 * @example
 * ```tsx
 * function Price() {
 *   const { formatted, formattedOriginal, hasDiscount } = usePrice({ price: 99.99 });
 *
 *   return (
 *     <div>
 *       {hasDiscount && <s>{formattedOriginal}</s>}
 *       <strong>{formatted}</strong>
 *     </div>
 *   );
 * }
 * ```
 */
export function usePrice(options: UsePriceOptions): UsePriceResult {
  const {
    price,
    localize = true,
    showDecimal,
    minimumDecimalDigits,
    maximumDecimalDigits,
  } = options;

  const ppp = usePPP();

  return useMemo(() => {
    const { discount } = ppp;
    const hasDiscount = discount > 0;
    const prices = localPrices(price, hasDiscount ? discount : 0, {
      baseCurrencyCode: ppp.baseCurrencyCode,
      currencyCode: ppp.currencyCode,
      fxRate: ppp.fxRate,
      fxAsOf: localize ? ppp.fxAsOf : null,
      charmPricingStrategy: ppp.charmPricingStrategy,
    });
    const currencyCode = prices.currencyCode;
    // Explicit digits (never Intl's defaults): see digitOptions.
    const digits = (v: number) =>
      digitOptions(v, currencyCode, showDecimal, minimumDecimalDigits, maximumDecimalDigits);
    const format = (v: number) => formatCurrency(v, currencyCode, digits(v));

    const formatted = format(prices.price);
    // Read from Intl, not parsed back from the string: a whole "₦8,999" has
    // no decimal part, while "KWD 2.280" has three digits.
    const parts = priceParts(prices.price, currencyCode, digits(prices.price));

    return {
      originalPrice: price,
      discountedPrice: hasDiscount ? price * (1 - discount / 100) : price,
      localPrice: prices.price,
      localOriginalPrice: prices.original,
      converted: prices.converted,
      formatted,
      formattedOriginal: format(prices.original),
      discount,
      integer: parts.integer,
      decimal: parts.decimal,
      currencySymbol: prices.converted ? ppp.currencySymbol : ppp.baseCurrencySymbol,
      currencyCode,
      hasDiscount,
    };
  }, [
    price,
    localize,
    showDecimal,
    minimumDecimalDigits,
    maximumDecimalDigits,
    ppp,
  ]);
}
