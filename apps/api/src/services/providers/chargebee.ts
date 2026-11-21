// ── Chargebee Provider ──────────────────────────────────────────────────────
// Integration with Chargebee for PPP discount management.
//
// Sources (verified November 2026):
//   - API reference (Markdown):  https://apidocs.chargebee.com/docs/api/<page>.md
//   - Official OpenAPI spec:     https://github.com/chargebee/openapi
//                                (spec/chargebee_api_v2_pc_v2_spec.json)
//   - Official Node SDK:         chargebee@3.37.0 (request encoding in esm/util.js
//                                `encodeParams`, per-endpoint JSON keys in
//                                esm/resources/api_endpoints.js)
//
// Auth: HTTP Basic, the site API key is the username and the password is empty
// (https://apidocs.chargebee.com/docs/api/auth.md). Test and live sites have
// different keys AND different hosts: the test site is `{site}-test`
// (OpenAPI `servers`: `{site}.chargebee.com` and `{site}-test.chargebee.com`).
//
// Requests are `application/x-www-form-urlencoded`. Nested params use bracketed
// index notation (`item_constraints[constraint][0]=specific`); params the SDK
// marks as JSON keys (`meta_data` at level 0, `item_price_ids` at level 1 on
// coupons) are sent as a single JSON-encoded value.
//
// This integration targets Product Catalog 2.0 ("for items" endpoints):
//   - Coupons:  POST /coupons/create_for_items, GET /coupons,
//               POST /coupons/{id}/delete
//   - Checkout: POST /hosted_pages/checkout_new_for_items
//   - Webhooks: POST /webhook_endpoints, POST /webhook_endpoints/{id}/delete
//
// Webhooks: Chargebee does NOT sign webhooks. Endpoints are secured with HTTP
// Basic Auth (https://apidocs.chargebee.com/docs/api/events.md, "Securing Your
// Webhook URL"). We generate the credentials at provisioning time and compare
// the inbound `Authorization` header against them in constant time. Duplicate
// deliveries are expected and are deduplicated on the event `id`.

import type {
  PaymentProvider,
  CreateDiscountParams,
  CheckoutUrlParams,
  ProviderDiscount,
  ProviderConfig,
  WebhookVerifyInput,
  RedemptionEvent,
  RedemptionDiscount,
} from './types';
import { ProviderError, ProviderAuthError, ProviderNotFoundError } from './types';
import { timingSafeEqual } from '../../lib/webhook-verify';

interface ChargebeeCoupon {
  id: string;
  name: string;
  discount_type: 'fixed_amount' | 'percentage' | 'offer_quantity';
  discount_percentage?: number;
  discount_amount?: number;
  currency_code?: string;
  apply_on: 'invoice_amount' | 'each_specified_item';
  duration_type: 'one_time' | 'forever' | 'limited_period';
  status: 'active' | 'expired' | 'archived' | 'deleted' | 'future';
  valid_till?: number;
  max_redemptions?: number;
  meta_data?: Record<string, unknown>;
}

interface ChargebeeHostedPage {
  id: string;
  url: string;
  state: string;
}

/** `invoice.discounts[]` entry (invoice object docs, `discounts`). */
interface ChargebeeInvoiceDiscount {
  amount?: number;
  entity_type?: string;
  entity_id?: string | null;
  coupon_set_code?: string | null;
  line_item_id?: string | null;
}

// `pass_thru_content` on checkout_new_for_items is a string, max 2048 chars.
const PASS_THRU_MAX = 2048;

// Chargebee site names are DNS labels. Anything else would let a stored
// providerAccountId point our API-key-bearing requests at another host.
const SITE_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

/**
 * Accepts what merchants actually paste ("acme", "acme.chargebee.com",
 * "https://acme.chargebee.com/") and returns the bare site name, or null if it
 * isn't a valid site name.
 */
export function normalizeChargebeeSite(raw: string): string | null {
  let site = raw.trim().toLowerCase();
  site = site.replace(/^https?:\/\//, '');
  site = site.split('/')[0] ?? '';
  site = site.replace(/\.chargebee\.com$/, '');
  return SITE_ID_PATTERN.test(site) ? site : null;
}

export class ChargebeeProvider implements PaymentProvider {
  readonly name = 'chargebee';
  private apiBase: string;
  private authHeader: string;

  constructor(config: ProviderConfig) {
    if (!config.siteId) {
      throw new ProviderError(
        'chargebee',
        'init',
        'siteId is required for Chargebee',
      );
    }
    let site = normalizeChargebeeSite(config.siteId);
    if (!site) {
      throw new ProviderError(
        'chargebee',
        'init',
        `Invalid Chargebee site '${config.siteId}': use the site name from {site}.chargebee.com`,
      );
    }
    // Test-mode keys only work against the `{site}-test` host (OpenAPI servers;
    // auth.md: "The API keys are different for your test site and your live site").
    if (config.environment === 'test' && !site.endsWith('-test')) {
      site = `${site}-test`;
    }

    this.apiBase = `https://${site}.chargebee.com/api/v2`;
    // Chargebee uses HTTP Basic Auth: API key as username, blank password.
    this.authHeader = 'Basic ' + btoa(`${config.apiKey}:`);
  }

  async createDiscount(params: CreateDiscountParams): Promise<ProviderDiscount> {
    const isPercentage = params.discountType === 'percentage';
    const restrictToItems =
      params.productIds !== undefined && params.productIds.length > 0;

    const body = new URLSearchParams({
      id: params.code,
      name: params.name,
      discount_type: isPercentage ? 'percentage' : 'fixed_amount',
      // `each_specified_item` is required when the coupon is restricted to
      // specific item prices; otherwise the discount applies to the whole
      // invoice subtotal.
      apply_on: restrictToItems ? 'each_specified_item' : 'invoice_amount',
      // PPP discounts reflect a customer's ongoing purchasing power, so they
      // should persist for the life of the subscription. 'one_time' would apply
      // the discount to only the first invoice and then detach it.
      duration_type: 'forever',
      // `meta_data` is a jsonobject param: the official SDK sends it as ONE
      // form field holding JSON (api_endpoints.js: coupon.createForItems
      // jsonKeys { meta_data: 0 }). Bracketed `meta_data[key]=` is not that.
      meta_data: JSON.stringify({ gopaylocal: 'true' }),
    });

    if (isPercentage) {
      // discount_percentage is a double in the range 0.01–100.
      body.set('discount_percentage', String(params.amount));
    } else {
      // discount_amount is an integer in the currency's smallest unit (cents);
      // CreateDiscountParams already provides `amount` in cents.
      body.set('discount_amount', String(Math.round(params.amount)));
      if (params.currency) {
        // Applicable to fixed_amount coupons only.
        body.set('currency_code', params.currency.toUpperCase());
      }
    }

    if (params.maxRedemptions) {
      body.set('max_redemptions', String(params.maxRedemptions));
    }

    if (params.expiresAt) {
      // Chargebee expects a Unix timestamp in seconds.
      body.set(
        'valid_till',
        String(Math.floor(new Date(params.expiresAt).getTime() / 1000)),
      );
    }

    if (restrictToItems) {
      // Product Catalog 2.0 restricts a coupon to specific item prices via
      // `item_constraints` (an indexed list of constraint objects), NOT the
      // legacy `plan_ids`. The `[0]` segment is the constraint's list index.
      // `item_price_ids` is a level-1 JSON key in the SDK, so the whole id list
      // is one JSON-array value: item_constraints[item_price_ids][0]=["a","b"].
      // The docs require the value be wrapped in square brackets.
      body.set('item_constraints[constraint][0]', 'specific');
      body.set('item_constraints[item_type][0]', 'plan');
      body.set(
        'item_constraints[item_price_ids][0]',
        JSON.stringify(params.productIds!),
      );
    }

    const response = await this.request<{ coupon: ChargebeeCoupon }>(
      'POST',
      '/coupons/create_for_items',
      body,
    );

    const coupon = response.coupon;

    return {
      providerDiscountId: coupon.id,
      code: coupon.id,
      discountPercent:
        coupon.discount_type === 'percentage'
          ? coupon.discount_percentage ?? params.amount
          : 0,
      provider: this.name,
    };
  }

  async deleteDiscount(discountId: string): Promise<void> {
    // Unused coupons are deleted; coupons linked to subscriptions/invoices are
    // archived instead (coupons "Delete a coupon").
    await this.request(
      'POST',
      `/coupons/${encodeURIComponent(discountId)}/delete`,
      null,
    );
  }

  async listDiscounts(): Promise<ProviderDiscount[]> {
    const result: ProviderDiscount[] = [];
    let offset: string | undefined;

    do {
      // limit: 1–100 (default 10). `next_offset` is present only while more
      // pages exist.
      const params = new URLSearchParams({ limit: '100' });
      if (offset) params.set('offset', offset);

      const response = await this.request<{
        list: Array<{ coupon: ChargebeeCoupon }>;
        next_offset?: string;
      }>('GET', `/coupons?${params.toString()}`, null);

      for (const item of response.list) {
        const coupon = item.coupon;

        // Only include GoPayLocal-created, applicable coupons. (List APIs
        // can't filter on meta_data, so this is client-side.)
        const tag = coupon.meta_data?.gopaylocal;
        if (tag !== 'true' && tag !== true) continue;
        if (coupon.status !== 'active') continue;

        result.push({
          providerDiscountId: coupon.id,
          code: coupon.id,
          discountPercent: coupon.discount_percentage ?? 0,
          provider: this.name,
        });
      }

      offset = response.next_offset;
    } while (offset);

    return result;
  }

  async buildCheckoutUrl(params: CheckoutUrlParams): Promise<string> {
    // checkout_new_for_items creates a hosted checkout for a NEW subscription.
    // The first subscription item must be an item price of type `plan`.
    const body = new URLSearchParams({
      'subscription_items[item_price_id][0]': params.productId,
      'subscription_items[quantity][0]': '1',
      redirect_url: params.successUrl,
    });

    // Coupons are applied via `coupon_ids` (an array → bracketed index form).
    // The value may be either a coupon id or a coupon code.
    const coupon = params.discountCode ?? params.discountId;
    if (coupon) {
      body.set('coupon_ids[0]', coupon);
    }

    if (params.cancelUrl) {
      body.set('cancel_url', params.cancelUrl);
    }

    if (params.customerEmail) {
      body.set('customer[email]', params.customerEmail);
    }

    // Neither a top-level `meta_data` nor `subscription[meta_data]` exists on
    // this endpoint (subscription[] accepts only id, trial_end, start_date,
    // coupon, auto_collection, offline_payment_method, invoice_notes,
    // po_number, contract_term_billing_cycle_on_renewal). `pass_thru_content`
    // is the documented place for custom data on a hosted page.
    if (params.metadata && Object.keys(params.metadata).length > 0) {
      const passThru = JSON.stringify(params.metadata);
      if (passThru.length > PASS_THRU_MAX) {
        throw new ProviderError(
          this.name,
          'buildCheckoutUrl',
          `metadata too large for pass_thru_content (${passThru.length} > ${PASS_THRU_MAX} chars)`,
        );
      }
      body.set('pass_thru_content', passThru);
    }

    const response = await this.request<{ hosted_page: ChargebeeHostedPage }>(
      'POST',
      '/hosted_pages/checkout_new_for_items',
      body,
    );

    if (!response.hosted_page?.url) {
      throw new ProviderError(
        this.name,
        'buildCheckoutUrl',
        'No checkout URL returned',
      );
    }

    return response.hosted_page.url;
  }

  // ── Webhooks ──────────────────────────────────────────────────────────────

  async provisionWebhook(
    callbackUrl: string,
  ): Promise<{ endpointId: string; secret: string | null }> {
    // Chargebee doesn't sign webhooks — secure the endpoint with HTTP Basic Auth
    // credentials WE generate (password is the stored "secret").
    const rand = (n: number) =>
      Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) =>
        b.toString(16).padStart(2, '0'),
      ).join('');
    const username = `gpl_${rand(4)}`;
    const password = rand(16);

    const body = new URLSearchParams({
      name: 'GoPayLocal Redemptions', // max 50 chars
      api_version: 'v2',
      url: callbackUrl, // max 512 chars; ports 80/443/8080/8443 only
      basic_auth_username: username,
      basic_auth_password: password,
      'enabled_events[0]': 'payment_succeeded',
    });

    let res: { webhook_endpoint?: { id?: string } };
    try {
      res = await this.request<{ webhook_endpoint?: { id?: string } }>(
        'POST',
        '/webhook_endpoints',
        body,
      );
    } catch (err) {
      if (err instanceof ProviderAuthError) throw err;
      if (err instanceof ProviderError) {
        // Most likely causes: the site already has the maximum of five webhook
        // endpoints (webhook_endpoints docs), or the API key lacks permission.
        throw new ProviderError(
          this.name,
          'provisionWebhook',
          `Chargebee refused to create the redemption webhook (${err.message}). ` +
            'Check that the site has fewer than 5 webhook endpoints and that the API key has full access, then reconnect.',
          err.statusCode,
          err.providerErrorCode,
        );
      }
      throw err;
    }

    const endpointId = res.webhook_endpoint?.id;
    if (!endpointId) {
      throw new ProviderError(
        this.name,
        'provisionWebhook',
        'Chargebee did not return a webhook_endpoint id',
      );
    }
    // Pack "username:password" as the stored secret; verifyWebhook compares it
    // against the decoded Basic-Auth header.
    return { endpointId, secret: `${username}:${password}` };
  }

  async deleteWebhook(endpointId: string): Promise<void> {
    if (!endpointId) return;
    await this.request(
      'POST',
      `/webhook_endpoints/${encodeURIComponent(endpointId)}/delete`,
      null,
    );
  }

  async verifyWebhook(input: WebhookVerifyInput): Promise<boolean> {
    if (!input.secret) return false;
    const header = input.headers.get('authorization');
    if (!header) return false;
    // RFC 7617: the auth scheme name is case-insensitive.
    const match = /^\s*basic\s+([A-Za-z0-9+/=]+)\s*$/i.exec(header);
    if (!match) return false;
    let decoded: string;
    try {
      decoded = atob(match[1]!);
    } catch {
      return false;
    }
    // Stored secret is "username:password"; the header decodes to the same.
    return timingSafeEqual(decoded, input.secret);
  }

  parseRedemption(rawBody: string): RedemptionEvent | null {
    let evt: { event_type?: string; id?: string; content?: any };
    try {
      evt = JSON.parse(rawBody);
    } catch {
      return null;
    }
    if (evt.event_type !== 'payment_succeeded' || !evt.content) return null;
    const content = evt.content;
    const invoice = content.invoice;
    if (!invoice) return null;

    // payment_succeeded fires for EVERY collected invoice, including each
    // renewal of a `duration_type=forever` coupon. Count a subscription
    // invoice only when it is the subscription's first (`first_invoice`:
    // "the first invoice raised for the subscription"). Non-recurring
    // invoices (one-off charges) count every time.
    if (invoice.recurring !== false && invoice.first_invoice !== true) return null;

    const discounts: ChargebeeInvoiceDiscount[] = Array.isArray(invoice.discounts)
      ? invoice.discounts
      : [];
    // Coupon-driven discounts only; entity_id === our Chargebee coupon id. Other
    // entity types (`promotional_credits`, `prorated_credits`, `*_discount`)
    // are not coupons, so an invoice mixing them with a PPP coupon must not
    // match on them.
    const couponDiscounts = discounts.filter(
      (x) =>
        (x?.entity_type === 'document_level_coupon' ||
          x?.entity_type === 'item_level_coupon') &&
        (x?.entity_id || x?.coupon_set_code),
    );
    if (couponDiscounts.length === 0) return null; // no coupon redeemed

    // RedemptionEvent carries ONE coupon. GoPayLocal creates its coupons with
    // apply_on=invoice_amount, which Chargebee reports as
    // `document_level_coupon`, so prefer those when an invoice stacks several.
    const d =
      couponDiscounts.find((x) => x.entity_type === 'document_level_coupon') ??
      couponDiscounts[0]!;

    const providerCouponId: string | null = d.entity_id || null;
    // `coupon_set_code` is only populated for coupon-set (pre-generated) codes.
    // We create plain coupons, so it's null for ours and matching rides on
    // entity_id → providerCouponId.
    const code: string | null = d.coupon_set_code || null;

    // A coupon can yield one discount entry per line item, so total every
    // entry belonging to the redeemed coupon.
    const redeemed = providerCouponId
      ? couponDiscounts.filter((x) => x.entity_id === providerCouponId)
      : [d];
    // Invoice price_type: tax_exclusive "All amounts in the document are
    // exclusive of tax", tax_inclusive "... inclusive of tax"
    // (https://apidocs.chargebee.com/docs/api/invoices). Discount amounts on a
    // tax-inclusive invoice contain tax and can't be split from documented
    // fields, so they are not reported (the handler back-calculates from
    // total − tax instead). Chargebee's default price_type is tax_exclusive.
    const taxInclusive = invoice.price_type === 'tax_inclusive';
    const amounts: number[] = taxInclusive
      ? []
      : redeemed.map((x) => x.amount).filter((a): a is number => typeof a === 'number');

    // Every other coupon on the invoice (one entry per coupon id, amounts
    // totalled), so the shared handler still finds ours when the merchant's own
    // coupon is the preferred one above.
    const otherDiscounts: RedemptionDiscount[] = [];
    const seen = new Set<string>(providerCouponId ? [providerCouponId] : []);
    for (const x of couponDiscounts) {
      if (x === d) continue;
      const id = x.entity_id || null;
      if (id) {
        if (seen.has(id)) continue;
        seen.add(id);
      }
      const own = id ? couponDiscounts.filter((y) => y.entity_id === id) : [x];
      const ownAmounts = taxInclusive
        ? []
        : own.map((y) => y.amount).filter((a): a is number => typeof a === 'number');
      otherDiscounts.push({
        code: x.coupon_set_code || null,
        providerCouponId: id,
        providerPromoCodeId: null,
        discountAmountCents: ownAmounts.length ? ownAmounts.reduce((sum, a) => sum + a, 0) : null,
      });
    }

    // Invoice `total` ("Invoiced amount", tax included) and `tax` ("Total tax
    // amount for this invoice") come from the same document, so the tax is
    // known to be inside that total. A transaction amount can differ from the
    // invoice total (credits, partial payments), so with it the tax is unknown.
    let charged: number | null = null;
    let tax: number | null = null;
    if (typeof invoice.total === 'number') {
      charged = invoice.total;
      tax = typeof invoice.tax === 'number' ? invoice.tax : null;
    } else if (typeof content.transaction?.amount === 'number') {
      charged = content.transaction.amount;
    }
    const currency =
      typeof content.transaction?.currency_code === 'string'
        ? content.transaction.currency_code
        : typeof invoice.currency_code === 'string'
          ? invoice.currency_code
          : null;

    return {
      eventId: typeof evt.id === 'string' ? evt.id : '',
      code,
      providerCouponId,
      providerPromoCodeId: null,
      // All Chargebee money fields are integers in the currency's minor unit
      // ("in cents"; whole units for zero-decimal currencies).
      chargedAmountCents: charged,
      taxAmountCents: tax,
      discountAmountCents: amounts.length
        ? amounts.reduce((sum, a) => sum + a, 0)
        : null,
      currency,
      ...(otherDiscounts.length > 0 ? { otherDiscounts } : {}),
    };
  }

  // ── Internal Helpers ────────────────────────────────────────────────────

  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    body: URLSearchParams | null,
  ): Promise<T> {
    const url = `${this.apiBase}${path}`;

    const init: RequestInit = {
      method,
      headers: {
        Authorization: this.authHeader,
        Accept: 'application/json',
      },
    };

    if (body && method === 'POST') {
      (init.headers as Record<string, string>)['Content-Type'] =
        'application/x-www-form-urlencoded';
      init.body = body.toString();
    }

    let response: Response;
    try {
      response = await fetch(url, init);
    } catch (err) {
      // DNS failure (e.g. a wrong site name), connection reset, timeout.
      throw new ProviderError(
        this.name,
        `${method} ${path}`,
        `Network error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    if (!response.ok) {
      const errorBody = (await response.json().catch(() => ({}))) as {
        message?: string;
        error_code?: string;
        api_error_code?: string;
      };
      const message = errorBody.message ?? `HTTP ${response.status}`;
      // Chargebee returns `api_error_code` (e.g. `param_wrong_value`);
      // `error_code` is a deprecated attribute kept for old client libraries.
      const providerErrorCode = errorBody.api_error_code ?? errorBody.error_code;

      if (response.status === 401 || response.status === 403) {
        throw new ProviderAuthError(this.name, message);
      }

      if (response.status === 404) {
        throw new ProviderNotFoundError(this.name, 'resource', path);
      }

      throw new ProviderError(
        this.name,
        `${method} ${path}`,
        message,
        response.status,
        providerErrorCode,
      );
    }

    return (await response.json()) as T;
  }
}
