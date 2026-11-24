import {
  PLAN_LIMITS,
  PLAN_PRICES_USD,
  PRO_FAIR_USE_API_HITS_PER_MONTH,
  formatLimit,
} from '@gopaylocal/shared/constants';
import { PPP_MULTIPLIERS, calculatePppDiscount } from '@gopaylocal/shared/parity';

export type LandingVariant = 'full' | 'dev' | 'revenue';

export interface HeroData {
  tag: string;
  headline: string;
  subline: string;
  primaryCta: { label: string; href: string; icon?: string };
  secondaryCta: { label: string; href: string };
  codeSnippet?: boolean;
  stats: { value: string; label: string; accent?: boolean }[];
}

export interface Feature {
  icon: string;
  title: string;
  description: string;
}

// Honest, verifiable proof points — NOT fabricated customer testimonials.
// Real testimonials get added here once collected post-launch.
export interface ProofPoint {
  label: string;
  description: string;
}

export interface LandingData {
  hero: HeroData;
  howItWorks: {
    title: string;
    subtitle: string;
    steps: { number: string; title: string; description: string }[];
  };
  features: {
    title: string;
    items: Feature[];
  };
  socialProof: {
    title: string;
    subtitle: string;
    proofPoints: ProofPoint[];
  };
  finalCta: {
    title: string;
    subtitle: string;
  };
}

const integrations = ['Stripe', 'Paddle', 'Gumroad', 'Chargebee', 'Dodo', 'Polar', 'Whop', 'Creem', 'WooCommerce'];

// Counts quoted in the copy, computed so the page can't drift from the code.
/** Countries with built-in PPP data (packages/shared/src/parity). */
export const PPP_COUNTRY_COUNT = Object.keys(PPP_MULTIPLIERS).length;
export const INTEGRATION_COUNT = integrations.length;

// Example prices in the copy: what a visitor pays with the code from a campaign
// left at the dashboard's defaults for a new campaign (PPP Factor mode, 50% maximum
// discount: apps/dashboard/src/routes/dashboard/campaigns/new.tsx). The API prices
// that mode with calculatePppDiscount (apps/api/src/services/parity.service.ts).
export const DEFAULT_MAX_DISCOUNT = 50;
// Says which default: the API's own defaults for a campaign differ (Group mode, 70%).
export const DEFAULT_SETTINGS = `the dashboard's defaults for a new campaign (PPP Factor, ${DEFAULT_MAX_DISCOUNT}% maximum discount)`;
export const defaultDiscount = (country: string) => calculatePppDiscount(country, DEFAULT_MAX_DISCOUNT);
/** 'No discount' or '35% off' for a country under the default settings. */
export const defaultDiscountLabel = (country: string) => {
  const d = defaultDiscount(country);
  return d === 0 ? 'No discount' : `${d}% off`;
};
/** A USD price after the default discount for a country: 49, 'PL' -> '$31.85'. */
export const defaultPrice = (usd: number, country: string) => {
  const cents = Math.round(usd * (100 - defaultDiscount(country)));
  return cents % 100 === 0 ? `$${cents / 100}` : `$${(cents / 100).toFixed(2)}`;
};

const faqItems = [
  {
    question: 'What is Purchasing Power Parity (PPP)?',
    answer: `PPP adjusts prices based on a customer's local purchasing power. With ${DEFAULT_SETTINGS}, a $99 product comes to ${defaultPrice(99, 'IN')} in India and ${defaultPrice(99, 'PL')} in Poland. GoPayLocal includes PPP data for ${PPP_COUNTRY_COUNT} countries, compiled from public sources including the World Bank and the Big Mac Index, and you set the maximum discount. This unlocks revenue from markets that would otherwise bounce.`,
  },
  {
    question: 'Will PPP discounts hurt my revenue?',
    answer: "The customers PPP converts generally weren't going to pay full price — they bounce when they see US pricing. A fair local price turns some of those bounced visitors into paying customers, so the discounted revenue is incremental rather than cannibalized. To see the effect on your own product, A/B test two discount levels and check the results against your own sales data.",
  },
  {
    question: 'How do you prevent VPN abuse?',
    answer: "We check each visitor's network (ASN) and IP address against lists built from open-source datasets. Visitors on known VPN, Tor or datacenter networks get no banner and no code, so they see your normal price. The lists catch known networks, not every proxy.",
  },
  {
    question: 'Which payment platforms do you support?',
    answer: 'Stripe, Paddle, Gumroad, Chargebee, Dodo Payments, Polar, Whop, Creem and WooCommerce. GoPayLocal creates the discount codes in the platform you connect, so there is nothing to set up there by hand. Checkouts on other platforms are not supported.',
  },
  {
    question: 'How long does setup take?',
    answer: 'A few minutes. Connect your payment platform, create a campaign in the dashboard and add a single <script> tag (under 4KB gzipped), and you\'re live. No build step, no dependencies.',
  },
  {
    question: 'Can I run a Black Friday sale?',
    answer: "Yes. A holiday deal is a sale with a first and a last day, one percentage and one code, which GoPayLocal creates in your payment platform. While it runs, each visitor is offered the larger of the deal and their country's discount, and visitors from countries without a discount see the deal. After the last day the code is removed from your payment platform. Holiday deals are on every plan.",
  },
  // Pricing FAQs. Numbers come from the shared plan constants (see PRICING below).
  {
    question: 'What counts as an API call?',
    answer: `One request from the banner or an SDK for a visitor's offer, counted on our servers. A request counts once it reaches campaign selection, whether or not a banner is shown. Script loads, analytics events, visitors flagged as VPN and test-mode campaigns don't count. Free includes ${formatLimit(PLAN_LIMITS.free.apiHitsPerMonth)} a month, counted per calendar month (UTC). Past that, the banner stops showing until the next month or until you upgrade. Pro includes ${PRO_FAIR_USE_API_HITS_PER_MONTH / 1_000_000} million a month.`,
  },
  {
    question: 'How many API calls does Pro include?',
    answer: `${PRO_FAIR_USE_API_HITS_PER_MONTH / 1_000_000} million a month, with unlimited products and team members. Nothing is throttled or switched off at that number: if you pass it we get in touch, and your banner keeps working. If you expect more than that, contact us first. Pro is $${PLAN_PRICES_USD.pro.month} a month.`,
  },
  {
    question: 'Can I self-host GoPayLocal?',
    answer: 'Yes. The server is open source (AGPL) and runs on your own Cloudflare account with your own Postgres database. A self-hosted install has every feature, no plan limits, no GoPayLocal branding and no billing; you pay only your own Cloudflare and database costs. Setup steps are in the self-hosting guide at docs.gopaylocal.com/self-hosting.',
  },
];

// ─── PRICING ────────────────────────────────────────────
// Free + one flat paid plan (Pro) + self-hosted. Limits and prices come from
// the same constants the API enforces (PLAN_LIMITS / PLAN_PRICES_USD in
// packages/shared), so the page can't drift from what the product does.

export const SELF_HOSTING_REPO_URL = 'https://github.com/RayLabsHQ/gopaylocal';
export const SELF_HOSTING_DOCS_URL = 'https://docs.gopaylocal.com/self-hosting/';
const APP_URL = 'https://app.gopaylocal.com';

const FREE = PLAN_LIMITS.free;
const PRO = PLAN_LIMITS.pro;
const PRO_MONTHLY = PLAN_PRICES_USD.pro.month;

/** 10000 -> "10K", 20000000 -> "20M". Only used for round plan numbers. */
function compactCount(n: number | null): string {
  if (n === null) return 'Unlimited';
  if (n >= 1_000_000) return `${n / 1_000_000}M`;
  if (n >= 1_000) return `${n / 1_000}K`;
  return String(n);
}

const plural = (n: number | null, word: string) => `${compactCount(n)} ${word}${n === 1 ? '' : 's'}`;

export interface PricingCard {
  name: string;
  price: string;
  subtitle: string;
  cta: string;
  href: string;
  highlighted: boolean;
  features: string[];
  secondaryLink?: { label: string; href: string };
}

const pricingCards: PricingCard[] = [
  {
    name: 'Free',
    price: '$0',
    subtitle: `${plural(FREE.products, 'product')} · ${compactCount(FREE.apiHitsPerMonth)} API calls/mo\n${plural(FREE.teamMembers, 'team member')} · ${FREE.analyticsRetentionDays}-day analytics\n"Powered by GoPayLocal" shown`,
    cta: 'Start Free',
    href: APP_URL,
    highlighted: false,
    features: ['Every feature included', `All ${INTEGRATION_COUNT} payment integrations`, 'VPN & proxy detection', 'Community support'],
  },
  {
    name: 'Pro',
    price: `$${PRO_MONTHLY}/mo`,
    subtitle: 'One flat price\nBilled monthly',
    cta: 'Start Pro',
    href: APP_URL,
    highlighted: true,
    features: [
      'Unlimited products',
      `${compactCount(PRO_FAIR_USE_API_HITS_PER_MONTH)} API calls/mo (contact us for more)`,
      'Unlimited team members',
      `${PRO.analyticsRetentionDays}-day analytics`,
      'No GoPayLocal branding',
      'Email support',
    ],
  },
  {
    name: 'Self-hosted',
    price: '$0',
    subtitle: 'Open source, on your own Cloudflare account\nNo plan limits, no branding\nYou pay your own Cloudflare + Postgres costs',
    cta: 'View on GitHub',
    href: SELF_HOSTING_REPO_URL,
    highlighted: false,
    features: ['Every feature, nothing capped', 'AGPL server, MIT SDKs', 'Data stays in your own database', 'Community support'],
    secondaryLink: { label: 'Read the self-hosting guide', href: SELF_HOSTING_DOCS_URL },
  },
];

// ─── FULL VARIANT ───────────────────────────────────────

const fullData: LandingData = {
  hero: {
    tag: 'Purchasing Power Parity for SaaS',
    headline: 'Fair prices.\nMore customers.\nZero effort.',
    subline: `Automatically detect visitor location and apply country-appropriate discounts. Under 4KB script. PPP data for ${PPP_COUNTRY_COUNT} countries. Open source.`,
    primaryCta: { label: 'Start Free', href: 'https://app.gopaylocal.com', icon: 'arrow-right' },
    secondaryCta: { label: 'Read the Docs', href: 'https://docs.gopaylocal.com/getting-started/quickstart' },
    stats: [
      { value: String(PPP_COUNTRY_COUNT), label: 'Countries with PPP data' },
      { value: '<4KB', label: 'Script size (gzip)' },
      { value: `$${PRO_MONTHLY}`, label: 'Flat price on Pro' },
      { value: String(INTEGRATION_COUNT), label: 'Integrations', accent: true },
    ],
  },
  howItWorks: {
    title: 'How It Works',
    subtitle: 'Three steps to global fair pricing.',
    steps: [
      { number: '01', title: 'Add the Script', description: 'A single <script> tag. Under 4KB gzipped. Shadow DOM rendering. Zero deps.' },
      { number: '02', title: 'Set Your Rules', description: 'Choose a pricing mode, a maximum discount and charm pricing in the dashboard.' },
      { number: '03', title: 'Convert Globally', description: `Visitors see a price for their country. You see impressions, copies and redemptions for each of ${PPP_COUNTRY_COUNT} countries.` },
    ],
  },
  features: {
    title: 'Built for developers.\nLoved by finance teams.',
    items: [
      { icon: 'globe', title: `${PPP_COUNTRY_COUNT} Countries`, description: 'Built-in PPP data for each one, with location detection at the Cloudflare edge. No third-party API calls.' },
      { icon: 'shield', title: 'VPN Detection', description: 'Block discount abuse with ASN + IP-based proxy detection. Open-source datasets.' },
      { icon: 'trending-up', title: 'A/B Testing', description: "Split a product's visitors between two discount campaigns. Compare impressions, copies and redemptions side by side." },
      { icon: 'banknote', title: 'Multi-Currency', description: "Show the discounted price in the visitor's currency, for example ₹3,999 instead of '30% off $59.99' with Round to X9 charm pricing. Local prices are estimates at the day's exchange rate." },
      { icon: 'sparkles', title: 'Charm Pricing', description: 'Psychology-driven rounding per currency. .99, X9, nearest-5, or region-aware.' },
      { icon: 'zap', title: 'Codes Created for You', description: "Each country's code is created in your payment platform. Visitors copy it from the banner, or your checkout applies it from the SDK." },
    ],
  },
  socialProof: {
    title: 'Built to be\nverifiable.',
    subtitle: 'No black boxes, no borrowed logos — just proof you can check yourself.',
    proofPoints: [
      { label: 'Open source', description: 'The server is AGPL-3.0 and the banner and SDKs are MIT. Read the code on GitHub, or run it on your own Cloudflare account.' },
      { label: 'A complete PPP toolkit', description: `VPN blocking, multi-currency, A/B testing, charm pricing and all ${INTEGRATION_COUNT} integrations in one tool.` },
      { label: `PPP data for ${PPP_COUNTRY_COUNT} countries`, description: 'Discounts come from built-in purchasing-power multipliers and tiers, capped at the maximum discount you set. The numbers are in the source code, not a black box.' },
    ],
  },
  finalCta: {
    title: 'Start converting global visitors\ninto paying customers.',
    subtitle: 'Free to try. No credit card required. Set up in minutes.',
  },
};

// ─── DEV VARIANT ────────────────────────────────────────

const devData: LandingData = {
  hero: {
    tag: 'Add one <script> tag — that\'s it',
    headline: 'One script tag.\nGlobal PPP pricing.\nShip it tonight.',
    subline: `Under 4KB gzipped. Shadow DOM rendering. Zero dependencies.\nEdge detection via Cloudflare. Works with Stripe, Paddle, and ${INTEGRATION_COUNT - 2} more.`,
    primaryCta: { label: 'Start Free', href: 'https://app.gopaylocal.com', icon: 'arrow-right' },
    secondaryCta: { label: 'Read the Docs', href: 'https://docs.gopaylocal.com/getting-started/quickstart' },
    codeSnippet: true,
    stats: [
      { value: String(PPP_COUNTRY_COUNT), label: 'Countries with PPP data' },
      { value: '<4KB', label: 'Script size (gzip)' },
      { value: 'AGPL', label: 'Open-source server' },
      { value: String(INTEGRATION_COUNT), label: 'Integrations', accent: true },
    ],
  },
  howItWorks: {
    title: 'Integration in 3 steps',
    subtitle: 'No build step. No config files. No breaking changes.',
    steps: [
      { number: '01', title: 'Add the script tag', description: 'Single <script> tag. Under 4KB gzipped. Shadow DOM isolation, so no CSS conflicts and no build step.' },
      { number: '02', title: 'Configure in the dashboard', description: 'Connect your payment platform, pick a pricing mode and a maximum discount, and create a campaign for each product.' },
      { number: '03', title: 'Deploy and forget', description: 'The visitor\'s country comes from Cloudflare at the edge. No server-side code changes.' },
    ],
  },
  features: {
    title: 'Developer-first.\nA management API.',
    items: [
      { icon: 'cloud', title: 'Edge Runtime', description: 'Runs on Cloudflare Workers. The visitor\'s country comes from Cloudflare itself, with no third-party geolocation lookup.' },
      { icon: 'terminal', title: 'Open Source', description: 'The API, dashboard and banner are open source. Read how every discount is computed, or self-host the whole service.' },
      { icon: 'webhook', title: 'Redemption Tracking', description: "Redemptions arrive through your payment platform's webhooks and show up in your analytics per country." },
      { icon: 'code', title: 'Shadow DOM', description: 'Isolated rendering. No CSS conflicts with your stack. Works with React, Vue, Svelte, anything.' },
      { icon: 'package', title: 'JS + React SDKs', description: 'Typed clients for JS and React. Full IntelliSense. Drop-in components and hooks.' },
      { icon: 'git-branch', title: 'Open Source Datasets', description: 'VPN detection uses open-source ASN + IP lists. Audit and contribute on GitHub.' },
    ],
  },
  socialProof: {
    title: 'Built for people\nwho read the source.',
    subtitle: 'Inspectable detection, a tiny footprint, and a secret-key API for products, campaigns, A/B tests and analytics.',
    proofPoints: [
      { label: 'Auditable, not a black box', description: 'VPN/proxy detection runs on open ASN lists you can inspect — no opaque risk scoring, no vendor lock-in.' },
      { label: 'Under 4KB, zero dependencies', description: 'One script tag with Shadow DOM isolation. No build step, no framework conflicts, no CSS bleed into your app.' },
      { label: 'Typed SDKs, open source', description: "Typed JavaScript and React SDKs give you the visitor's country, discount and code for your own pricing page and checkout. The SDKs are MIT, the service is AGPL." },
    ],
  },
  finalCta: {
    title: 'Start building with\nGoPayLocal today.',
    subtitle: 'Free to try. No credit card. Every feature included. One script tag to get started.',
  },
};

// ─── REVENUE VARIANT ────────────────────────────────────

const revenueData: LandingData = {
  hero: {
    tag: `Unlock revenue from ${PPP_COUNTRY_COUNT} countries`,
    headline: 'Capture the\nrevenue US pricing\nleaves behind.',
    subline: 'Visitors from emerging markets bounce when they see US pricing. Show fair local prices based on purchasing power and turn those bounced visitors into paying customers.',
    primaryCta: { label: 'Start Free', href: 'https://app.gopaylocal.com', icon: 'arrow-right' },
    secondaryCta: { label: 'See How It Works', href: '/use-cases/saas' },
    stats: [
      { value: String(PPP_COUNTRY_COUNT), label: 'Countries with PPP data' },
      { value: String(INTEGRATION_COUNT), label: 'Payment integrations' },
      { value: `$${PRO_MONTHLY}`, label: 'Flat price on Pro' },
      { value: 'All', label: 'Features on Free', accent: true },
    ],
  },
  howItWorks: {
    title: 'How companies grow globally',
    subtitle: 'Three steps from missing revenue to capturing it.',
    steps: [
      { number: '01', title: 'Identify lost revenue', description: 'See where your visitors come from, and which countries see the banner, copy the code and redeem it.' },
      { number: '02', title: 'Set fair local prices', description: 'Configure country-specific discounts based on purchasing power. Currency conversion and charm pricing included.' },
      { number: '03', title: 'Grow global revenue', description: 'Track redemptions in markets that were previously unprofitable, and A/B test two discount levels to see which works better.' },
    ],
  },
  features: {
    title: 'Everything you need\nto grow global revenue.',
    items: [
      { icon: 'map-pin', title: `${PPP_COUNTRY_COUNT}-Country Coverage`, description: 'Built-in purchasing-power data for each of them, with automatic geo-detection at the Cloudflare edge.' },
      { icon: 'shield-check', title: 'Fraud Protection', description: 'VPN and proxy detection blocks discount abuse. Protect margins while offering fair pricing.' },
      { icon: 'bar-chart-2', title: 'Revenue Analytics', description: 'Impressions, copies, redemptions and discount given per country. A/B test two discount campaigns and compare them side by side.' },
      { icon: 'coins', title: 'Local Currency Display', description: "For example, show '₹3,999 (was ₹5,589)' instead of '$59.99 (30% off)', with Round to X9 charm pricing. Local prices are estimates at the day's exchange rate." },
      { icon: 'brain', title: 'Smart Charm Pricing', description: 'Psychologically optimized price points per currency. .99, X9, nearest-5 — all automated.' },
      { icon: 'link', title: 'Codes in Your Checkout', description: 'GoPayLocal creates each code in your payment platform. Visitors copy it from the banner, or your checkout applies it for them.' },
    ],
  },
  socialProof: {
    title: 'A model you can\ntest, not trust.',
    subtitle: 'A/B test two discount levels and judge the results for yourself.',
    proofPoints: [
      { label: 'Incremental, not cannibalized', description: 'PPP converts visitors from markets that bounce at full price. Compare two discount levels with an A/B test, and check the net effect against your own sales data.' },
      { label: 'Abuse-resistant by default', description: 'Edge geolocation plus VPN/proxy detection means local prices reach real local buyers — not VPN users gaming the discount.' },
      { label: 'A complete PPP toolkit', description: `VPN blocking, multi-currency, A/B testing, charm pricing and ${INTEGRATION_COUNT} integrations in one tool. Try every feature free; Pro is one flat $${PLAN_PRICES_USD.pro.month}/mo.` },
    ],
  },
  finalCta: {
    title: 'How much revenue are you\nleaving on the table?',
    subtitle: 'Most of the world cannot afford flat US pricing. Start capturing those markets today — free to try, no credit card required.',
  },
};

export function getLandingData(variant: LandingVariant): LandingData {
  switch (variant) {
    case 'dev': return devData;
    case 'revenue': return revenueData;
    default: return fullData;
  }
}

export { integrations, faqItems, pricingCards };
