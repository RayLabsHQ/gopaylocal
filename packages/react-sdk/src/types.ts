// Bundled into this package at build time.
import type { CharmStrategy } from '../../js-sdk/src/price';

export type { CharmStrategy };

// ── SDK Configuration ────────────────────────────────────────────────────────

/** Configuration for the GoPayLocal React SDK (the provider's props, minus callbacks and children). */
export interface PPPConfig {
  /** Public API key (starts with gpl_pk_). Safe to ship in client code. */
  apiKey: string;
  /**
   * API base URL. Defaults to `https://api.gopaylocal.com` (the hosted
   * service). Self-hosted deployments pass the URL of their own API Worker.
   */
  apiBase?: string;
  /**
   * Only use this product's campaign. An unknown id, or a product with no
   * active campaign, means no discount; it never falls back to another
   * product's campaign.
   */
  productId?: string;
  /**
   * Your own visitor id for A/B experiments (16 to 64 characters of
   * `A-Z a-z 0-9 _ -`; anything else is ignored with a console warning).
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
   * The currency the prices you pass to `usePrice()` and the price components
   * are written in (e.g., 'USD'). Prices are converted to the visitor's
   * currency only when this is your product's currency. Defaults to the
   * product's currency from the API, and to 'USD' when the API has not
   * answered or no discount applies.
   */
  baseCurrencyCode?: string;
  /**
   * The symbol of that currency (e.g., '$'). Defaults to the product's symbol
   * from the API when `baseCurrencyCode` is the product's currency, otherwise
   * to the symbol of `baseCurrencyCode` in the visitor's locale.
   */
  baseCurrencySymbol?: string;
}

// ── API Response ─────────────────────────────────────────────────────────────

/** Dashboard-configured banner design, as returned by the API. */
export interface PPPBannerDesign {
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

/** A holiday deal: a sale with an end, offered in place of the visitor's country discount. */
export interface PPPDeal {
  id: string;
  /** The deal's name, such as "Black Friday". */
  name: string;
  /** When the deal ends (ISO 8601, UTC). */
  endsAt: string;
}

/** A config response for a visitor who gets a discount (`show: true`). */
export interface PPPResponse {
  show: true;
  country: string;
  countryName: string;
  discount: number;
  code: string | null;
  banner: PPPBannerDesign;
  /** Your product's currency (e.g., 'USD'). */
  baseCurrencyCode?: string;
  /** Your product's currency symbol. */
  baseCurrencySymbol?: string;
  /** The currency of `localPrice`: the visitor's when converted (`fxAsOf` set), else your product's. */
  currencyCode?: string;
  /** The symbol of `currencyCode`. */
  currencySymbol?: string;
  /** Units of `currencyCode` per unit of `baseCurrencyCode`; 1 when not converted. */
  fxRate?: number;
  /** The rates' date (YYYY-MM-DD); present only when the prices are converted estimates. */
  fxAsOf?: string;
  /** Your product's price after the discount, in `currencyCode` (charm-rounded up when converted). */
  localPrice?: number;
  /** Your product's price before the discount, in `currencyCode` (charm-rounded down when converted). */
  localOriginalPrice?: number;
  /** The campaign's charm pricing strategy. */
  charmPricingStrategy?: string;
  /** The campaign that produced this discount (the assigned arm during an experiment). */
  campaignId?: string;
  /** Present only when an A/B experiment applied. */
  experimentId?: string;
  /** Present only when an A/B experiment applied. */
  variant?: 'a' | 'b';
  /** Whether a "Powered by GoPayLocal" link is shown (Free plan). */
  showBranding?: boolean;
  /**
   * Present when the offer is a holiday deal: `discount` and `code` are then
   * the deal's, not the visitor's country discount.
   */
  deal?: PPPDeal;
}

// ── Context Value ────────────────────────────────────────────────────────────

/**
 * Banner interaction events. Only `'click'` and `'copy'` are sent to the API:
 * an impression is counted by the API when it serves the offer, and a
 * dismissal is not stored. `'impression'` and `'dismiss'` are accepted and do
 * nothing.
 */
export type PPPTrackableEvent = 'impression' | 'click' | 'copy' | 'dismiss';

/** The value exposed by the PPP context to all consumer hooks and components. */
export interface PPPContextValue {
  /** The API response when a discount applies; null while loading, on error, or when no discount applies. */
  data: PPPResponse | null;
  /** Whether the API request is in flight. True on the server and on the first client render. */
  isLoading: boolean;
  /** Error from the API request, if any (including a timeout after 8 seconds). */
  error: Error | null;
  /** The visitor's ISO 3166-1 alpha-2 country code (e.g., 'IN'), when a discount applies. */
  country: string | null;
  /** The discount percentage (0-100). 0 when no discount applies. */
  discount: number;
  /** The coupon code, if available. */
  code: string | null;
  /** The currency the prices you pass in are written in (see `baseCurrencyCode` on the provider). */
  baseCurrencyCode: string;
  /** The symbol of `baseCurrencyCode`. */
  baseCurrencySymbol: string;
  /**
   * The currency `usePrice()` and the price components show prices in: the
   * visitor's when prices are converted (`fxAsOf` is set), else `baseCurrencyCode`.
   */
  currencyCode: string;
  /** The symbol of `currencyCode`. */
  currencySymbol: string;
  /** The exchange rate prices are converted with; 1 when they are not converted. */
  fxRate: number;
  /**
   * The rates' date (YYYY-MM-DD) when prices are converted to the visitor's
   * currency, and are therefore estimates; null when they stay in your base
   * currency. Conversion needs a response that is a conversion and
   * `baseCurrencyCode` equal to your product's currency.
   */
  fxAsOf: string | null;
  /** The campaign's charm strategy, used to round converted prices. */
  charmPricingStrategy: CharmStrategy;
  /**
   * A base price after the discount, in `currencyCode`: converted and
   * charm-rounded up when `fxAsOf` is set, otherwise exact: rounded to the
   * currency's ISO minor unit (the cent for USD, the whole yen for JPY). The
   * same rule the API uses for your product's own price.
   */
  localPrice: (basePrice: number) => number;
  /** A base price before the discount, in `currencyCode` (charm-rounded down when converted). */
  localOriginalPrice: (basePrice: number) => number;
  /** Format a price in `currencyCode`. */
  formatPrice: (price: number, options?: Intl.NumberFormatOptions) => string;
  /** Country flag emoji (e.g., '🇮🇳' for India). Empty string if unavailable. */
  flag: string;
  /** The campaign that produced the discount (the assigned arm during an experiment), or null. */
  campaignId: string | null;
  /**
   * The running A/B experiment's id, or null when no experiment applied.
   * Also set when the visitor's arm has no discount for them (`data` is null).
   */
  experimentId: string | null;
  /** The experiment arm this visitor is in: 'a' (control), 'b' (variant), or null. */
  variant: 'a' | 'b' | null;
  /**
   * Report a banner interaction to GoPayLocal analytics, for custom banners
   * (`<PPPBanner>` reports its own). Does nothing when no discount applies.
   * Only `'click'` and `'copy'` are sent (see `PPPTrackableEvent`).
   */
  track: (event: PPPTrackableEvent) => void;
}
