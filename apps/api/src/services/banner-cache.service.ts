/**
 * Banner Cache Service
 *
 * Pre-computes everything the banner endpoint needs for an organization and
 * pushes it to KV as ONE document per public key, so the hot path reads one
 * key and picks the product, the arm and the visitor's country in memory.
 *
 * KV keys:
 *   banner-config:{apiKeyId} -> CachedBannerConfig (document version 3)
 *   apikey:{hash}            -> { apiKeyId, organizationId }
 *   discount-epoch:{orgId}   -> discount-cache epoch (see parity.service.ts)
 *
 * The document maps every product of the organization to what serves it (a
 * campaign, or a running experiment with arms A and B and the split), and
 * every referenced campaign to its servable data, including what its local
 * prices are computed from (the product's price and currency and the campaign's
 * charm strategy; the exchange rates are read per request, see
 * services/fx-cache.ts). Which campaign serves a
 * product is decided by selectAllServings (banner-selection.ts): the database
 * fallback in routes/banner-script.ts calls the same selection on the same
 * loader output (loadServingInputs), so the two paths cannot disagree.
 *
 * A document whose `v` is not BANNER_DOC_VERSION is treated as a cache miss by
 * the endpoint (answered from the database, then rebuilt). A current document
 * older than BANNER_DOC_MAX_AGE_MS (or without `builtAt`) is still served, and
 * the endpoint has it compared with the database in the background
 * (refreshBannerConfigForOrg). It is rewritten only when it differs: the
 * backstop for two rebuilds racing (see pushBannerConfigForOrg) and for a
 * rebuild that failed.
 *
 * Triggered by: campaign create/update/delete, banner-config update,
 * product update/delete, parity-group changes, api-key create, experiment changes, plan changes, and
 * by the endpoint itself on a missing or outdated document, or on one that no
 * longer matches the database. Every rebuild also
 * starts a new discount-cache epoch, which invalidates every
 * discount:{epoch}:{campaignId}:{cc} entry of the organization.
 */

import { eq, and, desc, inArray } from "drizzle-orm";
import { ulid } from "ulid";
import type { Database } from "../db";
import {
  apiKeys,
  campaigns,
  bannerConfigs,
  products,
  parityGroups,
  countryParityMappings,
  coupons,
  subscriptions,
  experiments,
} from "../db/schema";
import { resolveEntitlements, type DeploymentEnv } from "../lib/entitlements";
import {
  countryDiscount,
  DEFAULT_PARITY_TIERS,
  PPP_MULTIPLIERS,
  workspaceParityGroups,
  type WorkspaceParityGroups,
} from "@gopaylocal/shared/parity";
import { COUNTRY_NAMES } from "@gopaylocal/shared/constants";
import { isCharmStrategy, type CharmStrategy } from "@gopaylocal/shared/currency";
import type { BannerConfig } from "@gopaylocal/shared/types";
import { isDisplayableCoupon, COUPON_STATUS } from "./coupon.service";
import { discountEpochKey, readDiscountEpoch } from "./parity.service";
import { BANNER_DOC_MAX_AGE_MS } from "./banner-hot-cache";
import {
  selectAllServings,
  type BannerEnvironment,
  type ProductServing,
  type SelectableCampaign,
  type SelectableExperiment,
} from "./banner-selection";

// ── Types ───────────────────────────────────────────────────────────────────

/**
 * Bump when the document shape changes: older documents become cache misses.
 * 3: campaigns carry `pricing`; countries no longer carry `currencySymbol`.
 */
export const BANNER_DOC_VERSION = 3;

/** Per-country discount data stored in KV. */
export interface CachedCountryData {
  discount: number;
  tier: number;
  code: string | null;
  countryName: string;
  /**
   * Set for a provider-backed campaign when no stored coupon for exactly this
   * percent exists yet: the endpoint resolves the code at request time with
   * getDiscountForCountry (which creates it at the provider, or answers "no
   * banner"), instead of showing a discount without a working code.
   */
  resolve?: true;
}

/**
 * What a campaign's local prices are computed from: its product's price and
 * currency (products.base_price, products.currency) and its charm strategy.
 */
export interface CampaignPricing {
  currency: string;
  basePrice: number;
  charm: CharmStrategy;
}

/** One campaign's servable data. */
export interface CachedCampaign {
  environment: BannerEnvironment;
  allowedDomains: string[] | null;
  banner: BannerConfig;
  pricing: CampaignPricing;
  countries: Record<string, CachedCountryData>;
}

/** The KV document stored under `banner-config:{apiKeyId}`. */
export interface CachedBannerConfig {
  v: typeof BANNER_DOC_VERSION;
  organizationId: string;
  /**
   * The discount-cache epoch current when the rows were read: the one this
   * rebuild started, or a newer one adopted by a repair pass.
   */
  epoch: string;
  /**
   * When the document was built (ms since the epoch). Missing in documents
   * written before the field existed; the endpoint treats those as due for a
   * refresh (bannerDocRefreshDue).
   */
  builtAt?: number;
  // Plan-derived: Free orgs show the "Powered by GoPayLocal" link, paid don't.
  // Rebuilt on dashboard edits + the upgrade webhook; the usage cron reconciles
  // the transitions without a trigger of their own (downgrade at period end).
  // The endpoint forces it off on self-hosted deployments whatever is cached.
  showBranding: boolean;
  /** Product a request without `product` is answered for (null: none). */
  defaultProductId: string | null;
  /** Product id -> what serves it. Products with nothing servable are absent. */
  products: Record<string, ProductServing>;
  /** Campaign id -> data, for every campaign referenced in `products`. */
  campaigns: Record<string, CachedCampaign>;
}

/** API key mapping stored in KV under `apikey:{hash}`. */
export interface CachedApiKey {
  apiKeyId: string;
  organizationId: string;
}

export function bannerDocKey(apiKeyId: string): string {
  return `banner-config:${apiKeyId}`;
}

/** True only for a document of the current version (anything else is a miss). */
export function isCurrentBannerDoc(doc: unknown): doc is CachedBannerConfig {
  if (!doc || typeof doc !== "object") return false;
  const d = doc as Partial<CachedBannerConfig>;
  return (
    d.v === BANNER_DOC_VERSION &&
    typeof d.products === "object" &&
    d.products !== null &&
    typeof d.campaigns === "object" &&
    d.campaigns !== null
  );
}

export { BANNER_DOC_MAX_AGE_MS };

/** True when a served document is due for a comparison with the database: older than BANNER_DOC_MAX_AGE_MS, or without builtAt. */
export function bannerDocRefreshDue(doc: CachedBannerConfig, now: number): boolean {
  const builtAt = doc.builtAt;
  if (typeof builtAt !== "number" || !Number.isFinite(builtAt)) return true;
  return now - builtAt >= BANNER_DOC_MAX_AGE_MS;
}

// ── Push Functions ──────────────────────────────────────────────────────────

/**
 * Push API key mapping to KV.
 * Called on api-key create. On delete, the KV entry is removed.
 */
export async function pushApiKeyToKV(
  kv: KVNamespace,
  keyHash: string,
  apiKeyId: string,
  organizationId: string,
): Promise<void> {
  const data: CachedApiKey = { apiKeyId, organizationId };
  await kv.put(`apikey:${keyHash}`, JSON.stringify(data));
}

/**
 * Remove API key mapping from KV.
 */
export async function removeApiKeyFromKV(
  kv: KVNamespace,
  keyHash: string,
): Promise<void> {
  await kv.delete(`apikey:${keyHash}`);
}

// ── Selection inputs (shared with the database fallback) ────────────────────

/** An active campaign with what the selection and the document need. */
export interface ServingCampaign extends SelectableCampaign {
  integrationId: string | null;
  pricingMode: string;
  maxDiscountPercent: number;
  discountOverrides: unknown;
  allowedDomains: string[] | null;
  /** null when the campaign has no banner_configs row (then not servable). */
  banner: BannerConfig | null;
  pricing: CampaignPricing;
}

export interface ServingInputs {
  campaigns: ServingCampaign[];
  experiments: SelectableExperiment[];
}

type BannerConfigRow = typeof bannerConfigs.$inferSelect;

function toBannerConfig(row: BannerConfigRow): BannerConfig {
  return {
    position: row.position as BannerConfig["position"],
    messageTemplate: row.messageTemplate,
    ctaText: row.ctaText,
    backgroundColor: row.backgroundColor,
    textColor: row.textColor,
    ctaColor: row.ctaColor,
    ctaTextColor: row.ctaTextColor,
    showFlag: row.showFlag,
    showCloseBtn: row.showCloseBtn,
  };
}

/**
 * Everything selection needs for one organization, in two queries: its active
 * campaigns (with their banner config, if any, and their product's price and
 * currency) and its running experiments. Used by the cache builder and by the
 * endpoint's database fallback.
 */
export async function loadServingInputs(db: Database, organizationId: string): Promise<ServingInputs> {
  const [campaignRows, experimentRows] = await Promise.all([
    db
      .select({
        campaign: campaigns,
        banner: bannerConfigs,
        product: { currency: products.currency, basePrice: products.basePrice },
      })
      .from(campaigns)
      // campaigns.product_id is NOT NULL and references products, so the inner
      // join keeps every campaign.
      .innerJoin(products, eq(products.id, campaigns.productId))
      .leftJoin(bannerConfigs, eq(bannerConfigs.campaignId, campaigns.id))
      .where(and(eq(campaigns.organizationId, organizationId), eq(campaigns.status, "active"))),
    db
      .select()
      .from(experiments)
      .where(and(eq(experiments.organizationId, organizationId), eq(experiments.status, "running"))),
  ]);

  return {
    campaigns: campaignRows.map(({ campaign, banner, product }) => ({
      id: campaign.id,
      productId: campaign.productId,
      environment: campaign.environment,
      status: campaign.status,
      createdAt: new Date(campaign.createdAt),
      hasBanner: !!banner,
      integrationId: campaign.integrationId,
      pricingMode: campaign.pricingMode,
      maxDiscountPercent: campaign.maxDiscountPercent,
      discountOverrides: campaign.discountOverrides,
      allowedDomains: (campaign.allowedDomains as string[] | null) ?? null,
      banner: banner ? toBannerConfig(banner) : null,
      pricing: {
        currency: product.currency,
        basePrice: product.basePrice,
        charm: isCharmStrategy(campaign.charmPricingStrategy) ? campaign.charmPricingStrategy : "none",
      },
    })),
    experiments: experimentRows.map((e) => ({
      id: e.id,
      productId: e.productId,
      environment: e.environment,
      status: e.status,
      campaignAId: e.campaignAId,
      campaignBId: e.campaignBId,
      trafficSplitB: e.trafficSplitB,
      startedAt: new Date(e.startedAt),
    })),
  };
}

// ── Document builder (pure) ─────────────────────────────────────────────────

export interface CouponForDisplay {
  campaignId: string;
  countryCode: string | null;
  code: string;
  status: string;
  integrationId: string | null;
  environment: "live" | "test";
  discountPercent: number;
}

export interface BannerDocInput {
  organizationId: string;
  epoch: string;
  /** Date.now() of the rebuild (the builder stays pure). */
  builtAt: number;
  showBranding: boolean;
  inputs: ServingInputs;
  /** The organization's own parity groups (workspaceParityGroups). */
  parityGroups: WorkspaceParityGroups;
  /** Active coupons of the referenced campaigns, newest first. */
  coupons: CouponForDisplay[];
}

function campaignEnvironmentOf(value: string): BannerEnvironment {
  return value === "test" ? "test" : "live";
}

function campaignCountries(
  campaign: ServingCampaign,
  parityGroups: WorkspaceParityGroups,
  couponsForCampaign: CouponForDisplay[],
): Record<string, CachedCountryData> {
  const overrides =
    campaign.pricingMode === "custom" &&
    campaign.discountOverrides &&
    typeof campaign.discountOverrides === "object"
      ? Object.keys(campaign.discountOverrides as Record<string, unknown>)
      : [];
  // Group mode without parity groups of its own prices from the default tiers.
  const defaultTierCountries =
    campaign.pricingMode === "group" && !parityGroups.hasOwnGroups
      ? DEFAULT_PARITY_TIERS.flatMap((t) => t.countries)
      : [];
  const countryCodes = new Set([
    ...Object.keys(PPP_MULTIPLIERS),
    ...parityGroups.byCountry.keys(),
    ...defaultTierCountries,
    ...overrides,
  ]);

  const out: Record<string, CachedCountryData> = {};
  for (const cc of [...countryCodes].sort()) {
    const { discount, tier } = countryDiscount(campaign, cc, parityGroups);
    // Zero-discount countries are left out to keep the payload small.
    if (discount <= 0) continue;
    out[cc] = {
      discount,
      tier,
      code: null,
      countryName: COUNTRY_NAMES[cc] ?? cc,
    };
  }

  // Codes: only a coupon of this campaign's integration and environment for
  // exactly the advertised percent (the same rule getDiscountForCountry uses).
  // Coupons arrive newest first, so the newest displayable one wins.
  const environment = campaignEnvironmentOf(campaign.environment);
  for (const coupon of couponsForCampaign) {
    const cc = coupon.countryCode;
    if (!cc || !Object.hasOwn(out, cc)) continue;
    const country = out[cc]!;
    if (country.code) continue;
    if (
      isDisplayableCoupon(coupon, {
        integrationId: campaign.integrationId,
        environment,
        discountPercent: country.discount,
      })
    ) {
      country.code = coupon.code;
    }
  }

  // A provider-backed campaign never shows a discount without its code: a
  // country with no displayable stored coupon is resolved at request time.
  if (campaign.integrationId) {
    for (const country of Object.values(out)) {
      if (!country.code) country.resolve = true;
    }
  }
  return out;
}

/** The ids of every campaign a set of servings can serve. */
export function referencedCampaignIds(servings: Record<string, ProductServing>): string[] {
  const ids = new Set<string>();
  for (const serving of Object.values(servings)) {
    if (serving.kind === "campaign") ids.add(serving.campaignId);
    else {
      ids.add(serving.campaignAId);
      ids.add(serving.campaignBId);
    }
  }
  return [...ids].sort();
}

/** Build the KV document from loaded rows. Pure, so it is unit-tested directly. */
export function buildBannerDoc(input: BannerDocInput): CachedBannerConfig {
  const { products: servings, defaultProductId } = selectAllServings(input.inputs);
  const byId = new Map(input.inputs.campaigns.map((c) => [c.id, c]));

  const couponsByCampaign = new Map<string, CouponForDisplay[]>();
  for (const coupon of input.coupons) {
    const list = couponsByCampaign.get(coupon.campaignId);
    if (list) list.push(coupon);
    else couponsByCampaign.set(coupon.campaignId, [coupon]);
  }

  const cachedCampaigns: Record<string, CachedCampaign> = {};
  for (const id of referencedCampaignIds(servings)) {
    const campaign = byId.get(id);
    // Selection only references servable campaigns, which have a banner.
    if (!campaign?.banner) continue;
    cachedCampaigns[id] = {
      environment: campaignEnvironmentOf(campaign.environment),
      allowedDomains: campaign.allowedDomains,
      banner: campaign.banner,
      pricing: campaign.pricing,
      countries: campaignCountries(campaign, input.parityGroups, couponsByCampaign.get(id) ?? []),
    };
  }

  return {
    v: BANNER_DOC_VERSION,
    organizationId: input.organizationId,
    epoch: input.epoch,
    builtAt: input.builtAt,
    showBranding: input.showBranding,
    defaultProductId,
    products: servings,
    campaigns: cachedCampaigns,
  };
}

/**
 * Repair passes a rebuild makes when it finds a newer epoch after writing (see
 * pushBannerConfigForOrg).
 */
export const BANNER_REBUILD_EXTRA_PASSES = 2;

/**
 * Rebuild and push the banner document for every public API key of an
 * organization, and start a new discount-cache epoch.
 *
 * Call it whenever anything that affects banner output changes (campaign,
 * banner config, product price or currency, parity groups, coupons,
 * experiments, plan). `env` is the
 * Worker env and is REQUIRED: it decides self-hosted mode, where branding is
 * always off. (The endpoint also forces branding off when self-hosted, so a
 * stale document can never show it there.)
 *
 * Two rebuilds can race. KV has no compare-and-set. If a change commits while
 * rebuild R1 sits between its reads and its writes, the change's own rebuild
 * R2 can finish first. R1 then overwrites R2's document with rows from before
 * the change. So after writing, a rebuild re-reads the epoch key. A newer
 * epoch (ULIDs sort by time) means another rebuild started after this one
 * read its rows. The rebuild then builds again under that epoch, from the
 * rows as they are now, without starting another epoch, so R2 has nothing to
 * repair. It makes at most BANNER_REBUILD_EXTRA_PASSES such passes.
 *
 * The re-read only sees R2's epoch when R2 wrote it from the same location
 * (or long enough ago: KV takes up to about 60 s to reach other locations),
 * and only when R2's machine clock is not behind this one's by more than the
 * time between the two epochs.
 * Otherwise the endpoint's comparison of documents older than
 * BANNER_DOC_MAX_AGE_MS with the database repairs it
 * (refreshBannerConfigForOrg). A stale document therefore lives at most about
 * 15 minutes plus about 60 seconds after the last write.
 */
export async function pushBannerConfigForOrg(
  db: Database,
  kv: KVNamespace,
  organizationId: string,
  env: DeploymentEnv,
): Promise<void> {
  // New discount-cache epoch first: even if the rest fails, no discount
  // cached before this change is served again.
  let epoch = ulid();
  await kv.put(discountEpochKey(organizationId), epoch);

  for (let extra = 0; ; extra++) {
    const wrote = await writeBannerDocs(db, kv, organizationId, env, epoch);
    if (!wrote || extra === BANNER_REBUILD_EXTRA_PASSES) return;
    // "0" when missing or unreadable; an older value (a stale KV read) is
    // ignored, never adopted.
    const current = await readDiscountEpoch(kv, organizationId);
    if (!(current > epoch)) return;
    epoch = current;
  }
}

/**
 * One pass: read every row the document is built from and write it under
 * `epoch` to each public key. False when the organization has no public key
 * (nothing written).
 */
async function writeBannerDocs(
  db: Database,
  kv: KVNamespace,
  organizationId: string,
  env: DeploymentEnv,
  epoch: string,
): Promise<boolean> {
  const source = await loadBannerDocSource(db, organizationId, env);
  if (!source) return false;
  const json = JSON.stringify(source.build(epoch, Date.now()));
  await Promise.all(source.keyIds.map((id) => kv.put(bannerDocKey(id), json)));
  return true;
}

/** The rows of one organization's document, read once; `build` is pure. */
interface BannerDocSource {
  /** Ids of the organization's public keys (one stored document each). */
  keyIds: string[];
  build(epoch: string, builtAt: number): CachedBannerConfig;
}

/** Read every row the document is built from. Null when the organization has no public key. */
async function loadBannerDocSource(
  db: Database,
  organizationId: string,
  env: DeploymentEnv,
): Promise<BannerDocSource | null> {
  // 1. Public keys: no document without one.
  const orgApiKeys = await db
    .select({ id: apiKeys.id })
    .from(apiKeys)
    .where(and(eq(apiKeys.organizationId, organizationId), eq(apiKeys.keyType, "public")));
  if (orgApiKeys.length === 0) return null;

  // 2. Inputs.
  const [inputs, groupRows, sub] = await Promise.all([
    loadServingInputs(db, organizationId),
    // Every group of the organization, with or without countries: a group
    // without countries still means "the organization has its own groups"
    // (no default tiers for group mode).
    db
      .select({
        groupId: parityGroups.id,
        discountPercent: parityGroups.discountPercent,
        sortOrder: parityGroups.sortOrder,
        countryCode: countryParityMappings.countryCode,
      })
      .from(parityGroups)
      .leftJoin(countryParityMappings, eq(countryParityMappings.parityGroupId, parityGroups.id))
      .where(eq(parityGroups.organizationId, organizationId)),
    db
      .select({
        plan: subscriptions.plan,
        status: subscriptions.status,
        currentPeriodEnd: subscriptions.currentPeriodEnd,
      })
      .from(subscriptions)
      .where(eq(subscriptions.organizationId, organizationId))
      .limit(1)
      .then((rows) => rows[0] ?? null),
  ]);

  // 3. Coupons of the campaigns that can be served.
  const referenced = referencedCampaignIds(selectAllServings(inputs).products);
  const couponRows =
    referenced.length > 0
      ? await db
          .select({
            campaignId: coupons.campaignId,
            countryCode: coupons.countryCode,
            code: coupons.code,
            status: coupons.status,
            integrationId: coupons.integrationId,
            environment: coupons.environment,
            discountPercent: coupons.discountPercent,
          })
          .from(coupons)
          .where(and(inArray(coupons.campaignId, referenced), eq(coupons.status, COUPON_STATUS.active)))
          .orderBy(desc(coupons.createdAt))
      : [];

  // 4. The builder, over the rows just read.
  const showBranding = resolveEntitlements(sub, env).showBranding;
  const groups = workspaceParityGroups(groupRows);
  return {
    keyIds: orgApiKeys.map((key) => key.id),
    build: (epoch, builtAt) =>
      buildBannerDoc({ organizationId, epoch, builtAt, showBranding, inputs, parityGroups: groups, coupons: couponRows }),
  };
}

/** What refreshBannerConfigForOrg found. */
export type BannerDocRefresh =
  /** Every stored document matches the database. Nothing was written. */
  | "current"
  /** A stored document was missing, outdated or different: rebuilt (pushBannerConfigForOrg). */
  | "rebuilt"
  /** The organization has no public key, so no document. Nothing was written. */
  | "no_keys";

/**
 * Compare an organization's stored documents with what the database says now,
 * and rebuild them only when one differs.
 *
 * The endpoint calls this for a served document older than
 * BANNER_DOC_MAX_AGE_MS. A document is written when something changes
 * (pushBannerConfigForOrg), so in the usual case the stored one still matches
 * and this reads (the rows, one KV value per public key) and writes nothing:
 * no new document, no new discount-cache epoch. It finds what a rebuild could
 * not guarantee: a rebuild that lost a race another location could not see, a
 * rebuild that failed after its change was saved, and anything in the document
 * that depends on the date.
 *
 * `epoch` and `builtAt` are left out of the comparison (they differ between
 * two rebuilds of the same rows), and so is the order of object keys.
 */
export async function refreshBannerConfigForOrg(
  db: Database,
  kv: KVNamespace,
  organizationId: string,
  env: DeploymentEnv,
): Promise<BannerDocRefresh> {
  const source = await loadBannerDocSource(db, organizationId, env);
  if (!source) return "no_keys";

  const expected = bannerDocContent(source.build("", 0));
  const stored = await Promise.all(source.keyIds.map((id) => readStoredBannerDoc(kv, id)));
  if (stored.every((doc) => doc !== null && bannerDocContent(doc) === expected)) return "current";

  await pushBannerConfigForOrg(db, kv, organizationId, env);
  return "rebuilt";
}

/** The stored document of one public key; null when missing, unreadable or of another version. */
async function readStoredBannerDoc(kv: KVNamespace, apiKeyId: string): Promise<CachedBannerConfig | null> {
  try {
    const raw = await kv.get(bannerDocKey(apiKeyId));
    const doc: unknown = raw ? JSON.parse(raw) : null;
    return isCurrentBannerDoc(doc) ? doc : null;
  } catch {
    return null;
  }
}

/**
 * A document as text for comparison: without `epoch` and `builtAt`, with the
 * keys of every object sorted. It goes through JSON like a stored document
 * does, so a value JSON drops or changes (undefined, NaN) compares equal to
 * what was stored for it.
 */
export function bannerDocContent(doc: CachedBannerConfig): string {
  const { epoch: _epoch, builtAt: _builtAt, ...content } = doc;
  return JSON.stringify(content, (_key, value: unknown) =>
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : value,
  );
}
