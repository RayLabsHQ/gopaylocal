import { normalizeCurrency } from "@gopaylocal/shared/currency";
import { FX_RATES_KEY } from "./fx-refresh.service";

/**
 * Request-path access to the rates document written by the FX refresh cron.
 *
 * The banner endpoint calls loadFxRates() for every `show: true` answer, so the
 * document is memoised per isolate for MEMO_MS on top of KV's own edge cache
 * (cacheTtl). New rates reach visitors within about 15 minutes of a refresh, and
 * most requests make no KV read for them.
 *
 * Returns the raw document; freshness and shape are judged per request by
 * localPricing() (usableFxRates), with the request's own clock. Never throws: on a
 * KV error the answer is null (exact prices in the merchant's currency), cached
 * briefly so a failing KV is not hit on every request.
 */

const MEMO_MS = 10 * 60_000;
const ERROR_MEMO_MS = 30_000;
const KV_CACHE_TTL_S = 300;

let memo: { doc: unknown; until: number } | null = null;

export async function loadFxRates(kv: KVNamespace, now: number = Date.now()): Promise<unknown> {
  if (memo && now < memo.until) return memo.doc;
  try {
    const doc = await kv.get(FX_RATES_KEY, { type: "json", cacheTtl: KV_CACHE_TTL_S });
    memo = { doc: doc ?? null, until: now + MEMO_MS };
  } catch (err) {
    console.warn("fx: could not read rates; serving exact prices", err);
    memo = { doc: null, until: now + ERROR_MEMO_MS };
  }
  return memo.doc;
}

/** FX_EXCLUDED_CURRENCIES ("ARS, ves") -> {"ARS", "VES"}; malformed entries are ignored. */
export function parseExcludedCurrencies(value: string | undefined): ReadonlySet<string> {
  const out = new Set<string>();
  for (const part of (value ?? "").split(",")) {
    const code = normalizeCurrency(part);
    if (code) out.add(code);
  }
  return out;
}

/** Tests only: forget the memoised document. */
export function resetFxCacheForTests(): void {
  memo = null;
}
