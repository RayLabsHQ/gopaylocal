/**
 * Prices in the visitor's currency, computed by the API's own function
 * (pricePair, packages/shared/src/currency/pair.ts), so a price shown by the
 * SDKs and the same price in the banner always agree.
 *
 * `@gopaylocal/react` bundles this file too. The script-tag banner does not:
 * the API sends it the product's price ready-made, and it only formats it.
 */
// Pure modules shared with the API (MIT; pair.ts imports only ./charm, which
// imports only ./exponents); bundled into this package at build time.
import { isCharmStrategy, roundToMinorUnit, type CharmStrategy } from '../../shared/src/currency/charm';
import { displayFractionDigits, minorUnitExponent } from '../../shared/src/currency/exponents';
import { clampDiscount, pricePair, type PricePair } from '../../shared/src/currency/pair';

export type { CharmStrategy };

/** What a config response says about converting prices. */
export interface Conversion {
  /** The product's currency. Only prices written in it are converted. */
  baseCurrencyCode: string;
  /** The visitor's currency; equal to `baseCurrencyCode` when not converted. */
  currencyCode: string;
  /** Units of `currencyCode` per unit of `baseCurrencyCode`. */
  fxRate: number;
  /** The rates' date. Set only when the response is a converted estimate. */
  fxAsOf: string | null;
  /** The campaign's charm strategy. */
  charmPricingStrategy: CharmStrategy;
}

/**
 * A price after and before the discount, in one currency: `price` (what the
 * visitor pays, an estimate when converted), `original` (for a struck-through
 * display), `currencyCode` (of both) and `converted`.
 */
export type LocalPrices = PricePair;

/** `value` if it is a known charm strategy, else "none". */
export function charmStrategyOf(value: unknown): CharmStrategy {
  return isCharmStrategy(value) ? value : 'none';
}

/**
 * The visitor's two prices for `amount` (in the base currency): converted with
 * the response's own `fxRate` and charm strategy when the response is a
 * conversion (`fxAsOf` set), otherwise exact in the base currency. This is the
 * API's pricePair, so `amount` equal to the product's price gives the
 * response's `localPrice` and `localOriginalPrice`.
 */
export function localPrices(amount: number, discount: number, c: Conversion): LocalPrices {
  return pricePair(
    amount,
    discount,
    c.baseCurrencyCode,
    c.fxAsOf ? { currency: c.currencyCode, fxRate: c.fxRate, strategy: c.charmPricingStrategy } : null,
  );
}

/**
 * `amount` after the discount in `currency`, rounded half-up to its ISO minor
 * unit: what the payment provider charges. Unlike a displayed price it keeps
 * the minor unit in currencies shown in whole units (PKR 1838.14, not 1838).
 */
export function chargedPrice(amount: number, discount: number, currency: string): number {
  const discounted = amount * (1 - clampDiscount(discount) / 100);
  return roundToMinorUnit(discounted, currency, 'half-up') ?? discounted;
}

// ── Display digits ──────────────────────────────────────────────────────────
// Every formatter passes both minimumFractionDigits and maximumFractionDigits.
// Intl's per-currency defaults are not a rule anyone controls: they differ
// between browser versions, and current ICU gives PKR, IDR, IQD and a dozen
// more 0 decimals, which once rounded "PKR 1838.14" to "PKR 1,838". A price is
// shown with exactly the digits it has.

/** Both Intl fraction-digit options. */
export interface FractionDigits {
  minimumFractionDigits: number;
  maximumFractionDigits: number;
}

/**
 * The decimals that show `value` exactly in `currency`: the currency's display
 * digits (displayFractionDigits: USD 2, KWD 3, JPY and PKR 0), which every
 * price from pricePair is rounded to; or, for an amount with finer decimals than
 * that (a caller's own PKR 1838.14), the ISO minor-unit digits, so it is not
 * rounded away. Display digits are fewer than ISO only where they are 0.
 */
export function currencyDigits(currency: string, value = 0): number {
  const d = displayFractionDigits(currency);
  return d === 0 && value % 1 !== 0 ? minorUnitExponent(currency) : d;
}

/**
 * `options` with both fraction-digit options set: the caller's where given,
 * `currencyDigits(currency, value)` where not, filled in so the minimum never
 * exceeds the maximum. Options using significant digits are the caller's own
 * rounding and are returned as they are.
 */
export function withCurrencyDigits(
  options: Intl.NumberFormatOptions | undefined,
  currency: string,
  value = 0,
): Intl.NumberFormatOptions {
  const o: Intl.NumberFormatOptions = { ...options };
  if (o.minimumSignificantDigits !== undefined || o.maximumSignificantDigits !== undefined) return o;
  const d = currencyDigits(currency, value);
  const min = o.minimumFractionDigits;
  const max = o.maximumFractionDigits;
  o.minimumFractionDigits = min ?? Math.min(max ?? d, d);
  o.maximumFractionDigits = max ?? Math.max(min ?? d, d);
  return o;
}

/**
 * The digits a price is shown with. `showDecimal: false` shows none; explicit
 * digit counts are used, the missing one filled in; otherwise a whole amount
 * shows none ("₹719", "$19") and any other its currency's digits ("$7.60",
 * "KWD 2.334"), as does every amount with `showDecimal: true` ("$19.00",
 * but "¥719" and "PKR 1,838", whose display digits are 0; "PKR 1,838.14" keeps
 * its paisa either way).
 */
export function digitOptions(
  value: number,
  currency: string,
  showDecimal?: boolean,
  minimumDecimalDigits?: number,
  maximumDecimalDigits?: number,
): FractionDigits {
  const none = { minimumFractionDigits: 0, maximumFractionDigits: 0 };
  if (showDecimal === false) return none;
  const explicit = minimumDecimalDigits !== undefined || maximumDecimalDigits !== undefined;
  if (!explicit && showDecimal === undefined && value % 1 === 0) return none;
  return withCurrencyDigits(
    { minimumFractionDigits: minimumDecimalDigits, maximumFractionDigits: maximumDecimalDigits },
    currency,
    value,
  ) as FractionDigits;
}

/** The symbol of a currency in the visitor's locale ("€" for EUR), or the code itself. */
export function symbolOf(code: string, locale?: string): string {
  try {
    const parts = new Intl.NumberFormat(locale, {
      style: 'currency',
      currency: code,
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }).formatToParts(0);
    return parts.find((p) => p.type === 'currency')?.value ?? code;
  } catch {
    return code;
  }
}

/**
 * The integer part (with its group separators) and the fraction digits of a
 * price formatted with `options`, read from Intl instead of parsed back from
 * the string: "₦8,999" is 8,999 with no decimals, and "KWD 2.280" is 2 and 280.
 * Digits `options` leaves unset are the currency's (`withCurrencyDigits`).
 */
export function priceParts(
  value: number,
  currency: string,
  options?: Intl.NumberFormatOptions,
  locale?: string,
): { integer: string; decimal: string } {
  try {
    let integer = '';
    let decimal = '';
    const format = new Intl.NumberFormat(locale, { style: 'currency', currency, ...withCurrencyDigits(options, currency, value) });
    for (const p of format.formatToParts(value)) {
      if (p.type === 'integer' || p.type === 'group') integer += p.value;
      else if (p.type === 'fraction') decimal += p.value;
    }
    return { integer, decimal };
  } catch {
    const [integer = '0', decimal = ''] = String(value).split('.');
    return { integer, decimal };
  }
}
