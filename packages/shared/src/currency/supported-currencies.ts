import { COUNTRY_CURRENCY } from "./country-currency";
import { normalizeCurrency } from "./exponents";

/**
 * The currencies GoPayLocal works in: USD (the exchange-rate base) plus every
 * country's local currency (COUNTRY_CURRENCY), 151 codes. Exchange rates are
 * kept for exactly these (apps/api services/fx-refresh.service.ts), and a
 * product can be priced only in one of them: a code outside the list (XXX,
 * CLF, a typo) has no rate, is never a visitor's currency and has no symbol.
 */
export const SUPPORTED_CURRENCIES: ReadonlySet<string> = new Set(["USD", ...Object.values(COUNTRY_CURRENCY)]);

/** SUPPORTED_CURRENCIES in alphabetical order (for a currency picker). */
export const SUPPORTED_CURRENCY_CODES: readonly string[] = [...SUPPORTED_CURRENCIES].sort();

/** The upper-case code when `currency` ("usd", " Eur ") is supported, else null. */
export function supportedCurrency(currency: string | null | undefined): string | null {
  const code = normalizeCurrency(currency);
  return code !== null && SUPPORTED_CURRENCIES.has(code) ? code : null;
}
