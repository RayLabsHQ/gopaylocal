// Stripe adapter tests. No network: `fetch` is stubbed (the adapter uses the
// SDK's Fetch HTTP client, so every API call goes through it) and webhook
// signatures are produced by an independent node:crypto implementation of
// https://docs.stripe.com/webhooks#verify-manually.
//
// Request shapes are asserted against the Stripe OpenAPI spec for the version
// the SDK pins, 2026-10-28.endive (github.com/stripe/openapi tag v2596,
// openapi/spec3.json; stripe-node 23.1.0 is generated from it). Fixture
// provenance is noted where each is loaded.
import { readFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StripeProvider, STRIPE_API_VERSION, normalizeStripeCode } from './stripe';
import { ProviderAuthError, ProviderError, ProviderNotFoundError } from './types';

// ── fetch stub ──────────────────────────────────────────────────────────────

interface Call {
  method: string;
  url: URL;
  headers: Headers;
  form: Record<string, string>;
}
type Reply = { status?: number; body: unknown; headers?: Record<string, string> };

let calls: Call[];
let replies: Array<Reply | ((call: Call) => Reply)>;

function stubFetch() {
  calls = [];
  replies = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL, init: RequestInit = {}) => {
      const call: Call = {
        method: init.method ?? 'GET',
        url: new URL(String(input)),
        headers: new Headers(init.headers as Record<string, string>),
        form: Object.fromEntries(new URLSearchParams(typeof init.body === 'string' ? init.body : '')),
      };
      calls.push(call);
      const next = replies.shift();
      if (!next) throw new Error(`unexpected request ${call.method} ${call.url}`);
      const r = typeof next === 'function' ? next(call) : next;
      return new Response(JSON.stringify(r.body), {
        status: r.status ?? 200,
        headers: { 'content-type': 'application/json', 'request-id': 'req_test', ...r.headers },
      });
    }),
  );
}

const reply = (...rs: Array<Reply | ((call: Call) => Reply)>) => replies.push(...rs);
const stripeError = (status: number, error: Record<string, unknown>): Reply => ({
  status,
  body: { error },
  // Stops the SDK's automatic retry so error tests stay single-request.
  headers: { 'stripe-should-retry': 'false' },
});

// Credentials in this file are fake on purpose and do not use Stripe's key
// prefixes: GitHub secret scanning has partner and push-protection patterns for
// Stripe secret keys, restricted keys and webhook signing secrets
// (https://docs.github.com/en/code-security/secret-scanning/introduction/supported-secret-scanning-patterns).
// The adapter never inspects the key's format, and Stripe's verifier uses the
// signing secret as opaque HMAC key bytes.
const KEY = 'fake-stripe-secret-key';
let provider: StripeProvider;

beforeEach(() => {
  stubFetch();
  provider = new StripeProvider({ apiKey: KEY });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function expectStripeRequest(call: Call, method: string, path: string) {
  expect(call.method).toBe(method);
  expect(call.url.origin).toBe('https://api.stripe.com');
  expect(call.url.pathname).toBe(path);
  // Bearer auth (https://docs.stripe.com/api/authentication) and the pinned version.
  expect(call.headers.get('authorization')).toBe(`Bearer ${KEY}`);
  expect(call.headers.get('stripe-version')).toBe('2026-10-28.endive');
  if (method === 'POST') {
    expect(call.headers.get('content-type')).toBe('application/x-www-form-urlencoded');
  }
}

const couponObj = (over: Record<string, unknown> = {}) => ({
  id: 'PPPIN40K7QX', object: 'coupon', percent_off: 40, amount_off: null, currency: null,
  duration: 'forever', metadata: { gopaylocal: 'true' }, valid: true, ...over,
});
// PromotionCode as 2026-10-28.endive returns it: the coupon sits under
// `promotion` (moved there from a top-level `coupon` in 2025-09-30.clover).
const promoObj = (over: Record<string, unknown> = {}) => ({
  id: 'promo_1QxYzALkdIwHu7ixAbCdEfGh', object: 'promotion_code', code: 'PPPIN40K7QX',
  active: true, promotion: { type: 'coupon', coupon: couponObj() }, ...over,
});

// ── config ──────────────────────────────────────────────────────────────────

describe('StripeProvider config', () => {
  it('pins the SDK request version to the version the webhook endpoint renders', () => {
    expect(STRIPE_API_VERSION).toBe('2026-10-28.endive');
  });

  it('constructs with an empty API key (webhook route passes "" when the key cannot be decrypted)', () => {
    // Bug fixed: `new Stripe('')` throws, so the route acked webhooks as
    // "unsupported" and dropped the redemption.
    expect(() => new StripeProvider({ apiKey: '' })).not.toThrow();
  });
});

// ── createDiscount ──────────────────────────────────────────────────────────

describe('createDiscount', () => {
  it('creates a forever coupon then a promotion code, with an alphanumeric code', async () => {
    reply({ body: couponObj() }, { body: promoObj() });

    const result = await provider.createDiscount({
      name: 'PPP IN 40%',
      code: 'PPP-IN40-K7QX', // what coupon.service generates for Stripe today
      discountType: 'percentage',
      amount: 40,
    });

    expect(calls).toHaveLength(2);
    expectStripeRequest(calls[0]!, 'POST', '/v1/coupons');
    expect(calls[0]!.form).toEqual({
      id: 'PPPIN40K7QX',
      duration: 'forever',
      name: 'PPP IN 40%',
      percent_off: '40',
      'metadata[gopaylocal]': 'true',
      'metadata[name]': 'PPP IN 40%',
    });

    expectStripeRequest(calls[1]!, 'POST', '/v1/promotion_codes');
    // v2596: `promotion` (type + coupon) is required; `code` stays a-z, A-Z, 0-9.
    expect(calls[1]!.form).toEqual({
      'promotion[type]': 'coupon',
      'promotion[coupon]': 'PPPIN40K7QX',
      code: 'PPPIN40K7QX',
      'metadata[gopaylocal]': 'true',
    });

    expect(result).toEqual({
      providerDiscountId: 'PPPIN40K7QX',
      code: 'PPPIN40K7QX',
      discountPercent: 40,
      provider: 'stripe',
      providerPromoCodeId: 'promo_1QxYzALkdIwHu7ixAbCdEfGh',
    });
  });

  it('maps fixed amounts, limits, expiry (unix seconds) and product scope', async () => {
    reply(
      { body: couponObj({ id: 'FLAT500', percent_off: null, amount_off: 500, currency: 'eur' }) },
      { body: promoObj({ id: 'promo_flat', code: 'FLAT500' }) },
    );

    await provider.createDiscount({
      name: 'Flat',
      code: 'FLAT500',
      discountType: 'fixed',
      amount: 500, // cents
      currency: 'eur',
      maxRedemptions: 25,
      expiresAt: '2027-01-01T00:00:00.000Z',
      productIds: ['prod_A', 'prod_B'],
    });

    const expiry = String(Date.UTC(2027, 0, 1) / 1000);
    expect(calls[0]!.form).toMatchObject({
      amount_off: '500',
      currency: 'eur',
      max_redemptions: '25',
      redeem_by: expiry,
      'applies_to[products][0]': 'prod_A',
      'applies_to[products][1]': 'prod_B',
    });
    expect(calls[0]!.form).not.toHaveProperty('percent_off');
    expect(calls[1]!.form).toMatchObject({ max_redemptions: '25', expires_at: expiry });
  });

  it('deletes the coupon again when the promotion code cannot be created', async () => {
    reply(
      { body: couponObj() },
      stripeError(400, {
        type: 'invalid_request_error',
        code: 'parameter_invalid_string',
        param: 'code',
        message: 'Invalid code',
      }),
      { body: { id: 'PPPIN40K7QX', object: 'coupon', deleted: true } },
    );

    const err = await provider
      .createDiscount({ name: 'x', code: 'PPPIN40K7QX', discountType: 'percentage', amount: 40 })
      .catch((e) => e);

    expect(err).toBeInstanceOf(ProviderError);
    expect(err.statusCode).toBe(400);
    expect(err.providerErrorCode).toBe('parameter_invalid_string');
    expect(calls.map((c) => `${c.method} ${c.url.pathname}`)).toEqual([
      'POST /v1/coupons',
      'POST /v1/promotion_codes',
      'DELETE /v1/coupons/PPPIN40K7QX',
    ]);
  });

  it('rejects a code with no alphanumeric characters without calling Stripe', async () => {
    await expect(
      provider.createDiscount({ name: 'x', code: '---', discountType: 'percentage', amount: 10 }),
    ).rejects.toBeInstanceOf(ProviderError);
    expect(calls).toHaveLength(0);
  });

  it('normalizeStripeCode strips everything outside [A-Za-z0-9]', () => {
    expect(normalizeStripeCode('PPP-IN40-K7QX')).toBe('PPPIN40K7QX');
    expect(normalizeStripeCode('a_b c.d')).toBe('abcd');
  });
});

// ── deleteDiscount / listDiscounts / listProducts ───────────────────────────

describe('deleteDiscount', () => {
  it('DELETEs the coupon', async () => {
    reply({ body: { id: 'PPPIN40K7QX', object: 'coupon', deleted: true } });
    await provider.deleteDiscount('PPPIN40K7QX');
    expectStripeRequest(calls[0]!, 'DELETE', '/v1/coupons/PPPIN40K7QX');
  });

  it('maps resource_missing to ProviderNotFoundError (statusCode 404, which coupon.service treats as already gone)', async () => {
    reply(stripeError(404, { type: 'invalid_request_error', code: 'resource_missing', message: 'No such coupon' }));
    const err = await provider.deleteDiscount('GONE').catch((e) => e);
    expect(err).toBeInstanceOf(ProviderNotFoundError);
    expect(err.statusCode).toBe(404);
  });
});

describe('listDiscounts', () => {
  it('pages through coupons (limit=100, starting_after) and keeps only GoPayLocal ones', async () => {
    reply(
      {
        body: {
          object: 'list', has_more: true, url: '/v1/coupons',
          data: [couponObj(), couponObj({ id: 'MERCHANT10', metadata: {} })],
        },
      },
      {
        body: {
          object: 'list', has_more: false, url: '/v1/coupons',
          data: [couponObj({ id: 'PPPBR55ZZZZ', percent_off: 55 })],
        },
      },
    );

    const list = await provider.listDiscounts();

    expectStripeRequest(calls[0]!, 'GET', '/v1/coupons');
    expect(calls[0]!.url.searchParams.get('limit')).toBe('100');
    expect(calls[1]!.url.searchParams.get('starting_after')).toBe('MERCHANT10');
    expect(list).toEqual([
      { providerDiscountId: 'PPPIN40K7QX', code: 'PPPIN40K7QX', discountPercent: 40, provider: 'stripe' },
      { providerDiscountId: 'PPPBR55ZZZZ', code: 'PPPBR55ZZZZ', discountPercent: 55, provider: 'stripe' },
    ]);
  });

  it('leaves out coupons that can no longer be redeemed (valid: false)', async () => {
    // listDiscounts returns only redeemable discounts (types.ts contract).
    // Coupon `valid`: "Taking account of the above properties, whether this
    // coupon can still be applied to a customer", i.e. false once redeem_by
    // has passed or max_redemptions is used up. GET /v1/coupons has no filter
    // for it (params: created, ending_before, expand, limit, starting_after;
    // spec 2026-11-18.endive). Deleted coupons are not listed at all.
    reply({
      body: {
        object: 'list', has_more: false, url: '/v1/coupons',
        data: [
          couponObj({ id: 'PPPMX30EXPD', percent_off: 30, valid: false, redeem_by: 1767225600 }),
          couponObj({ id: 'PPPAR50USED', percent_off: 50, valid: false, max_redemptions: 1, times_redeemed: 1 }),
          couponObj(),
        ],
      },
    });

    const list = await provider.listDiscounts();

    expect(list).toEqual([
      { providerDiscountId: 'PPPIN40K7QX', code: 'PPPIN40K7QX', discountPercent: 40, provider: 'stripe' },
    ]);
  });
});

describe('listProducts', () => {
  it('lists active products with the default price expanded and converts minor units', async () => {
    const price = (currency: string, unit_amount: number | null) => ({
      id: `price_${currency}`, object: 'price', currency, unit_amount, recurring: null,
    });
    reply({
      body: {
        object: 'list', has_more: false, url: '/v1/products',
        data: [
          { id: 'prod_usd', object: 'product', name: 'USD', default_price: price('usd', 1999) },
          { id: 'prod_jpy', object: 'product', name: 'JPY', default_price: price('jpy', 1500) },
          // Stripe "special case": UGX amounts are two-decimal (5 UGX = 500).
          { id: 'prod_ugx', object: 'product', name: 'UGX', default_price: price('ugx', 3700000) },
          { id: 'prod_unexpanded', object: 'product', name: 'No expand', default_price: 'price_x' },
          { id: 'prod_none', object: 'product', name: 'None', default_price: null },
        ],
      },
    });

    const products = await provider.listProducts();

    expectStripeRequest(calls[0]!, 'GET', '/v1/products');
    expect(calls[0]!.url.searchParams.get('active')).toBe('true');
    expect(calls[0]!.url.searchParams.get('limit')).toBe('100');
    expect(calls[0]!.url.searchParams.get('expand[0]')).toBe('data.default_price');
    expect(products.map((p) => [p.providerProductId, p.price, p.currency, p.url])).toEqual([
      ['prod_usd', 19.99, 'usd', null],
      ['prod_jpy', 1500, 'jpy', null],
      ['prod_ugx', 37000, 'ugx', null],
      ['prod_unexpanded', null, null, null],
      ['prod_none', null, null, null],
    ]);
  });
});

// ── buildCheckoutUrl ────────────────────────────────────────────────────────

describe('buildCheckoutUrl', () => {
  const session = { id: 'cs_test_1', object: 'checkout.session', url: 'https://checkout.stripe.com/c/pay/cs_test_1' };

  it('creates a subscription-mode session for a recurring price with the coupon applied', async () => {
    reply(
      { body: { id: 'price_m', object: 'price', recurring: { interval: 'month' } } },
      { body: session },
    );

    const url = await provider.buildCheckoutUrl({
      productId: 'price_m',
      discountId: 'PPPIN40K7QX',
      successUrl: 'https://merchant.example/ok',
      cancelUrl: 'https://merchant.example/cancel',
      customerEmail: 'buyer@example.com',
      metadata: { campaign: 'c1' },
    });

    expect(url).toBe(session.url);
    expectStripeRequest(calls[0]!, 'GET', '/v1/prices/price_m');
    expectStripeRequest(calls[1]!, 'POST', '/v1/checkout/sessions');
    expect(calls[1]!.form).toEqual({
      'line_items[0][price]': 'price_m',
      'line_items[0][quantity]': '1',
      mode: 'subscription',
      success_url: 'https://merchant.example/ok',
      cancel_url: 'https://merchant.example/cancel',
      'discounts[0][coupon]': 'PPPIN40K7QX',
      customer_email: 'buyer@example.com',
      'metadata[campaign]': 'c1',
    });
  });

  it('resolves a (normalized) promotion code to its id when only a code is given', async () => {
    reply(
      { body: { id: 'price_once', object: 'price', recurring: null } },
      { body: { object: 'list', has_more: false, url: '/v1/promotion_codes', data: [promoObj()] } },
      { body: session },
    );

    await provider.buildCheckoutUrl({ productId: 'price_once', discountCode: 'PPP-IN40-K7QX', successUrl: 'https://m/ok' });

    expectStripeRequest(calls[1]!, 'GET', '/v1/promotion_codes');
    expect(Object.fromEntries(calls[1]!.url.searchParams)).toEqual({ code: 'PPPIN40K7QX', active: 'true', limit: '1' });
    expect(calls[2]!.form).toMatchObject({ mode: 'payment', 'discounts[0][promotion_code]': promoObj().id });
  });

  it('accepts a product id (what listProducts returns) by using its default price', async () => {
    reply(
      { body: { id: 'prod_A', object: 'product', default_price: { id: 'price_A', object: 'price', recurring: null } } },
      { body: session },
    );

    await provider.buildCheckoutUrl({ productId: 'prod_A', successUrl: 'https://m/ok' });

    expectStripeRequest(calls[0]!, 'GET', '/v1/products/prod_A');
    expect(calls[0]!.url.searchParams.get('expand[0]')).toBe('default_price');
    expect(calls[1]!.form['line_items[0][price]']).toBe('price_A');
  });

  it('throws ProviderError when Stripe returns no session url', async () => {
    reply({ body: { id: 'price_once', object: 'price', recurring: null } }, { body: { ...session, url: null } });
    await expect(provider.buildCheckoutUrl({ productId: 'price_once', successUrl: 'https://m/ok' })).rejects.toThrow(
      'No checkout URL returned',
    );
  });
});

// ── webhook endpoint lifecycle ──────────────────────────────────────────────

describe('provisionWebhook / deleteWebhook', () => {
  it('creates a pinned-version endpoint for the two checkout events and returns its secret', async () => {
    reply({ body: { id: 'we_123', object: 'webhook_endpoint', secret: 'fake-endpoint-secret', api_version: '2026-10-28.endive' } });

    const res = await provider.provisionWebhook('https://api.gopaylocal.com/v1/webhooks/stripe/int_1');

    expectStripeRequest(calls[0]!, 'POST', '/v1/webhook_endpoints');
    expect(calls[0]!.form).toEqual({
      url: 'https://api.gopaylocal.com/v1/webhooks/stripe/int_1',
      api_version: '2026-10-28.endive',
      'enabled_events[0]': 'checkout.session.completed',
      'enabled_events[1]': 'checkout.session.async_payment_succeeded',
      description: 'GoPayLocal PPP redemption tracking',
      'metadata[gopaylocal]': 'true',
    });
    expect(res).toEqual({ endpointId: 'we_123', secret: 'fake-endpoint-secret' });
  });

  it('DELETEs the endpoint and treats resource_missing as already deleted', async () => {
    reply({ body: { id: 'we_123', object: 'webhook_endpoint', deleted: true } });
    await provider.deleteWebhook('we_123');
    expectStripeRequest(calls[0]!, 'DELETE', '/v1/webhook_endpoints/we_123');

    reply(stripeError(404, { type: 'invalid_request_error', code: 'resource_missing', message: 'No such webhook endpoint' }));
    await expect(provider.deleteWebhook('we_gone')).resolves.toBeUndefined();
  });

  it('surfaces other delete failures as provider errors', async () => {
    reply(stripeError(401, { type: 'invalid_request_error', message: 'Invalid API Key provided' }));
    await expect(provider.deleteWebhook('we_123')).rejects.toBeInstanceOf(ProviderAuthError);
  });
});

// ── verifyWebhook ───────────────────────────────────────────────────────────

describe('verifyWebhook', () => {
  const secret = 'fake-webhook-signing-secret';
  const body = readFileSync(new URL('./__fixtures__/stripe/checkout-session-completed-coupon.json', import.meta.url), 'utf8');

  // Independent signer, per https://docs.stripe.com/webhooks#verify-manually:
  // HMAC-SHA256(secret, `${t}.${rawBody}`), hex.
  const sign = (payload: string, t: number, key = secret) =>
    createHmac('sha256', key).update(`${t}.${payload}`, 'utf8').digest('hex');
  const now = () => Math.floor(Date.now() / 1000);
  const verify = (header: string | null, payload = body, s: string | null = secret, p = provider) =>
    p.verifyWebhook({
      rawBody: payload,
      headers: new Headers(header === null ? {} : { 'Stripe-Signature': header }),
      secret: s,
    });

  it('accepts a correctly signed payload', async () => {
    const t = now();
    expect(await verify(`t=${t},v1=${sign(body, t)}`)).toBe(true);
  });

  it('accepts the documented header with debug entries, a v0 decoy and a rotated second v1', async () => {
    const t = now();
    const header = [
      `t=${t}`,
      `v1=${sign(body, t, 'fake-secret-being-rolled')}`,
      `v1=${sign(body, t)}`,
      `v0=${sign(body, t, 'unrelated')}`,
      'secret=whsec_****************************PzVt',
      'destination=we_1TN7mG6oEAX7HoXLZoZugElv',
      'payload=a25aefc6',
    ].join(',');
    expect(await verify(header)).toBe(true);
  });

  it('verifies with a provider built from an empty API key', async () => {
    const t = now();
    expect(await verify(`t=${t},v1=${sign(body, t)}`, body, secret, new StripeProvider({ apiKey: '' }))).toBe(true);
  });

  it('rejects a tampered body', async () => {
    const t = now();
    expect(await verify(`t=${t},v1=${sign(body, t)}`, body.replace('"amount_total": 1200', '"amount_total": 1'))).toBe(false);
  });

  it('rejects a signature made with the wrong secret', async () => {
    const t = now();
    expect(await verify(`t=${t},v1=${sign(body, t, 'fake-wrong-secret')}`)).toBe(false);
  });

  it('rejects missing, malformed and v0-only headers, and a missing secret', async () => {
    const t = now();
    expect(await verify(null)).toBe(false);
    expect(await verify('')).toBe(false);
    expect(await verify('garbage')).toBe(false);
    expect(await verify(`v1=${sign(body, t)}`)).toBe(false); // no timestamp
    expect(await verify(`t=${t},v0=${sign(body, t)}`)).toBe(false); // downgrade
    expect(await verify(`t=${t},v1=${sign(body, t)}`, body, null)).toBe(false);
  });

  it('rejects a timestamp older than the 300s tolerance', async () => {
    const t = now() - 301;
    expect(await verify(`t=${t},v1=${sign(body, t)}`)).toBe(false);
    const ok = now() - 290;
    expect(await verify(`t=${ok},v1=${sign(body, ok)}`)).toBe(true);
  });
});

// ── parseRedemption ─────────────────────────────────────────────────────────

describe('parseRedemption', () => {
  // Fixtures: the documented Checkout Session example at api-version
  // 2025-02-24.acacia (https://docs.stripe.com/api/checkout/sessions/object?api-version=2025-02-24.acacia)
  // moved to its completed state, with `discounts` per
  // https://docs.stripe.com/changelog/acacia/2025-01-27/checkout-sessions-discounts-field
  // (unexpanded in webhooks, so coupon/promotion_code are id strings), wrapped in
  // the documented Event envelope. Endpoints are now pinned to
  // 2026-10-28.endive; the session fields parseRedemption reads have the same
  // names, types and meaning there (spec v2596), so these acacia-rendered
  // payloads still stand for both versions. setup-intent-created.json is the documented
  // Event example verbatim; invoice-paid-renewal.json is the documented Invoice
  // example as a paid `subscription_cycle` invoice.
  const fixture = (name: string) =>
    readFileSync(new URL(`./__fixtures__/stripe/${name}`, import.meta.url), 'utf8');

  it('parses a paid checkout session that used our promotion code', () => {
    expect(provider.parseRedemption(fixture('checkout-session-completed-coupon.json'))).toEqual({
      eventId: 'cs_test_a11YYufWQzNY63zpQ6QSNRQhkUpVph4WRmzW0zWJO2znZKdVujZ0N0S22u',
      code: 'PPPIN40K7QX',
      providerCouponId: 'PPPIN40K7QX',
      providerPromoCodeId: 'promo_1QxYzALkdIwHu7ixAbCdEfGh',
      chargedAmountCents: 1200,
      // total_details.amount_tax is 0: the order carries no tax (contract C3).
      taxAmountCents: 0,
      discountAmountCents: 800,
      currency: 'usd',
    });
  });

  it('ignores a purchase with no discount', () => {
    expect(provider.parseRedemption(fixture('checkout-session-completed-no-coupon.json'))).toBeNull();
  });

  it('ignores unrelated events', () => {
    expect(provider.parseRedemption(fixture('setup-intent-created.json'))).toBeNull();
  });

  it('does not count subscription renewals (invoice events never reach the checkout path)', () => {
    expect(provider.parseRedemption(fixture('invoice-paid-renewal.json'))).toBeNull();
  });

  it('counts a delayed payment once: unpaid completion ignored, settlement keyed on the same session', () => {
    expect(provider.parseRedemption(fixture('checkout-session-completed-async-unpaid.json'))).toBeNull();
    const settled = provider.parseRedemption(fixture('checkout-session-async-payment-succeeded.json'));
    expect(settled?.eventId).toBe('cs_test_asyncAch00000000000000000000000000000000000000000000');
  });

  it('keeps zero-decimal amounts as whole units', () => {
    const r = provider.parseRedemption(fixture('checkout-session-completed-jpy.json'));
    expect(r).toMatchObject({ chargedAmountCents: 1800, discountAmountCents: 1200, currency: 'jpy' });
  });

  it('converts UGX from Stripe two-decimal representation to whole shillings', () => {
    // redemption.service treats UGX as zero-decimal; Stripe sends 500 for 5 UGX.
    const evt = JSON.parse(fixture('checkout-session-completed-coupon.json'));
    Object.assign(evt.data.object, {
      currency: 'ugx',
      amount_total: 3700000,
      total_details: { amount_discount: 2500000, amount_shipping: 0, amount_tax: 0 },
    });
    expect(provider.parseRedemption(JSON.stringify(evt))).toMatchObject({
      chargedAmountCents: 37000,
      discountAmountCents: 25000,
      currency: 'ugx',
    });
  });

  it('returns null for invalid JSON', () => {
    expect(provider.parseRedemption('{not json')).toBeNull();
  });
});

// ── tax (contract C3) and Managed Payments sessions ─────────────────────────

describe('parseRedemption: tax and Managed Payments', () => {
  const fixture = (name: string) =>
    readFileSync(new URL(`./__fixtures__/stripe/${name}`, import.meta.url), 'utf8');
  const withSession = (name: string, patch: Record<string, unknown>) => {
    const evt = JSON.parse(fixture(name));
    Object.assign(evt.data.object, patch);
    return JSON.stringify(evt);
  };

  // checkout-session-completed-managed-payments.json is the coupon fixture
  // re-rendered at 2026-10-28.endive as a one-off Managed Payments purchase.
  // Changed fields and their sources:
  //  - managed_payments {enabled: true}: Checkout Session object, schema
  //    PaymentPagesCheckoutSessionManagedPayments (spec v2596).
  //  - presentment_details {presentment_amount, presentment_currency}: shape of
  //    the documented checkout.session.completed example under Adaptive
  //    Pricing, which Managed Payments always enables
  //    (https://docs.stripe.com/payments/currencies/localize-prices/adaptive-pricing?payment-ui=stripe-hosted).
  //    The EUR figure is illustrative.
  //  - amount_tax 240 on a 1200 discounted subtotal (20% VAT, exclusive price,
  //    the Managed Payments default per
  //    https://docs.stripe.com/payments/managed-payments/set-up), so
  //    amount_total = 2000 - 800 + 240 = 1440.
  // Fields parseRedemption does not read (automatic_tax, payment_method_types)
  // are left as in the base fixture; what a real managed session puts there is
  // one of the things `verify:provider stripe --managed-payments` prints.
  it('parses a Managed Payments session: integration-currency amounts, tax reported, discount pre-tax', () => {
    expect(provider.parseRedemption(fixture('checkout-session-completed-managed-payments.json'))).toEqual({
      eventId: 'cs_test_b1MaNaGeDpAyMeNtS0000000000000000000000000000000000000000',
      code: 'PPPFR40M3PX',
      providerCouponId: 'PPPFR40M3PX',
      providerPromoCodeId: 'promo_1SmPmALkdIwHu7ixManaged01',
      chargedAmountCents: 1440,
      taxAmountCents: 240,
      discountAmountCents: 800,
      currency: 'usd',
    });
  });

  it('ignores presentment_details: what the customer saw in their currency is not the integration amount', () => {
    const body = withSession('checkout-session-completed-managed-payments.json', {
      presentment_details: { presentment_amount: 999999, presentment_currency: 'jpy' },
    });
    expect(provider.parseRedemption(body)).toMatchObject({ chargedAmountCents: 1440, currency: 'usd' });
  });

  it('reports a tax-inclusive discount as unknown (null) instead of counting tax as savings', () => {
    // Inclusive price: 2000 contains tax, the 40% discount takes 800 off that,
    // and the 1200 paid contains 200 VAT (20%). total = subtotal - discount,
    // so the tax was not added on top and the 800 includes tax.
    const body = withSession('checkout-session-completed-managed-payments.json', {
      amount_subtotal: 2000,
      amount_total: 1200,
      total_details: { amount_discount: 800, amount_shipping: 0, amount_tax: 200 },
    });
    expect(provider.parseRedemption(body)).toMatchObject({
      chargedAmountCents: 1200,
      taxAmountCents: 200,
      discountAmountCents: null,
    });
  });

  it('counts shipping when checking that tax was added on top', () => {
    const body = withSession('checkout-session-completed-coupon.json', {
      amount_subtotal: 2000,
      amount_total: 1740, // 2000 - 800 + 300 shipping + 240 tax
      total_details: { amount_discount: 800, amount_shipping: 300, amount_tax: 240 },
    });
    expect(provider.parseRedemption(body)).toMatchObject({ taxAmountCents: 240, discountAmountCents: 800 });
  });

  it('reports tax and discount as unknown when total_details is missing', () => {
    const body = withSession('checkout-session-completed-coupon.json', { total_details: null });
    expect(provider.parseRedemption(body)).toMatchObject({
      chargedAmountCents: 1200,
      taxAmountCents: null,
      discountAmountCents: null,
    });
  });

  it('converts UGX tax from the two-decimal representation too', () => {
    const body = withSession('checkout-session-completed-coupon.json', {
      currency: 'ugx',
      amount_subtotal: 5000000,
      amount_total: 3540000, // 50000 - 20000 + 5400 tax (18%), in Stripe's two-decimal UGX
      total_details: { amount_discount: 2000000, amount_shipping: 0, amount_tax: 540000 },
    });
    expect(provider.parseRedemption(body)).toMatchObject({
      chargedAmountCents: 35400,
      taxAmountCents: 5400,
      discountAmountCents: 20000,
      currency: 'ugx',
    });
  });
});

// ── createCheckoutSession: Managed Payments opt-in ──────────────────────────

describe('createCheckoutSession (Managed Payments)', () => {
  // Parameters a Managed Payments session must not carry, verbatim from
  // https://docs.stripe.com/payments/managed-payments/update-checkout#remove-unsupported-parameters
  // (fetched 2026-11-18). Checked as form-key prefixes: `automatic_tax` also
  // covers `automatic_tax[enabled]`.
  const REJECTED_SUBSCRIPTION = [
    'adaptive_pricing', 'automatic_tax', 'tax_id_collection', 'subscription_data[default_tax_rates]',
    'payment_method_configuration', 'payment_method_types', 'customer_update[name]', 'customer_update[address]',
    'shipping_address_collection', 'shipping_options', 'subscription_data[application_fee_percent]',
    'subscription_data[on_behalf_of]', 'subscription_data[transfer_data]', 'subscription_data[invoice_settings]',
    'invoice_creation',
  ];
  const REJECTED_ONE_OFF = [
    'automatic_tax', 'tax_id_collection', 'excluded_payment_method_types', 'adaptive_pricing',
    'payment_method_configuration', 'payment_method_types', 'customer_update[name]', 'customer_update[address]',
    'shipping_address_collection', 'shipping_options', 'payment_intent_data[shipping]',
    'payment_intent_data[application_fee_amount]', 'payment_intent_data[on_behalf_of]',
    'payment_intent_data[transfer_data]', 'payment_intent_data[transfer_group]', 'invoice_creation',
    'payment_intent_data[statement_descriptor]', 'payment_intent_data[statement_descriptor_suffix]',
    'payment_intent_data[receipt_email]',
  ];
  const rejectedKeys = (form: Record<string, string>, list: string[]) =>
    Object.keys(form).filter((k) => list.some((p) => k === p || k.startsWith(`${p}[`)));
  const managed = (extra: Record<string, unknown> = {}) => ({
    id: 'cs_test_mp',
    object: 'checkout.session',
    url: 'https://checkout.stripe.com/c/pay/cs_test_mp',
    managed_payments: { enabled: true },
    ...extra,
  });

  it('opts a one-off session in with managed_payments[enabled]=true and a promotion code, nothing else added', async () => {
    reply(
      { body: { id: 'price_once', object: 'price', recurring: null } },
      { body: { object: 'list', has_more: false, url: '/v1/promotion_codes', data: [promoObj()] } },
      { body: managed({ discounts: [{ coupon: 'PPPIN40K7QX', promotion_code: promoObj().id }] }) },
    );

    const session = await provider.createCheckoutSession({
      productId: 'price_once',
      discountCode: 'PPPIN40K7QX',
      successUrl: 'https://m/ok',
      customerEmail: 'buyer+location_FR@example.com',
      managedPayments: true,
    });

    expectStripeRequest(calls[2]!, 'POST', '/v1/checkout/sessions');
    expect(calls[2]!.form).toEqual({
      'line_items[0][price]': 'price_once',
      'line_items[0][quantity]': '1',
      mode: 'payment',
      success_url: 'https://m/ok',
      'discounts[0][promotion_code]': promoObj().id,
      customer_email: 'buyer+location_FR@example.com',
      'managed_payments[enabled]': 'true',
    });
    expect(rejectedKeys(calls[2]!.form, REJECTED_ONE_OFF)).toEqual([]);
    // The whole session comes back, so a caller can read what Stripe applied.
    expect(session.managed_payments).toEqual({ enabled: true });
    expect(session.discounts).toEqual([{ coupon: 'PPPIN40K7QX', promotion_code: promoObj().id }]);
  });

  it('opts a subscription session in with a coupon and sends nothing Managed Payments rejects', async () => {
    reply({ body: { id: 'price_m', object: 'price', recurring: { interval: 'month' } } }, { body: managed() });

    await provider.createCheckoutSession({
      productId: 'price_m',
      discountId: 'PPPIN40K7QX',
      successUrl: 'https://m/ok',
      cancelUrl: 'https://m/cancel',
      metadata: { campaign: 'c1' },
      managedPayments: true,
    });

    expect(calls[1]!.form).toMatchObject({ mode: 'subscription', 'discounts[0][coupon]': 'PPPIN40K7QX', 'managed_payments[enabled]': 'true' });
    expect(rejectedKeys(calls[1]!.form, REJECTED_SUBSCRIPTION)).toEqual([]);
  });

  it('can show the promotion-code field instead of pre-applying a discount', async () => {
    reply({ body: { id: 'price_once', object: 'price', recurring: null } }, { body: managed({ allow_promotion_codes: true }) });

    await provider.createCheckoutSession({ productId: 'price_once', successUrl: 'https://m/ok', allowPromotionCodes: true, managedPayments: true });

    expect(calls[1]!.form).toEqual({
      'line_items[0][price]': 'price_once',
      'line_items[0][quantity]': '1',
      mode: 'payment',
      success_url: 'https://m/ok',
      allow_promotion_codes: 'true',
      'managed_payments[enabled]': 'true',
    });
  });

  it('refuses allowPromotionCodes together with a pre-applied discount, before calling Stripe', async () => {
    await expect(
      provider.createCheckoutSession({ productId: 'price_once', successUrl: 'https://m/ok', allowPromotionCodes: true, discountCode: 'X1' }),
    ).rejects.toBeInstanceOf(ProviderError);
    expect(calls).toHaveLength(0);
  });

  it('buildCheckoutUrl never opts in on its own', async () => {
    reply({ body: { id: 'price_once', object: 'price', recurring: null } }, { body: managed() });
    await provider.buildCheckoutUrl({ productId: 'price_once', successUrl: 'https://m/ok' });
    expect(Object.keys(calls[1]!.form).some((k) => k.startsWith('managed_payments'))).toBe(false);
  });

  it('surfaces a Stripe rejection of a managed session as a ProviderError with Stripe\'s message', async () => {
    // Shape per https://docs.stripe.com/api/errors; the message text is a
    // placeholder: the real wording for an ineligible product or an account
    // without Managed Payments is not documented.
    reply(
      { body: { id: 'price_once', object: 'price', recurring: null } },
      stripeError(400, { type: 'invalid_request_error', code: 'parameter_invalid', param: 'managed_payments', message: 'example rejection' }),
    );
    const err = await provider
      .createCheckoutSession({ productId: 'price_once', successUrl: 'https://m/ok', managedPayments: true })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err).toMatchObject({ message: expect.stringContaining('example rejection'), statusCode: 400 });
  });
});

// ── error mapping ───────────────────────────────────────────────────────────

describe('error mapping (https://docs.stripe.com/api/errors)', () => {
  it('401 -> ProviderAuthError', async () => {
    reply(stripeError(401, { type: 'invalid_request_error', message: 'Invalid API Key provided: fake-***-key' }));
    await expect(provider.listDiscounts()).rejects.toBeInstanceOf(ProviderAuthError);
  });

  it('403 (restricted key without permission) -> ProviderAuthError', async () => {
    reply(stripeError(403, { type: 'invalid_request_error', message: 'The provided key does not have the required permissions' }));
    const err = await provider.listDiscounts().catch((e) => e);
    expect(err).toBeInstanceOf(ProviderAuthError);
    expect(err.statusCode).toBe(401);
  });

  it('404 -> ProviderNotFoundError', async () => {
    reply(stripeError(404, { type: 'invalid_request_error', code: 'resource_missing', message: 'No such price' }));
    await expect(provider.buildCheckoutUrl({ productId: 'price_x', successUrl: 'https://m/ok' })).rejects.toBeInstanceOf(
      ProviderNotFoundError,
    );
  });

  it('other API errors -> ProviderError carrying status, Stripe code and operation', async () => {
    reply(stripeError(400, { type: 'invalid_request_error', code: 'resource_already_exists', message: 'Coupon already exists.' }));
    const err = await provider
      .createDiscount({ name: 'x', code: 'PPPIN40K7QX', discountType: 'percentage', amount: 40 })
      .catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err).not.toBeInstanceOf(ProviderAuthError);
    expect(err.statusCode).toBe(400);
    expect(err.providerErrorCode).toBe('resource_already_exists');
    expect(err.operation).toBe('createDiscount');
    expect(err.message).toContain('Coupon already exists.');
  });

  it('calls made with an empty key fail as ProviderError, not as a constructor crash', async () => {
    const p = new StripeProvider({ apiKey: '' });
    await expect(p.listDiscounts()).rejects.toBeInstanceOf(ProviderError);
    expect(calls).toHaveLength(0);
  });
});
