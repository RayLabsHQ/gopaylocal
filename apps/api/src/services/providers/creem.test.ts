// Unit tests for the Creem provider, with `fetch` mocked. No live calls.
//
// Sources for every request/response shape asserted here (Creem docs, fetched
// 2026-11-18; endpoint pages render https://docs.creem.io/api-reference/openapi.json):
//  - https://docs.creem.io/api-reference/introduction (hosts, x-api-key, status codes)
//  - https://docs.creem.io/api-reference/error-codes (error body: trace_id, status, error, message[])
//  - https://docs.creem.io/integrations/linkjolt ("A Test Mode key starts with `creem_test_`")
//  - https://docs.creem.io/api-reference/endpoint/{create-discount-code,delete-discount-code,search-discounts}
//  - https://docs.creem.io/getting-started/migrate/lemon-squeezy/technical-guide
//    (applies_to_products required; "products you create later aren't covered")
//  - https://docs.creem.io/api-reference/endpoint/search-products
//  - https://docs.creem.io/api-reference/endpoint/create-checkout
//  - https://docs.creem.io/api-reference/endpoint/{create-webhook,get-webhook-secret,delete-webhook}
//  - https://docs.creem.io/code/webhooks (creem-signature HMAC-SHA256 hex over the raw
//    body; checkout.completed / subscription.paid samples; the Discounts section)
//
// Assertions are at the HTTP level (method, URL, query, headers, JSON body).

import { describe, it, expect, vi, afterEach } from 'vitest';
import { createHmac, randomBytes } from 'node:crypto';
import { CreemProvider } from './creem';
import { ProviderError, ProviderAuthError, ProviderNotFoundError } from './types';
import { computeSavingsMinor } from '../redemption.service';
// checkout.completed sample + the documented discount fields (tax-exclusive EUR, NL).
import checkoutDiscount from './__fixtures__/creem/checkout-completed-discount.json';
// The same order with no tax applied (the untaxed half of the C3 pair).
import checkoutDiscountUntaxed from './__fixtures__/creem/checkout-completed-discount-untaxed.json';
// checkout.completed for a one-time, tax-inclusive USD product with a discount.
import checkoutInclusive from './__fixtures__/creem/checkout-completed-inclusive-onetime.json';
// checkout.completed sample verbatim (no discount).
import checkoutNoDiscount from './__fixtures__/creem/checkout-completed-no-discount.json';
// subscription.paid sample verbatim (first payment AND every renewal).
import subscriptionPaid from './__fixtures__/creem/subscription-paid.json';
// DiscountEntity (POST /v1/discounts response).
import discountEntity from './__fixtures__/creem/discount-entity.json';
// WebhookEntity (POST /v1/webhooks response, with the create-only secret).
import webhookEntity from './__fixtures__/creem/webhook-entity.json';
// ProductListEntity (GET /v1/products/search), one page.
import productsPage from './__fixtures__/creem/products-search-page.json';

const LIVE = 'https://api.creem.io';
const TEST = 'https://test-api.creem.io';
const LIVE_KEY = 'creem_1A2b3C4d5E6f7G8h9I0j';
const TEST_KEY = 'creem_test_1A2b3C4d5E6f7G8h9I0j';

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

/** Creem's documented error body. */
function creemError(status: number, error: string, message?: string[]): Response {
  return json(
    {
      trace_id: '550e8400-e29b-41d4-a716-446655440000',
      status,
      error,
      ...(message ? { message } : {}),
      timestamp: 1706889600000,
    },
    status,
  );
}

/** Ordered fetch mock; an unexpected request throws, so nothing reaches the network. */
function mockFetch(...handlers: Handler[]): Call[] {
  const calls: Call[] = [];
  let i = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input as RequestInfo, init);
      const headers: Record<string, string> = {};
      req.headers.forEach((v, k) => {
        headers[k] = v;
      });
      const text = await req.text();
      const call: Call = { url: req.url, method: req.method.toUpperCase(), headers, body: text === '' ? undefined : text };
      calls.push(call);
      const handler = handlers[i++];
      if (!handler) throw new Error(`Unexpected fetch #${i}: ${call.method} ${call.url}`);
      return handler(call);
    }),
  );
  return calls;
}

function provider(apiKey = LIVE_KEY, environment: 'live' | 'test' = 'live'): CreemProvider {
  return new CreemProvider({ apiKey, environment });
}

const bodyOf = (call: Call): unknown => (call.body === undefined ? undefined : JSON.parse(call.body));
const query = (call: Call): Record<string, string> => Object.fromEntries(new URL(call.url).searchParams);
const path = (call: Call): string => {
  const u = new URL(call.url);
  return `${u.origin}${u.pathname}`;
};

/** A ProductListEntity / DiscountListEntity page. */
const page = <T>(items: T[], current: number, next: number | null) => ({
  items,
  pagination: { total_records: 0, total_pages: 0, current_page: current, next_page: next, prev_page: current > 1 ? current - 1 : null },
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ── Environment and auth ────────────────────────────────────────────────────

describe('environment and auth', () => {
  it('uses api.creem.io for live and test-api.creem.io for test, with the key in x-api-key', async () => {
    const calls = mockFetch(
      () => json({ checkout_url: 'https://creem.io/checkout/a' }),
      () => json({ checkout_url: 'https://creem.io/test/checkout/b' }),
    );
    await provider(LIVE_KEY, 'live').buildCheckoutUrl({ productId: 'prod_1', successUrl: 'https://x' });
    await provider(TEST_KEY, 'test').buildCheckoutUrl({ productId: 'prod_1', successUrl: 'https://x' });
    expect(path(calls[0]!)).toBe(`${LIVE}/v1/checkouts`);
    expect(path(calls[1]!)).toBe(`${TEST}/v1/checkouts`);
    expect(calls[0]!.headers['x-api-key']).toBe(LIVE_KEY);
    expect(calls[1]!.headers['x-api-key']).toBe(TEST_KEY);
    expect(calls[0]!.headers['authorization']).toBeUndefined();
  });

  it('refuses a creem_test_ key in the live slot without calling Creem', async () => {
    // Docs: test keys start with creem_test_ and "only work with test-api.creem.io".
    const calls = mockFetch();
    const err = await provider(TEST_KEY, 'live').listDiscounts().catch((e) => e);
    expect(err).toBeInstanceOf(ProviderAuthError);
    expect(err.message).toMatch(/test-mode key/);
    expect(calls).toHaveLength(0);
  });

  it('maps 401 (missing key) and 403 (invalid key or insufficient permissions) to ProviderAuthError', async () => {
    mockFetch(() => creemError(401, 'Unauthorized'));
    await expect(provider().listDiscounts()).rejects.toBeInstanceOf(ProviderAuthError);
    mockFetch(() => creemError(403, 'Forbidden'));
    const err = await provider().listDiscounts().catch((e) => e);
    expect(err).toBeInstanceOf(ProviderAuthError);
    expect(err.message).toContain('Forbidden');
    expect(err.message).toContain('trace_id 550e8400');
  });

  it('joins the message array of a 400 and keeps the status', async () => {
    mockFetch(() => creemError(400, 'Bad Request', ['product_id must be a string', 'success_url must be a valid URL']));
    const err = await provider().buildCheckoutUrl({ productId: 'p', successUrl: 'x' }).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err).not.toBeInstanceOf(ProviderAuthError);
    expect(err.statusCode).toBe(400);
    expect(err.message).toContain('product_id must be a string; success_url must be a valid URL');
  });

  it('maps 429 and a non-JSON 502 to ProviderError with the status', async () => {
    mockFetch(() => creemError(429, 'Too Many Requests'));
    expect((await provider().listProducts().catch((e) => e)).statusCode).toBe(429);
    mockFetch(() => new Response('<html>Bad gateway</html>', { status: 502 }));
    const err = await provider().listProducts().catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.statusCode).toBe(502);
    expect(err.message).toContain('HTTP 502');
  });

  it('fails on a 200 that is not JSON', async () => {
    mockFetch(() => new Response('ok', { status: 200 }));
    await expect(provider().buildCheckoutUrl({ productId: 'p', successUrl: 'x' })).rejects.toThrow(/not valid JSON/);
  });
});

// ── createDiscount ──────────────────────────────────────────────────────────

describe('createDiscount', () => {
  it('POSTs /v1/discounts with percentage, duration forever and the given products', async () => {
    const calls = mockFetch(() => json(discountEntity));

    const result = await provider().createDiscount({
      name: 'PPP NL 30%',
      code: 'PPPNL30K7QX',
      discountType: 'percentage',
      amount: 30,
      productIds: ['prod_d1AY2Sadk9YAvLI0pj97f'],
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.url).toBe(`${LIVE}/v1/discounts`);
    expect(calls[0]!.headers['x-api-key']).toBe(LIVE_KEY);
    expect(calls[0]!.headers['content-type']).toBe('application/json');
    expect(bodyOf(calls[0]!)).toEqual({
      name: 'PPP NL 30%',
      code: 'PPPNL30K7QX',
      type: 'percentage',
      percentage: 30,
      duration: 'forever',
      applies_to_products: ['prod_d1AY2Sadk9YAvLI0pj97f'],
    });
    expect(result).toEqual({
      providerDiscountId: 'dis_3e6Z6TzvHKdsjEgXnGDEp0',
      code: 'PPPNL30K7QX',
      discountPercent: 30,
      provider: 'creem',
    });
  });

  it('without productIds, scopes the code to every active product (applies_to_products is required)', async () => {
    // coupon.service never passes productIds. Docs: "A ... code that applies to
    // everything must list every Creem product".
    const p = (id: string) => ({ ...productsPage.items[0], id });
    const calls = mockFetch(
      () => json(page([p('prod_1'), p('prod_2')], 1, 2)),
      () => json(page([p('prod_3')], 2, null)),
      () => json(discountEntity),
    );

    await provider().createDiscount({ name: 'PPP NL 30%', code: 'PPPNL30K7QX', discountType: 'percentage', amount: 30 });

    expect(calls.map((c) => `${c.method} ${path(c)}`)).toEqual([
      `GET ${LIVE}/v1/products/search`,
      `GET ${LIVE}/v1/products/search`,
      `POST ${LIVE}/v1/discounts`,
    ]);
    expect(query(calls[0]!)).toEqual({ status: 'active', page_number: '1', page_size: '10' });
    expect(query(calls[1]!)).toEqual({ status: 'active', page_number: '2', page_size: '10' });
    expect(bodyOf(calls[2]!)).toMatchObject({ applies_to_products: ['prod_1', 'prod_2', 'prod_3'] });
  });

  it('skips products whose status is not active even if the filter was ignored', async () => {
    const calls = mockFetch(
      () => json(page([{ ...productsPage.items[0], id: 'prod_live' }, { ...productsPage.items[0], id: 'prod_old', status: 'archived' }], 1, null)),
      () => json(discountEntity),
    );
    await provider().createDiscount({ name: 'n', code: 'ABC', discountType: 'percentage', amount: 10 });
    expect(bodyOf(calls[1]!)).toMatchObject({ applies_to_products: ['prod_live'] });
  });

  it('refuses to create a code when the store has no active products', async () => {
    const calls = mockFetch(() => json(page([], 1, null)));
    const err = await provider()
      .createDiscount({ name: 'n', code: 'ABC', discountType: 'percentage', amount: 10 })
      .catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.message).toMatch(/no active products/);
    expect(calls).toHaveLength(1);
  });

  it('maps expiresAt to expiry_date and maxRedemptions to max_redemptions, passing fractional percents through', async () => {
    const calls = mockFetch(() => json({ ...discountEntity, percentage: 12.5, amount: 12.5 }));
    const result = await provider().createDiscount({
      name: 'n',
      code: 'ABC',
      discountType: 'percentage',
      amount: 12.5,
      productIds: ['prod_1'],
      expiresAt: '2027-01-01T00:00:00Z',
      maxRedemptions: 50,
    });
    expect(bodyOf(calls[0]!)).toEqual({
      name: 'n',
      code: 'ABC',
      type: 'percentage',
      percentage: 12.5,
      duration: 'forever',
      applies_to_products: ['prod_1'],
      expiry_date: '2027-01-01T00:00:00Z',
      max_redemptions: 50,
    });
    expect(result.discountPercent).toBe(12.5);
  });

  it("returns Creem's stored code, which is what checkout accepts", async () => {
    mockFetch(() => json({ ...discountEntity, code: 'PPPNL30K7QX' }));
    const r = await provider().createDiscount({ name: 'n', code: 'pppnl30k7qx', discountType: 'percentage', amount: 30, productIds: ['p'] });
    expect(r.code).toBe('PPPNL30K7QX');
  });

  it('rejects fixed-amount discounts and empty codes without calling Creem', async () => {
    const calls = mockFetch();
    await expect(
      provider().createDiscount({ name: 'n', code: 'ABC', discountType: 'fixed', amount: 500, currency: 'USD' }),
    ).rejects.toThrow(/only percentage/);
    // An empty code would make Creem generate one the banner never shows.
    await expect(
      provider().createDiscount({ name: 'n', code: ' ', discountType: 'percentage', amount: 10, productIds: ['p'] }),
    ).rejects.toThrow(/code is required/);
    expect(calls).toHaveLength(0);
  });

  it('surfaces a duplicate code (400 "The code has already been taken")', async () => {
    mockFetch(() => creemError(400, 'Bad Request', ['The code has already been taken']));
    const err = await provider()
      .createDiscount({ name: 'n', code: 'ABC', discountType: 'percentage', amount: 10, productIds: ['p'] })
      .catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.statusCode).toBe(400);
    expect(err.message).toContain('The code has already been taken');
  });

  it('fails when the response has no discount id', async () => {
    mockFetch(() => json({ object: 'discount' }));
    await expect(
      provider().createDiscount({ name: 'n', code: 'ABC', discountType: 'percentage', amount: 10, productIds: ['p'] }),
    ).rejects.toThrow(/No discount id/);
  });
});

// ── deleteDiscount ──────────────────────────────────────────────────────────

describe('deleteDiscount', () => {
  it('DELETEs /v1/discounts/{id}/delete (200 with the deleted DiscountEntity)', async () => {
    const calls = mockFetch(() => json({ ...discountEntity, status: 'deleted' }));
    await provider().deleteDiscount('dis_3e6Z6TzvHKdsjEgXnGDEp0');
    expect(calls[0]!.method).toBe('DELETE');
    expect(calls[0]!.url).toBe(`${LIVE}/v1/discounts/dis_3e6Z6TzvHKdsjEgXnGDEp0/delete`);
    expect(calls[0]!.headers['x-api-key']).toBe(LIVE_KEY);
    expect(calls[0]!.body).toBeUndefined();
  });

  it('maps 404 to ProviderNotFoundError naming the discount', async () => {
    mockFetch(() => creemError(404, 'Bad Request', ['Discount not found']));
    const err = await provider().deleteDiscount('dis_gone').catch((e) => e);
    expect(err).toBeInstanceOf(ProviderNotFoundError);
    expect(err.message).toContain("discount 'dis_gone'");
  });
});

// ── listDiscounts ───────────────────────────────────────────────────────────

describe('listDiscounts', () => {
  const d = (i: number, extra: Record<string, unknown> = {}) => ({
    ...discountEntity,
    id: `dis_${i}`,
    code: `CODE${i}`,
    percentage: 10 + i,
    amount: 10 + i,
    ...extra,
  });

  it('walks pages by pagination.next_page with status=active and the documented default page size', async () => {
    const calls = mockFetch(
      () => json(page(Array.from({ length: 10 }, (_, i) => d(i)), 1, 2)),
      () => json(page([d(10), d(11)], 2, null)),
    );
    const discounts = await provider().listDiscounts();
    expect(calls.every((c) => c.method === 'GET' && path(c) === `${LIVE}/v1/discounts/search`)).toBe(true);
    expect(calls.map(query)).toEqual([
      { status: 'active', page_number: '1', page_size: '10' },
      { status: 'active', page_number: '2', page_size: '10' },
    ]);
    expect(discounts).toHaveLength(12);
    expect(discounts[11]).toEqual({ providerDiscountId: 'dis_11', code: 'CODE11', discountPercent: 21, provider: 'creem' });
  });

  it('drops deleted and expired discounts even if the status filter is ignored (sync reads absence as gone)', async () => {
    mockFetch(() =>
      json(page([d(1), d(2, { status: 'deleted' }), d(3, { status: 'expired' })], 1, null)),
    );
    expect((await provider().listDiscounts()).map((x) => x.providerDiscountId)).toEqual(['dis_1']);
  });

  it('drops draft/scheduled codes, a passed expiry_date and used-up max_redemptions even while status says active', async () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    const future = new Date(Date.now() + 86_400_000).toISOString();
    mockFetch(() =>
      json(
        page(
          [
            d(1),
            d(2, { status: 'draft' }),
            d(3, { status: 'scheduled' }),
            d(4, { expiry_date: past }),
            d(5, { expiry_date: future }),
            d(6, { max_redemptions: 100, redeem_count: 100 }),
            d(7, { max_redemptions: 100, redeem_count: 15 }),
            d(8, { expiry_date: 'not a date', max_redemptions: null }),
          ],
          1,
          null,
        ),
      ),
    );
    expect((await provider().listDiscounts()).map((x) => x.providerDiscountId)).toEqual(['dis_1', 'dis_5', 'dis_7', 'dis_8']);
  });

  it('reports 0% for a fixed discount and reads `amount` when `percentage` is absent', async () => {
    mockFetch(() =>
      json(page([d(1, { type: 'fixed', amount: 500, percentage: undefined, currency: 'USD' }), d(2, { percentage: undefined, amount: 25 })], 1, null)),
    );
    const [fixed, pct] = await provider().listDiscounts();
    expect(fixed!.discountPercent).toBe(0);
    expect(pct!.discountPercent).toBe(25);
  });

  it('refuses a next_page that does not advance instead of looping', async () => {
    mockFetch(() => json(page([d(1)], 1, 1)));
    await expect(provider().listDiscounts()).rejects.toThrow(/Unexpected pagination/);
  });

  it('throws past 1,000 items rather than return a truncated list', async () => {
    let n = 0;
    const handlers = Array.from({ length: 100 }, () => () => {
      n++;
      return json(page(Array.from({ length: 10 }, (_, i) => d(n * 10 + i)), n, n + 1));
    });
    mockFetch(...handlers);
    await expect(provider().listDiscounts()).rejects.toThrow(/More than 1000 items/);
  });

  it('falls back to the short-page rule when pagination is missing', async () => {
    const calls = mockFetch(
      () => json({ items: Array.from({ length: 10 }, (_, i) => d(i)) }),
      () => json({ items: [d(10)] }),
    );
    expect(await provider().listDiscounts()).toHaveLength(11);
    expect(calls.map((c) => query(c).page_number)).toEqual(['1', '2']);
  });
});

// ── listProducts ────────────────────────────────────────────────────────────

describe('listProducts', () => {
  it('lists active products with prices converted from cents and the product_url', async () => {
    const calls = mockFetch(() => json(productsPage));
    const products = await provider(TEST_KEY, 'test').listProducts();
    expect(path(calls[0]!)).toBe(`${TEST}/v1/products/search`);
    expect(query(calls[0]!)).toEqual({ status: 'active', page_number: '1', page_size: '10' });
    expect(products).toEqual([
      {
        providerProductId: 'prod_d1AY2Sadk9YAvLI0pj97f',
        name: 'Monthly',
        price: 10,
        currency: 'EUR',
        url: 'https://creem.io/product/prod_d1AY2Sadk9YAvLI0pj97f',
      },
      { providerProductId: 'prod_AnVJ11ujp7x953ARpJvAF', name: 'My Product - Product 01', price: 100, currency: 'USD', url: null },
    ]);
  });
});

// ── buildCheckoutUrl ────────────────────────────────────────────────────────

describe('buildCheckoutUrl', () => {
  it('POSTs /v1/checkouts with product_id, discount_code, success_url, customer.email and metadata', async () => {
    const calls = mockFetch(() =>
      json({ id: 'ch_4l0N34kxo16AhRKUHFUuXr', object: 'checkout', status: 'pending', product: 'prod_d1AY2Sadk9YAvLI0pj97f', checkout_url: 'https://creem.io/checkout/prod_d1AY2Sadk9YAvLI0pj97f/ch_4l0N34kxo16AhRKUHFUuXr' }),
    );
    const url = await provider().buildCheckoutUrl({
      productId: 'prod_d1AY2Sadk9YAvLI0pj97f',
      discountCode: 'PPPNL30K7QX',
      discountId: 'dis_3e6Z6TzvHKdsjEgXnGDEp0', // no Creem field: not sent
      successUrl: 'https://merchant.example/thanks',
      cancelUrl: 'https://merchant.example/pricing', // no Creem field: not sent
      customerEmail: 'buyer@example.com',
      metadata: { gpl_campaign: 'c1' },
    });
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.url).toBe(`${LIVE}/v1/checkouts`);
    expect(calls[0]!.headers['content-type']).toBe('application/json');
    expect(bodyOf(calls[0]!)).toEqual({
      product_id: 'prod_d1AY2Sadk9YAvLI0pj97f',
      discount_code: 'PPPNL30K7QX',
      success_url: 'https://merchant.example/thanks',
      customer: { email: 'buyer@example.com' },
      metadata: { gpl_campaign: 'c1' },
    });
    expect(url).toBe('https://creem.io/checkout/prod_d1AY2Sadk9YAvLI0pj97f/ch_4l0N34kxo16AhRKUHFUuXr');
  });

  it('omits optional fields and fails when no checkout_url comes back', async () => {
    const calls = mockFetch(() => json({ id: 'ch_1', object: 'checkout' }));
    await expect(provider().buildCheckoutUrl({ productId: 'prod_1', successUrl: '' })).rejects.toThrow(/No checkout URL/);
    expect(bodyOf(calls[0]!)).toEqual({ product_id: 'prod_1' });
  });
});

// ── Webhook endpoints ───────────────────────────────────────────────────────

describe('provisionWebhook / deleteWebhook', () => {
  const CALLBACK = 'https://api.gopaylocal.com/v1/webhooks/creem/01HZINTEGRATION';

  it('POSTs /v1/webhooks for checkout.completed only and returns the create-only secret', async () => {
    const calls = mockFetch(() => json(webhookEntity));
    const result = await provider().provisionWebhook(CALLBACK);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.url).toBe(`${LIVE}/v1/webhooks`);
    expect(bodyOf(calls[0]!)).toEqual({
      url: CALLBACK,
      name: 'GoPayLocal',
      delivery_mode: 'http',
      events: ['checkout.completed'], // an empty list would subscribe to every event
    });
    expect(result).toEqual({ endpointId: 'wh_5Tq8Rz2Lm4Np6Vx', secret: 'whsec_xxxxxxxxxxxxxxxxxxxx' });
  });

  it('reads GET /v1/webhooks/{id}/secret when the create response lacks the secret', async () => {
    const { secret: _s, ...noSecret } = webhookEntity;
    const calls = mockFetch(() => json(noSecret), () => json({ secret: 'whsec_readback' }));
    const result = await provider().provisionWebhook(CALLBACK);
    expect(calls[1]!.method).toBe('GET');
    expect(calls[1]!.url).toBe(`${LIVE}/v1/webhooks/wh_5Tq8Rz2Lm4Np6Vx/secret`);
    expect(result.secret).toBe('whsec_readback');
  });

  it('deletes the endpoint it just created when no secret can be had, so nothing keeps firing', async () => {
    const { secret: _s, ...noSecret } = webhookEntity;
    let calls = mockFetch(() => json(noSecret), () => creemError(500, 'Internal Server Error'), () => json(webhookEntity));
    await expect(provider().provisionWebhook(CALLBACK)).rejects.toBeInstanceOf(ProviderError);
    expect(calls[2]!.method).toBe('DELETE');
    expect(calls[2]!.url).toBe(`${LIVE}/v1/webhooks/wh_5Tq8Rz2Lm4Np6Vx`);

    calls = mockFetch(() => json(noSecret), () => json({ secret: '' }), () => json(webhookEntity));
    await expect(provider().provisionWebhook(CALLBACK)).rejects.toThrow(/No signing secret/);
    expect(calls[2]!.method).toBe('DELETE');
  });

  it('fails without a cleanup call when the create response has no id', async () => {
    const calls = mockFetch(() => json({ object: 'webhook' }));
    await expect(provider().provisionWebhook(CALLBACK)).rejects.toThrow(/No webhook id/);
    expect(calls).toHaveLength(1);
  });

  it('deleteWebhook DELETEs /v1/webhooks/{id} and maps 404 to ProviderNotFoundError', async () => {
    let calls = mockFetch(() => json({ ...webhookEntity, secret: undefined }));
    await expect(provider().deleteWebhook('wh_5Tq8Rz2Lm4Np6Vx')).resolves.toBeUndefined();
    expect(calls[0]!.method).toBe('DELETE');
    expect(calls[0]!.url).toBe(`${LIVE}/v1/webhooks/wh_5Tq8Rz2Lm4Np6Vx`);

    calls = mockFetch(() => creemError(404, 'Not Found', ['Webhook not found']));
    await expect(provider().deleteWebhook('wh_gone')).rejects.toBeInstanceOf(ProviderNotFoundError);
  });
});

// ── verifyWebhook ───────────────────────────────────────────────────────────

/** Independent signer per the docs' own snippet: createHmac('sha256', secret).update(payload).digest('hex'). */
const sign = (secret: string, body: string) => createHmac('sha256', secret).update(body).digest('hex');

const sigHeaders = (sig: string | null) => {
  const h = new Headers({ 'content-type': 'application/json' });
  if (sig !== null) h.set('creem-signature', sig);
  return h;
};

describe('verifyWebhook', () => {
  const secret = `whsec_${randomBytes(24).toString('base64url')}`;
  const body = JSON.stringify(checkoutDiscount);

  it('accepts a body signed with the secret string (hex HMAC-SHA256 of the raw body)', async () => {
    expect(await provider().verifyWebhook({ rawBody: body, headers: sigHeaders(sign(secret, body)), secret })).toBe(true);
  });

  it('keys the HMAC with the whole secret string, prefix included (not a base64-decoded key)', async () => {
    const decodedKey = Buffer.from(secret.slice('whsec_'.length), 'base64url');
    const wrongScheme = createHmac('sha256', decodedKey).update(body).digest('hex');
    expect(await provider().verifyWebhook({ rawBody: body, headers: sigHeaders(wrongScheme), secret })).toBe(false);
  });

  it('accepts an upper-case hex header and surrounding whitespace', async () => {
    const sig = ` ${sign(secret, body).toUpperCase()} `;
    expect(await provider().verifyWebhook({ rawBody: body, headers: sigHeaders(sig), secret })).toBe(true);
  });

  it('rejects a tampered body and a signature made with another secret', async () => {
    const sig = sign(secret, body);
    const tampered = body.replace('"amount_paid":847', '"amount_paid":1');
    expect(tampered).not.toBe(body);
    expect(await provider().verifyWebhook({ rawBody: tampered, headers: sigHeaders(sig), secret })).toBe(false);
    expect(await provider().verifyWebhook({ rawBody: body, headers: sigHeaders(sign('whsec_other', body)), secret })).toBe(false);
  });

  it('rejects a missing header, a missing secret and malformed signatures', async () => {
    const p = provider();
    expect(await p.verifyWebhook({ rawBody: body, headers: sigHeaders(null), secret })).toBe(false);
    expect(await p.verifyWebhook({ rawBody: body, headers: sigHeaders(sign(secret, body)), secret: null })).toBe(false);
    for (const sig of ['', 'garbage', sign(secret, body).slice(0, 63), `${sign(secret, body)}00`, `sha256=${sign(secret, body)}`]) {
      expect(await p.verifyWebhook({ rawBody: body, headers: sigHeaders(sig), secret })).toBe(false);
    }
  });

  it('needs no API key (the webhook route may build the provider without one)', async () => {
    const p = new CreemProvider({ apiKey: '', environment: 'live' });
    expect(await p.verifyWebhook({ rawBody: body, headers: sigHeaders(sign(secret, body)), secret })).toBe(true);
  });
});

// ── parseRedemption ─────────────────────────────────────────────────────────

describe('parseRedemption', () => {
  const parse = (evt: unknown) => provider().parseRedemption(typeof evt === 'string' ? evt : JSON.stringify(evt));
  const withOrder = (patch: Record<string, unknown>) => ({
    ...checkoutDiscount,
    object: { ...checkoutDiscount.object, order: { ...checkoutDiscount.object.order, ...patch } },
  });

  it('reads the code, discount id, order id and amounts from checkout.completed (tax-exclusive)', () => {
    expect(parse(checkoutDiscount)).toEqual({
      eventId: 'ord_4aDwWXjMLpes4Kj4XqNnUA',
      code: 'PPPNL30K7QX',
      providerCouponId: 'dis_3e6Z6TzvHKdsjEgXnGDEp0',
      providerPromoCodeId: null,
      chargedAmountCents: 847, // amount_paid, tax included (C3)
      taxAmountCents: 147,
      // Exclusive tax is added on top of the price, so the discount taken off the price is pre-tax.
      discountAmountCents: 300,
      currency: 'EUR',
    });
  });

  it('emits no discount amount for a tax-inclusive product (it contains tax), leaving charged and tax for back-calculation', () => {
    expect(parse(checkoutInclusive)).toEqual({
      eventId: 'ord_3Hj5Kl7Np9Qr1St3Uv5Wx7',
      code: 'PPPDE40M4RT',
      providerCouponId: 'dis_6Yz8Ab0Cd2Ef4Gh6Ij8Kl',
      providerPromoCodeId: null,
      chargedAmountCents: 1200,
      taxAmountCents: 192,
      discountAmountCents: null,
      currency: 'USD',
    });
  });

  it('emits no discount amount when the product (and so its tax mode) is not expanded', () => {
    const evt = { ...checkoutDiscount, object: { ...checkoutDiscount.object, product: 'prod_d1AY2Sadk9YAvLI0pj97f' } };
    expect(parse(evt)).toMatchObject({ discountAmountCents: null, chargedAmountCents: 847, taxAmountCents: 147 });
  });

  it('keeps a zero tax as 0 and an absent one as null', () => {
    expect(parse(withOrder({ tax_amount: 0 }))!.taxAmountCents).toBe(0);
    const { tax_amount: _t, ...noTax } = checkoutDiscount.object.order;
    expect(parse({ ...checkoutDiscount, object: { ...checkoutDiscount.object, order: noTax } })!.taxAmountCents).toBeNull();
  });

  it('dedupes on the order id, so a manual resend (new event id) is the same redemption', () => {
    const resend = { ...checkoutDiscount, id: 'evt_resentWithNewId', created_at: 1728734999999 };
    expect(parse(resend)!.eventId).toBe(parse(checkoutDiscount)!.eventId);
  });

  it('falls back to the checkout discount id when order.discount is absent, and to the checkout id without an order id', () => {
    const { discount: _d, id: _id, ...order } = checkoutDiscount.object.order;
    expect(parse({ ...checkoutDiscount, object: { ...checkoutDiscount.object, order } })).toMatchObject({
      eventId: 'ch_4l0N34kxo16AhRKUHFUuXr',
      providerCouponId: 'dis_3e6Z6TzvHKdsjEgXnGDEp0',
      code: 'PPPNL30K7QX',
    });
  });

  it('attributes by id alone when the checkout discount object is missing', () => {
    const { discount: _d, ...object } = checkoutDiscount.object;
    expect(parse({ ...checkoutDiscount, object })).toMatchObject({ code: null, providerCouponId: 'dis_3e6Z6TzvHKdsjEgXnGDEp0' });
  });

  it('returns null for a checkout without a discount (the documented sample)', () => {
    expect(parse(checkoutNoDiscount)).toBeNull();
  });

  it('returns null for subscription.paid, so renewals are never counted', () => {
    expect(subscriptionPaid.eventType).toBe('subscription.paid');
    expect(parse(subscriptionPaid)).toBeNull();
    // Even if a renewal carried the subscription's discount object.
    expect(parse({ ...subscriptionPaid, object: { ...subscriptionPaid.object, discount: checkoutDiscount.object.discount } })).toBeNull();
  });

  it('returns null for a pending order (OrderStatus is pending | paid)', () => {
    expect(parse(withOrder({ status: 'pending' }))).toBeNull();
  });

  it('returns null for other events and malformed bodies', () => {
    expect(parse({ ...checkoutDiscount, eventType: 'refund.created' })).toBeNull();
    expect(parse({ ...checkoutDiscount, object: { ...checkoutDiscount.object, order: undefined } })).toBeNull();
    expect(parse('not json')).toBeNull();
    expect(parse('null')).toBeNull();
    expect(parse('[]')).toBeNull();
  });
});

// Contract C3 end to end: what the redemption handler records as revenue saved
// (computeSavingsMinor, the handler's own function) is the pre-tax saving.
describe('C3: pre-tax revenue saved', () => {
  const savings = (evt: unknown, percent: number) => {
    const r = provider().parseRedemption(JSON.stringify(evt));
    expect(r).not.toBeNull();
    return computeSavingsMinor(r!.discountAmountCents, r!.chargedAmountCents, r!.taxAmountCents, percent);
  };
  const patchOrder = (evt: typeof checkoutDiscount | typeof checkoutInclusive, patch: Record<string, unknown>) => ({
    ...evt,
    object: { ...evt.object, order: { ...evt.object.order, ...patch } },
  });

  it('tax-exclusive: 30% off EUR 10.00 saves 300 with NL VAT or without tax', () => {
    expect(savings(checkoutDiscount, 30)).toBe(300);
    expect(savings(checkoutDiscountUntaxed, 30)).toBe(300);
    expect(provider().parseRedemption(JSON.stringify(checkoutDiscountUntaxed))).toMatchObject({
      chargedAmountCents: 700,
      taxAmountCents: 0,
      discountAmountCents: 300,
      currency: 'EUR',
    });
  });

  it('tax-inclusive: the saving is worked out from amount paid minus tax', () => {
    // 1200 paid incl. 192 VAT -> 1008 pre-tax at 40% off -> pre-tax list 1680 -> 672 saved.
    expect(savings(checkoutInclusive, 40)).toBe(672);
    // Same price where no tax applies: 1200 paid at 40% off -> list 2000 -> 800 saved.
    expect(savings(patchOrder(checkoutInclusive, { tax_amount: 0 }), 40)).toBe(800);
  });

  it('tax-inclusive with tax_amount absent: no saving is invented', () => {
    const { tax_amount: _omit, ...order } = checkoutInclusive.object.order;
    expect(savings({ ...checkoutInclusive, object: { ...checkoutInclusive.object, order } }, 40)).toBeNull();
  });
});
