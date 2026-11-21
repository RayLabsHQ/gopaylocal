// Tests for scripts/refresh-vpn-dataset.ts (the VPN list refresh that runs
// outside the Worker, from .github/workflows/vpn-refresh.yml). Lives under src/
// only because the `api` vitest project includes src/**/*.test.ts. Nothing here
// touches the network: fetch is a fake.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  kvNamespaceIdFromWranglerToml,
  renderStatus,
  resolveConfig,
  restKv,
  run,
} from '../../scripts/refresh-vpn-dataset';
import type { VpnRefreshStatus } from '../services/vpn-refresh.service';

const read = (path: string) => readFileSync(fileURLToPath(new URL(`../../../../${path}`, import.meta.url)), 'utf8');
const WRANGLER_TOML = read('apps/api/wrangler.toml');
const WORKFLOW = read('.github/workflows/vpn-refresh.yml');

const ACCOUNT = 'a'.repeat(32);
const NAMESPACE = 'b'.repeat(32);
const TOKEN = 'secret-token-value';

const TOML = `
[[kv_namespaces]]
binding = "CACHE"
id = "${'c'.repeat(32)}"

[[kv_namespaces]]
id = "${NAMESPACE}"
binding = "VPN_DATA"

[[hyperdrive]]
binding = "HYPERDRIVE"
id = "${'d'.repeat(32)}"
`;

function status(overrides: Partial<VpnRefreshStatus> = {}): VpnRefreshStatus {
  return {
    ranAt: '2026-11-21T09:40:00.000Z',
    written: true,
    reason: 'rebuilt 4/5 sections (325952 bytes)',
    datasetGeneratedAt: '2026-11-21T09:40:00.000Z',
    sections: [
      { family: 4, category: 'vpn', status: 'updated', ranges: 5934 },
      { family: 6, category: 'tor', status: 'empty', ranges: 0 },
    ],
    sources: [{ id: 'x4b-vpn-v4', ok: true, entries: 11070, chars: 1 }],
    ...overrides,
  };
}

describe('kvNamespaceIdFromWranglerToml', () => {
  it('finds the namespace by its binding, whatever the key order', () => {
    expect(kvNamespaceIdFromWranglerToml(TOML, 'VPN_DATA')).toBe(NAMESPACE);
    expect(kvNamespaceIdFromWranglerToml(TOML, 'CACHE')).toBe('c'.repeat(32));
  });

  it('does not borrow an id from the table after the block', () => {
    const toml = `[[kv_namespaces]]\nbinding = "VPN_DATA"\n\n[[hyperdrive]]\nid = "${'d'.repeat(32)}"\n`;
    expect(kvNamespaceIdFromWranglerToml(toml, 'VPN_DATA')).toBeNull();
  });

  it('returns null for a binding that is not there', () => {
    expect(kvNamespaceIdFromWranglerToml(TOML, 'NOPE')).toBeNull();
  });

  it("reads the project's own wrangler.toml", () => {
    expect(kvNamespaceIdFromWranglerToml(WRANGLER_TOML, 'VPN_DATA')).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe('resolveConfig', () => {
  it('is not set up without the token or the account id, and says which is missing', () => {
    expect(resolveConfig({}, TOML)).toEqual({
      kind: 'not-set-up',
      missing: ['CLOUDFLARE_KV_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID'],
    });
    expect(resolveConfig({ CLOUDFLARE_KV_API_TOKEN: TOKEN, CLOUDFLARE_ACCOUNT_ID: ' ' }, TOML)).toEqual({
      kind: 'not-set-up',
      missing: ['CLOUDFLARE_ACCOUNT_ID'],
    });
  });

  it('takes the namespace from wrangler.toml by default', () => {
    expect(resolveConfig({ CLOUDFLARE_KV_API_TOKEN: TOKEN, CLOUDFLARE_ACCOUNT_ID: ACCOUNT }, TOML)).toEqual({
      kind: 'ready',
      token: TOKEN,
      accountId: ACCOUNT,
      namespaceId: NAMESPACE,
      namespaceSource: 'apps/api/wrangler.toml',
    });
  });

  it('lets VPN_KV_NAMESPACE_ID override it', () => {
    const config = resolveConfig(
      { CLOUDFLARE_KV_API_TOKEN: TOKEN, CLOUDFLARE_ACCOUNT_ID: ACCOUNT, VPN_KV_NAMESPACE_ID: 'e'.repeat(32) },
      TOML,
    );
    expect(config).toMatchObject({ kind: 'ready', namespaceId: 'e'.repeat(32), namespaceSource: 'VPN_KV_NAMESPACE_ID' });
  });

  it('refuses ids that could change the request path', () => {
    const base = { CLOUDFLARE_KV_API_TOKEN: TOKEN };
    expect(resolveConfig({ ...base, CLOUDFLARE_ACCOUNT_ID: '../zones' }, TOML).kind).toBe('error');
    expect(
      resolveConfig({ ...base, CLOUDFLARE_ACCOUNT_ID: ACCOUNT, VPN_KV_NAMESPACE_ID: 'x/../../y' }, TOML).kind,
    ).toBe('error');
  });

  it('is an error when no namespace id can be found', () => {
    expect(resolveConfig({ CLOUDFLARE_KV_API_TOKEN: TOKEN, CLOUDFLARE_ACCOUNT_ID: ACCOUNT }, null).kind).toBe('error');
  });
});

describe('restKv', () => {
  const urlFor = (key: string) =>
    `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/storage/kv/namespaces/${NAMESPACE}/values/${key}`;

  it('reads raw bytes, with the key percent-encoded and the token as a bearer', async () => {
    const fetchImpl = vi.fn(async () => new Response(new Uint8Array([1, 2, 3])));
    const kv = restKv({ accountId: ACCOUNT, namespaceId: NAMESPACE, token: TOKEN, fetchImpl });
    const value = await kv.get('vpn:v1:dataset', 'arrayBuffer');
    expect([...new Uint8Array(value!)]).toEqual([1, 2, 3]);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(urlFor('vpn%3Av1%3Adataset'));
    expect(new Headers(init.headers).get('authorization')).toBe(`Bearer ${TOKEN}`);
    expect(init.method).toBeUndefined();
  });

  it('returns null for a key that does not exist', async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({ success: false, errors: [{ code: 10009, message: 'get: key not found' }] }, { status: 404 }),
    );
    const kv = restKv({ accountId: ACCOUNT, namespaceId: NAMESPACE, token: TOKEN, fetchImpl });
    expect(await kv.get('vpn:v1:dataset', 'arrayBuffer')).toBeNull();
  });

  it("fails a read with Cloudflare's reason and without the token", async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({ success: false, errors: [{ code: 10000, message: 'Authentication error' }] }, { status: 403 }),
    );
    const kv = restKv({ accountId: ACCOUNT, namespaceId: NAMESPACE, token: TOKEN, fetchImpl });
    const error = await kv.get('vpn:v1:dataset', 'arrayBuffer').catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('Reading vpn:v1:dataset from KV failed: HTTP 403 (10000 Authentication error)');
    expect((error as Error).message).not.toContain(TOKEN);
  });

  it('writes the value as application/octet-stream', async () => {
    const fetchImpl = vi.fn(async () => Response.json({ success: true, errors: [], messages: [], result: {} }));
    const kv = restKv({ accountId: ACCOUNT, namespaceId: NAMESPACE, token: TOKEN, fetchImpl });
    const bytes = new Uint8Array([9, 8, 7]);
    await kv.put('vpn:v1:dataset', bytes);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(urlFor('vpn%3Av1%3Adataset'));
    expect(init.method).toBe('PUT');
    expect(new Headers(init.headers).get('content-type')).toBe('application/octet-stream');
    expect(new Headers(init.headers).get('authorization')).toBe(`Bearer ${TOKEN}`);
    expect(init.body).toBe(bytes);
  });

  it('fails a write Cloudflare rejects or does not confirm', async () => {
    const rejected = restKv({
      accountId: ACCOUNT,
      namespaceId: NAMESPACE,
      token: TOKEN,
      fetchImpl: vi.fn(async () =>
        Response.json({ success: false, errors: [{ code: 10013, message: 'namespace not found' }] }, { status: 404 }),
      ),
    });
    await expect(rejected.put('k', 'v')).rejects.toThrow('Writing k to KV failed: HTTP 404 (10013 namespace not found)');

    const unconfirmed = restKv({
      accountId: ACCOUNT,
      namespaceId: NAMESPACE,
      token: TOKEN,
      fetchImpl: vi.fn(async () => new Response('ok')),
    });
    await expect(unconfirmed.put('k', 'v')).rejects.toThrow('Cloudflare did not confirm the write');
  });
});

describe('run', () => {
  const ready = { CLOUDFLARE_KV_API_TOKEN: TOKEN, CLOUDFLARE_ACCOUNT_ID: ACCOUNT };

  function harness(env: Record<string, string>, refresh?: () => Promise<VpnRefreshStatus>) {
    const emitted: string[] = [];
    const errors: string[] = [];
    const refreshSpy = vi.fn(refresh ?? (async () => status()));
    const result = run({
      env,
      wranglerToml: TOML,
      refresh: refreshSpy as never,
      emit: (m) => emitted.push(m),
      error: (m) => errors.push(m),
    });
    return { result, emitted, errors, refreshSpy };
  }

  it('reports "not set up" and succeeds without credentials, calling nothing', async () => {
    const h = harness({});
    expect(await h.result).toBe(0);
    expect(h.emitted.join('\n')).toContain('### VPN list refresh: not set up');
    expect(h.emitted.join('\n')).toContain('`CLOUDFLARE_KV_API_TOKEN`');
    expect(h.refreshSpy).not.toHaveBeenCalled();
  });

  it('succeeds when the dataset was written', async () => {
    const h = harness(ready);
    expect(await h.result).toBe(0);
    expect(h.refreshSpy).toHaveBeenCalledTimes(1);
    expect(h.emitted.join('\n')).toContain('### VPN list refresh: written');
  });

  it('fails when nothing was written', async () => {
    const h = harness(ready, async () =>
      status({ written: false, reason: 'no section could be rebuilt; existing dataset left untouched' }),
    );
    expect(await h.result).toBe(1);
    expect(h.emitted.join('\n')).toContain('### VPN list refresh: FAILED, nothing written');
  });

  it('fails, without the token in the report, when the refresh throws', async () => {
    const h = harness(ready, async () => {
      throw new Error('Writing vpn:v1:dataset to KV failed: HTTP 403 (10000 Authentication error)');
    });
    expect(await h.result).toBe(1);
    const report = h.emitted.join('\n');
    expect(report).toContain('### VPN list refresh: FAILED');
    expect(report).toContain('HTTP 403');
    expect(report).not.toContain(TOKEN);
  });

  it('fails on a malformed account id before calling anything', async () => {
    const h = harness({ ...ready, CLOUDFLARE_ACCOUNT_ID: 'nope' });
    expect(await h.result).toBe(1);
    expect(h.errors[0]).toContain('CLOUDFLARE_ACCOUNT_ID');
    expect(h.refreshSpy).not.toHaveBeenCalled();
  });
});

describe('renderStatus', () => {
  it('lists sections and sources', () => {
    const text = renderStatus(status());
    expect(text).toContain('| vpn IPv4 | updated | 5934 |  |');
    expect(text).toContain('| tor IPv6 | empty | 0 |  |');
    expect(text).toContain('| x4b-vpn-v4 | ok | 11070 |');
  });

  it('flags a section that kept yesterday’s data and a rejected source', () => {
    const text = renderStatus(
      status({
        sections: [{ family: 4, category: 'vpn', status: 'kept', ranges: 5000, reason: 'source x4b-vpn-v4 failed' }],
        sources: [{ id: 'x4b-vpn-v4', ok: false, reason: 'HTTP 500' }],
      }),
    );
    expect(text).toContain('### VPN list refresh: written, with warnings');
    expect(text).toContain('| vpn IPv4 | kept | 5000 | source x4b-vpn-v4 failed |');
    expect(text).toContain('| x4b-vpn-v4 | REJECTED: HTTP 500 |  |');
  });
});

describe('the daily workflow', () => {
  it('runs on a schedule and by hand only, so a pull request can never reach the token', () => {
    const triggers = WORKFLOW.slice(WORKFLOW.indexOf('\non:\n'), WORKFLOW.indexOf('\npermissions:'));
    expect(triggers).toContain('schedule:');
    expect(triggers).toContain('workflow_dispatch:');
    expect(triggers).not.toMatch(/pull_request|push:/);
  });

  it('passes the secrets the script reads', () => {
    expect(WORKFLOW).toContain('CLOUDFLARE_KV_API_TOKEN: ${{ secrets.CLOUDFLARE_KV_API_TOKEN }}');
    expect(WORKFLOW).toContain('CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}');
    expect(WORKFLOW).toContain('scripts/refresh-vpn-dataset.ts');
  });
});
