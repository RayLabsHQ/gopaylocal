// ── verify-provider: orchestration ──────────────────────────────────────────
// main() takes every side effect as a dependency, so tests drive it end to end
// with a fake provider. The CLI entry (scripts/verify-provider.ts) wires in the
// real provider factory, the network guard and the process.

import type { PaymentProvider, ProviderConfig } from '../../src/services/providers/types';
import { helpText, parseCliArgs } from './args';
import type { CliOptions } from './args';
import type { CaptureHandle, CaptureOptions, CapturedDelivery } from './capture';
import type { RandomBytes } from './code';
import { capabilities, cleanupFlow, replayFlow, verifyFlow } from './flows';
import type { FlowContext, Output } from './flows';
import { normalizeHost } from './network-guard';
import type { NetworkGuard, NetworkGuardOptions } from './network-guard';
import { GENERIC_ENV, PROVIDER_PROFILES, resolveAccountId } from './profiles';
import type { ProviderProfile } from './profiles';
import { exitCodeFor, formatStepLine, formatSummaryTable } from './report';
import type { JsonReport } from './report';
import { StepRunner, describeError, runWithCleanup, summarize } from './runner';
import { managedPaymentsPlan } from './stripe-managed-payments';
import { Redactor, decideMode, hidden, mask } from './safety';
import type { ModeDecision } from './safety';

export interface MainDeps {
  env: Record<string, string | undefined>;
  createProvider: (name: string, config: ProviderConfig) => PaymentProvider;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  readFile: (path: string) => Promise<string>;
  /** Write a new file (must fail if it exists), owner-only permissions. */
  writeNewFile: (path: string, contents: string) => Promise<void>;
  fileExists: (path: string) => Promise<boolean>;
  /** Resolve a user-supplied path against the directory the user ran pnpm from. */
  resolvePath: (path: string) => string;
  waitForEnter: (prompt: string) => Promise<void>;
  /** Register a Ctrl-C handler; returns an unsubscribe function. */
  onInterrupt: (handler: () => void) => () => void;
  /** Hard exit (second Ctrl-C). */
  exit: (code: number) => void;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  commit: () => string | null;
  nodeVersion: string;
  installNetworkGuard?: (opts: NetworkGuardOptions) => NetworkGuard;
  captureOnce?: (opts: CaptureOptions) => CaptureHandle;
  randomBytes?: RandomBytes;
}

const EXIT_USAGE = 2;

export async function main(argv: string[], deps: MainDeps): Promise<number> {
  const parsed = parseCliArgs(argv);
  if (!parsed.ok) {
    deps.stderr(`error: ${parsed.error}\nRun with --help for usage.`);
    return EXIT_USAGE;
  }
  const options = parsed.options;
  if (options.mode === 'help') {
    deps.stdout(helpText());
    return 0;
  }

  const redactor = new Redactor({ hideAll: options.publicLog });
  const show = options.publicLog ? hidden : mask;
  // Human output goes to stdout; with --json, stdout carries only the report.
  const progress = options.json ? deps.stderr : deps.stdout;
  const out: Output = {
    info: (line) => progress(redactor.redact(line)),
    warn: (line) => deps.stderr(redactor.redact(`warning: ${line}`)),
    secret: (label, value) => deps.stderr(`${label}:\n  ${value}`),
  };

  if (options.mode === 'capture') return runCapture(options, deps, out);

  const startedAt = new Date(deps.now()).toISOString();
  const providerName = options.provider!;
  const profile = PROVIDER_PROFILES[providerName];

  // ── credentials (env only) ───────────────────────────────────────────────
  const apiKey = deps.env[GENERIC_ENV.apiKey]?.trim() || undefined;
  const webhookSecret = deps.env[GENERIC_ENV.webhookSecret]?.trim() || undefined;
  redactor.add(apiKey);
  redactor.add(webhookSecret);
  const account = resolveAccountId(profile, deps.env);
  // The account name can be part of a host ({site}.chargebee.com) or be a
  // store's URL; neither belongs in a log anyone can read.
  if (options.publicLog) redactor.addAccount(account.value);

  const problems: string[] = [];
  if (account.conflict) problems.push(account.conflict);
  if (!apiKey && options.mode !== 'replay') problems.push(`${GENERIC_ENV.apiKey} is not set`);
  if (profile?.accountId?.required && !account.value) {
    problems.push(
      `${profile.accountId.env} is not set (${profile.displayName} needs its ${profile.accountId.label}; ${GENERIC_ENV.accountId} also works)`,
    );
  }
  if (profile?.scopeDiscountToProduct && options.mode === 'verify' && !options.product) {
    problems.push(
      `--product is required for ${providerName}: ${profile.displayName} has no sandbox, so the throwaway ` +
        `discount is scoped to that one product instead of every product in your store`,
    );
  }
  if (options.mode === 'replay' && !webhookSecret && !profile?.unsignedWebhooks) {
    out.warn(`${GENERIC_ENV.webhookSecret} is not set; verifyWebhook() will receive secret = null.`);
  }
  if (problems.length) {
    deps.stderr(`error: ${problems.join('\n       ')}\nSee --help or apps/api/PROVIDER_VERIFICATION.md.`);
    return EXIT_USAGE;
  }

  // ── live-mode guard ──────────────────────────────────────────────────────
  const decision = decide(options, providerName, profile, apiKey, account.value);

  out.info(
    [
      `GoPayLocal provider verification: ${profile?.displayName ?? providerName} (${options.mode}${options.dryRun ? ', dry run' : ''})`,
      `  mode:        ${decision.effective.toUpperCase()}: ${decision.basis}`,
      `  api key:     ${show(apiKey)} (${GENERIC_ENV.apiKey})`,
      ...(account.value ? [`  account id:  ${account.value} (${account.source})`] : []),
      ...(options.mode === 'replay' ? [`  secret:      ${show(webhookSecret)} (${GENERIC_ENV.webhookSecret})`] : []),
      `  code:        ${deps.commit() ?? 'unknown commit'}, node ${deps.nodeVersion}`,
    ].join('\n'),
  );

  const runner = new StepRunner({
    timeoutMs: options.timeoutMs,
    onResult: (r) => out.info(formatStepLine(r)),
    clock: deps.now,
  });
  const artifacts: Record<string, unknown> = {};

  const finish = (caps: Record<string, boolean> | null, refused: string | null): number => {
    const results = runner.results;
    const code = refused ? EXIT_USAGE : exitCodeFor(results, runner.isInterrupted);
    if (options.json) {
      const report: JsonReport = {
        tool: 'gopaylocal-verify-provider',
        schemaVersion: 1,
        provider: providerName,
        mode: options.mode,
        dryRun: options.dryRun,
        environment: { effective: decision.effective, basis: decision.basis, allowLive: options.allowLive },
        refused,
        commit: deps.commit(),
        node: deps.nodeVersion,
        startedAt,
        finishedAt: new Date(deps.now()).toISOString(),
        capabilities: caps,
        steps: results,
        artifacts,
        summary: summarize(results),
        ok: code === 0,
      };
      deps.stdout(JSON.stringify(redactor.redactDeep(report), null, 2));
    } else if (!refused) {
      out.info('');
      out.info(
        formatSummaryTable(
          `Summary: ${providerName} ${options.mode}${options.dryRun ? ' (dry run)' : ''}, ${decision.effective.toUpperCase()}`,
          results,
        ),
      );
    }
    return code;
  };

  if (!decision.allowed) {
    deps.stderr(redactor.redact(`refused: ${decision.refusal}`));
    return finish(null, decision.refusal ?? 'refused');
  }

  // ── network guard: in a TEST run, refuse connections to live hosts; for a
  // provider on the merchant's own host, refuse every other host ────────────
  const allowOnly = profile?.allowOnlyAccountHost ? accountHostRules(account.value) : undefined;
  const guard = deps.installNetworkGuard?.({
    block: decision.effective === 'test' ? (profile?.liveHosts ?? []) : [],
    ...(allowOnly ? { allowOnly } : {}),
    reason: allowOnly
      ? `${profile?.displayName ?? providerName} credentials may only be sent to the store's own host (${allowOnly.join(', ') || 'none: the account id is not a URL'})`
      : `this run is in TEST mode and ${profile?.displayName ?? providerName} serves live data from this host`,
  });
  let caps: Record<string, boolean> | null = null;
  let initFailed = false;
  try {
    const outcome = await runWithProvider({
      options,
      deps,
      out,
      redactor,
      runner,
      artifacts,
      providerName,
      profile,
      decision,
      apiKey,
      accountId: account.value,
      webhookSecret,
    });
    caps = outcome.caps;
    initFailed = outcome.initFailed;
  } finally {
    guard?.restore();
  }

  if (guard) {
    artifacts.network = {
      hostsContacted: [...guard.hosts].sort(),
      blocked: [...guard.blocked],
      ...(allowOnly ? { allowedOnly: allowOnly } : {}),
    };
    if (guard.blocked.length && allowOnly) {
      runner.fail(
        'network-guard',
        `refused ${guard.blocked.length} connection(s) to ${[...new Set(guard.blocked)].join(', ')}: ` +
          `only the store's own host (${allowOnly.join(', ') || 'none'}) may receive the credentials. ` +
          'That is a provider bug; nothing was sent to those hosts.',
      );
    } else if (guard.blocked.length) {
      runner.fail(
        'network-guard',
        `refused ${guard.blocked.length} connection(s) to live host(s) ${[...new Set(guard.blocked)].join(', ')} during a TEST run: ` +
          `the provider ignored environment '${decision.providerEnvironment}'. That is a provider bug; nothing was sent to those hosts.`,
      );
    }
    if (guard.hosts.size) out.info(`\nHosts contacted: ${[...guard.hosts].sort().join(', ')}`);
  }
  const code = finish(caps, null);
  return initFailed ? EXIT_USAGE : code;
}

/** The account id's host, for a provider whose API is the merchant's own site. */
function accountHostRules(accountId: string | undefined): string[] {
  if (!accountId) return [];
  try {
    return [normalizeHost(new URL(accountId).hostname)];
  } catch {
    return []; // not a URL: refuse every host
  }
}

function decide(
  options: CliOptions,
  providerName: string,
  profile: ProviderProfile | undefined,
  apiKey: string | undefined,
  accountId: string | undefined,
): ModeDecision {
  if (options.mode === 'replay' && !apiKey) {
    return {
      allowed: true,
      effective: 'unknown',
      providerEnvironment: options.environment,
      basis: `no ${GENERIC_ENV.apiKey}: the replay makes no authenticated API calls (Gumroad parsing needs one)`,
    };
  }
  return decideMode({
    provider: providerName,
    profile,
    apiKey,
    accountId,
    requested: options.environment,
    requestedExplicit: options.environmentExplicit,
    allowLive: options.allowLive,
  });
}

interface RunInput {
  options: CliOptions;
  deps: MainDeps;
  out: Output;
  redactor: Redactor;
  runner: StepRunner;
  artifacts: Record<string, unknown>;
  providerName: string;
  profile: ProviderProfile | undefined;
  decision: ModeDecision;
  apiKey: string | undefined;
  accountId: string | undefined;
  webhookSecret: string | undefined;
}

/** Construct the provider through the production factory and run the mode's flow. */
async function runWithProvider(input: RunInput): Promise<{ caps: Record<string, boolean> | null; initFailed: boolean }> {
  const { options, deps, out, runner, artifacts, providerName, profile, decision } = input;
  const config: ProviderConfig = {
    apiKey: input.apiKey ?? '',
    environment: decision.providerEnvironment,
    // Same mapping as providerConfigFor() in src/services/providers/index.ts.
    siteId: input.accountId,
  };
  let provider: PaymentProvider;
  try {
    provider = deps.createProvider(providerName, config);
  } catch (err) {
    runner.fail('init', `createProvider('${providerName}') threw: ${describeError(err)}`, err);
    return { caps: null, initFailed: true };
  }
  const caps = capabilities(provider);
  await runner.step('init', async () => {
    const missing = Object.entries(caps).filter(([, v]) => !v).map(([k]) => k);
    const data = { capabilities: caps };
    if (provider.name !== providerName) {
      return { status: 'FAIL', detail: `provider.name is '${provider.name}', expected '${providerName}'`, data };
    }
    return {
      detail:
        `createProvider('${providerName}', environment '${config.environment}') → ${provider.constructor?.name ?? 'provider'}` +
        (missing.length ? `; does not implement: ${missing.join(', ')}` : '; implements every optional method'),
      data,
    };
  });

  if (options.dryRun) {
    dryRunPlan(options, runner, caps, profile);
    return { caps, initFailed: false };
  }

  const ctx: FlowContext = {
    providerName,
    provider,
    profile,
    options,
    runner,
    out,
    redactor: input.redactor,
    sleep: deps.sleep,
    waitForEnter: deps.waitForEnter,
    randomBytes: deps.randomBytes,
  };

  let interrupts = 0;
  const unsubscribe = deps.onInterrupt(() => {
    interrupts++;
    if (interrupts === 1) {
      runner.interrupt();
      out.warn('interrupted: finishing the current call, then cleaning up. Press Ctrl-C again to exit at once (skips cleanup).');
      return;
    }
    const left = runner.pendingCleanups.map((c) => `  - ${c.name}: ${c.keepHint}`);
    out.warn(`exiting without cleanup.${left.length ? ` Left behind:\n${left.join('\n')}` : ''}`);
    deps.exit(130);
  });

  try {
    await runWithCleanup(
      runner,
      async () => {
        if (options.mode === 'verify') {
          const art = await verifyFlow(ctx);
          if (art.discount) artifacts.discount = art.discount;
          if (art.checkoutUrl && !options.publicLog) artifacts.checkoutUrl = art.checkoutUrl;
          // The secret itself never goes into the report.
          if (art.webhook) artifacts.webhook = { endpointId: art.webhook.endpointId, hasSecret: art.webhook.hasSecret };
        } else if (options.mode === 'cleanup') {
          await cleanupFlow(ctx);
        } else if (options.mode === 'replay') {
          const filePath = deps.resolvePath(options.replayFile!);
          let fileText: string;
          try {
            fileText = await deps.readFile(filePath);
          } catch (err) {
            runner.fail('load-delivery', `cannot read ${filePath}: ${describeError(err)}`, err);
            return;
          }
          const art = await replayFlow(ctx, {
            fileText,
            filePath,
            secret: input.webhookSecret ?? null,
            nowSeconds: Math.floor(deps.now() / 1000),
          });
          Object.assign(artifacts, art);
        }
      },
      () => ({ keep: options.keep }),
    );
  } finally {
    unsubscribe();
  }
  return { caps, initFailed: false };
}

function dryRunPlan(
  options: CliOptions,
  runner: StepRunner,
  caps: Record<string, boolean>,
  profile: ProviderProfile | undefined,
): void {
  const checkoutId = profile?.checkoutId;
  const plan = (name: string, supported: boolean, requested: boolean, call: string, notRequested?: string) => {
    if (!supported) runner.skip(name, `unsupported: provider does not implement ${call}`);
    else if (!requested) runner.skip(name, `not requested${notRequested ? `: ${notRequested}` : ''}`);
    else runner.skip(name, `dry run: would call ${call}`);
  };
  if (options.mode === 'verify') {
    plan('list-products', caps.listProducts!, true, 'listProducts()');
    plan(
      'create-discount',
      true,
      true,
      `createDiscount() for ${options.percent}% with a VERIFY-… code` +
        (profile?.scopeDiscountToProduct && options.product ? `, scoped to product ${options.product}` : ''),
    );
    plan('list-discounts', true, true, 'listDiscounts()');
    if (options.managedPayments) {
      for (const p of managedPaymentsPlan('verify', options)) plan(p.name, true, true, p.call);
    } else {
      plan('checkout-url', true, !!options.product, `buildCheckoutUrl('${options.product}')`, `pass --product <${checkoutId ?? 'id'}>`);
    }
    plan('provision-webhook', caps.provisionWebhook!, !!options.webhookUrl, `provisionWebhook('${options.webhookUrl}')`, 'pass --webhook-url');
    plan('delete-webhook', caps.deleteWebhook!, !!options.webhookUrl && !options.keep, 'deleteWebhook()', options.keep ? '--keep' : 'no webhook provisioned');
    plan('delete-discount', true, !options.keep, 'deleteDiscount()', '--keep');
  } else if (options.mode === 'cleanup') {
    plan('delete-webhook', caps.deleteWebhook!, !!options.deleteWebhook, `deleteWebhook('${options.deleteWebhook}')`);
    plan('delete-discount', true, !!options.deleteDiscount, `deleteDiscount('${options.deleteDiscount}')`);
  } else if (options.mode === 'replay') {
    plan('verify-webhook', caps.verifyWebhook!, true, `verifyWebhook() on ${options.replayFile}`);
    plan('parse-redemption', caps.parseRedemption!, true, 'parseRedemption()');
    if (options.managedPayments) {
      for (const p of managedPaymentsPlan('replay', options)) plan(p.name, true, true, p.call);
    }
  }
}

/**
 * With a provider name (`verify:provider woocommerce --capture …`), a delivery
 * the provider's isHandshake() recognises doesn't use up the one capture.
 * WooCommerce sends an unsigned ping while each webhook is created, before any
 * order. The provider is built only for that check, without the API key (the
 * check reads only the delivery), and makes no API calls.
 */
function handshakeFilter(
  options: CliOptions,
  deps: MainDeps,
  out: Output,
): ((delivery: CapturedDelivery) => boolean) | undefined {
  const name = options.provider;
  if (!name) return undefined;
  let provider: PaymentProvider;
  try {
    provider = deps.createProvider(name, {
      apiKey: '',
      environment: options.environment,
      siteId: resolveAccountId(PROVIDER_PROFILES[name], deps.env).value,
    });
  } catch (err) {
    out.warn(
      `could not construct ${name} to recognise setup pings (${describeError(err)}); ` +
        `the first delivery is captured, whatever it is`,
    );
    return undefined;
  }
  const isHandshake = provider.isHandshake?.bind(provider);
  if (!isHandshake) return undefined;
  return (d) => isHandshake({ rawBody: d.rawBody, headers: new Headers(d.headers) });
}

async function runCapture(options: CliOptions, deps: MainDeps, out: Output): Promise<number> {
  if (!deps.captureOnce) {
    deps.stderr('error: capture is not available in this environment');
    return EXIT_USAGE;
  }
  const file = deps.resolvePath(options.captureFile!);
  if (await deps.fileExists(file)) {
    deps.stderr(`error: ${file} already exists; choose a new file name (captures are never overwritten)`);
    return EXIT_USAGE;
  }
  // Check the directory now: finding out after the one delivery arrived would lose it.
  const dir = file.replace(/[/\\][^/\\]*$/, '') || '/';
  if (!(await deps.fileExists(dir))) {
    deps.stderr(`error: directory ${dir} does not exist; create it first (mkdir -p '${dir}')`);
    return EXIT_USAGE;
  }
  const handle = deps.captureOnce({
    port: options.port,
    skip: handshakeFilter(options, deps, out),
    onSkip: (d) =>
      out.info(
        `Skipped a setup ping (${d.method} ${d.path}, ${new TextEncoder().encode(d.rawBody).length}-byte body): ` +
          `${options.provider} recognises it as a handshake, not an event. Still waiting for a delivery.`,
      ),
  });
  handle.done.catch(() => {}); // surfaced via the awaits below
  let port: number;
  try {
    ({ port } = await handle.listening);
  } catch (err) {
    deps.stderr(`error: cannot listen on 127.0.0.1:${options.port}: ${describeError(err)}`);
    return EXIT_USAGE;
  }
  out.info(
    [
      `Listening on http://127.0.0.1:${port} for ONE webhook delivery (Ctrl-C to stop).`,
      `Expose this port through an HTTPS tunnel, then pass the tunnel URL as --webhook-url`,
      `in a second terminal, e.g.:`,
      `  pnpm --filter @gopaylocal/api verify:provider <provider> --product <id> --webhook-url https://<tunnel-host>/hook --print-secret --wait`,
    ].join('\n'),
  );
  const unsubscribe = deps.onInterrupt(() => handle.close());
  try {
    let delivery: Awaited<CaptureHandle['done']>;
    try {
      delivery = await handle.done;
    } catch (err) {
      deps.stderr(`capture stopped: ${describeError(err)}`);
      return 130;
    }
    const json = `${JSON.stringify(delivery, null, 2)}\n`;
    try {
      await deps.writeNewFile(file, json);
    } catch (err) {
      // Don't lose the one delivery: hand it over on stdout instead.
      deps.stderr(`error: could not write ${file}: ${describeError(err)}\nThe delivery follows on stdout; save it to a file to replay it.`);
      deps.stdout(json);
      return 1;
    }
    out.info(
      `Captured ${delivery.method} ${delivery.path}: ${Object.keys(delivery.headers).length} header(s), ` +
        `${new TextEncoder().encode(delivery.rawBody).length}-byte body → ${file}\n` +
        `The file holds the delivery's headers and payload (test-mode customer data; for Chargebee, the endpoint's Basic-auth credentials). ` +
        `Don't commit or publish it. Next: GPL_VERIFY_WEBHOOK_SECRET=... verify:provider <provider> --replay ${options.captureFile}`,
    );
    return 0;
  } finally {
    unsubscribe();
  }
}
