// ── Dodo Payments Provider (merchant integration) ───────────────────────────
// A merchant's own Dodo Payments account, used for PPP discount codes and
// redemption tracking. GoPayLocal's own billing on Dodo lives in routes/billing.ts.
//
// Sources (OpenAPI v1.124.0, fetched Nov 2026):
//   API basics      https://docs.dodopayments.com/api-reference/introduction
//   Test vs live    https://docs.dodopayments.com/miscellaneous/test-mode-vs-live-mode
//   Discounts       https://docs.dodopayments.com/api-reference/discounts/create-discount
//                   https://docs.dodopayments.com/api-reference/discounts/delete-discount
//                   https://docs.dodopayments.com/api-reference/discounts/list-discounts
//                   https://docs.dodopayments.com/features/discount-codes
//   Products        https://docs.dodopayments.com/api-reference/products/get-products
//   Checkouts       https://docs.dodopayments.com/api-reference/checkout-sessions/create
//   Webhooks        https://docs.dodopayments.com/api-reference/webhooks/create-webhook
//                   https://docs.dodopayments.com/api-reference/webhooks/get-webhook-signing-key
//                   https://docs.dodopayments.com/api-reference/webhooks/delete-webhook
//                   https://docs.dodopayments.com/developer-resources/webhooks
//   Payment payload https://docs.dodopayments.com/developer-resources/webhooks/intents/payment
//                   https://docs.dodopayments.com/api-reference/payments/get-payments-1
//
// SDK: dodopayments@2.63.0 for discounts and products. POST /checkouts and
// /webhooks use raw fetch: SDK 0.24.0 lacked them, and the calls were kept as
// they were when the SDK was upgraded.
//
// Facts the code depends on:
//   • Hosts: live.dodopayments.com / test.dodopayments.com, `Authorization: Bearer`.
//     Keys may be prefixed dodo_live_ / dodo_test_; a prefixed key sent to the
//     other mode's host returns 401 "with a message that names the mismatch".
//     We keep the caller's environment (it says which credential slot the key
//     came from) and surface Dodo's 401 message instead of silently re-routing.
//   • Errors: `{ code, message }` JSON.
//   • Percentage discount `amount` is BASIS POINTS (30% => 3000). `code` is
//     uppercased by Dodo, min 3 chars; DiscountResponse.code is "up to 16 chars".
//     The API and SDK 2.x also accept `type: 'flat'` (with `currency_options`);
//     this adapter creates percentage discounts only.
//   • Lists are page_number (0-based, "default = 0") + page_size (max 100) and
//     return `{ items }`. The SDK's auto-iterator is broken (0.24.0 and 2.63.0
//     alike): after the implicit page 0 it requests page_number=2, skipping
//     page 1 (dodopayments-typescript issue #359). So we page manually with
//     explicit page_number/page_size.
//   • Product `price` is in the currency's lowest denomination.
//   • Static payment links (https://checkout.dodopayments.com/buy/{id}) accept
//     no discount parameter; only a Checkout Session (POST /checkouts with
//     `discount_codes`) pre-applies a code.
//   • Webhooks follow Standard Webhooks (https://www.standardwebhooks.com):
//     `webhook-id` / `webhook-timestamp` / `webhook-signature` headers, HMAC-SHA256
//     over `${id}.${timestamp}.${rawBody}`, base64, `v1,` tokens, `whsec_<base64>`
//     secret, 5-minute tolerance. Verified by lib/standard-webhooks ('whsec' mode).
//   • DELETE /webhooks/{id} documents "200 Webhook has been deleted" with no body.
//   • payment.succeeded `data` is a Payment: `payment_id`, `total_amount`
//     ("including tax, in the currency's smallest unit (e.g. cents for USD, yen
//     for JPY, fils for KWD)"), `tax`, `currency`, `discounts[]` ("All stacked
//     discounts applied, ordered by position", each with `code`, `discount_id`),
//     deprecated `discount_id`, `charge_type` (new | renewal | plan_change |
//     on_demand; null "when this payment charges no subscription"),
//     `is_update_payment_method`.

import DodoPayments from 'dodopayments';
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
import { verifyStandardWebhook } from '../../lib/standard-webhooks';

const DODO_API_LIVE = 'https://live.dodopayments.com';
const DODO_API_TEST = 'https://test.dodopayments.com';

/** list-discounts / get-products: page_size max = 100. */
const PAGE_SIZE = 100;
/** Hard stop for runaway pagination (10,000 items). */
const MAX_PAGES = 100;

/** create-discount: code "Must be at least 3 characters"; response code "up to 16 chars". */
const CODE_MIN_LENGTH = 3;
const CODE_MAX_LENGTH = 16;

// Currencies with no minor unit: the integer amount is already the major unit.
// Dodo's changelog v1.105.0 counts 16 zero-decimal currencies and names JPY,
// KRW, VND, CLP, XAF and XOF; the other ten are the ISO 4217 zero-decimal set.
const ZERO_DECIMAL_CURRENCIES = new Set([
  'JPY', 'KRW', 'CLP', 'VND', 'UGX', 'MGA', 'BIF', 'GNF', 'PYG', 'RWF', 'XOF', 'XAF', 'KMF', 'DJF', 'VUV', 'XPF',
]);
// Three-decimal currencies (ISO 4217), all in Dodo's Currency enum. Dodo
// documents "fils for KWD" as the smallest unit.
const THREE_DECIMAL_CURRENCIES = new Set(['BHD', 'IQD', 'JOD', 'KWD', 'LYD', 'OMR', 'TND']);

/** charge_type values that represent a first purchase (null = no subscription). */
const FIRST_PURCHASE_CHARGE_TYPES = new Set<unknown>([null, undefined, 'new']);

interface DodoCheckoutSession {
  session_id: string;
  checkout_url: string | null;
}

interface NotFoundTarget {
  resource: string;
  id: string;
}

export class DodoProvider implements PaymentProvider {
  readonly name = 'dodopayments';
  private client: DodoPayments;
  private environment: 'live' | 'test';
  private apiKey: string;
  private baseUrl: string;

  constructor(config: ProviderConfig) {
    this.environment = config.environment === 'test' ? 'test' : 'live';
    this.apiKey = config.apiKey;
    this.baseUrl = this.environment === 'test' ? DODO_API_TEST : DODO_API_LIVE;
    this.client = new DodoPayments({
      bearerToken: config.apiKey,
      environment: this.environment === 'live' ? 'live_mode' : 'test_mode',
      // Route SDK traffic through the runtime's global fetch, resolved per call.
      // SDK 2.x defaults to the global fetch it finds at construction, so in
      // production this changes nothing; resolving it per call lets tests stub
      // fetch after a client exists.
      fetch: (url, init) => globalThis.fetch(url as RequestInfo, init as RequestInit),
    });
  }

  async createDiscount(params: CreateDiscountParams): Promise<ProviderDiscount> {
    if (params.discountType !== 'percentage') {
      throw new ProviderError(
        this.name,
        'createDiscount',
        'GoPayLocal creates only percentage discounts on Dodo Payments',
      );
    }
    if (params.code.length < CODE_MIN_LENGTH || params.code.length > CODE_MAX_LENGTH) {
      throw new ProviderError(
        this.name,
        'createDiscount',
        `Discount code must be ${CODE_MIN_LENGTH}-${CODE_MAX_LENGTH} characters (got ${params.code.length})`,
      );
    }

    try {
      const discount = await this.client.discounts.create({
        type: 'percentage',
        // CreateDiscountParams.amount is a 0-100 percentage; Dodo expects basis points.
        amount: Math.round(params.amount * 100),
        code: params.code,
        name: params.name,
        ...(params.expiresAt ? { expires_at: params.expiresAt } : {}),
        ...(params.maxRedemptions ? { usage_limit: params.maxRedemptions } : {}),
        ...(params.productIds && params.productIds.length > 0
          ? { restricted_to: params.productIds }
          : {}),
      });

      return {
        providerDiscountId: discount.discount_id,
        code: discount.code,
        discountPercent: discount.amount / 100,
        provider: this.name,
      };
    } catch (err) {
      throw this.handleError('createDiscount', err);
    }
  }

  async deleteDiscount(discountId: string): Promise<void> {
    try {
      await this.client.discounts.delete(discountId);
    } catch (err) {
      // 404: "Discount not found or already deleted".
      throw this.handleError('deleteDiscount', err, { resource: 'discount', id: discountId });
    }
  }

  async listDiscounts(): Promise<ProviderDiscount[]> {
    try {
      const discounts = await this.listAllPages((page_number) =>
        this.client.discounts.list({ page_number, page_size: PAGE_SIZE }),
      );
      // Contract: only discounts that can still be redeemed. Deleted ones are
      // gone from the list; expired ones (`expires_at` passed) are not.
      const now = Date.now();
      return discounts
        .filter((discount) => !discount.expires_at || !(Date.parse(discount.expires_at) <= now))
        .map((discount) => ({
        providerDiscountId: discount.discount_id,
        code: discount.code,
        // `amount` is basis points for percentage discounts.
        discountPercent: discount.type === 'percentage' ? discount.amount / 100 : 0,
        provider: this.name,
      }));
    } catch (err) {
      throw this.handleError('listDiscounts', err);
    }
  }

  async listProducts(): Promise<ProviderProduct[]> {
    try {
      const products = await this.listAllPages((page_number) =>
        this.client.products.list({ page_number, page_size: PAGE_SIZE }),
      );
      return products.map((product) => {
        const currency = product.currency ?? 'USD';
        const rawPrice = product.price ?? null;
        return {
          providerProductId: product.product_id,
          name: product.name ?? '',
          price: rawPrice != null ? toMajorUnits(rawPrice, currency) : null,
          currency,
          url: this.staticPaymentLink(product.product_id),
        };
      });
    } catch (err) {
      throw this.handleError('listProducts', err);
    }
  }

  async buildCheckoutUrl(params: CheckoutUrlParams): Promise<string> {
    // A Checkout Session is required to pre-apply the PPP discount: static
    // payment links accept no discount param.
    try {
      const body: Record<string, unknown> = {
        product_cart: [{ product_id: params.productId, quantity: 1 }],
      };
      // `discount_codes` (max 20, stacked); the singular `discount_code` is deprecated.
      if (params.discountCode) body.discount_codes = [params.discountCode];
      if (params.successUrl) body.return_url = params.successUrl;
      if (params.cancelUrl) body.cancel_url = params.cancelUrl;
      if (params.customerEmail) body.customer = { email: params.customerEmail };
      if (params.metadata) body.metadata = params.metadata;

      const session = await this.request<DodoCheckoutSession>('POST', '/checkouts', body);

      // checkout_url is nullable ("None when payment_method_id is provided").
      if (!session?.checkout_url) {
        throw new ProviderError(this.name, 'buildCheckoutUrl', 'No checkout URL returned');
      }
      return session.checkout_url;
    } catch (err) {
      throw this.handleError('buildCheckoutUrl', err);
    }
  }

  // ── Webhooks ──────────────────────────────────────────────────────────────

  async provisionWebhook(
    callbackUrl: string,
  ): Promise<{ endpointId: string; secret: string | null }> {
    // The create response (WebhookDetails) carries no signing secret; it is
    // fetched separately.
    const endpoint = await this.request<{ id?: string }>('POST', '/webhooks', {
      url: callbackUrl,
      filter_types: ['payment.succeeded'],
    });
    const endpointId = endpoint?.id;
    if (!endpointId) {
      throw new ProviderError(this.name, 'provisionWebhook', 'No webhook id returned');
    }

    try {
      const { secret } = await this.request<{ secret?: string }>(
        'GET',
        `/webhooks/${encodeURIComponent(endpointId)}/secret`,
        null,
        'webhook',
      );
      if (!secret) {
        throw new ProviderError(this.name, 'provisionWebhook', 'No signing secret returned');
      }
      return { endpointId, secret };
    } catch (err) {
      // Without the secret every delivery would fail verification and Dodo would
      // keep retrying into a dead endpoint, so remove the one we just created.
      await this.request('DELETE', `/webhooks/${encodeURIComponent(endpointId)}`, null).catch(
        () => {},
      );
      throw err;
    }
  }

  async deleteWebhook(endpointId: string): Promise<void> {
    await this.request('DELETE', `/webhooks/${encodeURIComponent(endpointId)}`, null, 'webhook');
  }

  async verifyWebhook(input: WebhookVerifyInput): Promise<boolean> {
    if (!input.secret) return false;
    return verifyStandardWebhook(
      input.rawBody,
      {
        id: input.headers.get('webhook-id'),
        timestamp: input.headers.get('webhook-timestamp'),
        signature: input.headers.get('webhook-signature'),
      },
      input.secret,
      'whsec',
    );
  }

  parseRedemption(rawBody: string): RedemptionEvent | null {
    let evt: unknown;
    try {
      evt = JSON.parse(rawBody);
    } catch {
      return null;
    }
    if (!isRecord(evt) || evt.type !== 'payment.succeeded' || !isRecord(evt.data)) return null;
    const data = evt.data;

    // payment_id is the idempotency key handleRedemption dedupes on.
    const paymentId = nonEmptyString(data.payment_id);
    if (!paymentId) return null;

    // Count the first purchase only. A code created without subscription_cycles
    // applies "indefinitely to all recurring payments", so every renewal,
    // plan change and on-demand charge carries it again.
    if (!FIRST_PURCHASE_CHARGE_TYPES.has(data.charge_type)) return null;
    if (data.is_update_payment_method === true) return null;

    // discounts[] is "ordered by position"; position 0 is the first applied code.
    const stacked = Array.isArray(data.discounts) ? data.discounts.filter(isRecord) : [];
    const primary = stacked.find((d) => d.position === 0) ?? stacked[0];
    const code = nonEmptyString(primary?.code);
    const providerCouponId =
      nonEmptyString(primary?.discount_id) ?? nonEmptyString(data.discount_id);
    // The other stacked codes, in position order: a GoPayLocal code applied
    // after the merchant's own one must still be found by the shared handler.
    const otherDiscounts: RedemptionDiscount[] = stacked
      .filter((s) => s !== primary)
      .sort((a, b) => Number(a.position ?? 0) - Number(b.position ?? 0))
      .map((s) => ({
        code: nonEmptyString(s.code),
        providerCouponId: nonEmptyString(s.discount_id),
        providerPromoCodeId: null,
      }))
      .filter((s) => s.code || s.providerCouponId);
    if (!code && !providerCouponId && otherDiscounts.length === 0) return null;

    // Payment (https://docs.dodopayments.com/api-reference/payments/get-payments-1):
    // total_amount "Total amount charged to the customer including tax, in the
    // currency's smallest unit"; tax "Amount of tax collected in the currency's
    // smallest unit" (nullable). total − tax is the pre-tax amount paid whether
    // the product's price was tax-inclusive or not. A null tax is "not
    // reported", so no savings are back-calculated for that payment.
    const total = typeof data.total_amount === 'number' ? data.total_amount : null;
    const tax = typeof data.tax === 'number' ? data.tax : null;

    return {
      eventId: paymentId,
      code,
      providerCouponId,
      providerPromoCodeId: null,
      chargedAmountCents: total,
      taxAmountCents: tax,
      // discounts[].amount is in basis points (a percent), not money; the
      // handler back-calculates from the pre-tax amount and the coupon percent.
      discountAmountCents: null,
      currency: typeof data.currency === 'string' ? data.currency : null,
      ...(otherDiscounts.length > 0 ? { otherDiscounts } : {}),
    };
  }

  // ── Internal Helpers ────────────────────────────────────────────────────

  /** Hosted static payment-link URL for a product, environment-aware. */
  private staticPaymentLink(productId: string): string {
    const host =
      this.environment === 'test'
        ? 'https://test.checkout.dodopayments.com'
        : 'https://checkout.dodopayments.com';
    return `${host}/buy/${encodeURIComponent(productId)}`;
  }

  /** Walk 0-based pages explicitly; stop on the first short page. */
  private async listAllPages<T>(
    fetchPage: (pageNumber: number) => PromiseLike<{ getPaginatedItems(): T[] }>,
  ): Promise<T[]> {
    const all: T[] = [];
    for (let page = 0; page < MAX_PAGES; page++) {
      const items = (await fetchPage(page)).getPaginatedItems();
      all.push(...items);
      if (items.length < PAGE_SIZE) return all;
    }
    // Refuse to return a silently truncated list (a sync would read it as deletions).
    throw new ProviderError(this.name, 'list', `More than ${MAX_PAGES * PAGE_SIZE} items`);
  }

  /** Raw REST call for /checkouts and /webhooks (SDK 0.24.0 lacked them). */
  private async request<T>(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    body: Record<string, unknown> | null,
    resource = 'resource',
  ): Promise<T> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      Accept: 'application/json',
    };
    const init: RequestInit = { method, headers };
    if (body && method === 'POST') {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }

    const response = await fetch(`${this.baseUrl}${path}`, init);
    const text = await response.text().catch(() => '');
    let parsed: unknown = undefined;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = undefined;
      }
    }

    if (!response.ok) {
      const errorBody = isRecord(parsed) ? parsed : {};
      const code = nonEmptyString(errorBody.code) ?? undefined;
      const message =
        nonEmptyString(errorBody.message) ??
        nonEmptyString(errorBody.error) ??
        nonEmptyString(errorBody.detail) ??
        `HTTP ${response.status}`;

      if (response.status === 401 || response.status === 403) {
        throw new ProviderAuthError(this.name, code ? `${code}: ${message}` : message);
      }
      if (response.status === 404) {
        throw new ProviderNotFoundError(this.name, resource, path);
      }
      throw new ProviderError(this.name, `${method} ${path}`, message, response.status, code);
    }

    if (parsed === undefined && text) {
      throw new ProviderError(
        this.name,
        `${method} ${path}`,
        'Response was not valid JSON',
        response.status,
      );
    }
    // 204 and documented empty-body 200s (DELETE /webhooks/{id}) resolve to {}.
    return (parsed ?? {}) as T;
  }

  private handleError(operation: string, err: unknown, notFound?: NotFoundTarget): ProviderError {
    if (err instanceof ProviderError) return err;

    const message = err instanceof Error ? err.message : String(err);
    // SDK APIError carries `status` and the parsed body as `error` ({ code, message }).
    const status =
      (err as { status?: number; statusCode?: number })?.status ??
      (err as { status?: number; statusCode?: number })?.statusCode;
    const apiError = (err as { error?: unknown })?.error;
    const code = isRecord(apiError) ? (nonEmptyString(apiError.code) ?? undefined) : undefined;

    if (status === 401 || status === 403) {
      return new ProviderAuthError(this.name, code ? `${code}: ${message}` : message);
    }
    if (status === 404 && notFound) {
      return new ProviderNotFoundError(this.name, notFound.resource, notFound.id);
    }
    return new ProviderError(this.name, operation, message, status, code);
  }
}

function toMajorUnits(amount: number, currency: string): number {
  const c = currency.toUpperCase();
  if (ZERO_DECIMAL_CURRENCIES.has(c)) return amount;
  if (THREE_DECIMAL_CURRENCIES.has(c)) return amount / 1000;
  return amount / 100;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}
