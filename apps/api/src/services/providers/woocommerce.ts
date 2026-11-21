// ── WooCommerce Provider ────────────────────────────────────────────────────
// Integration with WooCommerce stores for PPP discount management.
//
// WooCommerce has no central API host: each merchant's REST API lives on their
// own store, so this adapter sends requests carrying the merchant's consumer
// key and secret to a URL the merchant typed in. The rules for that URL are in
// packages/shared/src/validation/woocommerce.ts (applied by the connect route
// and again here). This file adds the request-level guards: credentials go only
// to the validated store origin, over HTTPS, in the Authorization header (never
// a query string); redirects are never followed; every response is bounded in
// time and size; and no response body is ever copied into an error message
// (ProviderError messages are shown to merchants and stored in health issues).
//
// Facts the code depends on (WooCommerce 11.3.0, the current release on
// 2026-11-18; docs at https://developer.woocommerce.com/docs/apis/rest-api/,
// source at github.com/woocommerce/woocommerce/blob/11.3.0/plugins/woocommerce/):
//
//  Requirements and auth
//   - REST API v3 needs WooCommerce 3.5+, WordPress 4.4+ and pretty permalinks
//     ("default permalinks will not work"). Base path /wp-json/wc/v3.
//     https://developer.woocommerce.com/docs/apis/rest-api/ (Requirements)
//   - Over HTTPS: HTTP Basic, consumer key as user name, consumer secret as
//     password. The store only tries Basic auth when it sees HTTPS
//     (includes/class-wc-rest-authentication.php `authenticate`: `if ( is_ssl() )`).
//     https://developer.woocommerce.com/docs/apis/rest-api/authentication
//   - Some servers drop the Authorization header (FastCGI); the docs' fallback
//     is query-string credentials, which this adapter never uses, so the 401
//     message names the server as a possible cause instead.
//     https://developer.woocommerce.com/docs/apis/rest-api/ ("Consumer key is missing")
//   - GET needs a key with read or read_write permission; POST/PUT/DELETE need
//     write or read_write, otherwise 401 woocommerce_rest_authentication_error
//     (`check_permissions`). The key's user must have manage_woocommerce for
//     webhooks (wc-rest-functions.php `wc_rest_check_manager_permissions`).
//   - Errors are JSON {code, message, data:{status}}.
//     https://developer.woocommerce.com/docs/apis/rest-api/ (Errors)
//   - Lists take page / per_page (max 100: Version3/class-wc-rest-crud-controller.php
//     `get_collection_params`) and send X-WP-Total / X-WP-TotalPages.
//     https://developer.woocommerce.com/docs/apis/rest-api/ (Pagination)
//   - `_fields` limits the fields in a response (a WordPress global parameter).
//     https://developer.wordpress.org/rest-api/using-the-rest-api/global-parameters/#_fields
//
//  Coupons  https://developer.woocommerce.com/docs/apis/rest-api/v3/coupons
//   - POST /coupons (201): code (mandatory), discount_type `percent`, amount
//     (numeric string), individual_use, product_ids, usage_limit, date_expires,
//     description, meta_data [{key, value}].
//   - Codes pass the `woocommerce_coupon_code` filter (wc_sanitize_coupon_code +
//     wc_strtolower, includes/wc-core-functions.php) on save and on apply, so
//     the store keeps them lower case and matches them case-insensitively.
//   - An existing code: 400 woocommerce_rest_coupon_code_already_exists
//     (Version2/class-wc-rest-coupons-v2-controller.php).
//   - date_expires: an ISO 8601 string with a `Z` and no fraction is read as
//     UTC (abstract-wc-data.php `set_date_prop`); date_expires_gmt has no
//     setter and is ignored on write.
//   - DELETE /coupons/<id>?force=true deletes permanently (default: trash).
//     A missing id: 404 woocommerce_rest_shop_coupon_invalid_id.
//
//  Products  https://developer.woocommerce.com/docs/apis/rest-api/v3/products
//   - GET /products?status=publish: id, name, price ("Current product price",
//     a decimal string, "" when unset), permalink.
//   - GET /data/currencies/current: {code, name, symbol}, the store currency.
//     https://developer.woocommerce.com/docs/apis/rest-api/v3/data
//
//  Webhooks  https://developer.woocommerce.com/docs/apis/rest-api/v3/webhooks
//   - POST /webhooks: name, topic, delivery_url, secret (write-only), status.
//     Payload version for the v3 endpoint is wp_api_v3, so the body is the v3
//     order object (Version3/class-wc-rest-webhooks-controller.php).
//   - DELETE /webhooks/<id>?force=true (without force: 501
//     woocommerce_rest_trash_not_supported; a missing id: 404
//     woocommerce_rest_shop_webhook_invalid_id).
//   - Topics: order.created (woocommerce_new_order) and order.updated
//     (woocommerce_update_order, woocommerce_order_refunded,
//     woocommerce_order_refund_deleted) (class-wc-webhook.php
//     `get_default_topic_hooks`).
//   - X-WC-Webhook-Signature = base64_encode(hash_hmac('sha256', $body,
//     wp_specialchars_decode($secret, ENT_QUOTES), true)) over the exact body
//     sent (class-wc-webhook.php `generate_signature`). Our secrets are hex, so
//     wp_specialchars_decode leaves them unchanged.
//   - The body is the same JSON as GET /orders/<id>, built when the delivery
//     runs (asynchronously, through Action Scheduler), as the webhook's user.
//   - No retries. More than 5 consecutive failed deliveries disable the webhook
//     (class-wc-webhook.php `failed_delivery`).
//   - On create the store sends an unsigned ping: POST with body
//     `webhook_id=<id>` and no X-WC-Webhook-* headers, before it answers our
//     create request (`deliver_ping`; v1 controller `create_item`).
//
//  Orders  https://developer.woocommerce.com/docs/apis/rest-api/v3/orders
//   - status: pending, processing, on-hold, completed, cancelled, refunded,
//     failed, trash. Paid = processing or completed (`wc_get_is_paid_statuses`,
//     includes/wc-order-functions.php).
//   - total ("Grand total", tax included), total_tax ("Sum of all taxes"),
//     currency (ISO code), coupon_lines[] {code, discount, discount_tax}.
//     Money is a decimal string with "." (wc_format_decimal with the store's
//     decimals: Version2/class-wc-rest-orders-v2-controller.php).
//   - coupon_lines[].discount is EXCLUDING tax and discount_tax is its tax
//     (class-wc-checkout.php `create_order_coupon_lines` uses
//     get_coupon_discount_amount($code) with $ex_tax = true;
//     abstract-wc-order.php `recalculate_coupons` subtracts the tax when prices
//     include tax). coupon_lines[].code is lower case (wc_format_coupon_code).
//
//  Applying a code
//   - Customers type the code on the cart or checkout page; codes "can include
//     letters, numbers, and special characters (such as &, $, -, or @)" and
//     "aren't case-sensitive". https://woocommerce.com/document/coupon-management/
//   - Since WooCommerce 10.0.0, a shareable checkout link
//     https://<store>/checkout-link/?products=<id>:<qty>&coupon=<code> clears
//     the cart, adds the products, applies the coupon and redirects to checkout
//     (src/Blocks/Domain/Services/CheckoutLink.php; not present at 9.9.0).
//     https://woocommerce.com/document/creating-sharable-checkout-urls-in-woocommerce/
//
//  Cloudflare Workers fetch
//   - With redirect "follow", Workers forwards ALL headers, Authorization
//     included, to the redirect target even on another host; "manual" returns
//     the 3xx as-is ("error" is not implemented and throws).
//     https://developers.cloudflare.com/workers/runtime-apis/request/

import {
  normalizeWooCommerceStoreUrl,
  parseWooCommerceCredentials,
} from '@gopaylocal/shared/validation';
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
import { hmacSha256Base64, timingSafeEqual } from '../../lib/webhook-verify';
import { minorUnitExponent, normalizeCurrency } from '../../lib/currency';

const PROVIDER = 'woocommerce';
const API_PATH = '/wp-json/wc/v3';

/** Per request, headers and body. WordPress hosts can be slow; webhook creation waits for the store's ping. */
export const REQUEST_TIMEOUT_MS = 15_000;
/** Largest response body read. Lists use `_fields`, so real pages are a few KB. */
export const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
/** WordPress/WooCommerce cap per_page at 100. */
const PER_PAGE = 100;
/**
 * Listing stops with an error (never a silently truncated list: coupon sync
 * marks coupons missing from the list as deleted) beyond this many pages.
 */
export const MAX_PAGES = 50;

/** Orders in these statuses are paid (wc_get_is_paid_statuses). */
const PAID_STATUSES: ReadonlySet<string> = new Set(['processing', 'completed']);
/** Coupon meta that marks coupons GoPayLocal created. */
const META_KEY = 'gopaylocal';
const META_VALUE = 'true';
/** Both topics: an order can be created already paid (created only) or paid later (updated). */
const WEBHOOK_TOPICS = ['order.created', 'order.updated'] as const;

const ID_PATTERN = /^[1-9]\d{0,19}$/;
const SAFE_ERROR_CODE = /^[a-z0-9_]{1,80}$/;
const MEDIA_TYPE = /^[a-z0-9.+-]{1,40}\/[a-z0-9.+-]{1,60}$/i;
/** WooCommerce's ping body (class-wc-webhook.php deliver_ping). */
const PING_BODY = /^webhook_id=\d{1,20}$/;

interface WooCoupon {
  id?: unknown;
  code?: unknown;
  amount?: unknown;
  discount_type?: unknown;
  status?: unknown;
  date_expires_gmt?: unknown;
  usage_count?: unknown;
  usage_limit?: unknown;
  meta_data?: unknown;
}

interface WooProduct {
  id?: unknown;
  name?: unknown;
  price?: unknown;
  permalink?: unknown;
}

interface WooWebhook {
  id?: unknown;
}

interface WooResponse<T> {
  data: T;
  headers: Headers;
}

interface RequestOptions {
  query?: Record<string, string>;
  body?: unknown;
  /** 404 with WooCommerce's invalid-id code means "this resource doesn't exist". */
  notFound?: { resource: string; id: string; code: string };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * A WooCommerce decimal string ("19.99", "500", "1.500") → integer minor units
 * for a currency with `exponent` decimals, rounding half away from zero. Exact
 * string arithmetic, so "0.29" is 29, not 28.999…; null for anything else.
 */
export function decimalToMinor(value: unknown, exponent: number): number | null {
  let s: string;
  if (typeof value === 'string') s = value.trim();
  else if (typeof value === 'number' && Number.isFinite(value)) s = String(value);
  else return null;
  const m = /^(-?)(\d{1,15})(?:\.(\d{1,20}))?$/.exec(s);
  if (!m) return null;
  const [, sign, whole, frac = ''] = m;
  const digits = (frac + '0'.repeat(exponent + 1)).slice(0, exponent + 1);
  let minor = Number(whole + digits.slice(0, exponent));
  if (Number(digits[exponent]) >= 5) minor += 1;
  if (!Number.isSafeInteger(minor)) return null;
  return sign && minor !== 0 ? -minor : minor;
}

function randomHex(bytes: number): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, '0')).join('');
}

function toId(value: unknown): string | null {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value);
  if (typeof value === 'string' && ID_PATTERN.test(value)) return value;
  return null;
}

/** ISO date → "YYYY-MM-DDTHH:MM:SSZ", the form set_date_prop reads as UTC. */
function toWooUtcDate(iso: string): string | null {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function hasGoPayLocalMeta(meta: unknown): boolean {
  if (!Array.isArray(meta)) return false;
  return meta.some((m) => isRecord(m) && m.key === META_KEY && (m.value === META_VALUE || m.value === true));
}

/**
 * Whether the store would accept the coupon today: only `publish` coupons are
 * found by code (class-wc-coupon-data-store-cpt.php get_ids_by_code); a coupon
 * past date_expires is refused (class-wc-discounts.php
 * validate_coupon_expiry_date: time() > expiry); so is one whose usage_count
 * reached usage_limit (validate_coupon_usage_limit).
 */
function isRedeemable(c: WooCoupon, now: number): boolean {
  if (c.status !== undefined && c.status !== 'publish') return false;
  if (typeof c.date_expires_gmt === 'string' && c.date_expires_gmt !== '') {
    // wc_rest_prepare_date_response: "YYYY-MM-DDTHH:MM:SS" in GMT, no offset.
    const expires = Date.parse(/[zZ]|[+-]\d{2}:\d{2}$/.test(c.date_expires_gmt) ? c.date_expires_gmt : `${c.date_expires_gmt}Z`);
    if (Number.isFinite(expires) && now > expires) return false;
  }
  const limit = typeof c.usage_limit === 'number' ? c.usage_limit : null;
  const used = typeof c.usage_count === 'number' ? c.usage_count : 0;
  if (limit !== null && limit > 0 && used >= limit) return false;
  return true;
}

export class WooCommerceProvider implements PaymentProvider {
  readonly name = PROVIDER;
  /** Normalized store address, e.g. https://shop.example.com or https://example.com/store. */
  readonly storeUrl: string;
  private readonly storeOrigin: string;
  private readonly apiBase: string;
  /** Null when the stored token isn't a key pair: every API call then fails with ProviderAuthError. */
  private readonly authHeader: string | null;

  constructor(config: ProviderConfig) {
    // Defence in depth: the connect route already stored a normalized URL.
    const store = normalizeWooCommerceStoreUrl(config.siteId);
    if (!store.ok) throw new ProviderError(PROVIDER, 'init', store.message);
    this.storeUrl = store.value;
    this.storeOrigin = new URL(store.value).origin;
    this.apiBase = `${store.value}${API_PATH}`;
    // Webhook verification needs only the signing secret, so a bad or
    // undecryptable token must not stop the provider from being built (the
    // webhook route would then drop deliveries); API calls refuse instead.
    const creds = parseWooCommerceCredentials(config.apiKey);
    // The credential pattern is ASCII-only, so btoa cannot throw.
    this.authHeader = creds ? `Basic ${btoa(`${creds.consumerKey}:${creds.consumerSecret}`)}` : null;
  }

  // ── Coupons ───────────────────────────────────────────────────────────────

  async createDiscount(params: CreateDiscountParams): Promise<ProviderDiscount> {
    const op = 'createDiscount';
    if (params.discountType !== 'percentage') {
      throw new ProviderError(PROVIDER, op, 'GoPayLocal creates percentage coupons only in WooCommerce');
    }
    if (!(Number.isFinite(params.amount) && params.amount > 0 && params.amount <= 100)) {
      throw new ProviderError(PROVIDER, op, `Discount percent must be between 0 and 100, got ${params.amount}`);
    }

    const body: Record<string, unknown> = {
      code: params.code,
      discount_type: 'percent',
      amount: String(params.amount),
      // PPP codes don't stack with the store's other coupons: applying one
      // removes the others, and applying another individual-use coupon removes
      // this one.
      individual_use: true,
      description: `Created by GoPayLocal: ${params.name}`,
      meta_data: [{ key: META_KEY, value: META_VALUE }],
    };
    if (params.productIds && params.productIds.length > 0) {
      const ids = params.productIds.map((id) => toId(id));
      if (ids.some((id) => id === null)) {
        throw new ProviderError(PROVIDER, op, 'WooCommerce product ids are numbers');
      }
      body.product_ids = ids.map(Number);
    }
    if (params.maxRedemptions !== undefined) {
      if (!Number.isSafeInteger(params.maxRedemptions) || params.maxRedemptions < 1) {
        throw new ProviderError(PROVIDER, op, 'maxRedemptions must be a positive whole number');
      }
      body.usage_limit = params.maxRedemptions;
    }
    if (params.expiresAt) {
      const date = toWooUtcDate(params.expiresAt);
      if (!date) throw new ProviderError(PROVIDER, op, `Invalid expiry date '${params.expiresAt}'`);
      body.date_expires = date;
    }

    let coupon: WooCoupon;
    try {
      ({ data: coupon } = await this.request<WooCoupon>(op, 'POST', '/coupons', { body }));
    } catch (err) {
      if (err instanceof ProviderError && err.providerErrorCode === 'woocommerce_rest_coupon_code_already_exists') {
        throw new ProviderError(
          PROVIDER,
          op,
          `A coupon with the code ${params.code} already exists in the store`,
          err.statusCode,
          err.providerErrorCode,
        );
      }
      throw err;
    }

    const id = isRecord(coupon) ? toId(coupon.id) : null;
    if (!id) throw new ProviderError(PROVIDER, op, 'The store did not return the new coupon id');
    const stored = typeof coupon.code === 'string' ? coupon.code : '';
    const percent = typeof coupon.amount === 'string' || typeof coupon.amount === 'number' ? Number(coupon.amount) : NaN;
    return {
      providerDiscountId: id,
      // The store lower-cases codes and matches them case-insensitively, so
      // keep our spelling for display unless the store changed it otherwise.
      code: stored && stored.toLowerCase() !== params.code.toLowerCase() ? stored : params.code,
      discountPercent: Number.isFinite(percent) && percent > 0 ? percent : params.amount,
      provider: PROVIDER,
    };
  }

  async deleteDiscount(discountId: string): Promise<void> {
    const op = 'deleteDiscount';
    const id = toId(discountId);
    if (!id) throw new ProviderError(PROVIDER, op, `Invalid WooCommerce coupon id '${discountId}'`);
    await this.request(op, 'DELETE', `/coupons/${id}`, {
      query: { force: 'true' },
      notFound: { resource: 'coupon', id, code: 'woocommerce_rest_shop_coupon_invalid_id' },
    });
  }

  async listDiscounts(): Promise<ProviderDiscount[]> {
    const coupons = await this.listAll<WooCoupon>('listDiscounts', '/coupons', {
      _fields: 'id,code,amount,discount_type,status,date_expires_gmt,usage_count,usage_limit,meta_data',
    });
    const now = Date.now();
    const result: ProviderDiscount[] = [];
    for (const c of coupons) {
      // The REST API can't filter on meta, so ours are picked out here.
      if (!isRecord(c) || !hasGoPayLocalMeta(c.meta_data) || c.discount_type !== 'percent') continue;
      if (!isRedeemable(c, now)) continue;
      const id = toId(c.id);
      if (!id || typeof c.code !== 'string') continue;
      const percent = Number(c.amount);
      result.push({
        providerDiscountId: id,
        code: c.code,
        discountPercent: Number.isFinite(percent) ? percent : 0,
        provider: PROVIDER,
      });
    }
    return result;
  }

  // ── Products / checkout ───────────────────────────────────────────────────

  async listProducts(): Promise<ProviderProduct[]> {
    const op = 'listProducts';
    const products = await this.listAll<WooProduct>(op, '/products', {
      status: 'publish',
      _fields: 'id,name,price,permalink',
    });
    // Products carry no currency; prices are in the store currency.
    const { data: currency } = await this.request<{ code?: unknown }>(op, 'GET', '/data/currencies/current');
    const code = isRecord(currency) ? normalizeCurrency(typeof currency.code === 'string' ? currency.code : null) : null;

    const result: ProviderProduct[] = [];
    for (const p of products) {
      if (!isRecord(p)) continue;
      const id = toId(p.id);
      if (!id) continue;
      const price = typeof p.price === 'string' && p.price.trim() !== '' ? Number(p.price) : NaN;
      let url: string | null = null;
      if (typeof p.permalink === 'string') {
        try {
          const u = new URL(p.permalink);
          if (u.protocol === 'https:') url = u.toString();
        } catch {
          url = null;
        }
      }
      result.push({
        providerProductId: id,
        name: typeof p.name === 'string' ? p.name : `Product ${id}`,
        price: Number.isFinite(price) ? price : null,
        currency: code,
        url,
      });
    }
    return result;
  }

  /**
   * The store's shareable checkout link (WooCommerce 10.0+):
   * /checkout-link/?products=<id>:1&coupon=<code> empties the cart, adds the
   * product, applies the coupon and redirects to checkout. `productId` is a
   * product or variation id. The redirect URLs, email and metadata have no
   * place in the link and are not used. Built locally: no API call.
   */
  async buildCheckoutUrl(params: CheckoutUrlParams): Promise<string> {
    const id = toId(params.productId);
    if (!id) {
      throw new ProviderError(PROVIDER, 'buildCheckoutUrl', `Invalid WooCommerce product id '${params.productId}'`);
    }
    const url = new URL(`${this.storeUrl}/checkout-link/`);
    url.searchParams.set('products', `${id}:1`);
    if (params.discountCode) url.searchParams.set('coupon', params.discountCode);
    return url.toString();
  }

  // ── Webhooks ──────────────────────────────────────────────────────────────

  async provisionWebhook(callbackUrl: string): Promise<{ endpointId: string; secret: string | null }> {
    const op = 'provisionWebhook';
    // Hex: no characters wp_specialchars_decode would change before signing.
    const secret = randomHex(32);
    const created: string[] = [];
    try {
      for (const topic of WEBHOOK_TOPICS) {
        const { data } = await this.request<WooWebhook>(op, 'POST', '/webhooks', {
          body: { name: `GoPayLocal redemptions (${topic})`, topic, delivery_url: callbackUrl, secret, status: 'active' },
        });
        const id = isRecord(data) ? toId(data.id) : null;
        if (!id) throw new ProviderError(PROVIDER, op, 'The store did not return the new webhook id');
        created.push(id);
      }
    } catch (err) {
      // Don't leave half a setup behind (best-effort).
      // (401/403 messages already name the Read/Write permission and the
      // Administrator / Shop Manager role webhooks need.)
      for (const id of created) {
        await this.request('deleteWebhook', 'DELETE', `/webhooks/${id}`, { query: { force: 'true' } }).catch(() => {});
      }
      throw err;
    }
    return { endpointId: created.join(','), secret };
  }

  async deleteWebhook(endpointId: string): Promise<void> {
    const op = 'deleteWebhook';
    if (!endpointId) return;
    const ids = endpointId.split(',');
    if (ids.some((id) => !ID_PATTERN.test(id))) {
      throw new ProviderError(PROVIDER, op, `Invalid WooCommerce webhook id '${endpointId}'`);
    }
    let firstError: unknown = null;
    for (const id of ids) {
      try {
        await this.request(op, 'DELETE', `/webhooks/${id}`, {
          query: { force: 'true' },
          notFound: { resource: 'webhook', id, code: 'woocommerce_rest_shop_webhook_invalid_id' },
        });
      } catch (err) {
        if (err instanceof ProviderNotFoundError) continue; // already gone
        firstError ??= err;
      }
    }
    if (firstError) throw firstError;
  }

  async verifyWebhook(input: WebhookVerifyInput): Promise<boolean> {
    if (!input.secret) return false;
    const signature = input.headers.get('x-wc-webhook-signature');
    if (!signature) return false;
    const expected = await hmacSha256Base64(input.secret, input.rawBody);
    return timingSafeEqual(expected, signature.trim());
  }

  /**
   * True for the unsigned ping a store sends when a webhook is created
   * (body `webhook_id=<id>`, no X-WC-Webhook-* headers). It arrives before
   * provisionWebhook has returned, so before the secret is stored; it carries
   * no data and must not be treated as a failed delivery.
   */
  isHandshake(input: { rawBody: string; headers: Headers }): boolean {
    return !input.headers.has('x-wc-webhook-signature') && PING_BODY.test(input.rawBody.trim());
  }

  /**
   * A paid order (processing or completed) with at least one coupon. The event
   * id is the order id, so the order counts once however many deliveries
   * (order.created, each order.updated) carry it. Unpaid statuses are not
   * redemptions; refunds and cancellations after payment are not reversed
   * (the same as every other provider here).
   */
  parseRedemption(rawBody: string): RedemptionEvent | null {
    let order: unknown;
    try {
      order = JSON.parse(rawBody);
    } catch {
      return null;
    }
    if (!isRecord(order)) return null;
    const orderId = toId(order.id);
    if (!orderId || typeof order.status !== 'string' || !PAID_STATUSES.has(order.status)) return null;

    const currency = normalizeCurrency(typeof order.currency === 'string' ? order.currency : null);
    const exponent = minorUnitExponent(currency);
    // A coupon line that discounted nothing is not a redemption. This also
    // keeps a full-price renewal out if a subscriptions plugin copies the
    // coupon line onto it (WooCommerce Subscriptions applies standard coupons
    // to the first payment only:
    // https://woocommerce.com/document/subscriptions/subscriptions-coupons/).
    const lines = (Array.isArray(order.coupon_lines) ? order.coupon_lines : []).filter(
      (l): l is Record<string, unknown> =>
        isRecord(l) && typeof l.code === 'string' && l.code.trim() !== '' && decimalToMinor(l.discount, exponent) !== 0,
    );
    if (lines.length === 0) return null;

    const [primary, ...rest] = lines;
    const otherDiscounts: RedemptionDiscount[] = rest.map((l) => ({
      code: l.code as string,
      providerCouponId: null,
      providerPromoCodeId: null,
      discountAmountCents: decimalToMinor(l.discount, exponent),
    }));

    return {
      eventId: `order:${orderId}`,
      code: primary!.code as string,
      // coupon_lines[].id is the order item id, not the coupon's; codes are
      // unique per store, so the code identifies the coupon.
      providerCouponId: null,
      providerPromoCodeId: null,
      chargedAmountCents: decimalToMinor(order.total, exponent),
      taxAmountCents: decimalToMinor(order.total_tax, exponent),
      discountAmountCents: decimalToMinor(primary!.discount, exponent),
      currency,
      ...(otherDiscounts.length > 0 ? { otherDiscounts } : {}),
    };
  }

  // ── Internal helpers ──────────────────────────────────────────────────────

  /** Every page of a list endpoint, or an error; never a partial list. */
  private async listAll<T>(op: string, path: string, query: Record<string, string>): Promise<T[]> {
    const items: T[] = [];
    for (let page = 1; ; page++) {
      if (page > MAX_PAGES) {
        throw new ProviderError(
          PROVIDER,
          op,
          `The store has more than ${MAX_PAGES * PER_PAGE} items at ${path}; GoPayLocal reads at most ${MAX_PAGES} pages`,
        );
      }
      const { data, headers } = await this.request<unknown>(op, 'GET', path, {
        query: { ...query, per_page: String(PER_PAGE), page: String(page) },
      });
      if (!Array.isArray(data)) throw new ProviderError(PROVIDER, op, `The store returned an unexpected response for ${path}`);
      items.push(...(data as T[]));
      const totalPages = Number.parseInt(headers.get('x-wp-totalpages') ?? '', 10);
      const more = Number.isFinite(totalPages) ? page < totalPages : data.length === PER_PAGE;
      if (!more || data.length === 0) return items;
    }
  }

  private async request<T>(
    op: string,
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    opts: RequestOptions = {},
  ): Promise<WooResponse<T>> {
    if (!this.authHeader) {
      throw new ProviderAuthError(
        PROVIDER,
        'The stored credentials are not a WooCommerce consumer key and secret (ck_… and cs_…). Reconnect the integration.',
      );
    }
    const url = new URL(`${this.apiBase}${path}`);
    for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, v);
    // The key and secret go to the validated store origin and nowhere else.
    if (url.origin !== this.storeOrigin || url.protocol !== 'https:') {
      throw new ProviderError(PROVIDER, op, 'Refusing to send the API key outside the store');
    }

    const headers: Record<string, string> = {
      Authorization: this.authHeader,
      Accept: 'application/json',
      'User-Agent': 'GoPayLocal-WooCommerce/1',
    };
    const init: RequestInit = {
      method,
      headers,
      // Never follow: Workers would forward the Authorization header to the
      // redirect target, whatever its host.
      redirect: 'manual',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    };
    if (opts.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(opts.body);
    }

    let response: Response;
    let text: string;
    try {
      response = await fetch(url.toString(), init);
      text = response.status >= 300 && response.status < 400 ? '' : await readCapped(response, op);
    } catch (err) {
      if (err instanceof ProviderError) throw err;
      const name = err instanceof Error ? err.name : '';
      if (name === 'TimeoutError' || name === 'AbortError') {
        throw new ProviderError(PROVIDER, op, `The store did not respond within ${REQUEST_TIMEOUT_MS / 1000} seconds`);
      }
      throw new ProviderError(
        PROVIDER,
        op,
        `Could not connect to ${url.host} (DNS, TLS or network error). Check the store address and that the site is online over HTTPS.`,
      );
    }

    const status = response.status;
    if (status >= 300 && status < 400) {
      await response.body?.cancel().catch(() => {});
      throw new ProviderError(PROVIDER, op, this.redirectMessage(status, response.headers.get('location'), url), status);
    }

    let data: unknown = undefined;
    let parsed = false;
    if (text !== '') {
      try {
        data = JSON.parse(text);
        parsed = true;
      } catch {
        parsed = false;
      }
    }
    // WooCommerce's own error code, when it is a plain identifier. The error
    // `message` is never used: the response body is the store's, not ours.
    const code = parsed && isRecord(data) && typeof data.code === 'string' && SAFE_ERROR_CODE.test(data.code) ? data.code : undefined;
    const detail = code ? `HTTP ${status}, ${code}` : `HTTP ${status}`;

    if (status >= 200 && status < 300) {
      if (!parsed) {
        const type = (response.headers.get('content-type') ?? '').split(';')[0]!.trim();
        throw new ProviderError(
          PROVIDER,
          op,
          `The store did not return JSON from ${API_PATH}${path} (${detail}${MEDIA_TYPE.test(type) ? `, ${type}` : ''}). ` +
            'Check that WooCommerce is active and pretty permalinks are on.',
          status,
        );
      }
      return { data: data as T, headers: response.headers };
    }

    if (status === 401) {
      throw new ProviderAuthError(
        PROVIDER,
        `The store rejected the API key (${detail}). Check the consumer key and secret, and that the key has Read/Write permission. If they are right, the web server may be dropping the Authorization header (a known FastCGI issue).`,
      );
    }
    if (status === 403) {
      throw new ProviderAuthError(
        PROVIDER,
        `The store refused the request (${detail}). The key's user must be an Administrator or Shop Manager; a security plugin or firewall on the site can also block API requests.`,
      );
    }
    if (status === 404) {
      if (opts.notFound && code === opts.notFound.code) {
        throw new ProviderNotFoundError(PROVIDER, opts.notFound.resource, opts.notFound.id);
      }
      // Not WooCommerce saying "no such item": the REST route itself is
      // missing (wrong address, plugin inactive, plain permalinks). No 404
      // status code, so callers don't take it as "already deleted".
      throw new ProviderError(
        PROVIDER,
        op,
        `No WooCommerce REST API answered at ${this.storeUrl}${API_PATH} (${detail}). Check the store address, that WooCommerce is active, and that pretty permalinks are on.`,
        undefined,
        code,
      );
    }
    throw new ProviderError(PROVIDER, op, `The store returned an error (${detail})`, status, code);
  }

  private redirectMessage(status: number, location: string | null, from: URL): string {
    let target = '';
    if (location) {
      try {
        const to = new URL(location, from);
        // Name the destination only if it is itself an acceptable store address.
        const ok = normalizeWooCommerceStoreUrl(to.origin);
        if (ok.ok && to.origin !== from.origin) target = ` to ${ok.value}`;
      } catch {
        target = '';
      }
    }
    return (
      `The store answered with a redirect (HTTP ${status}${target}). GoPayLocal does not follow redirects with your API key. ` +
      (target ? 'If that is your store’s address, reconnect with it.' : 'Check the store address you entered.')
    );
  }
}

/** Read a body up to MAX_RESPONSE_BYTES; larger responses are an error, not truncated. */
async function readCapped(response: Response, op: string): Promise<string> {
  const tooLarge = () =>
    new ProviderError(PROVIDER, op, `The store's response is larger than ${MAX_RESPONSE_BYTES / (1024 * 1024)} MB`);
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => {});
    throw tooLarge();
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => {});
      throw tooLarge();
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.byteLength;
  }
  return new TextDecoder().decode(bytes);
}
