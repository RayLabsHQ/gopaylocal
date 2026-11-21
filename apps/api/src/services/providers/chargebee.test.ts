// Chargebee provider: request shapes, webhook auth and redemption parsing.
//
// Every expectation below is taken from Chargebee's official docs / spec, not
// from the code under test:
//   [AUTH]   https://apidocs.chargebee.com/docs/api/auth.md
//   [SPEC]   https://github.com/chargebee/openapi spec/chargebee_api_v2_pc_v2_spec.json
//            (servers, request bodies, response shapes)
//   [SDK]    chargebee@3.37.0 esm/util.js encodeParams + esm/resources/api_endpoints.js
//            (form encoding; coupon.createForItems jsonKeys {meta_data:0, item_price_ids:1})
//   [COUPON] https://apidocs.chargebee.com/docs/api/coupons/create-a-coupon-for-items.md
//   [LIST]   GET /coupons in [SPEC] (limit 1..100, offset/next_offset)
//   [HOSTED] https://apidocs.chargebee.com/docs/api/hosted_pages/create-checkout-for-a-new-subscription.md
//   [WHE]    https://apidocs.chargebee.com/docs/api/webhook_endpoints/create-a-webhook-endpoint.md
//   [EVENTS] https://apidocs.chargebee.com/docs/api/events.md ("Securing Your Webhook URL",
//            "Retries and Duplicate Handling", Sample Event)
//   [INV]    https://apidocs.chargebee.com/docs/api/invoices/invoice-object.md (discounts,
//            first_invoice, recurring, amounts "in cents")
//   [ERR]    https://apidocs.chargebee.com/docs/api/error-handling.md

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Buffer } from 'node:buffer';

vi.mock('../../lib/webhook-verify', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../lib/webhook-verify')>();
  return { ...orig, timingSafeEqual: vi.fn(orig.timingSafeEqual) };
});

import { ChargebeeProvider, normalizeChargebeeSite } from './chargebee';
import { ProviderError, ProviderAuthError, ProviderNotFoundError } from './types';
import { timingSafeEqual } from '../../lib/webhook-verify';

const fixture = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`./__fixtures__/chargebee/${name}`, import.meta.url)), 'utf8');

const API_KEY = 'test_cbKey123';
// Independent Basic-auth construction (RFC 7617): base64("user:pass").
const basic = (user: string, pass: string) =>
  'Basic ' + Buffer.from(`${user}:${pass}`, 'utf8').toString('base64');
const EXPECTED_AUTH = basic(API_KEY, ''); // [AUTH] key as username, empty password

type Call = { url: string; method: string; headers: Record<string, string>; body: string | undefined };
let calls: Call[];
let responder: (call: Call) => Response;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
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
        headers: { ...(init?.headers as Record<string, string>) },
        body: init?.body as string | undefined,
      };
      calls.push(call);
      return responder(call);
    }),
  );
  vi.mocked(timingSafeEqual).mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const provider = (env: 'live' | 'test' = 'live', siteId = 'acme') =>
  new ChargebeeProvider({ apiKey: API_KEY, siteId, environment: env });

const form = (body: string | undefined) => Object.fromEntries(new URLSearchParams(body ?? ''));

// ── construction / site handling ────────────────────────────────────────────

describe('constructor', () => {
  it('requires a site id', () => {
    expect(() => new ChargebeeProvider({ apiKey: API_KEY })).toThrow(ProviderError);
  });

  it('targets https://{site}.chargebee.com/api/v2 for live and {site}-test for test [SPEC servers][AUTH]', async () => {
    responder = () => json(200, { list: [] });
    await provider('live').listDiscounts();
    await provider('test').listDiscounts();
    await provider('test', 'acme-test').listDiscounts(); // no double suffix
    expect(calls.map((c) => new URL(c.url).origin)).toEqual([
      'https://acme.chargebee.com',
      'https://acme-test.chargebee.com',
      'https://acme-test.chargebee.com',
    ]);
  });

  it('normalizes pasted hostnames and rejects anything that is not a site name', () => {
    expect(normalizeChargebeeSite('acme')).toBe('acme');
    expect(normalizeChargebeeSite(' Acme.chargebee.com ')).toBe('acme');
    expect(normalizeChargebeeSite('https://acme-co.chargebee.com/')).toBe('acme-co');
    // Would otherwise send the API key to evil.com
    expect(normalizeChargebeeSite('evil.com/x?')).toBeNull();
    expect(normalizeChargebeeSite('evil.com#')).toBeNull();
    expect(normalizeChargebeeSite('a b')).toBeNull();
    expect(() => provider('live', 'evil.com/x?')).toThrow(/Invalid Chargebee site/);
  });

  it('does not implement listProducts (product import unsupported for Chargebee)', () => {
    expect((provider() as { listProducts?: unknown }).listProducts).toBeUndefined();
  });
});

// ── createDiscount ──────────────────────────────────────────────────────────

describe('createDiscount', () => {
  it('POSTs a form-encoded PC2 coupon with Basic auth [COUPON][SDK]', async () => {
    responder = () =>
      json(200, {
        coupon: { id: 'PPP-IN40-K7QX', discount_type: 'percentage', discount_percentage: 40, status: 'active' },
      });
    const out = await provider().createDiscount({
      name: 'PPP IN 40%',
      code: 'PPP-IN40-K7QX',
      discountType: 'percentage',
      amount: 40,
    });

    expect(calls).toHaveLength(1);
    const c = calls[0]!;
    expect(c.method).toBe('POST');
    expect(c.url).toBe('https://acme.chargebee.com/api/v2/coupons/create_for_items');
    expect(c.headers.Authorization).toBe(EXPECTED_AUTH);
    expect(c.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    expect(c.headers.Accept).toBe('application/json');
    expect(form(c.body)).toEqual({
      id: 'PPP-IN40-K7QX', // [COUPON] required, max 100 chars
      name: 'PPP IN 40%', // [COUPON] required, max 50 chars
      discount_type: 'percentage',
      discount_percentage: '40', // double 0.01..100
      apply_on: 'invoice_amount', // required
      duration_type: 'forever',
      meta_data: '{"gopaylocal":"true"}', // jsonobject → ONE JSON field [SDK jsonKeys meta_data:0]
    });
    expect(out).toEqual({
      providerDiscountId: 'PPP-IN40-K7QX',
      code: 'PPP-IN40-K7QX',
      discountPercent: 40,
      provider: 'chargebee',
    });
  });

  it('regression: never sends bracketed meta_data[...] keys', async () => {
    responder = () => json(200, { coupon: { id: 'X', discount_type: 'percentage' } });
    await provider().createDiscount({ name: 'n', code: 'X', discountType: 'percentage', amount: 10 });
    expect(calls[0]!.body).not.toMatch(/meta_data%5B|meta_data\[/);
  });

  it('encodes item restriction as item_constraints with a JSON-array item_price_ids [COUPON][SDK]', async () => {
    responder = () => json(200, { coupon: { id: 'X', discount_type: 'percentage' } });
    await provider().createDiscount({
      name: 'n',
      code: 'X',
      discountType: 'percentage',
      amount: 25,
      productIds: ['basic-USD-monthly', 'pro-USD-monthly'],
    });
    const f = form(calls[0]!.body);
    expect(f.apply_on).toBe('each_specified_item');
    expect(f['item_constraints[constraint][0]']).toBe('specific');
    expect(f['item_constraints[item_type][0]']).toBe('plan');
    expect(f['item_constraints[item_price_ids][0]']).toBe('["basic-USD-monthly","pro-USD-monthly"]');
    expect(Object.keys(f).some((k) => k.startsWith('plan_ids'))).toBe(false); // PC1 param
  });

  it('fixed amounts are integer minor units with an uppercase currency; expiry is unix seconds', async () => {
    responder = () => json(200, { coupon: { id: 'X', discount_type: 'fixed_amount' } });
    const out = await provider().createDiscount({
      name: 'n',
      code: 'X',
      discountType: 'fixed',
      amount: 1250.4,
      currency: 'usd',
      maxRedemptions: 5,
      expiresAt: '2027-01-01T00:00:00.000Z',
    });
    const f = form(calls[0]!.body);
    expect(f.discount_type).toBe('fixed_amount');
    expect(f.discount_amount).toBe('1250');
    expect(f.currency_code).toBe('USD');
    expect(f.max_redemptions).toBe('5');
    expect(f.valid_till).toBe('1798761600');
    expect(f.discount_percentage).toBeUndefined();
    expect(out.discountPercent).toBe(0);
  });
});

// ── deleteDiscount / listDiscounts ──────────────────────────────────────────

describe('deleteDiscount', () => {
  it('POSTs /coupons/{id}/delete with the id URL-encoded and no body [SPEC]', async () => {
    responder = () => json(200, { coupon: { id: 'PPP IN#1', status: 'archived' } });
    await provider().deleteDiscount('PPP IN#1');
    const c = calls[0]!;
    expect(c.method).toBe('POST');
    expect(c.url).toBe('https://acme.chargebee.com/api/v2/coupons/PPP%20IN%231/delete');
    expect(c.body).toBeUndefined();
    expect(c.headers.Authorization).toBe(EXPECTED_AUTH);
  });

  it('maps 404 resource_not_found to ProviderNotFoundError (statusCode 404, so deleteCoupon proceeds) [ERR]', async () => {
    responder = () =>
      json(404, { message: 'X not found', type: 'invalid_request', api_error_code: 'resource_not_found' });
    const err = await provider().deleteDiscount('X').catch((e) => e);
    expect(err).toBeInstanceOf(ProviderNotFoundError);
    expect(err.statusCode).toBe(404);
  });
});

describe('listDiscounts', () => {
  it('pages with limit=100 and next_offset; keeps only active GoPayLocal coupons [LIST]', async () => {
    const pages = [
      {
        list: [
          { coupon: { id: 'A', status: 'active', discount_percentage: 40, meta_data: { gopaylocal: 'true' } } },
          { coupon: { id: 'B', status: 'active', discount_percentage: 10 } }, // merchant's own
          { coupon: { id: 'C', status: 'archived', meta_data: { gopaylocal: 'true' } } },
        ],
        next_offset: '["1702645601000","203"]',
      },
      { list: [{ coupon: { id: 'D', status: 'active', discount_percentage: 25, meta_data: { gopaylocal: true } } }] },
    ];
    let i = 0;
    responder = () => json(200, pages[i++]);
    const out = await provider().listDiscounts();

    expect(calls.map((c) => c.method)).toEqual(['GET', 'GET']);
    expect(calls[0]!.url).toBe('https://acme.chargebee.com/api/v2/coupons?limit=100');
    const second = new URL(calls[1]!.url);
    expect(second.pathname).toBe('/api/v2/coupons');
    expect(second.searchParams.get('limit')).toBe('100');
    expect(second.searchParams.get('offset')).toBe('["1702645601000","203"]');
    expect(calls[0]!.headers['Content-Type']).toBeUndefined();
    expect(out.map((d) => [d.providerDiscountId, d.discountPercent])).toEqual([
      ['A', 40],
      ['D', 25],
    ]);
  });
});

// ── buildCheckoutUrl ────────────────────────────────────────────────────────

describe('buildCheckoutUrl', () => {
  it('creates a checkout_new_for_items hosted page and returns hosted_page.url [HOSTED]', async () => {
    responder = () =>
      json(200, { hosted_page: { id: 'hp_1', url: 'https://acme.chargebee.com/pages/v3/hp_1/', state: 'created' } });
    const url = await provider().buildCheckoutUrl({
      productId: 'pro-USD-monthly',
      discountCode: 'PPP-IN40-K7QX',
      successUrl: 'https://merchant.example/thanks',
      cancelUrl: 'https://merchant.example/cancel',
      customerEmail: 'buyer@example.com',
      metadata: { campaign: 'c_1' },
    });
    expect(url).toBe('https://acme.chargebee.com/pages/v3/hp_1/');
    const c = calls[0]!;
    expect(c.method).toBe('POST');
    expect(c.url).toBe('https://acme.chargebee.com/api/v2/hosted_pages/checkout_new_for_items');
    expect(form(c.body)).toEqual({
      'subscription_items[item_price_id][0]': 'pro-USD-monthly',
      'subscription_items[quantity][0]': '1',
      redirect_url: 'https://merchant.example/thanks',
      cancel_url: 'https://merchant.example/cancel',
      'coupon_ids[0]': 'PPP-IN40-K7QX', // coupon ids or coupon codes
      'customer[email]': 'buyer@example.com',
      pass_thru_content: '{"campaign":"c_1"}',
    });
  });

  it('regression: sends neither top-level meta_data nor subscription[meta_data] (not params of this endpoint) [SPEC]', async () => {
    responder = () => json(200, { hosted_page: { url: 'https://x' } });
    await provider().buildCheckoutUrl({ productId: 'p', successUrl: 'https://s', metadata: { a: 'b' } });
    expect(calls[0]!.body).not.toMatch(/meta_data/);
  });

  it('throws when Chargebee returns no URL', async () => {
    responder = () => json(200, { hosted_page: {} });
    await expect(provider().buildCheckoutUrl({ productId: 'p', successUrl: 'https://s' })).rejects.toThrow(
      /No checkout URL/,
    );
  });
});

// ── webhook provisioning ────────────────────────────────────────────────────

describe('provisionWebhook / deleteWebhook', () => {
  it('POSTs /webhook_endpoints with generated Basic-auth credentials and reads webhook_endpoint.id [WHE]', async () => {
    responder = () => json(200, { webhook_endpoint: { id: 'whv2_198PKVUX26UX9IvR', api_version: 'v2' } });
    const out = await provider().provisionWebhook('https://api.gopaylocal.com/v1/webhooks/chargebee/int_1');

    const c = calls[0]!;
    expect(c.method).toBe('POST');
    expect(c.url).toBe('https://acme.chargebee.com/api/v2/webhook_endpoints'); // not /webhooks
    const f = form(c.body);
    expect(f.name).toBe('GoPayLocal Redemptions');
    expect(f.name!.length).toBeLessThanOrEqual(50);
    expect(f.api_version).toBe('v2');
    expect(f.url).toBe('https://api.gopaylocal.com/v1/webhooks/chargebee/int_1');
    expect(f['enabled_events[0]']).toBe('payment_succeeded');
    expect(f.basic_auth_username).toMatch(/^gpl_[0-9a-f]{8}$/);
    expect(f.basic_auth_password).toMatch(/^[0-9a-f]{32}$/); // 128 bits

    expect(out.endpointId).toBe('whv2_198PKVUX26UX9IvR');
    expect(out.secret).toBe(`${f.basic_auth_username}:${f.basic_auth_password}`);
  });

  it('generates fresh credentials per call', async () => {
    responder = () => json(200, { webhook_endpoint: { id: 'w' } });
    const a = await provider().provisionWebhook('https://x');
    const b = await provider().provisionWebhook('https://x');
    expect(a.secret).not.toBe(b.secret);
  });

  it('fails loudly (does not store an empty endpoint id) when no webhook_endpoint is returned', async () => {
    responder = () => json(200, { webhook: { id: 'legacy-shape' } });
    await expect(provider().provisionWebhook('https://x')).rejects.toThrow(/webhook_endpoint id/);
  });

  it('turns a refusal into an actionable ProviderError, keeps auth errors as ProviderAuthError', async () => {
    responder = () =>
      json(400, { message: 'Limit reached', type: 'invalid_request', api_error_code: 'resource_limit_exhausted' });
    const err = await provider().provisionWebhook('https://x').catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.operation).toBe('provisionWebhook');
    expect(err.message).toMatch(/fewer than 5 webhook endpoints/);
    expect(err.statusCode).toBe(400);
    expect(err.providerErrorCode).toBe('resource_limit_exhausted');

    responder = () => json(401, { message: 'Sorry, authentication failed', api_error_code: 'api_authentication_failed' });
    await expect(provider().provisionWebhook('https://x')).rejects.toBeInstanceOf(ProviderAuthError);
  });

  it('deletes via POST /webhook_endpoints/{id}/delete; no-op without an id', async () => {
    responder = () => json(200, { webhook_endpoint: { id: 'whv2_1' } });
    await provider().deleteWebhook('whv2_1');
    await provider().deleteWebhook('');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.url).toBe('https://acme.chargebee.com/api/v2/webhook_endpoints/whv2_1/delete');
  });
});

// ── verifyWebhook (HTTP Basic Auth) ─────────────────────────────────────────

describe('verifyWebhook', () => {
  const user = 'gpl_1a2b3c4d';
  const pass = '00112233445566778899aabbccddeeff';
  const secret = `${user}:${pass}`;
  const rawBody = fixture('payment_succeeded_coupon.json');
  const verify = (headers: Record<string, string>, s: string | null = secret, body = rawBody) =>
    provider().verifyWebhook({ rawBody: body, headers: new Headers(headers), secret: s });

  it('accepts the Basic credentials Chargebee sends (independently encoded) [EVENTS]', async () => {
    expect(await verify({ Authorization: basic(user, pass) })).toBe(true);
    // scheme name is case-insensitive (RFC 7617)
    expect(await verify({ authorization: basic(user, pass).replace('Basic', 'basic') })).toBe(true);
  });

  it('compares credentials with the constant-time helper', async () => {
    await verify({ Authorization: basic(user, pass) });
    expect(timingSafeEqual).toHaveBeenCalledWith(secret, secret);
  });

  it('rejects wrong password, wrong username, missing header, other schemes, malformed base64, no stored secret', async () => {
    expect(await verify({ Authorization: basic(user, pass.replace('f', 'e')) })).toBe(false);
    expect(await verify({ Authorization: basic('gpl_ffffffff', pass) })).toBe(false);
    expect(await verify({})).toBe(false);
    expect(await verify({ Authorization: `Bearer ${pass}` })).toBe(false);
    expect(await verify({ Authorization: 'Basic %%%not-base64%%%' })).toBe(false);
    expect(await verify({ Authorization: 'Basic ' })).toBe(false);
    expect(await verify({ Authorization: basic(user, pass) }, null)).toBe(false);
    expect(await verify({ Authorization: basic(user, pass) }, '')).toBe(false);
  });

  it('is body-independent: Basic auth carries no body signature (documented limitation) [EVENTS]', async () => {
    // Chargebee does not sign payloads, so a tampered body with valid credentials
    // still authenticates. Integrity can only be re-checked by retrieving the
    // event via the API (events.md "Retrieve an Event").
    expect(await verify({ Authorization: basic(user, pass) }, secret, rawBody.replace('7000', '1'))).toBe(true);
  });
});

// ── parseRedemption ─────────────────────────────────────────────────────────

describe('parseRedemption', () => {
  const base = () => JSON.parse(fixture('payment_succeeded_coupon.json'));
  const parse = (evt: unknown) => provider().parseRedemption(JSON.stringify(evt));

  it('reads the coupon id, discount and charged amounts (minor units) from payment_succeeded [INV]', () => {
    expect(provider().parseRedemption(fixture('payment_succeeded_coupon.json'))).toEqual({
      eventId: 'ev_16BPgETyVrQbiGhB', // dedupe on event id [EVENTS]
      code: null, // plain coupon: no coupon_set_code
      providerCouponId: 'PPP-IN40-K7QX', // discounts[].entity_id = coupon id
      providerPromoCodeId: null,
      chargedAmountCents: 7000, // invoice.total, in cents
      taxAmountCents: null, // the fixture invoice carries no `tax` attribute: unknown
      discountAmountCents: 4667, // discounts[].amount, in cents (tax_exclusive invoice)
      currency: 'INR',
    });
  });

  it('reports the invoice tax as contained in the invoice total (C3)', () => {
    const evt = base();
    evt.content.invoice.total = 8260;
    evt.content.invoice.tax = 1260;
    const r = parse(evt)!;
    expect([r.chargedAmountCents, r.taxAmountCents, r.discountAmountCents]).toEqual([8260, 1260, 4667]);
  });

  it('does not report discount amounts from a tax_inclusive invoice (they contain tax) [INV price_type]', () => {
    const evt = base();
    evt.content.invoice.price_type = 'tax_inclusive';
    evt.content.invoice.tax = 1068;
    evt.content.invoice.discounts.push({ ...evt.content.invoice.discounts[0], entity_id: 'MERCHANT10', amount: 500 });
    const r = parse(evt)!;
    expect(r.discountAmountCents).toBeNull();
    expect(r.taxAmountCents).toBe(1068);
    expect(r.otherDiscounts).toEqual([
      { code: null, providerCouponId: 'MERCHANT10', providerPromoCodeId: null, discountAmountCents: null },
    ]);
  });

  it('returns null for a payment with no coupon', () => {
    const evt = base();
    evt.content.invoice.discounts = [];
    expect(parse(evt)).toBeNull();
    delete evt.content.invoice.discounts;
    expect(parse(evt)).toBeNull();
  });

  it('returns null for unrelated events and junk', () => {
    expect(provider().parseRedemption(fixture('subscription_created.json'))).toBeNull();
    expect(provider().parseRedemption('not json')).toBeNull();
    expect(parse({ event_type: 'payment_succeeded' })).toBeNull();
  });

  it('does NOT count a subscription renewal (recurring invoice that is not first_invoice) [INV]', () => {
    const evt = base();
    evt.content.invoice.first_invoice = false;
    expect(parse(evt)).toBeNull();
    delete evt.content.invoice.first_invoice; // attribute is optional: absent ≠ first
    expect(parse(evt)).toBeNull();
  });

  it('counts a coupon on a non-recurring (one-off) invoice', () => {
    const evt = base();
    evt.content.invoice.recurring = false;
    delete evt.content.invoice.first_invoice;
    expect(parse(evt)?.providerCouponId).toBe('PPP-IN40-K7QX');
  });

  it('ignores non-coupon deductions and prefers the document-level (invoice_amount) coupon; sums its per-line entries', () => {
    const evt = base();
    evt.content.invoice.discounts = [
      { amount: 500, entity_type: 'promotional_credits', entity_id: 'pc_1' },
      { amount: 300, entity_type: 'item_level_coupon', entity_id: 'MERCHANT10', line_item_id: 'li_2' },
      { amount: 4000, entity_type: 'document_level_coupon', entity_id: 'PPP-IN40-K7QX', line_item_id: 'li_1' },
      { amount: 667, entity_type: 'document_level_coupon', entity_id: 'PPP-IN40-K7QX', line_item_id: 'li_2' },
      { amount: 999, entity_type: 'document_level_discount', entity_id: 'disc_1' },
    ];
    const r = parse(evt)!;
    expect(r.providerCouponId).toBe('PPP-IN40-K7QX');
    expect(r.discountAmountCents).toBe(4667);
  });

  it('carries coupon_set_code as the code when the coupon came from a coupon set', () => {
    const evt = base();
    evt.content.invoice.discounts[0].coupon_set_code = 'SET-ABC-123';
    expect(parse(evt)?.code).toBe('SET-ABC-123');
  });

  it('passes zero-decimal currencies through unscaled (JPY amounts are whole yen) [INV "kind of currency"]', () => {
    const evt = base();
    evt.content.transaction.currency_code = 'JPY';
    evt.content.transaction.amount = 1800;
    evt.content.invoice.total = 1800;
    evt.content.invoice.currency_code = 'JPY';
    evt.content.invoice.discounts[0].amount = 1200;
    const r = parse(evt)!;
    expect([r.chargedAmountCents, r.discountAmountCents, r.currency]).toEqual([1800, 1200, 'JPY']);
  });

  it('falls back to invoice.currency_code without a transaction', () => {
    const evt = base();
    delete evt.content.transaction;
    const r = parse(evt)!;
    expect([r.chargedAmountCents, r.currency]).toEqual([7000, 'INR']);
  });

  it('falls back to transaction.amount without an invoice total, with the tax unknown', () => {
    const evt = base();
    delete evt.content.invoice.total;
    evt.content.invoice.tax = 900;
    const r = parse(evt)!;
    expect([r.chargedAmountCents, r.taxAmountCents]).toEqual([7000, null]);
  });
});

// ── error mapping ───────────────────────────────────────────────────────────

describe('error mapping [ERR]', () => {
  it('401 and 403 → ProviderAuthError', async () => {
    responder = () => json(401, { message: 'Sorry, authentication failed. Invalid api key', api_error_code: 'api_authentication_failed' });
    const e1 = await provider().listDiscounts().catch((e) => e);
    expect(e1).toBeInstanceOf(ProviderAuthError);
    expect(e1.message).toContain('Invalid api key');

    responder = () => json(403, { message: 'Sorry, Operation not permitted', api_error_code: 'api_authorization_failed' });
    await expect(provider().listDiscounts()).rejects.toBeInstanceOf(ProviderAuthError);
  });

  it('404 → ProviderNotFoundError', async () => {
    responder = () => json(404, { message: 'not found', api_error_code: 'resource_not_found' });
    await expect(provider().deleteWebhook('w')).rejects.toBeInstanceOf(ProviderNotFoundError);
  });

  it('other statuses → ProviderError with status, api_error_code and message', async () => {
    responder = () =>
      json(400, {
        message: 'id : The value PPP-IN40-K7QX is already present.',
        type: 'invalid_request',
        api_error_code: 'duplicate_entry',
        param: 'id',
      });
    const err = await provider()
      .createDiscount({ name: 'n', code: 'PPP-IN40-K7QX', discountType: 'percentage', amount: 40 })
      .catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err).not.toBeInstanceOf(ProviderAuthError);
    expect(err.statusCode).toBe(400);
    expect(err.providerErrorCode).toBe('duplicate_entry');
    expect(err.operation).toBe('POST /coupons/create_for_items');
    expect(err.message).toContain('already present');

    responder = () => json(429, {});
    const rl = await provider().listDiscounts().catch((e) => e);
    expect(rl.statusCode).toBe(429);
    expect(rl.message).toContain('HTTP 429');

    // deprecated `error_code` still surfaces when api_error_code is absent
    responder = () => json(400, { message: 'm', error_code: 'param_wrong_value' });
    expect((await provider().listDiscounts().catch((e) => e)).providerErrorCode).toBe('param_wrong_value');
  });

  it('network failures (e.g. wrong site DNS) → ProviderError, not a raw TypeError', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed'); }));
    const err = await provider().listDiscounts().catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.message).toContain('Network error');
  });
});
