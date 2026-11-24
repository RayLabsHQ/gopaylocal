// ── Argument parsing ────────────────────────────────────────────────────────
// Pure: argv in, validated options (or a usage error) out.

import { parseArgs } from 'node:util';
import { GENERIC_ENV, PROVIDER_PROFILES, normalizeProviderName } from './profiles';
import type { Mode } from './profiles';

export type RunMode = 'help' | 'verify' | 'replay' | 'cleanup' | 'capture';

export interface CliOptions {
  mode: RunMode;
  provider?: string;
  environment: Mode;
  environmentExplicit: boolean;
  allowLive: boolean;
  dryRun: boolean;
  json: boolean;
  /** The output can be read by anyone (CI on a public repository). */
  publicLog: boolean;
  timeoutMs: number;
  // verify and replay, Stripe only (scripts/verify-provider/stripe-managed-payments.ts)
  managedPayments: boolean;
  // verify
  product?: string;
  percent: number;
  successUrl: string;
  webhookUrl?: string;
  printSecret: boolean;
  keep: boolean;
  wait: boolean;
  // replay
  replayFile?: string;
  at?: number; // unix seconds
  expectNone: boolean;
  expectCode?: string;
  // cleanup
  deleteDiscount?: string;
  deleteWebhook?: string;
  // capture
  captureFile?: string;
  port: number;
}

export type ParseResult = { ok: true; options: CliOptions } | { ok: false; error: string };

export const DEFAULT_PERCENT = 17;
export const DEFAULT_SUCCESS_URL = 'https://example.com/gopaylocal-verify/success';
export const DEFAULT_PORT = 8787;
export const DEFAULT_TIMEOUT_SECONDS = 30;

const OPTION_SPEC = {
  help: { type: 'boolean', short: 'h' },
  environment: { type: 'string' },
  'allow-live': { type: 'boolean' },
  'dry-run': { type: 'boolean' },
  json: { type: 'boolean' },
  'public-log': { type: 'boolean' },
  timeout: { type: 'string' },
  'managed-payments': { type: 'boolean' },
  product: { type: 'string' },
  percent: { type: 'string' },
  'success-url': { type: 'string' },
  'webhook-url': { type: 'string' },
  'print-secret': { type: 'boolean' },
  keep: { type: 'boolean' },
  wait: { type: 'boolean' },
  replay: { type: 'string' },
  at: { type: 'string' },
  'expect-none': { type: 'boolean' },
  'expect-code': { type: 'string' },
  'delete-discount': { type: 'string' },
  'delete-webhook': { type: 'string' },
  capture: { type: 'string' },
  port: { type: 'string' },
} as const;

function fail(error: string): ParseResult {
  return { ok: false, error };
}

function parseHttpUrl(value: string, flag: string, httpsOnly: boolean): string | { error: string } {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { error: `${flag} must be an absolute URL (got '${value}')` };
  }
  if (httpsOnly ? url.protocol !== 'https:' : url.protocol !== 'https:' && url.protocol !== 'http:') {
    return { error: `${flag} must be an ${httpsOnly ? 'https' : 'http(s)'} URL (got '${value}')` };
  }
  return url.toString();
}

/**
 * The tool deletes the endpoint it provisions during cleanup, and a provider may
 * adopt an existing subscription with the same URL instead of creating one
 * (Gumroad does). Pointing --webhook-url at a real GoPayLocal endpoint
 * (`{API_BASE_URL}/v1/webhooks/{provider}/{integrationId}`) could therefore
 * delete a live integration's subscription. Refuse it.
 */
function gopaylocalEndpointRefusal(value: string): string | undefined {
  const url = new URL(value);
  const host = url.hostname.toLowerCase();
  if (host === 'gopaylocal.com' || host.endsWith('.gopaylocal.com') || url.pathname.startsWith('/v1/webhooks/')) {
    return (
      `--webhook-url must not be a GoPayLocal webhook endpoint (got '${value}'): cleanup deletes the ` +
      `endpoint it provisions, and some providers adopt an existing subscription with the same URL. ` +
      `Use a dedicated URL, e.g. a tunnel to --capture.`
    );
  }
  return undefined;
}

/** Accepts unix seconds or an ISO-8601 timestamp. */
function parseInstant(value: string): number | undefined {
  if (/^\d{9,11}$/.test(value)) return Number(value);
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : undefined;
}

function runParseArgs(argv: string[]) {
  return parseArgs({ args: argv, options: OPTION_SPEC, allowPositionals: true, strict: true });
}

export function parseCliArgs(argv: string[]): ParseResult {
  let parsed: ReturnType<typeof runParseArgs>;
  try {
    parsed = runParseArgs(argv);
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
  const v = parsed.values;
  const positionals = parsed.positionals;

  if (v.help) {
    return { ok: true, options: baseOptions('help') };
  }
  if (positionals.length > 1) {
    return fail(`expected one provider name, got: ${positionals.join(' ')}`);
  }
  const provider = positionals[0] ? normalizeProviderName(positionals[0]) : undefined;

  const modeFlags = [
    v.replay !== undefined && '--replay',
    (v['delete-discount'] !== undefined || v['delete-webhook'] !== undefined) && '--delete-discount/--delete-webhook',
    v.capture !== undefined && '--capture',
  ].filter(Boolean) as string[];
  if (modeFlags.length > 1) return fail(`${modeFlags.join(' and ')} are separate modes; use one at a time`);

  const mode: RunMode =
    v.replay !== undefined
      ? 'replay'
      : v['delete-discount'] !== undefined || v['delete-webhook'] !== undefined
        ? 'cleanup'
        : v.capture !== undefined
          ? 'capture'
          : 'verify';

  const options = baseOptions(mode);
  options.provider = provider;
  options.allowLive = v['allow-live'] ?? false;
  options.dryRun = v['dry-run'] ?? false;
  options.json = v.json ?? false;
  options.publicLog = v['public-log'] ?? false;

  if (mode !== 'capture' && !provider) {
    return fail(`missing provider name (one of: ${Object.keys(PROVIDER_PROFILES).join(', ')})`);
  }

  if (v.environment !== undefined) {
    if (v.environment !== 'test' && v.environment !== 'live') {
      return fail(`--environment must be 'test' or 'live' (got '${v.environment}')`);
    }
    options.environment = v.environment;
    options.environmentExplicit = true;
  }
  if (options.environment === 'live' && !options.allowLive) {
    return fail('--environment live requires --allow-live');
  }

  if (v.timeout !== undefined) {
    const seconds = Number(v.timeout);
    if (!Number.isFinite(seconds) || seconds <= 0) return fail(`--timeout must be a positive number of seconds`);
    options.timeoutMs = Math.round(seconds * 1000);
  }

  // Flags that only make sense in one mode — reject them elsewhere so a typo'd
  // invocation doesn't silently do something else.
  const verifyOnly: Array<[keyof typeof v, string]> = [
    ['product', '--product'],
    ['percent', '--percent'],
    ['success-url', '--success-url'],
    ['webhook-url', '--webhook-url'],
    ['print-secret', '--print-secret'],
    ['keep', '--keep'],
    ['wait', '--wait'],
  ];
  const replayOnly: Array<[keyof typeof v, string]> = [
    ['at', '--at'],
    ['expect-none', '--expect-none'],
    ['expect-code', '--expect-code'],
  ];
  const captureOnly: Array<[keyof typeof v, string]> = [['port', '--port']];
  const misplaced = (list: Array<[keyof typeof v, string]>, allowed: RunMode) =>
    mode === allowed ? [] : list.filter(([k]) => v[k] !== undefined).map(([, flag]) => flag);
  const wrong = [
    ...misplaced(verifyOnly, 'verify'),
    ...misplaced(replayOnly, 'replay'),
    ...misplaced(captureOnly, 'capture'),
  ];
  if (wrong.length) return fail(`${wrong.join(', ')} not valid with this mode (${mode})`);

  switch (mode) {
    case 'verify': {
      if (v.product !== undefined) {
        if (!v.product.trim()) return fail('--product must not be empty');
        options.product = v.product.trim();
      }
      if (v.percent !== undefined) {
        const pct = Number(v.percent);
        if (!Number.isInteger(pct) || pct < 1 || pct > 100) return fail('--percent must be a whole number from 1 to 100');
        options.percent = pct;
      }
      if (v['success-url'] !== undefined) {
        const url = parseHttpUrl(v['success-url'], '--success-url', false);
        if (typeof url !== 'string') return fail(url.error);
        options.successUrl = url;
      }
      if (v['webhook-url'] !== undefined) {
        const url = parseHttpUrl(v['webhook-url'], '--webhook-url', true);
        if (typeof url !== 'string') return fail(url.error);
        const refusal = gopaylocalEndpointRefusal(url);
        if (refusal) return fail(refusal);
        options.webhookUrl = url;
      }
      options.printSecret = v['print-secret'] ?? false;
      if (options.printSecret && !options.webhookUrl) return fail('--print-secret needs --webhook-url');
      options.keep = v.keep ?? false;
      options.wait = v.wait ?? false;
      if (options.keep && options.wait) return fail('--keep and --wait are alternatives; pick one');
      break;
    }
    case 'replay': {
      if (!v.replay?.trim()) return fail('--replay needs a file path');
      options.replayFile = v.replay.trim();
      if (v.at !== undefined) {
        const at = parseInstant(v.at);
        if (at === undefined) return fail(`--at must be unix seconds or an ISO-8601 time (got '${v.at}')`);
        options.at = at;
      }
      options.expectNone = v['expect-none'] ?? false;
      options.expectCode = v['expect-code']?.trim() || undefined;
      if (options.expectNone && options.expectCode) return fail('--expect-none and --expect-code contradict each other');
      break;
    }
    case 'cleanup': {
      options.deleteDiscount = v['delete-discount']?.trim() || undefined;
      options.deleteWebhook = v['delete-webhook']?.trim() || undefined;
      if (!options.deleteDiscount && !options.deleteWebhook) return fail('--delete-discount / --delete-webhook need an id');
      break;
    }
    case 'capture': {
      if (!v.capture?.trim()) return fail('--capture needs an output file path');
      options.captureFile = v.capture.trim();
      if (v.port !== undefined) {
        const port = Number(v.port);
        if (!Number.isInteger(port) || port < 1 || port > 65535) return fail('--port must be 1-65535');
        options.port = port;
      }
      if (options.dryRun) return fail('--dry-run does not apply to --capture');
      break;
    }
  }

  options.managedPayments = v['managed-payments'] ?? false;
  if (options.managedPayments) {
    if (mode !== 'verify' && mode !== 'replay') return fail(`--managed-payments not valid with this mode (${mode})`);
    if (provider !== 'stripe') return fail('--managed-payments is Stripe-only (Stripe Managed Payments)');
    if (mode === 'verify' && !options.product) {
      return fail('--managed-payments needs --product <price_... or prod_...> whose product has an eligible tax code');
    }
  }

  return { ok: true, options };
}

function baseOptions(mode: RunMode): CliOptions {
  return {
    mode,
    environment: 'test',
    environmentExplicit: false,
    allowLive: false,
    dryRun: false,
    json: false,
    publicLog: false,
    timeoutMs: DEFAULT_TIMEOUT_SECONDS * 1000,
    managedPayments: false,
    percent: DEFAULT_PERCENT,
    successUrl: DEFAULT_SUCCESS_URL,
    printSecret: false,
    keep: false,
    wait: false,
    expectNone: false,
    port: DEFAULT_PORT,
  };
}

export function helpText(): string {
  const accountVars = Object.entries(PROVIDER_PROFILES)
    .filter(([, p]) => p.accountId)
    .map(([name, p]) => `      ${p.accountId!.env.padEnd(24)} ${name}: ${p.accountId!.label}`)
    .join('\n');
  const checkoutIds = Object.entries(PROVIDER_PROFILES)
    .map(([name, p]) => `      ${name.padEnd(14)} ${p.checkoutId}`)
    .join('\n');
  return `Verify a GoPayLocal payment-provider integration against YOUR OWN sandbox account,
using the same provider code the API runs (src/services/providers).

Usage:
  pnpm --filter @gopaylocal/api verify:provider <provider> [flags]           run the checks
  pnpm --filter @gopaylocal/api verify:provider <provider> --replay <file>   check a captured webhook
  pnpm --filter @gopaylocal/api verify:provider --capture <file>             receive one webhook into <file>
  pnpm --filter @gopaylocal/api verify:provider <provider> --delete-discount <id> | --delete-webhook <id>

Providers:
  ${Object.keys(PROVIDER_PROFILES).join(', ')} (alias: dodo)
  Any other provider registered in src/services/providers/index.ts also runs, but
  needs --allow-live until it has an entry in scripts/verify-provider/profiles.ts.

Credentials (environment variables only; never flags, never files):
  ${GENERIC_ENV.apiKey.padEnd(26)} API key / access token (required)
  ${GENERIC_ENV.accountId.padEnd(26)} account id, if the provider needs one; or the specific name:
${accountVars}
  ${GENERIC_ENV.webhookSecret.padEnd(26)} webhook signing secret (only for --replay)

Checks, in order (each PASS / FAIL / SKIPPED / BLOCKED):
  list-products      listProducts()                          SKIPPED if the provider has none
  create-discount    createDiscount() with a throwaway code  e.g. VERIFY-ZZ17-K7QX
  list-discounts     listDiscounts() contains it, same percent
  checkout-url       buildCheckoutUrl(--product)             printed for a manual test purchase
  provision-webhook  provisionWebhook(--webhook-url)         only with --webhook-url
  delete-webhook     deleteWebhook()                         cleanup, always runs
  delete-discount    deleteDiscount()                        cleanup, always runs
  confirm-deleted    listDiscounts() no longer contains it
Cleanup runs even when a check fails or you press Ctrl-C (press twice to abort cleanup).

Flags:
  --product <id>        id to build a checkout URL for. What it must be:
${checkoutIds}
                        Required for providers without a sandbox (${Object.entries(PROVIDER_PROFILES)
                          .filter(([, p]) => p.scopeDiscountToProduct)
                          .map(([n]) => n)
                          .join(', ')}), whose throwaway
                        discount is then scoped to that product.
  --percent <n>         discount percent, 1-100 (default ${DEFAULT_PERCENT})
  --success-url <url>   checkout success URL (default ${DEFAULT_SUCCESS_URL})
  --webhook-url <url>   public https URL to provision a webhook endpoint at. Use a URL that
                        exists only for this test (e.g. a tunnel to --capture); cleanup
                        deletes the endpoint, and Gumroad adopts an existing subscription
                        with the same URL. GoPayLocal endpoints (*.gopaylocal.com,
                        /v1/webhooks/...) are refused.
  --print-secret        print the provisioned webhook's signing secret (stderr, never JSON)
  --wait                pause before cleanup so you can complete the test purchase
  --keep                skip cleanup; prints the commands to delete things later
  --managed-payments    Stripe only, needs --product: runs the Stripe Managed Payments probes
                        (mp-session, mp-promotion-code, mp-coupon, mp-customer-code) in place
                        of checkout-url. With --replay it adds mp-delivery. See the guide.
  --environment <env>   test (default) or live
  --allow-live          permit a run the tool cannot confirm is test/sandbox
  --dry-run             resolve config, apply the live-mode guard, construct the provider,
                        print the plan; no API calls
  --json                print one JSON report on stdout (progress goes to stderr);
                        use \`pnpm -s ...\` so pnpm's banner doesn't precede it
  --public-log          for output anyone can read (CI on a public repository): prints no
                        part of a key, no product names or prices, no checkout link and
                        no account name or store host
  --timeout <seconds>   per-call timeout (default ${DEFAULT_TIMEOUT_SECONDS})

Replay flags (--replay <file>: JSON {"headers": {...}, "rawBody": "..."}):
  --at <time>           evaluate the signature at this time (unix seconds or ISO); default:
                        both now and the delivery's own timestamp, when one is found
  --expect-code <code>  require the parsed redemption to match this code or discount id
  --expect-none         require parseRedemption() to return null (a non-discounted delivery)

Capture flags (--capture <file>):
  --port <n>            local port to listen on (default ${DEFAULT_PORT}); expose it with a tunnel

Exit status: 0 all checks passed or skipped, 1 a check failed, 2 usage/config error or
refused (live-mode guard), 130 interrupted. pnpm reports every non-zero status as 1;
read "ok" / "refused" in the --json report, or run the script with node directly
(see the verify:provider entry in apps/api/package.json) to see the real status.

Guide: apps/api/PROVIDER_VERIFICATION.md`;
}
