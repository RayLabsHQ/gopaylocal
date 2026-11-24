import type { IntegrationProvider } from '@gopaylocal/shared'

// Providers whose API needs an account identifier besides the key. Must match
// PROVIDERS_REQUIRING_ACCOUNT_ID in @gopaylocal/shared/validation, which also
// normalizes what is typed here (e.g. a pasted Chargebee URL).
export type AccountIdField = { label: string; placeholder: string; help: string }

export type ProviderMeta = {
  id: IntegrationProvider
  name: string
  /** One line under the name on the "Add a platform" tiles. */
  summary: string
  /** What the platform calls the credential: "API key", "Access token", … */
  keyLabel: string
  /** Shown under the key field. */
  keyHelp?: string
  placeholder: { live: string; test: string }
  docsUrl: string
  /**
   * The platform lets the key be limited to the permissions GoPayLocal needs.
   * Gumroad, Chargebee and WooCommerce don't (PROVIDER_KEY_ACCESS[id].note).
   */
  narrowable: boolean
  accountId?: AccountIdField
}

export const PROVIDERS: ProviderMeta[] = [
  {
    id: 'stripe',
    name: 'Stripe',
    summary: 'Promotion codes · live and test',
    keyLabel: 'Restricted key',
    placeholder: { live: 'rk_live_…', test: 'rk_test_…' },
    docsUrl: 'https://docs.stripe.com/keys/restricted-api-keys',
    narrowable: true,
  },
  {
    id: 'paddle',
    name: 'Paddle',
    summary: 'Discount codes · live and sandbox',
    keyLabel: 'API key',
    placeholder: { live: 'pdl_live_apikey_…', test: 'pdl_sdbx_apikey_…' },
    docsUrl: 'https://developer.paddle.com/api-reference/about/api-keys',
    narrowable: true,
  },
  {
    id: 'gumroad',
    name: 'Gumroad',
    summary: 'Offer codes · live only',
    keyLabel: 'Access token',
    placeholder: { live: 'xxxxxxxx-xxxx-xxxx-xxxx…', test: 'xxxxxxxx-xxxx-xxxx-xxxx…' },
    docsUrl: 'https://gumroad.com/api',
    narrowable: false,
  },
  {
    id: 'dodopayments',
    name: 'Dodo Payments',
    summary: 'Discount codes · live and test',
    keyLabel: 'API key',
    placeholder: { live: 'dodo_live_…', test: 'dodo_test_…' },
    docsUrl: 'https://docs.dodopayments.com/api-reference/introduction',
    narrowable: true,
  },
  {
    id: 'chargebee',
    name: 'Chargebee',
    summary: 'Coupons · needs your site name',
    keyLabel: 'API key',
    placeholder: { live: 'live_…', test: 'test_…' },
    docsUrl: 'https://www.chargebee.com/docs/billing/2.0/site-configuration/api_keys',
    narrowable: false,
    accountId: {
      label: 'Site name',
      placeholder: 'acme',
      help: 'The name in {site}.chargebee.com. Use the same name for test mode; GoPayLocal adds -test itself.',
    },
  },
  {
    id: 'whop',
    name: 'Whop',
    summary: 'Promo codes · needs your account ID',
    keyLabel: 'API key',
    placeholder: { live: 'whop_…', test: 'whop_…' },
    docsUrl: 'https://docs.whop.com/api-reference/overview',
    narrowable: true,
    accountId: {
      label: 'Whop account ID',
      placeholder: 'biz_…',
      help: 'The ID of your Whop account. It starts with biz_.',
    },
  },
  {
    id: 'polar',
    name: 'Polar',
    summary: 'Discount codes · organization token',
    keyLabel: 'Organization access token',
    placeholder: { live: 'polar_oat_…', test: 'polar_oat_…' },
    docsUrl: 'https://polar.sh/docs/integrate/oat',
    narrowable: true,
  },
  {
    id: 'creem',
    name: 'Creem',
    summary: 'Discount codes · live and test',
    keyLabel: 'API key',
    placeholder: { live: 'creem_…', test: 'creem_test_…' },
    docsUrl: 'https://docs.creem.io/api-reference/introduction',
    narrowable: true,
  },
  {
    id: 'woocommerce',
    name: 'WooCommerce',
    summary: 'Coupons in your store · live only',
    keyLabel: 'REST API key',
    keyHelp: 'Paste it as ck_…:cs_…: the consumer key, a colon, then the consumer secret.',
    // No test mode (PROVIDERS_WITHOUT_TEST_MODE): in Test the tile says "Live only".
    placeholder: { live: 'ck_…:cs_…', test: 'ck_…:cs_…' },
    docsUrl: 'https://developer.woocommerce.com/docs/apis/rest-api/#generate-keys',
    narrowable: false,
    accountId: {
      label: 'Store URL',
      placeholder: 'https://shop.example.com',
      help: "Your store's https:// address.",
    },
  },
]

export function providerMeta(id: IntegrationProvider): ProviderMeta {
  return PROVIDERS.find((p) => p.id === id) ?? PROVIDERS[0]!
}

export function providerName(id: IntegrationProvider): string {
  return PROVIDERS.find((p) => p.id === id)?.name ?? id
}

/**
 * The dashboard is dark-only for now (lib/theme.ts). Paddle's own mark is
 * dark navy, so it gets a white copy; the others read on dark as they are.
 */
export function providerLogo(id: IntegrationProvider): string {
  return id === 'paddle' ? '/logos/paddle-on-dark.svg' : `/logos/${id}.svg`
}

/** A key label inside a sentence: "restricted key", but "API key" keeps its capitals. */
export function inSentence(label: string): string {
  return /^(API|REST)\b/.test(label) ? label : label.charAt(0).toLowerCase() + label.slice(1)
}

/** "a restricted key", "an API key", "an organization access token". */
export function withArticle(label: string): string {
  const text = inSentence(label)
  return `${/^[aeiou]/i.test(text) ? 'an' : 'a'} ${text}`
}
