// ── Redemption tracking ─────────────────────────────────────────────────────
// Shared handler for provider webhooks: resolves a parsed RedemptionEvent to one
// of OUR coupons (scoped to the integration that received the webhook, so codes
// can't collide across orgs) and records a redemption + revenue-saved into
// analytics_rollups. Used by every customer-facing provider webhook.
//
// Exactly-once is the caller's job (routes/webhooks.ts claims the event row in
// the same transaction it passes in as `db`); this function only writes.

import { and, eq, or, sql, type SQL } from "drizzle-orm";
import { ulid } from "ulid";
import { coupons, campaigns, analyticsRollups } from "../db/schema";
import type { Database } from "../db";
import type { RedemptionDiscount, RedemptionEvent } from "./providers/types";
import { minorToMajor, normalizeCurrency } from "../lib/currency";

// Kept for existing importers (paddle.ts). The ISO 4217 table lives in lib/currency.
export { ZERO_DECIMAL_CURRENCIES as ZERO_DECIMAL } from "../lib/currency";

/**
 * analytics_rollups.revenue_saved (a dollar figure kept for existing readers)
 * only ever receives USD savings. Every currency, USD included, is recorded in
 * revenue_saved_by_currency as integer minor units keyed by ISO 4217 code, so
 * amounts in different currencies are never added together.
 */
export const REVENUE_SAVED_CURRENCY = "USD";

/**
 * Rollup country for a coupon without one. coupons.country_code is nullable and
 * the rollup unique index treats NULLs as distinct, so a NULL would insert a new
 * row on every redemption instead of incrementing one. "XX" is Cloudflare's
 * "unknown country" code, already treated as unknown by the banner route.
 */
export const UNKNOWN_COUNTRY = "XX";

/** Anything with drizzle's select/insert: the db or a transaction. */
export type DbWriter = Pick<Database, "select" | "insert">;

/**
 * Pre-tax savings for one redemption, in the currency's minor unit, or null if
 * unknown (contract C3, see RedemptionEvent): the provider's own pre-tax
 * discount when given; otherwise back-calculated from the pre-tax amount paid
 * (charged − tax) and the coupon's percent. With the tax unknown nothing is
 * back-calculated: a tax-inclusive total would count tax as savings.
 */
export function computeSavingsMinor(
  discountAmountMinor: number | null | undefined,
  chargedAmountMinor: number | null | undefined,
  taxAmountMinor: number | null | undefined,
  discountPercent: number,
): number | null {
  if (discountAmountMinor != null && Number.isFinite(discountAmountMinor) && discountAmountMinor > 0) {
    return Math.round(discountAmountMinor);
  }
  if (
    chargedAmountMinor != null &&
    Number.isFinite(chargedAmountMinor) &&
    taxAmountMinor != null &&
    Number.isFinite(taxAmountMinor) &&
    taxAmountMinor >= 0 &&
    discountPercent > 0 &&
    discountPercent < 100
  ) {
    const paidPreTax = Math.max(0, chargedAmountMinor - taxAmountMinor);
    // paid = list × (1 − p)  ⇒  saved = list × p = paid × p / (1 − p)
    return Math.round(paidPreTax * (discountPercent / (100 - discountPercent)));
  }
  return null;
}

/** Major-unit amount to add to analytics_rollups.revenue_saved (0 unless USD). */
export function revenueSavedForRollup(savingsMinor: number | null, currency: string | null): number {
  if (savingsMinor == null) return 0;
  if (normalizeCurrency(currency) !== REVENUE_SAVED_CURRENCY) return 0;
  return minorToMajor(savingsMinor, REVENUE_SAVED_CURRENCY);
}

/**
 * The (currency, minor units) pair to add to revenue_saved_by_currency, or null
 * when there is nothing to add (no savings, or no valid ISO currency code).
 */
export function savingsByCurrency(
  savingsMinor: number | null,
  currency: string | null,
): { currency: string; amountMinor: number } | null {
  if (savingsMinor == null || !(savingsMinor > 0)) return null;
  const code = normalizeCurrency(currency);
  if (!code) return null;
  return { currency: code, amountMinor: Math.round(savingsMinor) };
}

/** The primary discount followed by any stacked ones, in provider order. */
function discountsOf(r: RedemptionEvent): RedemptionDiscount[] {
  const primary: RedemptionDiscount = {
    code: r.code,
    providerCouponId: r.providerCouponId,
    providerPromoCodeId: r.providerPromoCodeId,
    discountAmountCents: r.discountAmountCents,
  };
  return [primary, ...(Array.isArray(r.otherDiscounts) ? r.otherDiscounts : [])];
}

type CouponRow = typeof coupons.$inferSelect;

function sameCode(a: string | null | undefined, b: string | null | undefined): boolean {
  return !!a && !!b && a.toLowerCase() === b.toLowerCase();
}

function matches(d: RedemptionDiscount, c: CouponRow): boolean {
  return (
    sameCode(d.code, c.code) ||
    (!!d.providerCouponId && d.providerCouponId === c.providerCouponId) ||
    (!!d.providerPromoCodeId && d.providerPromoCodeId === c.providerPromoCodeId)
  );
}

/**
 * Record a redemption for the coupon identified by `r`, scoped to `integrationId`.
 * Returns true if a matching coupon was found and the rollup was written.
 */
export async function handleRedemption(
  db: DbWriter,
  integrationId: string,
  organizationId: string,
  r: RedemptionEvent,
): Promise<boolean> {
  const discounts = discountsOf(r);

  // Match on whichever identifier(s) the provider gave us, for every discount
  // on the order. Codes compare case-insensitively: some providers echo codes
  // back in a different case than they were created with.
  const idMatches: SQL[] = [];
  for (const d of discounts) {
    if (d.code) idMatches.push(sql`lower(${coupons.code}) = ${d.code.toLowerCase()}`);
    if (d.providerCouponId) idMatches.push(eq(coupons.providerCouponId, d.providerCouponId));
    if (d.providerPromoCodeId) idMatches.push(eq(coupons.providerPromoCodeId, d.providerPromoCodeId));
  }
  if (idMatches.length === 0) return false;

  const candidates = await db
    .select()
    .from(coupons)
    .where(and(eq(coupons.integrationId, integrationId), or(...idMatches)))
    .limit(25);
  if (candidates.length === 0) return false; // not one of our coupons for this integration

  // Attribute to the first discount (provider order) that is one of ours.
  let coupon: CouponRow | undefined;
  let matchedDiscount: RedemptionDiscount | undefined;
  for (const d of discounts) {
    coupon = candidates.find((c) => matches(d, c));
    if (coupon) {
      matchedDiscount = d;
      break;
    }
  }
  if (!coupon || !matchedDiscount) return false;

  // Confirm the coupon's campaign belongs to this org (defense in depth).
  const [campaign] = await db
    .select({ organizationId: campaigns.organizationId })
    .from(campaigns)
    .where(and(eq(campaigns.id, coupon.campaignId), eq(campaigns.organizationId, organizationId)))
    .limit(1);
  if (!campaign) return false;

  // Prefer the provider's own pre-tax figure for THIS discount; otherwise
  // back-calculate from the pre-tax amount paid and the coupon's percent.
  const savingsMinor = computeSavingsMinor(
    matchedDiscount.discountAmountCents,
    r.chargedAmountCents,
    r.taxAmountCents,
    coupon.discountPercent,
  );
  const revenueSaved = revenueSavedForRollup(savingsMinor, r.currency);
  const saved = savingsByCurrency(savingsMinor, r.currency);

  const now = new Date();
  const periodStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

  await db
    .insert(analyticsRollups)
    .values({
      id: ulid(),
      organizationId,
      campaignId: coupon.campaignId,
      countryCode: coupon.countryCode ?? UNKNOWN_COUNTRY,
      period: "day",
      periodStart,
      environment: coupon.environment,
      impressions: 0,
      clicks: 0,
      copies: 0,
      redemptions: 1,
      revenueSaved,
      revenueSavedByCurrency: saved ? { [saved.currency]: saved.amountMinor } : {},
      createdAt: now,
    })
    .onConflictDoUpdate({
      target: [
        analyticsRollups.organizationId,
        analyticsRollups.campaignId,
        analyticsRollups.countryCode,
        analyticsRollups.period,
        analyticsRollups.periodStart,
        analyticsRollups.environment,
      ],
      set: {
        redemptions: sql`${analyticsRollups.redemptions} + 1`,
        revenueSaved: sql`${analyticsRollups.revenueSaved} + ${revenueSaved}`,
        ...(saved
          ? {
              // Typed params: jsonb_build_object takes "any", so untyped ones
              // can't be resolved by Postgres.
              revenueSavedByCurrency: sql`${analyticsRollups.revenueSavedByCurrency} || jsonb_build_object(${saved.currency}::text, COALESCE((${analyticsRollups.revenueSavedByCurrency} ->> ${saved.currency}::text)::bigint, 0) + ${saved.amountMinor}::bigint)`,
            }
          : {}),
      },
    });

  return true;
}
