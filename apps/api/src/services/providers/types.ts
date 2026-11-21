// ── Provider Integration Types ──────────────────────────────────────────────
// Common interface for all payment provider integrations.
// Each provider implements these operations to manage PPP discounts.

export interface ProviderDiscount {
  providerDiscountId: string;
  code: string;
  discountPercent: number;
  provider: string;
  /** Secondary provider id when codes are a separate object (e.g. Stripe promotion codes). */
  providerPromoCodeId?: string | null;
}

export interface CreateDiscountParams {
  name: string;
  code: string;
  discountType: 'percentage' | 'fixed';
  amount: number; // percentage (0-100) or fixed amount in cents
  currency?: string; // required for fixed discounts
  expiresAt?: string; // ISO date
  productIds?: string[]; // provider-specific product IDs to restrict to
  maxRedemptions?: number;
}

export interface CheckoutUrlParams {
  /**
   * The id of what is being bought; its kind differs per provider:
   * Stripe and Paddle: a price or a product; Gumroad, Dodo, Polar: a product;
   * Chargebee: an item price; Whop: a plan. Other adapters document theirs on
   * their buildCheckoutUrl. Not the same id kind as
   * CreateDiscountParams.productIds on every provider.
   */
  productId: string;
  discountCode?: string;
  discountId?: string; // provider discount ID
  successUrl: string;
  cancelUrl?: string;
  customerEmail?: string;
  metadata?: Record<string, string>;
}

export interface ProviderProduct {
  providerProductId: string;
  name: string;
  price: number | null;
  currency: string | null;
  url: string | null;
}

/** Input to a provider's webhook signature verification. */
export interface WebhookVerifyInput {
  rawBody: string;
  headers: Headers; // Fetch Headers (case-insensitive); from c.req.raw.headers
  secret: string | null; // the per-integration signing secret (decrypted)
}

/** One discount applied to an order, as identified by the provider. */
export interface RedemptionDiscount {
  code: string | null;
  providerCouponId: string | null;
  providerPromoCodeId: string | null;
  /**
   * This discount's own amount (minor units), EXCLUDING tax, when the provider
   * itemizes stacked discounts. Omitted/null means "not itemized" (or only
   * known tax-inclusive): the handler then back-calculates, see RedemptionEvent.
   */
  discountAmountCents?: number | null;
}

/**
 * A normalized "a coupon was redeemed" event parsed from a provider webhook.
 * Any of code / providerCouponId / providerPromoCodeId may identify our coupon
 * (resolved against the integration-scoped `coupons` row).
 *
 * Amounts are integers in the currency's ISO 4217 minor unit (cents for USD,
 * whole yen for JPY, fils for KWD; see lib/currency.ts). Adapters whose provider
 * uses a different representation (e.g. Stripe's two-decimal ISK/UGX) convert
 * before emitting. The redemption handler converts to major units.
 *
 * Tax (contract C3): "revenue saved" is always computed from PRE-TAX amounts.
 *  - `chargedAmountCents` is the provider's own order total: what the buyer
 *    paid after discounts, INCLUDING any tax.
 *  - `taxAmountCents` is the tax contained in that total: 0 when the provider
 *    reports the order carries no tax, null when the provider doesn't say.
 *  - `discountAmountCents` (here and on `otherDiscounts`) EXCLUDES tax. If the
 *    provider only reports a tax-inclusive discount (tax-inclusive prices) and
 *    the adapter can't split it, emit null.
 * The handler uses the pre-tax discount when given; otherwise it
 * back-calculates from `chargedAmountCents − taxAmountCents` and the coupon's
 * percent; if the tax is unknown (null) it counts the redemption but adds
 * nothing to revenue saved rather than count tax as savings.
 */
export interface RedemptionEvent {
  eventId: string; // for idempotency
  code: string | null;
  providerCouponId: string | null;
  providerPromoCodeId: string | null;
  /** Order total paid, after discounts, INCLUDING tax. */
  chargedAmountCents: number | null;
  /**
   * Tax included in `chargedAmountCents`: 0 = no tax on this order, null =
   * not reported. Required: an adapter must say which (redemption-shape.test.ts
   * checks the values).
   */
  taxAmountCents: number | null;
  /** The primary discount's amount, EXCLUDING tax; null when not known pre-tax. */
  discountAmountCents: number | null;
  currency: string | null;
  /**
   * Further discounts stacked on the same order, in the provider's order
   * (the fields above describe the primary one). A GoPayLocal code is not
   * always first: the handler matches the primary, then each of these.
   * Adapters only set this when the order really carries more than one.
   */
  otherDiscounts?: RedemptionDiscount[];
}

/** Result of PaymentProvider.provisionWebhook. */
export interface ProvisionedWebhook {
  endpointId: string;
  secret: string | null;
  adopted?: boolean;
}

export interface PaymentProvider {
  readonly name: string;

  createDiscount(params: CreateDiscountParams): Promise<ProviderDiscount>;
  /**
   * Make the discount unusable. Providers differ in how (Paddle and Whop
   * archive; Chargebee archives a coupon that is in use; others delete); what
   * callers can rely on is that it can no longer be redeemed and that
   * listDiscounts() no longer returns it.
   */
  deleteDiscount(discountId: string): Promise<void>;
  /**
   * Discounts that can currently be redeemed. Excludes archived, expired and
   * deleted ones, filtering client-side where the provider's list includes them.
   */
  listDiscounts(): Promise<ProviderDiscount[]>;
  buildCheckoutUrl(params: CheckoutUrlParams): Promise<string>;

  /** List products from the provider. Optional — not all providers support this. */
  listProducts?(): Promise<ProviderProduct[]>;

  // ── Webhooks (redemption tracking) — optional, added per provider ──────────
  /**
   * Create the webhook endpoint at connect time; returns its id + signing
   * secret. `adopted: true` when an existing endpoint for this exact callback
   * URL was reused instead of created (Gumroad), so a caller that only cleans
   * up what it created (the verify tool) leaves it alone. Omitted = created.
   */
  provisionWebhook?(callbackUrl: string): Promise<ProvisionedWebhook>;
  /** Delete the webhook endpoint on disconnect. */
  deleteWebhook?(endpointId: string): Promise<void>;
  /** Verify an incoming webhook's signature against the stored secret. */
  verifyWebhook?(input: WebhookVerifyInput): Promise<boolean>;
  /**
   * True for an unsigned setup ping that carries no event (WooCommerce sends
   * one when a webhook is created, before provisionWebhook has returned the
   * secret, and refuses to save the webhook unless it gets a 2xx). The handler
   * answers 200 without verifying, storing or touching integration health.
   */
  isHandshake?(input: { rawBody: string; headers: Headers }): boolean;
  /**
   * Parse a verified webhook body into a redemption, or null if not one. May be
   * async — a provider may need a follow-up API call to confirm authenticity
   * (Gumroad reads the sale back).
   */
  parseRedemption?(
    rawBody: string,
  ): RedemptionEvent | null | Promise<RedemptionEvent | null>;
}

// ── Provider Errors ─────────────────────────────────────────────────────────

export class ProviderError extends Error {
  constructor(
    public readonly provider: string,
    public readonly operation: string,
    message: string,
    public readonly statusCode?: number,
    public readonly providerErrorCode?: string,
  ) {
    super(`[${provider}] ${operation}: ${message}`);
    this.name = 'ProviderError';
  }
}

export class ProviderAuthError extends ProviderError {
  constructor(provider: string, message: string) {
    super(provider, 'auth', message, 401);
    this.name = 'ProviderAuthError';
  }
}

export class ProviderNotFoundError extends ProviderError {
  constructor(provider: string, resource: string, id: string) {
    super(provider, 'not_found', `${resource} '${id}' not found`, 404);
    this.name = 'ProviderNotFoundError';
  }
}

// ── Provider Config ─────────────────────────────────────────────────────────

export interface ProviderConfig {
  apiKey: string;
  environment?: 'test' | 'live';
  siteId?: string; // the integration's providerAccountId: Chargebee site, Whop company id
}
