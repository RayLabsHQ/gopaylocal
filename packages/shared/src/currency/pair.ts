// ── The price pair ──────────────────────────────────────────────────────────
// The one implementation of "which two prices does a visitor see": the price
// after the discount and the original, either converted to the visitor's
// currency or exactly in the product's own. The API (./local-price.ts) and the
// SDKs (packages/js-sdk/src/price.ts) both call pricePair(), so the banner and
// any SDK-rendered price can never disagree.
//
// Rules for a converted pair, with p and o the exact converted paid and
// original prices and d the discount in percent:
//   1. The paid price is never below p and at most 8% above it (charm's window;
//      below 13 display units rounding up to one unit can exceed 8%).
//   2. The original is never above o and at most 8% below it.
//   3. The paid price is below the original.
//   4. The discount the two imply, 1 - paid / original, is never above d (this
//      follows from 1 and 2), and at least d - 2 points and at least 0.8 d, so
//      "17% off: ₴950 instead of ₴1,000" (5%) cannot happen.
// Search: charm's candidates for each price, tidiest first; pairs are tried by
// their finer level (max(i, j)), then the tidier paid price, then the tidier
// original, and the first pair meeting every rule wins. If none does, the plain
// pair (paid rounded up, original rounded down, to the display unit) is used;
// if even that crosses, the visitor gets the exact pair in the product's
// currency. A 100% discount converts to 0 with the converted original.
//
// Digits: a converted pair is a whole number of display units of its currency
// (displayFractionDigits, ./exponents.ts: whole PKR, IDR, COP...). The exact
// pair is what the provider charges, to the ISO minor unit (roundToMinorUnit:
// PKR 1,838.14), so a formatter shows a fractional amount with its ISO digits.
//
// PURE MODULE: it imports only ./charm (which imports only ./exponents). The
// SDKs bundle it through a relative import; currency.purity.test.ts enforces it.

import { charmCandidates, roundToMinorUnit, type CharmStrategy } from "./charm";

/** The implied discount may fall short of the real one by at most this many percentage points... */
export const IMPLIED_DISCOUNT_MAX_SHORTFALL = 2;
/** ...and must be at least this share of it. */
export const IMPLIED_DISCOUNT_MIN_SHARE = 0.8;

/** How to convert: the visitor's currency, units of it per unit of the base currency, the charm strategy. */
export interface PairConversion {
  currency: string;
  fxRate: number;
  strategy: CharmStrategy;
}

export interface PricePair {
  /** After the discount: what the visitor pays (an estimate when converted). */
  price: number;
  /** Before the discount, for a struck-through display. */
  original: number;
  /** The currency of both: the conversion's when converted, else the base currency. */
  currencyCode: string;
  /** True when both are converted estimates. */
  converted: boolean;
}

/** The discount as used for prices: clamped to 0-100, anything non-finite as 0. */
export function clampDiscount(discountPercent: number): number {
  return Number.isFinite(discountPercent) ? Math.min(100, Math.max(0, discountPercent)) : 0;
}

/**
 * The two prices for `amount` (in `baseCurrency`) at `discountPercent`, converted
 * with `conversion` when one is given and a valid pair exists, otherwise exact:
 * half-up to the base currency's ISO minor unit (what the provider charges), no
 * charm.
 */
export function pricePair(
  amount: number,
  discountPercent: number,
  baseCurrency: string,
  conversion: PairConversion | null,
): PricePair {
  const d = clampDiscount(discountPercent);
  const discounted = amount * (1 - d / 100);

  const exact = (): PricePair => ({
    price: roundToMinorUnit(discounted, baseCurrency, "half-up") ?? discounted,
    original: roundToMinorUnit(amount, baseCurrency, "half-up") ?? amount,
    currencyCode: baseCurrency,
    converted: false,
  });

  if (!conversion || !Number.isFinite(conversion.fxRate) || !(conversion.fxRate > 0)) return exact();
  const cur = conversion.currency;
  // A free plan is free in every currency (there is no original to convert).
  if (amount === 0) return { price: 0, original: 0, currencyCode: cur, converted: true };

  const o = charmCandidates(amount * conversion.fxRate, cur, conversion.strategy, "down");
  if (o.candidates.length === 0) return exact();
  const unit = o.unit;
  // 100% off: 0 in the visitor's currency, next to the tidiest original.
  if (discounted === 0) return { price: 0, original: o.candidates[0]! / unit, currencyCode: cur, converted: true };

  const p = charmCandidates(discounted * conversion.fxRate, cur, conversion.strategy, "up");
  if (p.candidates.length === 0) return exact();

  const floor = Math.max(d - IMPLIED_DISCOUNT_MAX_SHORTFALL, d * IMPLIED_DISCOUNT_MIN_SHARE);
  const fits = (paid: number, original: number): boolean =>
    paid < original && (1 - paid / original) * 100 >= floor - 1e-9;

  const P = p.candidates;
  const O = o.candidates;
  const levels = Math.max(P.length, O.length);
  for (let level = 0; level < levels; level++) {
    // Pairs whose finer side is at `level`: tidier paid price first, then tidier original.
    for (let i = 0; i <= Math.min(level, P.length - 1); i++) {
      for (let j = i === level ? 0 : level; j <= Math.min(level, O.length - 1); j++) {
        if (fits(P[i]!, O[j]!)) return { price: P[i]! / unit, original: O[j]! / unit, currencyCode: cur, converted: true };
      }
    }
  }

  // No pair meets every rule: the plain pair, unless even that crosses.
  const plainPaid = P[P.length - 1]!;
  const plainOriginal = O[O.length - 1]!;
  if (plainPaid < plainOriginal) {
    return { price: plainPaid / unit, original: plainOriginal / unit, currencyCode: cur, converted: true };
  }
  return exact();
}
