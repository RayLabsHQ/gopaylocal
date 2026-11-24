// Tests for scripts/verify-provider (the live provider verification CLI).
// Lives under src/ only because the `api` vitest project includes
// src/**/*.test.ts; the code under test is in apps/api/scripts/verify-provider/.
// Nothing here touches the network: the fake provider is in-memory, the network
// guard is exercised against hosts it blocks before any DNS lookup, and the
// capture server is on 127.0.0.1.

import { readFileSync } from 'node:fs';
import tls from 'node:tls';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  CreateDiscountParams,
  PaymentProvider,
  ProviderConfig,
  ProviderDiscount,
  RedemptionEvent,
  WebhookVerifyInput,
} from '../services/providers/types';
import { ProviderAuthError, ProviderError } from '../services/providers/types';
import { DEFAULT_PERCENT, parseCliArgs } from '../../scripts/verify-provider/args';
import { captureOnce } from '../../scripts/verify-provider/capture';
import type { CaptureOptions, CapturedDelivery } from '../../scripts/verify-provider/capture';
import type { IntegrationProvider } from '@gopaylocal/shared';
import { createProvider } from '../services/providers';

// The production factory, typed the way scripts/verify-provider.ts wires it.
const productionFactory = (name: string, config: ProviderConfig) => createProvider(name as IntegrationProvider, config);
import * as verifyCode from '../../scripts/verify-provider/code';
import { generateThrowawayCode } from '../../scripts/verify-provider/code';
import * as couponCode from '../lib/coupon-code';
import { PROVIDERS_WITHOUT_TEST_MODE } from '@gopaylocal/shared/validation';
import {
  alterSecret,
  detectSignatureTimestamp,
  parseReplayFile,
  validateRedemption,
  withPinnedClock,
} from '../../scripts/verify-provider/flows';
import { main } from '../../scripts/verify-provider/main';
import type { MainDeps } from '../../scripts/verify-provider/main';
import { hostMatches, installNetworkGuard } from '../../scripts/verify-provider/network-guard';
import { PROVIDER_PROFILES, resolveAccountId } from '../../scripts/verify-provider/profiles';
import type { ProviderProfile } from '../../scripts/verify-provider/profiles';
import { StepRunner, runWithCleanup } from '../../scripts/verify-provider/runner';
import { Redactor, decideMode, hidden, mask } from '../../scripts/verify-provider/safety';
import type { ModeInput } from '../../scripts/verify-provider/safety';

// ── helpers ─────────────────────────────────────────────────────────────────

const TEST_KEY = 'sk_test_FAKE-not-a-real-key-0001';
const LIVE_KEY = 'sk_live_FAKE-not-a-real-key-0002';

function parsed(argv: string[]) {
  const r = parseCliArgs(argv);
  if (!r.ok) throw new Error(`expected ok, got: ${r.error}`);
  return r.options;
}

function parseError(argv: string[]): string {
  const r = parseCliArgs(argv);
  if (r.ok) throw new Error('expected a parse error');
  return r.error;
}

interface FakeOptions {
  name?: string;
  failOn?: Partial<Record<keyof PaymentProvider, Error>>;
  /** Pretend deleteDiscount archives: the discount stays in listDiscounts(). */
  archiveOnDelete?: boolean;
  omit?: Array<keyof PaymentProvider>;
  webhookSecret?: string | null;
  /** provisionWebhook reports it reused an existing endpoint (Gumroad). */
  adoptWebhook?: boolean;
  createPercentOverride?: number;
  verifyWebhook?: (input: WebhookVerifyInput) => Promise<boolean>;
  parseRedemption?: (rawBody: string) => RedemptionEvent | null;
  onListDiscounts?: () => Promise<void>;
}

function makeFakeProvider(opts: FakeOptions = {}) {
  const calls: string[] = [];
  const discounts = new Map<string, ProviderDiscount>();
  let seq = 0;
  const maybeFail = (m: keyof PaymentProvider) => {
    calls.push(m);
    const err = opts.failOn?.[m];
    if (err) throw err;
  };
  const provider: PaymentProvider = {
    name: opts.name ?? 'stripe',
    async createDiscount(p: CreateDiscountParams) {
      maybeFail('createDiscount');
      const d: ProviderDiscount = {
        providerDiscountId: `fake_${++seq}`,
        code: p.code,
        discountPercent: opts.createPercentOverride ?? p.amount,
        provider: 'fake',
      };
      discounts.set(d.providerDiscountId, d);
      return d;
    },
    async deleteDiscount(id: string) {
      maybeFail('deleteDiscount');
      if (!opts.archiveOnDelete) discounts.delete(id);
    },
    async listDiscounts() {
      maybeFail('listDiscounts');
      await opts.onListDiscounts?.();
      return [...discounts.values()];
    },
    async buildCheckoutUrl(p) {
      maybeFail('buildCheckoutUrl');
      return `https://checkout.example.test/pay/${p.productId}?code=${p.discountCode ?? ''}`;
    },
    async listProducts() {
      maybeFail('listProducts');
      return [{ providerProductId: 'price_1', name: 'Pro', price: 19, currency: 'usd', url: null }];
    },
    async provisionWebhook(url: string) {
      maybeFail('provisionWebhook');
      return {
        endpointId: `we_${url.length}`,
        secret: opts.webhookSecret === undefined ? 'whsec_FAKE-not-a-real-secret-0123' : opts.webhookSecret,
        ...(opts.adoptWebhook ? { adopted: true } : {}),
      };
    },
    async deleteWebhook() {
      maybeFail('deleteWebhook');
    },
    verifyWebhook: opts.verifyWebhook ?? (async (input) => input.secret === 'whsec_right'),
    parseRedemption:
      opts.parseRedemption ??
      (() => ({
        eventId: 'evt_1',
        code: 'VERIFY-ZZ17-AAAA',
        providerCouponId: 'VERIFY-ZZ17-AAAA',
        providerPromoCodeId: null,
        chargedAmountCents: 8300,
        taxAmountCents: 0,
        discountAmountCents: 1700,
        currency: 'usd',
      })),
  };
  for (const m of opts.omit ?? []) delete (provider as unknown as Record<string, unknown>)[m];
  return { provider, calls, discounts };
}

interface Harness {
  deps: MainDeps;
  stdout: string[];
  stderr: string[];
  created: Array<{ name: string; config: ProviderConfig }>;
  all: () => string;
}

function harness(env: Record<string, string | undefined>, provider?: PaymentProvider, extra: Partial<MainDeps> = {}): Harness {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const created: Harness['created'] = [];
  const deps: MainDeps = {
    env,
    createProvider: (name, config) => {
      created.push({ name, config });
      if (!provider) throw new ProviderError(name, 'init', `Unsupported provider: ${name}`);
      return provider;
    },
    stdout: (t) => stdout.push(t),
    stderr: (t) => stderr.push(t),
    readFile: async () => {
      throw new Error('no files in this test');
    },
    writeNewFile: async () => {},
    fileExists: async () => false,
    resolvePath: (p) => `/work/${p}`,
    waitForEnter: async () => {},
    onInterrupt: () => () => {},
    exit: (code) => {
      throw new Error(`exit ${code}`);
    },
    sleep: async () => {},
    now: () => Date.now(),
    commit: () => 'abc1234',
    nodeVersion: 'v24.0.0',
    randomBytes: (n) => new Uint8Array(n).fill(0), // suffix "AAAA"
    ...extra,
  };
  return { deps, stdout, stderr, created, all: () => [...stdout, ...stderr].join('\n') };
}

function jsonReport(h: Harness) {
  return JSON.parse(h.stdout.join('\n')) as {
    ok: boolean;
    refused: string | null;
    steps: Array<{ name: string; status: string; detail: string; phase: string }>;
    artifacts: Record<string, unknown>;
    summary: Record<string, number>;
  };
}

const statusOf = (report: ReturnType<typeof jsonReport>, name: string) =>
  report.steps.filter((s) => s.name === name).map((s) => s.status);

afterEach(() => {
  vi.restoreAllMocks();
});

// ── argument parsing ────────────────────────────────────────────────────────

describe('parseCliArgs', () => {
  it('defaults to a safe verify run in test mode', () => {
    const o = parsed(['stripe']);
    expect(o).toMatchObject({
      mode: 'verify',
      provider: 'stripe',
      environment: 'test',
      environmentExplicit: false,
      allowLive: false,
      keep: false,
      percent: DEFAULT_PERCENT,
      dryRun: false,
    });
  });

  it('normalizes provider names and aliases', () => {
    expect(parsed(['Stripe']).provider).toBe('stripe');
    expect(parsed(['dodo']).provider).toBe('dodopayments');
  });

  it('ignores a bare -- separator (pnpm may forward it)', () => {
    expect(parsed(['--', 'stripe']).provider).toBe('stripe');
  });

  it('requires a provider except for --capture and --help', () => {
    expect(parseError([])).toMatch(/missing provider/);
    expect(parsed(['--capture', 'out.json']).mode).toBe('capture');
    expect(parsed(['--help']).mode).toBe('help');
  });

  it('picks the mode from the mode flag and rejects combinations', () => {
    expect(parsed(['stripe', '--replay', 'd.json']).mode).toBe('replay');
    expect(parsed(['stripe', '--delete-discount', 'X']).mode).toBe('cleanup');
    expect(parseError(['stripe', '--replay', 'd.json', '--delete-webhook', 'w'])).toMatch(/separate modes/);
  });

  it('rejects flags that belong to another mode', () => {
    expect(parseError(['stripe', '--replay', 'd.json', '--product', 'p'])).toMatch(/--product not valid/);
    expect(parseError(['stripe', '--expect-none'])).toMatch(/--expect-none not valid/);
    expect(parseError(['stripe', '--port', '9000'])).toMatch(/--port not valid/);
  });

  it('validates values', () => {
    expect(parseError(['stripe', '--percent', '0'])).toMatch(/1 to 100/);
    expect(parseError(['stripe', '--percent', '12.5'])).toMatch(/whole number/);
    expect(parseError(['stripe', '--webhook-url', 'http://example.test/h'])).toMatch(/https/);
    expect(parseError(['stripe', '--environment', 'prod'])).toMatch(/'test' or 'live'/);
    expect(parseError(['stripe', '--timeout', '0'])).toMatch(/positive/);
    expect(parseError(['stripe', '--timeout', 'soon'])).toMatch(/positive/);
    expect(parseError(['stripe', '--frobnicate'])).toMatch(/Unknown option/);
    expect(parseError(['stripe', 'paddle'])).toMatch(/one provider/);
  });

  it('refuses a GoPayLocal webhook endpoint as --webhook-url (cleanup would delete it)', () => {
    expect(parseError(['gumroad', '--webhook-url', 'https://api.gopaylocal.com/v1/webhooks/gumroad/int_1'])).toMatch(/must not be a GoPayLocal webhook endpoint/);
    expect(parseError(['stripe', '--webhook-url', 'https://my-staging.example.test/v1/webhooks/stripe/x'])).toMatch(/GoPayLocal webhook endpoint/);
    expect(parsed(['stripe', '--webhook-url', 'https://abc.trycloudflare.com/hook']).webhookUrl).toBe('https://abc.trycloudflare.com/hook');
  });

  it('requires --allow-live for --environment live', () => {
    expect(parseError(['paddle', '--environment', 'live'])).toMatch(/requires --allow-live/);
    expect(parsed(['paddle', '--environment', 'live', '--allow-live'])).toMatchObject({
      environment: 'live',
      environmentExplicit: true,
      allowLive: true,
    });
  });

  it('rejects contradictory combinations', () => {
    expect(parseError(['stripe', '--keep', '--wait'])).toMatch(/alternatives/);
    expect(parseError(['stripe', '--print-secret'])).toMatch(/needs --webhook-url/);
    expect(parseError(['stripe', '--replay', 'f', '--expect-none', '--expect-code', 'X'])).toMatch(/contradict/);
  });

  it('accepts --at as unix seconds or ISO time', () => {
    expect(parsed(['stripe', '--replay', 'f', '--at', '1763400000']).at).toBe(1763400000);
    expect(parsed(['stripe', '--replay', 'f', '--at', '2025-11-17T17:20:00Z']).at).toBe(1763400000);
    expect(parseError(['stripe', '--replay', 'f', '--at', 'yesterday'])).toMatch(/--at/);
  });
});

// ── masking + redaction ─────────────────────────────────────────────────────

describe('mask', () => {
  it('hides short secrets entirely', () => {
    expect(mask('short-secret-123')).toBe('[hidden, 16 chars]');
    expect(mask('')).toBe('(not set)');
    expect(mask(undefined)).toBe('(not set)');
  });

  it('keeps only a type prefix and the last 4 characters of long secrets', () => {
    const key = `sk_test_${'x'.repeat(90)}WXYZ`;
    const m = mask(key);
    expect(m).toBe(`sk_test_…WXYZ [${key.length} chars]`);
    expect(m).not.toContain('xxxx');
  });

  it('never reveals more than a third of a secret', () => {
    for (let n = 24; n < 120; n++) {
      const s = 'a'.repeat(n);
      const visible = mask(s).split(' [')[0]!.replace('…', '').length;
      expect(visible).toBeLessThanOrEqual(Math.ceil(n / 3));
    }
  });
});

describe('hidden', () => {
  it('shows the length of a secret and no part of it', () => {
    const key = `sk_test_${'x'.repeat(90)}WXYZ`;
    expect(hidden(key)).toBe(`[hidden, ${key.length} chars]`);
    expect(hidden(undefined)).toBe('(not set)');
  });
});

describe('Redactor', () => {
  it('with hideAll, replaces a secret with its length only', () => {
    const r = new Redactor({ hideAll: true });
    const key = `sk_test_${'x'.repeat(40)}WXYZ`;
    r.add(key);
    const out = r.redact(`Invalid key ${key} provided`);
    expect(out).toBe(`Invalid key [hidden, ${key.length} chars] provided`);
    expect(out).not.toContain('sk_test_');
    expect(out).not.toContain('WXYZ');
  });

  it('with hideAll, hides a key the provider echoes partly masked, and leaves ordinary words alone', () => {
    const r = new Redactor({ hideAll: true });
    r.add(`sk_test_${'x'.repeat(40)}WXYZ`);
    r.add('ck_0123456789abcdef0123:cs_0123456789abcdef0123');
    expect(r.redact('Invalid API Key provided: sk_test_********************WXYZ.')).toBe('Invalid API Key provided: [hidden key]');
    expect(r.redact('consumer key ck_0123***def is not valid')).toBe('consumer key [hidden key] is not valid');
    // "ck_" inside a word, and the bare prefix in the tool's own messages, stay.
    expect(r.redact('stock_status is instock; expected a key starting with sk_test_ or rk_test_')).toBe(
      'stock_status is instock; expected a key starting with sk_test_ or rk_test_',
    );
  });

  it('without hideAll, a partly masked key is left as the provider printed it', () => {
    const r = new Redactor();
    r.add(`sk_test_${'x'.repeat(40)}WXYZ`);
    expect(r.redact('Invalid API Key provided: sk_test_****WXYZ')).toBe('Invalid API Key provided: sk_test_****WXYZ');
  });

  it('replaces a labelled value wherever it appears, in any letter case, and leaves very short ones alone', () => {
    const r = new Redactor();
    r.addLabel('Acme-Test', '[account id]');
    r.addLabel('abc', '[account id]');
    expect(r.redact('Hosts contacted: acme-test.chargebee.com (abc), site ACME-TEST')).toBe(
      'Hosts contacted: [account id].chargebee.com (abc), site [account id]',
    );
  });

  it('labels a store URL in every form it can be printed in', () => {
    const r = new Redactor();
    r.addAccount('https://Shop.Private-Store.example:8443/');
    const text = [
      'account id:  https://Shop.Private-Store.example:8443/ (GPL_VERIFY_STORE_URL)',
      'GET https://shop.private-store.example:8443/wp-json/wc/v3/coupons failed',
      'Hosts contacted: shop.private-store.example',
    ].join('\n');
    const out = r.redact(text);
    expect(out.toLowerCase()).not.toContain('private-store');
    expect(out).toContain('Hosts contacted: [account host]');
  });

  it('a label is plain text, not a pattern', () => {
    const r = new Redactor();
    r.addLabel('a.b+c(d)', '[account id]');
    expect(r.redact('x a.b+c(d) y aXb+c(d)')).toBe('x [account id] y aXb+c(d)');
  });

  it('replaces a secret and its URL- and base64-encoded forms', () => {
    const r = new Redactor();
    const key = 'live_key+with/specials=0123456789';
    r.add(key);
    const text = `raw ${key} url ${encodeURIComponent(key)} basic ${btoa(`${key}:`)}`;
    const out = r.redact(text);
    expect(out).not.toContain(key);
    expect(out).not.toContain(encodeURIComponent(key));
    expect(out).not.toContain(btoa(`${key}:`));
    expect(out).toContain(mask(key));
  });

  it('redacts nested values', () => {
    const r = new Redactor();
    r.add(TEST_KEY);
    const out = r.redactDeep({ a: [`x ${TEST_KEY}`], b: { c: TEST_KEY }, n: 3 });
    expect(JSON.stringify(out)).not.toContain(TEST_KEY);
    expect(out.n).toBe(3);
  });

  it('redacts each half of a key:secret pair, their encodings, and the Basic value', () => {
    const r = new Redactor();
    const ck = `ck_${'FAKE-consumer-key-'.repeat(2)}`;
    const cs = `cs_${'FAKE-consumer-secret-'.repeat(2)}`;
    r.add(`${ck}:${cs}`);
    const text = [ck, cs, encodeURIComponent(cs), btoa(ck), btoa(cs), btoa(`${ck}:${cs}`), `${ck}:${cs}`].join(' | ');
    const out = r.redact(text);
    for (const leaked of [ck, cs, btoa(ck), btoa(cs), btoa(`${ck}:${cs}`)]) expect(out).not.toContain(leaked);
    expect(out).toContain(mask(ck));
    expect(out).toContain(mask(cs));
  });

  it('ignores empty and very short values', () => {
    const r = new Redactor();
    r.add('');
    r.add('abc');
    expect(r.redact('abc stays')).toBe('abc stays');
  });
});

// ── live-mode guard ─────────────────────────────────────────────────────────

describe('decideMode', () => {
  const base = (over: Partial<ModeInput>): ModeInput => ({
    provider: 'stripe',
    profile: PROVIDER_PROFILES.stripe,
    requested: 'test',
    requestedExplicit: false,
    allowLive: false,
    ...over,
  });

  it('Stripe: a test key runs, a live key is refused without --allow-live', () => {
    expect(decideMode(base({ apiKey: TEST_KEY }))).toMatchObject({ allowed: true, effective: 'test' });
    const live = decideMode(base({ apiKey: LIVE_KEY }));
    expect(live).toMatchObject({ allowed: false, effective: 'live' });
    expect(live.refusal).toMatch(/--allow-live/);
    expect(decideMode(base({ apiKey: LIVE_KEY, allowLive: true }))).toMatchObject({ allowed: true, effective: 'live', providerEnvironment: 'live' });
  });

  it('Stripe: an unrecognised key is treated as possibly live', () => {
    expect(decideMode(base({ apiKey: 'pk_test_publishable' }))).toMatchObject({ allowed: false, effective: 'unknown' });
  });

  it('refuses a contradiction even with --allow-live', () => {
    const d = decideMode(base({ apiKey: LIVE_KEY, requestedExplicit: true, requested: 'test', allowLive: true }));
    expect(d.allowed).toBe(false);
    expect(d.refusal).toMatch(/targets TEST/);
  });

  it('environment providers: --environment decides, a contradicting key prefix is refused', () => {
    const paddle = (apiKey: string, requested: 'test' | 'live', allowLive = false) =>
      decideMode(base({ provider: 'paddle', profile: PROVIDER_PROFILES.paddle, apiKey, requested, requestedExplicit: requested === 'live', allowLive }));
    expect(paddle('pdl_sdbx_apikey_x', 'test')).toMatchObject({ allowed: true, effective: 'test', providerEnvironment: 'test' });
    expect(paddle('legacy0123456789', 'test')).toMatchObject({ allowed: true, effective: 'test' });
    expect(paddle('pdl_live_apikey_x', 'test').allowed).toBe(false);
    expect(paddle('pdl_sdbx_apikey_x', 'live', true).allowed).toBe(false);
    expect(paddle('legacy0123456789', 'live', true)).toMatchObject({ allowed: true, effective: 'live', providerEnvironment: 'live' });
    expect(paddle('legacy0123456789', 'live', false).allowed).toBe(false);
  });

  it('Chargebee: a -test site contradicts --environment live', () => {
    const cb = (accountId: string, requested: 'test' | 'live') =>
      decideMode(base({ provider: 'chargebee', profile: PROVIDER_PROFILES.chargebee, apiKey: 'k', accountId, requested, requestedExplicit: requested === 'live', allowLive: true }));
    expect(cb('acme', 'test')).toMatchObject({ allowed: true, effective: 'test' });
    expect(cb('acme-test', 'test')).toMatchObject({ allowed: true, effective: 'test' });
    expect(cb('acme-test', 'live').allowed).toBe(false);
    expect(cb('acme', 'live')).toMatchObject({ allowed: true, effective: 'live' });
  });

  it('always-live providers need --allow-live and refuse an explicit --environment test', () => {
    const g = (over: Partial<ModeInput>) =>
      decideMode(base({ provider: 'gumroad', profile: PROVIDER_PROFILES.gumroad, apiKey: 'tok', ...over }));
    expect(g({}).allowed).toBe(false);
    expect(g({ allowLive: true })).toMatchObject({ allowed: true, effective: 'live' });
    expect(g({ allowLive: true, requestedExplicit: true, requested: 'test' }).allowed).toBe(false);
  });

  it('a provider without a profile needs --allow-live', () => {
    const d = decideMode(base({ provider: 'acmepay', profile: undefined, apiKey: 'creem_test_x' }));
    expect(d).toMatchObject({ allowed: false, effective: 'unknown' });
    expect(d.refusal).toMatch(/profiles\.ts/);
    expect(decideMode(base({ provider: 'acmepay', profile: undefined, apiKey: 'x', allowLive: true })).allowed).toBe(true);
  });

  it('account-suffix rule: only a suffixed account id counts as test', () => {
    const profile: ProviderProfile = {
      displayName: 'Synthetic',
      mode: { kind: 'account-suffix', testSuffix: '-staging', source: 'n/a' },
      checkoutId: 'id',
    };
    expect(decideMode(base({ provider: 'x', profile, accountId: 'shop-staging' }))).toMatchObject({ allowed: true, effective: 'test' });
    expect(decideMode(base({ provider: 'x', profile, accountId: 'shop' }))).toMatchObject({ allowed: false, effective: 'unknown' });
  });
});

describe('resolveAccountId', () => {
  it('prefers the provider-specific variable, falls back to the generic one, flags conflicts', () => {
    const p = PROVIDER_PROFILES.chargebee;
    expect(resolveAccountId(p, { GPL_VERIFY_SITE_ID: 'acme' })).toEqual({ value: 'acme', source: 'GPL_VERIFY_SITE_ID' });
    expect(resolveAccountId(p, { GPL_VERIFY_ACCOUNT_ID: 'acme' })).toEqual({ value: 'acme', source: 'GPL_VERIFY_ACCOUNT_ID' });
    expect(resolveAccountId(p, { GPL_VERIFY_SITE_ID: 'acme', GPL_VERIFY_ACCOUNT_ID: 'other' }).conflict).toMatch(/different values/);
  });
});

// ── step runner ─────────────────────────────────────────────────────────────

describe('StepRunner', () => {
  const newRunner = (timeoutMs = 1000) => new StepRunner({ timeoutMs });

  it('turns a throw into FAIL and keeps going', async () => {
    const r = newRunner();
    const res = await r.step('boom', async () => {
      throw new ProviderAuthError('stripe', 'Invalid API Key');
    });
    expect(res.status).toBe('FAIL');
    expect(res.detail).toMatch(/ProviderAuthError: \[stripe\] auth: Invalid API Key \[HTTP 401\]/);
    expect(res.error).toMatchObject({ name: 'ProviderAuthError', statusCode: 401 });
  });

  it('runs cleanups (LIFO) after a failed step', async () => {
    const r = newRunner();
    const order: string[] = [];
    await runWithCleanup(
      r,
      async () => {
        r.defer('first', async () => void order.push('first'), 'hint1');
        r.defer('second', async () => void order.push('second'), 'hint2');
        await r.step('fails', async () => {
          throw new Error('nope');
        });
      },
      () => ({ keep: false }),
    );
    expect(order).toEqual(['second', 'first']);
  });

  it('runs cleanups even when the body itself throws (a bug, not a check)', async () => {
    const r = newRunner();
    let cleaned = false;
    await runWithCleanup(
      r,
      async () => {
        r.defer('cleanup', async () => {
          cleaned = true;
        }, 'hint');
        throw new TypeError('bug in the flow');
      },
      () => ({ keep: false }),
    );
    expect(cleaned).toBe(true);
    expect(r.results.find((x) => x.name === 'unexpected-error')?.status).toBe('FAIL');
  });

  it('a throwing cleanup is recorded and later cleanups still run', async () => {
    const r = newRunner();
    let ranOther = false;
    await runWithCleanup(
      r,
      async () => {
        r.defer('other', async () => {
          ranOther = true;
        }, 'h');
        r.defer('broken', async () => {
          throw new Error('cleanup exploded');
        }, 'h');
      },
      () => ({ keep: false }),
    );
    expect(ranOther).toBe(true);
    expect(r.results.find((x) => x.name === 'broken')).toMatchObject({ status: 'FAIL', phase: 'cleanup' });
  });

  it('with keep, records each cleanup as SKIPPED with its hint instead of running it', async () => {
    const r = newRunner();
    let ran = false;
    await runWithCleanup(
      r,
      async () => {
        r.defer('delete-discount', async () => {
          ran = true;
        }, 'delete it later with: X');
      },
      () => ({ keep: true }),
    );
    expect(ran).toBe(false);
    expect(r.results[0]).toMatchObject({ name: 'delete-discount', status: 'SKIPPED' });
    expect(r.results[0]!.detail).toContain('delete it later with: X');
  });

  it('times out a hung call as FAIL', async () => {
    const r = newRunner(20);
    const res = await r.step('hang', () => new Promise(() => {}));
    expect(res).toMatchObject({ status: 'FAIL', error: { name: 'StepTimeoutError' } });
  });

  it('after an interrupt, later main steps are BLOCKED but cleanup still runs', async () => {
    const r = newRunner();
    let cleaned = false;
    await runWithCleanup(
      r,
      async () => {
        r.defer('cleanup', async () => {
          await r.step('delete-discount', async () => {
            cleaned = true;
            return { detail: 'deleted' };
          });
        }, 'h');
        r.interrupt();
        await r.step('list-discounts', async () => ({ detail: 'should not run' }));
      },
      () => ({ keep: false }),
    );
    expect(r.results.find((x) => x.name === 'list-discounts')?.status).toBe('BLOCKED');
    expect(cleaned).toBe(true);
    expect(r.results.find((x) => x.name === 'delete-discount')).toMatchObject({ status: 'PASS', phase: 'cleanup' });
  });
});

// ── throwaway codes ─────────────────────────────────────────────────────────

describe('generateThrowawayCode', () => {
  const zeros = (n: number) => new Uint8Array(n).fill(0);

  it('matches the production code shape per provider', () => {
    expect(generateThrowawayCode('stripe', 17, zeros)).toBe('VERIFYZZ17AAAA');
    expect(generateThrowawayCode('chargebee', 17, zeros)).toBe('VERIFY-ZZ17-AAAA');
    expect(generateThrowawayCode('paddle', 17, zeros)).toBe('VERIFYZZ17AAAA');
    expect(generateThrowawayCode('polar', 17, zeros)).toBe('VERIFYZZ17AAAA');
    expect(generateThrowawayCode('dodopayments', 100, zeros)).toBe('VERIF-ZZ100-AAAA');
  });

  it('respects documented code constraints for every percent', () => {
    for (let pct = 1; pct <= 100; pct++) {
      expect(generateThrowawayCode('paddle', pct)).toMatch(/^[a-zA-Z0-9]{1,32}$/);
      expect(generateThrowawayCode('polar', pct)).toMatch(/^[A-Za-z0-9]{3,256}$/);
      expect(generateThrowawayCode('dodopayments', pct).length).toBeLessThanOrEqual(16);
      // Stripe promotion codes: a–z, A–Z, 0–9 only.
      expect(generateThrowawayCode('stripe', pct)).toMatch(/^[A-Za-z0-9]+$/);
    }
  });

  it('is random per run', () => {
    const codes = new Set(Array.from({ length: 50 }, () => generateThrowawayCode('stripe', 17)));
    expect(codes.size).toBeGreaterThan(45);
  });

  // One generator for production and the tool, so the two can't drift apart:
  // code.ts must re-export lib/coupon-code (the same objects, not copies), and
  // coupon.service.ts must use it rather than define its own rules again.
  it('uses the production generator and format rules, not a copy (drift check)', () => {
    expect(verifyCode.ALNUM_ONLY_PROVIDERS).toBe(couponCode.ALNUM_ONLY_PROVIDERS);
    expect(verifyCode.CODE_MAX_LENGTH).toBe(couponCode.CODE_MAX_LENGTH);
    expect(verifyCode.SUFFIX_CHARS).toBe(couponCode.SUFFIX_CHARS);
    expect(verifyCode.generateCouponCode).toBe(couponCode.generateCouponCode);
    expect([...couponCode.ALNUM_ONLY_PROVIDERS].sort()).toEqual(['creem', 'paddle', 'polar', 'stripe']);

    const service = readFileSync(fileURLToPath(new URL('../services/coupon.service.ts', import.meta.url)), 'utf8');
    expect(service).toMatch(/import \{ generateCouponCode \} from '\.\.\/lib\/coupon-code'/);
    expect(service).not.toMatch(/ALNUM_ONLY_PROVIDERS\s*=|CODE_MAX_LENGTH\s*[:=]|SUFFIX_CHARS\s*=|function generateCouponCode/);
  });
});

// ── end to end through main() with a fake provider ──────────────────────────

describe('main: verify run', () => {
  const env = { GPL_VERIFY_API_KEY: TEST_KEY };

  it('happy path: every check passes, the discount is deleted, the report is valid JSON', async () => {
    const fake = makeFakeProvider();
    const h = harness(env, fake.provider);
    const code = await main(['stripe', '--product', 'price_1', '--json'], h.deps);
    const report = jsonReport(h);
    expect(code).toBe(0);
    expect(report.ok).toBe(true);
    expect(report.steps.map((s) => `${s.name}:${s.status}`)).toEqual([
      'init:PASS',
      'list-products:PASS',
      'create-discount:PASS',
      'list-discounts:PASS',
      'checkout-url:PASS',
      'provision-webhook:SKIPPED',
      'delete-discount:PASS',
      'confirm-deleted:PASS',
    ]);
    expect(fake.discounts.size).toBe(0);
    expect(report.artifacts.checkoutUrl).toBe('https://checkout.example.test/pay/price_1?code=VERIFYZZ17AAAA');
    // Constructed through the factory with the connect-flow config shape.
    expect(h.created).toEqual([{ name: 'stripe', config: { apiKey: TEST_KEY, environment: 'test', siteId: undefined } }]);
  });

  it('never prints the API key, even when the provider echoes it in an error', async () => {
    const fake = makeFakeProvider({ failOn: { listProducts: new Error(`Invalid key ${TEST_KEY} provided`) } });
    const h = harness(env, fake.provider);
    await main(['stripe'], h.deps);
    const h2 = harness(env, fake.provider);
    await main(['stripe', '--json'], h2.deps);
    for (const text of [h.all(), h2.all()]) {
      expect(text).not.toContain(TEST_KEY);
      expect(text).toContain(mask(TEST_KEY));
    }
  });

  it('--public-log prints no part of the key, no product, no checkout link and no account host', async () => {
    const fake = makeFakeProvider({ name: 'woocommerce' });
    const storeEnv = { GPL_VERIFY_API_KEY: TEST_KEY, GPL_VERIFY_STORE_URL: 'https://Shop.Private-Store.example:8443/' };
    for (const flags of [['--public-log'], ['--public-log', '--json']]) {
      const h = harness(storeEnv, fake.provider);
      const code = await main(['woocommerce', '--product', 'price_1', '--allow-live', ...flags], h.deps);
      const text = h.all();
      expect(code, text).toBe(0);
      expect(text).not.toContain(TEST_KEY);
      expect(text).not.toContain(TEST_KEY.slice(-4));
      expect(text).not.toContain('sk_test_');
      expect(text).toContain(`[hidden, ${TEST_KEY.length} chars]`);
      expect(text).not.toContain('"Pro"');
      expect(text).not.toContain('19 usd');
      expect(text).not.toContain('checkout.example.test');
      expect(text.toLowerCase()).not.toContain('private-store');
      expect(text).toContain('1 product(s); --product is one of them');
    }
    const h = harness(storeEnv, fake.provider);
    await main(['woocommerce', '--product', 'price_1', '--allow-live', '--public-log', '--json'], h.deps);
    const report = jsonReport(h);
    expect(report.artifacts.checkoutUrl).toBeUndefined();
    expect(statusOf(report, 'checkout-url')).toEqual(['PASS']);
  });

  it('--public-log hides a key the provider echoes in an error, whole or partly masked', async () => {
    const fake = makeFakeProvider({
      failOn: {
        listProducts: new Error(`Invalid key ${TEST_KEY} provided`),
        createDiscount: new Error(`Invalid API Key provided: sk_test_***********${TEST_KEY.slice(-4)}`),
      },
    });
    const h = harness(env, fake.provider);
    await main(['stripe', '--public-log', '--json'], h.deps);
    expect(h.all()).not.toContain(TEST_KEY);
    expect(h.all()).not.toContain(TEST_KEY.slice(-4));
    expect(h.all()).toContain(`[hidden, ${TEST_KEY.length} chars]`);
  });

  it('cleanup still deletes the discount when a later check fails', async () => {
    const fake = makeFakeProvider({ failOn: { listDiscounts: new Error('list broke') } });
    const h = harness(env, fake.provider);
    const code = await main(['stripe', '--json'], h.deps);
    const report = jsonReport(h);
    expect(code).toBe(1);
    expect(statusOf(report, 'list-discounts')).toEqual(['FAIL']);
    expect(statusOf(report, 'delete-discount')).toEqual(['PASS']);
    expect(fake.calls).toContain('deleteDiscount');
  });

  it('a failed create blocks the presence check and deletes nothing', async () => {
    const fake = makeFakeProvider({ failOn: { createDiscount: new ProviderError('stripe', 'createDiscount', 'code invalid', 400) } });
    const h = harness(env, fake.provider);
    const code = await main(['stripe', '--json'], h.deps);
    const report = jsonReport(h);
    expect(code).toBe(1);
    expect(statusOf(report, 'create-discount')).toEqual(['FAIL']);
    expect(statusOf(report, 'list-discounts')).toEqual(['BLOCKED']);
    expect(fake.calls).not.toContain('deleteDiscount');
  });

  it('a wrong percent fails create-discount but the discount is still cleaned up', async () => {
    const fake = makeFakeProvider({ createPercentOverride: 0.17 });
    const h = harness(env, fake.provider);
    await main(['stripe', '--json'], h.deps);
    const report = jsonReport(h);
    expect(report.steps.find((s) => s.name === 'create-discount')?.detail).toMatch(/discountPercent 0.17, expected 17/);
    expect(statusOf(report, 'delete-discount')).toEqual(['PASS']);
  });

  it('reports SKIPPED for capabilities the provider lacks', async () => {
    const fake = makeFakeProvider({ omit: ['listProducts', 'provisionWebhook'] });
    const h = harness(env, fake.provider);
    await main(['stripe', '--webhook-url', 'https://hooks.example.test/h', '--json'], h.deps);
    const report = jsonReport(h);
    expect(report.steps.find((s) => s.name === 'list-products')).toMatchObject({ status: 'SKIPPED' });
    expect(report.steps.find((s) => s.name === 'provision-webhook')?.detail).toMatch(/unsupported/);
  });

  it('provisions and deletes a webhook; the secret is masked, only --print-secret shows it, never in JSON', async () => {
    const secret = 'whsec_FAKE-not-a-real-secret-0123';
    const fake = makeFakeProvider({ webhookSecret: secret });
    const h = harness(env, fake.provider);
    await main(['stripe', '--webhook-url', 'https://hooks.example.test/h', '--json'], h.deps);
    expect(h.all()).not.toContain(secret);
    expect(statusOf(jsonReport(h), 'delete-webhook')).toEqual(['PASS']);

    const h2 = harness(env, makeFakeProvider({ webhookSecret: secret }).provider);
    await main(['stripe', '--webhook-url', 'https://hooks.example.test/h', '--print-secret', '--json'], h2.deps);
    expect(h2.stdout.join('\n')).not.toContain(secret); // JSON report
    expect(h2.stderr.join('\n')).toContain(secret); // the one deliberate print
  });

  it('leaves an adopted webhook in place: cleanup only removes what the run created', async () => {
    // Before `adopted`, cleanup deleted a Gumroad subscription that existed before the run.
    const fake = makeFakeProvider({ adoptWebhook: true });
    const h = harness(env, fake.provider);
    await main(['stripe', '--webhook-url', 'https://hooks.example.test/h', '--json'], h.deps);
    const report = jsonReport(h);
    expect(report.steps.find((s) => s.name === 'provision-webhook')?.detail).toMatch(/existing endpoint reused/);
    expect(statusOf(report, 'delete-webhook')).toEqual([]);
    expect(fake.calls).not.toContain('deleteWebhook');
  });

  it('--keep leaves resources and says how to delete them', async () => {
    const fake = makeFakeProvider();
    const h = harness(env, fake.provider);
    await main(['stripe', '--keep', '--json'], h.deps);
    const report = jsonReport(h);
    expect(fake.calls).not.toContain('deleteDiscount');
    expect(report.steps.find((s) => s.name === 'delete-discount')).toMatchObject({ status: 'SKIPPED' });
    expect(report.steps.find((s) => s.name === 'delete-discount')?.detail).toContain('--delete-discount');
  });

  it('flags a discount that is still listed after deletion (archived, not deleted)', async () => {
    const fake = makeFakeProvider({ archiveOnDelete: true });
    const h = harness(env, fake.provider);
    const code = await main(['stripe', '--json'], h.deps);
    expect(code).toBe(1);
    expect(jsonReport(h).steps.find((s) => s.name === 'confirm-deleted')).toMatchObject({ status: 'FAIL' });
  });

  it('--wait pauses before cleanup', async () => {
    const fake = makeFakeProvider();
    const events: string[] = [];
    const h = harness(env, fake.provider, {
      waitForEnter: async () => {
        events.push(`wait (discounts: ${fake.discounts.size})`);
      },
    });
    await main(['stripe', '--wait'], h.deps);
    expect(events).toEqual(['wait (discounts: 1)']);
    expect(fake.discounts.size).toBe(0);
  });

  it('a Ctrl-C mid-run blocks the remaining checks and still cleans up', async () => {
    let interrupt: (() => void) | undefined;
    const fake = makeFakeProvider({
      onListDiscounts: async () => {
        interrupt?.(); // user presses Ctrl-C during list-discounts
      },
    });
    const h = harness(env, fake.provider, {
      onInterrupt: (handler) => {
        interrupt = handler;
        return () => {
          interrupt = undefined;
        };
      },
    });
    const code = await main(['stripe', '--product', 'price_1', '--json'], h.deps);
    const report = jsonReport(h);
    expect(code).toBe(130);
    expect(statusOf(report, 'checkout-url')).toEqual(['BLOCKED']);
    expect(statusOf(report, 'delete-discount')).toEqual(['PASS']);
  });

  it('the live-mode guard refuses before the provider is even constructed', async () => {
    const fake = makeFakeProvider();
    const h = harness({ GPL_VERIFY_API_KEY: LIVE_KEY }, fake.provider);
    const code = await main(['stripe', '--json'], h.deps);
    expect(code).toBe(2);
    expect(h.created).toHaveLength(0);
    expect(fake.calls).toHaveLength(0);
    expect(jsonReport(h).refused).toMatch(/LIVE/);
  });

  it('--dry-run constructs the provider but calls nothing', async () => {
    const fake = makeFakeProvider();
    const h = harness(env, fake.provider);
    const code = await main(['stripe', '--dry-run', '--product', 'price_1'], h.deps);
    expect(code).toBe(0);
    expect(h.created).toHaveLength(1);
    expect(fake.calls).toHaveLength(0);
  });

  it('missing credentials are a usage error naming the env var', async () => {
    const h = harness({}, makeFakeProvider().provider);
    expect(await main(['chargebee'], h.deps)).toBe(2);
    expect(h.stderr.join('\n')).toMatch(/GPL_VERIFY_API_KEY is not set[\s\S]*GPL_VERIFY_SITE_ID is not set/);
  });

  it('no-sandbox providers: --product is required and the discount is scoped to it', async () => {
    const env = { GPL_VERIFY_API_KEY: 'gumroad_token_FAKEFAKEFAKEFAKE' };
    const h1 = harness(env, makeFakeProvider({ name: 'gumroad' }).provider);
    expect(await main(['gumroad', '--allow-live'], h1.deps)).toBe(2);
    expect(h1.stderr.join('\n')).toMatch(/--product is required for gumroad/);

    const fake = makeFakeProvider({ name: 'gumroad' });
    const seen: CreateDiscountParams[] = [];
    const original = fake.provider.createDiscount.bind(fake.provider);
    fake.provider.createDiscount = async (p) => {
      seen.push(p);
      return original(p);
    };
    const h2 = harness(env, fake.provider);
    expect(await main(['gumroad', '--allow-live', '--product', 'prod_abc', '--json'], h2.deps)).toBe(0);
    expect(seen[0]?.productIds).toEqual(['prod_abc']);

    // Sandbox providers keep production's unscoped call.
    const stripe = makeFakeProvider();
    const seenStripe: CreateDiscountParams[] = [];
    const orig2 = stripe.provider.createDiscount.bind(stripe.provider);
    stripe.provider.createDiscount = async (p) => {
      seenStripe.push(p);
      return orig2(p);
    };
    await main(['stripe', '--product', 'price_1', '--json'], harness({ GPL_VERIFY_API_KEY: TEST_KEY }, stripe.provider).deps);
    expect(seenStripe[0]?.productIds).toBeUndefined();
  });

  it('an unregistered provider fails at init with exit 2', async () => {
    const h = harness({ GPL_VERIFY_API_KEY: 'x'.repeat(30) });
    const code = await main(['acmepay', '--allow-live', '--json'], h.deps);
    expect(code).toBe(2);
    expect(jsonReport(h).steps[0]).toMatchObject({ name: 'init', status: 'FAIL' });
  });

  it('cleanup mode deletes by id', async () => {
    const fake = makeFakeProvider();
    const h = harness(env, fake.provider);
    expect(await main(['stripe', '--delete-discount', 'VERIFY-ZZ17-AAAA', '--delete-webhook', 'we_1'], h.deps)).toBe(0);
    expect(fake.calls).toEqual(expect.arrayContaining(['deleteWebhook', 'deleteDiscount', 'listDiscounts']));
  });
});

// ── replay ──────────────────────────────────────────────────────────────────

describe('replay', () => {
  it('parseReplayFile accepts header objects and pair lists, and insists on a raw body string', () => {
    const ok = parseReplayFile(JSON.stringify({ headers: { 'Stripe-Signature': 't=1,v1=a' }, rawBody: '{}' }));
    expect(ok).toEqual({ ok: true, delivery: { headers: { 'stripe-signature': 't=1,v1=a' }, rawBody: '{}' } });
    const pairs = parseReplayFile(JSON.stringify({ headers: [['A', '1'], { name: 'B', value: '2' }], rawBody: '' }));
    expect(pairs.ok && pairs.delivery.headers).toEqual({ a: '1', b: '2' });
    const parsedBody = parseReplayFile(JSON.stringify({ headers: {}, body: { a: 1 } }));
    expect(!parsedBody.ok && parsedBody.error).toMatch(/byte-for-byte/);
    expect(parseReplayFile('not json').ok).toBe(false);
  });

  it('detects the signed timestamp of each scheme in use', () => {
    expect(detectSignatureTimestamp(new Headers({ 'webhook-timestamp': '1763400000' }))?.seconds).toBe(1763400000);
    expect(detectSignatureTimestamp(new Headers({ 'stripe-signature': 't=1763400000,v1=abc' }))?.seconds).toBe(1763400000);
    expect(detectSignatureTimestamp(new Headers({ 'paddle-signature': 'ts=1763400000;h1=abc' }))?.seconds).toBe(1763400000);
    expect(detectSignatureTimestamp(new Headers({ 'x-signature': 'abc' }))).toBeUndefined();
  });

  it('withPinnedClock pins Date.now and always restores it', async () => {
    const before = Date.now();
    await expect(
      withPinnedClock(1_000, async () => {
        expect(Date.now()).toBe(1_000);
        throw new Error('inside');
      }),
    ).rejects.toThrow('inside');
    expect(Date.now()).toBeGreaterThanOrEqual(before);
  });

  it('alterSecret changes exactly one character and keeps the format', () => {
    const s = 'whsec_FAKE-not-a-real-secret-0123';
    const w = alterSecret(s);
    expect(w).not.toBe(s);
    expect(w.length).toBe(s.length);
    expect([...w].filter((c, i) => c !== s[i])).toHaveLength(1);
  });

  it('validateRedemption catches shapes the redemption handler cannot use', () => {
    const good: RedemptionEvent = { eventId: 'e', code: 'C', providerCouponId: null, providerPromoCodeId: null, chargedAmountCents: 100, taxAmountCents: 0, discountAmountCents: null, currency: 'USD' };
    expect(validateRedemption(good)).toEqual([]);
    expect(validateRedemption({ ...good, taxAmountCents: null })).toEqual([]);
    expect(validateRedemption({ ...good, eventId: '' })).toHaveLength(1);
    expect(validateRedemption({ ...good, code: null })).toHaveLength(1);
    expect(validateRedemption({ ...good, chargedAmountCents: 83.5 })).toHaveLength(1);
    expect(validateRedemption({ ...good, currency: 'dollars' })).toHaveLength(1);
  });

  it('validateRedemption enforces contract C3: the tax inside the charged amount is stated', () => {
    const good: RedemptionEvent = { eventId: 'e', code: 'C', providerCouponId: null, providerPromoCodeId: null, chargedAmountCents: 120, taxAmountCents: 20, discountAmountCents: null, currency: 'USD' };
    expect(validateRedemption(good)).toEqual([]);
    const { taxAmountCents: _t, ...missing } = good;
    expect(validateRedemption(missing as RedemptionEvent)[0]).toContain('taxAmountCents is missing');
    expect(validateRedemption({ ...good, taxAmountCents: 150 })[0]).toContain('larger than chargedAmountCents');
    expect(validateRedemption({ ...good, taxAmountCents: 1.5 })).toHaveLength(1);
  });

  // A verifier with a real 300-second replay window, like the production ones.
  const signedAt = 1_763_400_000;
  const windowedVerifier = async (input: WebhookVerifyInput) =>
    input.secret === 'whsec_right' &&
    input.headers.get('webhook-timestamp') === String(signedAt) &&
    Math.abs(Math.floor(Date.now() / 1000) - signedAt) <= 300;

  const replayHarness = (provider: PaymentProvider, file: object, env: Record<string, string> = {}) =>
    harness(env, provider, {
      readFile: async () => JSON.stringify(file),
      now: () => (signedAt + 3 * 3600) * 1000, // replaying a 3-hour-old capture
    });

  const delivery = { headers: { 'webhook-timestamp': String(signedAt), 'webhook-id': 'msg_1' }, rawBody: '{"type":"x"}' };

  it('a stale capture verifies at its own timestamp and the wrong-secret control passes', async () => {
    const fake = makeFakeProvider({ verifyWebhook: windowedVerifier });
    const h = replayHarness(fake.provider, delivery, { GPL_VERIFY_WEBHOOK_SECRET: 'whsec_right' });
    const code = await main(['stripe', '--replay', 'd.json', '--json'], h.deps);
    const report = jsonReport(h);
    expect(code).toBe(0);
    const verify = report.steps.find((s) => s.name === 'verify-webhook')!;
    expect(verify.status).toBe('PASS');
    expect(verify.detail).toMatch(/INVALID now; valid at the delivery's timestamp/);
    expect(statusOf(report, 'reject-wrong-secret')).toEqual(['PASS']);
    expect(statusOf(report, 'parse-redemption')).toEqual(['PASS']);
    expect(h.all()).not.toContain('whsec_right');
  });

  it('a wrong secret fails verification and blocks the control', async () => {
    const fake = makeFakeProvider({ verifyWebhook: windowedVerifier });
    const h = replayHarness(fake.provider, delivery, { GPL_VERIFY_WEBHOOK_SECRET: 'whsec_wrong' });
    expect(await main(['stripe', '--replay', 'd.json', '--json'], h.deps)).toBe(1);
    const report = jsonReport(h);
    expect(statusOf(report, 'verify-webhook')).toEqual(['FAIL']);
    expect(statusOf(report, 'reject-wrong-secret')).toEqual(['BLOCKED']);
  });

  it('a verifier that accepts anything fails the wrong-secret control', async () => {
    const fake = makeFakeProvider({ verifyWebhook: async () => true });
    const h = replayHarness(fake.provider, delivery, { GPL_VERIFY_WEBHOOK_SECRET: 'whsec_right' });
    await main(['stripe', '--replay', 'd.json', '--json'], h.deps);
    expect(statusOf(jsonReport(h), 'reject-wrong-secret')).toEqual(['FAIL']);
  });

  it('skips the control for providers whose webhooks are unsigned by design', async () => {
    const fake = makeFakeProvider({ name: 'gumroad', verifyWebhook: async () => true });
    const h = replayHarness(fake.provider, delivery, {});
    await main(['gumroad', '--replay', 'd.json', '--json'], h.deps);
    expect(jsonReport(h).steps.find((s) => s.name === 'reject-wrong-secret')).toMatchObject({ status: 'SKIPPED' });
  });

  it('parse null fails unless --expect-none; --expect-code checks attribution', async () => {
    const none = makeFakeProvider({ verifyWebhook: windowedVerifier, parseRedemption: () => null });
    const env = { GPL_VERIFY_WEBHOOK_SECRET: 'whsec_right' };
    const h1 = replayHarness(none.provider, delivery, env);
    expect(await main(['stripe', '--replay', 'd.json', '--json'], h1.deps)).toBe(1);
    const h2 = replayHarness(none.provider, delivery, env);
    expect(await main(['stripe', '--replay', 'd.json', '--expect-none', '--json'], h2.deps)).toBe(0);
    const h3 = replayHarness(makeFakeProvider({ verifyWebhook: windowedVerifier }).provider, delivery, env);
    expect(await main(['stripe', '--replay', 'd.json', '--expect-code', 'OTHER-CODE', '--json'], h3.deps)).toBe(1);
    const h4 = replayHarness(makeFakeProvider({ verifyWebhook: windowedVerifier }).provider, delivery, env);
    expect(await main(['stripe', '--replay', 'd.json', '--expect-code', 'verify-zz17-aaaa', '--json'], h4.deps)).toBe(0);
  });
});

// ── network guard ───────────────────────────────────────────────────────────

describe('network guard', () => {
  it('blocks a live host before any connection is made, records hosts, restores tls.connect', () => {
    const original = tls.connect;
    const guard = installNetworkGuard({ block: ['api.paddle.com'], reason: 'test run' });
    try {
      expect(() => tls.connect({ host: 'api.paddle.com', port: 443 })).toThrow(/refused a connection to api.paddle.com/);
      expect(() => tls.connect(443, 'API.PADDLE.COM.')).toThrow(/refused/);
      expect([...guard.hosts]).toEqual(['api.paddle.com']);
      expect(guard.blocked).toEqual(['api.paddle.com', 'api.paddle.com']);
    } finally {
      guard.restore();
    }
    expect(tls.connect).toBe(original);
  });

  it('allow-only: passes the allowed host through, refuses any other and an unknown host', () => {
    const original = tls.connect;
    const reached: unknown[] = [];
    (tls as { connect: unknown }).connect = (...args: unknown[]) => {
      reached.push(args[0]);
      return {} as tls.TLSSocket;
    };
    const guard = installNetworkGuard({ block: [], allowOnly: ['shop.example.com'], reason: 'store only' });
    try {
      tls.connect({ host: 'Shop.Example.com.', port: 443 });
      expect(reached).toHaveLength(1);
      expect(() => tls.connect({ host: 'collector.example.net', port: 443 })).toThrow(/refused a connection to collector\.example\.net: store only/);
      expect(() => tls.connect({ port: 443 })).toThrow(/\(unknown host\)/);
      expect(reached).toHaveLength(1);
      expect(guard.blocked).toEqual(['collector.example.net', '(unknown host)']);
    } finally {
      guard.restore();
      (tls as { connect: unknown }).connect = original;
    }
  });

  it('host rules: exact names and patterns (Chargebee live vs -test sites)', () => {
    const cb = PROVIDER_PROFILES.chargebee!.liveHosts!;
    expect(hostMatches('acme.chargebee.com', cb)).toBe(true);
    expect(hostMatches('acme-test.chargebee.com', cb)).toBe(false);
    expect(hostMatches('acme-sandbox1-test.chargebee.com', cb)).toBe(false);
    expect(hostMatches('sandbox-api.paddle.com', PROVIDER_PROFILES.paddle!.liveHosts!)).toBe(false);
    expect(hostMatches('api.whop.com', PROVIDER_PROFILES.whop!.liveHosts!)).toBe(true);
  });

  it('end to end: a provider that ignores environment fails instead of reaching the live host', async () => {
    // Behaves like a provider that hardcodes its production host.
    const fake = makeFakeProvider({ name: 'polar' });
    fake.provider.listDiscounts = async () => {
      await fetch('https://api.polar.sh/v1/discounts/');
      return [];
    };
    const h = harness({ GPL_VERIFY_API_KEY: 'polar_oat_FAKEFAKEFAKEFAKE' }, fake.provider, { installNetworkGuard });
    const code = await main(['polar', '--json'], h.deps);
    const report = jsonReport(h);
    expect(code).toBe(1);
    expect(statusOf(report, 'list-discounts')).toEqual(['FAIL']);
    expect(report.steps.find((s) => s.name === 'network-guard')?.detail).toMatch(/api\.polar\.sh/);
    expect(report.artifacts.network).toMatchObject({ blocked: expect.arrayContaining(['api.polar.sh']) });
  });

  it('end to end: a store-hosted provider may only reach the store (WooCommerce)', async () => {
    const fake = makeFakeProvider({ name: 'woocommerce' });
    fake.provider.listDiscounts = async () => {
      await fetch('https://collector.example.net/keys');
      return [];
    };
    const h = harness(
      { GPL_VERIFY_API_KEY: 'ck_FAKE-not-a-real-key:cs_FAKE-not-a-real-secret', GPL_VERIFY_STORE_URL: 'https://shop.example.com' },
      fake.provider,
      { installNetworkGuard },
    );
    const code = await main(['woocommerce', '--allow-live', '--product', '12', '--json'], h.deps);
    const report = jsonReport(h);
    expect(code).toBe(1);
    expect(statusOf(report, 'list-discounts')).toEqual(['FAIL']);
    expect(report.steps.find((s) => s.name === 'network-guard')?.detail).toMatch(
      /collector\.example\.net: only the store's own host \(shop\.example\.com\)/,
    );
    const network = report.artifacts.network as { allowedOnly: string[]; blocked: string[] };
    expect(network.allowedOnly).toEqual(['shop.example.com']);
    expect(new Set(network.blocked)).toEqual(new Set(['collector.example.net']));
  });

  it('the providers the API refuses test mode for are exactly the always-live profiles', () => {
    const alwaysLive = Object.entries(PROVIDER_PROFILES)
      .filter(([, p]) => p.mode.kind === 'always-live')
      .map(([name]) => name)
      .sort();
    expect(Object.keys(PROVIDERS_WITHOUT_TEST_MODE).sort()).toEqual(alwaysLive);
  });

  it('every store-hosted profile declares an https account id the guard can read', () => {
    for (const [name, p] of Object.entries(PROVIDER_PROFILES)) {
      if (!p.allowOnlyAccountHost) continue;
      expect(p.accountId?.required, name).toBe(true);
    }
    expect(PROVIDER_PROFILES.woocommerce?.allowOnlyAccountHost).toBe(true);
  });
});

// ── capture ─────────────────────────────────────────────────────────────────

describe('main: --capture', () => {
  const delivery = { capturedAt: 'x', method: 'POST', path: '/hook', headers: { a: '1' }, rawBody: '{}' };
  const fakeCapture = () => ({
    listening: Promise.resolve({ host: '127.0.0.1', port: 8787 }),
    done: Promise.resolve(delivery),
    close: () => {},
  });

  it('refuses a missing directory before listening, so a delivery is never lost', async () => {
    let listened = false;
    const h = harness({}, undefined, {
      fileExists: async () => false,
      captureOnce: () => {
        listened = true;
        return fakeCapture();
      },
    });
    expect(await main(['--capture', 'nope/out.json'], h.deps)).toBe(2);
    expect(listened).toBe(false);
    expect(h.stderr.join('\n')).toMatch(/directory \/work\/nope does not exist/);
  });

  it('writes the delivery to a new file', async () => {
    const written: Array<[string, string]> = [];
    const h = harness({}, undefined, {
      fileExists: async (p) => p === '/work',
      writeNewFile: async (p, c) => void written.push([p, c]),
      captureOnce: fakeCapture,
    });
    expect(await main(['--capture', 'out.json'], h.deps)).toBe(0);
    expect(written).toHaveLength(1);
    expect(written[0]![0]).toBe('/work/out.json');
    expect(JSON.parse(written[0]![1])).toEqual(delivery);
  });

  it('if the write fails, hands the delivery over on stdout instead of dropping it', async () => {
    const h = harness({}, undefined, {
      fileExists: async (p) => p === '/work',
      writeNewFile: async () => {
        throw new Error('EACCES');
      },
      captureOnce: fakeCapture,
    });
    expect(await main(['--capture', 'out.json'], h.deps)).toBe(1);
    expect(JSON.parse(h.stdout.at(-1)!)).toEqual(delivery);
  });

  // WooCommerce sends an unsigned `webhook_id=<id>` ping while each webhook is
  // created (class-wc-webhook.php deliver_ping), before any order delivery.
  const wooPing: CapturedDelivery = {
    capturedAt: 'x',
    method: 'POST',
    path: '/hook',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    rawBody: 'webhook_id=142',
  };
  const wooOrder: CapturedDelivery = {
    capturedAt: 'x',
    method: 'POST',
    path: '/hook',
    headers: { 'x-wc-webhook-signature': 'c2ln', 'x-wc-webhook-topic': 'order.updated' },
    rawBody: '{"id":727,"status":"processing"}',
  };
  const recordingCapture = (seen: CaptureOptions[]) => (opts: CaptureOptions) => {
    seen.push(opts);
    return fakeCapture();
  };

  it("with a provider name, skips what the provider's isHandshake() recognises (WooCommerce's setup ping)", async () => {
    const seen: CaptureOptions[] = [];
    const created: Array<{ name: string; config: ProviderConfig }> = [];
    const h = harness({ GPL_VERIFY_STORE_URL: 'https://shop.example.com', GPL_VERIFY_API_KEY: 'ck_secret:cs_secret' }, undefined, {
      fileExists: async (p) => p === '/work',
      captureOnce: recordingCapture(seen),
      createProvider: (name, config) => {
        created.push({ name, config });
        return productionFactory(name, config);
      },
    });
    expect(await main(['woocommerce', '--capture', 'out.json'], h.deps)).toBe(0);
    // Built only for the check: the store URL, never the API key.
    expect(created).toEqual([{ name: 'woocommerce', config: expect.objectContaining({ apiKey: '', siteId: 'https://shop.example.com' }) }]);
    const skip = seen[0]!.skip!;
    expect(skip(wooPing)).toBe(true);
    expect(skip(wooOrder)).toBe(false);
    // A ping body that carries a signature header is not a handshake.
    expect(skip({ ...wooPing, headers: { 'x-wc-webhook-signature': 'c2ln' } })).toBe(false);
    seen[0]!.onSkip!(wooPing);
    expect(h.stdout.join('\n')).toMatch(/Skipped a setup ping \(POST \/hook, 14-byte body\).*Still waiting/);
  });

  it('without a provider name, or when the provider cannot be built, captures the first delivery', async () => {
    const seen: CaptureOptions[] = [];
    const deps = { fileExists: async (p: string) => p === '/work', captureOnce: recordingCapture(seen) };
    expect(await main(['--capture', 'out.json'], harness({}, undefined, deps).deps)).toBe(0);
    expect(seen[0]!.skip).toBeUndefined();

    const h = harness({}, undefined, { ...deps, createProvider: productionFactory }); // no store URL: WooCommerce refuses to build
    expect(await main(['woocommerce', '--capture', 'out2.json'], h.deps)).toBe(0);
    expect(seen[1]!.skip).toBeUndefined();
    expect(h.stderr.join('\n')).toMatch(/could not construct woocommerce to recognise setup pings.*the first delivery is captured/);
  });
});

describe('captureOnce', () => {
  it('records the first delivery byte-for-byte and answers 200', async () => {
    const handle = captureOnce({ port: 0 });
    const { port } = await handle.listening;
    const body = '{"type":"order.paid","data":{"amount":8300}}\n';
    const res = await fetch(`http://127.0.0.1:${port}/hook?x=1`, {
      method: 'POST',
      headers: { 'Webhook-Signature': 'v1,abc', 'Content-Type': 'application/json' },
      body,
    });
    expect(res.status).toBe(200);
    const d = await handle.done;
    expect(d).toMatchObject({ method: 'POST', path: '/hook?x=1', rawBody: body });
    expect(d.headers['webhook-signature']).toBe('v1,abc');
  });

  it('answers a skipped delivery 200 and keeps waiting for the next one', async () => {
    const skipped: string[] = [];
    const handle = captureOnce({
      port: 0,
      skip: (d) => d.rawBody.startsWith('webhook_id='),
      onSkip: (d) => skipped.push(d.rawBody),
    });
    const { port } = await handle.listening;
    const ping = await fetch(`http://127.0.0.1:${port}/hook`, { method: 'POST', body: 'webhook_id=142' });
    expect(ping.status).toBe(200);
    const order = '{"id":727}';
    const res = await fetch(`http://127.0.0.1:${port}/hook`, { method: 'POST', body: order });
    expect(res.status).toBe(200);
    expect((await handle.done).rawBody).toBe(order);
    expect(skipped).toEqual(['webhook_id=142']);
  });

  it('captures the delivery if skip() throws, so none is lost', async () => {
    const handle = captureOnce({
      port: 0,
      skip: () => {
        throw new Error('bad predicate');
      },
    });
    const { port } = await handle.listening;
    await fetch(`http://127.0.0.1:${port}/hook`, { method: 'POST', body: 'webhook_id=1' });
    expect((await handle.done).rawBody).toBe('webhook_id=1');
  });
});
