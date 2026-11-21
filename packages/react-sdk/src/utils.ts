// Bundled into this package at build time, like the price rule.
import { withCurrencyDigits } from '../../js-sdk/src/price';

/**
 * Convert an ISO 3166-1 alpha-2 country code to its flag emoji.
 *
 * @example
 * ```ts
 * countryToFlag('IN') // => '🇮🇳'
 * countryToFlag('US') // => '🇺🇸'
 * ```
 */
export function countryToFlag(countryCode: string): string {
  if (!countryCode || countryCode.length !== 2) return '';

  const upper = countryCode.toUpperCase();
  const codePointA = 0x1f1e6; // Regional Indicator Symbol Letter A
  const charCodeA = 65; // 'A'.charCodeAt(0)

  try {
    return String.fromCodePoint(
      codePointA + upper.charCodeAt(0) - charCodeA,
      codePointA + upper.charCodeAt(1) - charCodeA,
    );
  } catch {
    return '';
  }
}

/**
 * Format a numeric amount as a currency string using `Intl.NumberFormat`.
 * Decimal digits `options` leaves unset are the currency's (USD 2, KWD 3, JPY
 * and PKR 0, or more if the amount has them: PKR 1838.14 keeps its 2), never
 * Intl's defaults, which differ between browsers.
 *
 * @example
 * ```ts
 * formatCurrency(4999, 'INR')          // => '₹4,999.00'
 * formatCurrency(49.99, 'USD')         // => '$49.99'
 * formatCurrency(49.99, 'EUR', { maximumFractionDigits: 0 }) // => '€50'
 * ```
 */
export function formatCurrency(
  amount: number,
  currencyCode: string,
  options?: Intl.NumberFormatOptions,
): string {
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: currencyCode,
      ...withCurrencyDigits(options, currencyCode, amount),
    }).format(amount);
  } catch {
    // Fallback if the currency code is invalid
    return `${currencyCode} ${amount.toFixed(2)}`;
  }
}

/**
 * Split a formatted price string into its integer, decimal, and separator parts.
 *
 * @example
 * ```ts
 * splitPrice('4,999.99') // => { integer: '4,999', decimal: '99', separator: '.' }
 * splitPrice('4.999,99') // => { integer: '4.999', decimal: '99', separator: ',' }
 * splitPrice('5000')     // => { integer: '5000', decimal: '',   separator: '' }
 * ```
 */
export function splitPrice(formattedPrice: string): {
  integer: string;
  decimal: string;
  separator: string;
} {
  // Strip currency symbols/letters and whitespace from the start and end.
  // Keep digits, commas, dots, and spaces in the middle.
  const cleaned = formattedPrice
    .replace(/^[^\d\-]+/, '')
    .replace(/[^\d]+$/, '');

  if (!cleaned) {
    return { integer: formattedPrice, decimal: '', separator: '' };
  }

  // The decimal separator is the last non-digit character followed only by digits.
  // Match the last dot or comma that is followed by 1-3 digits at the end.
  const match = cleaned.match(/^(.+?)([.,])(\d{1,3})$/);

  if (match) {
    return {
      integer: match[1]!,
      decimal: match[3]!,
      separator: match[2]!,
    };
  }

  return { integer: cleaned, decimal: '', separator: '' };
}
