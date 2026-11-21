// Tests for scripts/verify-provider/ci.ts (the unattended runner behind
// .github/workflows/provider-checks.yml) and for the workflow's provider list.
// Lives under src/ only because the `api` vitest project includes
// src/**/*.test.ts. Nothing here starts the tool or touches the network.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  apiKeySecretName,
  parseReport,
  planRun,
  renderBroken,
  renderNotSetUp,
  renderReport,
} from '../../scripts/verify-provider/ci';
import { PROVIDER_PROFILES } from '../../scripts/verify-provider/profiles';
import type { JsonReport } from '../../scripts/verify-provider/report';

const WORKFLOW = readFileSync(
  fileURLToPath(new URL('../../../../.github/workflows/provider-checks.yml', import.meta.url)),
  'utf8',
);

function report(overrides: Partial<JsonReport> = {}): JsonReport {
  return {
    tool: 'gopaylocal-verify-provider',
    schemaVersion: 1,
    provider: 'stripe',
    mode: 'checks',
    dryRun: false,
    environment: { effective: 'test', basis: 'the API key prefix marks it as a TEST key', allowLive: false },
    refused: null,
    commit: 'abc1234',
    node: 'v24.0.0',
    startedAt: '2026-11-21T00:00:00.000Z',
    finishedAt: '2026-11-21T00:00:05.000Z',
    capabilities: null,
    steps: [
      { name: 'create-discount', status: 'PASS', detail: 'created VERIFY-AB12-CD34 at 17%', phase: 'main', durationMs: 812 },
      { name: 'delete-discount', status: 'PASS', detail: 'deleted', phase: 'cleanup', durationMs: 40 },
    ],
    artifacts: {},
    summary: { PASS: 2, FAIL: 0, SKIPPED: 0, BLOCKED: 0 },
    ok: true,
    ...overrides,
  };
}

describe('planRun', () => {
  it('needs a provider it knows', () => {
    expect(planRun({})).toEqual({ kind: 'usage', message: 'VERIFY_PROVIDER is not set.' });
    expect(planRun({ VERIFY_PROVIDER: 'nope' }).kind).toBe('usage');
  });

  it('reports a provider without a key as not set up, naming the secret to add', () => {
    for (const env of [{}, { GPL_VERIFY_API_KEY: '' }, { GPL_VERIFY_API_KEY: '   ' }]) {
      expect(planRun({ VERIFY_PROVIDER: 'stripe', ...env })).toEqual({
        kind: 'not-set-up',
        provider: 'stripe',
        secretName: 'VERIFY_STRIPE_API_KEY',
      });
    }
  });

  it('runs with --json and nothing else by default', () => {
    expect(planRun({ VERIFY_PROVIDER: 'paddle', GPL_VERIFY_API_KEY: 'k' })).toEqual({
      kind: 'run',
      provider: 'paddle',
      args: ['paddle', '--json'],
    });
  });

  it('passes the product, and --allow-live only for a provider marked as a real account', () => {
    const plan = planRun({
      VERIFY_PROVIDER: 'gumroad',
      GPL_VERIFY_API_KEY: 'k',
      VERIFY_PRODUCT: ' abc ',
      VERIFY_REAL_ACCOUNT: 'true',
    });
    expect(plan).toEqual({ kind: 'run', provider: 'gumroad', args: ['gumroad', '--json', '--product', 'abc', '--allow-live'] });
    // GitHub sets an unset secret or a false flag to '' or 'false': neither adds a flag.
    const plain = planRun({
      VERIFY_PROVIDER: 'stripe',
      GPL_VERIFY_API_KEY: 'k',
      VERIFY_PRODUCT: '',
      VERIFY_REAL_ACCOUNT: 'false',
      VERIFY_DRY_RUN: 'false',
    });
    expect(plan.kind === 'run' && plain.kind === 'run' && plain.args).toEqual(['stripe', '--json']);
  });

  it('passes --dry-run when asked', () => {
    const plan = planRun({ VERIFY_PROVIDER: 'creem', GPL_VERIFY_API_KEY: 'k', VERIFY_DRY_RUN: 'true' });
    expect(plan.kind === 'run' && plan.args).toEqual(['creem', '--json', '--dry-run']);
  });

  it('accepts the dodo alias', () => {
    expect(planRun({ VERIFY_PROVIDER: 'dodo', GPL_VERIFY_API_KEY: 'k' })).toMatchObject({ provider: 'dodopayments' });
  });
});

describe('the report', () => {
  it('says passed and lists every check', () => {
    const text = renderReport('stripe', report());
    expect(text).toContain('### Stripe: passed');
    expect(text).toContain('| create-discount | PASS | 0.8s | created VERIFY-AB12-CD34 at 17% |');
    expect(text).toContain('| delete-discount | PASS |  | deleted |');
    expect(text).toContain('Ran against: test (the API key prefix marks it as a TEST key).');
    expect(text).toContain('Code: abc1234.');
  });

  it('says FAILED with the counts', () => {
    const text = renderReport(
      'paddle',
      report({
        ok: false,
        steps: [
          { name: 'create-discount', status: 'FAIL', detail: 'HTTP 403', phase: 'main', durationMs: 300 },
          { name: 'list-discounts', status: 'BLOCKED', detail: 'needs create-discount', phase: 'main', durationMs: 0 },
        ],
      }),
    );
    expect(text).toContain('### Paddle Billing: FAILED (1 failed, 1 blocked)');
  });

  it('shows why a run was refused', () => {
    const text = renderReport('stripe', report({ ok: false, refused: 'Refusing to run against LIVE data.', steps: [] }));
    expect(text).toContain('### Stripe: refused to run');
    expect(text).toContain('Refusing to run against LIVE data.');
    expect(text).not.toContain('| Check |');
  });

  it('does not call a dry run a pass', () => {
    expect(renderReport('stripe', report({ dryRun: true }))).toContain('settings accepted (dry run, no API calls)');
  });

  it('keeps a detail on one table row', () => {
    const text = renderReport(
      'stripe',
      report({ steps: [{ name: 'x', status: 'PASS', detail: 'a | b\nc', phase: 'main', durationMs: 0 }] }),
    );
    expect(text).toContain('| x | PASS |  | a \\| b c |');
  });

  it('names the secret when a provider is not set up', () => {
    expect(renderNotSetUp('woocommerce', apiKeySecretName('woocommerce'))).toContain('`VERIFY_WOOCOMMERCE_API_KEY`');
  });

  it('reports a run that printed no report as failed', () => {
    expect(parseReport('not json')).toBeNull();
    expect(parseReport('{"tool":"something-else","steps":[]}')).toBeNull();
    expect(parseReport(JSON.stringify(report()))?.ok).toBe(true);
    expect(renderBroken('polar', 'The tool exited with status 2 without printing a report.', 'boom')).toContain(
      '### Polar: FAILED (the check itself did not finish)',
    );
  });
});

describe('the nightly workflow', () => {
  const providers = Object.keys(PROVIDER_PROFILES);

  it('checks every provider the tool knows, under the matching secret prefix', () => {
    const listed = [...WORKFLOW.matchAll(/\{"provider": "([a-z]+)", "key": "([A-Z]+)", "real_account": "(true|false)"\}/g)];
    expect(listed.map((m) => m[1]).sort()).toEqual([...providers].sort());
    for (const [, provider, key] of listed) {
      expect(apiKeySecretName(provider!)).toBe(`VERIFY_${key}_API_KEY`);
    }
  });

  it('marks exactly the providers without a sandbox as real accounts', () => {
    const alwaysLive = providers.filter((p) => PROVIDER_PROFILES[p]!.mode.kind === 'always-live').sort();
    const marked = [...WORKFLOW.matchAll(/\{"provider": "([a-z]+)", "key": "[A-Z]+", "real_account": "true"\}/g)]
      .map((m) => m[1])
      .sort();
    expect(marked).toEqual(alwaysLive);
  });

  it('offers every provider in the manual run menu', () => {
    const menu = /options: \[([^\]]+)\]/.exec(WORKFLOW)?.[1]?.split(',').map((s) => s.trim());
    expect(menu).toEqual(['all', ...providers]);
  });

  it('never runs for pull requests, where a fork could reach the secrets', () => {
    const triggers = WORKFLOW.slice(WORKFLOW.indexOf('\non:\n'), WORKFLOW.indexOf('\npermissions:'));
    expect(triggers).toContain('schedule:');
    expect(triggers).toContain('workflow_dispatch:');
    expect(triggers).not.toMatch(/pull_request|push:/);
  });
});
