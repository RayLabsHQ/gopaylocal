import type { Plan, PlanLimits, Limit, BannerConfig } from '../types/index.js';

export * from './provider-key-access.js';

// ── Plan Limits ─────────────────────────────────────────────────────────────

// Enforced caps per plan. `null` = unlimited (see the `Limit` type). These are
// also the public numbers on the pricing page and the dashboard billing tab.
// "API calls" = live banner config requests per calendar month (UTC), metered
// server-side by the banner endpoint (apps/api/src/services/usage.service.ts);
// browser-reported impressions are analytics only and do not count.
export const PLAN_LIMITS: Record<Plan, PlanLimits> = {
  free: {
    products: 1,
    apiHitsPerMonth: 10_000,
    teamMembers: 1,
    analyticsRetentionDays: 7,
  },
  // One flat paid plan. Products and seats are unlimited. API calls are not
  // capped here either: Pro's published allowance is
  // PRO_FAIR_USE_API_HITS_PER_MONTH, which is not enforced; admin usage alerts
  // flag a Pro org past it.
  pro: {
    products: null,
    apiHitsPerMonth: null,
    teamMembers: null,
    analyticsRetentionDays: 365,
  },
};

// Self-hosted deployments (Worker env SELF_HOSTED="true"): every organization
// is unlimited regardless of subscription rows, and branding is off.
export const SELF_HOSTED_LIMITS: PlanLimits = {
  products: null,
  apiHitsPerMonth: null,
  teamMembers: null,
  analyticsRetentionDays: null,
};

// List prices in USD. Pro is $19 a month; there is no yearly plan. The charged
// amount is whatever the Dodo product behind DODO_PRICE_ID_PRO_MONTHLY is set to.
export const PLAN_PRICES_USD: Record<Plan, { month: number }> = {
  free: { month: 0 },
  pro: { month: 19 },
};

// Pro's published API-call allowance ("20M API calls a month; contact us for
// more"). Admin alerts flag a hosted Pro org that exceeds this many calls in a
// month. Alert only, never enforced: the banner keeps working above it.
export const PRO_FAIR_USE_API_HITS_PER_MONTH = 20_000_000;

// How long the hosted service stores analytics and API-call counts before
// deleting them (apps/api/src/services/retention.service.ts). This is storage,
// not what a plan can see: analyticsRetentionDays above is the visible window.
// The privacy policy states this number. Self-hosted deployments never delete.
export const ANALYTICS_STORAGE_MONTHS = 24;

// Thresholds that trigger admin alerts (percentage of limit)
export const LIMIT_ALERT_THRESHOLD = 0.8; // alert admin at 80% of cap

/**
 * Parse a stored/transported plan value. 'free' and 'pro' pass through; the
 * retired 'business' tier maps to 'pro' (it was a superset of Pro, so its
 * subscribers keep paid limits). Anything else returns null.
 */
export function normalizePlan(value: unknown): Plan | null {
  if (value === 'free' || value === 'pro') return value;
  if (value === 'business') return 'pro';
  return null;
}

/** True when the cap is unlimited (`null`). */
export function isUnlimited(limit: Limit): limit is null {
  return limit === null;
}

/** True when `current` has reached a finite cap. Never true for unlimited. */
export function hasReachedLimit(current: number, limit: Limit): boolean {
  return limit !== null && current >= limit;
}

/** Headroom under the cap (never negative), or `null` when unlimited. */
export function remainingUnder(limit: Limit, current: number): number | null {
  return limit === null ? null : Math.max(0, limit - current);
}

/**
 * Fraction of the cap consumed (1 = at the cap; can exceed 1), or `null` when
 * unlimited so callers can't divide by an unlimited cap. A cap of 0 or less
 * counts as fully consumed (1).
 */
export function limitUsageRatio(current: number, limit: Limit): number | null {
  if (limit === null) return null;
  if (limit <= 0) return 1;
  return current / limit;
}

/** Human label for a cap: "Unlimited" or the number with thousands separators. */
export function formatLimit(limit: Limit): string {
  return limit === null ? 'Unlimited' : limit.toLocaleString('en-US');
}

// ── Country Names ───────────────────────────────────────────────────────────

export const COUNTRY_NAMES: Record<string, string> = {
  // Americas
  US: 'United States', CA: 'Canada', MX: 'Mexico', BR: 'Brazil', AR: 'Argentina',
  CL: 'Chile', CO: 'Colombia', PE: 'Peru', VE: 'Venezuela', EC: 'Ecuador',
  UY: 'Uruguay', CR: 'Costa Rica', PA: 'Panama', DO: 'Dominican Republic',
  GT: 'Guatemala', HN: 'Honduras', SV: 'El Salvador', NI: 'Nicaragua',
  BO: 'Bolivia', PY: 'Paraguay', CU: 'Cuba', HT: 'Haiti', JM: 'Jamaica',
  TT: 'Trinidad and Tobago', BS: 'Bahamas', BB: 'Barbados', BZ: 'Belize',
  SR: 'Suriname', GY: 'Guyana', PR: 'Puerto Rico',
  // Europe
  GB: 'United Kingdom', DE: 'Germany', FR: 'France', IT: 'Italy', ES: 'Spain',
  PT: 'Portugal', NL: 'Netherlands', BE: 'Belgium', AT: 'Austria', CH: 'Switzerland',
  SE: 'Sweden', NO: 'Norway', DK: 'Denmark', FI: 'Finland', IE: 'Ireland',
  PL: 'Poland', CZ: 'Czech Republic', RO: 'Romania', HU: 'Hungary', SK: 'Slovakia',
  HR: 'Croatia', BG: 'Bulgaria', RS: 'Serbia', SI: 'Slovenia', LT: 'Lithuania',
  LV: 'Latvia', EE: 'Estonia', LU: 'Luxembourg', MT: 'Malta', CY: 'Cyprus',
  IS: 'Iceland', AL: 'Albania', BA: 'Bosnia and Herzegovina', ME: 'Montenegro',
  MK: 'North Macedonia', MD: 'Moldova', BY: 'Belarus', UA: 'Ukraine', GE: 'Georgia',
  AM: 'Armenia', AZ: 'Azerbaijan', GR: 'Greece', TR: 'Turkey',
  // Asia
  JP: 'Japan', CN: 'China', KR: 'South Korea', IN: 'India', ID: 'Indonesia',
  TH: 'Thailand', VN: 'Vietnam', PH: 'Philippines', MY: 'Malaysia', SG: 'Singapore',
  TW: 'Taiwan', HK: 'Hong Kong', MO: 'Macao', MM: 'Myanmar', KH: 'Cambodia',
  LA: 'Laos', BN: 'Brunei', TL: 'Timor-Leste', MN: 'Mongolia', KZ: 'Kazakhstan',
  UZ: 'Uzbekistan', TM: 'Turkmenistan', KG: 'Kyrgyzstan', TJ: 'Tajikistan',
  PK: 'Pakistan', BD: 'Bangladesh', LK: 'Sri Lanka', NP: 'Nepal', BT: 'Bhutan',
  MV: 'Maldives', AF: 'Afghanistan',
  // Middle East
  SA: 'Saudi Arabia', AE: 'United Arab Emirates', IL: 'Israel', QA: 'Qatar',
  KW: 'Kuwait', BH: 'Bahrain', OM: 'Oman', JO: 'Jordan', LB: 'Lebanon',
  IQ: 'Iraq', IR: 'Iran', YE: 'Yemen', SY: 'Syria', PS: 'Palestine',
  // Africa
  ZA: 'South Africa', NG: 'Nigeria', EG: 'Egypt', KE: 'Kenya', GH: 'Ghana',
  TZ: 'Tanzania', UG: 'Uganda', ET: 'Ethiopia', MA: 'Morocco', TN: 'Tunisia',
  DZ: 'Algeria', LY: 'Libya', SD: 'Sudan', SN: 'Senegal', CI: "Ivory Coast",
  CM: 'Cameroon', CD: 'DR Congo', AO: 'Angola', MZ: 'Mozambique', MG: 'Madagascar',
  ZW: 'Zimbabwe', ZM: 'Zambia', BW: 'Botswana', NA: 'Namibia', MU: 'Mauritius',
  RW: 'Rwanda', ML: 'Mali', BF: 'Burkina Faso', NE: 'Niger', TD: 'Chad',
  GN: 'Guinea', BJ: 'Benin', TG: 'Togo', SL: 'Sierra Leone', LR: 'Liberia',
  MW: 'Malawi', SO: 'Somalia', ER: 'Eritrea', DJ: 'Djibouti', GA: 'Gabon',
  CG: 'Republic of the Congo', GQ: 'Equatorial Guinea', SS: 'South Sudan',
  LS: 'Lesotho', SZ: 'Eswatini', GM: 'Gambia', CV: 'Cape Verde', ST: 'Sao Tome and Principe',
  KM: 'Comoros', SC: 'Seychelles',
  // Oceania
  AU: 'Australia', NZ: 'New Zealand', FJ: 'Fiji', PG: 'Papua New Guinea',
  WS: 'Samoa', TO: 'Tonga', VU: 'Vanuatu', SB: 'Solomon Islands',
  NC: 'New Caledonia', PF: 'French Polynesia', GU: 'Guam',
  // Russia & Central Asia
  RU: 'Russia',
};

// ── Currency Symbols ────────────────────────────────────────────────────────

export const CURRENCY_SYMBOLS: Record<string, string> = {
  USD: '$', EUR: '€', GBP: '£', JPY: '¥', INR: '₹',
  BRL: 'R$', MXN: 'MX$', KRW: '₩', CNY: '¥', ZAR: 'R',
  NGN: '₦', EGP: 'E£', PKR: 'Rs', BDT: '৳', IDR: 'Rp',
  THB: '฿', VND: '₫', PHP: '₱', MYR: 'RM', SGD: 'S$',
  TWD: 'NT$', HKD: 'HK$', NZD: 'NZ$', SEK: 'kr', NOK: 'kr',
  DKK: 'kr', CHF: 'CHF', PLN: 'zł', CZK: 'Kč', RON: 'lei',
  HUF: 'Ft', UAH: '₴', TRY: '₺', ARS: 'ARS$', CLP: 'CLP$',
  COP: 'COP$', PEN: 'S/.', AED: 'AED', SAR: 'SAR', ILS: '₪',
  QAR: 'QAR', KWD: 'KD', CAD: 'CA$', AUD: 'A$',
  RUB: '₽', UYU: '$U', KES: 'KSh', GHS: '₵', TZS: 'TSh',
  LKR: '₨', NPR: '₨', MMK: 'K', KHR: '៛', BHD: 'BD',
  OMR: 'OMR', JOD: 'JD', MAD: 'MAD', TND: 'DT', DZD: 'DA',
  ETB: 'Br', CRC: '₡', PAB: 'B/.', DOP: 'RD$', GTQ: 'Q',
  HNL: 'L', NIO: 'C$', BOB: 'Bs.', PYG: '₲', VES: 'Bs.S',
  CUP: '₱', JMD: 'J$', BGN: 'лв', RSD: 'din', BAM: 'KM',
  ALL: 'L', MKD: 'ден', MDL: 'L', GEL: '₾', AMD: '֏',
  AZN: '₼', BYN: 'Br', ISK: 'kr',
};

// ── API Key Prefixes ────────────────────────────────────────────────────────

export const API_KEY_PREFIX_PUBLIC = 'gpl_pk_';
export const API_KEY_PREFIX_SECRET = 'gpl_sk_';

// ── Default Banner Message ──────────────────────────────────────────────────

export const DEFAULT_BANNER_MESSAGE =
  'It looks like you\'re visiting from {{country}}! Use code {{code}} for {{discount}}% off.';

/**
 * The default message of a campaign whose payment platform charges each
 * country's price itself (discount delivery `provider_price`): no code to copy.
 */
export const DEFAULT_BANNER_MESSAGE_CHARGED =
  'Visiting from {{countryName}}? Your price is {{localPrice}}, {{discount}}% off. Nothing to enter at checkout.';

export const DEFAULT_CTA_TEXT = 'Copy Code';

// ── Known Datacenter / VPN Networks ─────────────────────────────────────────

/**
 * @deprecated Not used for detection any more; use {@link KNOWN_DATACENTER_ASNS}.
 * Substring-matching `request.cf.asOrganization` against these names caused false
 * positives: 'google' matched Google Fiber's residential network, 'amazon' can match
 * ISPs named after the Amazonas region, and 'akamai' / 'cloudflare' matched the address
 * space that carries iCloud Private Relay egress (which keeps the visitor's real country).
 * Kept only so existing imports keep compiling; safe to delete once nothing imports it.
 */
export const KNOWN_DATACENTER_ORGS = [
  'amazon', 'aws', 'google', 'microsoft', 'azure', 'digitalocean',
  'linode', 'akamai', 'vultr', 'ovh', 'hetzner', 'cloudflare',
  'oracle', 'ibm', 'alibaba', 'tencent',
] as const;

/**
 * Networks (by origin ASN, `request.cf.asn`) whose visitors are treated as VPN/datacenter
 * traffic and get no PPP discount. Matched by exact number, so a residential ISP can only
 * match by actually being one of these networks. Used by
 * apps/api/src/services/vpn-detect.service.ts, independent of the KV IP-range dataset,
 * so it still works on a deployment that has never been seeded and covers IPv6 too.
 *
 * Every number was checked against X4BNet/lists_vpn (MIT) `input/datacenter/ASN.txt` or
 * `input/vpn/ASN.txt` on 2026-11-18.
 *
 * Deliberately NOT listed, because ordinary consumers browse through them: AS13335
 * Cloudflare (WARP app, iCloud Private Relay egress), AS36183 / AS20940 / AS16625 Akamai
 * and AS54113 Fastly (iCloud Private Relay egress; Apple states Private Relay preserves
 * the user's region), AS15169 Google (consumer-facing Google services). Google Cloud is
 * covered by AS396982.
 */
export const KNOWN_DATACENTER_ASNS: Readonly<Record<number, string>> = {
  // Hyperscale / general-purpose clouds (replace the old name substrings).
  16509: 'Amazon AWS (AMAZON-02)',
  14618: 'Amazon AWS (AMAZON-AES)',
  8075: 'Microsoft (Azure)',
  396982: 'Google Cloud Platform',
  31898: 'Oracle Cloud',
  36351: 'IBM Cloud (SoftLayer)',
  45102: 'Alibaba Cloud',
  37963: 'Alibaba Cloud (Hangzhou)',
  132203: 'Tencent Cloud',
  // Hosting providers commonly used for self-hosted and commercial VPN servers.
  14061: 'DigitalOcean',
  63949: 'Linode / Akamai Connected Cloud',
  20473: 'Vultr (The Constant Company / Choopa)',
  16276: 'OVHcloud',
  24940: 'Hetzner Online',
  51167: 'Contabo',
  9009: 'M247 (hosts NordVPN and other VPNs)',
  60068: 'CDN77 / DataCamp (VPN hosting)',
  212238: 'CDNEXT / DataCamp (VPN hosting)',
  // Networks operated by VPN providers or Tor exit operators.
  209854: 'Surfshark',
  136787: 'NordVPN (Tefincom)',
  207137: 'Packethub (NordVPN)',
  216025: 'Mullvad VPN',
  197141: 'Mullvad VPN',
  208172: 'Proton VPN',
  60729: 'Zwiebelfreunde e.V. / "Tor Servers" (Tor exits)',
};

// ── Currency By Country ──────────────────────────────────────────────────

/**
 * Country -> the currency local prices are shown in. Generated from Unicode CLDR
 * for every region (see ../currency/country-currency.ts, which carries the
 * licence notice and the overrides).
 * @deprecated Import COUNTRY_CURRENCY from "@gopaylocal/shared/currency".
 */
export { COUNTRY_CURRENCY as CURRENCY_BY_COUNTRY } from '../currency/country-currency';

// ── Default Banner Config ───────────────────────────────────────────────

export const BANNER_DEFAULTS: BannerConfig = {
  position: 'bottom',
  messageTemplate: "Hey! It looks like you're visiting from {{country}}. We support Purchasing Power Parity! Use code **{{code}}** for **{{discount}}% off**.",
  ctaText: 'Copy Code',
  backgroundColor: '#1a1a2e',
  textColor: '#ffffff',
  ctaColor: '#e94560',
  ctaTextColor: '#ffffff',
  showFlag: true,
  showCloseBtn: true,
};
