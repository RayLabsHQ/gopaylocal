// Tests for scripts/verify-provider/stripe-managed-payments.ts, the
// `verify:provider stripe --managed-payments` probes. Lives under src/ because
// the `api` vitest project includes src/**/*.test.ts.
//
// The flow runs against the REAL StripeProvider with `fetch` stubbed, so these
// tests also pin the requests the probes send. No network.
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StripeProvider } from '../services/providers/stripe';
import type { PaymentProvider } from '../services/providers/types';
import { parseCliArgs } from '../../scripts/verify-provider/args';
import type { CliOptions } from '../../scripts/verify-provider/args';
import { main } from '../../scripts/verify-provider/main';
import type { MainDeps } from '../../scripts/verify-provider/main';
import type { FlowContext, VerifyArtifacts } from '../../scripts/verify-provider/flows';
import { StepRunner } from '../../scripts/verify-provider/runner';
import type { StepResult } from '../../scripts/verify-provider/runner';
import { Redactor } from '../../scripts/verify-provider/safety';
import {
  MP_LOCATION_EMAIL,
  MP_VERIFY_STEPS,
  describeTaxShape,
  managedPaymentsPlan,
  managedPaymentsReplaySteps,
  managedPaymentsSteps,
} from '../../scripts/verify-provider/stripe-managed-payments';

// ── fetch stub, routed by method + path ─────────────────────────────────────

interface Call {
  method: string;
  path: string;
  form: Record<string, string>;
}
type Route = (call: Call) => { status?: number; body: unknown } | undefined;

let calls: Call[];
let route: Route;

beforeEach(() => {
  calls = [];
  route = () => undefined;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL, init: RequestInit = {}) => {
      const url = new URL(String(input));
      const call: Call = {
        method: init.method ?? 'GET',
        path: url.pathname,
        form: Object.fromEntries(new URLSearchParams(typeof init.body === 'string' ? init.body : '')),
      };
      calls.push(call);
      const r = route(call);
      if (!r) throw new Error(`unexpected request ${call.method} ${call.path}`);
      return new Response(JSON.stringify(r.body), {
        status: r.status ?? 200,
        headers: { 'content-type': 'application/json', 'request-id': 'req_test', 'stripe-should-retry': 'false' },
      });
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

const sessionCreates = () => calls.filter((c) => c.method === 'POST' && c.path === '/v1/checkout/sessions');
const stripeError = (status: number, message: string) => ({
  status,
  body: { error: { type: 'invalid_request_error', message } },
});

// ── context ─────────────────────────────────────────────────────────────────

function options(argv: string[]): CliOptions {
  const r = parseCliArgs(argv);
  if (!r.ok) throw new Error(r.error);
  return r.options;
}

function context(opts: CliOptions, provider: PaymentProvider = new StripeProvider({ apiKey: 'fake-stripe-secret-key' })) {
  const results: StepResult[] = [];
  const lines: string[] = [];
  const runner = new StepRunner({ timeoutMs: 5000, onResult: (r) => results.push(r) });
  const ctx: FlowContext = {
    providerName: 'stripe',
    provider,
    options: opts,
    runner,
    out: { info: (l) => lines.push(l), warn: (l) => lines.push(`warning: ${l}`), secret: () => {} },
    redactor: new Redactor(),
    sleep: async () => {},
    waitForEnter: async () => {},
  };
  const status = (name: string) => results.find((r) => r.name === name)?.status;
  const detail = (name: string) => results.find((r) => r.name === name)?.detail ?? '';
  return { ctx, results, lines, status, detail };
}

const DISCOUNT: NonNullable<VerifyArtifacts['discount']> = {
  providerDiscountId: 'VERIFYSTRIPE17AAAA',
  code: 'VERIFYSTRIPE17AAAA',
  requestedCode: 'VERIFY-STRIPE17-AAAA',
  discountPercent: 17,
  providerPromoCodeId: 'promo_verify',
};

const session = (form: Record<string, string>, over: Record<string, unknown> = {}) => {
  const n = sessionCreates().length - 1; // this create is already recorded: control = 0
  const discounts = form['discounts[0][promotion_code]']
    ? [{ coupon: DISCOUNT.providerDiscountId, promotion_code: form['discounts[0][promotion_code]'] }]
    : form['discounts[0][coupon]']
      ? [{ coupon: form['discounts[0][coupon]'], promotion_code: null }]
      : [];
  return {
    body: {
      id: `cs_test_mp${n}`,
      object: 'checkout.session',
      url: `https://checkout.stripe.com/c/pay/cs_test_mp${n}`,
      mode: 'payment',
      currency: 'usd',
      amount_total: discounts.length ? 830 : 1000,
      managed_payments: form['managed_payments[enabled]'] === 'true' ? { enabled: true } : null,
      allow_promotion_codes: form.allow_promotion_codes === 'true' ? true : null,
      discounts,
      ...over,
    },
  };
};

/** A test account where Managed Payments is active and every probe is accepted. */
const happyAccount: Route = (c) => {
  if (c.method === 'GET' && c.path === '/v1/prices/price_mp') return { body: { id: 'price_mp', object: 'price', recurring: null } };
  if (c.method === 'GET' && c.path === '/v1/promotion_codes') {
    return { body: { object: 'list', has_more: false, url: '/v1/promotion_codes', data: [{ id: 'promo_verify', object: 'promotion_code', code: DISCOUNT.code }] } };
  }
  if (c.method === 'POST' && c.path === '/v1/checkout/sessions') return session(c.form);
  return undefined;
};

// ── verify mode ─────────────────────────────────────────────────────────────

describe('managedPaymentsSteps', () => {
  it('runs the control, then the promotion code, coupon and customer-code probes, all opted into Managed Payments', async () => {
    route = happyAccount;
    const t = context(options(['stripe', '--product', 'price_mp']));
    const art: VerifyArtifacts = { discount: DISCOUNT };

    await managedPaymentsSteps(t.ctx, art);

    expect(MP_VERIFY_STEPS.map(t.status)).toEqual(['PASS', 'PASS', 'PASS', 'PASS']);
    const forms = sessionCreates().map((c) => c.form);
    expect(forms).toHaveLength(4);
    for (const f of forms) {
      expect(f['managed_payments[enabled]']).toBe('true');
      expect(f.customer_email).toBe(MP_LOCATION_EMAIL);
      expect(f['line_items[0][price]']).toBe('price_mp');
    }
    expect(forms[0]).not.toHaveProperty('discounts[0][promotion_code]');
    expect(forms[1]!['discounts[0][promotion_code]']).toBe('promo_verify');
    expect(forms[2]!['discounts[0][coupon]']).toBe(DISCOUNT.providerDiscountId);
    expect(forms[3]!.allow_promotion_codes).toBe('true');
    expect(t.detail('mp-promotion-code')).toMatch(/accepted the promotion code on a managed session/);
    // The purchase URL handed to the human is the pre-applied promotion-code session.
    expect(art.checkoutUrl).toBe('https://checkout.stripe.com/c/pay/cs_test_mp1');
    expect(t.lines.join('\n')).toMatch(/--replay <file> --managed-payments --expect-code VERIFYSTRIPE17AAAA/);
  });

  it('blocks the discount probes when Stripe refuses even a plain managed session', async () => {
    route = (c) =>
      c.method === 'POST' && c.path === '/v1/checkout/sessions'
        ? stripeError(400, 'example: Managed Payments is not enabled')
        : happyAccount(c);
    const t = context(options(['stripe', '--product', 'price_mp']));

    await managedPaymentsSteps(t.ctx, { discount: DISCOUNT });

    expect(MP_VERIFY_STEPS.map(t.status)).toEqual(['FAIL', 'BLOCKED', 'BLOCKED', 'BLOCKED']);
    expect(t.detail('mp-session')).toMatch(/example: Managed Payments is not enabled[\s\S]*settings\/managed-payments/);
    expect(sessionCreates()).toHaveLength(1);
  });

  it('fails the control when Stripe creates the session without applying Managed Payments', async () => {
    route = (c) =>
      c.method === 'POST' && c.path === '/v1/checkout/sessions' ? session(c.form, { managed_payments: null }) : happyAccount(c);
    const t = context(options(['stripe', '--product', 'price_mp']));
    await managedPaymentsSteps(t.ctx, { discount: DISCOUNT });
    expect(t.status('mp-session')).toBe('FAIL');
    expect(t.detail('mp-session')).toMatch(/Managed Payments was not applied/);
  });

  it('reports a rejected promotion code as the answer to open question 1, and still probes the rest', async () => {
    route = (c) =>
      c.method === 'POST' && c.path === '/v1/checkout/sessions' && c.form['discounts[0][promotion_code]']
        ? stripeError(400, 'example: discounts are not supported')
        : happyAccount(c);
    const t = context(options(['stripe', '--product', 'price_mp']));
    await managedPaymentsSteps(t.ctx, { discount: DISCOUNT });
    expect(MP_VERIFY_STEPS.map(t.status)).toEqual(['PASS', 'FAIL', 'PASS', 'PASS']);
    expect(t.detail('mp-promotion-code')).toMatch(/REJECTED promotion code VERIFYSTRIPE17AAAA[\s\S]*question 1 answered "no"/);
  });

  it('fails when Stripe accepts the code but the session shows no discount or no price change', async () => {
    route = (c) =>
      c.method === 'POST' && c.path === '/v1/checkout/sessions' && c.form['discounts[0][promotion_code]']
        ? session(c.form, { discounts: [], amount_total: 1000 })
        : happyAccount(c);
    const t = context(options(['stripe', '--product', 'price_mp']));
    await managedPaymentsSteps(t.ctx, { discount: DISCOUNT });
    expect(t.status('mp-promotion-code')).toBe('FAIL');
    expect(t.detail('mp-promotion-code')).toMatch(/session.discounts is \[\][\s\S]*not below the control's 1000/);
  });

  it('blocks the code probes when create-discount did not produce a discount', async () => {
    route = happyAccount;
    const t = context(options(['stripe', '--product', 'price_mp']));
    await managedPaymentsSteps(t.ctx, {});
    expect(MP_VERIFY_STEPS.map(t.status)).toEqual(['PASS', 'BLOCKED', 'BLOCKED', 'PASS']);
  });

  it('skips without --product, and for a provider that cannot create sessions', async () => {
    const a = context(options(['stripe']));
    await managedPaymentsSteps(a.ctx, { discount: DISCOUNT });
    expect(MP_VERIFY_STEPS.map(a.status)).toEqual(['SKIPPED', 'SKIPPED', 'SKIPPED', 'SKIPPED']);

    const notStripe = { name: 'paddle' } as unknown as PaymentProvider;
    const b = context(options(['stripe', '--product', 'price_mp']), notStripe);
    await managedPaymentsSteps(b.ctx, { discount: DISCOUNT });
    expect(b.detail('mp-session')).toMatch(/Stripe-only/);
    expect(calls).toHaveLength(0);
  });
});

// ── replay mode ─────────────────────────────────────────────────────────────

describe('managedPaymentsReplaySteps', () => {
  const fixture = (name: string) =>
    readFileSync(new URL(`../services/providers/__fixtures__/stripe/${name}`, import.meta.url), 'utf8');

  it('prints the Managed Payments fields of a managed, discounted delivery', async () => {
    const t = context(options(['stripe', '--replay', 'd.json']));
    await managedPaymentsReplaySteps(t.ctx, fixture('checkout-session-completed-managed-payments.json'));
    expect(t.status('mp-delivery')).toBe('PASS');
    expect(t.detail('mp-delivery')).toMatch(/1440 usd .*tax 240 added on top \(exclusive prices\).*presentment 1290 eur/);
    const printed = t.lines.join('\n');
    expect(printed).toMatch(/"managed_payments": \{\s*"enabled": true/);
    expect(printed).toMatch(/"presentment_currency": "eur"/);
    expect(calls).toHaveLength(0);
  });

  it('fails for a delivery from a session without Managed Payments', async () => {
    const t = context(options(['stripe', '--replay', 'd.json']));
    await managedPaymentsReplaySteps(t.ctx, fixture('checkout-session-completed-coupon.json'));
    expect(t.status('mp-delivery')).toBe('FAIL');
    expect(t.detail('mp-delivery')).toMatch(/not a Managed Payments session/);
  });

  it('fails when the code did not reach the webhook, unless --expect-none', async () => {
    const evt = JSON.parse(fixture('checkout-session-completed-managed-payments.json'));
    evt.data.object.discounts = [];
    const body = JSON.stringify(evt);

    const a = context(options(['stripe', '--replay', 'd.json']));
    await managedPaymentsReplaySteps(a.ctx, body);
    expect(a.detail('mp-delivery')).toMatch(/carries no discount/);

    const b = context(options(['stripe', '--replay', 'd.json', '--expect-none']));
    await managedPaymentsReplaySteps(b.ctx, body);
    expect(b.status('mp-delivery')).toBe('PASS');
  });

  it('rejects non-checkout events and non-JSON bodies', async () => {
    const t = context(options(['stripe', '--replay', 'd.json']));
    await managedPaymentsReplaySteps(t.ctx, fixture('invoice-paid-renewal.json'));
    expect(t.detail('mp-delivery')).toMatch(/expected a checkout.session.\* event/);
    const u = context(options(['stripe', '--replay', 'd.json']));
    await managedPaymentsReplaySteps(u.ctx, 'nope');
    expect(u.detail('mp-delivery')).toMatch(/not JSON/);
  });

  it('describeTaxShape tells exclusive, inclusive and untaxed totals apart', () => {
    const td = (amount_tax: number) => ({ amount_discount: 800, amount_shipping: 0, amount_tax });
    expect(describeTaxShape({ amount_subtotal: 2000, amount_total: 1440, total_details: td(240) })).toMatch(/added on top/);
    expect(describeTaxShape({ amount_subtotal: 2000, amount_total: 1200, total_details: td(200) })).toMatch(/inclusive/);
    expect(describeTaxShape({ amount_subtotal: 2000, amount_total: 1200, total_details: td(0) })).toBe('no tax');
    expect(describeTaxShape({ amount_subtotal: 2000, amount_total: 1300, total_details: td(200) })).toMatch(/neither/);
    expect(describeTaxShape({ total_details: null })).toBe('tax not reported');
  });
});

// ── dry-run plan ────────────────────────────────────────────────────────────

describe('managedPaymentsPlan', () => {
  it('names every probe and what it would send, without calling anything', () => {
    const verify = managedPaymentsPlan('verify', { product: 'price_mp' });
    expect(verify.map((p) => p.name)).toEqual([...MP_VERIFY_STEPS]);
    for (const p of verify) expect(p.call).toMatch(/createCheckoutSession\('price_mp', managed_payments\[enabled\]=true/);
    expect(managedPaymentsPlan('replay', { replayFile: 'd.json' })).toEqual([
      { name: 'mp-delivery', call: expect.stringMatching(/^managedPaymentsReplaySteps\(\) on d\.json \(.*no API call\)$/) },
    ]);
    expect(calls).toHaveLength(0);
  });
});

// ── --managed-payments flag ─────────────────────────────────────────────────

describe('parseCliArgs --managed-payments', () => {
  const parseError = (argv: string[]) => {
    const r = parseCliArgs(argv);
    return r.ok ? null : r.error;
  };

  it('is off by default and on for stripe verify with --product, or stripe replay', () => {
    expect(options(['stripe', '--product', 'price_mp']).managedPayments).toBe(false);
    expect(options(['stripe', '--managed-payments', '--product', 'price_mp']).managedPayments).toBe(true);
    expect(options(['stripe', '--replay', 'd.json', '--managed-payments']).managedPayments).toBe(true);
  });

  it('is refused for other providers, without --product, and in cleanup or capture mode', () => {
    expect(parseError(['paddle', '--managed-payments', '--product', 'pri_1'])).toMatch(/Stripe-only/);
    expect(parseError(['stripe', '--managed-payments'])).toMatch(/needs --product/);
    expect(parseError(['stripe', '--delete-discount', 'X', '--managed-payments'])).toMatch(/not valid with this mode \(cleanup\)/);
    expect(parseError(['--capture', 'out.json', '--managed-payments'])).toMatch(/not valid with this mode \(capture\)/);
  });
});

// ── end to end through main() ───────────────────────────────────────────────

function mainDeps(stdout: string[], created: string[]): MainDeps {
  return {
    // Obviously fake; only the sk_test_ prefix matters (it decides test mode).
    env: { GPL_VERIFY_API_KEY: 'sk_test_FAKE-not-a-real-key' },
    // The REAL adapter, so "no request" covers its construction too.
    createProvider: (name, config) => {
      created.push(name);
      return new StripeProvider(config);
    },
    stdout: (t) => stdout.push(t),
    stderr: () => {},
    readFile: async () => {
      throw new Error('no files in this test');
    },
    writeNewFile: async () => {},
    fileExists: async () => false,
    resolvePath: (p) => p,
    waitForEnter: async () => {},
    onInterrupt: () => () => {},
    exit: (code) => {
      throw new Error(`exit ${code}`);
    },
    sleep: async () => {},
    now: () => Date.now(),
    commit: () => null,
    nodeVersion: 'v24.0.0',
    randomBytes: (n) => new Uint8Array(n).fill(0), // throwaway code VERIFYZZ17AAAA
  };
}

type Report = { ok: boolean; steps: Array<{ name: string; status: string; detail: string }> };

describe('main: stripe --managed-payments --dry-run', () => {
  it('constructs the real StripeProvider, lists every probe in place of checkout-url, and sends no request', async () => {
    const out: string[] = [];
    const created: string[] = [];
    const code = await main(
      ['stripe', '--managed-payments', '--product', 'price_1MpVerifyDryRun', '--dry-run', '--json'],
      mainDeps(out, created),
    );

    expect(code).toBe(0);
    expect(created).toEqual(['stripe']);
    expect(calls).toHaveLength(0); // the fetch stub records every request
    const report = JSON.parse(out.join('\n')) as Report;
    const names = report.steps.map((s) => s.name);
    for (const step of MP_VERIFY_STEPS) expect(names).toContain(step);
    expect(names).not.toContain('checkout-url');
    expect(report.steps.find((s) => s.name === 'mp-promotion-code')!.detail).toMatch(
      /^dry run: would call createCheckoutSession\('price_1MpVerifyDryRun', managed_payments\[enabled\]=true/,
    );
  });

  it('replay --managed-payments --dry-run lists mp-delivery and reads nothing', async () => {
    const out: string[] = [];
    const code = await main(['stripe', '--replay', 'capture.json', '--managed-payments', '--dry-run', '--json'], mainDeps(out, []));

    expect(code).toBe(0);
    expect(calls).toHaveLength(0);
    const report = JSON.parse(out.join('\n')) as Report;
    expect(report.steps.map((s) => s.name)).toContain('mp-delivery');
  });
});

describe('main: stripe --managed-payments (verify flow wiring)', () => {
  it('runs the probes in place of checkout-url, between create-discount and cleanup', async () => {
    // A test account where everything is accepted; the coupon lives until deleted.
    let coupon: Record<string, unknown> | null = null;
    route = (c) => {
      if (c.method === 'GET' && c.path === '/v1/products') return { body: { object: 'list', has_more: false, url: '/v1/products', data: [] } };
      if (c.method === 'POST' && c.path === '/v1/coupons') {
        coupon = { id: c.form.id, object: 'coupon', percent_off: Number(c.form.percent_off), duration: 'forever', metadata: { gopaylocal: 'true' }, valid: true };
        return { body: coupon };
      }
      if (c.method === 'POST' && c.path === '/v1/promotion_codes') {
        return { body: { id: 'promo_verify', object: 'promotion_code', code: c.form.code, active: true } };
      }
      if (c.method === 'GET' && c.path === '/v1/coupons') {
        return { body: { object: 'list', has_more: false, url: '/v1/coupons', data: coupon ? [coupon] : [] } };
      }
      if (c.method === 'DELETE' && c.path.startsWith('/v1/coupons/')) {
        coupon = null;
        return { body: { id: c.path.slice('/v1/coupons/'.length), object: 'coupon', deleted: true } };
      }
      return happyAccount(c);
    };
    const out: string[] = [];

    const code = await main(['stripe', '--managed-payments', '--product', 'price_mp', '--json'], mainDeps(out, []));

    const report = JSON.parse(out.join('\n')) as Report;
    const names = report.steps.map((s) => s.name);
    expect(names).not.toContain('checkout-url');
    for (const step of MP_VERIFY_STEPS) expect(report.steps.find((s) => s.name === step)?.status).toBe('PASS');
    expect(names.indexOf('create-discount')).toBeLessThan(names.indexOf('mp-session'));
    expect(names.indexOf('mp-customer-code')).toBeLessThan(names.indexOf('delete-discount'));
    expect(code).toBe(0);
    const forms = sessionCreates().map((c) => c.form);
    expect(forms).toHaveLength(4);
    expect(forms[2]!['discounts[0][coupon]']).toBe('VERIFYZZ17AAAA'); // the run's own throwaway coupon
    expect(calls.some((c) => c.method === 'DELETE' && c.path === '/v1/coupons/VERIFYZZ17AAAA')).toBe(true);
  });
});
