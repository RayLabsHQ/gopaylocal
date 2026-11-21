import { eq, and, asc, sql } from "drizzle-orm";
import {
  computeCountryDiscount,
  needsParityGroup,
  parityGroupFor,
  type CountryGroup,
} from "@gopaylocal/shared/parity";
import type { Database } from "../db";
import type { Bindings } from "../bindings";
import {
  campaigns,
  parityGroups,
  countryParityMappings,
  integrations,
} from "../db/schema";
import { kvGet, kvSet } from "../lib/kv";
import { errorSummary } from "../lib/log";
import { findDisplayableCoupon, getOrCreateCoupon, isProviderAuthFailure } from "./coupon.service";
import { clearIntegrationIssue, describeError, recordIntegrationIssue } from "./integration-health.service";

export interface DiscountResult {
  discount: number;
  tier: number;
  code: string | null;
}

/** What is cached; `codeUnavailable` marks a short-lived "show nothing" result. */
interface CachedDiscountResult extends DiscountResult {
  codeUnavailable?: true;
}

/** Normal cache lifetime. */
export const DISCOUNT_CACHE_TTL_SECONDS = 3600;
/** Lifetime of anything produced while the provider was failing: retry soon. */
export const DISCOUNT_FAILURE_TTL_SECONDS = 300;

// ── Discount cache invalidation ─────────────────────────────────────────────
// Discount cache keys carry a per-organization epoch:
//   discount-epoch:{orgId}               -> current epoch (no TTL)
//   discount:{epoch}:{campaignId}:{cc}   -> cached DiscountResult (TTL above)
// pushBannerConfigForOrg (banner-cache.service.ts), which every campaign,
// banner, parity-group, coupon and key change already triggers, writes a new
// epoch first. Every entry cached under the previous epoch is then unreachable
// and expires on its own TTL: no KV list or per-key delete, and no call site
// can forget to invalidate. An organization that was never rebuilt uses "0".

export function discountEpochKey(organizationId: string): string {
  return `discount-epoch:${organizationId}`;
}

export function discountCacheKey(epoch: string, campaignId: string, countryCode: string): string {
  return `discount:${epoch}:${campaignId}:${countryCode}`;
}

/** The organization's current discount-cache epoch ("0" if never set or unreadable). */
export async function readDiscountEpoch(cache: KVNamespace, organizationId: string): Promise<string> {
  try {
    return (await cache.get(discountEpochKey(organizationId))) || "0";
  } catch {
    return "0";
  }
}

// Pricing one country is pure and lives in @gopaylocal/shared/parity, so the KV
// cache builder (every country), getDiscountForCountry (one country) and the
// dashboard's New Campaign preview all use the same code. Re-exported here for
// the API's existing importers.
export {
  computeCountryDiscount,
  needsParityGroup,
  pickCountryGroups,
  type CountryGroup,
  type DiscountCampaign,
} from "@gopaylocal/shared/parity";

/**
 * Get the discount for a given country in a campaign.
 *
 * 1. Check KV cache first (key: discountCacheKey(epoch, campaignId, cc); the
 *    epoch is passed by a caller that already has it, else read from KV)
 * 2. Look up campaign from DB
 * 3. Price the country with computeCountryDiscount (group / ppp_factor /
 *    custom with group fallback), reading the parity group only when needed
 * 4. For a campaign wired to a payment integration, resolve the coupon code for
 *    exactly this percentage (creating it at the provider if needed). The code
 *    is never one that is known to be dead or to give a different percentage:
 *    if the provider fails, an already-stored coupon for the same percent is
 *    used; if there is none, the result is null (no banner for this country),
 *    the error is logged and recorded on the integration's health.
 * 5. Cache the result in KV (1 hour; 5 minutes for anything produced during a
 *    provider failure, so it recovers quickly)
 */
export async function getDiscountForCountry(
  db: Database,
  env: Bindings | undefined,
  organizationId: string,
  campaignId: string,
  countryCode: string,
  cache: KVNamespace,
  /** The organization's discount-cache epoch if the caller has it (the KV banner document does). */
  epoch?: string,
): Promise<DiscountResult | null> {
  const cacheKey = discountCacheKey(
    epoch ?? (await readDiscountEpoch(cache, organizationId)),
    campaignId,
    countryCode,
  );

  // 1. Check cache
  const cached = await kvGet<CachedDiscountResult>(cache, cacheKey);
  if (cached) {
    if (cached.codeUnavailable) return null;
    return { discount: cached.discount, tier: cached.tier, code: cached.code };
  }

  // 2. Look up campaign
  const campaign = await db
    .select()
    .from(campaigns)
    .where(
      and(eq(campaigns.id, campaignId), eq(campaigns.organizationId, organizationId)),
    )
    .limit(1)
    .then((rows) => rows[0]);

  if (!campaign || campaign.status !== "active") {
    return null;
  }

  // 3. Price the country (same functions as the KV cache builder). Group mode
  //    in a workspace without parity groups uses the default tiers.
  let group: CountryGroup | null = null;
  if (needsParityGroup(campaign, countryCode)) {
    const found = await getCountryGroup(db, organizationId, countryCode);
    group = parityGroupFor(campaign.pricingMode, countryCode, found.group, found.hasOwnGroups);
  }
  const { discount, tier } = computeCountryDiscount(campaign, countryCode, group);
  let code: string | null = null;

  // No discount, or no payment integration (codes aren't expected): nothing to
  // resolve at a provider.
  if (discount <= 0 || !campaign.integrationId) {
    const result: DiscountResult = { discount, tier, code: null };
    await cachePut(cache, cacheKey, result, DISCOUNT_CACHE_TTL_SECONDS);
    return result;
  }

  // 4. Provider-backed coupon for exactly this percentage.
  const integration = await db
    .select()
    .from(integrations)
    .where(
      and(
        eq(integrations.id, campaign.integrationId),
        eq(integrations.organizationId, organizationId),
      ),
    )
    .limit(1)
    .then((rows) => rows[0]);

  let syncFailed = false;
  if (env && integration?.status === "active") {
    try {
      const coupon = await getOrCreateCoupon(db, env, campaign, integration, countryCode, discount);
      code = coupon.code;
      await clearIntegrationIssue(db, integration, "coupon_sync");
    } catch (err) {
      syncFailed = true;
      // Never silent: this is the only signal that a merchant's provider is
      // refusing coupon operations (expired key, outage, plan limits...).
      console.error(
        `[parity] coupon sync failed org=${organizationId} campaign=${campaignId} ` +
          `country=${countryCode} discount=${discount} provider=${integration.provider}:`,
        describeError(err),
      );
      const environment = campaign.environment === "test" ? "test" : "live";
      await recordIntegrationIssue(db, integration, {
        area: isProviderAuthFailure(err) ? "credentials" : "coupon_sync",
        message: `Couldn't create the ${discount}% code for ${countryCode}: ${describeError(err)}`,
        environment,
      });
    }
  } else {
    // Integration missing/disabled, or no env to reach the provider with.
    syncFailed = true;
  }

  // Provider unavailable: an already-stored coupon is fine, but ONLY one for
  // this campaign's integration, environment and exact percentage. A coupon
  // for another percentage would advertise a discount the code doesn't give.
  if (!code) {
    const stored = await findDisplayableCoupon(db, campaign, countryCode, discount);
    code = stored?.code ?? null;
  }

  if (!code) {
    // Show nothing for this country rather than a wrong code, and look again
    // soon instead of pinning the failure for an hour.
    const marker: CachedDiscountResult = { discount, tier, code: null, codeUnavailable: true };
    await cachePut(cache, cacheKey, marker, DISCOUNT_FAILURE_TTL_SECONDS);
    return null;
  }

  const result: DiscountResult = { discount, tier, code };
  await cachePut(
    cache,
    cacheKey,
    result,
    syncFailed ? DISCOUNT_FAILURE_TTL_SECONDS : DISCOUNT_CACHE_TTL_SECONDS,
  );
  return result;
}

/**
 * Cache write that never fails the caller: the banner must still answer when
 * KV refuses a write (e.g. the 1 write/s/key limit); the next request just
 * recomputes. Logged, since a persistent failure means every banner load for
 * this country goes to Postgres.
 */
async function cachePut(cache: KVNamespace, key: string, value: unknown, ttl: number): Promise<void> {
  try {
    await kvSet(cache, key, value, ttl);
  } catch (err) {
    console.error("parity: discount cache write failed", { key, error: errorSummary(err) });
  }
}

/**
 * The parity group a country is mapped to in this organization, and whether the
 * organization has any parity group at all, in one query: every group of the
 * organization, left-joined to this country's mapping, mapped rows first.
 *  - no row: the organization has no parity groups
 *  - a row without a country: it has groups, none with this country
 *  - a row with the country: its group
 * A country in several groups resolves to the lowest sort order, then the
 * lowest group id; the KV cache builder (pickCountryGroups) uses the same order.
 */
async function getCountryGroup(
  db: Database,
  organizationId: string,
  countryCode: string,
): Promise<{ group: CountryGroup | null; hasOwnGroups: boolean }> {
  const rows = await db
    .select({
      discountPercent: parityGroups.discountPercent,
      sortOrder: parityGroups.sortOrder,
      countryCode: countryParityMappings.countryCode,
    })
    .from(parityGroups)
    .leftJoin(
      countryParityMappings,
      and(
        eq(countryParityMappings.parityGroupId, parityGroups.id),
        eq(countryParityMappings.countryCode, countryCode),
      ),
    )
    .where(eq(parityGroups.organizationId, organizationId))
    .orderBy(sql`${countryParityMappings.countryCode} is null`, asc(parityGroups.sortOrder), asc(parityGroups.id))
    .limit(1);

  const row = rows[0];
  if (!row) return { group: null, hasOwnGroups: false };
  return {
    group: row.countryCode ? { discountPercent: row.discountPercent, sortOrder: row.sortOrder } : null,
    hasOwnGroups: true,
  };
}
