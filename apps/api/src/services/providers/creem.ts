// ── Creem Provider ──────────────────────────────────────────────────────────
// A merchant's Creem store (creem.io, merchant of record), used for PPP
// discount codes and redemption tracking. Raw REST with fetch; no SDK.
//
// Sources (official Creem docs, fetched 2026-11-18; the endpoint pages render
// https://docs.creem.io/api-reference/openapi.json):
//   API basics      https://docs.creem.io/api-reference/introduction
//   Errors          https://docs.creem.io/api-reference/error-codes
//   Test mode       https://docs.creem.io/getting-started/test-mode
//   Discounts       https://docs.creem.io/features/discounts
//                   https://docs.creem.io/api-reference/endpoint/create-discount-code
//                   https://docs.creem.io/api-reference/endpoint/delete-discount-code
//                   https://docs.creem.io/api-reference/endpoint/search-discounts
//                   https://docs.creem.io/getting-started/migrate/lemon-squeezy/technical-guide
//   Products        https://docs.creem.io/api-reference/endpoint/search-products
//   Checkouts       https://docs.creem.io/api-reference/endpoint/create-checkout
//   Webhooks        https://docs.creem.io/code/webhooks
//                   https://docs.creem.io/api-reference/endpoint/create-webhook
//                   https://docs.creem.io/api-reference/endpoint/get-webhook-secret
//                   https://docs.creem.io/api-reference/endpoint/delete-webhook
//   Key prefix      https://docs.creem.io/integrations/linkjolt
//
// Facts the code depends on:
//   • Hosts: https://api.creem.io (production) and https://test-api.creem.io
//     (test mode), paths under /v1. The caller picks the host; "Test mode API
//     keys only work with test-api.creem.io, and production keys only work with
//     api.creem.io". Test keys start with `creem_test_` (no distinct live prefix
//     is documented), so a test key in the live slot is refused locally.
//   • Auth: `x-api-key: <key>`. Errors are JSON `{trace_id, status, error,
//     message: string[], timestamp}`; 401 = missing key, 403 = invalid key or
//     insufficient permissions, 404 = not found, 400 = validation/duplicate.
//   • POST /v1/discounts requires `name`, `type`, `duration` and
//     `applies_to_products`. A percentage discount uses `percentage`; expiry is
//     `expiry_date`, the cap `max_redemptions`. "A Lemon Squeezy code that applies
//     to everything must list every Creem product, and products you create later
//     aren't covered": with no productIds we scope to every ACTIVE product.
//     Codes are unique per store ("The code has already been taken"). The docs
//     state no charset/length rule (every documented example is upper-case
//     letters and digits), so lib/coupon-code.ts generates letters and digits
//     only for Creem (PPPIN40K7QX); a live run confirms they're accepted. Fixed
//     discounts are not created here: the docs disagree on whether `amount` is
//     cents or major units.
//   • DELETE /v1/discounts/{id}/delete → 200 DiscountEntity.
//   • DiscountEntity (OAS): `status` is deleted | active | draft | expired |
//     scheduled; `expiry_date` (date-time), `max_redemptions`, `redeem_count`.
//   • GET /v1/discounts/search and GET /v1/products/search page with
//     `page_number` (default 1) and `page_size` (default 10, no documented
//     maximum, so the default is used) and return `{items, pagination}` where
//     `pagination.next_page` is null on the last page. Both take `status=active`.
//   • ProductEntity: `price` in cents, `currency` (USD or EUR), `product_url`.
//   • POST /v1/checkouts: `product_id` (required), `discount_code`,
//     `success_url`, `customer {email}`, `metadata` → `checkout_url`. There is no
//     cancel-URL field and no discount-id field.
//   • POST /v1/webhooks `{url, name, delivery_mode, events}` returns `id` and
//     `secret` ("Only returned when the endpoint is created");
//     GET /v1/webhooks/{id}/secret returns `{secret}`; DELETE /v1/webhooks/{id}.
//   • Signatures: header `creem-signature` = hex HMAC-SHA256 of the raw body,
//     keyed with the webhook secret string. The scheme has NO timestamp, so it
//     cannot reject replays; dedupe on the order id makes a replay harmless.
//   • Redemptions: `checkout.completed` (one per completed checkout; renewals
//     come as `subscription.paid`, which we don't subscribe to). `object.order`
//     carries `id`, `status` (pending | paid), `amount_paid` ("what the customer
//     was charged"), `tax_amount`, `discount_amount` ("the amount taken off the
//     price"), `discount` (discount id) and `currency`, all in cents.
//     `object.discount` is `{id, discountCode, ...}`. `object.product.tax_mode`:
//     "inclusive" = tax is included in the price, "exclusive" = added on top.

import type {
  PaymentProvider,
  CreateDiscountParams,
  CheckoutUrlParams,
  ProviderDiscount,
  ProviderProduct,
  ProviderConfig,
  WebhookVerifyInput,
  RedemptionEvent,
  ProvisionedWebhook,
} from './types';
import { ProviderError, ProviderAuthError, ProviderNotFoundError } from './types';
import { hmacSha256Hex, timingSafeEqual } from '../../lib/webhook-verify';
import { minorToMajor } from '../../lib/currency';

const CREEM_API_LIVE = 'https://api.creem.io';
const CREEM_API_TEST = 'https://test-api.creem.io';

/** search-discounts / search-products: documented default page size. */
const PAGE_SIZE = 10;
/** Hard stop for runaway pagination (1,000 items). */
const MAX_PAGES = 100;

const TEST_KEY_PREFIX = 'creem_test_';

/** The one event that marks a first purchase (renewals arrive as subscription.paid). */
const REDEMPTION_EVENT = 'checkout.completed';

/** Label of the endpoint GoPayLocal creates in the merchant's store. */
const WEBHOOK_NAME = 'GoPayLocal';

/** Lowercase hex SHA-256 digest. */
const HEX_SHA256 = /^[0-9a-f]{64}$/;

interface CreemDiscount {
  id: string;
  status?: string;
  name?: string;
  code?: string;
  type?: 'percentage' | 'fixed';
  amount?: number;
  percentage?: number;
  expiry_date?: string | null;
  max_redemptions?: number | null;
  redeem_count?: number | null;
}

interface CreemProduct {
  id: string;
  name?: string;
  price?: number | null;
  currency?: string | null;
  product_url?: string | null;
  status?: string;
}

interface CreemList<T> {
  items?: T[];
  pagination?: { next_page?: number | null } | null;
}

interface NotFoundTarget {
  resource: string;
  id: string;
}

export class CreemProvider implements PaymentProvider {
  readonly name = 'creem';
  private apiKey: string;
  private environment: 'live' | 'test';
  private baseUrl: string;

  constructor(config: ProviderConfig) {
    this.apiKey = config.apiKey;
    this.environment = config.environment === 'test' ? 'test' : 'live';
    this.baseUrl = this.environment === 'test' ? CREEM_API_TEST : CREEM_API_LIVE;
  }

  async createDiscount(params: CreateDiscountParams): Promise<ProviderDiscount> {
    if (params.discountType !== 'percentage') {
      throw new ProviderError(
        this.name,
        'createDiscount',
        'GoPayLocal creates only percentage discounts on Creem',
      );
    }
    // An empty code makes Creem generate one; the banner must show the code we chose.
    if (!params.code.trim()) {
      throw new ProviderError(this.name, 'createDiscount', 'A discount code is required');
    }

    try {
      const productIds =
        params.productIds && params.productIds.length > 0
          ? params.productIds
          : await this.activeProductIds();
      if (productIds.length === 0) {
        throw new ProviderError(
          this.name,
          'createDiscount',
          'Creem discounts must name the products they apply to, and this store has no active products',
        );
      }

      const body: Record<string, unknown> = {
        name: params.name,
        code: params.code,
        type: 'percentage',
        percentage: params.amount,
        // PPP discounts are permanent, like the Stripe/Polar/Chargebee/Whop adapters.
        duration: 'forever',
        applies_to_products: productIds,
      };
      if (params.expiresAt) body.expiry_date = params.expiresAt;
      if (params.maxRedemptions) body.max_redemptions = params.maxRedemptions;

      const discount = await this.request<CreemDiscount>('POST', '/v1/discounts', body);
      if (!nonEmptyString(discount?.id)) {
        throw new ProviderError(this.name, 'createDiscount', 'No discount id returned');
      }

      return {
        providerDiscountId: discount.id,
        // Creem's stored code is what checkout accepts.
        code: nonEmptyString(discount.code) ?? params.code,
        discountPercent: percentOf(discount) ?? params.amount,
        provider: this.name,
      };
    } catch (err) {
      throw this.handleError('createDiscount', err);
    }
  }

  async deleteDiscount(discountId: string): Promise<void> {
    try {
      await this.request(
        'DELETE',
        `/v1/discounts/${encodeURIComponent(discountId)}/delete`,
        null,
        { resource: 'discount', id: discountId },
      );
    } catch (err) {
      throw this.handleError('deleteDiscount', err);
    }
  }

  async listDiscounts(): Promise<ProviderDiscount[]> {
    try {
      const discounts = await this.listAll<CreemDiscount>('/v1/discounts/search', { status: 'active' });
      // Creem discounts carry no metadata to tag ours with, so every active
      // discount is listed (as the Dodo adapter does). Only codes that can
      // still be redeemed are returned: the status check repeats the
      // server-side filter, and a past expiry_date or a used-up
      // max_redemptions also reads as gone, in case the status lags.
      const now = Date.now();
      return discounts
        .filter((d) => nonEmptyString(d?.id) && isRedeemable(d, now))
        .map((d) => ({
          providerDiscountId: d.id,
          code: d.code ?? '',
          discountPercent: percentOf(d) ?? 0,
          provider: this.name,
        }));
    } catch (err) {
      throw this.handleError('listDiscounts', err);
    }
  }

  async listProducts(): Promise<ProviderProduct[]> {
    try {
      const products = await this.listAll<CreemProduct>('/v1/products/search', { status: 'active' });
      return products
        .filter((p) => nonEmptyString(p?.id))
        .map((p) => {
          const currency = nonEmptyString(p.currency);
          return {
            providerProductId: p.id,
            name: p.name ?? '',
            // `price` is in cents; Creem prices in USD or EUR (two decimals).
            price:
              typeof p.price === 'number' && Number.isFinite(p.price)
                ? minorToMajor(p.price, currency ?? 'USD')
                : null,
            currency,
            url: nonEmptyString(p.product_url),
          };
        });
    } catch (err) {
      throw this.handleError('listProducts', err);
    }
  }

  /**
   * `params.productId` is a Creem Product id (`prod_...`), sent as `product_id`
   * to POST /v1/checkouts. Returns the session's `checkout_url`.
   */
  async buildCheckoutUrl(params: CheckoutUrlParams): Promise<string> {
    try {
      // Creem applies a discount at checkout by code only (no discount-id
      // field), and has no cancel URL.
      const body: Record<string, unknown> = { product_id: params.productId };
      if (params.discountCode) body.discount_code = params.discountCode;
      if (params.successUrl) body.success_url = params.successUrl;
      if (params.customerEmail) body.customer = { email: params.customerEmail };
      if (params.metadata) body.metadata = params.metadata;

      const checkout = await this.request<{ checkout_url?: string }>('POST', '/v1/checkouts', body);
      const url = nonEmptyString(checkout?.checkout_url);
      if (!url) {
        throw new ProviderError(this.name, 'buildCheckoutUrl', 'No checkout URL returned');
      }
      return url;
    } catch (err) {
      throw this.handleError('buildCheckoutUrl', err);
    }
  }

  // ── Webhooks ──────────────────────────────────────────────────────────────

  /** Always creates a new endpoint (never reuses one), so `adopted` is not set. */
  async provisionWebhook(callbackUrl: string): Promise<ProvisionedWebhook> {
    let endpointId: string | null = null;
    try {
      const endpoint = await this.request<{ id?: string; secret?: string }>('POST', '/v1/webhooks', {
        url: callbackUrl,
        name: WEBHOOK_NAME,
        delivery_mode: 'http',
        // Only first purchases count; an empty list would mean every event.
        events: [REDEMPTION_EVENT],
      });
      endpointId = nonEmptyString(endpoint?.id);
      if (!endpointId) {
        throw new ProviderError(this.name, 'provisionWebhook', 'No webhook id returned');
      }

      // The create response is documented to carry the secret; read it back if not.
      let secret = nonEmptyString(endpoint.secret);
      if (!secret) {
        const read = await this.request<{ secret?: string }>(
          'GET',
          `/v1/webhooks/${encodeURIComponent(endpointId)}/secret`,
          null,
          { resource: 'webhook', id: endpointId },
        );
        secret = nonEmptyString(read?.secret);
      }
      if (!secret) {
        throw new ProviderError(this.name, 'provisionWebhook', 'No signing secret returned');
      }
      return { endpointId, secret };
    } catch (err) {
      // Without the secret every delivery would fail verification while Creem
      // kept retrying, so remove the endpoint we just created.
      if (endpointId) {
        await this.request('DELETE', `/v1/webhooks/${encodeURIComponent(endpointId)}`, null).catch(
          () => {},
        );
      }
      throw this.handleError('provisionWebhook', err);
    }
  }

  async deleteWebhook(endpointId: string): Promise<void> {
    try {
      await this.request('DELETE', `/v1/webhooks/${encodeURIComponent(endpointId)}`, null, {
        resource: 'webhook',
        id: endpointId,
      });
    } catch (err) {
      throw this.handleError('deleteWebhook', err);
    }
  }

  async verifyWebhook(input: WebhookVerifyInput): Promise<boolean> {
    if (!input.secret) return false;
    const received = input.headers.get('creem-signature')?.trim().toLowerCase();
    if (!received || !HEX_SHA256.test(received)) return false;
    // HMAC key = the secret string as given (the docs' createHmac('sha256', secret)).
    const expected = await hmacSha256Hex(input.secret, input.rawBody);
    return timingSafeEqual(expected, received);
  }

  parseRedemption(rawBody: string): RedemptionEvent | null {
    let evt: unknown;
    try {
      evt = JSON.parse(rawBody);
    } catch {
      return null;
    }
    if (!isRecord(evt) || evt.eventType !== REDEMPTION_EVENT || !isRecord(evt.object)) return null;
    const checkout = evt.object;
    const order = isRecord(checkout.order) ? checkout.order : null;
    if (!order) return null;

    // OrderStatus is pending | paid; only a paid order is a redemption.
    if (order.status !== undefined && order.status !== 'paid') return null;

    const discount = isRecord(checkout.discount) ? checkout.discount : null;
    const code = nonEmptyString(discount?.discountCode);
    const providerCouponId = nonEmptyString(order.discount) ?? nonEmptyString(discount?.id);
    if (!code && !providerCouponId) return null; // no discount applied

    // The order id, not the event id: a manual resend from the dashboard gets
    // a new event id, but it is the same order.
    const eventId = nonEmptyString(order.id) ?? nonEmptyString(checkout.id);
    if (!eventId) return null;

    const product = isRecord(checkout.product) ? checkout.product : null;
    // discount_amount is "the amount taken off the price". Exclusive tax is
    // added on top of the price, so the discount is pre-tax; an inclusive
    // price contains the tax, so its discount does too and can't be split
    // here (contract C3: null, the handler back-calculates from the pre-tax paid).
    const discountAmountCents =
      product?.tax_mode === 'exclusive' ? finiteNumber(order.discount_amount) : null;

    return {
      eventId,
      code,
      providerCouponId,
      providerPromoCodeId: null,
      chargedAmountCents: finiteNumber(order.amount_paid),
      taxAmountCents: finiteNumber(order.tax_amount),
      discountAmountCents,
      currency: nonEmptyString(order.currency),
    };
  }

  // ── Internal Helpers ────────────────────────────────────────────────────

  /** Ids of every active product: the scope of an "all products" discount. */
  private async activeProductIds(): Promise<string[]> {
    const products = await this.listAll<CreemProduct>('/v1/products/search', { status: 'active' });
    return products
      .filter((p) => nonEmptyString(p?.id) && (p.status === undefined || p.status === 'active'))
      .map((p) => p.id);
  }

  /**
   * Walk 1-based pages by `pagination.next_page` until it is null. Never
   * returns a silently truncated list: coupon sync reads absence as deletion.
   */
  private async listAll<T>(path: string, filters: Record<string, string>): Promise<T[]> {
    const all: T[] = [];
    let page = 1;
    for (let i = 0; i < MAX_PAGES; i++) {
      const qs = new URLSearchParams({
        ...filters,
        page_number: String(page),
        page_size: String(PAGE_SIZE),
      });
      const res = await this.request<CreemList<T>>('GET', `${path}?${qs.toString()}`, null);
      const items = Array.isArray(res?.items) ? res.items : [];
      all.push(...items);

      const pagination = isRecord(res?.pagination) ? res.pagination : null;
      if (!pagination) {
        // Not the documented shape: fall back to "a short page is the last".
        if (items.length < PAGE_SIZE) return all;
        page++;
        continue;
      }
      const next = pagination.next_page;
      if (next === null || next === undefined) return all;
      if (typeof next !== 'number' || !Number.isInteger(next) || next <= page) {
        throw new ProviderError(this.name, 'list', `Unexpected pagination.next_page ${String(next)} after page ${page}`);
      }
      page = next;
    }
    throw new ProviderError(this.name, 'list', `More than ${MAX_PAGES * PAGE_SIZE} items`);
  }

  private async request<T>(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    body: Record<string, unknown> | null,
    notFound?: NotFoundTarget,
  ): Promise<T> {
    if (this.environment === 'live' && this.apiKey.startsWith(TEST_KEY_PREFIX)) {
      // Creem would answer 403; say why instead.
      throw new ProviderAuthError(
        this.name,
        'This is a Creem test-mode key (creem_test_...). Save it as the test key, or use a live key here.',
      );
    }

    const headers: Record<string, string> = {
      'x-api-key': this.apiKey,
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
      const message = errorMessage(parsed, response.status);
      if (response.status === 401 || response.status === 403) {
        throw new ProviderAuthError(this.name, message);
      }
      if (response.status === 404) {
        throw new ProviderNotFoundError(this.name, notFound?.resource ?? 'resource', notFound?.id ?? path);
      }
      throw new ProviderError(this.name, `${method} ${path.split('?')[0]}`, message, response.status);
    }

    if (parsed === undefined && text) {
      throw new ProviderError(this.name, `${method} ${path.split('?')[0]}`, 'Response was not valid JSON', response.status);
    }
    return (parsed ?? {}) as T;
  }

  /** Normalise any thrown value into a ProviderError, preserving subtypes. */
  private handleError(operation: string, err: unknown): ProviderError {
    if (err instanceof ProviderError) return err;
    const message = err instanceof Error ? err.message : String(err);
    return new ProviderError(this.name, operation, message);
  }
}

/** `{message: string[] | string, error, trace_id}` → one readable line. */
function errorMessage(body: unknown, status: number): string {
  const b = isRecord(body) ? body : {};
  const parts = Array.isArray(b.message)
    ? b.message.filter((m): m is string => typeof m === 'string' && m.length > 0)
    : typeof b.message === 'string' && b.message
      ? [b.message]
      : [];
  const text = parts.length > 0 ? parts.join('; ') : (nonEmptyString(b.error) ?? `HTTP ${status}`);
  const traceId = nonEmptyString(b.trace_id);
  return traceId ? `${text} (trace_id ${traceId})` : text;
}

/** A percentage discount's percent (`percentage`, else `amount`), or null. */
function percentOf(d: CreemDiscount): number | null {
  if (d.type !== undefined && d.type !== 'percentage') return null;
  return finiteNumber(d.percentage) ?? (d.type === 'percentage' ? finiteNumber(d.amount) : null);
}

/**
 * Whether a listed discount can still be redeemed: status active (or absent),
 * expiry_date not passed, and redeem_count below max_redemptions when a cap is
 * set. An unparseable expiry_date is not treated as expired.
 */
function isRedeemable(d: CreemDiscount, now: number): boolean {
  if (d.status !== undefined && d.status !== 'active') return false;
  const expiry = nonEmptyString(d.expiry_date);
  if (expiry !== null) {
    const expires = Date.parse(expiry);
    if (Number.isFinite(expires) && expires <= now) return false;
  }
  const cap = finiteNumber(d.max_redemptions);
  const used = finiteNumber(d.redeem_count);
  if (cap !== null && cap > 0 && used !== null && used >= cap) return false;
  return true;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}
