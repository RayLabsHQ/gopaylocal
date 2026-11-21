import { withCurrencyDigits } from './price';

/**
 * Convert an ISO 3166-1 alpha-2 country code to a flag emoji.
 * Returns an empty string if the input is invalid.
 */
export function countryToFlag(countryCode: string): string {
  if (!countryCode || countryCode.length !== 2) return '';
  try {
    const upper = countryCode.toUpperCase();
    return String.fromCodePoint(
      0x1f1e6 + upper.charCodeAt(0) - 65,
      0x1f1e6 + upper.charCodeAt(1) - 65,
    );
  } catch {
    return '';
  }
}

/**
 * Format a number as currency using Intl.NumberFormat.
 * Decimal digits `options` leaves unset are the currency's (USD 2, KWD 3, JPY
 * and PKR 0, or more if the amount has them: PKR 1838.14 keeps its 2), never
 * Intl's defaults, which differ between browsers.
 * Falls back to a simple string representation if the currency is unsupported.
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
    return `${currencyCode} ${amount.toFixed(2)}`;
  }
}

/**
 * Split a formatted price string into its integer and decimal parts.
 * Handles various locale-specific separators (., ,).
 *
 * @example
 * splitPrice('$4,999.00') // { integer: '4,999', decimal: '00', separator: '.' }
 * splitPrice('\u20B94,999')   // { integer: '4,999', decimal: '', separator: '' }
 */
export function splitPrice(formattedPrice: string): {
  integer: string;
  decimal: string;
  separator: string;
} {
  // Strip currency symbols and whitespace from start/end
  const stripped = formattedPrice.replace(/^[^\d]*/, '').replace(/[^\d]*$/, '');

  if (!stripped) {
    return { integer: '0', decimal: '', separator: '' };
  }

  // Find the last decimal separator (. or ,)
  // Decimal separator is typically the last . or , that is followed by exactly 1-2 digits at the end
  const dotMatch = stripped.match(/^(.+)\.(\d{1,2})$/);
  if (dotMatch) {
    return { integer: dotMatch[1]!, decimal: dotMatch[2]!, separator: '.' };
  }

  const commaMatch = stripped.match(/^(.+),(\d{1,2})$/);
  if (commaMatch) {
    return { integer: commaMatch[1]!, decimal: commaMatch[2]!, separator: ',' };
  }

  // No decimal part (e.g., JPY, KRW, or whole numbers)
  return { integer: stripped, decimal: '', separator: '' };
}
