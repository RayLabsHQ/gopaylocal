// Paddle adapter tests. No network and no SDK internals: the real
// @paddle/paddle-node-sdk runs unmodified, and the assertions are made on the
// HTTP request that leaves the process (origin, method, path, query, headers,
// snake_cased JSON body) and on the values the adapter returns.
//
// Transport boundary. Since SDK 2.0
// (https://github.com/PaddleHQ/paddle-node-sdk/blob/main/CHANGELOG.md:
// "Switched from node-fetch to native fetch API") the SDK calls
// globalThis.fetch, stubbed here with vi.stubGlobal; the "transport" test pins
// that. SDK 1.x went through node-fetch -> node:https.request(), which these
// tests intercepted with a second layer until the upgrade to 3.12 removed it.
//
// Webhook signatures are produced by an independent node:crypto implementation
// of https://developer.paddle.com/webhooks/about/signature-verification.
//
// Fixtures (__fixtures__/paddle): API replies are the response examples from
// the Paddle API reference pages named in each file; webhook payloads are the
// documented transaction.completed / transaction.paid examples (see the
// parseRedemption section for which fields were changed and why).
//
// Credentials are fake on purpose. The repo is public and GitHub secret
// scanning has partner + push-protection patterns for Paddle API keys
// (paddle_api_key, paddle_sandbox_api_key:
// https://docs.github.com/en/code-security/secret-scanning/introduction/supported-secret-scanning-patterns).
// So the keys below keep the documented `pdl_sdbx_` / `pdl_live_` prefix (the
// adapter routes on it) but have a body that is not a key (dashes, wrong
// length), and the notification secret in create-notification-setting-response
// .json was replaced the same way; the HMAC tests do not depend on its format.
import { readFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import { SDK_VERSION } from '@paddle/paddle-node-sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PaddleProvider, normalizePaddleCode } from './paddle';
import { ProviderAuthError, ProviderError, ProviderNotFoundError } from './types';

// ── SDK behaviour that legitimately differs across the bump ─────────────────
// Each flag cites the paddle-node-sdk CHANGELOG entry that introduced it.

const [SDK_MAJOR = 0, SDK_MINOR = 0, SDK_PATCH = 0] = SDK_VERSION.split('.').map(Number);
const sdkAtLeast = (major: number, minor = 0, patch = 0) =>
  SDK_MAJOR !== major ? SDK_MAJOR > major : SDK_MINOR !== minor ? SDK_MINOR > minor : SDK_PATCH >= patch;
/** 3.2.1: "Fixed a bug where `delete` operations were not returning failures correctly". */
const SDK_DELETE_SURFACES_ERRORS = sdkAtLeast(3, 2, 1);
/** 3.12.0: "`ApiError.status`, the HTTP status code"; non-JSON bodies throw ApiError `unexpected_response`. */
const SDK_ERROR_HAS_STATUS = sdkAtLeast(3, 12);

// ── outgoing-request recorder ───────────────────────────────────────────────

interface Req {
  via: 'fetch';
  method: string;
  origin: string;
  path: string;
  query: Record<string, string>;
  headers: Headers;
  body: any;
}
type Reply = { status?: number; body?: unknown; raw?: string; contentType?: string };
type Wire = { status: number; text: string; headers: Record<string, string> };

let requests: Req[];
let replies: Array<Reply | ((req: Req) => Reply)>;

function respond(via: Req['via'], method: string, url: URL, headers: Headers, rawBody: string): Wire {
  const req: Req = {
    via,
    method: method.toUpperCase(),
    origin: url.origin,
    path: url.pathname,
    query: Object.fromEntries(url.searchParams),
    headers,
    body: rawBody ? JSON.parse(rawBody) : undefined,
  };
  requests.push(req);
  const next = replies.shift();
  const out: Reply = !next
    ? { status: 500, body: { error: { type: 'api_error', code: 'unexpected_test_request', detail: `${req.method} ${url}` } } }
    : typeof next === 'function'
      ? next(req)
      : next;
  return {
    status: out.status ?? 200,
    text: out.raw ?? (out.body === undefined ? '' : JSON.stringify(out.body)),
    headers: { 'content-type': out.contentType ?? 'application/json', 'request-id': 'req_test' },
  };
}

// The SDK's only transport: globalThis.fetch.
async function fetchShim(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const request = new Request(input, init);
  const out = respond('fetch', request.method, new URL(request.url), request.headers, await request.text());
  const nullBody = out.status === 204 || out.status === 304;
  return new Response(nullBody ? null : out.text, { status: out.status, headers: out.headers });
}

beforeEach(() => {
  requests = [];
  replies = [];
  vi.stubGlobal('fetch', vi.fn(fetchShim));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const reply = (...rs: Array<Reply | ((req: Req) => Reply)>) => replies.push(...rs);
const apiFixture = (name: string) =>
  JSON.parse(readFileSync(new URL(`./__fixtures__/paddle/api/${name}`, import.meta.url), 'utf8'));
// Paddle error envelope (https://developer.paddle.com/api-reference/about/errors).
const paddleError = (status: number, code: string, detail = code): Reply => ({
  status,
  body: {
    error: { type: 'request_error', code, detail, documentation_url: `https://developer.paddle.com/errors/shared/${code}` },
    meta: { request_id: 'req_test' },
  },
});
const emptyPage = (): Reply => ({
  body: { data: [], meta: { request_id: 'req_test', pagination: { per_page: 200, next: '', has_more: false, estimated_total: 0 } } },
});

// Base URLs from https://developer.paddle.com/api-reference/about/paddle-api.
const SANDBOX_ORIGIN = 'https://sandbox-api.paddle.com';
const LIVE_ORIGIN = 'https://api.paddle.com';
// Prefixes from https://developer.paddle.com/api-reference/about/authentication;
// the rest is a fake body (see the header comment).
const SANDBOX_KEY = 'pdl_sdbx_apikey_FAKE-not-a-real-sandbox-key';
const LIVE_KEY = 'pdl_live_apikey_FAKE-not-a-real-live-key';
const NOTIFICATION_SECRET = 'pdl_ntfset_FAKE-not-a-real-notification-secret';

const makeProvider = (apiKey = SANDBOX_KEY, environment: 'live' | 'test' = 'test') =>
  new PaddleProvider({ apiKey, environment });

function expectPaddleRequest(r: Req, method: string, path: string, key = SANDBOX_KEY) {
  expect(r.origin).toBe(key.startsWith('pdl_live_') ? LIVE_ORIGIN : SANDBOX_ORIGIN);
  expect(r.method).toBe(method);
  expect(r.path).toBe(path);
  // Bearer auth (https://developer.paddle.com/api-reference/about/authentication).
  // The SDK writes the scheme as lowercase `bearer`; schemes are case-insensitive.
  expect(r.headers.get('authorization')).toBe(`bearer ${key}`);
  expect(r.headers.get('content-type')).toBe('application/json');
  // No Paddle-Version header: requests use the account default, and v1 is the
  // only version (https://developer.paddle.com/api-reference/about/versioning).
  expect(r.headers.get('paddle-version')).toBeNull();
}

// ── transport + config ──────────────────────────────────────────────────────

describe('transport', () => {
  it(`SDK ${SDK_VERSION} sends its requests through globalThis.fetch`, async () => {
    reply(emptyPage());
    await makeProvider().listDiscounts();
    expect(requests).toHaveLength(1);
    expect(requests[0]!.via).toBe('fetch');
  });
});

describe('PaddleProvider environment', () => {
  it('sends a sandbox key to the sandbox API even when the caller says live', async () => {
    // Bug fixed: the connect + webhook routes always pass 'live', so a sandbox
    // key (pdl_sdbx_...) hit api.paddle.com and failed with invalid_token.
    reply(emptyPage());
    await makeProvider(SANDBOX_KEY, 'live').listDiscounts();
    expect(requests[0]!.origin).toBe(SANDBOX_ORIGIN);
  });

  it('sends a live key to the production API even when the caller says test', async () => {
    reply(emptyPage());
    await makeProvider(LIVE_KEY, 'test').listDiscounts();
    expectPaddleRequest(requests[0]!, 'GET', '/discounts', LIVE_KEY);
  });

  it('falls back to the environment hint for legacy keys without a prefix', async () => {
    const legacy = 'a'.repeat(50);
    reply(emptyPage(), emptyPage());
    await makeProvider(legacy, 'live').listDiscounts();
    await makeProvider(legacy, 'test').listDiscounts();
    expect(requests.map((r) => r.origin)).toEqual([LIVE_ORIGIN, SANDBOX_ORIGIN]);
  });

  it('constructs with an empty key (webhook route fallback) without throwing', () => {
    expect(() => new PaddleProvider({ apiKey: '', environment: 'live' })).not.toThrow();
  });
});

// ── createDiscount ──────────────────────────────────────────────────────────

describe('createDiscount', () => {
  const created = (over: Record<string, unknown> = {}) => {
    const r = apiFixture('create-discount-response.json');
    Object.assign(r.data, over);
    return { status: 201, body: r };
  };

  it('creates a recurring, checkout-enabled percentage discount with an alphanumeric code', async () => {
    reply(created({ code: 'PPPIN40K7QX', amount: '40', recur: true, maximum_recurring_intervals: null }));
    const provider = makeProvider();

    const result = await provider.createDiscount({
      name: 'PPP IN 40%',
      code: 'PPP-IN40-K7QX',
      discountType: 'percentage',
      amount: 40,
    });

    expect(requests).toHaveLength(1);
    expectPaddleRequest(requests[0]!, 'POST', '/discounts');
    expect(requests[0]!.body).toEqual({
      description: 'PPP IN 40%',
      type: 'percentage',
      amount: '40',
      code: 'PPPIN40K7QX',
      enabled_for_checkout: true,
      recur: true,
      maximum_recurring_intervals: null,
    });
    expect(result).toEqual({
      providerDiscountId: 'dsc_01hv6scyf7qdnzcdq01t2y8dx4',
      code: 'PPPIN40K7QX',
      discountPercent: 40,
      provider: 'paddle',
    });
  });

  it('maps flat amounts (lowest denomination string + uppercase currency), usage limit, scope and expiry', async () => {
    reply(created({ type: 'flat', amount: '500', currency_code: 'EUR', code: 'FLAT500' }));
    const provider = makeProvider();

    const result = await provider.createDiscount({
      name: 'Flat',
      code: 'FLAT500',
      discountType: 'fixed',
      amount: 500,
      currency: 'eur',
      maxRedemptions: 25,
      productIds: ['pro_01gsz4t5hdjse780zja8vvr7jg', 'pri_01gsz8x8sawmvhz1pv30nge1ke'],
      expiresAt: '2027-01-01T00:00:00.000Z',
    });

    expect(requests[0]!.body).toMatchObject({
      type: 'flat',
      amount: '500',
      currency_code: 'EUR',
      usage_limit: 25,
      restrict_to: ['pro_01gsz4t5hdjse780zja8vvr7jg', 'pri_01gsz8x8sawmvhz1pv30nge1ke'],
      expires_at: '2027-01-01T00:00:00.000Z',
    });
    expect(requests[0]!.body).not.toHaveProperty('maximum_recurring_intervals', 25);
    expect(result.discountPercent).toBe(0);
  });

  it('omits currency_code for percentage discounts', async () => {
    reply(created());
    await makeProvider().createDiscount({ name: 'x', code: 'A1', discountType: 'percentage', amount: 10, currency: 'usd' });
    expect(requests[0]!.body).not.toHaveProperty('currency_code');
  });

  it('refuses a flat discount without currency before calling Paddle', async () => {
    await expect(
      makeProvider().createDiscount({ name: 'x', code: 'A1', discountType: 'fixed', amount: 100 }),
    ).rejects.toThrow('currency is required');
    expect(requests).toHaveLength(0);
  });

  it('truncates codes to 32 characters (pattern ^[a-zA-Z0-9]{1,32}$)', async () => {
    reply(created());
    await makeProvider().createDiscount({ name: 'x', code: `${'AB'.repeat(20)}-X`, discountType: 'percentage', amount: 10 });
    expect(requests[0]!.body.code).toBe('AB'.repeat(16));
    expect(normalizePaddleCode('PPP-IN40-K7QX')).toBe('PPPIN40K7QX');
    expect(normalizePaddleCode('PPP-IN40-K7QX')).toMatch(/^[a-zA-Z0-9]{1,32}$/);
  });
});

// ── deleteDiscount / listDiscounts / listProducts ───────────────────────────

describe('deleteDiscount', () => {
  it('archives via PATCH status=archived (discounts cannot be deleted)', async () => {
    const archived = apiFixture('update-discount-response.json');
    archived.data.status = 'archived';
    reply({ body: archived });

    await makeProvider().deleteDiscount('dsc_01hv6scyf7qdnzcdq01t2y8dx4');

    expectPaddleRequest(requests[0]!, 'PATCH', '/discounts/dsc_01hv6scyf7qdnzcdq01t2y8dx4');
    expect(requests[0]!.body).toEqual({ status: 'archived' });
  });

  it('maps not_found to ProviderNotFoundError (statusCode 404)', async () => {
    reply(paddleError(404, 'not_found', 'Entity dsc_x not found'));
    const err = await makeProvider().deleteDiscount('dsc_x').catch((e) => e);
    expect(err).toBeInstanceOf(ProviderNotFoundError);
    expect(err.statusCode).toBe(404);
  });
});

describe('listDiscounts', () => {
  it('requests active discounts, 200 per page, follows pagination.next, and maps percent', async () => {
    const page1 = apiFixture('list-discounts-response.json');
    const page2 = apiFixture('list-discounts-response.json');
    page1.meta.pagination = { per_page: 200, next: `${SANDBOX_ORIGIN}/discounts?after=dsc_page1`, has_more: true, estimated_total: 8 };
    page2.meta.pagination = { per_page: 200, next: `${SANDBOX_ORIGIN}/discounts?after=dsc_page2`, has_more: false, estimated_total: 8 };
    // Two of the documented example's discounts have long-past expires_at
    // dates; clear them so this test is about paging and mapping only (the
    // expiry filter has its own test below).
    for (const page of [page1, page2]) for (const d of page.data) d.expires_at = null;
    reply({ body: page1 }, { body: page2 });

    const list = await makeProvider().listDiscounts();

    expect(requests).toHaveLength(2);
    expectPaddleRequest(requests[0]!, 'GET', '/discounts');
    expect(requests[0]!.query).toEqual({ status: 'active', per_page: '200' });
    expectPaddleRequest(requests[1]!, 'GET', '/discounts');
    expect(requests[1]!.query).toEqual({ after: 'dsc_page1' });
    expect(list).toHaveLength(8);
    const expected = page1.data.map((d: any) => ({
      providerDiscountId: d.id,
      code: d.code ?? '',
      discountPercent: d.type === 'percentage' ? Number(d.amount) : 0,
      provider: 'paddle',
    }));
    expect(list.slice(0, 4)).toEqual(expected);
  });

  it('leaves out discounts past expires_at or at their usage_limit, which status=active does not', async () => {
    // listDiscounts returns only redeemable discounts (types.ts contract).
    // The documented status values are only `active` and `archived`, and the
    // documented list example itself returns BF10OFF (expires_at 2024-12-03)
    // and 10OFFPRO (expires_at 2023-12-05) as "active". expires_at: "Discount
    // can no longer be redeemed after this date has elapsed". usage_limit:
    // "Paddle checks this limit when a discount is applied ... comparing it
    // against times_used" (https://developer.paddle.com/api-reference/discounts/list-discounts).
    const page = apiFixture('list-discounts-response.json');
    page.data[2].usage_limit = 6; // 98XFAUR91R, times_used 6: used up
    page.data.push({
      ...page.data[3],
      id: 'dsc_01jfuturediscount000000000',
      code: 'PPPIN40K7QX',
      expires_at: '2099-01-01T00:00:00Z',
      usage_limit: 10,
      times_used: 9,
    });
    reply({ body: page });

    const list = await makeProvider().listDiscounts();

    expect(list.map((d) => d.providerDiscountId)).toEqual([
      'dsc_01h83xenpcfjyhkqr4x214m02x', // no expiry, no limit
      'dsc_01jfuturediscount000000000', // expires in the future, 1 use left
    ]);
  });
});

describe('listProducts', () => {
  it('lists active products with prices, preferring an active price, and converts lowest-denomination amounts', async () => {
    const res = apiFixture('list-products-with-prices-response.json');
    // Product 0: first price archived -> the active one must be used.
    res.data[0].prices[0].status = 'archived';
    // Product 1: a zero-decimal currency (JPY has decimal_places 0 in /currencies).
    res.data[1].prices[0].unit_price = { amount: '1500', currency_code: 'JPY' };
    // Product 2: no prices at all.
    res.data[2].prices = [];
    reply({ body: res });

    const products = await makeProvider().listProducts();

    expectPaddleRequest(requests[0]!, 'GET', '/products');
    expect(requests[0]!.query).toEqual({ status: 'active', include: 'prices', per_page: '200' });
    expect(products.slice(0, 4)).toEqual([
      { providerProductId: res.data[0].id, name: 'Analytics addon', price: 100, currency: 'USD', url: null },
      { providerProductId: res.data[1].id, name: 'Custom domains', price: 1500, currency: 'JPY', url: null },
      { providerProductId: res.data[2].id, name: 'VIP support', price: null, currency: null, url: null },
      { providerProductId: res.data[3].id, name: 'AeroEdit Enterprise', price: 50, currency: 'USD', url: null },
    ]);
  });
});

// ── buildCheckoutUrl ────────────────────────────────────────────────────────

describe('buildCheckoutUrl', () => {
  const txn = (url: string | null) => {
    const r = apiFixture('create-transaction-response.json');
    r.data.checkout = { url };
    return { status: 201, body: r };
  };
  const payLink = 'https://merchant.example/pay?_ptxn=txn_01hv8m0mnx3sj85e7gxc6kga03';

  it('creates a transaction for the price with the discount id and custom data, returning checkout.url', async () => {
    reply(txn(payLink));

    const url = await makeProvider().buildCheckoutUrl({
      productId: 'pri_01gsz8x8sawmvhz1pv30nge1ke',
      discountId: 'dsc_01hv6scyf7qdnzcdq01t2y8dx4',
      successUrl: 'https://merchant.example/ok',
      customerEmail: 'ignored@example.com',
      metadata: { campaignId: 'c1' },
    });

    expect(url).toBe(payLink);
    expectPaddleRequest(requests[0]!, 'POST', '/transactions');
    // custom_data keys are passed through untouched (no snake_casing).
    expect(requests[0]!.body).toEqual({
      items: [{ price_id: 'pri_01gsz8x8sawmvhz1pv30nge1ke', quantity: 1 }],
      discount_id: 'dsc_01hv6scyf7qdnzcdq01t2y8dx4',
      custom_data: { campaignId: 'c1' },
    });
  });

  it('resolves a product id (what listProducts returns) to its active price', async () => {
    const product = apiFixture('list-products-with-prices-response.json').data[0];
    product.prices[0].status = 'archived';
    reply({ body: { data: product, meta: { request_id: 'r' } } }, txn(payLink));

    await makeProvider().buildCheckoutUrl({ productId: product.id, successUrl: 'https://m/ok' });

    expectPaddleRequest(requests[0]!, 'GET', `/products/${product.id}`);
    expect(requests[0]!.query).toEqual({ include: 'prices' });
    expectPaddleRequest(requests[1]!, 'POST', '/transactions');
    expect(requests[1]!.body.items).toEqual([{ price_id: product.prices[1].id, quantity: 1 }]);
  });

  it('resolves a discount code to its id when no discount id is given', async () => {
    const list = apiFixture('list-discounts-response.json');
    list.data = [{ ...list.data[0], id: 'dsc_resolved', code: 'PPPIN40K7QX' }];
    list.meta.pagination.has_more = false;
    reply({ body: list }, txn(payLink));

    await makeProvider().buildCheckoutUrl({ productId: 'pri_x', discountCode: 'PPP-IN40-K7QX', successUrl: 'https://m/ok' });

    expectPaddleRequest(requests[0]!, 'GET', '/discounts');
    expect(requests[0]!.query).toEqual({ code: 'PPPIN40K7QX', status: 'active' });
    expect(requests[1]!.body.discount_id).toBe('dsc_resolved');
  });

  it('throws when Paddle returns no checkout url', async () => {
    reply(txn(null));
    await expect(makeProvider().buildCheckoutUrl({ productId: 'pri_x', successUrl: 'https://m/ok' })).rejects.toThrow(
      'No checkout URL',
    );
  });

  it('surfaces a missing default payment link as a ProviderError with Paddle code', async () => {
    reply(paddleError(400, 'transaction_default_checkout_url_not_set', 'Cannot create a transaction or open a checkout as no default payment link has been set for this account.'));
    const err = await makeProvider().buildCheckoutUrl({ productId: 'pri_x', successUrl: 'https://m/ok' }).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.providerErrorCode).toBe('transaction_default_checkout_url_not_set');
    expect(err.operation).toBe('buildCheckoutUrl');
  });
});

// ── notification settings (webhook endpoint) ────────────────────────────────

describe('provisionWebhook / deleteWebhook', () => {
  it('creates a url destination for transaction.completed and returns id + endpoint_secret_key', async () => {
    reply({ status: 201, body: apiFixture('create-notification-setting-response.json') });

    const res = await makeProvider().provisionWebhook('https://api.gopaylocal.com/v1/webhooks/paddle/int_1');

    expectPaddleRequest(requests[0]!, 'POST', '/notification-settings');
    expect(requests[0]!.body).toEqual({
      description: 'GoPayLocal PPP redemption tracking',
      type: 'url',
      destination: 'https://api.gopaylocal.com/v1/webhooks/paddle/int_1',
      subscribed_events: ['transaction.completed'],
      include_sensitive_fields: false,
      traffic_source: 'all',
    });
    expect(res).toEqual({
      endpointId: 'ntfset_01gkpjp8bkm3tm53kdgkx6sms7',
      secret: NOTIFICATION_SECRET,
    });
  });

  it('maps provisioning failures to provider errors', async () => {
    // Bug fixed: SDK ApiErrors escaped unmapped.
    reply(paddleError(403, 'forbidden', "You aren't permitted to perform this request."));
    await expect(makeProvider().provisionWebhook('https://x/y')).rejects.toBeInstanceOf(ProviderAuthError);
  });

  it('DELETEs the notification setting', async () => {
    reply({ status: 204 });
    await makeProvider().deleteWebhook('ntfset_01gkpjp8bkm3tm53kdgkx6sms7');
    expectPaddleRequest(requests[0]!, 'DELETE', '/notification-settings/ntfset_01gkpjp8bkm3tm53kdgkx6sms7');
  });

  it('treats an already-deleted notification setting as success', async () => {
    reply(paddleError(404, 'not_found', 'Entity ntfset_x not found'));
    await expect(makeProvider().deleteWebhook('ntfset_x')).resolves.toBeUndefined();
    expectPaddleRequest(requests[0]!, 'DELETE', '/notification-settings/ntfset_x');
  });

  it(
    SDK_DELETE_SURFACES_ERRORS
      ? 'surfaces a failed delete as a mapped provider error'
      : `documents the SDK ${SDK_VERSION} limitation: a failed delete does not throw`,
    async () => {
      reply(paddleError(401, 'invalid_token', 'Invalid or revoked API key.'));
      const outcome = await makeProvider()
        .deleteWebhook('ntfset_x')
        .then(() => 'resolved' as const, (e: unknown) => e);
      expectPaddleRequest(requests[0]!, 'DELETE', '/notification-settings/ntfset_x');
      if (SDK_DELETE_SURFACES_ERRORS) expect(outcome).toBeInstanceOf(ProviderAuthError);
      else expect(outcome).toBe('resolved');
    },
  );
});

// ── verifyWebhook ───────────────────────────────────────────────────────────

describe('verifyWebhook', () => {
  const secret = NOTIFICATION_SECRET;
  const body = readFileSync(new URL('./__fixtures__/paddle/transaction-completed-discount.json', import.meta.url), 'utf8');
  // Independent signer: HMAC-SHA256(secret, `${ts}:${rawBody}`), hex.
  const sign = (payload: string, ts: number, key = secret) =>
    createHmac('sha256', key).update(`${ts}:${payload}`, 'utf8').digest('hex');
  const now = () => Math.floor(Date.now() / 1000);
  const provider = new PaddleProvider({ apiKey: '', environment: 'live' });
  const verify = (header: string | null, payload = body, s: string | null = secret) =>
    provider.verifyWebhook({
      rawBody: payload,
      headers: new Headers(header === null ? {} : { 'Paddle-Signature': header }),
      secret: s,
    });

  it('accepts a correctly signed payload', async () => {
    const ts = now();
    expect(await verify(`ts=${ts};h1=${sign(body, ts)}`)).toBe(true);
  });

  it('accepts any matching h1 during secret rotation, in either order', async () => {
    // "Signatures contain at least one h1 ... During secret rotation, more than
    // one h1 is returned."
    const ts = now();
    const good = sign(body, ts);
    const old = sign(body, ts, 'pdl_ntfset_old');
    expect(await verify(`ts=${ts};h1=${good};h1=${old}`)).toBe(true);
    expect(await verify(`ts=${ts};h1=${old};h1=${good}`)).toBe(true);
  });

  it('rejects a tampered body', async () => {
    const ts = now();
    expect(await verify(`ts=${ts};h1=${sign(body, ts)}`, body.replace('"23960"', '"1"'))).toBe(false);
  });

  it('rejects the wrong secret', async () => {
    const ts = now();
    expect(await verify(`ts=${ts};h1=${sign(body, ts, 'pdl_ntfset_wrong')}`)).toBe(false);
  });

  it('rejects a signature over the bare body (no `ts:` prefix)', async () => {
    const ts = now();
    const bare = createHmac('sha256', secret).update(body, 'utf8').digest('hex');
    expect(await verify(`ts=${ts};h1=${bare}`)).toBe(false);
  });

  it('rejects missing or malformed headers and a missing secret', async () => {
    const ts = now();
    expect(await verify(null)).toBe(false);
    expect(await verify('')).toBe(false);
    expect(await verify('garbage')).toBe(false);
    expect(await verify(`h1=${sign(body, ts)}`)).toBe(false); // no ts
    expect(await verify(`ts=${ts}`)).toBe(false); // no h1
    expect(await verify(`ts=${ts};h1=`)).toBe(false);
    expect(await verify(`ts=${ts};h1=${sign(body, ts)}`, body, null)).toBe(false);
  });

  it('rejects timestamps outside the 300s window, either side', async () => {
    const old = now() - 301;
    expect(await verify(`ts=${old};h1=${sign(body, old)}`)).toBe(false);
    const future = now() + 301;
    expect(await verify(`ts=${future};h1=${sign(body, future)}`)).toBe(false);
    const ok = now() - 290;
    expect(await verify(`ts=${ok};h1=${sign(body, ok)}`)).toBe(true);
  });

  it('makes no API call', async () => {
    const ts = now();
    await verify(`ts=${ts};h1=${sign(body, ts)}`);
    expect(requests).toHaveLength(0);
  });
});

// ── parseRedemption ─────────────────────────────────────────────────────────

describe('parseRedemption', () => {
  // transaction-completed-no-discount.json: the documented example, verbatim
  //   (https://developer.paddle.com/webhooks/transactions/transaction-completed).
  // transaction-completed-discount.json: same, with discount_id set to the
  //   create-discount docs example id and details.totals recomputed for 40% off.
  // transaction-completed-renewal.json: the discounted one as Paddle's renewal
  //   transaction (origin subscription_recurring, new txn/event ids).
  // transaction-paid.json: the documented transaction.paid example, verbatim
  //   (https://developer.paddle.com/webhooks/transactions/transaction-paid).
  const fixture = (name: string) => readFileSync(new URL(`./__fixtures__/paddle/${name}`, import.meta.url), 'utf8');
  const provider = new PaddleProvider({ apiKey: '', environment: 'live' });

  it('parses a completed checkout that used our discount (amounts are lowest-denomination strings)', () => {
    expect(provider.parseRedemption(fixture('transaction-completed-discount.json'))).toEqual({
      eventId: 'txn_01hv8wptq8987qeep44cyrewp9',
      code: null,
      providerCouponId: 'dsc_01hv6scyf7qdnzcdq01t2y8dx4',
      providerPromoCodeId: null,
      chargedAmountCents: 39134,
      // grand_total_tax: "Net tax amount included in grand_total" (contract C3).
      taxAmountCents: 3194,
      // Pre-tax: 59900 subtotal - 23960 discount + 3194 tax = 39134 total.
      discountAmountCents: 23960,
      currency: 'USD',
    });
  });

  it('reports the discount as unknown (null) when the totals do not show it was taken before tax', () => {
    // Defensive: a discount figure that does not reconcile with
    // subtotal - discount + tax = total cannot be proven tax-exclusive.
    const evt = JSON.parse(fixture('transaction-completed-discount.json'));
    Object.assign(evt.data.details.totals, { total: '36000', grand_total: '36000' });
    expect(provider.parseRedemption(JSON.stringify(evt))).toMatchObject({
      chargedAmountCents: 36000,
      taxAmountCents: 3194,
      discountAmountCents: null,
    });
  });

  it('takes the tax inside grand_total, which credits reduce proportionally', () => {
    const evt = JSON.parse(fixture('transaction-completed-discount.json'));
    Object.assign(evt.data.details.totals, { credit: '10000', grand_total: '29134', grand_total_tax: '2378' });
    expect(provider.parseRedemption(JSON.stringify(evt))).toMatchObject({
      chargedAmountCents: 29134,
      taxAmountCents: 2378,
      discountAmountCents: 23960,
    });
  });

  it('reports tax as unknown (null) when grand_total_tax is absent', () => {
    const evt = JSON.parse(fixture('transaction-completed-discount.json'));
    delete evt.data.details.totals.grand_total_tax;
    expect(provider.parseRedemption(JSON.stringify(evt))).toMatchObject({ taxAmountCents: null, discountAmountCents: 23960 });
  });

  it('ignores a purchase with no discount', () => {
    expect(provider.parseRedemption(fixture('transaction-completed-no-discount.json'))).toBeNull();
  });

  it('does not count subscription renewals that carry the recurring discount', () => {
    expect(provider.parseRedemption(fixture('transaction-completed-renewal.json'))).toBeNull();
  });

  it('ignores other subscription-created transaction origins', () => {
    for (const origin of ['subscription_update', 'subscription_charge', 'subscription_payment_method_change']) {
      const evt = JSON.parse(fixture('transaction-completed-discount.json'));
      evt.data.origin = origin;
      expect(provider.parseRedemption(JSON.stringify(evt))).toBeNull();
    }
  });

  it('counts API-created transactions (origin api)', () => {
    const evt = JSON.parse(fixture('transaction-completed-discount.json'));
    evt.data.origin = 'api';
    expect(provider.parseRedemption(JSON.stringify(evt))?.providerCouponId).toBe('dsc_01hv6scyf7qdnzcdq01t2y8dx4');
  });

  it('ignores other event types, even about a discounted transaction', () => {
    expect(provider.parseRedemption(fixture('transaction-paid.json'))).toBeNull();
    const paid = JSON.parse(fixture('transaction-paid.json'));
    paid.data.discount_id = 'dsc_01hv6scyf7qdnzcdq01t2y8dx4';
    expect(provider.parseRedemption(JSON.stringify(paid))).toBeNull();
  });

  it('keys idempotency on the transaction id, stable across redeliveries of the same event', () => {
    const a = JSON.parse(fixture('transaction-completed-discount.json'));
    const b = { ...a, notification_id: 'ntf_redelivery', event_id: 'evt_01hzzzzzzzzzzzzzzzzzzzzzzz' };
    expect(provider.parseRedemption(JSON.stringify(a))?.eventId).toBe(a.data.id);
    expect(provider.parseRedemption(JSON.stringify(b))?.eventId).toBe(a.data.id);
  });

  it('passes zero-decimal amounts through as whole units', () => {
    const evt = JSON.parse(fixture('transaction-completed-discount.json'));
    evt.data.currency_code = 'JPY';
    Object.assign(evt.data.details.totals, {
      subtotal: '3000',
      discount: '1200',
      tax: '0',
      total: '1800',
      grand_total: '1800',
      grand_total_tax: '0',
      currency_code: 'JPY',
    });
    expect(provider.parseRedemption(JSON.stringify(evt))).toMatchObject({
      chargedAmountCents: 1800,
      taxAmountCents: 0,
      discountAmountCents: 1200,
      currency: 'JPY',
    });
  });

  it('returns null for invalid JSON', () => {
    expect(provider.parseRedemption('not json')).toBeNull();
  });
});

// ── error mapping ───────────────────────────────────────────────────────────

describe('error mapping (codes from https://developer.paddle.com/errors)', () => {
  it.each(['invalid_token', 'authentication_missing', 'authentication_malformed', 'invalid_access_token'])(
    '%s -> ProviderAuthError',
    async (code) => {
      reply(paddleError(401, code));
      await expect(makeProvider().listDiscounts()).rejects.toBeInstanceOf(ProviderAuthError);
    },
  );

  it('forbidden (key lacks a permission) -> ProviderAuthError', async () => {
    reply(paddleError(403, 'forbidden'));
    await expect(makeProvider().listProducts()).rejects.toBeInstanceOf(ProviderAuthError);
  });

  it('not_found -> ProviderNotFoundError', async () => {
    reply(paddleError(404, 'not_found'));
    await expect(makeProvider().buildCheckoutUrl({ productId: 'pro_missing', successUrl: 'https://m/ok' })).rejects.toBeInstanceOf(
      ProviderNotFoundError,
    );
  });

  it('other errors -> ProviderError with the Paddle code and operation', async () => {
    reply(paddleError(409, 'discount_code_conflict', 'Discount code PPPIN40K7QX is already in use.'));
    const err = await makeProvider()
      .createDiscount({ name: 'x', code: 'PPPIN40K7QX', discountType: 'percentage', amount: 40 })
      .catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err).not.toBeInstanceOf(ProviderAuthError);
    expect(err).not.toBeInstanceOf(ProviderNotFoundError);
    expect(err.providerErrorCode).toBe('discount_code_conflict');
    expect(err.operation).toBe('createDiscount');
    expect(err.message).toContain('already in use');
    // Only SDK >= 3.12 exposes the HTTP status; earlier SDKs give the code alone.
    expect(err.statusCode).toBe(SDK_ERROR_HAS_STATUS ? 409 : undefined);
  });

  it('a non-JSON error page (e.g. a Cloudflare 502) -> ProviderError, never Auth/NotFound', async () => {
    reply({ status: 502, raw: '<html><body>502 Bad Gateway</body></html>', contentType: 'text/html' });
    const err = await makeProvider().listProducts().catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err).not.toBeInstanceOf(ProviderAuthError);
    expect(err).not.toBeInstanceOf(ProviderNotFoundError);
    expect(err.operation).toBe('listProducts');
    if (SDK_ERROR_HAS_STATUS) {
      // 3.12: "Other unexpected responses use the `unexpected_response` code".
      expect(err.statusCode).toBe(502);
      expect(err.providerErrorCode).toBe('unexpected_response');
    }
  });
});
