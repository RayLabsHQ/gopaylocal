// ── Coupon Service ──────────────────────────────────────────────────────────
// High-level coupon management that orchestrates provider operations and
// local database records. This service:
//
// 1. Looks up the integration for the campaign
// 2. Gets the provider credentials for the campaign's ENVIRONMENT (live/test)
// 3. Creates the provider instance via the factory
// 4. Creates/deletes coupons in the provider
// 5. Stores coupon records in our DB
//
// Invariant the banner depends on: for a (campaign, country) there is at most one
// kind of coupon that may be displayed, namely an `active` row whose integration,
// environment and percent match the campaign's current ones
// (isDisplayableCoupon). Anything else is retired: deleted at its provider, or,
// if that delete fails, parked as `retiring` (never displayed, retried on the
// next reconcile, still matched by redemption webhooks).

import { eq, and, inArray } from 'drizzle-orm';
import { ulid } from 'ulid';
import type { Database } from '../db';
import type { Bindings } from '../bindings';
import { campaigns, coupons, integrations } from '../db/schema';
import {
  createProvider,
  ProviderError,
  ProviderAuthError,
  accessTokenEncFor,
  providerConfigFor,
  type PaymentProvider,
} from './providers';
import { decrypt, tokenEncryptionSecret } from '../lib/crypto';
import { generateCouponCode } from '../lib/coupon-code';

// ── Types ───────────────────────────────────────────────────────────────────

type Campaign = typeof campaigns.$inferSelect;
type Integration = typeof integrations.$inferSelect;
type Coupon = typeof coupons.$inferSelect;
type Environment = 'live' | 'test';

/** Coupon row statuses. Only `active` rows may ever reach a banner. */
export const COUPON_STATUS = {
  active: 'active',
  /** Superseded; the provider-side delete failed and will be retried. */
  retiring: 'retiring',
  /** Gone at the provider (set by syncProviderCoupons). */
  deleted: 'deleted',
} as const;

export interface CouponServiceError extends Error {
  code: 'NOT_FOUND' | 'PROVIDER_ERROR' | 'ALREADY_EXISTS' | 'INVALID_STATE';
  /** The underlying provider error, when there is one (e.g. ProviderAuthError). */
  providerError?: ProviderError;
}

function serviceError(
  code: CouponServiceError['code'],
  message: string,
  providerError?: ProviderError,
): CouponServiceError {
  const err = new Error(message) as CouponServiceError;
  err.code = code;
  if (providerError) err.providerError = providerError;
  return err;
}

function toServiceError(err: unknown): unknown {
  if (err instanceof ProviderError) return serviceError('PROVIDER_ERROR', err.message, err);
  return err;
}

/** True when `err` (raw or wrapped by this service) means the stored key was rejected. */
export function isProviderAuthFailure(err: unknown): boolean {
  if (err instanceof ProviderAuthError) return true;
  const wrapped = (err as Partial<CouponServiceError> | null)?.providerError;
  return wrapped instanceof ProviderAuthError;
}

export function campaignEnvironment(campaign: Pick<Campaign, 'environment'>): Environment {
  return campaign.environment === 'test' ? 'test' : 'live';
}

/** Percent equality that survives a float4 round trip (coupons.discount_percent is `real`). */
export function samePercent(a: number, b: number): boolean {
  return Math.abs(a - b) < 0.005;
}

export interface DisplayExpectation {
  integrationId: string | null;
  environment: Environment;
  discountPercent: number;
}

/**
 * May this coupon be shown on a banner that advertises `expected.discountPercent`
 * for a campaign wired to `expected.integrationId` in `expected.environment`?
 * Pure, so the banner cache can apply the same rule to the rows it reads.
 */
export function isDisplayableCoupon(
  coupon: Pick<Coupon, 'status' | 'integrationId' | 'environment' | 'discountPercent'>,
  expected: DisplayExpectation,
): boolean {
  return (
    coupon.status === COUPON_STATUS.active &&
    !!expected.integrationId &&
    coupon.integrationId === expected.integrationId &&
    coupon.environment === expected.environment &&
    samePercent(coupon.discountPercent, expected.discountPercent)
  );
}

// ── Coupon Code Generation ──────────────────────────────────────────────────
// generateCouponCode (and every provider format rule) lives in lib/coupon-code.ts,
// shared with the verify tool.

// ── Provider access ─────────────────────────────────────────────────────────

/**
 * A provider client for `integration` in `environment`. Constructor failures
 * (e.g. an invalid Chargebee site) surface as PROVIDER_ERROR like any other
 * provider failure instead of escaping as raw ProviderErrors.
 */
async function providerFor(
  env: Bindings,
  integration: Integration,
  environment: Environment,
): Promise<PaymentProvider> {
  const accessTokenEnc = accessTokenEncFor(integration, environment);
  if (!accessTokenEnc) {
    throw serviceError('INVALID_STATE', `Integration ${integration.id} has no ${environment} access token`);
  }
  const accessToken = await decrypt(accessTokenEnc, tokenEncryptionSecret(env));
  try {
    return createProvider(integration.provider, providerConfigFor(integration, environment, accessToken));
  } catch (err) {
    throw toServiceError(err);
  }
}

function otherEnvironment(e: Environment): Environment {
  return e === 'live' ? 'test' : 'live';
}

/**
 * Delete a discount at the provider, trying the environment it was recorded in
 * first. Rows written before coupons carried their real environment all say
 * 'live', so a 404 there is retried in the other environment when the
 * integration has credentials for it. Codes carry a random suffix, so this can
 * never hit a different coupon. Resolves when the discount is gone everywhere.
 */
async function deleteAtProvider(
  env: Bindings,
  integration: Integration,
  providerCouponId: string,
  recordedEnv: Environment,
): Promise<void> {
  const envs = [recordedEnv, otherEnvironment(recordedEnv)].filter(
    (e) => accessTokenEncFor(integration, e) != null,
  );
  if (envs.length === 0) {
    throw serviceError('INVALID_STATE', `Integration ${integration.id} has no access token`);
  }
  for (const [i, e] of envs.entries()) {
    const isFallback = i > 0 || e !== recordedEnv;
    let provider: PaymentProvider;
    try {
      provider = await providerFor(env, integration, e);
    } catch (err) {
      if (isFallback) return; // can't even build the fallback client: nothing conclusive to do
      throw err;
    }
    try {
      await provider.deleteDiscount(providerCouponId);
      return;
    } catch (err) {
      if (err instanceof ProviderError && err.statusCode === 404) continue; // not here / already gone
      // A rejected key in the fallback environment proves nothing about the
      // coupon; give up on that environment rather than wedge the cleanup.
      if (isFallback && err instanceof ProviderAuthError) return;
      throw toServiceError(err);
    }
  }
}

async function loadIntegration(
  db: Database,
  integrationId: string,
  organizationId: string,
): Promise<Integration | undefined> {
  const [row] = await db
    .select()
    .from(integrations)
    .where(and(eq(integrations.id, integrationId), eq(integrations.organizationId, organizationId)))
    .limit(1);
  return row;
}

/**
 * Take a superseded coupon out of service. Deleted at its own provider (its
 * integration may no longer be the campaign's) and then from our table. If the
 * provider delete fails, the row is parked as `retiring` so it is never shown
 * again and the delete is retried by the next reconcile. Never throws; returns
 * the failure for the caller to report.
 */
async function retireCoupon(
  db: Database,
  env: Bindings,
  coupon: Coupon,
  organizationId: string,
): Promise<unknown | null> {
  try {
    const integration =
      coupon.providerCouponId && coupon.integrationId
        ? await loadIntegration(db, coupon.integrationId, organizationId)
        : undefined;
    if (integration && coupon.providerCouponId) {
      await deleteAtProvider(env, integration, coupon.providerCouponId, coupon.environment);
    }
    await db.delete(coupons).where(eq(coupons.id, coupon.id));
    return null;
  } catch (err) {
    console.error(
      `[coupon] retire failed coupon=${coupon.id} provider_coupon=${coupon.providerCouponId ?? '-'}:`,
      err instanceof Error ? err.message : err,
    );
    if (coupon.status !== COUPON_STATUS.retiring) {
      try {
        await db.update(coupons).set({ status: COUPON_STATUS.retiring }).where(eq(coupons.id, coupon.id));
      } catch (markErr) {
        console.error(`[coupon] could not park coupon=${coupon.id} as retiring:`, markErr);
      }
    }
    return err;
  }
}

/** Create the discount at the provider and store it. No reuse logic: see reconcileCoupon. */
async function insertNewCoupon(
  db: Database,
  env: Bindings,
  campaign: Campaign,
  integration: Integration,
  countryCode: string,
  discountPercent: number,
  couponPrefix?: string | null,
): Promise<Coupon> {
  const environment = campaignEnvironment(campaign);
  const code = generateCouponCode(
    countryCode,
    discountPercent,
    couponPrefix ?? campaign.couponPrefix,
    integration.provider,
  );

  // Check if a coupon with this code already exists
  const existing = await db
    .select()
    .from(coupons)
    .where(eq(coupons.code, code))
    .limit(1)
    .then((rows) => rows[0]);

  if (existing) {
    throw serviceError('ALREADY_EXISTS', `Coupon with code '${code}' already exists`);
  }

  const provider = await providerFor(env, integration, environment);

  // Create the discount in the provider
  let providerDiscountId: string;
  let providerCode: string;
  let providerPromoCodeId: string | null;
  try {
    const result = await provider.createDiscount({
      name: `PPP ${countryCode} ${discountPercent}%`,
      code,
      discountType: 'percentage',
      amount: discountPercent,
    });
    providerDiscountId = result.providerDiscountId;
    // The provider's accepted code is the source of truth — it's what customers
    // must type at checkout, so it's what we store and the banner displays.
    providerCode = result.code || code;
    providerPromoCodeId = result.providerPromoCodeId ?? null;
  } catch (err) {
    throw toServiceError(err);
  }

  // Store the coupon record in our DB
  try {
    const [coupon] = await db
      .insert(coupons)
      .values({
        id: ulid(),
        campaignId: campaign.id,
        integrationId: integration.id,
        countryCode,
        environment,
        code: providerCode,
        discountPercent,
        providerCouponId: providerDiscountId,
        providerPromoCodeId,
        status: COUPON_STATUS.active,
        createdAt: new Date(),
      })
      .returning();
    return coupon!;
  } catch (err) {
    // The discount exists at the provider but we have no row for it: it would
    // be a live, untracked, never-cleaned-up code. Undo it (best-effort).
    await provider.deleteDiscount(providerDiscountId).catch((undoErr: unknown) => {
      console.error(`[coupon] orphaned provider discount ${providerDiscountId}:`, undoErr);
    });
    // Lost a race with a concurrent request creating the same (campaign,
    // country) coupon: coupons_one_active_per_country_idx let only one insert
    // through. Use the winner's row if it is the one we wanted.
    if (violatedConstraint(err) === ACTIVE_COUPON_INDEX) {
      const winner = await findDisplayableCoupon(db, campaign, countryCode, discountPercent);
      if (winner) return winner;
    }
    throw err;
  }
}

/** Partial unique index: one `active` coupon per (campaign, country). See db/schema.ts. */
export const ACTIVE_COUPON_INDEX = 'coupons_one_active_per_country_idx';

/** The constraint a (possibly Drizzle-wrapped) unique violation names, if any. */
function violatedConstraint(err: unknown): string | undefined {
  const cause = (err as { query?: unknown; cause?: unknown } | null)?.cause;
  const driver = typeof (err as { query?: unknown } | null)?.query === 'string' && cause ? cause : err;
  const d = driver as { code?: unknown; constraint_name?: unknown } | null;
  return d?.code === '23505' && typeof d.constraint_name === 'string' ? d.constraint_name : undefined;
}

/**
 * Converge (campaign, country) on exactly one displayable coupon: reuse a
 * matching one, retire every mismatched one (other percent, other integration,
 * other environment, or already retiring), and create a new one if needed.
 */
async function reconcileCoupon(
  db: Database,
  env: Bindings,
  campaign: Campaign,
  integration: Integration,
  countryCode: string,
  discountPercent: number,
  couponPrefix?: string | null,
): Promise<Coupon> {
  const expected: DisplayExpectation = {
    integrationId: integration.id,
    environment: campaignEnvironment(campaign),
    discountPercent,
  };

  const rows = await db
    .select()
    .from(coupons)
    .where(
      and(
        eq(coupons.campaignId, campaign.id),
        eq(coupons.countryCode, countryCode),
        inArray(coupons.status, [COUPON_STATUS.active, COUPON_STATUS.retiring]),
      ),
    );

  const match = rows.find((c) => isDisplayableCoupon(c, expected));
  for (const stale of rows) {
    if (!isDisplayableCoupon(stale, expected)) {
      await retireCoupon(db, env, stale, campaign.organizationId);
    }
  }
  if (match) return match;

  return insertNewCoupon(db, env, campaign, integration, countryCode, discountPercent, couponPrefix);
}

// ── Core Operations ─────────────────────────────────────────────────────────

/**
 * Ensure a coupon exists for a specific country and discount percentage.
 *
 * Idempotent: an existing coupon for the same campaign, country, integration,
 * environment and percent is returned as-is (re-activating a campaign must not
 * mint a second set of provider discounts). Superseded coupons for the country
 * are retired first. Otherwise the discount is created in the provider, in the
 * campaign's environment, and stored.
 */
export async function createCouponForCountry(
  db: Database,
  env: Bindings,
  campaign: Campaign,
  integration: Integration,
  countryCode: string,
  discountPercent: number,
  couponPrefix?: string,
): Promise<Coupon> {
  return reconcileCoupon(db, env, campaign, integration, countryCode, discountPercent, couponPrefix);
}

/**
 * Delete a coupon from both the provider and our database.
 *
 * The provider call uses the coupon's own environment (where it was created)
 * unless `deleteEnv` overrides it. Throws PROVIDER_ERROR, keeping the row, if
 * the provider refuses: the discount may still be live there.
 */
export async function deleteCoupon(
  db: Database,
  env: Bindings,
  couponId: string,
  integration: Integration,
  deleteEnv?: Environment,
): Promise<void> {
  // Look up the coupon
  const coupon = await db
    .select()
    .from(coupons)
    .where(eq(coupons.id, couponId))
    .limit(1)
    .then((rows) => rows[0]);

  if (!coupon) {
    throw serviceError('NOT_FOUND', `Coupon '${couponId}' not found`);
  }

  // Delete from provider if we have a provider coupon ID
  if (coupon.providerCouponId) {
    await deleteAtProvider(env, integration, coupon.providerCouponId, deleteEnv ?? coupon.environment);
  }

  // Remove from our database
  await db.delete(coupons).where(eq(coupons.id, couponId));
}

/**
 * Get an existing coupon for a campaign + country, or create one if needed.
 *
 * This is the primary method used by the banner/checkout flow. It ensures
 * exactly one displayable coupon exists per campaign-country pair (see
 * reconcileCoupon). Throws if a new coupon is needed and can't be created;
 * superseded coupons are never returned.
 */
export async function getOrCreateCoupon(
  db: Database,
  env: Bindings,
  campaign: Campaign,
  integration: Integration,
  countryCode: string,
  discountPercent: number,
): Promise<Coupon> {
  return reconcileCoupon(db, env, campaign, integration, countryCode, discountPercent);
}

/**
 * A stored coupon that may be displayed for this campaign/country/percent
 * without touching the provider, or undefined.
 */
export async function findDisplayableCoupon(
  db: Database,
  campaign: Pick<Campaign, 'id' | 'integrationId' | 'environment'>,
  countryCode: string,
  discountPercent: number,
): Promise<Coupon | undefined> {
  if (!campaign.integrationId) return undefined;
  const rows = await db
    .select()
    .from(coupons)
    .where(
      and(
        eq(coupons.campaignId, campaign.id),
        eq(coupons.countryCode, countryCode),
        eq(coupons.status, COUPON_STATUS.active),
      ),
    );
  const expected: DisplayExpectation = {
    integrationId: campaign.integrationId,
    environment: campaignEnvironment(campaign),
    discountPercent,
  };
  return rows.find((c) => isDisplayableCoupon(c, expected));
}

/**
 * List all active coupons for a campaign, optionally filtered by country.
 */
export async function listCouponsForCampaign(
  db: Database,
  campaignId: string,
  countryCode?: string,
): Promise<Coupon[]> {
  const conditions = [
    eq(coupons.campaignId, campaignId),
    eq(coupons.status, COUPON_STATUS.active),
  ];

  if (countryCode) {
    conditions.push(eq(coupons.countryCode, countryCode));
  }

  return db
    .select()
    .from(coupons)
    .where(and(...conditions));
}

/**
 * Gumroad lists a universal offer code under whichever product it is asked
 * about, so its "productId:offerCodeId" ids only compare on the offer-code part.
 */
function comparableDiscountId(provider: string, id: string): string {
  if (provider !== 'gumroad') return id;
  const idx = id.indexOf(':');
  return idx >= 0 ? id.slice(idx + 1) : id;
}

/**
 * Sync coupons from the payment provider.
 * Lists all discounts from the provider (in `syncEnv`) and marks our coupons
 * from that same environment that no longer exist there as deleted.
 *
 * When `orphaned > 0` the caller must call pushBannerConfigForOrg afterwards,
 * or the cached banner keeps showing the deleted codes. It can't happen here:
 * banner-cache.service imports this module. (No route calls this yet.)
 */
export async function syncProviderCoupons(
  db: Database,
  env: Bindings,
  integration: Integration,
  syncEnv: Environment = 'live',
): Promise<{ synced: number; orphaned: number }> {
  const provider = await providerFor(env, integration, syncEnv);

  let providerDiscounts;
  try {
    providerDiscounts = await provider.listDiscounts();
  } catch (err) {
    throw toServiceError(err);
  }

  // Our live coupons for this integration in the SAME environment: a test
  // listing says nothing about live coupons and vice versa.
  const ourCoupons = await db
    .select()
    .from(coupons)
    .where(
      and(
        eq(coupons.integrationId, integration.id),
        eq(coupons.environment, syncEnv),
        inArray(coupons.status, [COUPON_STATUS.active, COUPON_STATUS.retiring]),
      ),
    );

  const providerIds = new Set(
    providerDiscounts.map((d) => comparableDiscountId(integration.provider, d.providerDiscountId)),
  );
  let orphaned = 0;

  // Mark coupons that no longer exist in the provider
  for (const coupon of ourCoupons) {
    if (
      coupon.providerCouponId &&
      !providerIds.has(comparableDiscountId(integration.provider, coupon.providerCouponId))
    ) {
      await db
        .update(coupons)
        .set({ status: COUPON_STATUS.deleted })
        .where(eq(coupons.id, coupon.id));
      orphaned++;
    }
  }

  return { synced: providerDiscounts.length, orphaned };
}
