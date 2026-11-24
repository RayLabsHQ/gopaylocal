// ── Currency minor units (ISO 4217) ─────────────────────────────────────────
// The single source of truth for "how many decimals does this currency's minor
// unit have". Provider webhooks report money in the currency's smallest unit
// (RedemptionEvent amounts); converting that to major units with a blanket
// `/ 100` is wrong for zero-decimal currencies (JPY 500 is ¥500, not ¥5) and for
// three-decimal ones (KWD 1500 is 1.500 KD, not 15 KD). Charm pricing
// (./charm.ts) rounds in these same minor units.
//
// Source: the ISO 4217 "List one" minor-unit column (SIX Group, maintenance
// agency for ISO 4217: https://www.six-group.com/en/products-services/financial-information/data-standards.html).
//   exponent 0: BIF CLP DJF GNF ISK JPY KMF KRW PYG RWF UGX UYI VND VUV XAF XOF XPF
//   exponent 3: BHD IQD JOD KWD LYD OMR TND
//   exponent 4: CLF UYW
//   every other active currency: 2
//
// One deliberate deviation: MGA (Malagasy ariary). ISO lists 2 decimals, but its
// subunit is 1/5 of an ariary and is not used; Stripe (docs.stripe.com/currencies
// #zero-decimal), Dodo and CLDR all treat MGA as zero-decimal, and this module
// has to agree with what the provider adapters emit. MRU stays at ISO's 2.
//
// Provider-specific representations that differ from ISO (for example Stripe
// sends ISK and UGX as two-decimal values) are normalised in the adapter, so
// every RedemptionEvent amount is in the ISO minor unit defined here.
//
// PURE MODULE: no imports. The SDKs bundle this file through a relative import
// (see ./charm.ts), so it must never import a package; currency.purity.test.ts
// enforces that.

export const ZERO_DECIMAL_CURRENCIES: ReadonlySet<string> = new Set([
  "BIF", "CLP", "DJF", "GNF", "ISK", "JPY", "KMF", "KRW", "MGA", "PYG",
  "RWF", "UGX", "UYI", "VND", "VUV", "XAF", "XOF", "XPF",
]);

export const THREE_DECIMAL_CURRENCIES: ReadonlySet<string> = new Set([
  "BHD", "IQD", "JOD", "KWD", "LYD", "OMR", "TND",
]);

export const FOUR_DECIMAL_CURRENCIES: ReadonlySet<string> = new Set(["CLF", "UYW"]);

/** Normalise a currency code ("usd", " Usd ") to upper case, or null if it isn't a 3-letter code. */
export function normalizeCurrency(currency: string | null | undefined): string | null {
  if (typeof currency !== "string") return null;
  const c = currency.trim().toUpperCase();
  return /^[A-Z]{3}$/.test(c) ? c : null;
}

/**
 * Number of decimal places in the currency's minor unit (USD 2, JPY 0, KWD 3).
 * Unknown or missing codes return 2, the exponent of almost every currency.
 */
export function minorUnitExponent(currency: string | null | undefined): number {
  const c = normalizeCurrency(currency);
  if (!c) return 2;
  if (ZERO_DECIMAL_CURRENCIES.has(c)) return 0;
  if (THREE_DECIMAL_CURRENCIES.has(c)) return 3;
  if (FOUR_DECIMAL_CURRENCIES.has(c)) return 4;
  return 2;
}

// ── Display digits ──────────────────────────────────────────────────────────
// Prices shown to a visitor are rounded to the digits people use, which for
// these currencies is fewer than the ISO exponent: their minor units (paisa,
// fils, sen...) exist on paper but prices are written in whole units, and CLDR
// (so Intl.NumberFormat) shows them with no decimals. Converted local prices
// (./pair.ts) and charm (./charm.ts) round to these digits, so a converted price
// formatted with displayFractionDigits() decimals is exactly the number in the
// JSON in every browser. Only converted estimates use them: an exact price (no
// conversion) is what the provider charges, to the ISO exponent above, which
// also stays the rule for amounts a provider receives or reports (validation,
// webhooks).
// The list is fixed here rather than read from Intl, whose defaults differ
// between ICU versions. Checked against ICU 78.3 (Node 26): exactly these 15
// allowlisted currencies have fewer CLDR digits than ISO, and none has more.
export const WHOLE_UNIT_DISPLAY_CURRENCIES: ReadonlySet<string> = new Set([
  "AFN", "ALL", "COP", "HUF", "IDR", "IQD", "IRR", "KPW", "LAK", "LBP",
  "MMK", "PKR", "SOS", "SYP", "YER",
]);

/** Decimals a price in this currency is shown and rounded with (PKR 0, USD 2, KWD 3, JPY 0). */
export function displayFractionDigits(currency: string | null | undefined): number {
  const c = normalizeCurrency(currency);
  return c && WHOLE_UNIT_DISPLAY_CURRENCIES.has(c) ? 0 : minorUnitExponent(c);
}

/** Amount in the currency's minor unit → major units (500 JPY → 500, 1500 KWD → 1.5, 1999 USD → 19.99). */
export function minorToMajor(amountMinor: number, currency: string | null | undefined): number {
  const exp = minorUnitExponent(currency);
  return exp === 0 ? amountMinor : amountMinor / 10 ** exp;
}
