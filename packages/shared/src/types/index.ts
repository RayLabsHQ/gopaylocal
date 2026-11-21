// ── Plan & Billing ──────────────────────────────────────────────────────────

// Exactly two plans. A legacy stored 'business' value is folded into 'pro' by
// the API's entitlement resolver (apps/api/src/lib/entitlements.ts).
export type Plan = 'free' | 'pro';

// Billing cadence for the paid plan (Pro: $19/month or $180/year).
export type BillingInterval = 'month' | 'year';

/**
 * A plan cap. `null` means UNLIMITED.
 *
 * Deliberately not `Infinity`: JSON.stringify(Infinity) is `null` anyway, so an
 * Infinity cap would silently turn into null in API responses and KV. Making
 * null the explicit representation keeps every hop (API, KV, dashboard) honest.
 * Use the helpers next to PLAN_LIMITS (isUnlimited, hasReachedLimit,
 * remainingUnder, limitUsageRatio, formatLimit) instead of raw arithmetic.
 */
export type Limit = number | null;

export type PlanLimits = {
  products: Limit;
  apiHitsPerMonth: Limit;
  teamMembers: Limit;
  analyticsRetentionDays: Limit;
};

// ── Campaign Configuration ──────────────────────────────────────────────────

export type PricingMode = 'group' | 'ppp_factor' | 'custom';

export type DiscountDelivery = 'banner_coupon' | 'auto_apply';

export type CharmPricingStrategy =
  | 'none'
  | 'dot99'
  | 'round_x9'
  | 'nearest_5'
  | 'region_aware';

export type CampaignStatus = 'active' | 'paused' | 'draft';

// ── Experiments (A/B tests) ─────────────────────────────────────────────────

export type ExperimentStatus = 'running' | 'ended';

/** Arm of an experiment: 'a' is the control campaign, 'b' the variant. */
export type ExperimentVariant = 'a' | 'b';

// ── Integrations ────────────────────────────────────────────────────────────

export type IntegrationProvider =
  | 'dodopayments'
  | 'stripe'
  | 'paddle'
  | 'gumroad'
  | 'chargebee'
  | 'whop'
  | 'polar'
  | 'creem'
  | 'woocommerce';

// ── Banner ──────────────────────────────────────────────────────────────────

export type BannerPosition = 'top' | 'bottom' | 'bottom-left' | 'bottom-right';

export type BannerConfig = {
  position: BannerPosition;
  messageTemplate: string;
  ctaText: string;
  backgroundColor: string;
  textColor: string;
  ctaColor: string;
  ctaTextColor: string;
  showFlag: boolean;
  showCloseBtn: boolean;
};

export type BannerResponse = {
  show: boolean;
  country: string;
  countryName: string;
  discount: number;
  code: string | null;
  banner: BannerConfig;
  // ── Local prices (packages/shared/src/currency/local-price.ts) ──
  // Sent on every `show: true` answer. Without a usable exchange rate they are
  // the exact prices in the product's currency (currencyCode = baseCurrencyCode,
  // fxRate 1, no fxAsOf); `fxAsOf` present means a converted estimate.
  /** The product's currency (products.currency). */
  baseCurrencyCode?: string;
  baseCurrencySymbol?: string;
  /** The currency of localPrice and localOriginalPrice. */
  currencyCode?: string;
  /** Symbol of currencyCode. */
  currencySymbol?: string;
  /** Units of currencyCode per 1 unit of baseCurrencyCode; 1 when not converted. */
  fxRate?: number;
  /** The rates' date, YYYY-MM-DD. Present only on a converted estimate. */
  fxAsOf?: string;
  /** The product's price after the discount, in currencyCode (charm-rounded up when converted). */
  localPrice?: number;
  /** The product's price before the discount, in currencyCode (charm-rounded down when converted). */
  localOriginalPrice?: number;
  /** The campaign's charm strategy, so the SDKs round other prices the same way. */
  charmPricingStrategy?: CharmPricingStrategy;
  // Echoed back so the banner can attribute analytics events to the campaign
  // (the client sends campaignId + the resolved country on /v1/events).
  // With an A/B experiment this is the visitor's assigned arm's campaign.
  campaignId?: string;
  // Present only when a running A/B experiment chose the campaign: the
  // experiment and the visitor's sticky arm ('a' = control, 'b' = variant).
  experimentId?: string;
  variant?: 'a' | 'b';
  // Plan-derived, server-enforced (NOT a customer-editable banner setting):
  // Free plans render a "Powered by GoPayLocal" link; paid plans remove it.
  showBranding: boolean;
};

// ── Parity ──────────────────────────────────────────────────────────────────

export type ParityTier = {
  id: string;
  name: string;
  discountPercent: number;
  sortOrder: number;
  countries: string[];
};

// ── Analytics ───────────────────────────────────────────────────────────────

export type AnalyticsEventType =
  | 'impression'
  | 'click'
  | 'copy'
  | 'dismiss'
  | 'redemption';

// ── API Keys ────────────────────────────────────────────────────────────────

export type ApiKeyType = 'public' | 'secret';
