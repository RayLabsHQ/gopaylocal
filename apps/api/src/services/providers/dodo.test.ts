// Unit tests for the Dodo Payments MERCHANT provider (a merchant's own Dodo account),
// with `fetch` mocked. No live calls. GoPayLocal's own billing on Dodo is not covered here.
//
// Sources for every request/response shape asserted here (fetched Nov 2026, OpenAPI v1.124.0):
//  - https://docs.dodopayments.com/api-reference/introduction (hosts, bearer auth, key prefixes, error body)
//  - https://docs.dodopayments.com/api-reference/discounts/{create-discount,delete-discount,list-discounts}
//  - https://docs.dodopayments.com/api-reference/products/get-products
//  - https://docs.dodopayments.com/api-reference/checkout-sessions/create
//  - https://docs.dodopayments.com/api-reference/webhooks/{create-webhook,get-webhook-signing-key,delete-webhook}
//  - https://docs.dodopayments.com/developer-resources/webhooks (Standard Webhooks headers, manual verification, envelope)
//  - https://docs.dodopayments.com/developer-resources/webhooks/intents/payment and
//    https://docs.dodopayments.com/api-reference/payments/get-payments-1 (Payment payload: discounts[], charge_type, total_amount, tax)
//  - https://www.standardwebhooks.com (spec: signed content, whsec_ secret, v1 signatures)
//
// Every assertion is at the HTTP level (URL, method, headers, JSON body, returned
// values), so the suite stays valid whether dodo.ts calls an endpoint with raw fetch
// or through the dodopayments SDK (2.x). Two things keep that true:
//  - The fetch mock normalizes whatever it is handed (url + init, or a Request) via
//    `new Request(...)`, so it does not care how a client builds the call.
//  - Each test stubs fetch BEFORE constructing the provider. SDK 2.x captures
//    globalThis.fetch at construction unless a `fetch` option is passed (dodo.ts
//    passes one that resolves globalThis.fetch per call).

import { describe, it, expect, vi, afterEach } from 'vitest';
import { createHmac, randomBytes } from 'node:crypto';
import { DodoProvider } from './dodo';
import { ProviderError, ProviderAuthError, ProviderNotFoundError } from './types';
// Fixture: a payment.succeeded webhook envelope (business_id/type/timestamp/data) wrapping
// a Payment object built from the documented PaymentResponse schema. One-time purchase
// (charge_type null) with one stacked discount in `discounts[]` plus the deprecated
// `discount_id` mirror.
import paymentDiscounted from './__fixtures__/dodo/payment-succeeded-discounted.json';
// Fixture: the same envelope for a subscription renewal charge (charge_type "renewal").
// Docs: a discount without subscription_cycles "will be applied indefinitely to all
// recurring payments", so renewals carry the code too.
import paymentRenewal from './__fixtures__/dodo/payment-succeeded-subscription-renewal.json';
// Fixture: DiscountResponse from POST /discounts.
import discountResponse from './__fixtures__/dodo/discount-response.json';

const LIVE = 'https://live.dodopayments.com';
const TEST = 'https://test.dodopayments.com';
const KEY = 'legacy-unprefixed-key';

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}
type Handler = (call: Call) => Response | Promise<Response>;

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

/**
 * Ordered fetch mock. Every request (raw fetch AND the SDK) must hit it; an
 * unexpected request throws, so nothing can reach the network.
 */
function mockFetch(...handlers: Handler[]): Call[] {
  const calls: Call[] = [];
  let i = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      // Normalize url+init or a Request object into one Request, then read it the
      // way a server would.
      const req = new Request(input as RequestInfo, init);
      const headers: Record<string, string> = {};
      req.headers.forEach((v, k) => {
        headers[k] = v;
      });
      const text = await req.text();
      const call: Call = {
        url: req.url,
        method: req.method.toUpperCase(),
        headers,
        body: text === '' ? undefined : text,
      };
      calls.push(call);
      const handler = handlers[i++];
      if (!handler) throw new Error(`Unexpected fetch #${i}: ${call.method} ${call.url}`);
      return handler(call);
    }),
  );
  return calls;
}

function provider(apiKey = KEY, environment: 'live' | 'test' = 'live'): DodoProvider {
  return new DodoProvider({ apiKey, environment });
}

function bodyOf(call: Call): unknown {
  return call.body === undefined ? undefined : JSON.parse(call.body);
}

function query(call: Call): Record<string, string> {
  return Object.fromEntries(new URL(call.url).searchParams);
}

function path(call: Call): string {
  const u = new URL(call.url);
  return `${u.origin}${u.pathname}`;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ── Environment ─────────────────────────────────────────────────────────────

describe('environment / host selection', () => {
  it('uses live.dodopayments.com for live and test.dodopayments.com for test', async () => {
    const calls = mockFetch(
      () => json({ session_id: 's', checkout_url: 'https://checkout.dodopayments.com/session/s' }),
      () => json({ session_id: 's', checkout_url: 'https://test.checkout.dodopayments.com/session/s' }),
    );
    await provider(KEY, 'live').buildCheckoutUrl({ productId: 'p', successUrl: 'https://x' });
    await provider(KEY, 'test').buildCheckoutUrl({ productId: 'p', successUrl: 'https://x' });
    expect(path(calls[0]!)).toBe(`${LIVE}/checkouts`);
    expect(path(calls[1]!)).toBe(`${TEST}/checkouts`);
  });

  it('keeps the configured environment for a mismatched prefixed key and surfaces Dodo\'s 401 message', async () => {
    // Docs: "A prefixed key sent to the other environment returns 401 with a message
    // that names the mismatch." The environment says which credential slot the key
    // came from, so a test key saved as live must fail loudly, not be re-routed.
    // (The exact 401 wording is not documented; this message is a stand-in.)
    const calls = mockFetch(() => json({ code: 'UNAUTHORIZED', message: 'test mode key used in live mode' }, 401));
    const err = await provider('dodo_test_AbCd1234EfGh5678.secret', 'live')
      .buildCheckoutUrl({ productId: 'p', successUrl: 'x' })
      .catch((e) => e);
    expect(path(calls[0]!)).toBe(`${LIVE}/checkouts`);
    expect(err).toBeInstanceOf(ProviderAuthError);
    expect(err.message).toContain('test mode key used in live mode');
  });
});

// ── Discounts and products ──────────────────────────────────────────────────

describe('createDiscount', () => {
  it('POSTs /discounts with bearer auth and amount in basis points', async () => {
    const calls = mockFetch(() => json(discountResponse));

    const result = await provider().createDiscount({
      name: 'PPP IN 30%',
      code: 'PPP-IN30-K7QX',
      discountType: 'percentage',
      amount: 30,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe('POST');
    expect(path(calls[0]!)).toBe(`${LIVE}/discounts`);
    expect(calls[0]!.headers['authorization']).toBe(`Bearer ${KEY}`);
    expect(calls[0]!.headers['content-type']).toBe('application/json');
    expect(bodyOf(calls[0]!)).toEqual({
      type: 'percentage',
      amount: 3000,
      code: 'PPP-IN30-K7QX',
      name: 'PPP IN 30%',
    });
    expect(result).toEqual({
      providerDiscountId: 'dsc_qxxEmg5PuM1uNTE0LgkP9',
      code: 'PPP-IN30-K7QX',
      discountPercent: 30,
      provider: 'dodopayments',
    });
  });

  it('maps optional params to restricted_to, usage_limit and expires_at, and rounds fractional percents to whole bps', async () => {
    const calls = mockFetch(() => json({ ...discountResponse, amount: 1255 }));
    const result = await provider().createDiscount({
      name: 'n',
      code: 'ABC',
      discountType: 'percentage',
      amount: 12.554,
      productIds: ['pdt_1', 'pdt_2'],
      maxRedemptions: 50,
      expiresAt: '2027-01-01T00:00:00Z',
    });
    expect(bodyOf(calls[0]!)).toEqual({
      type: 'percentage',
      amount: 1255,
      code: 'ABC',
      name: 'n',
      expires_at: '2027-01-01T00:00:00Z',
      usage_limit: 50,
      restricted_to: ['pdt_1', 'pdt_2'],
    });
    expect(result.discountPercent).toBe(12.55);
  });

  // Current behavior, not an API limit: the API (and SDK 2.x) accept `type: "flat"`
  // with required `currency_options`. coupon.service only ever sends percentages.
  it('rejects fixed-amount discounts without calling Dodo', async () => {
    const calls = mockFetch();
    await expect(
      provider().createDiscount({ name: 'n', code: 'ABC', discountType: 'fixed', amount: 500, currency: 'USD' }),
    ).rejects.toBeInstanceOf(ProviderError);
    expect(calls).toHaveLength(0);
  });

  it('rejects codes outside Dodo\'s 3-16 character range before calling Dodo', async () => {
    // Docs: code "Must be at least 3 characters"; DiscountResponse.code "(up to 16 chars)".
    const calls = mockFetch();
    for (const code of ['AB', 'PPPPPP-IN30-K7QXZ' /* 17 */]) {
      const err = await provider()
        .createDiscount({ name: 'n', code, discountType: 'percentage', amount: 10 })
        .catch((e) => e);
      expect(err).toBeInstanceOf(ProviderError);
      expect(err.message).toMatch(/3.*16/);
    }
    expect(calls).toHaveLength(0);
  });

  it('maps 401 to ProviderAuthError and 422 to ProviderError with the status', async () => {
    mockFetch(() => json({ code: 'UNAUTHORIZED', message: 'Invalid API key' }, 401));
    await expect(
      provider().createDiscount({ name: 'n', code: 'ABC', discountType: 'percentage', amount: 10 }),
    ).rejects.toBeInstanceOf(ProviderAuthError);

    mockFetch(() => json({ code: 'INVALID_REQUEST_BODY', message: 'code already exists' }, 422));
    const err = await provider()
      .createDiscount({ name: 'n', code: 'ABC', discountType: 'percentage', amount: 10 })
      .catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err).not.toBeInstanceOf(ProviderAuthError);
    expect(err.statusCode).toBe(422);
    expect(err.message).toContain('code already exists');
    expect(err.providerErrorCode).toBe('INVALID_REQUEST_BODY');
  });

  it('maps a 500 to ProviderError with the status', async () => {
    // `x-should-retry: false` stops an SDK client from retrying (the SDKs otherwise
    // retry 5xx twice with backoff); a raw fetch client ignores it.
    mockFetch(() => json({ message: 'Something went wrong :(' }, 500, { 'x-should-retry': 'false' }));
    const err = await provider()
      .createDiscount({ name: 'n', code: 'ABC', discountType: 'percentage', amount: 10 })
      .catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.statusCode).toBe(500);
  });
});

describe('deleteDiscount', () => {
  it('DELETEs /discounts/{discount_id} (204 no content)', async () => {
    const calls = mockFetch(() => new Response(null, { status: 204 }));
    await provider().deleteDiscount('dsc_qxxEmg5PuM1uNTE0LgkP9');
    expect(calls[0]!.method).toBe('DELETE');
    expect(path(calls[0]!)).toBe(`${LIVE}/discounts/dsc_qxxEmg5PuM1uNTE0LgkP9`);
    expect(calls[0]!.headers['authorization']).toBe(`Bearer ${KEY}`);
  });

  it('maps 404 ("not found or already deleted") to ProviderNotFoundError', async () => {
    mockFetch(() => json({ code: 'NOT_FOUND', message: 'Discount not found' }, 404));
    const err = await provider().deleteDiscount('dsc_gone').catch((e) => e);
    expect(err).toBeInstanceOf(ProviderNotFoundError);
    expect(err.statusCode).toBe(404);
  });
});

describe('listDiscounts', () => {
  const d = (i: number) => ({ ...discountResponse, discount_id: `dsc_${i}`, code: `CODE${i}`, amount: 1000 + i });

  it('walks 0-indexed pages (0, 1, 2 ...) at page_size 100 and stops on a short page', async () => {
    // Docs: page_number "default = 0", page_size "default = 10, max = 100". The SDK's
    // auto-iterator (0.24.0 and 2.63.0 alike) computes the next page as
    // `(page_number ?? 1) + 1`, so when page_number is omitted it fetches the implicit
    // page 0 and then page_number=2, skipping page 1 (dodopayments-typescript #359).
    // This test fails for any implementation that skips a page.
    const page0 = Array.from({ length: 100 }, (_, i) => d(i));
    const page1 = [d(100), d(101)];
    const calls = mockFetch(() => json({ items: page0 }), () => json({ items: page1 }));

    const discounts = await provider().listDiscounts();

    expect(calls.map(query)).toEqual([
      { page_number: '0', page_size: '100' },
      { page_number: '1', page_size: '100' },
    ]);
    expect(calls.every((c) => path(c) === `${LIVE}/discounts` && c.method === 'GET')).toBe(true);
    expect(discounts).toHaveLength(102);
    expect(discounts[101]).toEqual({
      providerDiscountId: 'dsc_101',
      code: 'CODE101',
      discountPercent: 11.01,
      provider: 'dodopayments',
    });
  });

  it('leaves out expired discounts (listDiscounts returns only redeemable ones)', async () => {
    // An expired code used to be listed, so coupon sync kept showing it.
    mockFetch(() =>
      json({
        items: [
          { ...d(1), expires_at: '2000-01-01T00:00:00Z' },
          { ...d(2), expires_at: '2999-01-01T00:00:00Z' },
          { ...d(3), expires_at: null },
        ],
      }),
    );
    const discounts = await provider().listDiscounts();
    expect(discounts.map((x) => x.providerDiscountId)).toEqual(['dsc_2', 'dsc_3']);
  });

  it('reports 0% for a flat discount (type "flat")', async () => {
    mockFetch(() => json({ items: [{ ...d(1), type: 'flat', amount: 500 }] }));
    const [only] = await provider().listDiscounts();
    expect(only!.discountPercent).toBe(0);
  });
});

describe('listProducts', () => {
  const p = (id: string, price: number | null, currency: string) => ({
    product_id: id,
    business_id: 'bus_1',
    name: `Product ${id}`,
    price,
    currency,
    is_recurring: false,
    tax_category: 'saas',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    metadata: {},
  });

  it('converts minor units per currency precision and links the static payment URL', async () => {
    // get-products: price "in the lowest denomination" (USD cents, JPY yen); payments
    // docs: "fils for KWD" (3 decimals).
    const calls = mockFetch(() =>
      json({
        items: [
          p('pdt_usd', 1999, 'USD'),
          p('pdt_jpy', 1500, 'JPY'),
          p('pdt_kwd', 2500, 'KWD'),
          p('pdt_none', null, 'USD'),
        ],
      }),
    );

    const products = await provider().listProducts();

    expect(query(calls[0]!)).toEqual({ page_number: '0', page_size: '100' });
    expect(products).toEqual([
      { providerProductId: 'pdt_usd', name: 'Product pdt_usd', price: 19.99, currency: 'USD', url: 'https://checkout.dodopayments.com/buy/pdt_usd' },
      { providerProductId: 'pdt_jpy', name: 'Product pdt_jpy', price: 1500, currency: 'JPY', url: 'https://checkout.dodopayments.com/buy/pdt_jpy' },
      { providerProductId: 'pdt_kwd', name: 'Product pdt_kwd', price: 2.5, currency: 'KWD', url: 'https://checkout.dodopayments.com/buy/pdt_kwd' },
      { providerProductId: 'pdt_none', name: 'Product pdt_none', price: null, currency: 'USD', url: 'https://checkout.dodopayments.com/buy/pdt_none' },
    ]);
  });

  it('uses the test API host and the test-mode checkout host in test mode', async () => {
    const calls = mockFetch(() => json({ items: [p('pdt_1', 100, 'USD')] }));
    const [only] = await provider(KEY, 'test').listProducts();
    expect(path(calls[0]!)).toBe(`${TEST}/products`);
    expect(only!.url).toBe('https://test.checkout.dodopayments.com/buy/pdt_1');
  });

  it('pages products the same way (page 1 is not skipped)', async () => {
    const page0 = Array.from({ length: 100 }, (_, i) => p(`pdt_${i}`, 100, 'USD'));
    const calls = mockFetch(() => json({ items: page0 }), () => json({ items: [p('pdt_100', 100, 'USD')] }));
    const products = await provider().listProducts();
    expect(calls.map((c) => query(c).page_number)).toEqual(['0', '1']);
    expect(products.map((x) => x.providerProductId)).toContain('pdt_100');
    expect(products).toHaveLength(101);
  });
});

// ── buildCheckoutUrl (POST /checkouts) ──────────────────────────────────────

describe('buildCheckoutUrl', () => {
  it('POSTs /checkouts with product_cart, discount_codes, return_url, cancel_url, customer and metadata', async () => {
    const calls = mockFetch(() =>
      json({ session_id: 'cks_Gi6KGJ2zFJo9rq9Ukifwa', checkout_url: 'https://checkout.dodopayments.com/session/cks_Gi6KGJ2zFJo9rq9Ukifwa' }),
    );

    const url = await provider().buildCheckoutUrl({
      productId: 'pdt_0NWGkZeQ1wHqNC2FIbFsL',
      discountCode: 'PPP-IN30-K7QX',
      successUrl: 'https://merchant.example/thanks',
      cancelUrl: 'https://merchant.example/pricing',
      customerEmail: 'buyer@example.com',
      metadata: { gpl_campaign: 'c1' },
    });

    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.url).toBe(`${LIVE}/checkouts`);
    expect(calls[0]!.headers['authorization']).toBe(`Bearer ${KEY}`);
    expect(calls[0]!.headers['content-type']).toBe('application/json');
    expect(bodyOf(calls[0]!)).toEqual({
      product_cart: [{ product_id: 'pdt_0NWGkZeQ1wHqNC2FIbFsL', quantity: 1 }],
      discount_codes: ['PPP-IN30-K7QX'], // not the deprecated singular discount_code
      return_url: 'https://merchant.example/thanks',
      cancel_url: 'https://merchant.example/pricing',
      customer: { email: 'buyer@example.com' },
      metadata: { gpl_campaign: 'c1' },
    });
    expect(url).toBe('https://checkout.dodopayments.com/session/cks_Gi6KGJ2zFJo9rq9Ukifwa');
  });

  it('omits optional fields and fails when no checkout_url comes back', async () => {
    const calls = mockFetch(() => json({ session_id: 'cks_1', checkout_url: null }));
    await expect(provider().buildCheckoutUrl({ productId: 'pdt_1', successUrl: '' })).rejects.toThrow(/No checkout URL/);
    expect(bodyOf(calls[0]!)).toEqual({ product_cart: [{ product_id: 'pdt_1', quantity: 1 }] });
  });
});

describe('error mapping (POST /checkouts)', () => {
  const call = () => provider().buildCheckoutUrl({ productId: 'pdt_1', successUrl: 'https://x' });

  it('maps 401 and 403 (INSUFFICIENT_PERMISSION) to ProviderAuthError, keeping Dodo\'s code and message', async () => {
    mockFetch(() => json({ code: 'UNAUTHORIZED', message: 'Invalid API key' }, 401));
    await expect(call()).rejects.toBeInstanceOf(ProviderAuthError);
    mockFetch(() => json({ code: 'INSUFFICIENT_PERMISSION', message: 'Key lacks checkout write permission' }, 403));
    const err = await call().catch((e) => e);
    expect(err).toBeInstanceOf(ProviderAuthError);
    expect(err.message).toContain('INSUFFICIENT_PERMISSION');
  });

  it('maps 404 to ProviderNotFoundError', async () => {
    mockFetch(() => json({ code: 'NOT_FOUND', message: 'Product not found' }, 404));
    await expect(call()).rejects.toBeInstanceOf(ProviderNotFoundError);
  });

  it('maps other statuses to ProviderError with status, message and Dodo error code', async () => {
    mockFetch(() => json({ code: 'INVALID_REQUEST_BODY', message: 'product_cart is empty' }, 422));
    const err = await call().catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err).not.toBeInstanceOf(ProviderAuthError);
    expect(err).not.toBeInstanceOf(ProviderNotFoundError);
    expect(err.statusCode).toBe(422);
    expect(err.providerErrorCode).toBe('INVALID_REQUEST_BODY');
    expect(err.message).toContain('product_cart is empty');
  });

  it('handles a non-JSON error body', async () => {
    mockFetch(() => new Response('<html>Bad gateway</html>', { status: 502 }));
    const err = await call().catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.statusCode).toBe(502);
    expect(err.message).toContain('HTTP 502');
  });
});

// ── Webhook provisioning (/webhooks) ────────────────────────────────────────

describe('provisionWebhook / deleteWebhook', () => {
  const CALLBACK = 'https://api.gopaylocal.com/v1/webhooks/dodopayments/01HZINTEGRATION';

  it('POSTs /webhooks filtered to payment.succeeded, then reads GET /webhooks/{id}/secret', async () => {
    const calls = mockFetch(
      () => json({ id: 'whk_YdWqVEGKmSYKbsIyDxEab', url: CALLBACK, description: '', metadata: {}, created_at: 'x', updated_at: 'x', filter_types: ['payment.succeeded'] }),
      () => json({ secret: 'whsec_FAKE-not-a-real-secret' }),
    );

    const result = await provider().provisionWebhook(CALLBACK);

    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.url).toBe(`${LIVE}/webhooks`);
    expect(bodyOf(calls[0]!)).toEqual({ url: CALLBACK, filter_types: ['payment.succeeded'] });
    expect(calls[1]!.method).toBe('GET');
    expect(calls[1]!.url).toBe(`${LIVE}/webhooks/whk_YdWqVEGKmSYKbsIyDxEab/secret`);
    expect(calls[1]!.body).toBeUndefined();
    expect(result).toEqual({
      endpointId: 'whk_YdWqVEGKmSYKbsIyDxEab',
      secret: 'whsec_FAKE-not-a-real-secret',
    });
  });

  it('deletes the endpoint it just created if the secret cannot be read, so no orphan keeps firing', async () => {
    const calls = mockFetch(
      () => json({ id: 'whk_1' }),
      () => json({ code: 'INTERNAL', message: 'Something went wrong.' }, 500),
      () => new Response(null, { status: 200 }),
    );
    await expect(provider().provisionWebhook(CALLBACK)).rejects.toBeInstanceOf(ProviderError);
    expect(calls[2]!.method).toBe('DELETE');
    expect(calls[2]!.url).toBe(`${LIVE}/webhooks/whk_1`);
  });

  it('fails when the create response has no id, and cleans up when the secret is empty', async () => {
    let calls = mockFetch(() => json({}));
    await expect(provider().provisionWebhook(CALLBACK)).rejects.toThrow(/No webhook id/);
    expect(calls).toHaveLength(1);

    calls = mockFetch(() => json({ id: 'whk_2' }), () => json({ secret: '' }), () => new Response(null, { status: 200 }));
    await expect(provider().provisionWebhook(CALLBACK)).rejects.toThrow(/No signing secret/);
    expect(calls[2]!.method).toBe('DELETE');
    expect(calls[2]!.url).toBe(`${LIVE}/webhooks/whk_2`);
  });

  it('deleteWebhook accepts the documented 200 with an empty body', async () => {
    // delete-webhook: '200': "Webhook has been deleted" (no response schema).
    const calls = mockFetch(() => new Response('', { status: 200 }));
    await expect(provider().deleteWebhook('whk_YdWqVEGKmSYKbsIyDxEab')).resolves.toBeUndefined();
    expect(calls[0]!.method).toBe('DELETE');
    expect(calls[0]!.url).toBe(`${LIVE}/webhooks/whk_YdWqVEGKmSYKbsIyDxEab`);
  });

  it('deleteWebhook maps 404 to ProviderNotFoundError', async () => {
    mockFetch(() => json({ code: 'NOT_FOUND', message: 'Endpoint Not Found' }, 404));
    await expect(provider().deleteWebhook('whk_gone')).rejects.toBeInstanceOf(ProviderNotFoundError);
  });
});

// ── verifyWebhook (Standard Webhooks) ───────────────────────────────────────

/**
 * Independent signer per https://www.standardwebhooks.com and Dodo's "Manual
 * Verification": HMAC-SHA256 over `${id}.${timestamp}.${body}`, keyed with the
 * base64-decoded part after `whsec_`, base64 output, header token `v1,<sig>`.
 * Uses node:crypto, not the code under test.
 */
function standardSign(keyBytes: Buffer, id: string, ts: string, body: string): string {
  return 'v1,' + createHmac('sha256', keyBytes).update(`${id}.${ts}.${body}`).digest('base64');
}

function headers(id: string | null, ts: string | null, sig: string | null): Headers {
  const h = new Headers();
  if (id !== null) h.set('webhook-id', id);
  if (ts !== null) h.set('webhook-timestamp', ts);
  if (sig !== null) h.set('webhook-signature', sig);
  return h;
}

describe('verifyWebhook', () => {
  const keyBytes = randomBytes(32);
  const secret = `whsec_${keyBytes.toString('base64')}`;
  const body = JSON.stringify(paymentDiscounted);
  const id = 'msg_2KWPBgLlAfxdpx2AI54pPJ85f4W';
  const now = () => String(Math.floor(Date.now() / 1000));

  it('accepts a payload signed by an independent Standard Webhooks implementation', async () => {
    const ts = now();
    const ok = await provider().verifyWebhook({ rawBody: body, headers: headers(id, ts, standardSign(keyBytes, id, ts, body)), secret });
    expect(ok).toBe(true);
  });

  it('matches the msg_p5jXN8AQM9LWM0D4loKWxJek vector used by the standard-webhooks reference libraries', async () => {
    // The published test-vector secret from the standard-webhooks repo, not a
    // credential; assembled at runtime so secret scanners don't flag it.
    const vectorSecret = ['whsec', 'MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw'].join('_');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(1614265330 * 1000));
    const ok = await provider().verifyWebhook({
      rawBody: '{"test": 2432232314}',
      headers: headers('msg_p5jXN8AQM9LWM0D4loKWxJek', '1614265330', 'v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE='),
      secret: vectorSecret,
    });
    expect(ok).toBe(true);
  });

  it('accepts when any one of several space-separated signatures matches (key rotation, v2a tokens)', async () => {
    const ts = now();
    const sig = `v2a,${randomBytes(64).toString('base64')} v1,${randomBytes(32).toString('base64')} ${standardSign(keyBytes, id, ts, body)}`;
    expect(await provider().verifyWebhook({ rawBody: body, headers: headers(id, ts, sig), secret })).toBe(true);
  });

  it('rejects a tampered body', async () => {
    const ts = now();
    const sig = standardSign(keyBytes, id, ts, body);
    const tampered = body.replace('"total_amount":826', '"total_amount":1');
    expect(tampered).not.toBe(body);
    expect(await provider().verifyWebhook({ rawBody: tampered, headers: headers(id, ts, sig), secret })).toBe(false);
  });

  it('rejects a signature made with the wrong secret', async () => {
    const ts = now();
    const sig = standardSign(randomBytes(32), id, ts, body);
    expect(await provider().verifyWebhook({ rawBody: body, headers: headers(id, ts, sig), secret })).toBe(false);
  });

  it('rejects a swapped webhook-id (the id is part of the signed content)', async () => {
    const ts = now();
    const sig = standardSign(keyBytes, id, ts, body);
    expect(await provider().verifyWebhook({ rawBody: body, headers: headers('msg_other', ts, sig), secret })).toBe(false);
  });

  it('rejects missing headers and a missing secret', async () => {
    const ts = now();
    const sig = standardSign(keyBytes, id, ts, body);
    const p = provider();
    expect(await p.verifyWebhook({ rawBody: body, headers: headers(null, ts, sig), secret })).toBe(false);
    expect(await p.verifyWebhook({ rawBody: body, headers: headers(id, null, sig), secret })).toBe(false);
    expect(await p.verifyWebhook({ rawBody: body, headers: headers(id, ts, null), secret })).toBe(false);
    expect(await p.verifyWebhook({ rawBody: body, headers: headers(id, ts, sig), secret: null })).toBe(false);
  });

  it('rejects malformed signature headers and timestamps', async () => {
    const ts = now();
    const p = provider();
    for (const sig of ['', 'v1,', 'v1,not base64!!', 'garbage', `v1,${'A'.repeat(43)}=`]) {
      expect(await p.verifyWebhook({ rawBody: body, headers: headers(id, ts, sig), secret })).toBe(false);
    }
    const badTs = 'yesterday';
    expect(
      await p.verifyWebhook({ rawBody: body, headers: headers(id, badTs, standardSign(keyBytes, id, badTs, body)), secret }),
    ).toBe(false);
  });

  it('rejects timestamps more than 5 minutes old or in the future (Standard Webhooks tolerance)', async () => {
    const p = provider();
    for (const offset of [-301, 301, -3600]) {
      const ts = String(Math.floor(Date.now() / 1000) + offset);
      const sig = standardSign(keyBytes, id, ts, body);
      expect(await p.verifyWebhook({ rawBody: body, headers: headers(id, ts, sig), secret })).toBe(false);
    }
    // Just inside the window is accepted.
    const ts = String(Math.floor(Date.now() / 1000) - 290);
    expect(await p.verifyWebhook({ rawBody: body, headers: headers(id, ts, standardSign(keyBytes, id, ts, body)), secret })).toBe(true);
  });
});

// ── parseRedemption ─────────────────────────────────────────────────────────

describe('parseRedemption', () => {
  const parse = (evt: unknown) => provider().parseRedemption(typeof evt === 'string' ? evt : JSON.stringify(evt));
  const withData = (patch: Record<string, unknown>) => ({
    ...paymentDiscounted,
    data: { ...paymentDiscounted.data, ...patch },
  });

  it('reads code and discount_id from discounts[0] and the pre-tax charged amount in minor units', () => {
    expect(parse(paymentDiscounted)).toEqual({
      eventId: 'pay_gr4RizvMOXFJ6xca3y2tU',
      code: 'PPP-IN30-K7QX',
      providerCouponId: 'dsc_qxxEmg5PuM1uNTE0LgkP9',
      providerPromoCodeId: null,
      // total_amount 826 "including tax" and tax 126 (C3: the handler uses 826 − 126)
      chargedAmountCents: 826,
      taxAmountCents: 126,
      discountAmountCents: null,
      currency: 'USD',
    });
  });

  it('reports a missing tax as unknown (null), not as zero', () => {
    const r = parse(withData({ tax: null }));
    expect([r?.chargedAmountCents, r?.taxAmountCents]).toEqual([826, null]);
  });

  it('takes the position-0 discount when several codes are stacked', () => {
    const [first] = paymentDiscounted.data.discounts;
    const stacked = [
      { ...first, position: 1, code: 'LAUNCH10', discount_id: 'dsc_launch' },
      { ...first, position: 0 },
    ];
    expect(parse(withData({ discounts: stacked }))).toMatchObject({
      code: 'PPP-IN30-K7QX',
      providerCouponId: 'dsc_qxxEmg5PuM1uNTE0LgkP9',
    });
  });

  it('falls back to the deprecated top-level discount_id when discounts[] is absent', () => {
    const { discounts: _d, ...rest } = paymentDiscounted.data;
    expect(parse({ ...paymentDiscounted, data: rest })).toMatchObject({
      code: null,
      providerCouponId: 'dsc_qxxEmg5PuM1uNTE0LgkP9',
    });
  });

  it('returns null for a payment with no discount', () => {
    expect(parse(withData({ discounts: [], discount_id: null }))).toBeNull();
    expect(parse(withData({ discounts: null, discount_id: null }))).toBeNull();
  });

  it('returns null for unrelated events', () => {
    expect(parse({ ...paymentDiscounted, type: 'payment.failed' })).toBeNull();
    expect(parse({ ...paymentDiscounted, type: 'refund.succeeded' })).toBeNull();
    expect(parse({ business_id: 'bus_1', type: 'subscription.active', timestamp: 't', data: { payload_type: 'Subscription', subscription_id: 'sub_1', discount_id: 'dsc_1' } })).toBeNull();
  });

  it('returns null for a subscription renewal charge, so each billing cycle is not counted as a new redemption', () => {
    expect(paymentRenewal.data.charge_type).toBe('renewal');
    expect(parse(paymentRenewal)).toBeNull();
    expect(parse(withData({ charge_type: 'on_demand' }))).toBeNull();
    expect(parse(withData({ charge_type: 'plan_change' }))).toBeNull();
  });

  it('counts the first charge of a subscription (charge_type "new")', () => {
    expect(parse({ ...paymentRenewal, data: { ...paymentRenewal.data, charge_type: 'new' } })).toMatchObject({
      eventId: 'pay_R3n3wa1Xc8b2Lm0Pq9ZtY',
      code: 'PPP-IN30-K7QX',
    });
  });

  it('returns null for a payment-method update charge', () => {
    expect(parse(withData({ is_update_payment_method: true }))).toBeNull();
  });

  it('returns null when payment_id is missing (it is the idempotency key)', () => {
    expect(parse(withData({ payment_id: undefined }))).toBeNull();
    expect(parse(withData({ payment_id: '' }))).toBeNull();
  });

  it('passes amounts through in the currency\'s smallest unit (JPY has no minor unit)', () => {
    expect(parse(withData({ total_amount: 1500, tax: null, currency: 'JPY' }))).toMatchObject({
      chargedAmountCents: 1500,
      currency: 'JPY',
    });
  });

  it('returns null for a malformed body', () => {
    expect(parse('not json')).toBeNull();
    expect(parse('null')).toBeNull();
  });
});
