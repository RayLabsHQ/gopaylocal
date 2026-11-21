import {
  PLAN_LIMITS,
  PLAN_PRICES_USD,
  PRO_FAIR_USE_API_HITS_PER_MONTH,
  formatLimit,
} from '@gopaylocal/shared/constants';
import { PPP_COUNTRY_COUNT, SELF_HOSTING_DOCS_URL, integrations } from './landing-data';

/**
 * Content of the comparison pages (/vs/*, /alternatives/*, /compare).
 *
 * Rules for this file:
 *  - Everything said about GoPayLocal is computed from the shared plan
 *    constants or matches the landing page, so it cannot drift from the code.
 *  - Everything said about another product comes from that product's own
 *    website (`sourceUrl`), read on COMPARISON_CHECKED_ON. Where its site says
 *    nothing, the cell says so; it never says the product lacks something.
 *  - When you re-read the sources, update the facts and the date together.
 */
export const COMPARISON_CHECKED_ON = '21 November 2026';

const FREE = PLAN_LIMITS.free;
const FREE_CALLS = formatLimit(FREE.apiHitsPerMonth);
const PRO_MONTH = PLAN_PRICES_USD.pro.month;
const PRO_YEAR = PLAN_PRICES_USD.pro.year;
const PRO_CALLS_MILLIONS = PRO_FAIR_USE_API_HITS_PER_MONTH / 1_000_000;

/** "Stripe, Paddle, ... and WooCommerce", with Dodo under its full name. */
const platformNames = integrations.map((name) => (name === 'Dodo' ? 'Dodo Payments' : name));
const GOPAYLOCAL_PLATFORMS = `${platformNames.slice(0, -1).join(', ')} and ${platformNames[platformNames.length - 1]}`;

export type CompetitorSlug = 'paritydeals' | 'parityvend' | 'parity-kit';

export type RowKey =
  | 'price'
  | 'calls'
  | 'at19'
  | 'overLimit'
  | 'products'
  | 'free'
  | 'openSource'
  | 'selfHost'
  | 'platforms'
  | 'vpn'
  | 'abTesting'
  | 'currency';

/** The rows of a head-to-head table, with GoPayLocal's side. */
export const comparisonRows: { key: RowKey; label: string; gopaylocal: string }[] = [
  { key: 'price', label: 'Price', gopaylocal: `Free, or Pro at $${PRO_MONTH} a month ($${PRO_YEAR} a year)` },
  {
    key: 'calls',
    label: 'API calls a month',
    gopaylocal: `${FREE_CALLS} on Free. ${PRO_CALLS_MILLIONS} million on Pro; contact us for more`,
  },
  {
    key: 'at19',
    label: `What $${PRO_MONTH} a month buys`,
    gopaylocal: `${PRO_CALLS_MILLIONS} million API calls, unlimited products and team members`,
  },
  {
    key: 'overLimit',
    label: 'Past the allowance',
    gopaylocal:
      'Free: the banner stops showing until the next month or an upgrade. Pro: nothing is cut off; we get in touch.',
  },
  { key: 'products', label: 'Products', gopaylocal: `${FREE.products} on Free, unlimited on Pro` },
  {
    key: 'free',
    label: 'Free option',
    gopaylocal: `A free plan: ${FREE.products} product, ${FREE_CALLS} calls a month, "Powered by GoPayLocal" on the banner`,
  },
  {
    key: 'openSource',
    label: 'Open source',
    gopaylocal: 'Yes. The service is AGPL-3.0; the SDKs and the banner are MIT.',
  },
  {
    key: 'selfHost',
    label: 'Self-hosting',
    gopaylocal: 'Yes, on your own Cloudflare account and Postgres database, with no plan limits',
  },
  { key: 'platforms', label: 'Payment platforms', gopaylocal: GOPAYLOCAL_PLATFORMS },
  {
    key: 'vpn',
    label: 'VPN and proxy blocking',
    gopaylocal: 'Yes. Visitors on known VPN, Tor or datacenter networks get no banner and no code.',
  },
  { key: 'abTesting', label: 'A/B testing', gopaylocal: 'Yes: two discount campaigns compared side by side' },
  {
    key: 'currency',
    label: 'Prices in local currency',
    gopaylocal: 'Yes, with charm pricing (.99, X9, nearest 5)',
  },
];

/** Monthly call volumes for the "what you pay" table, with GoPayLocal's plan at each. */
export const volumeRows: { calls: number; label: string; gopaylocal: string }[] = [
  { calls: 10_000, label: '10,000', gopaylocal: 'Free' },
  { calls: 50_000, label: '50,000', gopaylocal: `Pro, $${PRO_MONTH}` },
  { calls: 100_000, label: '100,000', gopaylocal: `Pro, $${PRO_MONTH}` },
  { calls: 1_000_000, label: '1 million', gopaylocal: `Pro, $${PRO_MONTH}` },
  { calls: 10_000_000, label: '10 million', gopaylocal: `Pro, $${PRO_MONTH}` },
];

export interface Competitor {
  slug: CompetitorSlug;
  name: string;
  /** The page the facts below were read from. */
  sourceUrl: string;
  sourceLabel: string;
  /** One neutral sentence on what the product is. */
  summary: string;
  /** Its plans, as its site lists them. */
  plans: { name: string; price: string; includes: string }[];
  /** Its side of comparisonRows. */
  cells: Record<RowKey, string>;
  /** Its plan at each volume of volumeRows, same order. */
  volume: string[];
  /** The three differences that matter most, for the top of the versus page. */
  differences: { title: string; body: string }[];
  /** Honest reasons to pick it over GoPayLocal. */
  betterWhen: { title: string; body: string }[];
  /** Facts that make people look for an alternative to it. */
  whyLook: string[];
  /** For the alternatives lists. */
  listing: { price: string; calls: string; goodFit: string };
}

const NOT_OPEN = 'No';
const NOT_SELF_HOSTED = 'Not offered';

export const competitors: Record<CompetitorSlug, Competitor> = {
  paritydeals: {
    slug: 'paritydeals',
    name: 'ParityDeals',
    sourceUrl: 'https://www.paritydeals.com/pricing',
    sourceLabel: 'paritydeals.com/pricing',
    summary:
      'ParityDeals is a hosted service for location-based pricing. It offers PPP, holiday and time-based discounts and works with Stripe, Paddle and other payment platforms.',
    plans: [
      { name: 'Starter', price: '$19 a month ($15 billed yearly)', includes: 'Up to 10,000 API hits a month, 1 product' },
      { name: 'Builder', price: '$49 a month ($40 billed yearly)', includes: 'Up to 50,000 API hits a month, 5 products' },
      { name: 'Scale', price: '$99 a month ($83 billed yearly)', includes: 'Up to 100,000 API hits a month, unlimited products' },
      { name: 'Custom', price: 'On request', includes: 'More than 100,000 API hits a month' },
    ],
    cells: {
      price: '$19, $49 or $99 a month by volume; custom pricing above that',
      calls: '10,000, 50,000 or 100,000 API hits by plan',
      at19: '10,000 API hits and 1 product',
      overLimit:
        'Above 100,000 API hits a month the price is on request. The pricing page does not say what happens at a smaller plan\'s limit.',
      products: '1, 5 or unlimited by plan',
      free: 'A 14-day free trial. The Scale plan is free when you sell through Kelviq, a merchant of record.',
      openSource: NOT_OPEN,
      selfHost: NOT_SELF_HOSTED,
      platforms: 'Kelviq, Stripe, Lemon Squeezy, Gumroad, Chargebee, Whop, Paddle, Polar and Dodo Payments',
      vpn: 'Yes. A Tor, proxy and VPN blocker is on every plan.',
      abTesting: 'Not listed on its pricing page',
      currency: 'Yes. Its site says prices can be shown in 135+ currencies.',
    },
    volume: ['Starter, $19', 'Builder, $49', 'Scale, $99', 'On request', 'On request'],
    differences: [
      {
        title: 'What $19 buys',
        body: `ParityDeals' $19 plan includes 10,000 API hits and one product. That is what GoPayLocal's free plan includes. GoPayLocal's $${PRO_MONTH} plan includes ${PRO_CALLS_MILLIONS} million calls and unlimited products.`,
      },
      {
        title: 'One price, not three',
        body: `ParityDeals has three plans sized by API hits, and prices on request above 100,000 a month. GoPayLocal has one paid plan: the price is the same at 50,000 calls a month and at ${PRO_CALLS_MILLIONS} million.`,
      },
      {
        title: 'Open source',
        body: 'GoPayLocal\'s code is public: you can read how every discount is computed, or run the whole service on your own infrastructure. ParityDeals is hosted only.',
      },
    ],
    betterWhen: [
      {
        title: 'You want it bundled with a merchant of record',
        body: 'ParityDeals\' Scale plan is free when you sell through Kelviq, a merchant of record. GoPayLocal is not a payment provider; it works with the one you already use.',
      },
      {
        title: 'You run holiday or time-based sales',
        body: 'ParityDeals lists holiday discounts and time-based discounts as features. GoPayLocal\'s discounts are by country only.',
      },
      {
        title: 'You sell through Lemon Squeezy, or on a course or newsletter platform',
        body: 'ParityDeals lists a Lemon Squeezy integration and tutorials for Kajabi, Podia, Circle, Beehiiv, Framer and Substack. GoPayLocal has no Lemon Squeezy integration and no guides for those platforms.',
      },
      {
        title: 'You want the established product',
        body: 'ParityDeals has been around for years and publishes many customer testimonials. GoPayLocal is new.',
      },
    ],
    whyLook: [
      'Plans are sized by API hits: 10,000 for $19, 50,000 for $49 and 100,000 for $99 a month, with prices on request above that.',
      'The $19 plan covers one product and the $49 plan covers five.',
      'It is hosted only, and its source code is not published.',
    ],
    listing: {
      price: 'From $19 a month',
      calls: '10,000 to 100,000 by plan',
      goodFit: 'You want it bundled with a merchant of record, or you want holiday and time-based discounts.',
    },
  },

  parityvend: {
    slug: 'parityvend',
    name: 'ParityVend',
    sourceUrl: 'https://www.ambeteco.com/ParityVend/pricing/',
    sourceLabel: 'ParityVend\'s pricing page',
    summary:
      'ParityVend is a hosted service for location-based pricing with two ways to use it: a no-code banner and an API.',
    plans: [
      { name: 'Free', price: '$0', includes: '7,500 requests a month' },
      { name: 'Basic', price: '$19 a month', includes: '25,000 requests a month' },
      { name: 'Super', price: '$49 a month', includes: '150,000 requests a month' },
      { name: 'Ultra', price: '$99 a month', includes: '1.5 million requests a month' },
    ],
    cells: {
      price: 'Free, then $19, $49 or $99 a month by volume (20% less when paid yearly)',
      calls: '7,500 on Free; 25,000, 150,000 or 1.5 million by plan. Each API call or banner display counts.',
      at19: '25,000 requests',
      overLimit: 'ParityVend stops working until the next month or an upgrade. There are no overage charges.',
      products: 'No product limit listed',
      free: 'A free plan with 7,500 requests a month',
      openSource: 'No. Its Python API client is open source.',
      selfHost: NOT_SELF_HOSTED,
      platforms: 'None listed on its home or pricing page',
      vpn: 'Yes. Protection against VPN, Tor, bots, proxies and scrapers.',
      abTesting: 'Not listed on its home or pricing page',
      currency: 'Its API includes exchange rates for 170 currencies.',
    },
    volume: ['Basic, $19', 'Super, $49', 'Super, $49', 'Ultra, $99', 'More than its largest listed plan'],
    differences: [
      {
        title: 'What $19 buys',
        body: `ParityVend's $19 plan includes 25,000 requests a month, and its largest listed plan is 1.5 million for $99. GoPayLocal's $${PRO_MONTH} plan includes ${PRO_CALLS_MILLIONS} million calls.`,
      },
      {
        title: 'At the limit',
        body: `When a ParityVend quota is used up, it stops working until the next month or an upgrade. GoPayLocal's free plan does the same at ${FREE_CALLS} calls. Its paid plan is not cut off.`,
      },
      {
        title: 'Open source',
        body: 'GoPayLocal\'s code is public: you can read how every discount is computed, or run the whole service on your own infrastructure. ParityVend is hosted only.',
      },
    ],
    betterWhen: [
      {
        title: 'You work in Python',
        body: 'ParityVend publishes an official Python client. GoPayLocal\'s SDKs are for JavaScript and React; from other languages you call the HTTP API.',
      },
      {
        title: 'You want many ready-made banner designs',
        body: 'ParityVend lists 99 banner presets. GoPayLocal has one banner whose colors, text and position you set.',
      },
      {
        title: 'You want support on the free plan',
        body: 'ParityVend advertises free 24/7 technical support for every client. GoPayLocal\'s free plan has community support; email support comes with Pro.',
      },
    ],
    whyLook: [
      'Every plan has a request quota: 7,500 on the free plan, then 25,000, 150,000 and 1.5 million. Each API call or banner display counts.',
      'When the quota is used up, ParityVend stops working until the next month or an upgrade.',
      'It is hosted only. Its Python client is open source; the service is not.',
    ],
    listing: {
      price: 'Free, then from $19 a month',
      calls: '7,500 to 1.5 million by plan',
      goodFit: 'You want a no-code banner with many presets, or an official Python client.',
    },
  },

  'parity-kit': {
    slug: 'parity-kit',
    name: 'Parity Kit',
    sourceUrl: 'https://paritykit.com/',
    sourceLabel: 'paritykit.com',
    summary:
      'Parity Kit is a hosted tool that creates country-based discount codes in Paddle, Lemon Squeezy, Polar or Stripe and shows them in a banner.',
    plans: [
      { name: 'Growth', price: '$19.50 a month', includes: '5 websites, unlimited API requests' },
      { name: 'Scale', price: '$44.50 a month', includes: 'Unlimited websites, unlimited API requests' },
    ],
    cells: {
      price: '$19.50 or $44.50 a month, charged after your first sale',
      calls: 'Unlimited API requests on both plans',
      at19: 'At $19.50: unlimited API requests and 5 websites',
      overLimit: 'No request limit listed',
      products: '5 websites or unlimited websites by plan',
      free: 'No charge until you make your first sale',
      openSource: NOT_OPEN,
      selfHost: NOT_SELF_HOSTED,
      platforms: 'Paddle, Lemon Squeezy, Polar and Stripe',
      vpn: 'Yes. A Tor, proxy and VPN blocker is on both plans.',
      abTesting: 'Listed as coming soon',
      currency: 'Not listed on its site',
    },
    volume: ['$19.50 or $44.50', '$19.50 or $44.50', '$19.50 or $44.50', '$19.50 or $44.50', '$19.50 or $44.50'],
    differences: [
      {
        title: 'Payment platforms',
        body: `Parity Kit lists four payment platforms: Paddle, Lemon Squeezy, Polar and Stripe. GoPayLocal supports ${platformNames.length}: ${GOPAYLOCAL_PLATFORMS}.`,
      },
      {
        title: 'Both are flat-priced',
        body: `Parity Kit is $19.50 a month for five websites and $44.50 for unlimited websites. GoPayLocal is $${PRO_MONTH} a month for unlimited products, with a free plan for one product.`,
      },
      {
        title: 'Open source, and A/B tests today',
        body: 'GoPayLocal\'s code is public and can be self-hosted, and it can A/B test two discount campaigns now. Parity Kit is hosted only and lists A/B testing as coming soon.',
      },
    ],
    betterWhen: [
      {
        title: 'You want to pay nothing until it works',
        body: `Parity Kit charges only after your first sale. GoPayLocal's free plan has no time limit but covers one product and ${FREE_CALLS} calls a month.`,
      },
      {
        title: 'You sell through Lemon Squeezy',
        body: 'Parity Kit supports it. GoPayLocal does not.',
      },
      {
        title: 'You stack a campaign discount on top',
        body: 'Parity Kit can add a launch or holiday discount on top of the country discount. GoPayLocal\'s discounts are by country only.',
      },
      {
        title: 'You want no stated request limit',
        body: `Parity Kit lists unlimited API requests. GoPayLocal's Pro plan states ${PRO_CALLS_MILLIONS} million calls a month and asks you to get in touch above that.`,
      },
    ],
    whyLook: [
      'It lists four payment platforms: Paddle, Lemon Squeezy, Polar and Stripe.',
      'The $19.50 plan covers five websites; unlimited websites cost $44.50 a month.',
      'A/B testing is listed as coming soon.',
      'It is hosted only, and its source code is not published.',
    ],
    listing: {
      price: '$19.50 or $44.50 a month',
      calls: 'Unlimited',
      goodFit: 'You sell through Paddle, Lemon Squeezy, Polar or Stripe and want to pay only after a first sale.',
    },
  },
};

export const competitorList: Competitor[] = Object.values(competitors);

/** GoPayLocal's own entry in an alternatives list. */
export const gopaylocalListing = {
  name: 'GoPayLocal',
  summary: `Open-source PPP discounts: a banner that shows each visitor a discount for their country, with the codes created in your payment platform. Built-in data for ${PPP_COUNTRY_COUNT} countries, VPN detection, A/B testing and local-currency prices on every plan.`,
  price: `Free, or $${PRO_MONTH} a month`,
  calls: `${FREE_CALLS} on Free, ${PRO_CALLS_MILLIONS} million on Pro`,
  openSource: 'Yes',
  goodFit: 'You want one price instead of volume tiers, or you want to read the code or run it yourself.',
  href: '/#pricing',
  linkLabel: 'See GoPayLocal\'s pricing',
};

/** The two options in every alternatives list that are not a PPP product. */
export const otherOptions = [
  {
    name: 'The PPP setting in your payment platform',
    summary:
      'Some payment platforms can do this themselves. Dodo Payments applies a percentage per country at checkout, with no banner and no codes. Gumroad has a purchasing-power-parity setting for its products.',
    price: 'Included with the platform',
    calls: 'Not metered',
    openSource: 'No',
    goodFit: 'All your sales go through that one platform and its built-in setting does what you need.',
    href: 'https://docs.dodopayments.com/features/purchasing-power-parity',
    linkLabel: 'Dodo Payments\' PPP documentation',
  },
  {
    name: 'Build it yourself',
    summary:
      'Purchasing-power data is public, and there are open-source calculators and a free API for it, such as the purchasing-power-parity project (MIT). You write the country detection, the discount codes, the banner and the abuse checks yourself.',
    price: 'Your time',
    calls: 'Yours to run',
    openSource: 'Yes',
    goodFit: 'You have one product, one checkout and the time to maintain it.',
    href: 'https://github.com/purchasing-power-parity/purchasing-power-parity',
    linkLabel: 'purchasing-power-parity on GitHub',
  },
];

export const SELF_HOSTING_URL = SELF_HOSTING_DOCS_URL;

/** The closing call to action of every comparison page. */
export const CTA_SUBTITLE = `Free for one product. Pro is one price for up to ${PRO_CALLS_MILLIONS} million calls a month. Or run it on your own infrastructure.`;

/** Steps to move from another tool, the same for each. */
export const switchingSteps = [
  { title: 'Connect your payment platform', body: 'GoPayLocal creates the discount codes there, so nothing is set up by hand.' },
  { title: 'Create a campaign', body: 'Pick the product and the maximum discount. The defaults cover every country with built-in data.' },
  { title: 'Swap the script tag', body: 'Replace the other tool\'s snippet with GoPayLocal\'s one script tag. Codes created by the other tool stay in your payment platform until you remove them.' },
];
