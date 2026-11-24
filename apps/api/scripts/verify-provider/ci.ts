/**
 * Runs verify:provider for ONE provider without a person at the keyboard and
 * writes a short report. Used by .github/workflows/provider-checks.yml (every
 * night, and on demand); it also runs locally.
 *
 *   VERIFY_PROVIDER=stripe GPL_VERIFY_API_KEY=sk_test_... VERIFY_PRODUCT=price_... \
 *     pnpm --filter @gopaylocal/api verify:provider:ci
 *
 * Input, all from environment variables:
 *   VERIFY_PROVIDER        provider id (stripe, paddle, ...)
 *   GPL_VERIFY_API_KEY     the sandbox API key. Empty or unset: the provider is
 *                          reported as "not set up" and the run succeeds, so a
 *                          provider without an account never fails the night.
 *   GPL_VERIFY_ACCOUNT_ID  Chargebee site name, WooCommerce store URL, Whop company id
 *   VERIFY_PRODUCT         product or price id, passed as --product
 *   VERIFY_REAL_ACCOUNT    "true" for providers with no sandbox (passes --allow-live)
 *   VERIFY_DRY_RUN         "true" passes --dry-run: checks the settings, calls no API
 *   GITHUB_STEP_SUMMARY    file to append the Markdown report to (set by GitHub Actions)
 *
 * Exit status: 0 passed or not set up, 1 anything else.
 *
 * The report can be public (a public repository's workflow logs are), so the
 * tool always runs with --public-log: check names, results and counts, and
 * nothing of the account's contents (no part of a key, no product names,
 * prices or ids, no discount code, no checkout link, no account name or store
 * host).
 */

import { spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PROVIDER_PROFILES, normalizeProviderName } from './profiles';
import type { JsonReport } from './report';

type Env = Record<string, string | undefined>;

export type CiPlan =
  | { kind: 'usage'; message: string }
  | { kind: 'not-set-up'; provider: string; secretName: string }
  | { kind: 'run'; provider: string; args: string[] };

const set = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
};

/** The repository secret that turns a provider's check on. */
export function apiKeySecretName(provider: string): string {
  return `VERIFY_${provider.toUpperCase()}_API_KEY`;
}

export function planRun(env: Env): CiPlan {
  const raw = set(env.VERIFY_PROVIDER);
  if (!raw) return { kind: 'usage', message: 'VERIFY_PROVIDER is not set.' };
  const provider = normalizeProviderName(raw);
  if (!PROVIDER_PROFILES[provider]) {
    return {
      kind: 'usage',
      message: `Unknown provider '${raw}'. Known: ${Object.keys(PROVIDER_PROFILES).join(', ')}.`,
    };
  }
  if (!set(env.GPL_VERIFY_API_KEY)) {
    return { kind: 'not-set-up', provider, secretName: apiKeySecretName(provider) };
  }
  const args = [provider, '--json', '--public-log'];
  const product = set(env.VERIFY_PRODUCT);
  if (product) args.push('--product', product);
  if (set(env.VERIFY_REAL_ACCOUNT) === 'true') args.push('--allow-live');
  if (set(env.VERIFY_DRY_RUN) === 'true') args.push('--dry-run');
  return { kind: 'run', provider, args };
}

export function displayName(provider: string): string {
  return PROVIDER_PROFILES[provider]?.displayName ?? provider;
}

const cell = (text: string, max = 200): string => {
  const oneLine = text.replace(/\s+/g, ' ').trim().replace(/\|/g, '\\|');
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
};

export function renderNotSetUp(provider: string, secretName: string): string {
  return [
    `### ${displayName(provider)}: not set up`,
    '',
    `No sandbox key yet. Add the repository secret \`${secretName}\` to turn this check on.`,
    'apps/api/PROVIDER_VERIFICATION.md says which account and key each provider needs.',
    '',
  ].join('\n');
}

export function renderReport(provider: string, report: JsonReport): string {
  const failed = report.steps.filter((s) => s.status === 'FAIL').length;
  const blocked = report.steps.filter((s) => s.status === 'BLOCKED').length;
  let verdict: string;
  if (report.refused) verdict = 'refused to run';
  else if (!report.ok) verdict = `FAILED (${failed} failed${blocked ? `, ${blocked} blocked` : ''})`;
  else if (report.dryRun) verdict = 'settings accepted (dry run, no API calls)';
  else verdict = 'passed';

  const lines = [`### ${displayName(provider)}: ${verdict}`, ''];
  if (report.refused) lines.push(cell(report.refused, 600), '');
  if (report.steps.length > 0) {
    lines.push('| Check | Result | Time | Detail |', '|---|---|---|---|');
    for (const step of report.steps) {
      const seconds = step.durationMs >= 100 ? `${(step.durationMs / 1000).toFixed(1)}s` : '';
      lines.push(`| ${cell(step.name)} | ${step.status} | ${seconds} | ${cell(step.detail)} |`);
    }
    lines.push('');
  }
  if (report.environment) {
    lines.push(`Ran against: ${report.environment.effective} (${cell(report.environment.basis, 300)}).`);
  }
  if (report.commit) lines.push(`Code: ${report.commit}.`);
  lines.push('');
  return lines.join('\n');
}

export function renderBroken(provider: string, why: string, output: string): string {
  return [
    `### ${displayName(provider)}: FAILED (the check itself did not finish)`,
    '',
    cell(why, 600),
    '',
    '```',
    output.slice(-2000),
    '```',
    '',
  ].join('\n');
}

/** Parse the tool's --json output. Null when it is not a report. */
export function parseReport(stdout: string): JsonReport | null {
  try {
    const parsed = JSON.parse(stdout) as Partial<JsonReport>;
    if (parsed.tool !== 'gopaylocal-verify-provider' || !Array.isArray(parsed.steps)) return null;
    return parsed as JsonReport;
  } catch {
    return null;
  }
}

function emit(env: Env, markdown: string): void {
  process.stdout.write(`${markdown}\n`);
  const file = set(env.GITHUB_STEP_SUMMARY);
  if (file) appendFileSync(file, `${markdown}\n`);
}

function main(env: Env): number {
  const plan = planRun(env);
  if (plan.kind === 'usage') {
    process.stderr.write(`${plan.message}\n`);
    return 1;
  }
  if (plan.kind === 'not-set-up') {
    emit(env, renderNotSetUp(plan.provider, plan.secretName));
    return 0;
  }

  const apiDir = fileURLToPath(new URL('../..', import.meta.url));
  const child = spawnSync(
    process.execPath,
    [
      '--disable-warning=ExperimentalWarning',
      '--import',
      './scripts/verify-provider/register-ts-resolve.mjs',
      'scripts/verify-provider.ts',
      ...plan.args,
    ],
    { cwd: apiDir, env: process.env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: 16 * 1024 * 1024 },
  );

  const stdout = child.stdout ?? '';
  const report = parseReport(stdout);
  if (!report) {
    const why = child.error
      ? `Could not start the tool: ${child.error.message}`
      : `The tool exited with status ${child.status} without printing a report.`;
    emit(env, renderBroken(plan.provider, why, stdout));
    return 1;
  }
  emit(env, renderReport(plan.provider, report));
  return report.ok && child.status === 0 ? 0 : 1;
}

const isEntry = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;
if (isEntry) process.exitCode = main(process.env);
