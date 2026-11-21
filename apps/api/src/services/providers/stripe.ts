// ── Stripe Provider ─────────────────────────────────────────────────────────
// Integration with Stripe for PPP discount management.
// Docs: https://docs.stripe.com/api
// SDK: stripe-node v23.1.0 (https://github.com/stripe/stripe-node), which pins
// API version 2026-10-28.endive. Every request below is checked against the
// SDK's types for THAT version (generated from github.com/stripe/openapi tag
// v2596). Since the previous pin (2025-02-24.acacia) one request shape changed:
// 2025-09-30.clover moved the promotion code's coupon reference from `coupon`
// to `promotion: { type: 'coupon', coupon }`
// (https://docs.stripe.com/changelog/clover/2025-09-30/polymorphic-coupon).
// The Checkout Session fields parseRedemption reads (`discounts[]`,
// `payment_status`, `amount_subtotal`, `amount_total`, `total_details`,
// `currency`) are the same in both versions. See stripe.test.ts.
//
// Stripe Managed Payments (Stripe as merchant of record) changes nothing in
// how coupons, promotion codes or webhooks work here: the merchant opts in per
// Checkout Session or Payment Link in their own integration, the same
// checkout.session.* events arrive on the same endpoint, and every session says
// whether it was managed (`managed_payments.enabled`). What it does change is
// that tax is always calculated, so amount_total includes tax and
// parseRedemption reports it (contract C3). createCheckoutSession() can opt a
// session in; GoPayLocal itself has no production checkout caller.
//
// Stripe uses a two-level discount system:
// 1. Coupons — define the discount amount/percentage (and optional product scope)
// 2. Promotion Codes — user-facing codes that reference a coupon
//
// We tag coupons with metadata { gopaylocal: 'true' } to identify ours.
// For checkout, we use Stripe Checkout Sessions with the coupon/promo applied.
//
// Cloudflare Workers: the SDK is instantiated with the Web Fetch HTTP client
// (Stripe.createFetchHttpClient()) because Workers has no Node `http` module.
// The `workerd` package export already wires up the Web platform functions, but
// passing the fetch client explicitly is the documented, defensive approach.
//
// Webhook signature scheme (https://docs.stripe.com/webhooks#verify-manually):
//   Header:  `Stripe-Signature: t=<unix-ts>,v1=<hex-hmac-sha256>[,v1=...]`
//   Signed:  `${t}.${rawBody}` (the literal timestamp, a dot, then the raw body)
//   The SDK's async verifier + Web Crypto provider runs on Workers; the sync
//   constructEvent() will NOT (no node:crypto). Default tolerance: 300s.

import Stripe from 'stripe';
import type {
  PaymentProvider,
  CreateDiscountParams,
  CheckoutUrlParams,
  ProviderDiscount,
  ProviderProduct,
  ProviderConfig,
  WebhookVerifyInput,
  RedemptionEvent,
  RedemptionDiscount,
} from './types';
import { ProviderError, ProviderAuthError, ProviderNotFoundError } from './types';

/**
 * The one Stripe API version this adapter speaks, for BOTH outbound requests
 * and webhook payloads. Typed as the SDK's LatestApiVersion so bumping the SDK
 * major fails typecheck here instead of silently changing request/payload
 * shapes. Must be >= 2025-01-27.acacia: that is when Checkout Session gained the
 * `discounts` field parseRedemption reads
 * (https://docs.stripe.com/changelog/acacia/2025-01-27/checkout-sessions-discounts-field).
 */
export const STRIPE_API_VERSION: Stripe.LatestApiVersion = '2026-10-28.endive';

// Stripe amounts are always in the currency's smallest unit. For zero-decimal
// currencies the "smallest unit" is the whole unit, so no /100 conversion.
// Source: https://docs.stripe.com/currencies#zero-decimal. UGX is deliberately
// absent: Stripe lists it as zero-decimal but its "Special cases" table says
// backwards compatibility requires UGX amounts to be sent and returned as
// two-decimal values (5 UGX = 500). ISK is the same and was never listed.
const ZERO_DECIMAL_CURRENCIES = new Set([
  'BIF', 'CLP', 'DJF', 'GNF', 'JPY', 'KMF', 'KRW', 'MGA', 'PYG',
  'RWF', 'VND', 'VUV', 'XAF', 'XOF', 'XPF',
]);

/**
 * Stripe amount -> the unit RedemptionEvent promises (the ISO 4217 minor unit,
 * lib/currency.ts). Identical for every currency except UGX and ISK, which ISO
 * makes zero-decimal while Stripe represents them with two (always-zero)
 * decimals (the "Special cases" above).
 */
const STRIPE_TWO_DECIMAL_ISO_ZERO = new Set(['UGX', 'ISK']);
function toRedemptionUnits(amount: number | null | undefined, currency: string | null): number | null {
  if (amount == null) return null;
  if (currency && STRIPE_TWO_DECIMAL_ISO_ZERO.has(currency.toUpperCase())) return Math.round(amount / 100);
  return amount;
}

/**
 * Contract C3 (types.ts): the tax inside amount_total, and the discount only
 * when it is known to EXCLUDE tax. Stripe units, before toRedemptionUnits.
 *
 * Checkout Session object (https://docs.stripe.com/api/checkout/sessions/object):
 * amount_subtotal "Total of all items before discounts or taxes are applied",
 * amount_total "Total of all items after discounts and taxes are applied",
 * total_details.amount_tax "the sum of all the tax amounts",
 * total_details.amount_discount "the sum of all the discounts".
 *
 * Whether that discount includes tax depends on the prices' tax behaviour
 * (https://docs.stripe.com/tax/products-prices-tax-codes-tax-behavior):
 * exclusive prices get tax added on top of the discounted amount; inclusive
 * prices already contain the tax, so a discount taken off them contains tax
 * too. Managed Payments uses the price's tax behaviour, exclusive by default
 * (https://docs.stripe.com/payments/managed-payments/set-up). The webhook
 * payload carries no per-rate `inclusive` flag (total_details.breakdown is
 * only present when expanded), so the totals decide:
 *   - no tax, or no discount              -> the discount is pre-tax as is
 *   - subtotal - discount + shipping + tax === total
 *                                         -> tax was added on top: pre-tax
 *   - anything else (inclusive or mixed)  -> null; the handler back-calculates
 *                                            from amount_total - amount_tax
 */
function stripeTaxAndDiscount(session: Stripe.Checkout.Session): { tax: number | null; discount: number | null } {
  const td = session.total_details;
  if (!td) return { tax: null, discount: null };
  const tax = typeof td.amount_tax === 'number' ? td.amount_tax : null;
  const discount = typeof td.amount_discount === 'number' ? td.amount_discount : null;
  if (tax === null || discount === null) return { tax, discount: null };
  if (tax === 0 || discount === 0) return { tax, discount };
  const { amount_subtotal: subtotal, amount_total: total } = session;
  const shipping = td.amount_shipping ?? 0;
  if (subtotal != null && total != null && subtotal - discount + shipping + tax === total) return { tax, discount };
  return { tax, discount: null };
}

/**
 * Codes are reduced to a-z, A-Z and 0-9. Under 2025-02-24.acacia (spec v1505)
 * promotion codes accepted nothing else; 2026-10-28.endive also accepts dashes
 * (POST /v1/promotion_codes `code`), but the codes stay dash-free so the
 * upgrade does not change the codes customers see. The coupon id reuses the
 * same string so parseRedemption's coupon id IS the customer-facing code.
 */
export function normalizeStripeCode(code: string): string {
  return code.replace(/[^a-zA-Z0-9]/g, '');
}

/** StripeProvider.createCheckoutSession options on top of the shared CheckoutUrlParams. */
export interface StripeCheckoutSessionParams extends CheckoutUrlParams {
  /**
   * Opt the session into Stripe Managed Payments (Stripe as merchant of
   * record): sends `managed_payments[enabled]=true`.
   */
  managedPayments?: boolean;
  /**
   * Show the hosted page's promotion-code field instead of pre-applying a
   * discount (`allow_promotion_codes=true`). Not combinable with discountId /
   * discountCode.
   */
  allowPromotionCodes?: boolean;
}

export class StripeProvider implements PaymentProvider {
  readonly name = 'stripe';
  private readonly apiKey: string;
  private client: Stripe | null = null;

  constructor(config: ProviderConfig) {
    // Construct the SDK lazily: `new Stripe('')` throws, and the webhook route
    // builds providers with an empty key when the merchant key can't be
    // decrypted. Verification only needs the signing secret, so an eager throw
    // there would silently drop every redemption.
    this.apiKey = config.apiKey;
  }

  private get stripe(): Stripe {
    if (!this.client) {
      this.client = new Stripe(this.apiKey, {
        // Cloudflare Workers run on the Web platform: use the Fetch-based HTTP
        // client instead of the default Node `http`/`https` client.
        httpClient: Stripe.createFetchHttpClient(),
        apiVersion: STRIPE_API_VERSION,
        typescript: true,
      });
    }
    return this.client;
  }

  async createDiscount(params: CreateDiscountParams): Promise<ProviderDiscount> {
    const code = normalizeStripeCode(params.code);
    if (!code) {
      throw new ProviderError(this.name, 'createDiscount', `Code '${params.code}' has no alphanumeric characters`);
    }

    let couponId: string | null = null;
    try {
      // 1. Create the coupon (defines the discount).
      // `duration: 'forever'` keeps the PPP price across every subscription
      // renewal; Stripe's default ('once') reverts to full price on invoice 2.
      // Chargebee, Polar and Whop adapters make the same choice; Paddle's
      // `recur: true` with no interval cap is the equivalent.
      const couponParams: Stripe.CouponCreateParams = {
        id: code,
        duration: 'forever',
        name: params.name,
        metadata: { gopaylocal: 'true', name: params.name },
      };

      if (params.discountType === 'percentage') {
        // percent_off: positive float, 0 < x <= 100.
        couponParams.percent_off = params.amount;
      } else {
        // amount_off: positive integer in the currency's smallest unit (cents).
        // currency is REQUIRED whenever amount_off is passed.
        couponParams.amount_off = params.amount;
        couponParams.currency = params.currency ?? 'usd';
      }

      if (params.maxRedemptions !== undefined) {
        couponParams.max_redemptions = params.maxRedemptions;
      }

      if (params.expiresAt) {
        // redeem_by: Unix timestamp (seconds) of the last redeemable moment.
        couponParams.redeem_by = Math.floor(new Date(params.expiresAt).getTime() / 1000);
      }

      // Restrict the coupon to specific products when requested.
      if (params.productIds && params.productIds.length > 0) {
        couponParams.applies_to = { products: params.productIds };
      }

      const coupon = await this.stripe.coupons.create(couponParams);
      couponId = coupon.id;

      // 2. Create a promotion code so customers can enter it at checkout.
      // Mirror the redemption/expiry limits onto the promo code as well; Stripe
      // requires these to be within the coupon's own limits, which they are.
      const promoParams: Stripe.PromotionCodeCreateParams = {
        // Since 2025-09-30.clover the coupon is referenced through `promotion`.
        promotion: { type: 'coupon', coupon: coupon.id },
        code,
        metadata: { gopaylocal: 'true' },
      };

      if (params.maxRedemptions !== undefined) {
        promoParams.max_redemptions = params.maxRedemptions;
      }

      if (params.expiresAt) {
        promoParams.expires_at = Math.floor(new Date(params.expiresAt).getTime() / 1000);
      }

      const promo = await this.stripe.promotionCodes.create(promoParams);

      return {
        providerDiscountId: coupon.id,
        code: promo.code ?? code,
        discountPercent: coupon.percent_off ?? 0,
        provider: this.name,
        providerPromoCodeId: promo.id,
      };
    } catch (err) {
      // The coupon exists but its promotion code doesn't: delete the coupon so a
      // failed create leaves nothing behind in the merchant's account.
      if (couponId) {
        await this.stripe.coupons.del(couponId).catch(() => {});
      }
      throw this.handleError('createDiscount', err);
    }
  }

  async deleteDiscount(discountId: string): Promise<void> {
    // Deleting the coupon also disables its promotion code: "A promotion code is
    // only active if the coupon is also valid" (promotion_code.active, v1505
    // and v2596).
    try {
      await this.stripe.coupons.del(discountId);
    } catch (err) {
      throw this.handleError('deleteDiscount', err);
    }
  }

  async listDiscounts(): Promise<ProviderDiscount[]> {
    try {
      const result: ProviderDiscount[] = [];

      // Auto-pagination: the list promise is an async iterator that fetches
      // subsequent pages transparently.
      for await (const coupon of this.stripe.coupons.list({ limit: 100 })) {
        // Only include coupons created by GoPayLocal.
        if (coupon.metadata?.gopaylocal !== 'true') continue;
        // Only redeemable ones (types.ts contract). `valid`: "Taking account of
        // the above properties, whether this coupon can still be applied to a
        // customer" (false past redeem_by or once max_redemptions is used up).
        // GET /v1/coupons has no filter for it; deleted coupons aren't listed.
        if (coupon.valid === false) continue;

        result.push({
          providerDiscountId: coupon.id,
          code: coupon.id, // Stripe coupon ID is the customer-facing code.
          discountPercent: coupon.percent_off ?? 0,
          provider: this.name,
        });
      }

      return result;
    } catch (err) {
      throw this.handleError('listDiscounts', err);
    }
  }

  async listProducts(): Promise<ProviderProduct[]> {
    try {
      const products: ProviderProduct[] = [];

      // Expand the default price so we can surface amount + currency.
      for await (const product of this.stripe.products.list({
        active: true,
        limit: 100,
        expand: ['data.default_price'],
      })) {
        const defaultPrice = product.default_price;
        let price: number | null = null;
        let currency: string | null = null;

        // default_price is `string | Stripe.Price | null`; only an expanded
        // (object) Price carries unit_amount/currency.
        if (defaultPrice && typeof defaultPrice !== 'string') {
          currency = defaultPrice.currency ?? null;
          const unitAmount = defaultPrice.unit_amount; // smallest currency unit
          if (unitAmount != null) {
            const isZeroDecimal =
              currency != null && ZERO_DECIMAL_CURRENCIES.has(currency.toUpperCase());
            // Convert minor units (cents) to major units (dollars).
            price = isZeroDecimal ? unitAmount : unitAmount / 100;
          }
        }

        products.push({
          providerProductId: product.id,
          name: product.name,
          price,
          currency,
          // Stripe products have no inherent hosted URL; checkout URLs are built
          // per-session via buildCheckoutUrl.
          url: null,
        });
      }

      return products;
    } catch (err) {
      throw this.handleError('listProducts', err);
    }
  }

  async buildCheckoutUrl(params: CheckoutUrlParams): Promise<string> {
    const session = await this.createCheckoutSession(params);
    if (!session.url) {
      throw new ProviderError(this.name, 'buildCheckoutUrl', 'No checkout URL returned');
    }
    return session.url;
  }

  /**
   * Stripe-only superset of buildCheckoutUrl that returns the whole session, so
   * a caller can read back what Stripe applied (`managed_payments`, `discounts`,
   * amounts). Used by `verify:provider stripe --managed-payments`.
   *
   * Managed Payments (https://docs.stripe.com/payments/managed-payments/set-up)
   * is opted into per session with `managed_payments[enabled]=true`; it needs
   * API version 2025-03-31.basil or later (this adapter pins a later one), the
   * feature activated in the merchant's Dashboard, and products with an
   * eligible tax code. Of the parameters Managed Payments rejects
   * (https://docs.stripe.com/payments/managed-payments/update-checkout#remove-unsupported-parameters)
   * this method never sends any, with or without the flag; stripe.test.ts
   * checks the outgoing form against that list.
   */
  async createCheckoutSession(params: StripeCheckoutSessionParams): Promise<Stripe.Checkout.Session> {
    if (params.allowPromotionCodes && (params.discountId || params.discountCode)) {
      throw new ProviderError(
        this.name,
        'createCheckoutSession',
        'allowPromotionCodes lets the customer type a code; do not also pass discountId or discountCode',
      );
    }
    try {
      // listProducts hands out product ids (prod_...), but a Checkout line item
      // needs a price: resolve a product to its default price.
      let price: Stripe.Price;
      if (params.productId.startsWith('prod_')) {
        const product = await this.stripe.products.retrieve(params.productId, {
          expand: ['default_price'],
        });
        const defaultPrice = product.default_price;
        if (!defaultPrice || typeof defaultPrice === 'string') {
          throw new ProviderError(
            this.name,
            'buildCheckoutUrl',
            `Product ${params.productId} has no default price`,
          );
        }
        price = defaultPrice;
      } else {
        price = await this.stripe.prices.retrieve(params.productId);
      }

      // Detect mode from the price: recurring prices require 'subscription'.
      const mode: Stripe.Checkout.SessionCreateParams.Mode = price.recurring
        ? 'subscription'
        : 'payment';

      const sessionParams: Stripe.Checkout.SessionCreateParams = {
        line_items: [
          {
            price: price.id,
            quantity: 1,
          },
        ],
        mode,
        success_url: params.successUrl,
      };

      if (params.cancelUrl) {
        sessionParams.cancel_url = params.cancelUrl;
      }

      // Apply discount — prefer the discount/coupon ID, fall back to a code.
      if (params.discountId) {
        sessionParams.discounts = [{ coupon: params.discountId }];
      } else if (params.discountCode) {
        // Resolve the promotion code string to its Stripe promo-code ID.
        const promoCodes = await this.stripe.promotionCodes.list({
          code: normalizeStripeCode(params.discountCode),
          active: true,
          limit: 1,
        });
        const promo = promoCodes.data[0];
        if (promo) {
          sessionParams.discounts = [{ promotion_code: promo.id }];
        }
      } else if (params.allowPromotionCodes) {
        // "Enables user redeemable promotion codes": the hosted page shows a
        // code field (https://docs.stripe.com/payments/checkout/discounts).
        sessionParams.allow_promotion_codes = true;
      }

      if (params.customerEmail) {
        sessionParams.customer_email = params.customerEmail;
      }

      if (params.metadata) {
        sessionParams.metadata = params.metadata;
      }

      if (params.managedPayments) {
        sessionParams.managed_payments = { enabled: true };
      }

      return await this.stripe.checkout.sessions.create(sessionParams);
    } catch (err) {
      if (err instanceof ProviderError) throw err;
      throw this.handleError('buildCheckoutUrl', err);
    }
  }

  // ── Webhooks ──────────────────────────────────────────────────────────────

  async provisionWebhook(
    callbackUrl: string,
  ): Promise<{ endpointId: string; secret: string | null }> {
    try {
      const endpoint = await this.stripe.webhookEndpoints.create({
        url: callbackUrl,
        // Pin the payload version: unpinned endpoints render at the MERCHANT's
        // account-default version, and the session-level `discounts` array only
        // exists from 2025-01-27.acacia. Older accounts would parse as zero
        // redemptions. Same constant as the SDK's request version.
        api_version: STRIPE_API_VERSION,
        // Card flows fire `completed`; delayed/async methods fire the async event.
        enabled_events: [
          'checkout.session.completed',
          'checkout.session.async_payment_succeeded',
        ],
        description: 'GoPayLocal PPP redemption tracking',
        metadata: { gopaylocal: 'true' },
      });
      // `secret` (whsec_...) is ONLY returned at creation — capture it now.
      return { endpointId: endpoint.id, secret: endpoint.secret ?? null };
    } catch (err) {
      throw this.handleError('provisionWebhook', err);
    }
  }

  async deleteWebhook(endpointId: string): Promise<void> {
    try {
      await this.stripe.webhookEndpoints.del(endpointId);
    } catch (err) {
      // Already gone — treat as success.
      if (err instanceof Stripe.errors.StripeError && err.code === 'resource_missing') return;
      throw this.handleError('deleteWebhook', err);
    }
  }

  async verifyWebhook(input: WebhookVerifyInput): Promise<boolean> {
    if (!input.secret) return false;
    const sig = input.headers.get('stripe-signature');
    if (!sig) return false;
    try {
      // Static verifier: needs no API key. Async + WebCrypto provider — the sync
      // verifier uses node:crypto and won't run on Workers.
      await Stripe.webhooks.constructEventAsync(
        input.rawBody,
        sig,
        input.secret,
        undefined,
        Stripe.createSubtleCryptoProvider(),
      );
      return true;
    } catch {
      return false;
    }
  }

  parseRedemption(rawBody: string): RedemptionEvent | null {
    let event: Stripe.Event;
    try {
      event = JSON.parse(rawBody) as Stripe.Event;
    } catch {
      return null;
    }
    // Only Checkout completions count. Subscription renewals never produce a
    // Checkout Session, so they can't be double-counted here.
    if (
      event.type !== 'checkout.session.completed' &&
      event.type !== 'checkout.session.async_payment_succeeded'
    ) {
      return null;
    }
    const session = event.data.object as Stripe.Checkout.Session;
    // Don't count sessions whose payment hasn't actually settled.
    if (session.payment_status !== 'paid' && session.payment_status !== 'no_payment_required') {
      return null;
    }
    // Webhook payloads aren't expanded, so coupon/promotion_code are string ids.
    // Our coupons are created with id === human code, so coupon (string) IS the code.
    const idsOf = (d: NonNullable<Stripe.Checkout.Session['discounts']>[number] | undefined) => ({
      couponId: !d ? null : typeof d.coupon === 'string' ? d.coupon : d.coupon?.id ?? null,
      promoId: !d
        ? null
        : typeof d.promotion_code === 'string'
          ? d.promotion_code
          : d.promotion_code?.id ?? null,
    });
    const { couponId, promoId } = idsOf(session.discounts?.[0]);
    if (!couponId && !promoId) return null; // no discount applied

    // Checkout currently accepts only one discount per session ("Currently,
    // only up to one may be specified", Checkout Session `discounts`), so this
    // is defensive. Per-discount amounts aren't in the unexpanded webhook
    // payload (total_details.amount_discount is the session total and stays on
    // the primary), so extra entries carry identifiers only.
    const otherDiscounts: RedemptionDiscount[] = (session.discounts ?? [])
      .slice(1)
      .map((d) => {
        const ids = idsOf(d);
        return { code: ids.couponId, providerCouponId: ids.couponId, providerPromoCodeId: ids.promoId };
      })
      .filter((d) => d.providerCouponId || d.providerPromoCodeId);

    // Amounts and currency are the integration currency (the prices'), also
    // under Adaptive Pricing, which Managed Payments always enables: "The
    // Checkout Session and the underlying PaymentIntent objects reflect what
    // your customer paid in your integration currency and amount"; what the
    // customer saw is only in `presentment_details`
    // (https://docs.stripe.com/payments/currencies/localize-prices/adaptive-pricing?payment-ui=stripe-hosted).
    const currency = session.currency ?? null;
    const { tax, discount } = stripeTaxAndDiscount(session);
    return {
      // Key idempotency on the session, not the event: `completed` and
      // `async_payment_succeeded` both fire for the same session and would
      // otherwise be counted twice.
      eventId: session.id,
      code: couponId,
      providerCouponId: couponId,
      providerPromoCodeId: promoId,
      chargedAmountCents: toRedemptionUnits(session.amount_total, currency),
      taxAmountCents: toRedemptionUnits(tax, currency),
      discountAmountCents: toRedemptionUnits(discount, currency),
      currency,
      ...(otherDiscounts.length > 0 ? { otherDiscounts } : {}),
    };
  }

  private handleError(operation: string, err: unknown): ProviderError {
    if (err instanceof ProviderError) return err;

    if (err instanceof Stripe.errors.StripeError) {
      // 401 = bad/revoked key; 403 = restricted key missing a permission
      // (https://docs.stripe.com/api/errors). Both need the merchant to fix the key.
      if (
        err.type === 'StripeAuthenticationError' ||
        err.type === 'StripePermissionError' ||
        err.statusCode === 401 ||
        err.statusCode === 403
      ) {
        return new ProviderAuthError(this.name, err.message);
      }
      if (err.code === 'resource_missing' || err.statusCode === 404) {
        return new ProviderNotFoundError(this.name, 'resource', err.message);
      }
      return new ProviderError(
        this.name,
        operation,
        err.message,
        err.statusCode,
        err.code ?? undefined,
      );
    }

    const message = err instanceof Error ? err.message : String(err);
    return new ProviderError(this.name, operation, message);
  }
}
