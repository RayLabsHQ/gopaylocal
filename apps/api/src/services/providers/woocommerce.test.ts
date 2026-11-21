// WooCommerce provider: where requests may go, request shapes, webhook
// signatures and redemption parsing.
//
// Expectations come from WooCommerce's docs and source, not from the code under
// test:
//   [INTRO]    https://developer.woocommerce.com/docs/apis/rest-api/ (requirements, errors, pagination)
//   [AUTH]     https://developer.woocommerce.com/docs/apis/rest-api/authentication (Basic over HTTPS)
//   [COUPONS]  https://developer.woocommerce.com/docs/apis/rest-api/v3/coupons
//   [PRODUCTS] https://developer.woocommerce.com/docs/apis/rest-api/v3/products
//   [DATA]     https://developer.woocommerce.com/docs/apis/rest-api/v3/data (current currency)
//   [WEBHOOKS] https://developer.woocommerce.com/docs/apis/rest-api/v3/webhooks
//   [ORDERS]   https://developer.woocommerce.com/docs/apis/rest-api/v3/orders
//   [LINK]     https://woocommerce.com/document/creating-sharable-checkout-urls-in-woocommerce/
//   [SRC]      github.com/woocommerce/woocommerce/blob/11.3.0/plugins/woocommerce/
//              includes/class-wc-webhook.php (generate_signature, deliver_ping),
//              Version3/class-wc-rest-crud-controller.php (per_page max 100),
//              includes/class-wc-discounts.php (expiry, usage limit)
//   [CF]       https://developers.cloudflare.com/workers/runtime-apis/request/ (redirect modes)
// The store-URL rules themselves are tested shape by shape in
// packages/shared/src/validation/woocommerce.test.ts; here the adapter is shown
// to apply them.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Buffer } from 'node:buffer';
import { createHmac } from 'node:crypto';

import { WooCommerceProvider, decimalToMinor, MAX_PAGES, MAX_RESPONSE_BYTES } from './woocommerce';
import { ProviderError, ProviderAuthError, ProviderNotFoundError } from './types';
import { computeSavingsMinor } from '../redemption.service';

const fixtureText = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`./__fixtures__/woocommerce/${name}`, import.meta.url)), 'utf8');
const fixture = (name: string) => JSON.parse(fixtureText(name));

const CK = `ck_${'a1'.repeat(20)}`; // ck_ + 40 hex, as WooCommerce generates
const CS = `cs_${'b2'.repeat(20)}`;
const TOKEN = `${CK}:${CS}`;
const STORE = 'https://shop.example.com';
// [AUTH] consumer key as user name, consumer secret as password (RFC 7617).
const EXPECTED_AUTH = 'Basic ' + Buffer.from(`${CK}:${CS}`, 'utf8').toString('base64');

type Call = { url: string; method: string; headers: Record<string, string>; body: string | undefined; init: RequestInit };
let calls: Call[];
let responder: (call: Call) => Response | Promise<Response>;

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=UTF-8', ...headers },
  });
}

beforeEach(() => {
  calls = [];
  responder = () => json(200, {});
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const call: Call = {
        url: String(input),
        method: init?.method ?? 'GET',
        headers: { ...((init?.headers as Record<string, string>) ?? {}) },
        body: typeof init?.body === 'string' ? init.body : undefined,
        init: init ?? {},
      };
      calls.push(call);
      return responder(call);
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const provider = (siteId: string = STORE, apiKey: string = TOKEN) => new WooCommerceProvider({ apiKey, siteId });

// ── Where requests may go ───────────────────────────────────────────────────

describe('store URL', () => {
  it('normalizes what merchants paste and builds the v3 base on it', async () => {
    responder = () => json(200, []);
    for (const [raw, base] of [
      ['shop.example.com', 'https://shop.example.com/wp-json/wc/v3'],
      ['https://Shop.Example.com/', 'https://shop.example.com/wp-json/wc/v3'],
      ['https://shop.example.com/wp-json/wc/v3/', 'https://shop.example.com/wp-json/wc/v3'],
      ['https://example.com/store', 'https://example.com/store/wp-json/wc/v3'], // subdirectory install
    ] as const) {
      calls = [];
      const p = provider(raw);
      await p.listDiscounts();
      expect(calls[0]!.url.startsWith(`${base}/coupons?`), raw).toBe(true);
    }
  });

  it('refuses to construct for every rejected URL shape (no request is made)', () => {
    for (const raw of [
      '',
      'http://shop.example.com', // Basic auth only over HTTPS [AUTH]
      'ftp://shop.example.com',
      'https://127.0.0.1',
      'https://2130706433',
      'https://[::1]',
      'https://169.254.169.254',
      'https://127.0.0.1.nip.io',
      'https://localhost',
      'https://shop.local',
      'https://metadata.google.internal',
      'https://intranet',
      'https://api.gopaylocal.com', // own zone: same-zone fetch reaches the origin
      'https://user:pass@shop.example.com',
      'shop.example.com@evil.example.org',
      'https://shop.example.com:8443',
      'https://shop.example.com/?x=1',
      'https://shop.example.com/#x',
      'https://shop.example.com/%2e%2e/admin',
      'https://shop.example.com/a/../b',
      'https://shop.example.com\\@evil.example.org',
    ]) {
      expect(() => provider(raw), raw).toThrow(ProviderError);
    }
    expect(() => new WooCommerceProvider({ apiKey: TOKEN })).toThrow(/Store URL is required/);
    expect(calls).toHaveLength(0);
  });

  it('sends the key only to the store origin, over HTTPS, in the Authorization header', async () => {
    responder = (c) =>
      c.url.includes('/data/currencies/current') ? json(200, fixture('currency-current.json')) : json(200, []);
    const p = provider();
    await p.listDiscounts();
    await p.listProducts();
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) {
      const u = new URL(c.url);
      expect(u.origin).toBe(STORE);
      expect(c.headers.Authorization).toBe(EXPECTED_AUTH);
      // [INTRO] offers ?consumer_key=&consumer_secret= as a fallback; never used.
      expect(c.url).not.toMatch(/consumer_key|consumer_secret|ck_|cs_/);
    }
  });

  it('builds without a usable key (webhooks still verify) but makes no API call with it', async () => {
    for (const bad of ['', 'ck_short:cs_short', CK, `${CS}:${CK}`, `${CK}:${CS}\r\nX: y`]) {
      const p = provider(STORE, bad);
      await expect(p.listDiscounts(), bad).rejects.toBeInstanceOf(ProviderAuthError);
    }
    expect(calls).toHaveLength(0);
  });
});

describe('response handling', () => {
  it('never follows a redirect: manual mode, one request, an error naming only a valid target origin', async () => {
    responder = () => new Response(null, { status: 301, headers: { location: 'https://www.shop.example.com/wp-json/wc/v3/coupons?per_page=100' } });
    const err = await provider().listDiscounts().catch((e) => e);
    expect(calls).toHaveLength(1);
    // [CF] "follow" would forward Authorization to any redirect host.
    expect(calls[0]!.init.redirect).toBe('manual');
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.statusCode).toBe(301);
    expect(err.message).toContain('(HTTP 301 to https://www.shop.example.com)');
    expect(err.message).not.toContain('per_page');
  });

  it('does not name a redirect target that is not an acceptable store address', async () => {
    for (const location of ['https://169.254.169.254/latest/meta-data', 'http://evil.example.org/x', 'javascript:alert(1)', '//10.0.0.1/']) {
      calls = [];
      responder = () => new Response(null, { status: 302, headers: { location } });
      const err = await provider().listDiscounts().catch((e) => e);
      expect(calls, location).toHaveLength(1);
      expect(err.message, location).not.toMatch(/169\.254|evil|javascript|10\.0\.0\.1/);
      expect(err.message).toMatch(/redirect \(HTTP 302\)/);
    }
  });

  it('sets a timeout signal on every request and reports a timeout without detail', async () => {
    responder = () => {
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    };
    const err = await provider().listDiscounts().catch((e) => e);
    expect(calls[0]!.init.signal).toBeInstanceOf(AbortSignal);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.message).toMatch(/did not respond within 15 seconds/);
  });

  it('reports a network failure without the runtime message', async () => {
    responder = () => {
      throw new TypeError('internal detail 10.1.2.3');
    };
    const err = await provider().listDiscounts().catch((e) => e);
    expect(err.message).toMatch(/Could not connect to shop\.example\.com/);
    expect(err.message).not.toContain('10.1.2.3');
  });

  it('refuses a body larger than the cap, by Content-Length or while streaming', async () => {
    responder = () =>
      new Response('[]', { status: 200, headers: { 'content-type': 'application/json', 'content-length': String(MAX_RESPONSE_BYTES + 1) } });
    await expect(provider().listDiscounts()).rejects.toThrow(/larger than 2 MB/);

    const chunk = new Uint8Array(256 * 1024).fill(0x20);
    let sent = 0;
    responder = () =>
      new Response(
        new ReadableStream({
          pull(controller) {
            if (sent > MAX_RESPONSE_BYTES + chunk.length) return controller.close();
            sent += chunk.length;
            controller.enqueue(chunk);
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    await expect(provider().listDiscounts()).rejects.toThrow(/larger than 2 MB/);
    expect(sent).toBeLessThanOrEqual(MAX_RESPONSE_BYTES + 2 * chunk.length);
  });

  it('never copies a response body into an error message', async () => {
    const secretish = '<h1>Fatal error</h1> DB_PASSWORD=hunter2 in /var/www/wp-config.php';
    for (const status of [400, 401, 403, 404, 500, 502]) {
      responder = () => json(status, { code: 'woocommerce_rest_something', message: secretish, data: { status } });
      const err = await provider().listDiscounts().catch((e) => e);
      expect(err, String(status)).toBeInstanceOf(ProviderError);
      expect(err.message).not.toContain('hunter2');
      expect(err.message).not.toContain('Fatal');
      expect(err.message).toContain(`HTTP ${status}, woocommerce_rest_something`);
    }
    // An error code that isn't a plain identifier is left out too.
    responder = () => json(500, { code: '<script>x</script>', message: 'm' });
    const err = await provider().listDiscounts().catch((e) => e);
    expect(err.message).not.toContain('script');
    expect(err.message).toContain('(HTTP 500)');
    // HTML where JSON was expected: the media type only, never the page.
    responder = () => new Response(`<html>${secretish}</html>`, { status: 200, headers: { 'content-type': 'text/html; charset=UTF-8' } });
    const html = await provider().listDiscounts().catch((e) => e);
    expect(html.message).toContain('text/html');
    expect(html.message).not.toContain('hunter2');
  });

  it('maps 401/403 to ProviderAuthError with the permission hint [INTRO, AUTH]', async () => {
    responder = () => json(401, { code: 'woocommerce_rest_authentication_error', message: 'x', data: { status: 401 } });
    const e401 = await provider().listDiscounts().catch((e) => e);
    expect(e401).toBeInstanceOf(ProviderAuthError);
    expect(e401.message).toMatch(/Read\/Write/);
    // [INTRO] "Consumer key is missing": servers that drop the header. We never
    // fall back to query-string credentials, so the message points at the server.
    expect(e401.message).toMatch(/dropping the Authorization header/);
    responder = () => json(403, { code: 'woocommerce_rest_cannot_view', message: 'x', data: { status: 403 } });
    const e403 = await provider().listDiscounts().catch((e) => e);
    expect(e403).toBeInstanceOf(ProviderAuthError);
    expect(e403.message).toMatch(/Administrator or Shop Manager/);
  });

  it('a 404 from a missing REST route is not "not found" (so callers never treat a coupon as deleted)', async () => {
    responder = () => json(404, { code: 'rest_no_route', message: 'No route was found', data: { status: 404 } });
    const err = await provider().deleteDiscount('719').catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err).not.toBeInstanceOf(ProviderNotFoundError);
    expect(err.statusCode).toBeUndefined();
    expect(err.message).toMatch(/pretty permalinks/);
  });
});

// ── Coupons ─────────────────────────────────────────────────────────────────

describe('createDiscount', () => {
  it('POSTs a percent, individual-use coupon tagged with our meta [COUPONS]', async () => {
    responder = () => json(201, fixture('coupon-create-response.json'));
    const d = await provider().createDiscount({ name: 'PPP IN 40%', code: 'PPP-IN40-K7QX', discountType: 'percentage', amount: 40 });

    expect(calls).toHaveLength(1);
    const c = calls[0]!;
    expect(c.method).toBe('POST');
    expect(c.url).toBe(`${STORE}/wp-json/wc/v3/coupons`);
    expect(c.headers.Authorization).toBe(EXPECTED_AUTH);
    expect(c.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(c.body!)).toEqual({
      code: 'PPP-IN40-K7QX',
      discount_type: 'percent',
      amount: '40', // "Should always be numeric, even if setting a percentage"
      individual_use: true,
      description: 'Created by GoPayLocal: PPP IN 40%',
      meta_data: [{ key: 'gopaylocal', value: 'true' }],
    });
    // The store lower-cases the code; ours is kept for display (case-insensitive match).
    expect(d).toEqual({ providerDiscountId: '719', code: 'PPP-IN40-K7QX', discountPercent: 40, provider: 'woocommerce' });
  });

  it('sends product_ids, usage_limit and a UTC date_expires when asked', async () => {
    responder = () => json(201, fixture('coupon-create-response.json'));
    await provider().createDiscount({
      name: 'n',
      code: 'GPLVERIFY-AB12',
      discountType: 'percentage',
      amount: 12.5,
      productIds: ['794'],
      maxRedemptions: 1,
      expiresAt: '2026-12-31T23:59:59.000Z',
    });
    expect(JSON.parse(calls[0]!.body!)).toMatchObject({
      amount: '12.5',
      product_ids: [794],
      usage_limit: 1,
      date_expires: '2026-12-31T23:59:59Z', // Z, no fraction: read as UTC (abstract-wc-data.php set_date_prop)
    });
  });

  it('rejects what it cannot create, before any request', async () => {
    const p = provider();
    await expect(p.createDiscount({ name: 'n', code: 'X', discountType: 'fixed', amount: 500, currency: 'USD' })).rejects.toThrow(/percentage/);
    await expect(p.createDiscount({ name: 'n', code: 'X', discountType: 'percentage', amount: 0 })).rejects.toThrow(ProviderError);
    await expect(p.createDiscount({ name: 'n', code: 'X', discountType: 'percentage', amount: 101 })).rejects.toThrow(ProviderError);
    await expect(p.createDiscount({ name: 'n', code: 'X', discountType: 'percentage', amount: 10, productIds: ['prod_1'] })).rejects.toThrow(/numbers/);
    await expect(p.createDiscount({ name: 'n', code: 'X', discountType: 'percentage', amount: 10, expiresAt: 'soon' })).rejects.toThrow(/expiry/);
    expect(calls).toHaveLength(0);
  });

  it('explains a duplicate code [COUPONS: woocommerce_rest_coupon_code_already_exists]', async () => {
    responder = () => json(400, { code: 'woocommerce_rest_coupon_code_already_exists', message: 'The coupon code already exists', data: { status: 400 } });
    const err = await provider().createDiscount({ name: 'n', code: 'PPP-IN40-K7QX', discountType: 'percentage', amount: 40 }).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.message).toContain('A coupon with the code PPP-IN40-K7QX already exists');
    expect(err.providerErrorCode).toBe('woocommerce_rest_coupon_code_already_exists');
  });
});

describe('deleteDiscount', () => {
  it('DELETEs permanently with force=true [COUPONS]', async () => {
    responder = () => json(200, fixture('coupon-create-response.json'));
    await provider().deleteDiscount('719');
    expect(calls[0]!.method).toBe('DELETE');
    expect(calls[0]!.url).toBe(`${STORE}/wp-json/wc/v3/coupons/719?force=true`);
  });

  it('maps WooCommerce\'s invalid-id 404 to ProviderNotFoundError', async () => {
    responder = () => json(404, { code: 'woocommerce_rest_shop_coupon_invalid_id', message: 'Invalid ID.', data: { status: 404 } });
    await expect(provider().deleteDiscount('719')).rejects.toBeInstanceOf(ProviderNotFoundError);
  });

  it('refuses an id that is not a number, without a request', async () => {
    for (const id of ['', 'abc', '719/../../users', '719?force=false', '-1', '0']) {
      await expect(provider().deleteDiscount(id), id).rejects.toThrow(ProviderError);
    }
    expect(calls).toHaveLength(0);
  });
});

describe('listDiscounts', () => {
  it('GETs 100 per page with _fields and returns only our redeemable coupons', async () => {
    responder = () => json(200, fixture('coupons-list-page.json').body, { 'X-WP-Total': '3', 'X-WP-TotalPages': '1' });
    const list = await provider().listDiscounts();
    expect(calls).toHaveLength(1);
    const u = new URL(calls[0]!.url);
    expect(u.pathname).toBe('/wp-json/wc/v3/coupons');
    expect(u.searchParams.get('per_page')).toBe('100');
    expect(u.searchParams.get('page')).toBe('1');
    expect(u.searchParams.get('_fields')).toBe('id,code,amount,discount_type,status,date_expires_gmt,usage_count,usage_limit,meta_data');
    expect(list).toEqual([{ providerDiscountId: '721', code: 'ppp-br30-q2zm', discountPercent: 30, provider: 'woocommerce' }]);
  });

  it('leaves out expired, used-up and unpublished coupons [SRC class-wc-discounts.php]', async () => {
    const ours = fixture('coupons-list-page.json').body[0];
    responder = () =>
      json(200, [
        { ...ours, id: 801, date_expires_gmt: '2020-01-01T00:00:00' },
        { ...ours, id: 802, usage_limit: 5, usage_count: 5 },
        { ...ours, id: 803, status: 'draft' },
        { ...ours, id: 804, date_expires_gmt: '2999-01-01T00:00:00', usage_limit: 5, usage_count: 4 },
      ], { 'X-WP-TotalPages': '1' });
    expect((await provider().listDiscounts()).map((d) => d.providerDiscountId)).toEqual(['804']);
  });

  it('follows X-WP-TotalPages [INTRO Pagination]', async () => {
    const ours = fixture('coupons-list-page.json').body[0];
    responder = (c) => {
      const page = Number(new URL(c.url).searchParams.get('page'));
      return json(200, [{ ...ours, id: 900 + page }], { 'X-WP-TotalPages': '3' });
    };
    const list = await provider().listDiscounts();
    expect(calls.map((c) => new URL(c.url).searchParams.get('page'))).toEqual(['1', '2', '3']);
    expect(list.map((d) => d.providerDiscountId)).toEqual(['901', '902', '903']);
  });

  it('errors instead of returning a truncated list past the page cap', async () => {
    responder = () => json(200, Array.from({ length: 100 }, (_, i) => ({ id: i + 1, code: 'x', meta_data: [] })), { 'X-WP-TotalPages': '9999' });
    await expect(provider().listDiscounts()).rejects.toThrow(/more than 5000/);
    expect(calls).toHaveLength(MAX_PAGES);
  });
});

// ── Products / checkout ─────────────────────────────────────────────────────

describe('listProducts', () => {
  it('lists published products with the store currency [PRODUCTS, DATA]', async () => {
    responder = (c) =>
      c.url.includes('/data/currencies/current')
        ? json(200, fixture('currency-current.json'))
        : json(200, fixture('products-list-page.json').body, { 'X-WP-TotalPages': '1' });
    const products = await provider().listProducts();
    const u = new URL(calls[0]!.url);
    expect(u.pathname).toBe('/wp-json/wc/v3/products');
    expect(u.searchParams.get('status')).toBe('publish');
    expect(u.searchParams.get('_fields')).toBe('id,name,price,permalink');
    expect(calls[1]!.url).toBe(`${STORE}/wp-json/wc/v3/data/currencies/current`);
    expect(products).toEqual([
      { providerProductId: '799', name: 'Ship Your Idea', price: null, currency: 'USD', url: 'https://example.com/product/ship-your-idea-22/' },
      { providerProductId: '794', name: 'Premium Quality', price: 21.99, currency: 'USD', url: 'https://example.com/product/premium-quality-19/' },
    ]);
  });

  it('drops a permalink that is not https', async () => {
    responder = (c) =>
      c.url.includes('/data/currencies/current')
        ? json(200, { code: 'EUR' })
        : json(200, [{ id: 5, name: 'P', price: '9', permalink: 'javascript:alert(1)' }], { 'X-WP-TotalPages': '1' });
    expect((await provider().listProducts())[0]).toMatchObject({ url: null, price: 9, currency: 'EUR' });
  });
});

describe('buildCheckoutUrl', () => {
  it('returns the store\'s shareable checkout link with the coupon, without a request [LINK]', async () => {
    const url = await provider('https://example.com/store').buildCheckoutUrl({
      productId: '794',
      discountCode: 'PPP-IN40-K7QX',
      successUrl: 'https://merchant.example/thanks',
    });
    const u = new URL(url);
    expect(`${u.origin}${u.pathname}`).toBe('https://example.com/store/checkout-link/');
    expect(u.searchParams.get('products')).toBe('794:1');
    expect(u.searchParams.get('coupon')).toBe('PPP-IN40-K7QX');
    expect(calls).toHaveLength(0);
  });

  it('refuses a non-numeric product id', async () => {
    await expect(provider().buildCheckoutUrl({ productId: '794,795:9', successUrl: 'https://x.example' })).rejects.toThrow(ProviderError);
  });
});

// ── Webhooks ────────────────────────────────────────────────────────────────

describe('provisionWebhook / deleteWebhook', () => {
  const CALLBACK = 'https://api.gopaylocal.com/v1/webhooks/woocommerce/int_123';

  it('creates order.created and order.updated webhooks with one secret [WEBHOOKS]', async () => {
    let next = 142;
    responder = (c) => json(201, { ...fixture('webhook-create-response.json'), id: next++, topic: JSON.parse(c.body!).topic });
    const res = await provider().provisionWebhook(CALLBACK);

    expect(calls.map((c) => [c.method, c.url])).toEqual([
      ['POST', `${STORE}/wp-json/wc/v3/webhooks`],
      ['POST', `${STORE}/wp-json/wc/v3/webhooks`],
    ]);
    const bodies = calls.map((c) => JSON.parse(c.body!));
    expect(bodies.map((b) => b.topic)).toEqual(['order.created', 'order.updated']);
    for (const b of bodies) {
      expect(b).toMatchObject({ delivery_url: CALLBACK, status: 'active', secret: res.secret });
      expect(b.name).toMatch(/^GoPayLocal redemptions/);
    }
    // Hex: wp_specialchars_decode (applied to the secret before signing) leaves it unchanged.
    expect(res.secret).toMatch(/^[0-9a-f]{64}$/);
    expect(res.endpointId).toBe('142,143');
  });

  it('removes the first webhook if the second cannot be created', async () => {
    responder = (c) => {
      if (c.method === 'DELETE') return json(200, {});
      return JSON.parse(c.body!).topic === 'order.created'
        ? json(201, { ...fixture('webhook-create-response.json'), id: 142 })
        : json(400, { code: 'woocommerce_rest_webhook_invalid_topic', message: 'm', data: { status: 400 } });
    };
    await expect(provider().provisionWebhook(CALLBACK)).rejects.toThrow(/woocommerce_rest_webhook_invalid_topic/);
    expect(calls.map((c) => [c.method, c.url])).toContainEqual(['DELETE', `${STORE}/wp-json/wc/v3/webhooks/142?force=true`]);
  });

  it('deletes both with force=true (required: no trash for webhooks) and ignores one already gone', async () => {
    responder = (c) =>
      c.url.includes('/142')
        ? json(404, { code: 'woocommerce_rest_shop_webhook_invalid_id', message: 'Invalid ID.', data: { status: 404 } })
        : json(200, {});
    await provider().deleteWebhook('142,143');
    expect(calls.map((c) => [c.method, c.url])).toEqual([
      ['DELETE', `${STORE}/wp-json/wc/v3/webhooks/142?force=true`],
      ['DELETE', `${STORE}/wp-json/wc/v3/webhooks/143?force=true`],
    ]);
  });

  it('still tries the second delete when the first fails, then reports the failure', async () => {
    responder = (c) => (c.url.includes('/142') ? json(500, { code: 'x', message: 'm' }) : json(200, {}));
    await expect(provider().deleteWebhook('142,143')).rejects.toThrow(/HTTP 500/);
    expect(calls).toHaveLength(2);
  });

  it('refuses a malformed endpoint id', async () => {
    await expect(provider().deleteWebhook('142,../users')).rejects.toThrow(ProviderError);
    expect(calls).toHaveLength(0);
  });
});

describe('verifyWebhook', () => {
  const SECRET = 'f'.repeat(64);
  const body = fixtureText('order-processing-coupon.json').trim();
  // Independent oracle: PHP base64_encode(hash_hmac('sha256', $body, $secret, true)) [SRC generate_signature].
  const sign = (b: string, s = SECRET) => createHmac('sha256', s).update(b, 'utf8').digest('base64');
  const headers = (sig?: string) => new Headers(sig === undefined ? {} : { 'X-WC-Webhook-Signature': sig });

  it('accepts the store\'s signature over the exact body', async () => {
    expect(await provider().verifyWebhook({ rawBody: body, headers: headers(sign(body)), secret: SECRET })).toBe(true);
  });

  it('rejects a changed body, another secret, a hex digest, a missing header or no stored secret', async () => {
    const p = provider();
    expect(await p.verifyWebhook({ rawBody: `${body} `, headers: headers(sign(body)), secret: SECRET })).toBe(false);
    expect(await p.verifyWebhook({ rawBody: body, headers: headers(sign(body, 'other')), secret: SECRET })).toBe(false);
    const hex = createHmac('sha256', SECRET).update(body).digest('hex');
    expect(await p.verifyWebhook({ rawBody: body, headers: headers(hex), secret: SECRET })).toBe(false);
    expect(await p.verifyWebhook({ rawBody: body, headers: headers(), secret: SECRET })).toBe(false);
    expect(await p.verifyWebhook({ rawBody: body, headers: headers(sign(body)), secret: null })).toBe(false);
  });

  it('verifies without a usable API key (the webhook route may not have one)', async () => {
    expect(await provider(STORE, '').verifyWebhook({ rawBody: body, headers: headers(sign(body)), secret: SECRET })).toBe(true);
  });
});

describe('isHandshake', () => {
  it('recognizes the unsigned creation ping (body webhook_id=<id>) [SRC deliver_ping]', () => {
    const p = provider();
    expect(p.isHandshake({ rawBody: 'webhook_id=142', headers: new Headers() })).toBe(true);
    expect(p.isHandshake({ rawBody: 'webhook_id=142', headers: new Headers({ 'X-WC-Webhook-Signature': 'x' }) })).toBe(false);
    expect(p.isHandshake({ rawBody: fixtureText('order-processing-coupon.json'), headers: new Headers() })).toBe(false);
    expect(p.isHandshake({ rawBody: 'webhook_id=142&x=1', headers: new Headers() })).toBe(false);
  });
});

// ── Redemptions ─────────────────────────────────────────────────────────────

describe('parseRedemption', () => {
  const withOrder = (patch: Record<string, unknown>) => JSON.stringify({ ...fixture('order-processing-coupon.json'), ...patch });

  it('turns a paid order with our coupon into a redemption, net of tax [ORDERS]', () => {
    expect(provider().parseRedemption(fixtureText('order-processing-coupon.json'))).toEqual({
      eventId: 'order:727',
      code: 'ppp-in40-k7qx',
      providerCouponId: null,
      providerPromoCodeId: null,
      chargedAmountCents: 2161, // total 21.61, tax and shipping included
      taxAmountCents: 81, // total_tax 0.81
      discountAmountCents: 720, // coupon line discount 7.20, ex tax (discount_tax 0.54 separate)
      currency: 'USD',
    });
  });

  it('counts the same savings with and without tax (C3)', () => {
    const p = provider();
    const taxed = p.parseRedemption(fixtureText('order-processing-coupon.json'))!;
    const order = fixture('order-processing-coupon.json');
    order.total = '20.80';
    order.total_tax = '0.00';
    order.coupon_lines[0].discount_tax = '0.00';
    const untaxed = p.parseRedemption(JSON.stringify(order))!;
    expect(untaxed.taxAmountCents).toBe(0);
    expect(taxed.taxAmountCents).toBe(81);
    const savings = (r: typeof taxed) => computeSavingsMinor(r.discountAmountCents, r.chargedAmountCents, r.taxAmountCents, 40);
    expect(savings(taxed)).toBe(720);
    expect(savings(untaxed)).toBe(720);
  });

  it('counts only paid statuses (processing, completed)', () => {
    const p = provider();
    expect(p.parseRedemption(withOrder({ status: 'completed' }))).toMatchObject({ eventId: 'order:727' });
    for (const status of ['pending', 'on-hold', 'failed', 'cancelled', 'refunded', 'trash', 'checkout-draft']) {
      expect(p.parseRedemption(withOrder({ status })), status).toBeNull();
    }
  });

  it('keys the event on the order, so created/updated/completed deliveries count once', () => {
    const p = provider();
    const a = p.parseRedemption(withOrder({ status: 'processing' }))!;
    const b = p.parseRedemption(withOrder({ status: 'completed', date_modified_gmt: '2017-03-23T10:00:00' }))!;
    expect(a.eventId).toBe(b.eventId);
  });

  it('returns null without a coupon, and for anything that is not an order', () => {
    const p = provider();
    expect(p.parseRedemption(fixtureText('order-processing-no-coupon.json'))).toBeNull();
    expect(p.parseRedemption('webhook_id=142')).toBeNull();
    expect(p.parseRedemption('not json')).toBeNull();
    expect(p.parseRedemption('[]')).toBeNull();
    // What a delivery carries when the webhook user can't read orders.
    expect(p.parseRedemption(JSON.stringify({ code: 'woocommerce_rest_cannot_view', message: 'x', data: { status: 401 } }))).toBeNull();
    expect(p.parseRedemption(withOrder({ id: 'abc' }))).toBeNull();
  });

  it('ignores a coupon line that discounted nothing (e.g. a full-price renewal carrying the code)', () => {
    const p = provider();
    const order = fixture('order-processing-coupon.json');
    order.coupon_lines[0].discount = '0.00';
    order.coupon_lines[0].discount_tax = '0.00';
    expect(p.parseRedemption(JSON.stringify(order))).toBeNull();
    // ...but an amount WooCommerce left out is unknown, not zero: still counted.
    delete order.coupon_lines[0].discount;
    expect(p.parseRedemption(JSON.stringify(order))).toMatchObject({ code: 'ppp-in40-k7qx', discountAmountCents: null });
  });

  it('passes on stacked coupons in order', () => {
    const order = fixture('order-processing-coupon.json');
    order.coupon_lines = [
      { id: 320, code: 'welcome5', discount: '0.50', discount_tax: '0.04', meta_data: [] },
      ...order.coupon_lines,
    ];
    const r = provider().parseRedemption(JSON.stringify(order))!;
    expect(r.code).toBe('welcome5');
    expect(r.discountAmountCents).toBe(50);
    expect(r.otherDiscounts).toEqual([
      { code: 'ppp-in40-k7qx', providerCouponId: null, providerPromoCodeId: null, discountAmountCents: 720 },
    ]);
  });

  it('omits otherDiscounts for a single coupon', () => {
    expect(provider().parseRedemption(fixtureText('order-processing-coupon.json'))).not.toHaveProperty('otherDiscounts');
  });

  it('converts to the currency\'s ISO minor unit (JPY 0, KWD 3 decimals)', () => {
    const p = provider();
    expect(
      p.parseRedemption(withOrder({ currency: 'JPY', total: '1200', total_tax: '0', coupon_lines: [{ code: 'c', discount: '800' }] })),
    ).toMatchObject({ chargedAmountCents: 1200, taxAmountCents: 0, discountAmountCents: 800, currency: 'JPY' });
    // A JPY store configured with 2 decimals still yields whole yen.
    expect(p.parseRedemption(withOrder({ currency: 'JPY', total: '1200.00', coupon_lines: [{ code: 'c', discount: '800.00' }] }))).toMatchObject({
      chargedAmountCents: 1200,
      discountAmountCents: 800,
    });
    expect(
      p.parseRedemption(withOrder({ currency: 'KWD', total: '1.500', total_tax: '0.000', coupon_lines: [{ code: 'c', discount: '0.750' }] })),
    ).toMatchObject({ chargedAmountCents: 1500, discountAmountCents: 750 });
  });

  it('reports unknown amounts as null rather than guessing', () => {
    const r = provider().parseRedemption(withOrder({ total: 'n/a', total_tax: undefined, coupon_lines: [{ code: 'c' }] }))!;
    expect(r).toMatchObject({ chargedAmountCents: null, taxAmountCents: null, discountAmountCents: null });
  });
});

describe('decimalToMinor', () => {
  it('converts exactly, rounding half away from zero', () => {
    expect(decimalToMinor('19.99', 2)).toBe(1999);
    expect(decimalToMinor('0.29', 2)).toBe(29); // 0.29 * 100 = 28.999… in floating point
    expect(decimalToMinor('7.2', 2)).toBe(720);
    expect(decimalToMinor('5', 2)).toBe(500);
    expect(decimalToMinor('1.005', 2)).toBe(101);
    expect(decimalToMinor('1.004', 2)).toBe(100);
    expect(decimalToMinor('1200.5', 0)).toBe(1201);
    expect(decimalToMinor('-3.50', 2)).toBe(-350);
    expect(decimalToMinor(21.61, 2)).toBe(2161);
  });

  it('returns null for anything that is not a plain decimal', () => {
    for (const v of ['', '1,000.00', '1e3', 'abc', '12.', '.5', null, undefined, NaN, {}]) {
      expect(decimalToMinor(v, 2), String(v)).toBeNull();
    }
  });
});
