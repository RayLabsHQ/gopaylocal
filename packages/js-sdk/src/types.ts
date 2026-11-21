import type { CharmStrategy } from './price';

// ── SDK Configuration ────────────────────────────────────────────────────────

/** Configuration for the GoPayLocal JS SDK. */
export interface GoPayLocalConfig {
  /** Public API key (starts with gpl_pk_). Safe to ship in client code. */
  apiKey: string;
  /**
   * API base URL. Defaults to `https://api.gopaylocal.com` (the hosted
   * service). Self-hosted deployments pass the URL of their own API Worker.
   */
  apiBase?: string;
  /**
   * Only use this product's campaign. Without it, the API picks the campaign
   * for you (see the banner API docs for the rule when you have several
   * products). An unknown id, or a product with no active campaign, means no
   * discount; it never falls back to another product's campaign.
   */
  productId?: string;
  /**
   * Your own visitor id for A/B experiments, for example a signed-in user's
   * id, so the visitor sees the same arm on every device. 16 to 64 characters
   * of `A-Z a-z 0-9 _ -`; anything else is ignored (with a console warning).
   * Do not put personal data such as an email address in it.
   */
  visitorId?: string;
  /**
   * Keep a random visitor id in localStorage (key `gpl_vid`) so the visitor
   * stays in the same experiment arm across page loads. Defaults to true.
   * When false, no id is stored or sent and the API assigns the arm from a
   * hash of IP address and user agent instead.
   */
  persistVisitorId?: boolean;
  /**
   * The currency the prices you pass to `getPrice()` are written in (e.g.,
   * 'USD'). Prices are converted to the visitor's currency only when this is
   * your product's currency. Defaults to the product's currency from the API,
   * and to 'USD' when the API has not answered or no discount applies.
   */
  baseCurrencyCode?: string;
  /**
   * The symbol of that currency (e.g., '$'). Defaults to the product's symbol
   * from the API when `baseCurrencyCode` is the product's currency, otherwise
   * to the symbol of `baseCurrencyCode` in the visitor's locale.
   */
  baseCurrencySymbol?: string;
  /** Called when a discount applies to this visitor (not when there is none). */
  onLoad?: (data: PPPData) => void;
  /** Called when the request fails, including a timeout after 8 seconds. */
  onError?: (error: Error) => void;
  /**
   * How long a response with a discount is reused from sessionStorage, in
   * milliseconds. Defaults to 5 minutes. Set 0 to always ask the API.
   */
  cacheTtl?: number;
}

// ── PPP Data ────────────────────────────────────────────────────────────────

/** Dashboard-configured banner design, as returned by the API. */
export interface BannerDesign {
  position: 'top' | 'bottom' | 'bottom-left' | 'bottom-right';
  messageTemplate: string;
  ctaText: string;
  backgroundColor: string;
  textColor: string;
  ctaColor: string;
  ctaTextColor: string;
  showFlag: boolean;
  showCloseBtn: boolean;
}

/** Purchasing Power Parity data for the current visitor. */
export interface PPPData {
  /** Always true: the SDK returns null instead of data when no discount applies. */
  show: boolean;
  /** ISO 3166-1 alpha-2 country code (e.g., 'IN'). */
  country: string;
  /** Full country name (e.g., 'India'). */
  countryName: string;
  /** Discount percentage (0-100). */
  discount: number;
  /** Coupon code, if available. */
  code: string | null;
  /** Your product's currency (e.g., 'USD'). */
  baseCurrencyCode: string;
  /** Your product's currency symbol (e.g., '$'). */
  baseCurrencySymbol: string;
  /**
   * The currency of `localPrice`: the visitor's currency when the API
   * converted the price (`fxAsOf` is set), otherwise `baseCurrencyCode`.
   */
  currencyCode: string;
  /** The symbol of `currencyCode`. */
  currencySymbol: string;
  /** Units of `currencyCode` per unit of `baseCurrencyCode`; 1 when not converted. */
  fxRate: number;
  /**
   * The date of the exchange rates (YYYY-MM-DD) when the prices are converted
   * estimates; null when they are exact prices in your product's currency.
   */
  fxAsOf: string | null;
  /**
   * Your product's price after the discount, in `currencyCode`, as the API
   * computed it: converted and charm-rounded up when `fxAsOf` is set,
   * otherwise exact. Null if the API did not send one.
   */
  localPrice: number | null;
  /** Your product's price before the discount, in `currencyCode` (charm-rounded down when converted). */
  localOriginalPrice: number | null;
  /** The campaign's charm pricing strategy, which `getPrice()` rounds converted prices with. */
  charmPricingStrategy: CharmStrategy;
  /** Country flag emoji. */
  flag: string;
  /** The campaign that produced this discount (the assigned arm during an experiment). */
  campaignId: string | null;
  /** The running A/B experiment's id, or null when no experiment applied. */
  experimentId: string | null;
  /** The experiment arm this visitor is in: 'a' (control), 'b' (variant), or null. */
  variant: 'a' | 'b' | null;
  /** The campaign's banner design, used by `showBanner()`. */
  banner: BannerDesign | null;
  /** Whether a "Powered by GoPayLocal" link is shown (Free plan). Set by the API. */
  showBranding: boolean;
}

// ── Pricing Result ──────────────────────────────────────────────────────────

/** Result of a price calculation with PPP applied. */
export interface PricingResult {
  /** The base price you passed in (before any discount). */
  originalPrice: number;
  /** The price after the discount, in your base currency, unrounded. */
  discountedPrice: number;
  /**
   * The price after the discount in `currencyCode`: converted and
   * charm-rounded up when `converted`, otherwise exact: rounded to the currency's ISO minor unit (the cent for USD, the
   * whole yen for JPY), the amount your payment provider charges.
   */
  localPrice: number;
  /** The price before the discount in `currencyCode` (charm-rounded down when `converted`). */
  localOriginalPrice: number;
  /** True when the prices were converted to the visitor's currency; they are then estimates. */
  converted: boolean;
  /** Formatted `localPrice` (e.g., '₹719' or '$17.40'). */
  formatted: string;
  /** Formatted `localOriginalPrice`, for a struck-through display (e.g., '₹1,699' or '$29'). */
  formattedOriginal: string;
  /** Integer part of `formatted` (e.g., '17'). */
  integer: string;
  /** Decimal part of `formatted` (e.g., '40'). Empty for zero-decimal currencies. */
  decimal: string;
  /** Currency symbol of `formatted`. */
  currencySymbol: string;
  /** Currency code of `formatted`. */
  currencyCode: string;
  /** Whether a discount is being applied. */
  hasDiscount: boolean;
  /** The discount percentage (0-100). */
  discount: number;
}

// ── Banner Options ──────────────────────────────────────────────────────────

/**
 * Options for `showBanner()`. Each one overrides the banner design from your
 * dashboard; anything not set there or here uses the SDK default.
 */
export interface BannerOptions {
  /** Banner position. Default 'bottom'. */
  position?: 'top' | 'bottom' | 'bottom-left' | 'bottom-right';
  /** Banner background color. Default '#1a1a2e'. */
  backgroundColor?: string;
  /** Banner text color. Default '#ffffff'. */
  textColor?: string;
  /** CTA button color. Default '#e94560'. */
  ctaColor?: string;
  /** CTA button text color. Default '#ffffff'. */
  ctaTextColor?: string;
  /** CTA button text. Default 'Copy Code'. */
  ctaText?: string;
  /**
   * Message with placeholders: {{countryName}}, {{country}}, {{flag}},
   * {{discount}}, {{code}}, {{localPrice}}, {{localOriginalPrice}},
   * {{currencySymbol}}, {{currencyCode}}. The prices are your product's, in the
   * visitor's currency when converted. Wrap text in `**double asterisks**` to
   * make it bold.
   */
  messageTemplate?: string;
  /** Whether to show the country flag. Default true. */
  showFlag?: boolean;
  /** Whether to show the close button. Default true. */
  showCloseBtn?: boolean;
  /** Called when the visitor closes the banner. */
  onClose?: () => void;
}

// ── API Response (internal) ─────────────────────────────────────────────────

/** Raw response from `GET /v1/banner/config/:publicKey`. */
export interface ApiResponse {
  show: boolean;
  country?: string;
  countryName?: string;
  discount?: number;
  code?: string | null;
  baseCurrencyCode?: string;
  baseCurrencySymbol?: string;
  currencyCode?: string;
  currencySymbol?: string;
  fxRate?: number;
  fxAsOf?: string;
  localPrice?: number;
  localOriginalPrice?: number;
  charmPricingStrategy?: string;
  reason?: string;
  campaignId?: string;
  experimentId?: string;
  variant?: 'a' | 'b';
  showBranding?: boolean;
  banner?: BannerDesign;
}
