// Tests for scripts/verify-provider/ci.ts (the unattended runner behind
// .github/workflows/provider-checks.yml) and for the workflow's provider list.
// Lives under src/ only because the `api` vitest project includes
// src/**/*.test.ts. Nothing here starts the tool or touches the network.

import { readdirSync, readFileSync } from 'node:fs';
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

  it('runs with --json and --public-log and nothing else by default', () => {
    expect(planRun({ VERIFY_PROVIDER: 'paddle', GPL_VERIFY_API_KEY: 'k' })).toEqual({
      kind: 'run',
      provider: 'paddle',
      args: ['paddle', '--json', '--public-log'],
    });
  });

  it('passes the product, and --allow-live only for a provider marked as a real account', () => {
    const plan = planRun({
      VERIFY_PROVIDER: 'gumroad',
      GPL_VERIFY_API_KEY: 'k',
      VERIFY_PRODUCT: ' abc ',
      VERIFY_REAL_ACCOUNT: 'true',
    });
    expect(plan).toEqual({ kind: 'run', provider: 'gumroad', args: ['gumroad', '--json', '--public-log', '--product', 'abc', '--allow-live'] });
    // GitHub sets an unset secret or a false flag to '' or 'false': neither adds a flag.
    const plain = planRun({
      VERIFY_PROVIDER: 'stripe',
      GPL_VERIFY_API_KEY: 'k',
      VERIFY_PRODUCT: '',
      VERIFY_REAL_ACCOUNT: 'false',
      VERIFY_DRY_RUN: 'false',
    });
    expect(plan.kind === 'run' && plain.kind === 'run' && plain.args).toEqual(['stripe', '--json', '--public-log']);
  });

  it('passes --dry-run when asked', () => {
    const plan = planRun({ VERIFY_PROVIDER: 'creem', GPL_VERIFY_API_KEY: 'k', VERIFY_DRY_RUN: 'true' });
    expect(plan.kind === 'run' && plan.args).toEqual(['creem', '--json', '--public-log', '--dry-run']);
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

describe('actions used by the workflows', () => {
  const dir = fileURLToPath(new URL('../../../../.github/workflows/', import.meta.url));
  const workflows = readdirSync(dir)
    .filter((name) => name.endsWith('.yml'))
    .map((name) => ({ name, text: readFileSync(`${dir}${name}`, 'utf8') }));
  const usesOf = (text: string) => [...text.matchAll(/^\s*-?\s*uses:\s*(\S+)/gm)].map((m) => m[1]!);
  const pinned = (ref: string) => /@[0-9a-f]{40}$/.test(ref);

  it('finds the workflows', () => {
    expect(workflows.map((w) => w.name).sort()).toEqual(
      ['ci.yml', 'provider-checks.yml', 'release-sdks.yml', 'vpn-refresh.yml', 'woocommerce-store.yml'].sort(),
    );
  });

  it('pins every action to a commit in a workflow that holds secrets or can publish', () => {
    // `id-token: write` lets a job sign in to npm as this repository's workflow.
    const withSecrets = workflows.filter((w) => /\$\{\{\s*secrets\b/.test(w.text) || /id-token:\s*write/.test(w.text));
    expect(withSecrets.map((w) => w.name).sort()).toEqual(['provider-checks.yml', 'release-sdks.yml', 'vpn-refresh.yml']);
    for (const w of withSecrets) {
      expect(usesOf(w.text).length).toBeGreaterThan(0);
      expect(usesOf(w.text).filter((ref) => !pinned(ref)), w.name).toEqual([]);
    }
  });

  it('pins every action GitHub does not publish, in every workflow', () => {
    for (const w of workflows) {
      const thirdParty = usesOf(w.text).filter((ref) => !ref.startsWith('actions/'));
      expect(thirdParty.filter((ref) => !pinned(ref)), w.name).toEqual([]);
    }
  });
});

describe('the SDK release workflow', () => {
  const RELEASE_WORKFLOW = readFileSync(
    fileURLToPath(new URL('../../../../.github/workflows/release-sdks.yml', import.meta.url)),
    'utf8',
  );

  it('runs only by hand', () => {
    const triggers = RELEASE_WORKFLOW.slice(RELEASE_WORKFLOW.indexOf('\non:\n'), RELEASE_WORKFLOW.indexOf('\npermissions:\n'));
    expect(triggers).toContain('  workflow_dispatch:');
    expect(triggers).not.toMatch(/^\s*(push|pull_request|pull_request_target|schedule|release|workflow_run):/m);
  });

  it('stores no npm token: only the publishing job can sign in, as the workflow itself', () => {
    expect(RELEASE_WORKFLOW).not.toMatch(/\$\{\{\s*secrets\b/);
    expect(RELEASE_WORKFLOW).toMatch(/\npermissions:\n  contents: read\n/);
    expect(RELEASE_WORKFLOW.match(/id-token:\s*write/g)).toHaveLength(1);
  });

  it('publishes the two SDKs, and both can be published', () => {
    const published = [...(RELEASE_WORKFLOW.match(/release-sdks\.sh (.+)$/m)?.[1] ?? '').split(' ')];
    expect(published).toEqual(['packages/js-sdk', 'packages/react-sdk']);
    for (const dir of published) {
      const manifest = JSON.parse(readFileSync(fileURLToPath(new URL(`../../../../${dir}/package.json`, import.meta.url)), 'utf8'));
      expect(manifest.private, dir).toBeUndefined();
      expect(manifest.publishConfig, dir).toEqual({ access: 'public' });
      // npm checks this against the repository the workflow runs in.
      expect(manifest.repository.url, dir).toBe('git+https://github.com/RayLabsHQ/gopaylocal.git');
    }
  });
});

describe('the WooCommerce store workflow', () => {
  const STORE_WORKFLOW = readFileSync(
    fileURLToPath(new URL('../../../../.github/workflows/woocommerce-store.yml', import.meta.url)),
    'utf8',
  );

  it('uses no secrets, because it runs for pull requests', () => {
    expect(STORE_WORKFLOW).toContain('pull_request:');
    expect(STORE_WORKFLOW).not.toMatch(/\$\{\{\s*secrets\b/);
    expect(STORE_WORKFLOW).toMatch(/permissions:\n  contents: read\n/);
  });

  it('runs the store script that exists', () => {
    const script = 'apps/api/scripts/verify-provider/woocommerce-store/run.sh';
    expect(STORE_WORKFLOW).toContain(`run: ${script}`);
    expect(readFileSync(fileURLToPath(new URL(`../../../../${script}`, import.meta.url)), 'utf8')).toContain(
      'set -euo pipefail',
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
