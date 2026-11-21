// ── Polar Provider ──────────────────────────────────────────────────────────
// Integration with Polar for PPP discount management.
// Docs: https://polar.sh/docs/api-reference — verified 2026-11-18 against the
// 2026-10 OpenAPI spec (https://api.polar.sh/openapi.json); per-endpoint
// citations live in polar.test.ts.
//
// Auth: Bearer ORGANIZATION access token (`oat` scheme). With an org token
// `organization_id` is omitted everywhere ("Required unless you use an
// organization token"). A personal access token would need it and would 422.
// Scopes used: discounts:read/write, checkouts:write, webhooks:write.
// This file talks to the raw REST API with fetch — the wire format is snake_case.
//
// API base: https://api.polar.sh/v1   (sandbox: https://sandbox-api.polar.sh/v1)
//
// VERSIONING (https://polar.sh/docs/api-reference/2026-10/versioning.md):
// requests are pinned with the `Polar-Version` header and the webhook endpoint
// with `api_version`. Unpinned requests follow "Current", which changes every
// quarter (2027-01 becomes Current on 2027-01-01). A version is removed ~9
// months after it appears and then answers EVERY request with 404, so
// POLAR_API_VERSION must be bumped before 2026-10 is removed (early April
// 2027); polar.test.ts fails from 2027-03-01 as a reminder.
//
// Shapes (2026-10 spec):
//   • POST /v1/discounts/ REQUIRES `name`, `type`, `duration`
//     ('once' | 'forever' | 'repeating'). Percentage discounts use
//     `basis_points` (1-10000; 2550 = 25.5%). Fixed discounts use the
//     `amounts` currency→cents map (`amount`/`currency` are deprecated and are
//     removed in 2027-01). Product scoping is `products`, expiry is `ends_at`,
//     cap is `max_redemptions`. `code`: 3-256 alphanumeric characters
//     (case-insensitive at checkout).
//   • GET /v1/discounts/ paginates with `page` + `limit` (≤100) and answers
//     { items, pagination: { total_count, max_page } }.
//   • POST /v1/checkouts/ (CheckoutProductsCreate): `products`, `success_url`,
//     `discount_id`, `customer_email`, `metadata`. There is no discount-code
//     field on checkout sessions; discounts apply by id.
//   • POST /v1/webhooks/endpoints: `url`, `format`, `events`, `api_version`.
//     Since 2026-10 Polar generates the secret (the request field was removed)
//     and returns it in the response.
//
// ── Webhook signatures (https://polar.sh/docs/integrate/webhooks/delivery.md) ─
// Headers `webhook-id`, `webhook-timestamp`, `webhook-signature` (`v1,<b64>`
// tokens); signed content `${id}.${timestamp}.${rawBody}`; HMAC-SHA256. The
// HMAC KEY depends on when the endpoint's secret was generated:
//   • on/after 2026-09-08 00:00 UTC (every endpoint we provision now):
//     Standard Webhooks — key = base64-decode of the secret minus `whsec_`.
//   • before that, or a user-provided secret: Polar HMAC — key = the UTF-8
//     bytes of the full secret string.
// Polar's own SDK (≥1.0.0-alpha.19) tries both keys; so does verifyWebhook.
//
// Redemptions: `order.paid`. Renewal orders of a `forever` discount also carry
// the discount, so only billing_reason `purchase` / `subscription_create`
// count as a redemption.

import type {
  PaymentProvider,
  CreateDiscountParams,
  CheckoutUrlParams,
  ProviderDiscount,
  ProviderConfig,
  WebhookVerifyInput,
  RedemptionEvent,
} from './types';
import { ProviderError, ProviderAuthError, ProviderNotFoundError } from './types';
import { verifyStandardWebhook } from '../../lib/standard-webhooks';

const POLAR_API_LIVE = 'https://api.polar.sh/v1';
const POLAR_API_SANDBOX = 'https://sandbox-api.polar.sh/v1';

/** API contract this adapter was verified against (requests + webhook payloads). */
const POLAR_API_VERSION = '2026-10';

/** DiscountCreate.code: "between 3 and 256 characters long and contain only alphanumeric characters". */
const POLAR_CODE_PATTERN = /^[A-Za-z0-9]{3,256}$/;

/**
 * Order.billing_reason values that represent a NEW use of a discount. Renewals
 * (`subscription_cycle`, `subscription_meter_cycle`) and plan changes
 * (`subscription_update`) reuse the discount already on the subscription.
 */
const REDEMPTION_BILLING_REASONS = new Set(['purchase', 'subscription_create']);

type PolarDuration = 'once' | 'forever' | 'repeating';

interface PolarDiscount {
  id: string;
  name: string;
  code: string | null;
  type: 'percentage' | 'fixed';
  duration: PolarDuration;
  duration_in_months?: number | null;
  basis_points?: number; // 4000 = 40%
  amounts?: Record<string, number> | null; // fixed discounts, minor units
  ends_at?: string | null;
  max_redemptions?: number | null;
  products?: string[];
  metadata?: Record<string, string | number | boolean>;
}

interface PolarList<T> {
  items: T[];
  pagination: { total_count: number; max_page: number };
}

interface PolarCheckout {
  id: string;
  url: string;
}

export class PolarProvider implements PaymentProvider {
  readonly name = 'polar';
  private apiKey: string;
  private baseUrl: string;

  constructor(config: ProviderConfig) {
    this.apiKey = config.apiKey;
    this.baseUrl =
      config.environment === 'test' ? POLAR_API_SANDBOX : POLAR_API_LIVE;
  }

  async createDiscount(params: CreateDiscountParams): Promise<ProviderDiscount> {
    if (!POLAR_CODE_PATTERN.test(params.code)) {
      throw new ProviderError(
        this.name,
        'createDiscount',
        `Polar discount codes must be 3-256 alphanumeric characters (got '${params.code}')`,
      );
    }

    try {
      const body: Record<string, unknown> = {
        name: params.name,
        code: params.code,
        // Polar REQUIRES a duration enum on every discount. We model PPP
        // discounts as permanent, so 'forever' (no duration_in_months needed).
        duration: 'forever' satisfies PolarDuration,
        metadata: { gopaylocal: 'true' },
      };

      if (params.discountType === 'percentage') {
        body.type = 'percentage';
        // basis_points: 1000 = 10%, so a 0-100 percentage maps to amount * 100.
        body.basis_points = Math.round(params.amount * 100);
      } else {
        body.type = 'fixed';
        // `amounts` (currency → integer minor units) is the non-deprecated
        // field and is required from 2027-01. 'usd' mirrors the documented
        // default of the deprecated `currency` field.
        const currency = (params.currency ?? 'usd').toLowerCase();
        body.amounts = { [currency]: Math.round(params.amount) };
      }

      // Product scoping is `products` (array of product UUIDs), not product_ids.
      if (params.productIds && params.productIds.length > 0) {
        body.products = params.productIds;
      }

      if (params.maxRedemptions) {
        body.max_redemptions = params.maxRedemptions;
      }

      // Expiry is `ends_at` (ISO 8601), not expires_at.
      if (params.expiresAt) {
        body.ends_at = params.expiresAt;
      }

      const discount = await this.request<PolarDiscount>(
        'POST',
        '/discounts/',
        body,
      );

      return {
        providerDiscountId: discount.id,
        code: discount.code ?? params.code,
        discountPercent:
          discount.type === 'percentage' && discount.basis_points != null
            ? discount.basis_points / 100
            : params.discountType === 'percentage'
              ? params.amount
              : 0,
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
        `/discounts/${encodeURIComponent(discountId)}`,
        null,
      );
    } catch (err) {
      throw this.handleError('deleteDiscount', err);
    }
  }

  async listDiscounts(): Promise<ProviderDiscount[]> {
    try {
      const result: ProviderDiscount[] = [];
      let page = 1;
      let hasMore = true;

      while (hasMore) {
        const response = await this.request<PolarList<PolarDiscount>>(
          'GET',
          `/discounts/?page=${page}&limit=100`,
          null,
        );

        for (const discount of response.items) {
          // Only include GoPayLocal-created discounts.
          if (discount.metadata?.gopaylocal !== 'true') continue;
          // Contract: only discounts that can still be redeemed. Deleted ones
          // are not listed; ended ones (`ends_at` passed) are.
          if (discount.ends_at && Date.parse(discount.ends_at) <= Date.now()) continue;

          result.push({
            providerDiscountId: discount.id,
            code: discount.code ?? '',
            discountPercent:
              discount.type === 'percentage' && discount.basis_points != null
                ? discount.basis_points / 100
                : 0,
            provider: this.name,
          });
        }

        // Pagination is `pagination.max_page` (snake_case) on the wire.
        hasMore = page < response.pagination.max_page;
        page++;
      }

      return result;
    } catch (err) {
      throw this.handleError('listDiscounts', err);
    }
  }

  async buildCheckoutUrl(params: CheckoutUrlParams): Promise<string> {
    try {
      // All checkout-create fields are snake_case; the first product in
      // `products` is selected by default. Checkout sessions take a discount
      // by id only (params.discountCode has no API equivalent here).
      const body: Record<string, unknown> = {
        products: [params.productId],
      };

      if (params.successUrl) {
        body.success_url = params.successUrl;
      }

      if (params.discountId) {
        body.discount_id = params.discountId;
      }

      if (params.customerEmail) {
        body.customer_email = params.customerEmail;
      }

      if (params.metadata) {
        body.metadata = params.metadata;
      }

      const checkout = await this.request<PolarCheckout>(
        'POST',
        '/checkouts/',
        body,
      );

      if (!checkout.url) {
        throw new ProviderError(
          this.name,
          'buildCheckoutUrl',
          'No checkout URL returned',
        );
      }

      return checkout.url;
    } catch (err) {
      throw this.handleError('buildCheckoutUrl', err);
    }
  }

  // ── Webhooks ──────────────────────────────────────────────────────────────

  async provisionWebhook(
    callbackUrl: string,
  ): Promise<{ endpointId: string; secret: string | null }> {
    try {
      // format:'raw' so we receive the raw JSON (not Discord/Slack formatting).
      // api_version pins the payload contract parseRedemption was verified on.
      const res = await this.request<{ id?: string; secret?: string }>(
        'POST',
        '/webhooks/endpoints',
        {
          url: callbackUrl,
          format: 'raw',
          events: ['order.paid'],
          api_version: POLAR_API_VERSION,
        },
      );
      if (!res.id || !res.secret) {
        throw new ProviderError(
          this.name,
          'provisionWebhook',
          'Webhook endpoint response is missing its id or secret',
        );
      }
      return { endpointId: res.id, secret: res.secret };
    } catch (err) {
      throw this.handleError('provisionWebhook', err);
    }
  }

  async deleteWebhook(endpointId: string): Promise<void> {
    try {
      await this.request('DELETE', `/webhooks/endpoints/${encodeURIComponent(endpointId)}`, null);
    } catch (err) {
      throw this.handleError('deleteWebhook', err);
    }
  }

  async verifyWebhook(input: WebhookVerifyInput): Promise<boolean> {
    if (!input.secret) return false;
    const headers = {
      id: input.headers.get('webhook-id'),
      timestamp: input.headers.get('webhook-timestamp'),
      signature: input.headers.get('webhook-signature'),
    };
    // Standard Webhooks key first (every secret Polar generated since
    // 2026-09-08), then the legacy Polar HMAC key (UTF-8 bytes of the whole
    // secret) for older and user-provided secrets. Both need the secret.
    return (
      (await verifyStandardWebhook(input.rawBody, headers, input.secret, 'whsec')) ||
      (await verifyStandardWebhook(input.rawBody, headers, input.secret, 'raw'))
    );
  }

  parseRedemption(rawBody: string): RedemptionEvent | null {
    let evt: { type?: string; data?: Record<string, any> };
    try {
      evt = JSON.parse(rawBody);
    } catch {
      return null;
    }
    if (evt.type !== 'order.paid' || !evt.data) return null;
    const data = evt.data;
    if (typeof data.id !== 'string' || !data.id) return null;

    // A forever discount rides along on every renewal order; count only the
    // order that first applied it. (billing_reason is a required Order field;
    // tolerate its absence rather than drop a redemption.)
    if (data.billing_reason != null && !REDEMPTION_BILLING_REASONS.has(data.billing_reason)) {
      return null;
    }

    const code: string | null = data.discount?.code ?? null;
    const providerCouponId: string | null = data.discount_id ?? data.discount?.id ?? null;
    if (!code && !providerCouponId) return null; // no discount applied

    // Order amounts (https://polar.sh/docs/api-reference/orders/get), all "in cents":
    //   subtotal_amount "before discounts and taxes", net_amount "after discounts
    //   but before taxes", tax_amount "Sales tax amount", total_amount "after
    //   discounts and taxes". The pre-tax discount is subtotal − net (both
    //   documented as pre-tax); discount_amount itself has no tax wording, so it
    //   is only used when the order carries no tax.
    const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
    const subtotal = num(data.subtotal_amount);
    const net = num(data.net_amount);
    const tax = num(data.tax_amount);
    let discount: number | null = null;
    if (subtotal != null && net != null && subtotal - net > 0) discount = subtotal - net;
    else if (tax === 0) discount = num(data.discount_amount);
    return {
      eventId: data.id,
      code,
      providerCouponId,
      providerPromoCodeId: null,
      chargedAmountCents: num(data.total_amount),
      taxAmountCents: tax,
      discountAmountCents: discount,
      currency: typeof data.currency === 'string' ? data.currency : null,
    };
  }

  // ── Internal Helpers ────────────────────────────────────────────────────

  private async request<T>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    body: Record<string, unknown> | null,
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;

    const init: RequestInit = {
      method,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        Accept: 'application/json',
        'Polar-Version': POLAR_API_VERSION,
      },
    };

    if (body && (method === 'POST' || method === 'PUT')) {
      (init.headers as Record<string, string>)['Content-Type'] =
        'application/json';
      init.body = JSON.stringify(body);
    }

    const response = await fetch(url, init);

    if (!response.ok) {
      const errorBody = (await response.json().catch(() => ({}))) as {
        detail?: unknown;
        message?: string;
        error?: string;
      };
      const message = this.formatError(errorBody, response.status);

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
      );
    }

    // DELETE (and other no-content responses) return 204 with no body.
    if (response.status === 204) {
      return {} as T;
    }

    return (await response.json()) as T;
  }

  /**
   * Polar / FastAPI validation errors return `detail` either as a string or as
   * an array of { loc, msg, type } objects (HTTP 422). Flatten both into a
   * readable message so 422s are actionable instead of "[object Object]".
   */
  private formatError(
    errorBody: { detail?: unknown; message?: string; error?: string },
    status: number,
  ): string {
    const { detail } = errorBody;

    if (typeof detail === 'string') return detail;

    if (Array.isArray(detail)) {
      const parts = detail
        .map((d) => {
          const item = d as { loc?: unknown[]; msg?: string };
          const loc = Array.isArray(item.loc) ? item.loc.join('.') : '';
          return loc ? `${loc}: ${item.msg ?? ''}` : (item.msg ?? '');
        })
        .filter(Boolean);
      if (parts.length > 0) return parts.join('; ');
    }

    return errorBody.message ?? errorBody.error ?? `HTTP ${status}`;
  }

  /** Normalise any thrown value into a ProviderError, preserving subtypes. */
  private handleError(operation: string, err: unknown): ProviderError {
    if (err instanceof ProviderError) return err;

    const message = err instanceof Error ? err.message : String(err);
    return new ProviderError(this.name, operation, message);
  }
}
