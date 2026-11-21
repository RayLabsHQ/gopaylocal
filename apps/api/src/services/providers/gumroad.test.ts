// Unit tests for the Gumroad provider, with `fetch` mocked. No live calls.
//
// Sources for every request/response shape asserted here (fetched Nov 2026):
//  - API docs, as rendered at https://gumroad.com/api. Their source is in the open
//    antiwork/gumroad repo: app/javascript/components/ApiDocumentation/Endpoints/
//    {OfferCodes,Products,ResourceSubscriptions,Sales}.tsx, Errors.tsx and
//    responseFieldDefinitions.ts.
//  - Ping docs, as rendered at https://gumroad.com/ping (app/javascript/pages/Public/Ping.tsx).
//  - Help center "URL parameters" (https://gumroad.com/help/article/270-url-parameters)
//    and "Discount codes" (https://gumroad.com/help/article/128-discount-codes).
//  - Server behaviour the docs leave out is from the same repo:
//    app/controllers/api/v2/{base,offer_codes,sales}_controller.rb and
//    app/models/purchase.rb (Purchase#as_json, version 2).

import { describe, it, expect, vi, afterEach } from 'vitest';
import { GumroadProvider } from './gumroad';
import { ProviderError, ProviderAuthError, ProviderNotFoundError } from './types';
// Fixture: the GET /v2/sales/:id example from https://gumroad.com/api#sales, trimmed
// and given a percentage offer code. As in the docs example, `offer_code` has only
// `name` and `displayed_amount_off`, with no `code` key.
import saleWithCode from './__fixtures__/gumroad/sale-with-offer-code.json';
// Fixture: the same sale shape for a membership's second charge, where
// `recurring_charge: true` (documented in SALE_FIELDS).
import saleRenewal from './__fixtures__/gumroad/sale-membership-renewal.json';
// Fixture: the GET /v2/products/:id/offer_codes example from https://gumroad.com/api#offer-codes.
import offerCodesList from './__fixtures__/gumroad/offer-codes-list.json';
// Fixture: a "sale" ping. Parameter names come from https://gumroad.com/ping and
// values from the sale above. The test form-encodes it as Gumroad does.
import pingSale from './__fixtures__/gumroad/ping-sale.json';

const TOKEN = 'gr-token-abc';
const API = 'https://api.gumroad.com/v2';

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

type Handler = (call: Call) => Response | Promise<Response>;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Install a fetch mock driven by an ordered list of handlers; records every call. */
function mockFetch(...handlers: Handler[]): Call[] {
  const calls: Call[] = [];
  let i = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers: Record<string, string> = {};
      new Headers(init?.headers).forEach((v, k) => {
        headers[k] = v;
      });
      const call: Call = {
        url: typeof input === 'string' ? input : input.toString(),
        method: init?.method ?? 'GET',
        headers,
        body: typeof init?.body === 'string' ? init.body : undefined,
      };
      calls.push(call);
      const handler = handlers[i++];
      if (!handler) throw new Error(`Unexpected fetch #${i}: ${call.method} ${call.url}`);
      return handler(call);
    }),
  );
  return calls;
}

function provider(): GumroadProvider {
  return new GumroadProvider({ apiKey: TOKEN });
}

function form(obj: Record<string, string>): string {
  return new URLSearchParams(obj).toString();
}

function formBody(call: Call): Record<string, string> {
  return Object.fromEntries(new URLSearchParams(call.body ?? ''));
}

function expectAuthed(call: Call) {
  expect(call.headers['authorization']).toBe(`Bearer ${TOKEN}`);
  expect(call.headers['accept']).toBe('application/json');
}

const product = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  name: `Product ${id}`,
  short_url: `https://sahil.gumroad.com/l/${id.toLowerCase()}`,
  price: 1000,
  currency: 'usd',
  published: true,
  ...extra,
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ── createDiscount ──────────────────────────────────────────────────────────

describe('createDiscount', () => {
  it('creates a universal percent code (how coupon.service calls it) anchored on the first listed product', async () => {
    // GET /v2/products lists newest first (links_controller#index orders created_at desc).
    const calls = mockFetch(
      () => json({ success: true, products: [product('NEWEST'), product('OLDER')] }),
      () =>
        json({
          success: true,
          offer_code: {
            id: 'oc_1==',
            name: 'PPP-IN30-K7QX',
            percent_off: 30,
            max_purchase_count: null,
            universal: true,
            times_used: 0,
          },
        }),
    );

    const result = await provider().createDiscount({
      name: 'PPP IN 30%',
      code: 'PPP-IN30-K7QX',
      discountType: 'percentage',
      amount: 30,
    });

    expect(calls).toHaveLength(2);
    expect(calls[0]!.method).toBe('GET');
    expect(calls[0]!.url).toBe(`${API}/products`);
    expectAuthed(calls[0]!);

    expect(calls[1]!.method).toBe('POST');
    expect(calls[1]!.url).toBe(`${API}/products/NEWEST/offer_codes`);
    expectAuthed(calls[1]!);
    expect(calls[1]!.headers['content-type']).toBe('application/x-www-form-urlencoded');
    // Documented params: name (the code), amount_off, offer_type "percent", universal.
    expect(formBody(calls[1]!)).toEqual({
      name: 'PPP-IN30-K7QX',
      offer_type: 'percent',
      amount_off: '30',
      universal: 'true',
    });

    expect(result).toEqual({
      providerDiscountId: 'NEWEST:oc_1==',
      code: 'PPP-IN30-K7QX',
      discountPercent: 30,
      provider: 'gumroad',
    });
  });

  it('creates a product-scoped code without listing products and URL-encodes the product id', async () => {
    const calls = mockFetch(() =>
      json({ success: true, offer_code: { id: 'x', name: 'ABC', percent_off: 25, universal: false } }),
    );

    await provider().createDiscount({
      name: 'n',
      code: 'ABC',
      discountType: 'percentage',
      amount: 24.6,
      productIds: ['A-m3CDDC5dlrSdKZp0RFhA=='],
      maxRedemptions: 5,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${API}/products/A-m3CDDC5dlrSdKZp0RFhA%3D%3D/offer_codes`);
    // Gumroad stores an integer percent (amount_off.to_i), so round rather than truncate.
    expect(formBody(calls[0]!)).toEqual({
      name: 'ABC',
      offer_type: 'percent',
      amount_off: '25',
      max_purchase_count: '5',
    });
  });

  it('sends a fixed-amount code the documented way: offer_type=cents with amount_off in cents', async () => {
    // Docs: amount_off, offer_type ("cents" or "percent"), default "cents".
    const calls = mockFetch(() =>
      json({ success: true, offer_code: { id: 'f', name: 'FIVE', amount_cents: 500, universal: false } }),
    );

    const result = await provider().createDiscount({
      name: 'n',
      code: 'FIVE',
      discountType: 'fixed',
      amount: 500,
      productIds: ['P1'],
    });

    expect(formBody(calls[0]!)).toEqual({ name: 'FIVE', offer_type: 'cents', amount_off: '500' });
    expect(result.discountPercent).toBe(0);
  });

  it('fails clearly when a universal code is requested on an account with no products', async () => {
    mockFetch(() => json({ success: true, products: [] }));
    await expect(
      provider().createDiscount({ name: 'n', code: 'C', discountType: 'percentage', amount: 10 }),
    ).rejects.toThrow(/at least one product/);
  });

  it('surfaces a 200 success:false validation failure as a ProviderError with the message', async () => {
    // OfferCode#validate_price_after_discount: a universal code is rejected if it would
    // push any product below the minimum price.
    const message =
      'The price after discount for all of your products must be either $0 or at least $0.99.';
    mockFetch(
      () => json({ success: true, products: [product('P1')] }),
      () => json({ success: false, message }),
    );

    const err = await provider()
      .createDiscount({ name: 'n', code: 'C', discountType: 'percentage', amount: 95 })
      .catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err).not.toBeInstanceOf(ProviderNotFoundError);
    expect(err.message).toContain(message);
    expect(err.providerErrorCode).toBe('success_false');
  });
});

// ── deleteDiscount ──────────────────────────────────────────────────────────

describe('deleteDiscount', () => {
  it('DELETEs /products/:product_id/offer_codes/:id from the stored "productId:offerId"', async () => {
    const calls = mockFetch(() =>
      json({ success: true, message: 'The offer_code was deleted successfully.' }),
    );

    await provider().deleteDiscount('P1==:oc/1==');

    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe('DELETE');
    expect(calls[0]!.url).toBe(`${API}/products/P1%3D%3D/offer_codes/oc%2F1%3D%3D`);
    expect(calls[0]!.body).toBeUndefined();
    expectAuthed(calls[0]!);
  });

  it('rejects a malformed stored id without calling Gumroad', async () => {
    const calls = mockFetch();
    await expect(provider().deleteDiscount('no-separator')).rejects.toThrow(/Invalid discount ID/);
    await expect(provider().deleteDiscount(':x')).rejects.toBeInstanceOf(ProviderError);
    expect(calls).toHaveLength(0);
  });

  it('maps "offer_code was not found" (HTTP 200, success:false) to ProviderNotFoundError so coupon cleanup proceeds', async () => {
    // base_controller#error_with_object: a missing object is HTTP 200 + success:false.
    mockFetch(() => json({ success: false, message: 'The offer_code was not found.' }));
    const err = await provider().deleteDiscount('P1:oc1').catch((e) => e);
    expect(err).toBeInstanceOf(ProviderNotFoundError);
    expect(err.statusCode).toBe(404);
  });

  it('retries through another product when the anchor product was deleted (universal codes outlive it)', async () => {
    // Link#find_offer_code_by_external_id finds a universal code from ANY of the seller's products.
    const calls = mockFetch(
      () => json({ success: false, message: 'The product was not found.' }),
      () => json({ success: true, products: [product('P2'), product('P3')] }),
      () => json({ success: true, message: 'The offer_code was deleted successfully.' }),
    );

    await provider().deleteDiscount('GONE:oc1');

    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `DELETE ${API}/products/GONE/offer_codes/oc1`,
      `GET ${API}/products`,
      `DELETE ${API}/products/P2/offer_codes/oc1`,
    ]);
  });

  it('treats the code as gone when the anchor product is deleted and no other product holds it', async () => {
    mockFetch(
      () => json({ success: false, message: 'The product was not found.' }),
      () => json({ success: true, products: [product('P2')] }),
      () => json({ success: false, message: 'The offer_code was not found.' }),
    );
    await expect(provider().deleteDiscount('GONE:oc1')).rejects.toBeInstanceOf(ProviderNotFoundError);
  });

  it('treats the code as gone when the anchor product is deleted and the account has no products left', async () => {
    mockFetch(
      () => json({ success: false, message: 'The product was not found.' }),
      () => json({ success: true, products: [] }),
    );
    await expect(provider().deleteDiscount('GONE:oc1')).rejects.toBeInstanceOf(ProviderNotFoundError);
  });
});

// ── listDiscounts / listProducts ────────────────────────────────────────────

describe('listDiscounts', () => {
  it('follows next_page_key, lists each product, dedupes universal codes and skips unreadable products', async () => {
    const calls = mockFetch(
      () => json({ success: true, products: [product('P1')], next_page_key: '2021-01-05-123', next_page_url: '/v2/products?page_key=2021-01-05-123' }),
      () => json({ success: true, products: [product('P2'), product('P3')] }),
      () => json(offerCodesList),
      // P2 also sees the universal HALFOFF code: it must not be listed twice.
      () => json({ success: true, offer_codes: [offerCodesList.offer_codes[1]] }),
      () => json({ success: false, message: 'The product was not found.' }),
    );

    const discounts = await provider().listDiscounts();

    expect(calls.map((c) => c.url)).toEqual([
      `${API}/products`,
      `${API}/products?page_key=2021-01-05-123`,
      `${API}/products/P1/offer_codes`,
      `${API}/products/P2/offer_codes`,
      `${API}/products/P3/offer_codes`,
    ]);
    expect(discounts).toEqual([
      { providerDiscountId: 'P1:mN7CdHiwHaR9FlxKvF-n-g==', code: '1OFF', discountPercent: 0, provider: 'gumroad' },
      { providerDiscountId: 'P1:l5C1XQfr2TG3WXcGY7-r-g==', code: 'HALFOFF', discountPercent: 50, provider: 'gumroad' },
    ]);
  });

  it('lets an auth failure surface instead of skipping the product', async () => {
    mockFetch(
      () => json({ success: true, products: [product('P1')] }),
      () => json({ success: false, message: 'The access token is invalid' }, 401),
    );
    await expect(provider().listDiscounts()).rejects.toBeInstanceOf(ProviderAuthError);
  });
});

describe('listProducts', () => {
  it('converts the price from cents to major units, upper-cases the currency and uses short_url', async () => {
    mockFetch(() =>
      json({
        success: true,
        products: [
          product('P1', { price: 1999, currency: 'usd' }),
          product('P2', { price: undefined }),
        ],
      }),
    );

    const products = await provider().listProducts();

    expect(products).toEqual([
      { providerProductId: 'P1', name: 'Product P1', price: 19.99, currency: 'USD', url: 'https://sahil.gumroad.com/l/p1' },
      { providerProductId: 'P2', name: 'Product P2', price: null, currency: 'USD', url: 'https://sahil.gumroad.com/l/p2' },
    ]);
  });

  it('does not divide single-unit currencies (Gumroad: JPY, VND) by 100', async () => {
    // config/currencies.json marks jpy and vnd single_unit; KRW is NOT single-unit on Gumroad.
    mockFetch(() =>
      json({
        success: true,
        products: [
          product('J', { price: 1500, currency: 'jpy' }),
          product('V', { price: 250000, currency: 'vnd' }),
          product('K', { price: 1500000, currency: 'krw' }),
        ],
      }),
    );

    const [jpy, vnd, krw] = await provider().listProducts();
    expect(jpy!.price).toBe(1500);
    expect(vnd!.price).toBe(250000);
    expect(krw!.price).toBe(15000);
  });
});

// ── buildCheckoutUrl ────────────────────────────────────────────────────────

describe('buildCheckoutUrl', () => {
  it('looks up short_url and appends the code as a path segment, with ?wanted=true and ?email=', async () => {
    // Help center: "{YourProductID}/{YourDiscountCode}", "?wanted=true" goes straight to
    // checkout, "?email=" prefills the email.
    const calls = mockFetch(() => json({ success: true, product: product('P1') }));

    const url = await provider().buildCheckoutUrl({
      productId: 'P1',
      discountCode: 'PPP-IN30-K7QX',
      successUrl: 'https://merchant.example/thanks',
      customerEmail: 'buyer@example.com',
    });

    expect(calls[0]!.method).toBe('GET');
    expect(calls[0]!.url).toBe(`${API}/products/P1`);
    expect(url).toBe('https://sahil.gumroad.com/l/p1/PPP-IN30-K7QX?wanted=true&email=buyer%40example.com');
  });

  it('keeps existing query params on short_url and works without a code', async () => {
    mockFetch(() => json({ success: true, product: product('P1', { short_url: 'https://gum.co/l/abc/?ref=x' }) }));
    const url = await provider().buildCheckoutUrl({ productId: 'P1', successUrl: 's' });
    expect(url).toBe('https://gum.co/l/abc/?ref=x&wanted=true');
  });
});

// ── Webhook provisioning ────────────────────────────────────────────────────

describe('provisionWebhook / deleteWebhook', () => {
  const CALLBACK = 'https://api.gopaylocal.com/v1/webhooks/gumroad/01HZINTEGRATION';

  it('creates a "sale" resource subscription with PUT /v2/resource_subscriptions and returns its id and no secret', async () => {
    const calls = mockFetch(
      () => json({ success: true, resource_subscriptions: [{ id: 'other', resource_name: 'sale', post_url: 'https://elsewhere.example' }] }),
      () => json({ success: true, resource_subscription: { id: 'G_-mnBf9b1j9A7a4ub4nFQ==', resource_name: 'sale', post_url: CALLBACK } }),
    );

    const result = await provider().provisionWebhook(CALLBACK);

    expect(calls[0]!.method).toBe('GET');
    expect(calls[0]!.url).toBe(`${API}/resource_subscriptions?resource_name=sale`);
    expect(calls[1]!.method).toBe('PUT');
    expect(calls[1]!.url).toBe(`${API}/resource_subscriptions`);
    expect(calls[1]!.headers['content-type']).toBe('application/x-www-form-urlencoded');
    expect(formBody(calls[1]!)).toEqual({ resource_name: 'sale', post_url: CALLBACK });
    // Resource-subscription pings are unsigned (https://gumroad.com/ping, "Verifying a ping").
    expect(result).toEqual({ endpointId: 'G_-mnBf9b1j9A7a4ub4nFQ==', secret: null });
  });

  it('adopts an existing subscription for the same URL and removes duplicates instead of stacking another', async () => {
    const calls = mockFetch(
      () =>
        json({
          success: true,
          resource_subscriptions: [
            { id: 'keep', resource_name: 'sale', post_url: CALLBACK },
            { id: 'dupe', resource_name: 'sale', post_url: CALLBACK },
          ],
        }),
      () => json({ success: true, message: 'The resource_subscription was deleted successfully.' }),
    );

    const result = await provider().provisionWebhook(CALLBACK);

    // `adopted` tells cleanup-only callers (the verify tool) it wasn't created here.
    expect(result).toEqual({ endpointId: 'keep', secret: null, adopted: true });
    expect(calls[1]!.method).toBe('DELETE');
    expect(calls[1]!.url).toBe(`${API}/resource_subscriptions/dupe`);
  });

  it('still creates the subscription if the best-effort listing fails', async () => {
    const calls = mockFetch(
      () => json({ error: 'boom' }, 500),
      () => json({ success: true, resource_subscription: { id: 'new' } }),
    );
    await expect(provider().provisionWebhook(CALLBACK)).resolves.toEqual({ endpointId: 'new', secret: null });
    expect(calls[1]!.method).toBe('PUT');
  });

  it('throws when Gumroad returns no subscription id, rather than storing an empty endpoint id', async () => {
    mockFetch(
      () => json({ success: true, resource_subscriptions: [] }),
      () => json({ success: true }),
    );
    await expect(provider().provisionWebhook(CALLBACK)).rejects.toBeInstanceOf(ProviderError);
  });

  it('deleteWebhook DELETEs /v2/resource_subscriptions/:id and is a no-op for an empty id', async () => {
    const calls = mockFetch(() => json({ success: true, message: 'The resource_subscription was deleted successfully.' }));
    await provider().deleteWebhook('G_-mnBf9b1j9A7a4ub4nFQ==');
    await provider().deleteWebhook('');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe('DELETE');
    expect(calls[0]!.url).toBe(`${API}/resource_subscriptions/G_-mnBf9b1j9A7a4ub4nFQ%3D%3D`);
  });
});

// ── verifyWebhook ───────────────────────────────────────────────────────────

describe('verifyWebhook', () => {
  it('cannot authenticate anything: resource-subscription pings carry no signature, so it accepts every body', async () => {
    // https://gumroad.com/ping: "Notifications for API resource subscriptions go to your
    // application's own URL, and are not signed with this secret." There is no scheme to
    // verify against, so authenticity rests on parseRedemption's authenticated re-fetch
    // (tested below), not on this method.
    const p = provider();
    for (const rawBody of [form(pingSale), 'garbage', '']) {
      await expect(p.verifyWebhook({ rawBody, headers: new Headers(), secret: null })).resolves.toBe(true);
    }
  });
});

// ── parseRedemption ─────────────────────────────────────────────────────────

describe('parseRedemption', () => {
  it('re-fetches the sale named by sale_id and attributes the redemption only from the API response', async () => {
    const calls = mockFetch(() => json(saleWithCode));

    const event = await provider().parseRedemption(form(pingSale));

    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe('GET');
    expect(calls[0]!.url).toBe(`${API}/sales/FO8TXN-dvxYabdavG97Y-Q%3D%3D`);
    expectAuthed(calls[0]!);
    expect(event).toEqual({
      eventId: 'FO8TXN-dvxYabdavG97Y-Q==',
      code: 'PPP-IN30-K7QX', // from offer_code.name (docs example has no `code` key)
      providerCouponId: null,
      providerPromoCodeId: null,
      chargedAmountCents: 700,
      taxAmountCents: 0, // tax_cents 0: no tax in price
      discountAmountCents: null,
      currency: 'USD',
    });
  });

  describe('tax inside `price` (C3)', () => {
    const parseSale = async (patch: Record<string, unknown>) => {
      mockFetch(() => json({ ...saleWithCode, sale: { ...saleWithCode.sale, ...patch } }));
      return provider().parseRedemption(form(pingSale));
    };

    it("reports the seller's tax as inside price, and strips shipping like tips", async () => {
      const r = await parseSale({
        price: 1325, tip_cents: 100, shipping_cents: 100, tax_cents: 125,
        buyer_presentment: { seller_tax_cents: 175, gumroad_tax_cents: 0 },
      });
      expect([r?.chargedAmountCents, r?.taxAmountCents]).toEqual([1125, 125]);
    });

    it("reports 0 when the tax is Gumroad's own (charged on top of price, not in it)", async () => {
      const r = await parseSale({ tax_cents: 140, buyer_presentment: { seller_tax_cents: 0, gumroad_tax_cents: 196 } });
      expect(r?.taxAmountCents).toBe(0);
    });

    it("reports unknown (null) when nothing says whose tax it was", async () => {
      expect((await parseSale({ tax_cents: 140 }))?.taxAmountCents).toBeNull();
      expect((await parseSale({ tax_cents: undefined }))?.taxAmountCents).toBeNull();
    });
  });

  it('ignores forged ping fields: code, price and refund state come from the authenticated sale', async () => {
    mockFetch(() => json(saleWithCode));
    const forged = form({ ...pingSale, offer_code: 'SOMEONE-ELSES-CODE', price: '1', currency: 'jpy' });

    const event = await provider().parseRedemption(forged);

    expect(event?.code).toBe('PPP-IN30-K7QX');
    expect(event?.chargedAmountCents).toBe(700);
    expect(event?.currency).toBe('USD');
  });

  it('dedupes on the canonical sale id from the API, not the ping value (alternate encodings cannot double count)', async () => {
    // A ping whose sale_id is a different spelling that Gumroad resolves to the same sale.
    mockFetch(() => json(saleWithCode));
    const event = await provider().parseRedemption(form({ ...pingSale, sale_id: 'FO8TXN-dvxYabdavG97Y-Q' }));
    expect(event?.eventId).toBe('FO8TXN-dvxYabdavG97Y-Q==');
  });

  it('reads `price` as USD cents even when the product is listed in another currency', async () => {
    // Ping docs: "Price and the other amount fields are always USD cents, whatever this
    // value is". Sales docs: "canonical fields like `price` keep their USD accounting meaning".
    const sale = { ...saleWithCode, sale: { ...saleWithCode.sale, currency: 'eur', price: 1234 } };
    mockFetch(() => json(sale));
    const event = await provider().parseRedemption(form(pingSale));
    expect(event?.chargedAmountCents).toBe(1234);
    expect(event?.currency).toBe('USD');
  });

  it('subtracts a tip (tip_cents, USD) so the charged amount is the discounted product price', async () => {
    const sale = { ...saleWithCode, sale: { ...saleWithCode.sale, price: 900, tip_cents: 200 } };
    mockFetch(() => json(sale));
    const event = await provider().parseRedemption(form(pingSale));
    expect(event?.chargedAmountCents).toBe(700);
  });

  it('accepts offer_code.code when present (the field definitions list both code and name)', async () => {
    const sale = { ...saleWithCode, sale: { ...saleWithCode.sale, offer_code: { code: 'CODE-A', name: 'CODE-A' } } };
    mockFetch(() => json(sale));
    expect((await provider().parseRedemption(form(pingSale)))?.code).toBe('CODE-A');
  });

  it('returns null for a purchase with no offer code', async () => {
    const { offer_code: _drop, ...noCode } = saleWithCode.sale;
    mockFetch(() => json({ success: true, sale: noCode }));
    const { offer_code: _p, ...pingNoCode } = pingSale;
    await expect(provider().parseRedemption(form(pingNoCode))).resolves.toBeNull();
  });

  it('returns null for a membership renewal (recurring_charge: true) so renewals are not counted as new redemptions', async () => {
    mockFetch(() => json(saleRenewal));
    const ping = form({ ...pingSale, sale_id: saleRenewal.sale.id, is_recurring_charge: 'true' });
    await expect(provider().parseRedemption(ping)).resolves.toBeNull();
  });

  it('returns null for the gift receiver half of a gift purchase (the gifter purchase is the redemption)', async () => {
    const sale = { ...saleWithCode, sale: { ...saleWithCode.sale, is_gift_receiver_purchase: true, price: 0 } };
    mockFetch(() => json(sale));
    await expect(provider().parseRedemption(form(pingSale))).resolves.toBeNull();
  });

  it('returns null for a refunded sale', async () => {
    const sale = { ...saleWithCode, sale: { ...saleWithCode.sale, refunded: true } };
    mockFetch(() => json(sale));
    await expect(provider().parseRedemption(form(pingSale))).resolves.toBeNull();
  });

  it('returns null without any API call for an unrelated resource (refund ping)', async () => {
    const calls = mockFetch();
    const event = await provider().parseRedemption(form({ ...pingSale, resource_name: 'refund', refunded: 'true' }));
    expect(event).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('returns null without any API call when sale_id is missing or implausible (no quota spent on junk)', async () => {
    const calls = mockFetch();
    const p = provider();
    await expect(p.parseRedemption('')).resolves.toBeNull();
    await expect(p.parseRedemption(form({ resource_name: 'sale' }))).resolves.toBeNull();
    await expect(p.parseRedemption(form({ sale_id: 'x'.repeat(500) }))).resolves.toBeNull();
    await expect(p.parseRedemption(form({ sale_id: '../../user' }))).resolves.toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('returns null when the sale is not this merchant\'s (Gumroad scopes /sales/:id to the token)', async () => {
    // sales_controller#show: current_resource_owner.sales.find_by_external_id → error_with_sale.
    mockFetch(() => json({ success: false, message: 'The sale was not found.' }));
    await expect(provider().parseRedemption(form(pingSale))).resolves.toBeNull();
  });

  it('returns null when the merchant token is revoked (retrying cannot help)', async () => {
    mockFetch(() => json({ success: false, message: 'The access token is invalid' }, 401));
    await expect(provider().parseRedemption(form(pingSale))).resolves.toBeNull();
  });

  it('throws on a transient failure (5xx, 429, network) so a caller can retry instead of silently dropping it', async () => {
    mockFetch(() => json({ success: false }, 503));
    await expect(provider().parseRedemption(form(pingSale))).rejects.toBeInstanceOf(ProviderError);

    mockFetch(() => new Response('slow down', { status: 429, headers: { 'Retry-After': '30' } }));
    await expect(provider().parseRedemption(form(pingSale))).rejects.toBeInstanceOf(ProviderError);

    mockFetch(() => {
      throw new TypeError('fetch failed');
    });
    await expect(provider().parseRedemption(form(pingSale))).rejects.toBeInstanceOf(ProviderError);
  });

  it('parses a JSON ping body (Gumroad sends JSON to zapier.com hosts)', async () => {
    mockFetch(() => json(saleWithCode));
    const event = await provider().parseRedemption(JSON.stringify(pingSale));
    expect(event?.eventId).toBe('FO8TXN-dvxYabdavG97Y-Q==');
  });
});

// ── Error mapping ───────────────────────────────────────────────────────────

describe('error mapping', () => {
  it.each([401, 403])('maps HTTP %i to ProviderAuthError with Gumroad\'s message', async (status) => {
    mockFetch(() => json({ success: false, message: 'The access token is invalid' }, status));
    const err = await provider().listProducts().catch((e) => e);
    expect(err).toBeInstanceOf(ProviderAuthError);
    expect(err.message).toContain('The access token is invalid');
  });

  it('maps HTTP 404 to ProviderNotFoundError', async () => {
    mockFetch(() => json({ success: false, message: 'Not found' }, 404));
    const err = await provider().buildCheckoutUrl({ productId: 'nope', successUrl: 's' }).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderNotFoundError);
    expect(err.statusCode).toBe(404);
  });

  it('maps other HTTP errors to ProviderError carrying the status, method/path and message', async () => {
    mockFetch(() => json({ success: false, message: 'the parameters were valid but request failed' }, 402));
    const err = await provider().listProducts().catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err).not.toBeInstanceOf(ProviderAuthError);
    expect(err.statusCode).toBe(402);
    expect(err.operation).toBe('GET /products');
    expect(err.message).toContain('the parameters were valid but request failed');
  });

  it('keeps a non-JSON error body as the message', async () => {
    mockFetch(() => new Response('<html>Bad gateway</html>', { status: 502 }));
    const err = await provider().listProducts().catch((e) => e);
    expect(err.statusCode).toBe(502);
    expect(err.message).toContain('Bad gateway');
  });
});
