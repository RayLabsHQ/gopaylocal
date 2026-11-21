// ── Charm pricing ───────────────────────────────────────────────────────────
// Rounds a converted price to a "charm" price point (₹1,599, R$59, €13.99) without
// ever misstating it in the visitor's disfavour:
//
//   - direction "up" (the price the visitor pays): the result is never below the
//     converted estimate and at most CHARM_MAX_DEVIATION (8%) above it.
//   - direction "down" (the struck-through original): never above the estimate
//     and at most 8% below it.
//
// Rounding the paid price up and the original down means the discount the two
// shown prices imply can never exceed the real coupon percentage. Choosing the
// two together (the implied-discount floor, crossing) is ./pair.ts's job.
//
// The estimate is first rounded, in the given direction, to the currency's
// display unit: its ISO 4217 minor unit, except whole units for the currencies
// in WHOLE_UNIT_DISPLAY_CURRENCIES (./exponents.ts), so what a visitor sees is
// the exact number. Each strategy then proposes candidates from coarse to fine;
// the first one within 8% wins, otherwise the rounded estimate itself is
// returned. Below 13 display units the 8% window is narrower than one unit, so
// only that rounding applies (and it can be more than 8%: 1.2 rounds up to 2).
//
// Strategies (the dashboard's labels in quotes):
//   none          the estimate, rounded to the minor unit.
//   dot99         ".99 ending": N.99 (N.990 in 3-decimal currencies). In
//                 currencies shown without decimals it behaves like round_x9.
//   round_x9      "Round to X9": ending in 9 at the second significant digit
//                 (29, 639, 1,599, 12,999, 119,999), then at the third, then N.99.
//   nearest_5     "Nearest $5": a multiple of 5 x 10^(d-2), d = integer digits
//                 (30, 650, 1,600, 115,000), then a multiple of a tenth of that.
//   region_aware  "Region-aware": KRW ends in 900 (₩13,900), IDR and VND end in
//                 9,000 (Rp159.000), with 100 / 1,000 / 1,000 as the finest step;
//                 every other currency behaves like round_x9.
//
// Charm is for converted estimates only. A visitor who pays in the product's own
// currency is shown the exact price (./local-price.ts never calls charm then).
//
// PURE MODULE: it imports only ./exponents.ts, which imports nothing. The SDKs
// bundle these files (with ./pair.ts) through a relative import, so none may
// import a package; currency.purity.test.ts enforces that.

import { displayFractionDigits, minorUnitExponent } from "./exponents";

export const CHARM_STRATEGIES = ["none", "dot99", "round_x9", "nearest_5", "region_aware"] as const;
export type CharmStrategy = (typeof CHARM_STRATEGIES)[number];
export type CharmDirection = "up" | "down";

/** Largest distance between a charm price and the estimate it rounds, as a fraction. */
export const CHARM_MAX_DEVIATION = 0.08;

/** region_aware: finest price step, in major units, for currencies with a convention. */
export const REGION_MIN_STEP: Readonly<Record<string, number>> = { KRW: 100, IDR: 1000, VND: 1000 };

/** Above this many display units charm returns null (no realistic price is this large). */
export const CHARM_MAX_UNITS = 1e12;

export function isCharmStrategy(value: unknown): value is CharmStrategy {
  return typeof value === "string" && (CHARM_STRATEGIES as readonly string[]).includes(value);
}

/**
 * Amount in minor units with floating-point noise removed (19.99 * 100 is
 * 1998.9999999999998 in binary floating point; this returns 1999). Below 1e9 minor
 * units the value is snapped to 1e-6 of a minor unit; above that the noise is
 * already far below a minor unit.
 */
function toMinor(amount: number, exponent: number): number {
  const scaled = amount * 10 ** exponent;
  return scaled < 1e9 ? Math.round(scaled * 1e6) / 1e6 : scaled;
}

/**
 * Round an amount to the currency's minor unit: "up", "down" or "half-up".
 * Returns null for a non-finite or negative amount.
 */
export function roundToMinorUnit(
  amount: number,
  currency: string,
  mode: CharmDirection | "half-up",
): number | null {
  return roundTo(amount, minorUnitExponent(currency), mode);
}

/**
 * Round an amount to the currency's display unit (displayFractionDigits: whole
 * PKR, IDR, COP...; otherwise the minor unit): "up", "down" or "half-up".
 * Returns null for a non-finite or negative amount.
 */
export function roundForDisplay(
  amount: number,
  currency: string,
  mode: CharmDirection | "half-up",
): number | null {
  return roundTo(amount, displayFractionDigits(currency), mode);
}

function roundTo(amount: number, exponent: number, mode: CharmDirection | "half-up"): number | null {
  if (!Number.isFinite(amount) || amount < 0) return null;
  const raw = toMinor(amount, exponent);
  const minor = mode === "up" ? Math.ceil(raw) : mode === "down" ? Math.floor(raw) : Math.round(raw);
  return minor / 10 ** exponent;
}

/**
 * Charm-round a converted price. Returns the price in major units, a whole number
 * of the currency's display units, or null when the amount is not a positive
 * finite number, is too large, or rounds down to zero. An unknown strategy is
 * treated as "none".
 */
export function charm(
  amount: number,
  currency: string,
  strategy: CharmStrategy,
  direction: CharmDirection = "up",
): number | null {
  const { unit, candidates } = charmCandidates(amount, currency, strategy, direction);
  return candidates.length > 0 ? candidates[0]! / unit : null;
}

/**
 * Every price charm() could choose for `amount`, as whole display units (divide
 * by `unit` for major units): the strategy's candidates from tidiest to finest
 * that lie in the 8% window, without duplicates, always ending with the plain
 * rounding of the estimate. charm() takes the first; ./pair.ts searches them
 * for the best paid/original pair. Empty in exactly the cases charm() is null.
 */
export function charmCandidates(
  amount: number,
  currency: string,
  strategy: CharmStrategy,
  direction: CharmDirection = "up",
): { unit: number; candidates: number[] } {
  const exponent = displayFractionDigits(currency);
  const unit = 10 ** exponent; // display units per major unit
  if (!Number.isFinite(amount) || amount <= 0) return { unit, candidates: [] };
  const raw = toMinor(amount, exponent);
  if (raw > CHARM_MAX_UNITS) return { unit, candidates: [] };

  const up = direction === "up";
  const estimate = up ? Math.ceil(raw) : Math.floor(raw);
  if (estimate <= 0) return { unit, candidates: [] };
  const low = up ? estimate : Math.ceil(raw * (1 - CHARM_MAX_DEVIATION));
  const high = up ? Math.floor(raw * (1 + CHARM_MAX_DEVIATION)) : estimate;

  // Nearest value on the estimate's side (above for "up", below for "down") whose
  // remainder modulo `step` is `step - offset`: offset 1 at step 10 is "ends in 9".
  const snap = (step: number, offset: number): number =>
    (up ? Math.ceil((estimate + offset) / step) : Math.floor((estimate + offset) / step)) * step - offset;
  const multipleOf = (stepMajor: number): number => snap(Math.max(1, Math.round(stepMajor * unit)), 0);
  // Ending in 9 at granularity `stepMajor`, with `nines` as the unit of the 9
  // (1: ...9, ...99; 100: ...900). Only meaningful when the step is 10x the unit.
  const endsIn9 = (stepMajor: number, ninesMajor = 1): number | null =>
    stepMajor >= 10 * ninesMajor ? snap(stepMajor * unit, ninesMajor * unit) : null;

  const integerPart = Math.floor(raw / unit);
  const digits = integerPart < 1 ? 1 : String(integerPart).length;
  const second = 10 ** Math.max(1, digits - 2); // 9 at the second significant digit
  const cents99 = exponent >= 2 ? snap(unit, 10 ** (exponent - 2)) : null; // N.99

  let proposals: Array<number | null>;
  switch (strategy) {
    case "dot99":
      proposals = exponent >= 2 ? [cents99] : [endsIn9(second), endsIn9(second / 10)];
      break;
    case "round_x9":
      proposals = [endsIn9(second), endsIn9(second / 10), cents99];
      break;
    case "nearest_5": {
      const step = 5 * 10 ** (digits - 2);
      proposals = [multipleOf(step), multipleOf(step / 10)];
      break;
    }
    case "region_aware": {
      const minStep = REGION_MIN_STEP[currency.toUpperCase()];
      proposals =
        minStep === undefined
          ? [endsIn9(second), endsIn9(second / 10), cents99]
          : [
              endsIn9(Math.max(second, 10 * minStep), minStep),
              endsIn9(Math.max(second / 10, 10 * minStep), minStep),
              multipleOf(minStep),
            ];
      break;
    }
    default:
      proposals = [];
  }

  const candidates: number[] = [];
  for (const v of proposals) {
    if (v !== null && v > 0 && v >= low && v <= high && !candidates.includes(v)) candidates.push(v);
  }
  if (!candidates.includes(estimate)) candidates.push(estimate);
  return { unit, candidates };
}
