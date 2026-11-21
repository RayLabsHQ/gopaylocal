// ── Exchange-rate document ──────────────────────────────────────────────────
// The API's FX refresh cron (apps/api/src/services/fx-refresh.service.ts) writes
// one validated document to KV; the banner endpoint reads it to convert prices.
// Rates are mid-market estimates, units of each currency per 1 USD.

export const FX_DOC_VERSION = 1;

/** Rates older than this (from their own date, not our fetch time) are not used. */
export const FX_MAX_AGE_HOURS = 96;

/**
 * Absolute sanity bounds for a rate in units per USD, applied when a feed is
 * validated and again whenever a stored rate is read. Real extremes: the
 * strongest currency is KWD at about 0.31 per USD (then BHD, OMR, JOD, GBP);
 * the weakest, IRR and LBP, are in the tens of thousands to about a million.
 * The range leaves 30x room below KWD and 10x above IRR's market rate. A rate
 * outside it gives the exact price in the product's currency.
 */
export const FX_MIN_RATE = 0.01;
export const FX_MAX_RATE = 1e7;

/** True for a finite rate inside [FX_MIN_RATE, FX_MAX_RATE). */
export function fxRatePlausible(rate: unknown): rate is number {
  return typeof rate === "number" && Number.isFinite(rate) && rate >= FX_MIN_RATE && rate < FX_MAX_RATE;
}

export interface FxRatesDoc {
  v: typeof FX_DOC_VERSION;
  base: "USD";
  /** YYYY-MM-DD: the date the feed states for these rates. */
  asOf: string;
  /** ISO timestamp of the refresh that wrote this document. */
  fetchedAt: string;
  /** Which configured source the rates came from. */
  source: "primary" | "fallback";
  /** Upper-case ISO 4217 code -> units per 1 USD. USD is 1. */
  rates: Record<string, number>;
  /**
   * Codes not accepted from the feed on the run that wrote this document. A held
   * code whose baseline is under FX_MAX_AGE_HOURS old is served at that baseline
   * (listed in `heldAsOf`); any other held code is left out of `rates`.
   */
  held: string[];
  /** Held codes served at their baseline -> the baseline's date (YYYY-MM-DD). */
  heldAsOf?: Record<string, string>;
  /**
   * Per code, the last rate that was cross-checked (both sources agreed), or with
   * a single configured source the last accepted rate, with its date. Kept
   * across holds; the refresh compares each new rate with it.
   */
  baseline?: Record<string, { rate: number; asOf: string }>;
}

/**
 * The body's `data` of GET /v1/teams/:orgId/fx-rates (the banner editor's
 * preview). `fx` is the stored document (without the refresh's `baseline`), so
 * the editor passes it straight to localPricing(), with `excludedCurrencies`
 * (the deployment's FX_EXCLUDED_CURRENCIES) as its excludedCurrencies, exactly
 * as the banner endpoint does. `available: false` exactly when the banner
 * endpoint would not convert. Shared by the API route and the dashboard so the
 * two cannot drift.
 */
export type FxRatesView =
  | { available: false }
  | { available: true; fx: FxRatesDoc; excludedCurrencies?: string[] };

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

/** Midnight UTC of a YYYY-MM-DD date, in ms, or NaN. */
export function fxDateMs(date: string): number {
  return DATE_RE.test(date) ? Date.parse(`${date}T00:00:00Z`) : Number.NaN;
}

/** True when a YYYY-MM-DD date is not in the future and at most FX_MAX_AGE_HOURS old at `now`. */
export function fxDateFresh(date: string, now: number): boolean {
  const ms = fxDateMs(date);
  return Number.isFinite(ms) && ms <= now + DAY_MS && now - ms <= FX_MAX_AGE_HOURS * 3_600_000;
}

/**
 * The document if it is well formed and fresh enough to convert prices with at
 * `now`, otherwise null. Anything read back from KV goes through this. A held
 * code served at a baseline that is now too old is dropped from the returned
 * rates (that visitor gets the exact price), even if no newer document exists.
 */
export function usableFxRates(doc: unknown, now: number): FxRatesDoc | null {
  if (!doc || typeof doc !== "object") return null;
  const d = doc as Partial<FxRatesDoc>;
  if (d.v !== FX_DOC_VERSION || d.base !== "USD" || typeof d.asOf !== "string") return null;
  if (!d.rates || typeof d.rates !== "object" || d.rates.USD !== 1) return null;
  if (!fxDateFresh(d.asOf, now)) return null;
  const heldAsOf = d.heldAsOf;
  if (heldAsOf && typeof heldAsOf === "object") {
    let stale: string[] | null = null;
    for (const [code, date] of Object.entries(heldAsOf)) {
      if (typeof date !== "string" || !fxDateFresh(date, now)) (stale ??= []).push(code);
    }
    if (stale) {
      const rates = { ...d.rates };
      for (const code of stale) delete rates[code];
      return { ...(d as FxRatesDoc), rates };
    }
  }
  return d as FxRatesDoc;
}

/** Units per 1 USD for `code`, or null if the document has no usable rate for it (missing or outside the sanity bounds). */
export function fxRateOf(doc: FxRatesDoc, code: string): number | null {
  const rate = Object.prototype.hasOwnProperty.call(doc.rates, code) ? doc.rates[code] : undefined;
  return fxRatePlausible(rate) ? rate : null;
}
