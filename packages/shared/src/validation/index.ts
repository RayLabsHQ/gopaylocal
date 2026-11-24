import { z } from 'zod';
import { minorUnitExponent, normalizeCurrency } from '../currency/exponents';
import { SUPPORTED_CURRENCIES } from '../currency/supported-currencies';
import { normalizeWooCommerceStoreUrl, parseWooCommerceCredentials } from './woocommerce';
import {
  DEAL_MANUAL_CODE_PATTERN,
  MAX_DEAL_DAYS,
  MAX_DEAL_DURATION_MS,
  MAX_DEAL_NAME_LENGTH,
  MAX_DEAL_PERCENT,
  MIN_DEAL_PERCENT,
} from '../deals/index';

export * from './woocommerce';

// Update (PATCH) schemas must not carry defaults: routes write parsed.data
// straight into the row, so a default would overwrite the stored value of every
// field the client did not send. Zod 4 applies .default() even inside optional
// fields, so `createXSchema.partial()` would fill them in. Each resource
// therefore has one set of field validators without defaults; the create schema
// adds the defaults and the update schema makes the plain fields optional.

// ── Products ────────────────────────────────────────────────────────────────

export const UNSUPPORTED_CURRENCY_MESSAGE =
  'Use USD or the local currency of a country, as an ISO 4217 code such as EUR or INR';

const productFields = {
  name: z.string().min(1).max(200),
  url: z.url(),
  // Normalized to upper case ("usd" is stored as USD) and limited to the
  // currencies GoPayLocal has exchange rates for (SUPPORTED_CURRENCIES).
  currency: z
    .string()
    .trim()
    .toUpperCase()
    .refine((code) => SUPPORTED_CURRENCIES.has(code), { message: UNSUPPORTED_CURRENCY_MESSAGE }),
  basePrice: z.number().positive(),
  environment: z.enum(['live', 'test']),
};

/**
 * Why `basePrice` is not a valid price in `currency`, or null. A price must be a
 * whole number of the currency's ISO 4217 minor units (what a provider can
 * charge) and at least one of them: JPY 1,999.5 and USD 0.001 are refused.
 * Shared by the product schemas and the product update route, which checks a
 * patch that sends only one of the two against the stored other.
 */
export function basePriceProblem(basePrice: number, currency: string): string | null {
  const code = normalizeCurrency(currency) ?? currency;
  const exponent = minorUnitExponent(code);
  const scaled = basePrice * 10 ** exponent;
  const minor = Math.round(scaled);
  // Tolerates binary noise (19.99 * 100 is 1998.9999999999998), nothing more.
  const whole = Math.abs(scaled - minor) <= Math.max(1e-6, Math.abs(scaled) * 1e-12);
  if (whole && minor >= 1) return null;
  return exponent === 0
    ? `${code} prices are whole numbers of at least 1`
    : `${code} prices have at most ${exponent} decimals and are at least ${(1 / 10 ** exponent).toFixed(exponent)}`;
}

function checkBasePrice(v: { basePrice?: number; currency?: string }, ctx: z.RefinementCtx): void {
  if (v.basePrice === undefined || v.currency === undefined) return;
  const problem = basePriceProblem(v.basePrice, v.currency);
  if (problem) ctx.addIssue({ code: 'custom', path: ['basePrice'], message: problem });
}

export const createProductSchema = z
  .object({
    ...productFields,
    currency: productFields.currency.default('USD'),
    environment: productFields.environment.default('live'),
  })
  .superRefine(checkBasePrice);

// A patch with only one of basePrice and currency is checked by the route
// against the stored other (basePriceProblem).
export const updateProductSchema = z.object(productFields).partial().superRefine(checkBasePrice);

// ── Campaigns ───────────────────────────────────────────────────────────────

// Free-text limits for everything a merchant types that ends up in the banner's
// KV document (security review L4): generous for real use, small enough that no
// single field can blow up the document every banner request reads.
export const MAX_DISCOUNT_OVERRIDES = 300;
export const MAX_ALLOWED_DOMAINS = 100;
export const MAX_DOMAIN_LENGTH = 253;
export const MAX_BANNER_MESSAGE_LENGTH = 500;
export const MAX_BANNER_CTA_LENGTH = 50;
export const MAX_BANNER_COLOR_LENGTH = 64;

const campaignFields = {
  productId: z.string().min(1),
  integrationId: z.string().nullable().optional(),
  name: z.string().min(1).max(200),
  status: z.enum(['active', 'paused', 'draft']),
  pricingMode: z.enum(['group', 'ppp_factor', 'custom']),
  discountDelivery: z.enum(['banner_coupon', 'auto_apply', 'provider_price']),
  // The payment platform's product a 'provider_price' campaign prices per
  // country (a Dodo product id). Checked against the platform by the API.
  providerProductId: z.string().trim().min(1).max(128).nullable().optional(),
  charmPricingStrategy: z.enum(['none', 'dot99', 'round_x9', 'nearest_5', 'region_aware']),
  maxDiscountPercent: z.number().min(0).max(100),
  // Country code -> percent. Keys become country entries of the banner's KV
  // document, so both the key length and the number of entries are bounded.
  discountOverrides: z
    .record(z.string().length(2), z.number())
    .refine((r) => Object.keys(r).length <= MAX_DISCOUNT_OVERRIDES, {
      message: `At most ${MAX_DISCOUNT_OVERRIDES} per-country percentages`,
    })
    .nullable()
    .optional(),
  // Alphanumeric ≤8 so generated codes fit every provider's rules
  // (Dodo caps codes at 16 chars; Paddle/Polar reject separators).
  couponPrefix: z.string().regex(/^[A-Za-z0-9]+$/).max(8).nullable().optional(),
  // Host names (253 characters is the DNS maximum); stored in the banner's KV document.
  allowedDomains: z.array(z.string().max(MAX_DOMAIN_LENGTH)).max(MAX_ALLOWED_DOMAINS).nullable().optional(),
  environment: z.enum(['live', 'test']),
};

export const createCampaignSchema = z.object({
  ...campaignFields,
  status: campaignFields.status.default('draft'),
  pricingMode: campaignFields.pricingMode.default('group'),
  discountDelivery: campaignFields.discountDelivery.default('banner_coupon'),
  charmPricingStrategy: campaignFields.charmPricingStrategy.default('none'),
  maxDiscountPercent: campaignFields.maxDiscountPercent.default(70),
  environment: campaignFields.environment.default('live'),
});

export const updateCampaignSchema = z.object(campaignFields).partial();

// ── Experiments (A/B tests) ─────────────────────────────────────────────────

// trafficSplitB is the percent of visitors sent to campaign B (the variant).
// 0 and 100 are not allowed: an arm that gets no traffic is not a test.
const experimentFields = {
  name: z.string().trim().min(1).max(200),
  trafficSplitB: z.number().int().min(1).max(99),
};

export const DEFAULT_EXPERIMENT_TRAFFIC_SPLIT_B = 50;

export const createExperimentSchema = z
  .object({
    productId: z.string().min(1),
    campaignAId: z.string().min(1),
    campaignBId: z.string().min(1),
    ...experimentFields,
    trafficSplitB: experimentFields.trafficSplitB.default(DEFAULT_EXPERIMENT_TRAFFIC_SPLIT_B),
  })
  .refine((v) => v.campaignAId !== v.campaignBId, {
    path: ['campaignBId'],
    message: 'Campaign B must be a different campaign from campaign A',
  });

export const updateExperimentSchema = z
  .object(experimentFields)
  .partial()
  .refine((v) => v.name !== undefined || v.trafficSplitB !== undefined, {
    message: 'Nothing to update: send name and/or trafficSplitB',
  });

export const endExperimentSchema = z.object({
  winnerCampaignId: z.string().min(1),
});

// ── Parity Groups ───────────────────────────────────────────────────────────

// No defaults today; kept in the same shape as the schemas above so adding
// one to the create schema cannot leak into updates.
const parityGroupFields = {
  name: z.string().min(1).max(100),
  discountPercent: z.number().min(0).max(100),
  sortOrder: z.number().int().min(0),
};

export const createParityGroupSchema = z.object(parityGroupFields);

export const updateParityGroupSchema = z.object(parityGroupFields).partial();

export const setCountriesSchema = z.object({
  countries: z.array(z.string().length(2)),
});

// ── Banner Configs ──────────────────────────────────────────────────────────

export const updateBannerConfigSchema = z.object({
  position: z.enum(['top', 'bottom', 'bottom-left', 'bottom-right']).optional(),
  messageTemplate: z.string().min(1).max(MAX_BANNER_MESSAGE_LENGTH).optional(),
  ctaText: z.string().min(1).max(MAX_BANNER_CTA_LENGTH).optional(),
  backgroundColor: z.string().min(1).max(MAX_BANNER_COLOR_LENGTH).optional(),
  textColor: z.string().min(1).max(MAX_BANNER_COLOR_LENGTH).optional(),
  ctaColor: z.string().min(1).max(MAX_BANNER_COLOR_LENGTH).optional(),
  ctaTextColor: z.string().min(1).max(MAX_BANNER_COLOR_LENGTH).optional(),
  showFlag: z.boolean().optional(),
  showCloseBtn: z.boolean().optional(),
});

// ── Holiday deals ───────────────────────────────────────────────────────────
// A deal's percentage and where its code comes from are fixed once it exists
// (the code at the payment platform carries the percentage), so the update
// schema has neither.

/** An instant with a UTC offset, such as 2026-11-27T00:00:00Z. */
const dealInstant = z.iso.datetime({ offset: true });

const dealFields = {
  name: z.string().trim().min(1).max(MAX_DEAL_NAME_LENGTH),
  startsAt: dealInstant,
  endsAt: dealInstant,
  messageTemplate: z.string().min(1).max(MAX_BANNER_MESSAGE_LENGTH),
};

/** The message for a window that is empty, backwards or too long; null when fine. */
export function dealWindowError(startsAt: string | Date, endsAt: string | Date): string | null {
  const start = new Date(startsAt).getTime();
  const end = new Date(endsAt).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 'startsAt and endsAt must be dates';
  if (end <= start) return 'A deal must end after it starts';
  if (end - start > MAX_DEAL_DURATION_MS) return `A deal can run for at most ${MAX_DEAL_DAYS} days`;
  return null;
}

export const createDealSchema = z
  .object({
    name: dealFields.name,
    discountPercent: z.number().int().min(MIN_DEAL_PERCENT).max(MAX_DEAL_PERCENT),
    startsAt: dealFields.startsAt,
    endsAt: dealFields.endsAt,
    messageTemplate: dealFields.messageTemplate.optional(),
    /** Only for a campaign without a payment integration: a code you created yourself. */
    code: z.string().regex(DEAL_MANUAL_CODE_PATTERN).nullable().optional(),
  })
  .superRefine((deal, ctx) => {
    const message = dealWindowError(deal.startsAt, deal.endsAt);
    if (message) ctx.addIssue({ code: 'custom', path: ['endsAt'], message });
  });

export const updateDealSchema = z
  .object({
    name: dealFields.name.optional(),
    startsAt: dealFields.startsAt.optional(),
    endsAt: dealFields.endsAt.optional(),
    messageTemplate: dealFields.messageTemplate.optional(),
  })
  .refine((deal) => Object.values(deal).some((value) => value !== undefined), {
    message: 'Nothing to update',
  });

// ── API Keys ────────────────────────────────────────────────────────────────

export const createApiKeySchema = z.object({
  name: z.string().min(1).max(100),
  keyType: z.enum(['public', 'secret']),
});

// ── Integrations ────────────────────────────────────────────────────────────

export const INTEGRATION_PROVIDERS = [
  'dodopayments', 'stripe', 'paddle',
  'gumroad', 'chargebee', 'whop', 'polar',
  'creem',
  'woocommerce',
] as const;

/** Providers whose API calls need an account identifier besides the key. */
export const PROVIDERS_REQUIRING_ACCOUNT_ID = ['chargebee', 'whop', 'woocommerce'] as const;

/**
 * Providers whose products can be imported, so the dashboard offers Import.
 * The truth is the API's integrations products routes (GET
 * /v1/teams/:orgId/integrations/:id/products and POST .../products/import),
 * which answer 400 "This provider does not support product listing" when the
 * provider's adapter has no listProducts(). A route test
 * (apps/api/src/routes/integrations-product-import.test.ts) keeps this list
 * equal to the adapters.
 */
export const PROVIDERS_WITH_PRODUCT_IMPORT = [
  'stripe', 'paddle', 'gumroad', 'dodopayments', 'creem', 'woocommerce',
] as const satisfies readonly (typeof INTEGRATION_PROVIDERS)[number][];

export function providerCanImportProducts(provider: string): boolean {
  return (PROVIDERS_WITH_PRODUCT_IMPORT as readonly string[]).includes(provider);
}

/**
 * Providers with no test environment: every key acts on the real account. A
 * test-mode connection would create real, redeemable codes and count real
 * orders as test redemptions, so the API refuses test credentials for them and
 * the dashboard doesn't offer it. Values are display names for that message.
 */
export const PROVIDERS_WITHOUT_TEST_MODE: Readonly<Partial<Record<(typeof INTEGRATION_PROVIDERS)[number], string>>> = {
  gumroad: 'Gumroad',
  woocommerce: 'WooCommerce',
};

export function providerHasTestMode(provider: string): boolean {
  return !Object.prototype.hasOwnProperty.call(PROVIDERS_WITHOUT_TEST_MODE, provider);
}

export type ProviderAccountIdResult =
  | { ok: true; value: string | undefined }
  | { ok: false; message: string };

// Chargebee site names are DNS labels ({site}.chargebee.com). Same rule as the
// API adapter's normalizeChargebeeSite: anything else could point our
// API-key-bearing requests at another host.
const CHARGEBEE_SITE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const WHOP_ACCOUNT_ID = /^biz_[A-Za-z0-9]+$/;

/**
 * Validate and normalize the account identifier a provider needs, in the form
 * the API adapters expect:
 *  - chargebee: site name; a pasted URL ("https://acme.chargebee.com/") is
 *    reduced to "acme". In test mode the adapter adds "-test" itself, so a
 *    pasted "acme-test" is stored as "acme" and one value serves both modes.
 *  - whop: the biz_… account ID. Whop's automatic lookup uses an endpoint Whop
 *    marks as hidden, so the merchant supplies it.
 *  - woocommerce: the store's address, normalized to https://host[/path] by
 *    normalizeWooCommerceStoreUrl() (./woocommerce.ts holds the URL rules).
 *  - every other provider: not used; ignored (undefined).
 */
export function normalizeProviderAccountId(
  provider: string,
  raw: string | null | undefined,
  environment: 'live' | 'test' = 'live',
): ProviderAccountIdResult {
  const input = typeof raw === 'string' ? raw.trim() : '';
  switch (provider) {
    case 'chargebee': {
      if (!input) return { ok: false, message: 'Site name is required for Chargebee' };
      let site = input.toLowerCase().replace(/^https?:\/\//, '');
      site = site.split('/')[0] ?? '';
      site = site.replace(/\.chargebee\.com$/, '');
      if (environment === 'test' && site.endsWith('-test') && site.length > '-test'.length) {
        site = site.slice(0, -'-test'.length);
      }
      if (!CHARGEBEE_SITE.test(site)) {
        return { ok: false, message: 'Chargebee site must be the name in {site}.chargebee.com, for example acme' };
      }
      return { ok: true, value: site };
    }
    case 'whop': {
      if (!input) return { ok: false, message: 'Whop account ID (biz_…) is required' };
      if (!WHOP_ACCOUNT_ID.test(input)) {
        return { ok: false, message: 'Whop account ID must start with biz_, for example biz_AbC123' };
      }
      return { ok: true, value: input };
    }
    case 'woocommerce':
      return normalizeWooCommerceStoreUrl(input);
    default:
      return { ok: true, value: undefined };
  }
}

export const createIntegrationSchema = z
  .object({
    provider: z.enum(INTEGRATION_PROVIDERS),
    accessToken: z.string().trim().min(1),
    refreshToken: z.string().optional(),
    providerAccountId: z.string().optional(),
    environment: z.enum(['live', 'test']).default('live'),
  })
  .superRefine((val, ctx) => {
    // Chargebee needs the site and Whop the biz_ account ID for every API
    // call; without a valid one the adapter can't create coupons or process
    // webhooks. Callers store the normalized value
    // from normalizeProviderAccountId().
    const result = normalizeProviderAccountId(val.provider, val.providerAccountId, val.environment);
    if (!result.ok) {
      ctx.addIssue({ code: 'custom', path: ['providerAccountId'], message: result.message });
    }
    if (val.environment === 'test' && !providerHasTestMode(val.provider)) {
      ctx.addIssue({
        code: 'custom',
        path: ['environment'],
        message: `${PROVIDERS_WITHOUT_TEST_MODE[val.provider]} has no test mode. Connect it in Live.`,
      });
    }
    // WooCommerce's key is a consumer key and secret pair, stored as one token.
    if (val.provider === 'woocommerce' && !parseWooCommerceCredentials(val.accessToken)) {
      ctx.addIssue({
        code: 'custom',
        path: ['accessToken'],
        message: 'Paste the WooCommerce consumer key and consumer secret as ck_…:cs_…',
      });
    }
  });

// ── Analytics Events (from banner) ──────────────────────────────────────────

export const analyticsEventSchema = z.object({
  eventType: z.enum(['impression', 'click', 'copy', 'dismiss', 'redemption']),
  campaignId: z.string().min(1),
  countryCode: z.string().length(2),
  couponId: z.string().optional(),
  pageUrl: z.url().optional(),
  discountPercent: z.number().optional(),
});

export const analyticsEventBatchSchema = z.object({
  key: z.string().min(1),
  events: z.array(analyticsEventSchema).min(1).max(50),
});
