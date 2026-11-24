// ── Verification flows ──────────────────────────────────────────────────────
// The checks themselves, written against the PaymentProvider interface only,
// so any provider in the registry runs through them unchanged.

import type {
  PaymentProvider,
  ProviderDiscount,
  ProviderProduct,
  RedemptionEvent,
} from '../../src/services/providers/types';
import type { CliOptions } from './args';
import { generateThrowawayCode } from './code';
import type { RandomBytes } from './code';
import type { ProviderProfile } from './profiles';
import { GENERIC_ENV } from './profiles';
import type { StepRunner } from './runner';
import { mask } from './safety';
import type { Redactor } from './safety';
import { managedPaymentsReplaySteps, managedPaymentsSteps } from './stripe-managed-payments';

export interface Output {
  /** Progress / human-readable line (redacted). */
  info(line: string): void;
  /** Warning line, always on stderr (redacted). */
  warn(line: string): void;
  /** Deliberately unredacted secret, stderr only (--print-secret). */
  secret(label: string, value: string): void;
}

export interface FlowContext {
  providerName: string;
  provider: PaymentProvider;
  profile?: ProviderProfile;
  options: CliOptions;
  runner: StepRunner;
  out: Output;
  redactor: Redactor;
  sleep: (ms: number) => Promise<void>;
  waitForEnter: (prompt: string) => Promise<void>;
  randomBytes?: RandomBytes;
}

export interface CreatedDiscount {
  providerDiscountId: string;
  code: string;
  requestedCode: string;
  discountPercent: number;
  providerPromoCodeId?: string | null;
}

export interface VerifyArtifacts {
  discount?: CreatedDiscount;
  checkoutUrl?: string;
  webhook?: { endpointId: string; secret: string; hasSecret: boolean };
}

export function capabilities(provider: PaymentProvider): Record<string, boolean> {
  const has = (m: keyof PaymentProvider) => typeof provider[m] === 'function';
  return {
    listProducts: has('listProducts'),
    provisionWebhook: has('provisionWebhook'),
    deleteWebhook: has('deleteWebhook'),
    verifyWebhook: has('verifyWebhook'),
    parseRedemption: has('parseRedemption'),
  };
}

const approxEqual = (a: unknown, b: number) => typeof a === 'number' && Math.abs(a - b) < 1e-6;

/** Catches ids that are really a stringified missing field, e.g. String(undefined). */
const isRealId = (s: unknown): s is string =>
  typeof s === 'string' && s.trim() !== '' && s !== 'undefined' && s !== 'null' && s !== 'NaN';

function fmtProduct(p: ProviderProduct): string {
  const price = p.price != null ? ` ${p.price}${p.currency ? ` ${p.currency}` : ''}` : '';
  return `${p.providerProductId} "${p.name}"${price}`;
}

export function cleanupCommand(ctx: Pick<FlowContext, 'providerName' | 'profile'>, flag: string, id: string): string {
  const envHint = [GENERIC_ENV.apiKey, ctx.profile?.accountId?.env].filter(Boolean).join(' + ');
  return `delete it later with: pnpm --filter @gopaylocal/api verify:provider ${ctx.providerName} ${flag} '${id}' (needs ${envHint})`;
}

// ── Shared cleanup steps ────────────────────────────────────────────────────

export async function deleteDiscountSteps(
  ctx: FlowContext,
  discount: { providerDiscountId: string; code?: string },
): Promise<void> {
  const { runner, provider } = ctx;
  const del = await runner.step('delete-discount', async () => {
    await provider.deleteDiscount(discount.providerDiscountId);
    return { detail: `deleted ${discount.providerDiscountId}` };
  });
  if (del.status !== 'PASS') {
    ctx.out.warn(
      `The verification discount ${discount.code ?? discount.providerDiscountId} was NOT deleted; ${cleanupCommand(ctx, '--delete-discount', discount.providerDiscountId)}, or remove it in the provider dashboard.`,
    );
    return;
  }
  await runner.step('confirm-deleted', async () => {
    const attempts = 3;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      const list = await provider.listDiscounts();
      if (!list.some((d) => d.providerDiscountId === discount.providerDiscountId)) {
        return {
          detail: `no longer returned by listDiscounts() (${list.length} listed${attempt > 1 ? `, attempt ${attempt}` : ''})`,
        };
      }
      if (attempt < attempts) await ctx.sleep(2000);
    }
    return {
      status: 'FAIL',
      detail:
        `still returned by listDiscounts() after deleteDiscount() succeeded (checked ${attempts} times over ~4s). ` +
        `If the provider archives instead of deleting, listDiscounts() should filter archived items; ` +
        `otherwise syncProviderCoupons() keeps treating the coupon as live.`,
    };
  });
}

export async function deleteWebhookStep(ctx: FlowContext, endpointId: string): Promise<void> {
  const { runner, provider } = ctx;
  if (typeof provider.deleteWebhook !== 'function') {
    runner.skip(
      'delete-webhook',
      `unsupported: provider has no deleteWebhook(); remove endpoint ${endpointId} in the provider dashboard`,
    );
    return;
  }
  const res = await runner.step('delete-webhook', async () => {
    await provider.deleteWebhook!(endpointId);
    return { detail: `deleted endpoint ${endpointId}` };
  });
  if (res.status !== 'PASS') {
    ctx.out.warn(
      `Webhook endpoint ${endpointId} was NOT deleted; ${cleanupCommand(ctx, '--delete-webhook', endpointId)}, or remove it in the provider dashboard.`,
    );
  }
}

// ── verify (default mode) ───────────────────────────────────────────────────

export async function verifyFlow(ctx: FlowContext): Promise<VerifyArtifacts> {
  const { provider, runner, options, out, profile } = ctx;
  const art: VerifyArtifacts = {};
  const percent = options.percent;

  // 1. list-products
  if (typeof provider.listProducts !== 'function') {
    runner.skip('list-products', 'unsupported: provider does not implement listProducts()');
  } else {
    await runner.step('list-products', async () => {
      const products = await provider.listProducts!();
      if (!Array.isArray(products)) throw new Error('listProducts() did not return an array');
      const malformed = products.filter(
        (p) =>
          !p ||
          !isRealId(p.providerProductId) ||
          typeof p.name !== 'string' ||
          (p.price !== null && !Number.isFinite(p.price)),
      );
      // --public-log: the account's catalogue (names, prices, ids) is not printed.
      const sample = options.publicLog ? '' : products.slice(0, 5).map(fmtProduct).join('; ');
      let detail = `${products.length} product(s)${sample ? `: ${sample}${products.length > 5 ? '; …' : ''}` : ''}`;
      if (options.product && !products.some((p) => p.providerProductId === options.product)) {
        detail += ` (note: --product ${options.product} is not one of these ids; expected ${profile?.checkoutId ?? 'a provider id'})`;
      } else if (options.product && options.publicLog) {
        detail += '; --product is one of them';
      }
      const data = options.publicLog
        ? { count: products.length }
        : { count: products.length, products: products.slice(0, 20) };
      if (malformed.length) {
        const which = options.publicLog ? '' : `: ${JSON.stringify(malformed.slice(0, 2))}`;
        return {
          status: 'FAIL',
          detail: `${malformed.length} of ${products.length} product(s) are malformed (missing id/name or non-numeric price)${which}`,
          data,
        };
      }
      return { detail, data };
    });
  }

  // 2. create-discount — cleanup is registered the moment the provider returns
  // an id, before any assertion, so a half-right result still gets deleted.
  const requestedCode = generateThrowawayCode(ctx.providerName, percent, ctx.randomBytes);
  // --public-log: the code works at the provider until cleanup, and on Gumroad
  // or WooCommerce that is a real store. Anyone watching the log could use it.
  if (options.publicLog) ctx.redactor.addLabel(requestedCode, '[throwaway code]');
  const create = await runner.step('create-discount', async () => {
    const d: ProviderDiscount = await provider.createDiscount({
      name: `GoPayLocal verify ${requestedCode}`,
      code: requestedCode,
      discountType: 'percentage',
      amount: percent,
      ...(profile?.scopeDiscountToProduct && options.product ? { productIds: [options.product] } : {}),
    });
    if (options.publicLog && d?.code) ctx.redactor.addLabel(d.code, '[throwaway code]');
    if (d && isRealId(d.providerDiscountId)) {
      art.discount = {
        providerDiscountId: d.providerDiscountId,
        code: d.code || requestedCode,
        requestedCode,
        discountPercent: d.discountPercent,
        providerPromoCodeId: d.providerPromoCodeId ?? null,
      };
      const created = art.discount;
      runner.defer(
        'delete-discount',
        () => deleteDiscountSteps(ctx, created),
        cleanupCommand(ctx, '--delete-discount', created.providerDiscountId),
      );
    }
    const problems: string[] = [];
    if (!d || !isRealId(d.providerDiscountId)) problems.push(`no usable providerDiscountId returned (${JSON.stringify(d?.providerDiscountId)})`);
    if (!d?.code) problems.push('no code returned');
    if (!approxEqual(d?.discountPercent, percent)) problems.push(`returned discountPercent ${JSON.stringify(d?.discountPercent)}, expected ${percent}`);
    const codeNote =
      d?.code && d.code !== requestedCode
        ? ` (provider returned ${d.code} for requested ${requestedCode}; production stores and displays the provider's version)`
        : '';
    const data = { requestedCode, discount: d };
    if (problems.length) return { status: 'FAIL', detail: `${problems.join('; ')}${codeNote}`, data };
    return {
      detail: `created ${d.providerDiscountId}, code ${d.code}, ${d.discountPercent}%${codeNote}`,
      data,
    };
  });
  if (create.status === 'FAIL' && create.error?.name === 'StepTimeoutError' && !art.discount) {
    // The create may still land after the timeout. Look it up by code at
    // cleanup time and delete it if it exists.
    runner.defer(
      'delete-discount',
      async () => {
        const found = await runner.step('find-timed-out-discount', async () => {
          const list = await provider.listDiscounts();
          const hit = list.find((d) => d.code?.toUpperCase().endsWith(requestedCode.toUpperCase()));
          if (!hit) return { status: 'SKIPPED', detail: `no discount with code ${requestedCode} exists; nothing to delete` };
          art.discount = {
            providerDiscountId: hit.providerDiscountId,
            code: hit.code,
            requestedCode,
            discountPercent: hit.discountPercent,
          };
          return { detail: `the timed-out create did land: ${hit.providerDiscountId}` };
        });
        if (found.status === 'PASS' && art.discount) await deleteDiscountSteps(ctx, art.discount);
      },
      `the create timed out; look for code ${requestedCode} in the provider dashboard`,
    );
  }

  // 3. list-discounts
  if (art.discount) {
    const created = art.discount;
    await runner.step('list-discounts', async () => {
      const list = await provider.listDiscounts();
      const byId = list.find((d) => d.providerDiscountId === created.providerDiscountId);
      const match = byId ?? list.find((d) => d.code?.toUpperCase() === created.code.toUpperCase());
      if (!match) {
        return {
          status: 'FAIL',
          detail: `not found among ${list.length} listed discount(s) (looked for id ${created.providerDiscountId} or code ${created.code})`,
          data: { count: list.length },
        };
      }
      const problems: string[] = [];
      if (!byId) problems.push(`found by code but listed under a different id (${match.providerDiscountId}); deleteDiscount() gets the id from createDiscount()`);
      if (!approxEqual(match.discountPercent, percent)) problems.push(`listed at ${match.discountPercent}%, expected ${percent}%`);
      if (match.code && match.code.toUpperCase() !== created.code.toUpperCase()) problems.push(`listed code ${match.code} differs from created code ${created.code}`);
      const data = { count: list.length, match };
      if (problems.length) return { status: 'FAIL', detail: problems.join('; '), data };
      return { detail: `found ${match.providerDiscountId} (${match.code}, ${match.discountPercent}%) among ${list.length} discount(s)`, data };
    });
  } else {
    // Nothing to look for, but listing still proves auth + parsing.
    await runner.step('list-discounts', async () => {
      const list = await provider.listDiscounts();
      return {
        status: 'BLOCKED',
        detail: `listDiscounts() returned ${list.length} discount(s), but the presence check needs the discount from create-discount`,
        data: { count: list.length },
      };
    });
  }

  // 4. checkout-url (buildCheckoutUrl has no production caller today; this is
  // how a human gets a discounted checkout for the test purchase).
  // --managed-payments (Stripe) replaces it with the Managed Payments probes.
  if (options.managedPayments) {
    await managedPaymentsSteps(ctx, art);
  } else if (!options.product) {
    runner.skip('checkout-url', `not requested: pass --product <${profile?.checkoutId ?? 'provider product id'}>`);
  } else {
    const productId = options.product;
    await runner.step('checkout-url', async () => {
      const url = await provider.buildCheckoutUrl({
        productId,
        successUrl: options.successUrl,
        ...(art.discount ? { discountCode: art.discount.code, discountId: art.discount.providerDiscountId } : {}),
      });
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        const what = options.publicLog ? '' : `: ${JSON.stringify(url)}`;
        return { status: 'FAIL', detail: `buildCheckoutUrl() returned something that is not a URL${what}` };
      }
      if (parsed.protocol !== 'https:') {
        return { status: 'FAIL', detail: `checkout URL is not https${options.publicLog ? '' : `: ${url}`}` };
      }
      art.checkoutUrl = url;
      return {
        detail: art.discount
          ? `built for ${productId} with ${art.discount.code}`
          : `built for ${productId} WITHOUT a discount (create-discount did not succeed)`,
        ...(options.publicLog ? {} : { data: { url } }),
      };
    });
  }

  // 5. provision-webhook
  if (!options.webhookUrl) {
    runner.skip('provision-webhook', 'not requested: pass --webhook-url <https url> (e.g. a tunnel to --capture)');
  } else if (typeof provider.provisionWebhook !== 'function') {
    runner.skip('provision-webhook', 'unsupported: provider does not implement provisionWebhook()');
  } else {
    const callbackUrl = options.webhookUrl;
    await runner.step('provision-webhook', async () => {
      const res = await provider.provisionWebhook!(callbackUrl);
      if (res && isRealId(res.endpointId)) {
        const secret = res.secret ?? '';
        ctx.redactor.add(secret);
        art.webhook = { endpointId: res.endpointId, secret, hasSecret: !!res.secret };
        // An adopted endpoint existed before this run: cleanup only removes
        // what the run created.
        if (!res.adopted) {
          runner.defer(
            'delete-webhook',
            () => deleteWebhookStep(ctx, res.endpointId),
            cleanupCommand(ctx, '--delete-webhook', res.endpointId),
          );
        }
      }
      if (!res || !isRealId(res.endpointId)) {
        return { status: 'FAIL', detail: `no usable endpointId returned (${JSON.stringify(res?.endpointId)})` };
      }
      const secretNote = res.secret
        ? `signing secret ${mask(res.secret)}${options.printSecret ? ' (printed on stderr)' : ' (pass --print-secret to see it)'}`
        : profile?.unsignedWebhooks
          ? 'no signing secret (this provider does not sign webhooks)'
          : 'NO signing secret returned';
      return {
        status: res.secret || profile?.unsignedWebhooks ? 'PASS' : 'FAIL',
        detail: `endpoint ${res.endpointId} → ${callbackUrl}${res.adopted ? ' (existing endpoint reused; cleanup leaves it in place)' : ''}; ${secretNote}`,
        data: { endpointId: res.endpointId, hasSecret: !!res.secret, adopted: !!res.adopted },
      };
    });
    if (art.webhook?.hasSecret && options.printSecret) {
      out.secret(`webhook signing secret (set ${GENERIC_ENV.webhookSecret} to this for --replay)`, art.webhook.secret);
    }
  }

  if (art.checkoutUrl && options.publicLog) {
    // Anyone who can read the log could open the link and buy.
    out.info('');
    out.info('Checkout URL built; not printed with --public-log. Run the tool on your machine to get one.');
  } else if (art.checkoutUrl) {
    out.info('');
    out.info(`Checkout URL (complete a test purchase here):\n  ${art.checkoutUrl}`);
    if (art.discount && !options.keep && !options.wait) {
      out.info(
        '  Note: cleanup deletes the discount when this run ends. To complete a discounted purchase, re-run with --wait (pause before cleanup) or --keep.',
      );
    }
  }

  if (options.wait && runner.pendingCleanups.length > 0 && !runner.isInterrupted) {
    out.info('');
    out.info('Paused before cleanup (--wait). Complete the test purchase now; deliveries go to your --webhook-url.');
    await ctx.waitForEnter('Press Enter to clean up (Ctrl-C also cleans up)… ');
  }

  return art;
}

// ── cleanup mode (--delete-discount / --delete-webhook) ─────────────────────

export async function cleanupFlow(ctx: FlowContext): Promise<void> {
  if (ctx.options.deleteWebhook) await deleteWebhookStep(ctx, ctx.options.deleteWebhook);
  if (ctx.options.deleteDiscount) {
    await deleteDiscountSteps(ctx, { providerDiscountId: ctx.options.deleteDiscount });
  }
}

// ── replay mode ─────────────────────────────────────────────────────────────

export interface ReplayDelivery {
  headers: Record<string, string>;
  rawBody: string;
}

export function parseReplayFile(text: string): { ok: true; delivery: ReplayDelivery } | { ok: false; error: string } {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    return { ok: false, error: `not valid JSON: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (!json || typeof json !== 'object' || Array.isArray(json)) {
    return { ok: false, error: 'expected a JSON object with "headers" and "rawBody"' };
  }
  const obj = json as Record<string, unknown>;
  if (typeof obj.rawBody !== 'string') {
    return {
      ok: false,
      error:
        obj.body !== undefined
          ? '"rawBody" (a string) is required. A parsed "body" object cannot be re-serialized byte-for-byte, and signatures cover the exact bytes; paste the raw request body as a JSON string.'
          : '"rawBody" (the exact request body, as a string) is required',
    };
  }
  const headers: Record<string, string> = {};
  const raw = obj.headers;
  const put = (name: unknown, value: unknown) => {
    if (typeof name !== 'string' || !name) return false;
    const v = Array.isArray(value) ? value.join(', ') : value;
    if (typeof v !== 'string' && typeof v !== 'number') return false;
    headers[name.toLowerCase()] = String(v);
    return true;
  };
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      const ok = Array.isArray(entry)
        ? put(entry[0], entry[1])
        : entry && typeof entry === 'object'
          ? put((entry as { name?: unknown }).name, (entry as { value?: unknown }).value)
          : false;
      if (!ok) return { ok: false, error: `unreadable header entry: ${JSON.stringify(entry)}` };
    }
  } else if (raw && typeof raw === 'object') {
    for (const [k, val] of Object.entries(raw)) {
      if (!put(k, val)) return { ok: false, error: `header "${k}" must be a string` };
    }
  } else {
    return { ok: false, error: '"headers" must be an object of name → value (or a list of [name, value] pairs)' };
  }
  return { ok: true, delivery: { headers, rawBody: obj.rawBody } };
}

/** Find the signed timestamp a delivery carries, for the schemes in use today. */
export function detectSignatureTimestamp(headers: Headers): { seconds: number; source: string } | undefined {
  const fromHeader = (name: string, re?: RegExp) => {
    const value = headers.get(name);
    if (!value) return undefined;
    const m = re ? re.exec(value) : /^\s*(\d{9,11})\s*$/.exec(value);
    return m ? Number(m[1]) : undefined;
  };
  const candidates: Array<[string, number | undefined]> = [
    ['webhook-timestamp header (Standard Webhooks)', fromHeader('webhook-timestamp')],
    ['t= in Stripe-Signature', fromHeader('stripe-signature', /(?:^|,)\s*t=(\d{9,11})/)],
    ['ts= in Paddle-Signature', fromHeader('paddle-signature', /(?:^|;)\s*ts=(\d{9,11})/)],
    ['t= in X-Gumroad-Signature', fromHeader('x-gumroad-signature', /(?:^|,)\s*t=(\d{9,11})/)],
  ];
  for (const [source, seconds] of candidates) if (seconds !== undefined) return { seconds, source };
  return undefined;
}

/**
 * Run `fn` with Date.now() pinned to `epochMs`. Every verifier in use reads the
 * clock through Date.now() (lib/standard-webhooks, lib/webhook-verify, the
 * Stripe SDK), so this evaluates a captured delivery "as of" its own timestamp.
 */
export async function withPinnedClock<T>(epochMs: number, fn: () => Promise<T>): Promise<T> {
  const realNow = Date.now;
  Date.now = () => epochMs;
  try {
    return await fn();
  } finally {
    Date.now = realNow;
  }
}

/** Flip one alphanumeric character so the secret keeps its format but is wrong. */
export function alterSecret(secret: string): string {
  for (let i = secret.length - 1; i >= 0; i--) {
    const c = secret[i]!;
    if (/[A-Za-z0-9]/.test(c)) {
      const replacement = c === 'A' ? 'B' : c === '0' ? '1' : /[0-9]/.test(c) ? '0' : 'A';
      return secret.slice(0, i) + replacement + secret.slice(i + 1);
    }
  }
  return `${secret}x`;
}

function formatAge(seconds: number): string {
  const s = Math.abs(seconds);
  if (s < 120) return `${Math.round(s)}s`;
  if (s < 7200) return `${Math.round(s / 60)}m`;
  if (s < 172800) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

export function validateRedemption(r: RedemptionEvent): string[] {
  const problems: string[] = [];
  if (!isRealId(r.eventId)) problems.push(`eventId is empty (${JSON.stringify(r.eventId)}): webhook idempotency would collapse every delivery into one`);
  if (!r.code && !r.providerCouponId && !r.providerPromoCodeId) problems.push('no code, providerCouponId or providerPromoCodeId: the redemption cannot be matched to a coupon');
  for (const k of ['chargedAmountCents', 'discountAmountCents', 'taxAmountCents'] as const) {
    const v = r[k];
    if (v != null && (!Number.isInteger(v) || v < 0)) problems.push(`${k} must be a non-negative integer number of minor units or null (got ${JSON.stringify(v)})`);
  }
  // Contract C3 (providers/types.ts): every event states the tax inside the
  // charged amount (0 = none, null = not reported), so revenue saved is pre-tax.
  if (r.taxAmountCents === undefined) problems.push('taxAmountCents is missing: the adapter must state the tax inside chargedAmountCents (0 for none, null if the provider does not report it)');
  if (r.taxAmountCents != null && r.chargedAmountCents != null && r.taxAmountCents > r.chargedAmountCents) {
    problems.push(`taxAmountCents (${r.taxAmountCents}) is larger than chargedAmountCents (${r.chargedAmountCents}): chargedAmountCents must include the tax`);
  }
  if (r.currency !== null && !/^[A-Za-z]{3}$/.test(r.currency)) problems.push(`currency should be a 3-letter ISO code or null (got ${JSON.stringify(r.currency)})`);
  return problems;
}

export interface ReplayArtifacts {
  delivery?: { headerNames: string[]; bodyBytes: number; signatureTimestamp?: number; timestampSource?: string };
  verification?: Array<{ label: string; valid: boolean }>;
  redemption?: RedemptionEvent | null;
}

export async function replayFlow(
  ctx: FlowContext,
  input: { fileText: string; filePath: string; secret: string | null; nowSeconds: number },
): Promise<ReplayArtifacts> {
  const { provider, runner, options, out, profile } = ctx;
  const art: ReplayArtifacts = {};

  let delivery: ReplayDelivery | undefined;
  let headers: Headers | undefined;
  let stamp: { seconds: number; source: string } | undefined;
  const load = await runner.step('load-delivery', async () => {
    const parsed = parseReplayFile(input.fileText);
    if (!parsed.ok) return { status: 'FAIL', detail: `${input.filePath}: ${parsed.error}` };
    delivery = parsed.delivery;
    headers = new Headers(delivery.headers);
    stamp = detectSignatureTimestamp(headers);
    const bodyBytes = new TextEncoder().encode(delivery.rawBody).length;
    art.delivery = {
      headerNames: Object.keys(delivery.headers).sort(),
      bodyBytes,
      ...(stamp ? { signatureTimestamp: stamp.seconds, timestampSource: stamp.source } : {}),
    };
    const when = stamp
      ? `; signed at ${new Date(stamp.seconds * 1000).toISOString()} (${stamp.source}, ${formatAge(input.nowSeconds - stamp.seconds)} ago)`
      : '; no signed timestamp found';
    return { detail: `${Object.keys(delivery.headers).length} header(s), ${bodyBytes}-byte body${when}`, data: art.delivery };
  });
  if (load.status !== 'PASS' || !delivery || !headers) {
    for (const name of ['verify-webhook', 'reject-wrong-secret', 'parse-redemption']) runner.block(name, 'load-delivery failed');
    return art;
  }
  const d = delivery;
  const h = headers;

  // verify-webhook: evaluate now and, for a stale capture, at its own
  // timestamp. Every signed scheme here enforces a ~5-minute replay window, so
  // a capture from an hour ago fails "now" by design; the signature math is
  // what this step is about.
  let validAtMs: number | undefined; // undefined = real clock
  let verified = false;
  if (typeof provider.verifyWebhook !== 'function') {
    runner.skip('verify-webhook', 'unsupported: provider does not implement verifyWebhook()');
  } else {
    await runner.step('verify-webhook', async () => {
      const evaluations: Array<{ label: string; atMs?: number }> = [];
      if (options.at !== undefined) {
        evaluations.push({ label: `at ${new Date(options.at * 1000).toISOString()} (--at)`, atMs: options.at * 1000 + 1000 });
      } else {
        evaluations.push({ label: 'now' });
        if (stamp && Math.abs(input.nowSeconds - stamp.seconds) > 5) {
          evaluations.push({
            label: `at the delivery's timestamp ${new Date(stamp.seconds * 1000).toISOString()}`,
            atMs: stamp.seconds * 1000 + 1000,
          });
        }
      }
      const results: Array<{ label: string; valid: boolean }> = [];
      for (const e of evaluations) {
        const run = () => provider.verifyWebhook!({ rawBody: d.rawBody, headers: h, secret: input.secret });
        const valid = e.atMs !== undefined ? await withPinnedClock(e.atMs, run) : await run();
        results.push({ label: e.label, valid: valid === true });
        if (valid === true && !verified) {
          verified = true;
          validAtMs = e.atMs;
        }
      }
      art.verification = results;
      const summary = results.map((r) => `${r.valid ? 'valid' : 'INVALID'} ${r.label}`).join('; ');
      const staleNote =
        results.length > 1 && !results[0]!.valid && results[1]!.valid
          ? ` (expected for a replay: production rejects deliveries older than its replay window)`
          : '';
      const secretNote = input.secret ? '' : ` [no ${GENERIC_ENV.webhookSecret} set; secret passed as null]`;
      if (!verified) {
        return {
          status: 'FAIL',
          detail:
            `${summary}${secretNote}. Check that ${GENERIC_ENV.webhookSecret} is the signing secret of the endpoint that received this delivery, ` +
            `and that rawBody is byte-for-byte what was sent (no re-formatting, no added newline).`,
          data: { evaluations: results },
        };
      }
      return { detail: `${summary}${staleNote}${secretNote}`, data: { evaluations: results } };
    });
  }

  // reject-wrong-secret: a verifier that returns true for a wrong secret isn't verifying.
  if (typeof provider.verifyWebhook !== 'function') {
    runner.skip('reject-wrong-secret', 'unsupported: provider does not implement verifyWebhook()');
  } else if (!verified) {
    runner.block('reject-wrong-secret', 'verify-webhook did not pass');
  } else if (profile?.unsignedWebhooks) {
    runner.skip(
      'reject-wrong-secret',
      `unsigned by design: ${profile.displayName} deliveries carry no signature; authenticity comes from parseRedemption() re-fetching the sale with the API key`,
    );
  } else if (!input.secret) {
    runner.skip('reject-wrong-secret', 'no secret given, nothing to alter');
  } else {
    const wrong = alterSecret(input.secret);
    await runner.step('reject-wrong-secret', async () => {
      const run = () => provider.verifyWebhook!({ rawBody: d.rawBody, headers: h, secret: wrong });
      const valid = validAtMs !== undefined ? await withPinnedClock(validAtMs, run) : await run();
      return valid === true
        ? { status: 'FAIL', detail: 'verifyWebhook() ACCEPTED a wrong secret: it is not actually checking the signature' }
        : { detail: 'a wrong secret is rejected' };
    });
  }

  // parse-redemption
  if (typeof provider.parseRedemption !== 'function') {
    runner.skip('parse-redemption', 'unsupported: provider does not implement parseRedemption()');
  } else {
    await runner.step('parse-redemption', async () => {
      const r = await provider.parseRedemption!(d.rawBody);
      art.redemption = r;
      if (options.expectNone) {
        return r === null
          ? { detail: 'returned null, as expected (--expect-none)' }
          : { status: 'FAIL', detail: `expected null (--expect-none) but got a redemption: ${JSON.stringify(r)}`, data: { redemption: r } };
      }
      if (r === null) {
        return {
          status: 'FAIL',
          detail:
            'returned null: the delivery was not recognised as a redemption (different event type, unpaid, or no discount applied). ' +
            'If the purchase had no discount, re-run with --expect-none.',
        };
      }
      const problems = validateRedemption(r);
      if (options.expectCode) {
        const want = options.expectCode.toUpperCase();
        const ids = [r.code, r.providerCouponId, r.providerPromoCodeId].filter((x): x is string => !!x);
        if (!ids.some((x) => x.toUpperCase() === want || x.toUpperCase().endsWith(want))) {
          problems.push(`does not match --expect-code ${options.expectCode} (got ${ids.join(', ') || 'no identifiers'})`);
        }
      }
      const fields = [
        `eventId ${r.eventId}`,
        r.code ? `code ${r.code}` : null,
        r.providerCouponId ? `coupon ${r.providerCouponId}` : null,
        r.providerPromoCodeId ? `promo ${r.providerPromoCodeId}` : null,
        r.chargedAmountCents !== null ? `charged ${r.chargedAmountCents}` : null,
        r.discountAmountCents !== null ? `discount ${r.discountAmountCents}` : null,
        r.currency ? `${r.currency}` : null,
      ].filter(Boolean);
      if (problems.length) return { status: 'FAIL', detail: problems.join('; '), data: { redemption: r } };
      return { detail: fields.join(', '), data: { redemption: r } };
    });
    if (art.redemption !== undefined) {
      out.info('');
      out.info(`Parsed redemption:\n${JSON.stringify(art.redemption, null, 2)}`);
    }
  }

  if (options.managedPayments) await managedPaymentsReplaySteps(ctx, d.rawBody);

  return art;
}
