// ── Paddle Provider ─────────────────────────────────────────────────────────
// Integration with Paddle Billing (API version 1, NOT Paddle Classic) for PPP
// discount management.
// Docs: https://developer.paddle.com/api-reference/overview
//
// SDK: @paddle/paddle-node-sdk@3.12.0. It has no dependencies, calls
// globalThis.fetch, and its `workerd` export is the edge build, which takes
// randomUUID (X-Transaction-ID header) from Web Crypto. SDK 1.x went through
// node-fetch and relied on wrangler's unenv shim for it; that is gone. The
// calls below have the same wire format as under 1.x (paddle.test.ts asserts
// the outgoing HTTP, not SDK internals).
//
// Request facts (each covered by paddle.test.ts on the outgoing HTTP request):
//   • POST /discounts: `amount` is always a string. Percentage => plain percent
//     ("30"); flat => lowest currency denomination. `currency_code` is required
//     for flat and omitted for percentage. `code` must match ^[a-zA-Z0-9]{1,32}$.
//     `usage_limit` is the total redemption cap (maps maxRedemptions);
//     `maximum_recurring_intervals` caps recurring billing periods and is NOT a
//     redemption limit. `restrict_to` takes price (pri_) or product (pro_) ids.
//     https://developer.paddle.com/api-reference/discounts/create-discount
//   • Discounts can't be deleted; PATCH status=archived instead.
//   • POST /transactions has no inline email field (only customer_id). The
//     returned `checkout.url` is the merchant's DEFAULT PAYMENT LINK page +
//     `?_ptxn=<txn id>`, not a Paddle-hosted page; without a default payment link
//     Paddle refuses to create the transaction
//     (error transaction_default_checkout_url_not_set).
//
// ── Webhook signature scheme (implemented in verifyWebhook) ──────────────────
// https://developer.paddle.com/webhooks/about/signature-verification
//   • Header `Paddle-Signature: ts=<unixSeconds>;h1=<hex>` — semicolon-separated
//     key=value pairs. "Signatures contain at least one h1"; during secret
//     rotation more than one h1 is sent, so any matching h1 is accepted.
//   • Signed content: `${ts}:${rawRequestBody}` (exact unparsed body).
//   • HMAC-SHA256 keyed with the destination's endpoint secret
//     (`pdl_ntfset_...`, used as raw key bytes), hex output.
//   • The SDK's verifier is not used: its default tolerance is five seconds
//     ("Our SDKs have a default tolerance of five seconds", same page).
//     lib/webhook-verify.ts runs the same scheme on WebCrypto with a 300s
//     window.

import { Paddle, Environment, LogLevel } from '@paddle/paddle-node-sdk';
import type { CurrencyCode } from '@paddle/paddle-node-sdk';
import type {
  PaymentProvider,
  CreateDiscountParams,
  CheckoutUrlParams,
  ProviderDiscount,
  ProviderProduct,
  ProviderConfig,
  WebhookVerifyInput,
  RedemptionEvent,
} from './types';
import { ProviderError, ProviderAuthError, ProviderNotFoundError } from './types';
import { verifyPaddleSignature } from '../../lib/webhook-verify';
import { ZERO_DECIMAL } from '../redemption.service';

// Paddle's error body carries a string `code` but SDK < 3.12's ApiError exposes
// no HTTP status, so map the codes callers branch on. Codes from
// https://developer.paddle.com/errors (shared/*).
const PADDLE_ERROR_CODE_STATUS: Record<string, number> = {
  not_found: 404,
  forbidden: 403,
  authentication_missing: 401,
  authentication_malformed: 401,
  invalid_token: 401,
  invalid_access_token: 401,
};

// Transaction origins Paddle itself counts as a discount redemption: a checkout
// or an API-created transaction. Renewals (`subscription_recurring`), midcycle
// changes and one-time charges against a subscription are not redemptions
// (usage_limit / times_used semantics in create-discount docs), and with a
// recurring discount they still carry `discount_id`.
const REDEMPTION_ORIGINS = new Set(['web', 'api']);

/** Paddle discount codes: letters and digits only, 1-32 chars. */
export function normalizePaddleCode(code: string): string {
  return code.replace(/[^a-zA-Z0-9]/g, '').slice(0, 32);
}

/**
 * The key says which environment it belongs to (`pdl_live_apikey_...` /
 * `pdl_sdbx_apikey_...`, https://developer.paddle.com/api-reference/about/authentication).
 * Trust it over the caller's hint: the webhook and connect routes always pass
 * 'live', so a sandbox key would otherwise be sent to the production API.
 * Legacy keys carry no prefix and fall back to the hint.
 */
function environmentFor(config: ProviderConfig): Environment {
  if (config.apiKey.startsWith('pdl_sdbx_')) return Environment.sandbox;
  if (config.apiKey.startsWith('pdl_live_')) return Environment.production;
  return config.environment === 'live' ? Environment.production : Environment.sandbox;
}

export class PaddleProvider implements PaymentProvider {
  readonly name = 'paddle';
  private paddle: Paddle;

  constructor(config: ProviderConfig) {
    this.paddle = new Paddle(config.apiKey, {
      environment: environmentFor(config),
      // 1.x defaults to logging every request; 3.x changed the default to error.
      logLevel: LogLevel.error,
    });
  }

  async createDiscount(params: CreateDiscountParams): Promise<ProviderDiscount> {
    const isPercentage = params.discountType === 'percentage';
    const code = normalizePaddleCode(params.code);

    if (!code) {
      throw new ProviderError(this.name, 'createDiscount', `Code '${params.code}' has no alphanumeric characters`);
    }
    if (!isPercentage && !params.currency) {
      // Paddle requires currencyCode for flat discounts; fail fast with a clear
      // message rather than letting the API reject it opaquely.
      throw new ProviderError(
        this.name,
        'createDiscount',
        'currency is required for fixed (flat) Paddle discounts',
      );
    }

    try {
      const discount = await this.paddle.discounts.create({
        description: params.name,
        // DiscountType union: 'flat' | 'flat_per_seat' | 'percentage'.
        type: isPercentage ? 'percentage' : 'flat',
        // `amount` is always a string. Percentage => plain percent ("30").
        // Flat => amount in the currency's smallest unit (cents).
        amount: String(params.amount),
        code,
        enabledForCheckout: true,
        // PPP pricing should hold for the life of a subscription, matching the
        // Stripe (`duration: forever`), Chargebee, Polar and Whop adapters.
        // `recur` defaults to false (first billing period only);
        // maximum_recurring_intervals = null means "recurs forever".
        recur: true,
        maximumRecurringIntervals: null,
        // currencyCode is required for flat and must be omitted for percentage.
        ...(isPercentage
          ? {}
          : { currencyCode: params.currency!.toUpperCase() as CurrencyCode }),
        // Total redemption cap → usageLimit (NOT maximumRecurringIntervals).
        ...(params.maxRedemptions ? { usageLimit: params.maxRedemptions } : {}),
        // Restrict the discount to specific Paddle price/product ids when given.
        ...(params.productIds && params.productIds.length > 0
          ? { restrictTo: params.productIds }
          : {}),
        ...(params.expiresAt ? { expiresAt: params.expiresAt } : {}),
      });

      return {
        providerDiscountId: discount.id,
        // Discount.code is string | null; fall back to the code we sent.
        code: discount.code ?? code,
        // Discount.amount is a string; percentage discounts carry the percent.
        discountPercent: isPercentage ? Number(discount.amount) : 0,
        provider: this.name,
      };
    } catch (err) {
      throw this.handleError('createDiscount', err);
    }
  }

  async deleteDiscount(discountId: string): Promise<void> {
    // Paddle does not support hard deletion — archive instead.
    try {
      await this.paddle.discounts.archive(discountId);
    } catch (err) {
      throw this.handleError('deleteDiscount', err);
    }
  }

  async listDiscounts(): Promise<ProviderDiscount[]> {
    try {
      const result: ProviderDiscount[] = [];
      // list() returns an async-iterable, auto-paginating DiscountCollection.
      // 200 is the documented page maximum; fewer pages = fewer subrequests.
      const collection = this.paddle.discounts.list({ status: ['active'], perPage: 200 });
      const now = Date.now();

      for await (const discount of collection) {
        // Only redeemable discounts (types.ts contract), and status=active is
        // not enough: the documented statuses are only active/archived, and the
        // documented list example returns long-expired discounts as active.
        // expires_at: "Discount can no longer be redeemed after this date has
        // elapsed"; usage_limit is checked "against times_used"
        // (https://developer.paddle.com/api-reference/discounts/list-discounts).
        if (discount.expiresAt && Date.parse(discount.expiresAt) <= now) continue;
        if (discount.usageLimit != null && (discount.timesUsed ?? 0) >= discount.usageLimit) continue;
        result.push({
          providerDiscountId: discount.id,
          code: discount.code ?? '',
          discountPercent:
            discount.type === 'percentage' ? Number(discount.amount) : 0,
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

      // Include catalog prices so we can surface a representative unit price.
      // Price.unitPrice.amount is a string in the currency's lowest denomination.
      const collection = this.paddle.products.list({
        status: ['active'],
        include: ['prices'],
        perPage: 200,
      });

      for await (const product of collection) {
        // `include=prices` isn't documented as active-only; prefer an active one.
        const prices = product.prices ?? [];
        const firstPrice = prices.find((p) => p.status === 'active') ?? prices[0] ?? null;
        const unitPrice = firstPrice?.unitPrice ?? null;
        const currency = unitPrice?.currencyCode ?? null;
        const rawAmount = unitPrice ? Number(unitPrice.amount) : null;

        // Paddle's zero-decimal currencies (decimal_places 0 in
        // /currencies: JPY, KRW, VND, CLP) are all in ZERO_DECIMAL.
        const price =
          rawAmount != null && currency != null
            ? ZERO_DECIMAL.has(currency)
              ? rawAmount
              : rawAmount / 100
            : null;

        products.push({
          providerProductId: product.id,
          name: product.name,
          price,
          currency,
          // Paddle has no public per-product hosted URL; checkout is created
          // per-transaction via buildCheckoutUrl.
          url: null,
        });
      }

      return products;
    } catch (err) {
      throw this.handleError('listProducts', err);
    }
  }

  async buildCheckoutUrl(params: CheckoutUrlParams): Promise<string> {
    try {
      // listProducts hands out product ids (pro_...); a transaction item needs a
      // price id (pri_...).
      let priceId = params.productId;
      if (priceId.startsWith('pro_')) {
        const product = await this.paddle.products.get(priceId, { include: ['prices'] });
        const prices = product.prices ?? [];
        const price = prices.find((p) => p.status === 'active') ?? prices[0];
        if (!price) {
          throw new ProviderError(this.name, 'buildCheckoutUrl', `Product ${priceId} has no prices`);
        }
        priceId = price.id;
      }

      // Transactions take a discount id, not a code: resolve a code if needed.
      let discountId = params.discountId;
      if (!discountId && params.discountCode) {
        for await (const d of this.paddle.discounts.list({
          code: [normalizePaddleCode(params.discountCode)],
          status: ['active'],
        })) {
          discountId = d.id;
          break;
        }
      }

      const transaction = await this.paddle.transactions.create({
        items: [{ priceId, quantity: 1 }],
        ...(discountId ? { discountId } : {}),
        // The create body has no inline customer/email field — only customerId
        // (an existing Paddle customer). We have only an email here, so we omit
        // it; the buyer enters their email on the checkout page.
        ...(params.metadata ? { customData: params.metadata } : {}),
      });

      const url = transaction.checkout?.url;
      if (!url) {
        throw new ProviderError(
          this.name,
          'buildCheckoutUrl',
          'No checkout URL returned from transaction',
        );
      }

      return url;
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
      const setting = await this.paddle.notificationSettings.create({
        description: 'GoPayLocal PPP redemption tracking',
        type: 'url',
        destination: callbackUrl,
        subscribedEvents: ['transaction.completed'],
        includeSensitiveFields: false,
        // Defaults to 'platform', which drops events fired by Paddle's webhook
        // simulator; 'all' keeps real traffic and lets us e2e-test the endpoint.
        trafficSource: 'all',
      });
      return { endpointId: setting.id, secret: setting.endpointSecretKey ?? null };
    } catch (err) {
      throw this.handleError('provisionWebhook', err);
    }
  }

  async deleteWebhook(endpointId: string): Promise<void> {
    // NOTE: before SDK 3.2.1, notificationSettings.delete never throws: it hands
    // the raw fetch Response to handleResponse(), which only looks for a parsed
    // `error` key, so API failures on delete are invisible here. 3.2.1 fixed
    // this ("delete operations were not returning failures correctly").
    try {
      await this.paddle.notificationSettings.delete(endpointId);
    } catch (err) {
      const mapped = this.handleError('deleteWebhook', err);
      if (mapped.statusCode === 404) return; // already gone
      throw mapped;
    }
  }

  async verifyWebhook(input: WebhookVerifyInput): Promise<boolean> {
    if (!input.secret) return false;
    // verifyPaddleSignature parses `ts` and every `h1`, and accepts the header
    // if any h1 matches, so a rotation header (old + new secret) verifies in
    // either order.
    return verifyPaddleSignature(input.rawBody, input.headers.get('paddle-signature'), input.secret);
  }

  parseRedemption(rawBody: string): RedemptionEvent | null {
    let evt: { event_type?: string; event_id?: string; data?: Record<string, any> };
    try {
      evt = JSON.parse(rawBody);
    } catch {
      return null;
    }
    if (evt.event_type !== 'transaction.completed' || !evt.data) return null;
    const data = evt.data;
    // Count only first purchases; renewals of a subscription that holds a
    // recurring discount also complete with `discount_id` set.
    if (!REDEMPTION_ORIGINS.has(data.origin)) return null;
    // The event carries discount_id (dsc_...), not the code — match it against
    // the stored coupon's providerCouponId. Amounts are STRINGS in minor units.
    const providerCouponId: string | null = data.discount_id ?? null;
    if (!providerCouponId) return null; // no discount on this transaction
    // details.totals (transaction.completed payload,
    // https://developer.paddle.com/webhooks/transactions/transaction-completed):
    //   subtotal "before discount, tax, and deductions", discount "Total discount
    //   as a result of any discounts applied", tax "Total tax on the subtotal",
    //   total "after discount and tax", grand_total "after credits but before any
    //   payments", grand_total_tax "Net tax amount included in grand_total".
    // Contract C3: chargedAmountCents = grand_total, taxAmountCents =
    // grand_total_tax, and the discount only when the totals show it is pre-tax
    // (subtotal - discount + tax === total, i.e. tax was charged on the
    // discounted subtotal); otherwise null and the handler back-calculates.
    const totals = data.details?.totals as
      | { subtotal?: string; discount?: string; tax?: string; total?: string; grand_total?: string; grand_total_tax?: string }
      | undefined;
    const amount = (v: string | undefined): number | null => {
      if (v == null || v === '') return null;
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    };
    const grand = amount(totals?.grand_total);
    const grandTax = amount(totals?.grand_total_tax);
    const subtotal = amount(totals?.subtotal);
    const disc = amount(totals?.discount);
    const tax = amount(totals?.tax);
    const total = amount(totals?.total);
    const preTaxDiscount =
      disc != null && (disc === 0 || (subtotal != null && tax != null && total != null && subtotal - disc + tax === total))
        ? disc
        : null;
    return {
      // One redemption per transaction: key on txn_..., which stays the same
      // across retries/replays and any other event about the same transaction.
      eventId:
        typeof data.id === 'string'
          ? data.id
          : typeof evt.event_id === 'string'
            ? evt.event_id
            : '',
      code: null,
      providerCouponId,
      providerPromoCodeId: null,
      chargedAmountCents: grand,
      taxAmountCents: grandTax,
      discountAmountCents: preTaxDiscount,
      currency: typeof data.currency_code === 'string' ? data.currency_code : null,
    };
  }

  private handleError(operation: string, err: unknown): ProviderError {
    if (err instanceof ProviderError) return err;

    const message = err instanceof Error ? err.message : String(err);
    // SDK < 3.12's ApiError exposes no HTTP status at all, only a string `code`,
    // so fall back to mapping that onto the status callers branch on. SDK 3.12
    // added `ApiError.status` (null when there was no response), which wins.
    const code = (err as { code?: unknown })?.code;
    const codeStr = typeof code === 'string' ? code : undefined;
    const status =
      (err as { statusCode?: number; status?: number })?.statusCode ??
      (err as { statusCode?: number; status?: number })?.status ??
      (codeStr ? PADDLE_ERROR_CODE_STATUS[codeStr] : undefined);

    if (status === 401 || status === 403) {
      return new ProviderAuthError(this.name, message);
    }
    if (status === 404) {
      return new ProviderNotFoundError(this.name, 'resource', message);
    }

    return new ProviderError(this.name, operation, message, status, codeStr);
  }
}
