import type { IntegrationProvider } from '../types/index.js';

// ── Provider key access ─────────────────────────────────────────────────────
// The least a payment platform key needs for GoPayLocal to work, shown in the
// dashboard's Connect dialog and repeated on each integration's docs page
// (apps/docs/src/content/docs/integrations/*.mdx): change both together.
//
// Each list covers exactly the calls the integration makes in
// apps/api/src/services/providers: product import, creating, listing and
// deleting discount codes, the redemption webhook, and Gumroad's sale lookup.
// GoPayLocal never creates a checkout with a merchant's key (only the
// verify:provider tool does, apps/api/src/provider-key-access.test.ts checks
// this), so no checkout permission is listed.
//
// Names are the ones the platform's key form uses. Sources:
//   Stripe   https://docs.stripe.com/stripe-apps/reference/permissions (the
//            same resources as restricted keys) and
//            https://docs.stripe.com/keys/restricted-api-keys
//   Paddle   https://developer.paddle.com/api-reference/about/permissions
//   Gumroad  the scope each API v2 controller asks for, in Gumroad's source
//            (github.com/antiwork/gumroad, app/controllers/api/v2)
//   Dodo     https://docs.dodopayments.com/api-reference/introduction
//   Chargebee https://www.chargebee.com/docs/billing/2.0/site-configuration/api_keys
//   Whop     the endpoint pages under https://docs.whop.com/api-reference
//   Polar    the endpoint pages under https://polar.sh/docs/api-reference
//   Creem    https://docs.creem.io/integrations/linkjolt (scope names)
//   WooCommerce https://developer.woocommerce.com/docs/apis/rest-api/

export interface ProviderKeyPermission {
  /** The permission or scope, as the platform's key form names it. */
  name: string;
  /** What GoPayLocal does with it. */
  usedFor: string;
}

export interface ProviderKeyAccess {
  /** Which kind of key to create. */
  key: string;
  permissions: readonly ProviderKeyPermission[];
  /** What the platform does or doesn't let you narrow. */
  note?: string;
}

const WEBHOOK = 'Creating the webhook that reports redemptions, and removing it when you disconnect';

export const PROVIDER_KEY_ACCESS: Record<IntegrationProvider, ProviderKeyAccess> = {
  stripe: {
    key: 'A restricted key (rk_…) with only these permissions. Everything else can stay None.',
    permissions: [
      { name: 'Products: Read', usedFor: 'Importing your products' },
      { name: 'Prices: Read', usedFor: 'Showing each product’s price when you import it' },
      { name: 'Coupons: Write', usedFor: 'Creating, listing and deleting the coupon behind each code' },
      { name: 'Promotion Codes: Write', usedFor: 'Creating and listing the codes customers enter' },
      { name: 'Webhook Endpoints: Write', usedFor: WEBHOOK },
    ],
    note: 'A secret key (sk_…) also works, but it can do anything in your Stripe account.',
  },
  paddle: {
    key: 'An API key with only these permissions.',
    permissions: [
      { name: 'discount.write', usedFor: 'Creating, listing and archiving the discounts (write includes read)' },
      { name: 'product.read', usedFor: 'Importing your products' },
      { name: 'price.read', usedFor: 'Showing each product’s prices when you import it' },
      { name: 'notification_setting.write', usedFor: WEBHOOK },
    ],
  },
  gumroad: {
    key: 'An access token: in Gumroad, go to Settings > Advanced, create an application and click Generate access token.',
    permissions: [
      { name: 'edit_products', usedFor: 'Creating, listing and deleting offer codes on your products' },
      { name: 'view_sales', usedFor: 'Reading the sale that used a code, and subscribing to sale notifications' },
    ],
    note: 'Gumroad gives that token every scope it has, and its form has no way to narrow it. GoPayLocal only calls endpoints these two scopes cover.',
  },
  dodopayments: {
    key: 'An API key with these resources set. Everything else can stay None.',
    permissions: [
      { name: 'Discounts: Write', usedFor: 'Creating, listing and deleting the discount codes' },
      {
        name: 'Products: Read (Write if Dodo charges the country price)',
        usedFor: "Importing your products; with Write, setting each country's price on the Dodo product a campaign prices",
      },
      { name: 'Webhooks: Write', usedFor: `${WEBHOOK}; reading its signing secret` },
    ],
  },
  chargebee: {
    key: 'A full-access key of the type All.',
    permissions: [
      { name: 'Coupons', usedFor: 'Creating, listing and deleting the coupons' },
      { name: 'Webhook endpoints', usedFor: WEBHOOK },
    ],
    note: 'Chargebee keys can’t be limited to some resources. Its Write and Update keys can’t delete, which removing codes needs, and a read-only key can’t create them.',
  },
  whop: {
    key: 'An API key with only these permissions.',
    permissions: [
      { name: 'promo_code:create', usedFor: 'Creating the promo codes' },
      { name: 'promo_code:basic:read', usedFor: 'Listing them' },
      { name: 'promo_code:delete', usedFor: 'Deleting them' },
      { name: 'developer:manage_webhook', usedFor: WEBHOOK },
    ],
  },
  polar: {
    key: 'An organization access token (polar_oat_…) with only these scopes. A personal access token doesn’t work.',
    permissions: [
      { name: 'discounts:read', usedFor: 'Listing the discounts' },
      { name: 'discounts:write', usedFor: 'Creating and deleting them' },
      { name: 'webhooks:write', usedFor: WEBHOOK },
    ],
  },
  creem: {
    key: 'An API key with Full access switched off and only these scopes.',
    permissions: [
      { name: 'products:read', usedFor: 'Importing your products, and applying each code to them' },
      { name: 'discounts:read', usedFor: 'Listing the discount codes' },
      { name: 'discounts:write', usedFor: 'Creating and deleting them' },
      { name: 'webhooks:read', usedFor: 'Reading the redemption webhook’s signing secret' },
      { name: 'webhooks:write', usedFor: WEBHOOK },
    ],
  },
  woocommerce: {
    key: 'A REST API key (WooCommerce > Settings > Advanced > REST API) for an Administrator or Shop Manager.',
    permissions: [
      { name: 'Read/Write', usedFor: 'Creating, listing and deleting coupons; reading your products and store currency' },
      { name: 'manage_woocommerce', usedFor: `The user’s capability (Administrator or Shop Manager). ${WEBHOOK}` },
    ],
    note: 'WooCommerce keys can’t be limited to some resources: Read/Write reaches everything that user can do in the store API.',
  },
};
