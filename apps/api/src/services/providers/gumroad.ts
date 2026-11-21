// ── Gumroad Provider ────────────────────────────────────────────────────────
// Integration with Gumroad for PPP discount management.
//
// Sources (checked Nov 2026). Gumroad's docs are rendered from the open
// antiwork/gumroad repo, so the doc source and the server code are cited together:
//   • API docs: https://gumroad.com/api
//     (app/javascript/components/ApiDocumentation/Endpoints/*.tsx,
//      app/javascript/components/ApiDocumentation/responseFieldDefinitions.ts)
//   • Ping docs: https://gumroad.com/ping  (app/javascript/pages/Public/Ping.tsx)
//   • Help center: https://gumroad.com/help/article/270-url-parameters,
//     https://gumroad.com/help/article/128-discount-codes
//   • Server: app/controllers/api/v2/{base,offer_codes,links,sales,
//     resource_subscriptions}_controller.rb, app/models/{offer_code,purchase,link,
//     resource_subscription}.rb, config/currencies.json
//
// REST base https://api.gumroad.com/v2. Docs show the token as an `access_token`
// param; Doorkeeper (Gumroad's OAuth server, no `access_token_methods` override in
// config/initializers/doorkeeper.rb) also accepts `Authorization: Bearer`, which is
// sent here so the token never appears in a URL.
//
// Offer codes (https://gumroad.com/api#offer-codes):
//   • Created per product: POST /products/:product_id/offer_codes with form params
//     `name` (the code), `amount_off`, `offer_type` ("cents" | "percent", default
//     "cents"), `max_purchase_count`, `universal` ("true" applies the code to every
//     product). A universal code is still created under some product id.
//   • Percent codes store an integer percent (`amount_off.to_i`).
//   • Response object: `id`, `name` (the code), `universal`, `times_used`, and
//     `percent_off` (percent codes) or `amount_cents` (fixed codes).
//   • Code charset: letters (incl. accented Latin), digits, `-`, `_`
//     (OfferCode code format validation). Universal codes must be unique per seller.
//   • A universal code is rejected if it would push ANY product below the minimum
//     price (OfferCode#validate_price_after_discount). That surfaces here as a
//     success:false ProviderError on create.
//   • Delete: DELETE /products/:product_id/offer_codes/:id. Our stored id is
//     "productId:offerCodeId", where productId is the product the code was created
//     under ("anchor"). Gumroad finds a universal code from ANY of the seller's
//     products (Link#find_offer_code_by_external_id), so a deleted anchor is
//     recoverable.
//   • Store-wide GET/PUT /offer_codes(/:id) exist, but there is no store-wide
//     create or delete, and the store-wide list carries no product ids.
//
// Errors: docs list 401/402/404/429/5xx, but v2 controllers answer "not found" as
// HTTP 200 + { success: false, message: "The <object> was not found." }
// (base_controller#error_with_object, with a TODO to switch to 404). Both forms map
// to ProviderNotFoundError here.
//
// Products: GET /products → { success, products[], next_page_key?, next_page_url? },
// newest first, cursor param `page_key`. Each product has `id`, `name`, `short_url`,
// `currency` (lower-case ISO, e.g. "usd") and `price` in the currency's minor unit.
// For Gumroad's single-unit currencies (JPY, VND in config/currencies.json) that
// minor unit is the whole unit. KRW is NOT single-unit on Gumroad.
//
// ── Webhooks ────────────────────────────────────────────────────────────────
// Resource subscriptions (https://gumroad.com/api#resource-subscriptions):
//   PUT /resource_subscriptions {resource_name, post_url} creates (not an upsert),
//   GET /resource_subscriptions?resource_name=… lists, DELETE /resource_subscriptions/:id
//   removes (only from the OAuth application that created it).
// Pings (https://gumroad.com/ping):
//   • Form-urlencoded POST (JSON for zapier.com hosts). Resource-subscription pings
//     are NOT signed: the optional X-Gumroad-Signature covers only the seller's own
//     Ping URL. Authenticity therefore rests on (a) the unguessable integration id in
//     the URL and (b) re-reading the sale through the authenticated API, as the Ping
//     docs themselves recommend ("treat a ping as a trigger rather than as data").
//   • 5 s to respond. 499/500/502/503/504 are retried (about 1 min, 3 min, 10 min,
//     1 h); other statuses, connection errors and timeouts are not.
//   • `price` and every other amount is USD cents. `currency` is only the product's
//     listing currency.
// Sale read-back (GET /sales/:id, https://gumroad.com/api#sales):
//   • Scoped to the token's seller (sales_controller#show uses
//     current_resource_owner.sales), so a hit proves the sale is this merchant's.
//   • `id` is the canonical sale id. `price` is USD cents ("canonical fields like
//     `price` keep their USD accounting meaning"). `tip_cents` is USD and included in
//     price. `offer_code` is an object { code?, name, displayed_amount_off } (the docs
//     example has only `name`). `recurring_charge` is true for membership renewals,
//     and `is_gift_receiver_purchase` marks the gift copy. `currency` (v2) is the
//     sale's display currency, NOT the unit of `price`.

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

const GUMROAD_API = 'https://api.gumroad.com';
const GUMROAD_API_BASE = '/v2';

// `providerErrorCode` for a 200 + success:false reply that is not a "not found".
const SUCCESS_FALSE = 'success_false';

// Gumroad's "The <object> was not found." wording (base_controller#error_with_object).
const NOT_FOUND_MESSAGE = /^The (\w+) was not found\.?$/;

// Gumroad currencies whose minor unit is the whole unit (config/currencies.json
// `single_unit: true`). Deliberately NOT the generic ISO zero-decimal list: Gumroad
// stores KRW in hundredths.
const SINGLE_UNIT_CURRENCIES = new Set(['JPY', 'VND']);

// Sale ids are obfuscated base64-ish external ids (e.g. "FO8TXN-dvxYabdavG97Y-Q==").
// Anything else in a ping is junk: rejecting it spends no merchant API quota.
const SALE_ID_PATTERN = /^[A-Za-z0-9_\-+/=]{1,64}$/;

// Offer-code object as returned by the Gumroad v2 API (`as_json_for_api`).
interface GumroadOfferCode {
  id: string;
  name: string; // the offer CODE (Gumroad returns `code` as `name`)
  max_purchase_count?: number | null;
  universal?: boolean;
  times_used?: number;
  percent_off?: number; // percentage codes: integer percent (e.g. 20)
  amount_cents?: number; // fixed codes: minor units of the product currency
}

interface GumroadResourceSubscription {
  id: string;
  resource_name?: string;
  post_url?: string;
}

interface GumroadProduct {
  id: string;
  name: string;
  short_url: string;
  price?: number; // minor units of `currency`
  currency?: string; // lower-case ISO code
  published?: boolean;
}

// The subset of GET /v2/sales/:id we rely on.
interface GumroadSale {
  id?: string;
  price?: number | string;
  tip_cents?: number | string;
  shipping_cents?: number | string;
  tax_cents?: number | string;
  buyer_presentment?: {
    seller_tax_cents?: number | string;
    gumroad_tax_cents?: number | string;
  } | null;
  refunded?: boolean | string;
  recurring_charge?: boolean | string;
  is_gift_receiver_purchase?: boolean | string;
  offer_code?: string | { code?: string; name?: string } | null;
}

export class GumroadProvider implements PaymentProvider {
  readonly name = 'gumroad';
  private accessToken: string;

  constructor(config: ProviderConfig) {
    this.accessToken = config.apiKey;
  }

  async createDiscount(params: CreateDiscountParams): Promise<ProviderDiscount> {
    try {
      const universal = !params.productIds || params.productIds.length === 0;

      // Offer codes are created under a product. A universal code applies to every
      // product but still needs *a* product id to anchor the request.
      let productId: string;
      if (!universal) {
        productId = params.productIds![0]!;
      } else {
        const products = await this.fetchAllProducts();
        if (products.length === 0) {
          throw new ProviderError(
            this.name,
            'createDiscount',
            'Gumroad requires at least one product to create an offer code, but the account has none',
          );
        }
        productId = products[0]!.id;
      }

      const body = new URLSearchParams({ name: params.code });

      if (params.discountType === 'percentage') {
        body.set('offer_type', 'percent');
        body.set('amount_off', String(Math.round(params.amount)));
      } else {
        // Documented form: offer_type "cents" + amount_off in cents. Gumroad takes
        // the currency from the product (`currency_type: @product.price_currency_type`).
        body.set('offer_type', 'cents');
        body.set('amount_off', String(Math.round(params.amount)));
      }

      if (params.maxRedemptions) {
        body.set('max_purchase_count', String(params.maxRedemptions));
      }

      if (universal) {
        body.set('universal', 'true');
      }

      const response = await this.request<{ offer_code: GumroadOfferCode }>(
        'POST',
        `/products/${encodeURIComponent(productId)}/offer_codes`,
        body,
      );

      return {
        // Encode the anchoring product id so deleteDiscount can address it.
        providerDiscountId: `${productId}:${response.offer_code.id}`,
        code: response.offer_code.name,
        discountPercent: this.discountPercentOf(response.offer_code),
        provider: this.name,
      };
    } catch (err) {
      throw this.handleError('createDiscount', err);
    }
  }

  async deleteDiscount(discountId: string): Promise<void> {
    try {
      const [productId, offerCodeId] = this.parseDiscountId(discountId);

      try {
        await this.deleteOfferCode(productId, offerCodeId);
        return;
      } catch (err) {
        if (!this.isNotFound(err, 'product')) throw err;
      }

      // The anchor product is gone. A universal code still lives on the seller's
      // account and Gumroad finds it from any other product, so retry through one.
      // A product-scoped code died with its product, which the retry reports as
      // "offer_code was not found".
      const products = await this.fetchAllProducts();
      const other = products.find((p) => p.id !== productId);
      if (!other) {
        throw new ProviderNotFoundError(this.name, 'offer_code', offerCodeId);
      }
      await this.deleteOfferCode(other.id, offerCodeId);
    } catch (err) {
      throw this.handleError('deleteDiscount', err);
    }
  }

  async listDiscounts(): Promise<ProviderDiscount[]> {
    try {
      // Offer codes are listed per product, so iterate every product.
      // NOTE: a universal code's id here uses the first product that lists it,
      // which is not necessarily the anchor it was created under (products are
      // newest first). Compare Gumroad discounts on the part after ':'.
      const products = await this.fetchAllProducts();
      const result: ProviderDiscount[] = [];
      // Universal codes come back under every product; keep the first sighting.
      const seenOfferIds = new Set<string>();

      for (const product of products) {
        let offersResponse: { offer_codes?: GumroadOfferCode[] };
        try {
          offersResponse = await this.request<{ offer_codes?: GumroadOfferCode[] }>(
            'GET',
            `/products/${encodeURIComponent(product.id)}/offer_codes`,
            null,
          );
        } catch (err) {
          // A product that vanished or is unreadable mid-listing is skipped.
          // Anything else (auth, rate limit, outage) must surface.
          if (
            err instanceof ProviderNotFoundError ||
            (err instanceof ProviderError && err.providerErrorCode === SUCCESS_FALSE)
          ) {
            continue;
          }
          throw err;
        }

        for (const offer of offersResponse.offer_codes ?? []) {
          if (seenOfferIds.has(offer.id)) continue;
          seenOfferIds.add(offer.id);

          result.push({
            providerDiscountId: `${product.id}:${offer.id}`,
            code: offer.name,
            discountPercent: this.discountPercentOf(offer),
            provider: this.name,
          });
        }
      }

      return result;
    } catch (err) {
      throw this.handleError('listDiscounts', err);
    }
  }

  async listProducts(): Promise<ProviderProduct[]> {
    try {
      const products = await this.fetchAllProducts();
      return products.map((p) => {
        const currency = (p.currency ?? 'usd').toUpperCase();
        return {
          providerProductId: p.id,
          name: p.name,
          // `price` is in the currency's minor unit. ProviderProduct.price is in
          // major units, like the other providers.
          price:
            typeof p.price === 'number'
              ? SINGLE_UNIT_CURRENCIES.has(currency)
                ? p.price
                : p.price / 100
              : null,
          currency,
          url: p.short_url ?? null,
        };
      });
    } catch (err) {
      throw this.handleError('listProducts', err);
    }
  }

  async buildCheckoutUrl(params: CheckoutUrlParams): Promise<string> {
    try {
      const response = await this.request<{ product: GumroadProduct }>(
        'GET',
        `/products/${encodeURIComponent(params.productId)}`,
        null,
      );

      const url = new URL(response.product.short_url);

      // Documented discount link: "{product URL}/{YourDiscountCode}"
      // (help article 270-url-parameters). The page reads the code from that path
      // segment (route /l/:id/:code) and carries it into checkout with ?wanted=true.
      if (params.discountCode) {
        url.pathname = `${url.pathname.replace(/\/+$/, '')}/${encodeURIComponent(params.discountCode)}`;
      }

      // ?wanted=true goes straight to checkout; ?email= prefills the buyer email.
      url.searchParams.set('wanted', 'true');
      if (params.customerEmail) {
        url.searchParams.set('email', params.customerEmail);
      }

      return url.toString();
    } catch (err) {
      throw this.handleError('buildCheckoutUrl', err);
    }
  }

  // ── Webhooks ──────────────────────────────────────────────────────────────

  async provisionWebhook(callbackUrl: string): Promise<ProvisionedWebhook> {
    // PUT always creates a NEW subscription. If one already points at this exact
    // URL (provisioning re-run for the same integration), adopt it and drop extras
    // so pings are not delivered twice. Subscriptions on other URLs belong to the
    // seller and are never touched. Listing is best-effort; on failure, create.
    const existing = await this.request<{
      resource_subscriptions?: GumroadResourceSubscription[];
    }>('GET', '/resource_subscriptions?resource_name=sale', null).catch(() => null);

    const ours = (existing?.resource_subscriptions ?? []).filter(
      (sub) => sub.post_url === callbackUrl && sub.id,
    );

    if (ours.length > 0) {
      for (const stale of ours.slice(1)) {
        await this.deleteWebhook(stale.id).catch(() => {});
      }
      return { endpointId: ours[0]!.id, secret: null, adopted: true };
    }

    const body = new URLSearchParams({ resource_name: 'sale', post_url: callbackUrl });
    const res = await this.request<{ resource_subscription?: { id?: string } }>(
      'PUT',
      '/resource_subscriptions',
      body,
    );
    const endpointId = res.resource_subscription?.id;
    if (!endpointId) {
      // An empty id would be stored and silently skip teardown on disconnect.
      throw new ProviderError(
        this.name,
        'provisionWebhook',
        'Gumroad did not return a resource_subscription id',
      );
    }
    // Unsigned: no secret. Authenticity = the unguessable URL + sale re-fetch.
    return { endpointId, secret: null };
  }

  async deleteWebhook(endpointId: string): Promise<void> {
    if (!endpointId) return;
    await this.request('DELETE', `/resource_subscriptions/${encodeURIComponent(endpointId)}`, null);
  }

  async verifyWebhook(_input: WebhookVerifyInput): Promise<boolean> {
    // Resource-subscription pings are UNSIGNED (https://gumroad.com/ping), so there
    // is nothing to verify here. The unguessable :integrationId in the URL (the route
    // already resolved it to a real integration) plus the authenticated sale
    // re-fetch in parseRedemption are the authenticity boundary.
    return true;
  }

  /**
   * Turn a sale ping into a redemption using ONLY the authenticated sale read-back.
   *
   * Returns null when the ping is not a first-time purchase with an offer code from
   * this merchant (junk, wrong resource, foreign or refunded sale, renewal, gift copy,
   * no code, revoked token). Throws a ProviderError when the read-back failed
   * transiently (network, 429, 5xx), so a caller can retry instead of dropping the
   * redemption.
   */
  async parseRedemption(rawBody: string): Promise<RedemptionEvent | null> {
    // The ping is unsigned and fully attacker-controllable. It is trusted for exactly
    // one thing: which sale to look up.
    const fields = this.parsePing(rawBody);
    if (fields.resource_name && fields.resource_name !== 'sale') return null;
    const saleId = fields.sale_id;
    if (!saleId || !SALE_ID_PATTERN.test(saleId)) return null;

    let sale: GumroadSale | undefined;
    try {
      const res = await this.request<{ sale?: GumroadSale }>(
        'GET',
        `/sales/${encodeURIComponent(saleId)}`,
        null,
      );
      sale = res.sale;
    } catch (err) {
      // Permanent: not this merchant's sale (success:false / 404), or the token is
      // revoked (401/403). Retrying cannot change either.
      if (err instanceof ProviderAuthError || err instanceof ProviderNotFoundError) return null;
      if (err instanceof ProviderError && err.providerErrorCode === SUCCESS_FALSE) return null;
      throw this.handleError('parseRedemption', err);
    }
    if (!sale) return null;

    if (isTrue(sale.refunded)) return null;
    // A membership's later charges carry the original offer code. They are
    // renewals, not new redemptions.
    if (isTrue(sale.recurring_charge)) return null;
    // A gift creates a gifter purchase (the redemption) and a $0 receiver copy.
    if (isTrue(sale.is_gift_receiver_purchase)) return null;

    // Authoritative code from the sale only. It matches our coupon's stored code
    // (we store the `name` Gumroad returned on create).
    const oc = sale.offer_code;
    const code: string | null =
      typeof oc === 'string' ? oc : (oc?.code ?? oc?.name ?? null);
    if (!code) return null;

    // `price` is USD cents and includes any tip and shipping (USD cents too).
    // Strip both so the charged amount is the discounted product price.
    const price = toNumber(sale.price);
    const tip = toNumber(sale.tip_cents) ?? 0;
    const shipping = toNumber(sale.shipping_cents) ?? 0;
    const charged = price != null ? Math.max(0, price - tip - shipping) : null;
    const tax = gumroadTaxInPrice(sale);

    return {
      // Dedupe on Gumroad's canonical id, not the ping's spelling of it.
      eventId: typeof sale.id === 'string' && sale.id ? sale.id : saleId,
      code,
      providerCouponId: null,
      providerPromoCodeId: null,
      chargedAmountCents: charged,
      taxAmountCents: tax,
      discountAmountCents: null,
      currency: 'USD',
    };
  }

  // ── Internal Helpers ────────────────────────────────────────────────────

  private async deleteOfferCode(productId: string, offerCodeId: string): Promise<void> {
    await this.request(
      'DELETE',
      `/products/${encodeURIComponent(productId)}/offer_codes/${encodeURIComponent(offerCodeId)}`,
      null,
    );
  }

  private isNotFound(err: unknown, object: string): boolean {
    return err instanceof ProviderNotFoundError && err.message.includes(`${object} '`);
  }

  /**
   * Derive a 0-100 discount percentage from an offer code. Percentage codes
   * expose `percent_off`; fixed-amount codes have no percentage, so 0.
   */
  private discountPercentOf(offer: GumroadOfferCode): number {
    return typeof offer.percent_off === 'number' ? offer.percent_off : 0;
  }

  /**
   * Fetch every product on the account, following Gumroad's `next_page_key`
   * cursor pagination (param: `page_key`).
   */
  private async fetchAllProducts(): Promise<GumroadProduct[]> {
    const all: GumroadProduct[] = [];
    let pageKey: string | undefined;

    do {
      const path =
        pageKey !== undefined
          ? `/products?page_key=${encodeURIComponent(pageKey)}`
          : '/products';

      const response = await this.request<{
        products?: GumroadProduct[];
        next_page_key?: string | null;
      }>('GET', path, null);

      for (const product of response.products ?? []) {
        all.push(product);
      }

      pageKey = response.next_page_key ?? undefined;
    } while (pageKey);

    return all;
  }

  private parseDiscountId(discountId: string): [string, string] {
    const idx = discountId.indexOf(':');
    if (idx <= 0 || idx >= discountId.length - 1) {
      throw new ProviderError(
        this.name,
        'parseDiscountId',
        `Invalid discount ID format: '${discountId}'. Expected 'productId:offerCodeId'.`,
      );
    }
    return [discountId.slice(0, idx), discountId.slice(idx + 1)];
  }

  /** Parse a Gumroad ping body: form-urlencoded (default) or JSON (zapier.com hosts). */
  private parsePing(rawBody: string): Record<string, string> {
    try {
      const json = JSON.parse(rawBody);
      if (json && typeof json === 'object') {
        const out: Record<string, string> = {};
        for (const [k, v] of Object.entries(json)) {
          out[k] = typeof v === 'string' ? v : String(v);
        }
        return out;
      }
    } catch {
      // Not JSON; fall through to form parsing.
    }
    const out: Record<string, string> = {};
    for (const [k, v] of new URLSearchParams(rawBody)) out[k] = v;
    return out;
  }

  private async request<T>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    body: URLSearchParams | null,
  ): Promise<T> {
    // Join base ('/v2') with the relative path. A leading-slash path passed to
    // `new URL(path, origin)` would drop the '/v2' segment, so build manually.
    const url = new URL(GUMROAD_API_BASE + path, GUMROAD_API);

    const init: RequestInit = {
      method,
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        Accept: 'application/json',
      },
    };

    if (body && (method === 'POST' || method === 'PUT')) {
      (init.headers as Record<string, string>)['Content-Type'] =
        'application/x-www-form-urlencoded';
      init.body = body.toString();
    }

    const response = await fetch(url.toString(), init);

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      const message = this.messageOf(errorText) || errorText || `HTTP ${response.status}`;

      if (response.status === 401 || response.status === 403) {
        throw new ProviderAuthError(this.name, message);
      }

      if (response.status === 404) {
        throw new ProviderNotFoundError(this.name, 'resource', path);
      }

      throw new ProviderError(this.name, `${method} ${path}`, message, response.status);
    }

    const data = (await response.json()) as { success: boolean; message?: string } & T;

    if (!data.success) {
      const message = data.message ?? 'Gumroad API returned success: false';
      const notFound = NOT_FOUND_MESSAGE.exec(message);
      if (notFound) {
        throw new ProviderNotFoundError(this.name, notFound[1]!, path);
      }
      throw new ProviderError(this.name, `${method} ${path}`, message, response.status, SUCCESS_FALSE);
    }

    return data as T;
  }

  /** Pull Gumroad's human-readable `message` out of an error body, if present. */
  private messageOf(body: string): string | null {
    try {
      const json = JSON.parse(body);
      if (typeof json?.message === 'string') return json.message;
      if (typeof json?.error === 'string') return json.error;
      return null;
    } catch {
      return null;
    }
  }

  private handleError(operation: string, err: unknown): ProviderError {
    if (err instanceof ProviderError) return err;
    const message = err instanceof Error ? err.message : String(err);
    return new ProviderError(this.name, operation, message);
  }
}

function isTrue(v: unknown): boolean {
  return v === true || v === 'true';
}

function toNumber(v: unknown): number | null {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * The tax (USD cents) contained in a sale's `price`, or null when it can't be
 * told (contract C3). From Gumroad's open-source app (antiwork/gumroad,
 * app/models/purchase.rb and the API docs' SALE_FIELDS):
 *  - `price` includes the tax the SELLER is responsible for ("either intrinsic
 *    or added on to price_cents"), but not the tax Gumroad remits itself
 *    (total_transaction_cents = price_cents + gumroad_tax_cents).
 *  - the sale's `tax_cents` is Gumroad's tax when Gumroad is responsible, else
 *    the seller's tax.
 *  - `buyer_presentment` (only on buyer-currency charges) splits the two into
 *    `seller_tax_cents` and `gumroad_tax_cents`.
 * So: tax_cents 0 ⇒ no tax in price. Otherwise only buyer_presentment says
 * whose tax it was; without it the answer is unknown.
 */
function gumroadTaxInPrice(sale: GumroadSale): number | null {
  const taxCents = toNumber(sale.tax_cents);
  if (taxCents == null) return null;
  if (taxCents === 0) return 0;
  const bp = sale.buyer_presentment;
  if (!bp || typeof bp !== 'object') return null;
  const sellerTax = toNumber(bp.seller_tax_cents);
  const gumroadTax = toNumber(bp.gumroad_tax_cents);
  if (sellerTax != null && sellerTax > 0) return taxCents; // seller's tax, inside price
  if (gumroadTax != null && gumroadTax > 0) return 0; // Gumroad's tax, on top of price
  return null;
}
