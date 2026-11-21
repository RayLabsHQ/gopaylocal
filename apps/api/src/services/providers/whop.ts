// ── Whop Provider ───────────────────────────────────────────────────────────
// Integration with Whop for PPP discount management.
//
// Sources (verified November 2026):
//   - OpenAPI spec (Current API): https://api.whop.com/api/v1/openapi.json
//       info.x-api-version-date = "2026-11-17-2", the version pinned below.
//   - Versioning:  https://docs.whop.com/developer/api/versioning.md
//   - Webhooks:    https://docs.whop.com/developer/guides/webhooks.md
//   - Sandbox:     https://docs.whop.com/developer/guides/sandbox.md
//   - Official SDK: @whop/sdk@2.8.1, dist/esm/helpers/verifyWebhook.mjs
//
// VERSION PINNING (critical). Whop versions its API by date. Without an
// `Api-Version-Date` header a request is served at the version pinned on the
// API KEY, and "newly created keys use the latest released version", so the
// request/response shapes would depend on when the merchant made their key.
// We send the header on every request and pin the webhook's payload shape
// with `api_version_date`, so every shape below is the one in the spec above.
//
// Shapes at 2026-11-17-2 (each changed from the original 2025-01-01 shapes):
//   - promo codes take `account_id` (was `company_id`) and `variant_ids` (was
//     `plan_ids`; variant ids keep the `plan_` prefix) — changelog 2026-08-03,
//     2026-10-27-2;
//   - checkout configurations take `variant_id` (was `plan_id`) — 2026-10-27-2;
//   - POST /webhooks rejects `api_version` with a 400; pin with
//     `api_version_date` instead — 2026-08-12;
//   - payment webhooks carry `promo_code_id` (not an embedded promo_code) and
//     money as `{ amount: "10.00", currency, decimals, display_decimals }`
//     objects — 2026-09-02-1.
//
// Environments: production https://api.whop.com/api/v1 + https://whop.com,
// sandbox https://sandbox-api.whop.com/api/v1 + https://sandbox.whop.com.
// The two share no accounts, keys or webhooks.
//
// Whop calls discounts "promo codes". Every promo-code operation is scoped to an
// `account_id` (biz_xxx). The caller populates siteId from
// `integration.providerAccountId`; if it is missing we look it up with
// GET /accounts/me ("Retrieves the account associated with the current Account
// API key"; needs the company:balance:read scope). That operation is in the
// spec but marked `x-whop-docs: hidden`, so collecting the biz_ id at connect
// time is the reliable path; the lookup is a fallback.
//
// Promo codes can't be created with metadata, so GoPayLocal-created codes are
// tagged with a `GPL_` code prefix for listDiscounts().
//
// Webhook signatures: Standard Webhooks headers (`webhook-id`,
// `webhook-timestamp`, `webhook-signature: v1,<base64>`), HMAC-SHA256 over
// `${id}.${timestamp}.${rawBody}`, 5-minute tolerance. The HMAC key is the
// LITERAL UTF-8 bytes of the `ws_…` secret, prefix included — NOT a base64
// decode of it (SDK verifyWebhook.mjs: "Whop's backend HMACs with the literal
// bytes of the secret it issued"). That is lib/standard-webhooks 'raw' mode.

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

/** The dated API version every request and the webhook payloads are pinned to. */
export const WHOP_API_VERSION = '2026-11-17-2';

const ENDPOINTS = {
  live: { api: 'https://api.whop.com/api/v1', web: 'https://whop.com' },
  test: { api: 'https://sandbox-api.whop.com/api/v1', web: 'https://sandbox.whop.com' },
} as const;

// We tag GoPayLocal-created promo codes with this prefix so listDiscounts() can
// filter them — promo-code creation accepts no metadata.
const GPL_CODE_PREFIX = 'GPL_';

// Payment `billing_reason` values that are NOT a new redemption: the promo
// stays on the membership and is re-applied on each renewal / plan change.
// Enum (BillingReasons): subscription_create, subscription_cycle,
// subscription_update, one_time, manual, subscription.
const NON_REDEMPTION_BILLING_REASONS = new Set(['subscription_cycle', 'subscription_update']);

type WhopPromoType = 'percentage' | 'flat_amount';
type WhopPromoStatus = 'active' | 'inactive' | 'archived';

// Response shape for POST /promo_codes and items of GET /promo_codes
// (only the fields we consume).
interface WhopPromoCode {
  id: string; // promo_xxxxxxxxxxxx
  code: string | null;
  // "Discount amount. Percentage discounts are represented as a decimal
  // fraction" (e.g. 0.25 for 25%).
  amount_off: number;
  promo_type: WhopPromoType;
  currency: string;
  status: WhopPromoStatus;
  expires_at: string | null;
}

interface WhopListResponse<T> {
  data: T[];
  page_info: { has_next_page?: boolean; end_cursor?: string | null };
}

interface WhopCheckoutConfiguration {
  id: string; // ch_xxxxxxxxxxxxxx
  // "Checkout URL you can send to customers", e.g.
  // https://whop.com/checkout/ch_xxxxxxxxxxxxxx/
  purchase_url: string | null;
}

interface WhopErrorBody {
  error?: { type?: string; message?: string; code?: string | null };
  message?: string;
}

/** Money object on Current-API payments. */
interface WhopMoney {
  amount: string; // major units as an exact decimal string, e.g. "29.99"
  currency: string; // lowercase ISO 4217
  decimals: number; // decimal places the amount carries
}

function isMoney(v: unknown): v is WhopMoney {
  return (
    !!v &&
    typeof v === 'object' &&
    typeof (v as WhopMoney).amount === 'string' &&
    typeof (v as WhopMoney).decimals === 'number'
  );
}

/** ISO 4217 minor-unit digits for a currency (USD 2, JPY 0, KWD 3); 2 if unknown. */
function minorUnitDigits(currency: string): number {
  try {
    return (
      new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions()
        .maximumFractionDigits ?? 2
    );
  } catch {
    return 2;
  }
}

/** Major-unit decimal string → integer minor units, using the stated precision. */
function moneyToMinor(m: WhopMoney): number | null {
  const n = Number(m.amount);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 10 ** m.decimals);
}

export class WhopProvider implements PaymentProvider {
  readonly name = 'whop';
  private apiKey: string;
  private accountId: string | null;
  private apiBase: string;
  private webOrigin: string;

  constructor(config: ProviderConfig) {
    // The caller populates siteId from
    // `integration.providerAccountId`. It may be absent (the connect form does
    // not ask for it); operations that need it resolve it lazily, so webhook
    // verification never depends on it.
    this.accountId = config.siteId ?? null;
    this.apiKey = config.apiKey;
    const env = config.environment === 'test' ? ENDPOINTS.test : ENDPOINTS.live;
    this.apiBase = env.api;
    this.webOrigin = env.web;
  }

  async createDiscount(params: CreateDiscountParams): Promise<ProviderDiscount> {
    const promoType: WhopPromoType =
      params.discountType === 'percentage' ? 'percentage' : 'flat_amount';

    const baseCurrency = (params.currency ?? 'usd').toLowerCase();
    // Request `amount_off` for a percentage promo is the percent (spec example:
    // amount_off 25 for code AFFILIATE25, read back as 0.25). CreateDiscountParams
    // carries fixed amounts in minor units ("cents"); Whop takes major units, so
    // divide by the currency's own precision (JPY 500 → 500, not 5).
    const amountOff =
      promoType === 'percentage'
        ? params.amount
        : params.amount / 10 ** minorUnitDigits(baseCurrency.toUpperCase());

    const body: Record<string, unknown> = {
      // Prefix so listDiscounts() can recognise GoPayLocal-managed codes.
      code: this.tagCode(params.code),
      account_id: await this.resolveAccountId(),
      promo_type: promoType,
      amount_off: amountOff,
      // Required. PPP discounts are not "new users only".
      new_users_only: false,
      // Required. Billing intervals the discount lasts; we send 0 for a
      // permanent PPP price (see the live check in the provider report).
      promo_duration_months: 0,
      // Required, even for percentage promos.
      base_currency: baseCurrency,
      // Whop's dashboard defaults are one-per-customer and a one-month expiry;
      // a PPP code is a standing regional price, so state every eligibility
      // rule explicitly rather than inherit unknown API defaults.
      one_per_customer: false,
      churned_users_only: false,
      existing_memberships_only: false,
      expires_at: params.expiresAt ?? null,
    };

    // Scope to specific variants when provided (variant ids are `plan_…`).
    if (params.productIds && params.productIds.length > 0) {
      body.variant_ids = params.productIds;
    }

    // Usage cap maps to `stock`; otherwise allow unlimited uses (the dashboard
    // default is a 100-use limit).
    if (params.maxRedemptions && params.maxRedemptions > 0) {
      body.stock = params.maxRedemptions;
      body.unlimited_stock = false;
    } else {
      body.unlimited_stock = true;
    }

    const promo = await this.request<WhopPromoCode>('POST', '/promo_codes', body);

    return {
      providerDiscountId: promo.id,
      // Whop's stored code is what customers type (its examples read back
      // lowercase); fall back to what we sent.
      code: promo.code ?? this.tagCode(params.code),
      discountPercent: promoType === 'percentage' ? params.amount : 0,
      provider: this.name,
    };
  }

  async deleteDiscount(discountId: string): Promise<void> {
    // DELETE archives the promo code; returns { id, deleted }.
    await this.request('DELETE', `/promo_codes/${encodeURIComponent(discountId)}`, null);
  }

  async listDiscounts(): Promise<ProviderDiscount[]> {
    const result: ProviderDiscount[] = [];
    const accountId = await this.resolveAccountId();
    let cursor: string | null = null;

    // Cursor pagination: `first` (max 100) + `after` = previous
    // `page_info.end_cursor`; stop when `has_next_page` is false.
    // `status=active`: deleteDiscount only ARCHIVES a code, and the docs don't
    // say whether archived/inactive codes are listed by default; a deleted
    // code must not look live to coupon sync.
    do {
      const query = new URLSearchParams({ account_id: accountId, status: 'active', first: '50' });
      if (cursor) query.set('after', cursor);

      const response = await this.request<WhopListResponse<WhopPromoCode>>(
        'GET',
        `/promo_codes?${query.toString()}`,
        null,
      );

      for (const promo of response.data) {
        // Belt and braces with the status filter (`status` is a required
        // field on list items: active | inactive | archived).
        if (promo.status !== 'active') continue;
        // Only surface GoPayLocal-managed codes. Case-insensitive: Whop's
        // examples return codes lowercased ("AFFILIATE25" → "affiliate25").
        if (!promo.code || !promo.code.toUpperCase().startsWith(GPL_CODE_PREFIX)) continue;

        result.push({
          providerDiscountId: promo.id,
          code: promo.code,
          // Read back as a decimal fraction → percent.
          discountPercent:
            promo.promo_type === 'percentage' ? Math.round(promo.amount_off * 10000) / 100 : 0,
          provider: this.name,
        });
      }

      cursor = response.page_info?.has_next_page ? response.page_info.end_cursor ?? null : null;
    } while (cursor);

    return result;
  }

  async buildCheckoutUrl(params: CheckoutUrlParams): Promise<string> {
    // Create a checkout configuration for the variant; the response carries a
    // ready-to-use `purchase_url`.
    const body: Record<string, unknown> = {
      variant_id: params.productId,
      // Defaults to `payment` at this version; sent explicitly.
      mode: 'payment',
    };
    if (this.accountId) body.account_id = this.accountId;
    if (params.successUrl) body.redirect_url = params.successUrl;
    if (params.metadata) body.metadata = params.metadata;

    const checkout = await this.request<WhopCheckoutConfiguration>(
      'POST',
      '/checkout_configurations',
      body,
    );

    if (!checkout.purchase_url) {
      throw new ProviderError(this.name, 'buildCheckoutUrl', 'No purchase_url returned');
    }

    // purchase_url is absolute in the current spec; resolve defensively.
    const url = new URL(checkout.purchase_url, this.webOrigin);
    // The checkout-configuration API has no promo-code field. `promoCode` is
    // NOT in Whop's current docs; it is appended on the assumption it pre-fills
    // the code and is harmless if ignored (see live check).
    if (params.discountCode) url.searchParams.set('promoCode', params.discountCode);
    if (params.customerEmail) url.searchParams.set('email', params.customerEmail);
    return url.toString();
  }

  // ── Webhooks ──────────────────────────────────────────────────────────────

  async provisionWebhook(
    callbackUrl: string,
  ): Promise<{ endpointId: string; secret: string | null }> {
    const body: Record<string, unknown> = {
      url: callbackUrl,
      events: ['payment.succeeded'],
      // Pin the payload (and envelope) shape so parseRedemption reads exactly
      // the 2026-11-17-2 Payment. NOT `api_version`: rejected since 2026-08-12.
      api_version_date: WHOP_API_VERSION,
      title: 'GoPayLocal Redemptions',
    };
    // Defaults to the API key's own account when omitted.
    if (this.accountId) body.resource_id = this.accountId;

    const res = await this.request<{ id: string; webhook_secret: string | null }>(
      'POST',
      '/webhooks',
      body,
    );
    // `webhook_secret` is returned ONLY in this create response.
    if (!res.webhook_secret) {
      // Without the secret every delivery would fail verification; remove the
      // endpoint rather than leave one we can never authenticate.
      await this.deleteWebhook(res.id).catch(() => {});
      throw new ProviderError(this.name, 'provisionWebhook', 'Whop did not return webhook_secret');
    }
    return { endpointId: res.id, secret: res.webhook_secret };
  }

  async deleteWebhook(endpointId: string): Promise<void> {
    if (!endpointId) return;
    await this.request('DELETE', `/webhooks/${encodeURIComponent(endpointId)}`, null);
  }

  async verifyWebhook(input: WebhookVerifyInput): Promise<boolean> {
    if (!input.secret) return false;
    // 'raw': HMAC key = literal UTF-8 bytes of the `ws_…` secret.
    return verifyStandardWebhook(
      input.rawBody,
      {
        id: input.headers.get('webhook-id'),
        timestamp: input.headers.get('webhook-timestamp'),
        signature: input.headers.get('webhook-signature'),
      },
      input.secret,
      'raw',
    );
  }

  parseRedemption(rawBody: string): RedemptionEvent | null {
    let evt: { id?: string; type?: string; data?: Record<string, any> };
    try {
      evt = JSON.parse(rawBody);
    } catch {
      return null;
    }
    if (evt.type !== 'payment.succeeded' || !evt.data) return null;
    const data = evt.data;

    // Renewals and plan changes re-apply the membership's promo code; only the
    // purchase that applied it is a redemption.
    if (
      typeof data.billing_reason === 'string' &&
      NON_REDEMPTION_BILLING_REASONS.has(data.billing_reason)
    ) {
      return null;
    }

    // Pinned (2026-11-17-2) payload: `promo_code_id`. Webhooks created before
    // pinning are unpinned ("tracking the current payload shape", spec: POST
    // /webhooks `api_version_date`), so they may deliver this shape too. The
    // embedded `promo_code: { id, code }` / float `total` fallback is the
    // original shape the previous implementation assumed; Whop's docs do not
    // publish that payload schema, so the fallback is NOT doc-verified.
    const legacyPromo = data.promo_code as { id?: string; code?: string } | undefined;
    const promoId: string | null =
      (typeof data.promo_code_id === 'string' && data.promo_code_id) ||
      (legacyPromo && typeof legacyPromo === 'object' && typeof legacyPromo.id === 'string'
        ? legacyPromo.id
        : null);
    const code: string | null =
      legacyPromo && typeof legacyPromo === 'object' && typeof legacyPromo.code === 'string'
        ? legacyPromo.code
        : null;
    if (!code && !promoId) return null; // no promo applied

    // `total`: "the price after discounts, plus any tax added on top"
    // (account-facing; excludes buyer fees). Not `amount_after_fees` (net).
    let chargedMinor: number | null = null;
    let currency: string | null = typeof data.currency === 'string' ? data.currency : null;
    if (isMoney(data.total)) {
      chargedMinor = moneyToMinor(data.total);
      currency = data.total.currency ?? currency;
    } else if (typeof data.total === 'number') {
      // Original (unpinned) shape: float in major units.
      chargedMinor = Math.round(data.total * 100);
    }

    // Tax (https://docs.whop.com/api-reference/payments/retrieve-payment):
    // tax_amount "The sales tax or VAT collected. Null when no tax applied";
    // tax_behavior "Whether `tax_amount` was added on top of the price
    // (`exclusive`) or was already inside it (`inclusive`)". Either way the
    // tax is inside `total` (exclusive: "plus any tax added on top").
    let taxMinor: number | null = null;
    if (isMoney(data.total)) {
      if (data.tax_amount == null) taxMinor = 0;
      else if (isMoney(data.tax_amount) && data.tax_amount.currency === data.total.currency) {
        taxMinor = moneyToMinor(data.tax_amount);
      }
    }

    // Pre-tax discount = subtotal ("The price before discounts, tax and fees")
    // minus the pre-tax total. Only computed when that is unambiguous: no tax,
    // or exclusive tax (the price, so the subtotal, has no tax in it). With
    // inclusive tax the docs don't say whether `subtotal` contains it, so the
    // handler back-calculates from total − tax instead.
    let discountMinor: number | null = null;
    if (
      isMoney(data.subtotal) &&
      isMoney(data.total) &&
      data.subtotal.currency === data.total.currency &&
      taxMinor != null &&
      (taxMinor === 0 || data.tax_behavior === 'exclusive')
    ) {
      const sub = moneyToMinor(data.subtotal);
      const tot = moneyToMinor(data.total);
      if (sub !== null && tot !== null) {
        const d = sub - (tot - taxMinor);
        if (d > 0) discountMinor = d;
      }
    }

    return {
      // One redemption per payment; Whop retries keep the same payment id.
      eventId: typeof data.id === 'string' ? data.id : typeof evt.id === 'string' ? evt.id : '',
      code,
      providerCouponId: promoId,
      providerPromoCodeId: promoId,
      chargedAmountCents: chargedMinor,
      // The original float `total` shape has no tax information: unknown.
      taxAmountCents: taxMinor,
      discountAmountCents: discountMinor,
      currency: currency ? currency.toUpperCase() : null,
    };
  }

  // ── Internal Helpers ────────────────────────────────────────────────────

  /** Prefix a caller-supplied code so we can recognise it later. Idempotent. */
  private tagCode(code: string): string {
    return code.toUpperCase().startsWith(GPL_CODE_PREFIX) ? code : `${GPL_CODE_PREFIX}${code}`;
  }

  /** The Whop account (biz_…) id: configured, or looked up once from the key. */
  private async resolveAccountId(): Promise<string> {
    if (this.accountId) return this.accountId;
    let me: { id?: string };
    try {
      me = await this.request<{ id?: string }>('GET', '/accounts/me', null);
    } catch (err) {
      if (err instanceof ProviderError) {
        throw new ProviderError(
          this.name,
          'init',
          'Whop account id (biz_…) is not configured and could not be looked up ' +
            `(${err.message}). Add the account id to the integration, or give the API key the company:balance:read permission.`,
          err.statusCode,
          err.providerErrorCode,
        );
      }
      throw err;
    }
    if (!me.id) {
      throw new ProviderError(this.name, 'init', 'GET /accounts/me returned no account id');
    }
    this.accountId = me.id;
    return me.id;
  }

  private async request<T>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    body: Record<string, unknown> | null,
  ): Promise<T> {
    const url = `${this.apiBase}${path}`;

    const init: RequestInit = {
      method,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        Accept: 'application/json',
        'Api-Version-Date': WHOP_API_VERSION,
      },
    };

    if (body && (method === 'POST' || method === 'PUT')) {
      (init.headers as Record<string, string>)['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }

    let response: Response;
    try {
      response = await fetch(url, init);
    } catch (err) {
      throw new ProviderError(
        this.name,
        `${method} ${path}`,
        `Network error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    if (!response.ok) {
      const errorBody = (await response.json().catch(() => ({}))) as WhopErrorBody;
      // Errors are `{ error: { type, message, code? } }`: `type` is the
      // machine-readable code, `code` a more specific reason when present.
      const message =
        errorBody.error?.message ?? errorBody.message ?? `HTTP ${response.status}`;
      const code = errorBody.error?.code ?? errorBody.error?.type ?? undefined;

      if (response.status === 401 || response.status === 403) {
        throw new ProviderAuthError(this.name, message);
      }

      if (response.status === 404) {
        throw new ProviderNotFoundError(this.name, 'resource', path);
      }

      throw new ProviderError(this.name, `${method} ${path}`, message, response.status, code);
    }

    // 204 No Content (and empty bodies) — nothing to parse.
    if (response.status === 204) {
      return {} as T;
    }

    return (await response.json()) as T;
  }
}
