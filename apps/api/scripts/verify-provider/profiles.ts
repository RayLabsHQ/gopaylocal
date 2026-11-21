// ── Provider verification profiles ──────────────────────────────────────────
// The few per-provider facts the verification tool cannot learn from the
// PaymentProvider interface:
//   • which env var carries the provider's account id (ProviderConfig.siteId —
//     the connect flow fills it from `providerAccountId`),
//   • how to tell test credentials from live ones, and which hosts are live
//     (the network guard refuses those during a test run),
//   • what kind of id `--product` must be for buildCheckoutUrl.
// Everything else (which optional methods exist) is discovered from the
// provider instance itself.
//
// A provider that is registered in src/services/providers/index.ts but missing
// here still runs: the tool passes the name straight to createProvider(). It
// just cannot tell that provider's test credentials from live ones, so it then
// requires --allow-live. Adding a provider = one entry below.

import type { HostRule } from './network-guard';

export type Mode = 'test' | 'live';
export type DetectedMode = Mode | 'unknown';

export type ModeRule =
  /** The API key alone decides (provider ignores ProviderConfig.environment). */
  | { kind: 'key-prefix'; test: string[]; live: string[]; source: string }
  /**
   * The provider honours ProviderConfig.environment (picks the sandbox host).
   * Optional key prefixes / an account-id suffix let the tool catch a
   * contradiction early. Pair with `liveHosts` so the network guard enforces it.
   */
  | {
      kind: 'environment';
      test?: string[];
      live?: string[];
      /** An account id with this suffix is a test account (contradicts --environment live). */
      accountTestSuffix?: string;
      source: string;
    }
  /** Test vs live is visible in the account id (e.g. a `-test` site name). */
  | { kind: 'account-suffix'; testSuffix: string; source: string }
  /** Every call acts on the real account (no sandbox, or the provider can't reach it). */
  | { kind: 'always-live'; reason: string };

export interface AccountIdSpec {
  /** Provider-specific env var name; GPL_VERIFY_ACCOUNT_ID is accepted as a fallback. */
  env: string;
  label: string;
  required: boolean;
}

export interface ProviderProfile {
  displayName: string;
  accountId?: AccountIdSpec;
  mode: ModeRule;
  /**
   * Hosts that serve LIVE data. In a test run the network guard refuses to
   * connect to them, so a provider that ignores ProviderConfig.environment fails
   * loudly instead of touching live data. Omit when test and live share a host
   * (the key decides, e.g. Stripe).
   */
  liveHosts?: HostRule[];
  /**
   * The provider's API is the merchant's own host (the account id is its
   * https:// URL). The network guard then refuses every other host, whatever
   * the mode, so a run shows the credentials were sent nowhere else.
   */
  allowOnlyAccountHost?: boolean;
  /** Deliveries carry no signature; authenticity is established another way. */
  unsignedWebhooks?: boolean;
  /**
   * Scope the throwaway discount to --product (CreateDiscountParams.productIds)
   * and require --product. For providers without a sandbox, where an unscoped
   * discount would be redeemable on every real product while the run lasts.
   * Only valid when the provider's discount scope ids are the same kind as its
   * checkout product ids.
   */
  scopeDiscountToProduct?: boolean;
  /** What `--product` must be for buildCheckoutUrl. */
  checkoutId: string;
}

export const GENERIC_ENV = {
  apiKey: 'GPL_VERIFY_API_KEY',
  accountId: 'GPL_VERIFY_ACCOUNT_ID',
  webhookSecret: 'GPL_VERIFY_WEBHOOK_SECRET',
} as const;

export const PROVIDER_ALIASES: Record<string, string> = {
  dodo: 'dodopayments',
};

export const PROVIDER_PROFILES: Record<string, ProviderProfile> = {
  stripe: {
    displayName: 'Stripe',
    mode: {
      kind: 'key-prefix',
      test: ['sk_test_', 'rk_test_'],
      live: ['sk_live_', 'rk_live_'],
      source: 'https://docs.stripe.com/keys',
    },
    checkoutId: 'a Price id (price_...) or a Product id (prod_..., uses its default price)',
  },
  paddle: {
    displayName: 'Paddle Billing',
    mode: {
      kind: 'environment',
      // Keys created since 2025-05-06 carry the environment; older keys don't.
      test: ['pdl_sdbx_'],
      live: ['pdl_live_'],
      source: 'https://developer.paddle.com/api-reference/about/authentication',
    },
    liveHosts: ['api.paddle.com'],
    checkoutId: 'a Price id (pri_...) or a Product id (pro_..., uses its first active price)',
  },
  gumroad: {
    displayName: 'Gumroad',
    mode: {
      kind: 'always-live',
      reason: 'Gumroad has no sandbox or test mode; every API call acts on your real account',
    },
    liveHosts: ['api.gumroad.com'],
    unsignedWebhooks: true,
    // Unscoped, createDiscount() makes a `universal` offer code valid on every
    // product in the (real) store. Offer codes and checkout both take the product id.
    scopeDiscountToProduct: true,
    checkoutId: 'a Product id (as printed by list-products)',
  },
  chargebee: {
    displayName: 'Chargebee',
    accountId: {
      env: 'GPL_VERIFY_SITE_ID',
      label: 'Site name (the {site} in {site}.chargebee.com; with or without -test)',
      required: true,
    },
    mode: {
      // The provider targets `{site}-test` when environment is 'test'.
      kind: 'environment',
      accountTestSuffix: '-test',
      source: 'https://apidocs.chargebee.com/docs/api/getting-started',
    },
    // Any *.chargebee.com host that is not a `-test` site.
    liveHosts: [/^(?!.*-test\.chargebee\.com$)[a-z0-9-]+\.chargebee\.com$/],
    checkoutId: 'an Item Price id of a plan',
  },
  dodopayments: {
    displayName: 'Dodo Payments',
    mode: {
      kind: 'environment',
      test: ['dodo_test_'],
      live: ['dodo_live_'],
      source: 'https://docs.dodopayments.com/miscellaneous/test-mode-vs-live-mode',
    },
    liveHosts: ['live.dodopayments.com'],
    checkoutId: 'a Product id (pdt_...)',
  },
  polar: {
    displayName: 'Polar',
    mode: {
      kind: 'environment',
      source: 'https://polar.sh/docs/integrate/sandbox',
    },
    liveHosts: ['api.polar.sh'],
    checkoutId: 'a Product id (UUID)',
  },
  whop: {
    displayName: 'Whop',
    // Optional: the provider looks it up with GET /accounts/me when absent.
    accountId: { env: 'GPL_VERIFY_COMPANY_ID', label: 'Company id (biz_...), optional', required: false },
    mode: {
      // Sandbox and production keys look identical (no prefix); the provider
      // picks sandbox-api.whop.com when environment is 'test'.
      kind: 'environment',
      source: 'https://docs.whop.com/developer/guides/sandbox.md',
    },
    liveHosts: ['api.whop.com'],
    checkoutId: 'a Plan (variant) id (plan_...)',
  },
  creem: {
    displayName: 'Creem',
    mode: {
      // The provider picks test-api.creem.io when environment is 'test'. Test
      // keys start with creem_test_ (https://docs.creem.io/integrations/linkjolt);
      // live keys are creem_... with no distinct prefix, so only test is listed.
      kind: 'environment',
      test: ['creem_test_'],
      source: 'https://docs.creem.io/getting-started/test-mode',
    },
    liveHosts: ['api.creem.io'],
    checkoutId: 'a Product id (prod_...)',
  },
  woocommerce: {
    displayName: 'WooCommerce',
    // The store's own address: the API lives at {store}/wp-json/wc/v3.
    accountId: { env: 'GPL_VERIFY_STORE_URL', label: 'Store URL (https://...)', required: true },
    mode: {
      kind: 'always-live',
      reason: 'WooCommerce has no test mode; every API call acts on the real store',
    },
    // The API is the store itself: refuse every other host during the run.
    allowOnlyAccountHost: true,
    // An unscoped percent coupon would be redeemable on every product while the
    // run lasts. Coupon product_ids and checkout links both take product ids.
    scopeDiscountToProduct: true,
    // GPL_VERIFY_API_KEY is "<consumer key>:<consumer secret>" (ck_...:cs_...).
    checkoutId: 'a Product id (a number; for a variable product, the variation id)',
  },
};

export function normalizeProviderName(raw: string): string {
  const name = raw.trim().toLowerCase();
  return PROVIDER_ALIASES[name] ?? name;
}

/** Resolve the account id from the provider-specific env var, then the generic one. */
export function resolveAccountId(
  profile: ProviderProfile | undefined,
  env: Record<string, string | undefined>,
): { value?: string; source?: string; conflict?: string } {
  const specificName = profile?.accountId?.env;
  const specific = specificName ? env[specificName]?.trim() || undefined : undefined;
  const generic = env[GENERIC_ENV.accountId]?.trim() || undefined;
  if (specific && generic && specific !== generic) {
    return {
      conflict: `${specificName} and ${GENERIC_ENV.accountId} are both set to different values; set only one`,
    };
  }
  if (specific) return { value: specific, source: specificName };
  if (generic) return { value: generic, source: GENERIC_ENV.accountId };
  return {};
}
