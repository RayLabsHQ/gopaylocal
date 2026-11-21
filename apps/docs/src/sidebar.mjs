// Sidebar definition, shared by astro.config.mjs (Starlight's `sidebar` option)
// and the llms.txt endpoints in src/pages, which list pages in the same order.
// Plain .mjs so the Astro config can import it without a TypeScript loader.

/** @type {Array<{ label: string; collapsed?: boolean; items: Array<{ slug: string }> }>} */
export const sidebar = [
  {
    label: 'Getting Started',
    items: [
      { slug: 'getting-started/introduction' },
      { slug: 'getting-started/quickstart' },
      { slug: 'getting-started/how-it-works' },
      { slug: 'getting-started/concepts' },
    ],
  },
  {
    label: 'AI agents',
    items: [
      { slug: 'ai/overview' },
      { slug: 'ai/integration-prompt' },
      { slug: 'ai/reference-card' },
    ],
  },
  {
    label: 'Banner Script',
    items: [
      { slug: 'banner/installation' },
      { slug: 'banner/customization' },
      { slug: 'banner/positioning' },
      { slug: 'banner/events' },
    ],
  },
  {
    label: 'React SDK',
    items: [
      { slug: 'react/installation' },
      { slug: 'react/provider' },
      { slug: 'react/hooks' },
      { slug: 'react/components' },
      { slug: 'react/pricing-table' },
    ],
  },
  {
    label: 'JavaScript SDK',
    items: [
      { slug: 'js/installation' },
      { slug: 'js/client' },
      { slug: 'js/data-attributes' },
      { slug: 'js/banner' },
    ],
  },
  {
    label: 'Integrations',
    items: [
      { slug: 'integrations/overview' },
      { slug: 'integrations/dodo-payments' },
      { slug: 'integrations/stripe' },
      { slug: 'integrations/paddle' },
      { slug: 'integrations/gumroad' },
      { slug: 'integrations/chargebee' },
      { slug: 'integrations/whop' },
      { slug: 'integrations/polar' },
      { slug: 'integrations/creem' },
      { slug: 'integrations/woocommerce' },
    ],
  },
  {
    label: 'Dashboard',
    items: [
      { slug: 'dashboard/products' },
      { slug: 'dashboard/campaigns' },
      { slug: 'dashboard/parity-groups' },
      { slug: 'dashboard/analytics' },
      { slug: 'dashboard/api-keys' },
      { slug: 'dashboard/team' },
      { slug: 'dashboard/billing' },
    ],
  },
  {
    label: 'API Reference',
    collapsed: true,
    items: [
      { slug: 'api/authentication' },
      { slug: 'api/products' },
      { slug: 'api/campaigns' },
      { slug: 'api/deals' },
      { slug: 'api/experiments' },
      { slug: 'api/parity-groups' },
      { slug: 'api/banner' },
      { slug: 'api/analytics' },
      { slug: 'api/integrations' },
      { slug: 'api/api-keys' },
      { slug: 'api/webhooks' },
    ],
  },
  {
    label: 'Guides',
    items: [
      { slug: 'guides/pricing-modes' },
      { slug: 'guides/charm-pricing' },
      { slug: 'guides/vpn-detection' },
      { slug: 'guides/ab-testing' },
      { slug: 'guides/holiday-deals' },
      { slug: 'guides/multi-currency' },
      { slug: 'guides/auto-apply' },
      { slug: 'guides/moving-from-lemon-squeezy' },
    ],
  },
  {
    label: 'Platform Guides',
    collapsed: true,
    items: [
      { slug: 'platforms/nextjs' },
      { slug: 'platforms/remix' },
      { slug: 'platforms/astro' },
      { slug: 'platforms/wordpress' },
      { slug: 'platforms/shopify' },
      { slug: 'platforms/webflow' },
      { slug: 'platforms/framer' },
      { slug: 'platforms/carrd' },
    ],
  },
  {
    label: 'Self-hosting',
    items: [
      { slug: 'self-hosting' },
      { slug: 'self-hosting/database' },
      { slug: 'self-hosting/cloudflare' },
      { slug: 'self-hosting/oauth' },
      { slug: 'self-hosting/first-admin' },
      { slug: 'self-hosting/configuration' },
      { slug: 'self-hosting/upgrading' },
      { slug: 'self-hosting/hosted-differences' },
    ],
  },
];
