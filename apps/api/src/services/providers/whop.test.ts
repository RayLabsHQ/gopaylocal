// Whop provider: request shapes, version pinning, webhook signatures and
// redemption parsing.
//
// Every expectation below comes from Whop's official docs / spec, not from the
// code under test:
//   [SPEC]  https://api.whop.com/api/v1/openapi.json (info.x-api-version-date 2026-11-17-2):
//           paths /promo_codes, /promo_codes/{id}, /checkout_configurations, /webhooks,
//           /webhooks/{id}, /accounts/me; webhooks['payment.succeeded']
//   [VER]   https://docs.whop.com/developer/api/versioning.md (header precedence, key pins,
//           changelog 2026-08-03, 2026-08-12, 2026-09-02-1, 2026-10-27-2)
//   [OVR]   https://docs.whop.com/api-reference/overview.md (auth, pagination, error body)
//   [WH]    https://docs.whop.com/developer/guides/webhooks.md (envelope, ws_ secret,
//           "Verify without an SDK", 5-minute tolerance, retries keep webhook-id)
//   [SDKWH] @whop/sdk@2.8.1 dist/esm/helpers/verifyWebhook.mjs (key = literal secret bytes)
//   [SBX]   https://docs.whop.com/developer/guides/sandbox.md
//   [PAY]   https://docs.whop.com/api-reference/payments/payment.md (Payment example, money objects)

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { WhopProvider, WHOP_API_VERSION } from './whop';
import { ProviderError, ProviderAuthError, ProviderNotFoundError } from './types';

const fixture = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`./__fixtures__/whop/${name}`, import.meta.url)), 'utf8');

const API_KEY = 'apik_test_123';
const ACCOUNT = 'biz_ABCDEFGHIJKL';
const PROD = 'https://api.whop.com/api/v1';
const SANDBOX = 'https://sandbox-api.whop.com/api/v1';

type Call = { url: string; method: string; headers: Record<string, string>; body: any };
let calls: Call[];
let responder: (call: Call) => Response;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
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
        body: init?.body === undefined ? undefined : JSON.parse(init.body as string),
      };
      calls.push(call);
      return responder(call);
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const provider = (opts: { env?: 'live' | 'test'; account?: string | null } = {}) =>
  new WhopProvider({
    apiKey: API_KEY,
    environment: opts.env ?? 'live',
    siteId: opts.account === null ? undefined : opts.account ?? ACCOUNT,
  });

const PROMO = {
  id: 'promo_xxxxxxxxxxxxxx',
  code: 'gpl_ppp-in40-k7qx',
  amount_off: 0.4,
  promo_type: 'percentage',
  currency: 'usd',
  status: 'active',
  expires_at: null,
};

// ── common request contract ─────────────────────────────────────────────────

describe('request contract', () => {
  it('sends Bearer auth and pins Api-Version-Date on every request [OVR][VER]', async () => {
    responder = (c) =>
      c.url.includes('/webhooks') && c.method === 'POST'
        ? json(200, { id: 'hook_1', webhook_secret: 'ws_abc' })
        : c.url.includes('/checkout_configurations')
          ? json(200, { id: 'ch_1', purchase_url: 'https://whop.com/checkout/ch_1/' })
          : c.method === 'GET'
            ? json(200, { data: [], page_info: { has_next_page: false, end_cursor: null } })
            : json(200, PROMO);
    const p = provider();
    await p.createDiscount({ name: 'n', code: 'PPP-IN40-K7QX', discountType: 'percentage', amount: 40 });
    await p.deleteDiscount('promo_1');
    await p.listDiscounts();
    await p.buildCheckoutUrl({ productId: 'plan_1', successUrl: 'https://s' });
    await p.provisionWebhook('https://cb');
    await p.deleteWebhook('hook_1');
    expect(calls).toHaveLength(6);
    for (const c of calls) {
      expect(c.headers.Authorization).toBe(`Bearer ${API_KEY}`);
      expect(c.headers['Api-Version-Date']).toBe('2026-11-17-2');
      expect(c.headers.Accept).toBe('application/json');
      expect(c.url.startsWith(PROD)).toBe(true);
    }
    expect(WHOP_API_VERSION).toBe('2026-11-17-2');
  });

  it('uses the sandbox API host for test-mode integrations [SBX]', async () => {
    responder = () => json(200, { data: [], page_info: { has_next_page: false } });
    await provider({ env: 'test' }).listDiscounts();
    expect(calls[0]!.url.startsWith(`${SANDBOX}/promo_codes?`)).toBe(true);
  });

  it('does not implement listProducts (product import unsupported for Whop)', () => {
    expect((provider() as { listProducts?: unknown }).listProducts).toBeUndefined();
  });
});

// ── createDiscount ──────────────────────────────────────────────────────────

describe('createDiscount', () => {
  it('POSTs /promo_codes with account_id and the required fields [SPEC createPromoCode][VER 2026-08-03]', async () => {
    responder = () => json(200, PROMO);
    const out = await provider().createDiscount({
      name: 'PPP IN 40%',
      code: 'PPP-IN40-K7QX',
      discountType: 'percentage',
      amount: 40,
    });
    const c = calls[0]!;
    expect(c.method).toBe('POST');
    expect(c.url).toBe(`${PROD}/promo_codes`);
    expect(c.headers['Content-Type']).toBe('application/json');
    expect(c.body).toEqual({
      // required: account_id, amount_off, base_currency, code, new_users_only,
      //           promo_duration_months, promo_type
      account_id: ACCOUNT,
      amount_off: 40,
      base_currency: 'usd',
      code: 'GPL_PPP-IN40-K7QX',
      new_users_only: false,
      promo_duration_months: 0,
      promo_type: 'percentage',
      // optional, stated explicitly
      one_per_customer: false,
      churned_users_only: false,
      existing_memberships_only: false,
      expires_at: null,
      unlimited_stock: true,
    });
    expect(c.body).not.toHaveProperty('company_id'); // pre-2026-08-03 name
    expect(out).toEqual({
      providerDiscountId: 'promo_xxxxxxxxxxxxxx',
      code: 'gpl_ppp-in40-k7qx', // Whop's stored code is what customers type
      discountPercent: 40,
      provider: 'whop',
    });
  });

  it('scopes with variant_ids (not plan_ids), caps with stock, converts fixed cents to major units [SPEC][VER 2026-10-27-2]', async () => {
    responder = () => json(200, { ...PROMO, promo_type: 'flat_amount', amount_off: 12.5 });
    const out = await provider().createDiscount({
      name: 'n',
      code: 'GPL_ALREADY',
      discountType: 'fixed',
      amount: 1250,
      currency: 'EUR',
      productIds: ['plan_a', 'plan_b'],
      maxRedemptions: 10,
      expiresAt: '2027-01-01T00:00:00.000Z',
    });
    const b = calls[0]!.body;
    expect(b.code).toBe('GPL_ALREADY'); // prefix not doubled
    expect(b.promo_type).toBe('flat_amount');
    expect(b.amount_off).toBe(12.5);
    expect(b.base_currency).toBe('eur');
    expect(b.variant_ids).toEqual(['plan_a', 'plan_b']);
    expect(b).not.toHaveProperty('plan_ids');
    expect(b.stock).toBe(10);
    expect(b.unlimited_stock).toBe(false);
    expect(b.expires_at).toBe('2027-01-01T00:00:00.000Z');
    expect(out.discountPercent).toBe(0);
  });

  it('converts fixed minor units with the currency\'s own precision (JPY 0, KWD 3 decimals)', async () => {
    responder = () => json(200, { ...PROMO, promo_type: 'flat_amount' });
    const p = provider();
    await p.createDiscount({ name: 'n', code: 'A', discountType: 'fixed', amount: 500, currency: 'JPY' });
    await p.createDiscount({ name: 'n', code: 'B', discountType: 'fixed', amount: 1250, currency: 'KWD' });
    await p.createDiscount({ name: 'n', code: 'C', discountType: 'fixed', amount: 1250, currency: 'usd' });
    expect(calls.map((c) => [c.body.base_currency, c.body.amount_off])).toEqual([
      ['jpy', 500],
      ['kwd', 1.25],
      ['usd', 12.5],
    ]);
  });

  it('looks up the account via GET /accounts/me once when no account id is configured [SPEC /accounts/me]', async () => {
    responder = (c) => (c.url.endsWith('/accounts/me') ? json(200, { id: 'biz_LOOKEDUP' }) : json(200, PROMO));
    const p = provider({ account: null });
    await p.createDiscount({ name: 'n', code: 'A', discountType: 'percentage', amount: 10 });
    await p.createDiscount({ name: 'n', code: 'B', discountType: 'percentage', amount: 10 });
    expect(calls.map((c) => `${c.method} ${c.url.replace(PROD, '')}`)).toEqual([
      'GET /accounts/me',
      'POST /promo_codes',
      'POST /promo_codes',
    ]);
    expect(calls[1]!.body.account_id).toBe('biz_LOOKEDUP');
    expect(calls[2]!.body.account_id).toBe('biz_LOOKEDUP');
  });

  it('explains what to do when the account id is missing and cannot be looked up', async () => {
    responder = () => json(403, { error: { type: 'forbidden', message: 'Missing permission company:balance:read' } });
    const err = await provider({ account: null })
      .createDiscount({ name: 'n', code: 'A', discountType: 'percentage', amount: 10 })
      .catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err).not.toBeInstanceOf(ProviderAuthError); // not "check your API key"
    expect(err.message).toMatch(/Add the account id to the integration/);
    expect(err.statusCode).toBe(401); // ProviderAuthError's status is carried through
  });
});

// ── deleteDiscount / listDiscounts ──────────────────────────────────────────

describe('deleteDiscount', () => {
  it('DELETEs /promo_codes/{id} without a body [SPEC]', async () => {
    responder = () => json(200, { id: 'promo_1', deleted: true });
    await provider().deleteDiscount('promo_1');
    expect(calls[0]!.method).toBe('DELETE');
    expect(calls[0]!.url).toBe(`${PROD}/promo_codes/promo_1`);
    expect(calls[0]!.body).toBeUndefined();
    expect(calls[0]!.headers['Content-Type']).toBeUndefined();
  });
});

describe('listDiscounts', () => {
  it('paginates with account_id/status=active/first/after; keeps only active GPL_ codes, case-insensitively [OVR][SPEC]', async () => {
    const pages = [
      {
        data: [
          { ...PROMO, id: 'promo_a', code: 'gpl_ppp-in40-k7qx', amount_off: 0.4 },
          { ...PROMO, id: 'promo_b', code: 'summer25', amount_off: 0.25 },
          { ...PROMO, id: 'promo_c', code: null },
          // DELETE only archives; archived/inactive codes must not look live
          { ...PROMO, id: 'promo_arch', code: 'gpl_ppp-mx30-aaaa', status: 'archived' },
          { ...PROMO, id: 'promo_inact', code: 'gpl_ppp-co30-bbbb', status: 'inactive' },
        ],
        page_info: { has_next_page: true, end_cursor: 'WyJjdXJzb3IiLDFd' },
      },
      {
        data: [{ ...PROMO, id: 'promo_d', code: 'GPL_PPP-BR35-ZZZZ', amount_off: 0.35 }],
        page_info: { has_next_page: false, end_cursor: 'WyJjdXJzb3IiLDJd' },
      },
    ];
    let i = 0;
    responder = () => json(200, pages[i++]);
    const out = await provider().listDiscounts();

    expect(calls).toHaveLength(2);
    const q1 = new URL(calls[0]!.url);
    expect(q1.origin + q1.pathname).toBe(`${PROD}/promo_codes`);
    // status=active: documented filter (enum active|inactive|archived|expired)
    expect(Object.fromEntries(q1.searchParams)).toEqual({ account_id: ACCOUNT, status: 'active', first: '50' });
    const q2 = new URL(calls[1]!.url);
    expect(Object.fromEntries(q2.searchParams)).toEqual({
      account_id: ACCOUNT,
      status: 'active',
      first: '50',
      after: 'WyJjdXJzb3IiLDFd',
    });
    // amount_off is read back as a decimal fraction
    expect(out.map((d) => [d.providerDiscountId, d.discountPercent])).toEqual([
      ['promo_a', 40],
      ['promo_d', 35],
    ]);
  });
});

// ── buildCheckoutUrl ────────────────────────────────────────────────────────

describe('buildCheckoutUrl', () => {
  it('POSTs /checkout_configurations with variant_id + mode and returns purchase_url [SPEC][VER 2026-10-27-2]', async () => {
    responder = () => json(200, { id: 'ch_xxxxxxxxxxxxxx', purchase_url: 'https://whop.com/checkout/ch_xxxxxxxxxxxxxx/' });
    const url = await provider().buildCheckoutUrl({
      productId: 'plan_xxxxxxxxxxxxxx',
      successUrl: 'https://merchant.example/thanks',
      discountCode: 'gpl_ppp-in40-k7qx',
      customerEmail: 'b@example.com',
      metadata: { campaign: 'c_1' },
    });
    const c = calls[0]!;
    expect(c.method).toBe('POST');
    expect(c.url).toBe(`${PROD}/checkout_configurations`);
    expect(c.body).toEqual({
      variant_id: 'plan_xxxxxxxxxxxxxx',
      mode: 'payment',
      account_id: ACCOUNT,
      redirect_url: 'https://merchant.example/thanks',
      metadata: { campaign: 'c_1' },
    });
    expect(c.body).not.toHaveProperty('plan_id');
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe('https://whop.com/checkout/ch_xxxxxxxxxxxxxx/');
    expect(u.searchParams.get('promoCode')).toBe('gpl_ppp-in40-k7qx'); // UNVERIFIED param
    expect(u.searchParams.get('email')).toBe('b@example.com');
  });

  it('resolves a relative purchase_url against the environment origin', async () => {
    responder = () => json(200, { id: 'ch_1', purchase_url: '/checkout/ch_1/' });
    expect(await provider({ env: 'test' }).buildCheckoutUrl({ productId: 'plan_1', successUrl: 'https://s' })).toBe(
      'https://sandbox.whop.com/checkout/ch_1/',
    );
  });

  it('surfaces API failures instead of returning a guessed URL', async () => {
    responder = () => json(400, { error: { type: 'invalid_parameters', message: 'variant_id is invalid' } });
    await expect(provider().buildCheckoutUrl({ productId: 'plan_x', successUrl: 'https://s' })).rejects.toThrow(
      /variant_id is invalid/,
    );
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed'); }));
    await expect(provider().buildCheckoutUrl({ productId: 'plan_x', successUrl: 'https://s' })).rejects.toBeInstanceOf(
      ProviderError,
    );
  });
});

// ── webhook provisioning ────────────────────────────────────────────────────

describe('provisionWebhook / deleteWebhook', () => {
  it('POSTs /webhooks pinned with api_version_date (no api_version) and returns webhook_secret [SPEC][VER 2026-08-12][WH]', async () => {
    responder = () =>
      json(200, {
        id: 'hook_xxxxxxxxxxxxxx',
        api_version: 'v1',
        api_version_date: '2026-11-17-2',
        resource_id: ACCOUNT,
        webhook_secret: 'ws_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
        // regression: a `secret` field must not be read
        secret: 'WRONG',
      });
    const out = await provider().provisionWebhook('https://api.gopaylocal.com/v1/webhooks/whop/int_1');
    const c = calls[0]!;
    expect(c.method).toBe('POST');
    expect(c.url).toBe(`${PROD}/webhooks`);
    expect(c.body).toEqual({
      url: 'https://api.gopaylocal.com/v1/webhooks/whop/int_1',
      events: ['payment.succeeded'],
      api_version_date: '2026-11-17-2',
      title: 'GoPayLocal Redemptions',
      resource_id: ACCOUNT,
    });
    expect(c.body).not.toHaveProperty('api_version'); // 400 since 2026-08-12
    expect(out).toEqual({
      endpointId: 'hook_xxxxxxxxxxxxxx',
      secret: 'ws_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    });
  });

  it('omits resource_id when no account id is configured (defaults to the key\'s account)', async () => {
    responder = () => json(200, { id: 'hook_1', webhook_secret: 'ws_x' });
    await provider({ account: null }).provisionWebhook('https://cb');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body).not.toHaveProperty('resource_id');
  });

  it('deletes the endpoint and throws when no webhook_secret comes back', async () => {
    responder = (c) => (c.method === 'POST' ? json(200, { id: 'hook_1', webhook_secret: null }) : json(200, { id: 'hook_1', deleted: true }));
    await expect(provider().provisionWebhook('https://cb')).rejects.toThrow(/webhook_secret/);
    expect(calls.map((c) => `${c.method} ${c.url.replace(PROD, '')}`)).toEqual(['POST /webhooks', 'DELETE /webhooks/hook_1']);
  });

  it('DELETEs /webhooks/{id}; no-op without an id', async () => {
    responder = () => json(200, { id: 'hook_1', deleted: true });
    await provider().deleteWebhook('hook_1');
    await provider().deleteWebhook('');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe('DELETE');
    expect(calls[0]!.url).toBe(`${PROD}/webhooks/hook_1`);
  });
});

// ── verifyWebhook ───────────────────────────────────────────────────────────

describe('verifyWebhook (Standard Webhooks, key = literal ws_ secret bytes)', () => {
  const SECRET = 'ws_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  const rawBody = fixture('payment_succeeded_promo.json');
  const msgId = 'msg_bQPHmO2eBnHYtWWuxAN9K3Xd';
  const now = () => Math.floor(Date.now() / 1000);

  // Independent implementation of [WH] "Verify without an SDK" + [SDKWH]:
  // HMAC-SHA256 keyed with the secret's literal UTF-8 bytes over
  // `${id}.${ts}.${body}`, base64, header `v1,<sig>`.
  const sign = (secret: string, id: string, ts: number, body: string) =>
    'v1,' + createHmac('sha256', Buffer.from(secret, 'utf8')).update(`${id}.${ts}.${body}`).digest('base64');

  const verify = (
    headers: Record<string, string>,
    opts: { secret?: string | null; body?: string; account?: string | null } = {},
  ) =>
    provider({ account: opts.account }).verifyWebhook({
      rawBody: opts.body ?? rawBody,
      headers: new Headers(headers),
      secret: opts.secret === undefined ? SECRET : opts.secret,
    });

  const headersFor = (ts = now(), secret = SECRET, body = rawBody) => ({
    'webhook-id': msgId,
    'webhook-timestamp': String(ts),
    'webhook-signature': sign(secret, msgId, ts, body),
  });

  it('accepts a delivery signed with the literal secret bytes', async () => {
    expect(await verify(headersFor())).toBe(true);
  });

  it('works without a configured account id (verification never needs it)', async () => {
    expect(await verify(headersFor(), { account: null })).toBe(true);
  });

  it('accepts when one of several space-separated signatures matches (secret rotation)', async () => {
    const h = headersFor();
    h['webhook-signature'] = `v1,AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA= ${h['webhook-signature']}`;
    expect(await verify(h)).toBe(true);
  });

  it('rejects a signature made by base64-decoding the secret (the old whsec assumption)', async () => {
    const ts = now();
    // what a whsec-style verifier would expect: key = base64decode(secret sans prefix)
    const wrongKey = Buffer.from(SECRET.slice(3), 'base64');
    const sig = 'v1,' + createHmac('sha256', wrongKey).update(`${msgId}.${ts}.${rawBody}`).digest('base64');
    expect(
      await verify({ 'webhook-id': msgId, 'webhook-timestamp': String(ts), 'webhook-signature': sig }),
    ).toBe(false);
  });

  it('rejects tampered body, wrong secret, and changed webhook-id', async () => {
    expect(await verify(headersFor(), { body: rawBody.replace('32.40', '0.01') })).toBe(false);
    expect(await verify(headersFor(now(), 'ws_ffff'))).toBe(false);
    expect(await verify({ ...headersFor(), 'webhook-id': 'msg_other' })).toBe(false);
  });

  it('rejects missing or malformed headers and a missing stored secret', async () => {
    const h = headersFor();
    for (const k of ['webhook-id', 'webhook-timestamp', 'webhook-signature'] as const) {
      const partial: Record<string, string> = { ...h };
      delete partial[k];
      expect(await verify(partial)).toBe(false);
    }
    expect(await verify({ ...h, 'webhook-signature': 'v1,not base64!!' })).toBe(false);
    expect(await verify({ ...h, 'webhook-signature': '' })).toBe(false);
    expect(await verify({ ...h, 'webhook-timestamp': 'yesterday' })).toBe(false);
    expect(await verify(h, { secret: null })).toBe(false);
    expect(await verify(h, { secret: '' })).toBe(false);
  });

  it('enforces the 5-minute timestamp tolerance [WH]', async () => {
    expect(await verify(headersFor(now() - 240))).toBe(true);
    expect(await verify(headersFor(now() - 360))).toBe(false);
    expect(await verify(headersFor(now() + 360))).toBe(false);
  });
});

// ── parseRedemption ─────────────────────────────────────────────────────────

describe('parseRedemption', () => {
  const base = () => JSON.parse(fixture('payment_succeeded_promo.json'));
  const parse = (evt: unknown) => provider().parseRedemption(JSON.stringify(evt));

  it('reads promo_code_id and converts money objects to minor units [SPEC payment.succeeded][PAY]', () => {
    expect(provider().parseRedemption(fixture('payment_succeeded_promo.json'))).toEqual({
      eventId: 'pay_xxxxxxxxxxxxxx',
      code: null, // pinned payload carries only the id
      providerCouponId: 'promo_xxxxxxxxxxxxxx',
      providerPromoCodeId: 'promo_xxxxxxxxxxxxxx',
      chargedAmountCents: 3240, // total "32.40", decimals 2
      taxAmountCents: 240, // tax_amount "2.40" (exclusive: on top, so inside total)
      discountAmountCents: 2000, // subtotal 50.00 − (total 32.40 − exclusive tax 2.40)
      currency: 'USD',
    });
  });

  it('regression: never reads a non-existent data.amount', () => {
    const evt = base();
    evt.data.amount = 999999;
    expect(parse(evt)!.chargedAmountCents).toBe(3240);
  });

  it('inclusive tax: reports the tax inside total, but no discount (the docs do not say whether subtotal holds tax)', () => {
    const evt = base();
    evt.data.tax_behavior = 'inclusive';
    evt.data.total.amount = '30.00';
    const r = parse(evt)!;
    expect([r.chargedAmountCents, r.taxAmountCents, r.discountAmountCents]).toEqual([3000, 240, null]);
  });

  it('no tax (tax_amount null, "Null when no tax applied"): tax 0 and discount = subtotal − total', () => {
    const evt = base();
    evt.data.tax_amount = null;
    evt.data.tax_behavior = null;
    evt.data.total.amount = '30.00';
    const r = parse(evt)!;
    expect([r.taxAmountCents, r.discountAmountCents]).toEqual([0, 2000]);
  });

  it('uses the stated decimals (zero-decimal JPY)', () => {
    const jpy = base();
    for (const k of ['subtotal', 'total', 'tax_amount'] as const) {
      jpy.data[k].currency = 'jpy';
      jpy.data[k].decimals = 0;
    }
    jpy.data.subtotal.amount = '5000';
    jpy.data.tax_amount.amount = '0';
    jpy.data.total.amount = '3000';
    jpy.data.currency = 'jpy';
    const r = parse(jpy)!;
    expect([r.chargedAmountCents, r.discountAmountCents, r.currency]).toEqual([3000, 2000, 'JPY']);
  });

  it('returns null for a payment with no promo code', () => {
    const evt = base();
    evt.data.promo_code_id = null;
    expect(parse(evt)).toBeNull();
  });

  it('returns null for unrelated events and junk', () => {
    const evt = base();
    evt.type = 'membership.activated';
    expect(parse(evt)).toBeNull();
    evt.type = 'payment.failed';
    expect(parse(evt)).toBeNull();
    expect(provider().parseRedemption('{')).toBeNull();
    expect(parse({ type: 'payment.succeeded' })).toBeNull();
  });

  it('does NOT count a subscription renewal or plan change (billing_reason) [SPEC BillingReasons]', () => {
    const evt = base();
    evt.data.billing_reason = 'subscription_cycle';
    expect(parse(evt)).toBeNull();
    evt.data.billing_reason = 'subscription_update';
    expect(parse(evt)).toBeNull();
    for (const reason of ['subscription_create', 'one_time', 'manual', null]) {
      evt.data.billing_reason = reason;
      expect(parse(evt)?.providerPromoCodeId).toBe('promo_xxxxxxxxxxxxxx');
    }
  });

  it('no discount reported when subtotal equals the pre-tax total (doc Payment example) [PAY]', () => {
    const evt = base();
    evt.data.subtotal.amount = '27.99';
    evt.data.tax_amount.amount = '2.00';
    evt.data.total.amount = '29.99';
    const r = parse(evt)!;
    expect(r.discountAmountCents).toBeNull();
    expect(r.chargedAmountCents).toBe(2999);
  });

  it('still reads webhooks created before pinning (embedded promo_code, float total in dollars)', () => {
    const legacy = {
      id: 'msg_1',
      type: 'payment.succeeded',
      api_version: 'v1',
      company_id: 'biz_X',
      data: { id: 'pay_1', total: 19.99, currency: 'usd', promo_code: { id: 'promo_1', code: 'GPL_PPP-IN40-K7QX' } },
    };
    expect(parse(legacy)).toEqual({
      eventId: 'pay_1',
      code: 'GPL_PPP-IN40-K7QX',
      providerCouponId: 'promo_1',
      providerPromoCodeId: 'promo_1',
      chargedAmountCents: 1999,
      taxAmountCents: null, // the float shape carries no tax information
      discountAmountCents: null,
      currency: 'USD',
    });
  });
});

// ── error mapping ───────────────────────────────────────────────────────────

describe('error mapping [OVR]', () => {
  it('401 and 403 → ProviderAuthError with Whop\'s message', async () => {
    responder = () => json(401, { error: { type: 'unauthorized', message: 'Invalid API key' } });
    const e = await provider().deleteDiscount('promo_1').catch((x) => x);
    expect(e).toBeInstanceOf(ProviderAuthError);
    expect(e.message).toContain('Invalid API key');
    responder = () => json(403, { error: { type: 'forbidden', message: 'Missing promo_code:delete' } });
    await expect(provider().deleteDiscount('promo_1')).rejects.toBeInstanceOf(ProviderAuthError);
  });

  it('404 → ProviderNotFoundError (statusCode 404)', async () => {
    responder = () => json(404, { error: { type: 'not_found', message: 'Promo code not found' } });
    const e = await provider().deleteDiscount('promo_1').catch((x) => x);
    expect(e).toBeInstanceOf(ProviderNotFoundError);
    expect(e.statusCode).toBe(404);
  });

  it('other statuses → ProviderError with status, machine code (code ?? type) and message', async () => {
    responder = () => json(400, { error: { type: 'invalid_parameters', message: 'account_id is required' } });
    const e = await provider()
      .createDiscount({ name: 'n', code: 'A', discountType: 'percentage', amount: 10 })
      .catch((x) => x);
    expect(e).toBeInstanceOf(ProviderError);
    expect(e.statusCode).toBe(400);
    expect(e.providerErrorCode).toBe('invalid_parameters');
    expect(e.operation).toBe('POST /promo_codes');
    expect(e.message).toContain('account_id is required');

    responder = () => json(409, { error: { type: 'conflict', code: 'promo_code_taken', message: 'Code already exists' } });
    expect((await provider().createDiscount({ name: 'n', code: 'A', discountType: 'percentage', amount: 10 }).catch((x) => x)).providerErrorCode).toBe(
      'promo_code_taken',
    );

    responder = () => new Response('upstream down', { status: 502 });
    const e502 = await provider().listDiscounts().catch((x) => x);
    expect(e502.statusCode).toBe(502);
    expect(e502.message).toContain('HTTP 502');
  });
});
