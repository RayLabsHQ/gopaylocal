/**
 * Refreshes the VPN / datacenter / Tor IP dataset from OUTSIDE the Worker.
 *
 * It runs the same refreshVpnDataset() the Worker's daily cron runs (download
 * the public lists, validate them, keep yesterday's section when a list looks
 * wrong, write the dataset and a status record), with the VPN_DATA namespace
 * reached through Cloudflare's REST API instead of the Worker binding.
 *
 * This is for deployments on Workers Free, where the cron cannot finish: the
 * build needs 0.2-0.3 s of CPU and the free plan allows 10 ms per run.
 * .github/workflows/vpn-refresh.yml runs it every day; it also runs by hand:
 *
 *   CLOUDFLARE_KV_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... \
 *     pnpm --filter @gopaylocal/api vpn:refresh
 *
 * Input, all from environment variables:
 *   CLOUDFLARE_KV_API_TOKEN  an API token with the account permission
 *                            "Workers KV Storage: Edit" and nothing else
 *   CLOUDFLARE_ACCOUNT_ID    the account the namespace belongs to
 *   VPN_KV_NAMESPACE_ID      the VPN_DATA namespace id; default: the one in
 *                            apps/api/wrangler.toml
 *   GITHUB_STEP_SUMMARY      file to append the Markdown report to
 *
 * Without the token or the account id it reports "not set up" and succeeds.
 * Exit status: 0 the dataset was written (or not set up), 1 anything else.
 *
 * Unlike scripts/build-vpn-dataset.ts, which only writes files, this script
 * talks to Cloudflare. The token never appears in its output.
 */

import { appendFileSync, readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { refreshVpnDataset, type VpnRefreshStatus } from '../src/services/vpn-refresh.service';

type Env = Record<string, string | undefined>;

const API_BASE = 'https://api.cloudflare.com/client/v4';
const REQUEST_TIMEOUT_MS = 60_000;

const set = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
};

/** The id of the namespace bound as `binding` in a wrangler.toml, or null. */
export function kvNamespaceIdFromWranglerToml(toml: string, binding: string): string | null {
  for (const block of toml.split(/^\[\[kv_namespaces\]\]\s*$/m).slice(1)) {
    // The block ends where the next table starts.
    const body = block.split(/^\[/m)[0] ?? '';
    const name = /^\s*binding\s*=\s*"([^"]+)"/m.exec(body)?.[1];
    const id = /^\s*id\s*=\s*"([0-9a-f]{32})"/m.exec(body)?.[1];
    if (name === binding && id) return id;
  }
  return null;
}

export type RefreshConfig =
  | { kind: 'not-set-up'; missing: string[] }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; token: string; accountId: string; namespaceId: string; namespaceSource: string };

export function resolveConfig(env: Env, wranglerToml: string | null): RefreshConfig {
  const token = set(env.CLOUDFLARE_KV_API_TOKEN);
  const accountId = set(env.CLOUDFLARE_ACCOUNT_ID);
  const missing = [
    ...(token ? [] : ['CLOUDFLARE_KV_API_TOKEN']),
    ...(accountId ? [] : ['CLOUDFLARE_ACCOUNT_ID']),
  ];
  if (!token || !accountId) return { kind: 'not-set-up', missing };
  if (!/^[0-9a-f]{32}$/.test(accountId)) {
    return { kind: 'error', message: 'CLOUDFLARE_ACCOUNT_ID is not a Cloudflare account id (32 hex characters).' };
  }
  const explicit = set(env.VPN_KV_NAMESPACE_ID);
  if (explicit) {
    if (!/^[0-9a-f]{32}$/.test(explicit)) {
      return { kind: 'error', message: 'VPN_KV_NAMESPACE_ID is not a KV namespace id (32 hex characters).' };
    }
    return { kind: 'ready', token, accountId, namespaceId: explicit, namespaceSource: 'VPN_KV_NAMESPACE_ID' };
  }
  const fromToml = wranglerToml ? kvNamespaceIdFromWranglerToml(wranglerToml, 'VPN_DATA') : null;
  if (!fromToml) {
    return {
      kind: 'error',
      message: 'No VPN_DATA namespace id: set VPN_KV_NAMESPACE_ID, or add the VPN_DATA binding to apps/api/wrangler.toml.',
    };
  }
  return { kind: 'ready', token, accountId, namespaceId: fromToml, namespaceSource: 'apps/api/wrangler.toml' };
}

/** The two KV operations refreshVpnDataset() uses. */
export interface KvLike {
  get(key: string, type: 'arrayBuffer'): Promise<ArrayBuffer | null>;
  put(key: string, value: string | ArrayBuffer | ArrayBufferView): Promise<void>;
}

/** Cloudflare's error text for a failed call, without anything we sent. */
async function describeFailure(res: Response): Promise<string> {
  let detail = '';
  try {
    const body = (await res.json()) as { errors?: Array<{ code?: number; message?: string }> };
    detail = (body.errors ?? [])
      .map((e) => `${e.code ?? ''} ${e.message ?? ''}`.trim())
      .filter(Boolean)
      .join('; ');
  } catch {
    // Not JSON: the status is all we report.
  }
  return `HTTP ${res.status}${detail ? ` (${detail.slice(0, 300)})` : ''}`;
}

/**
 * One KV namespace over Cloudflare's REST API:
 * https://developers.cloudflare.com/api/resources/kv/subresources/namespaces/subresources/values/
 * A read returns the raw bytes; a write takes them as application/octet-stream.
 */
export function restKv(opts: {
  accountId: string;
  namespaceId: string;
  token: string;
  fetchImpl?: typeof fetch;
}): KvLike {
  const doFetch = opts.fetchImpl ?? fetch;
  const url = (key: string) =>
    `${API_BASE}/accounts/${opts.accountId}/storage/kv/namespaces/${opts.namespaceId}/values/${encodeURIComponent(key)}`;
  const authorization = `Bearer ${opts.token}`;
  return {
    async get(key) {
      const res = await doFetch(url(key), {
        headers: { authorization },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`Reading ${key} from KV failed: ${await describeFailure(res)}`);
      return res.arrayBuffer();
    },
    async put(key, value) {
      const res = await doFetch(url(key), {
        method: 'PUT',
        headers: { authorization, 'content-type': 'application/octet-stream' },
        body: value as BodyInit,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`Writing ${key} to KV failed: ${await describeFailure(res)}`);
      const body = (await res.json().catch(() => null)) as { success?: boolean } | null;
      if (body?.success !== true) throw new Error(`Writing ${key} to KV failed: Cloudflare did not confirm the write`);
    },
  };
}

const cell = (text: string): string => text.replace(/\s+/g, ' ').trim().replace(/\|/g, '\\|');

export function renderNotSetUp(missing: string[]): string {
  return [
    '### VPN list refresh: not set up',
    '',
    `Missing: ${missing.map((m) => `\`${m}\``).join(', ')}. Add them as repository secrets to turn the daily refresh on.`,
    'The token needs the account permission "Workers KV Storage: Edit" and nothing else.',
    '',
  ].join('\n');
}

export function renderStatus(status: VpnRefreshStatus): string {
  const kept = status.sections.filter((s) => s.status === 'kept' || s.status === 'absent');
  const verdict = !status.written ? 'FAILED, nothing written' : kept.length ? 'written, with warnings' : 'written';
  const lines = [`### VPN list refresh: ${verdict}`, '', `${cell(status.reason)}.`, ''];
  if (status.sections.length > 0) {
    lines.push('| Section | Result | Ranges | Note |', '|---|---|---|---|');
    for (const s of status.sections) {
      lines.push(`| ${s.category} IPv${s.family} | ${s.status} | ${s.ranges} | ${cell(s.reason ?? '')} |`);
    }
    lines.push('');
  }
  if (status.sources.length > 0) {
    lines.push('| Source | Result | Entries |', '|---|---|---|');
    for (const s of status.sources) {
      lines.push(`| ${s.id} | ${s.ok ? 'ok' : `REJECTED: ${cell(s.reason ?? '')}`} | ${s.entries ?? ''} |`);
    }
    lines.push('');
  }
  if (status.datasetGeneratedAt) lines.push(`Dataset now in KV was generated at ${status.datasetGeneratedAt}.`, '');
  return lines.join('\n');
}

export interface RunDeps {
  env: Env;
  wranglerToml: string | null;
  fetchImpl?: typeof fetch;
  refresh?: typeof refreshVpnDataset;
  emit: (markdown: string) => void;
  error: (line: string) => void;
}

export async function run(deps: RunDeps): Promise<number> {
  const config = resolveConfig(deps.env, deps.wranglerToml);
  if (config.kind === 'not-set-up') {
    deps.emit(renderNotSetUp(config.missing));
    return 0;
  }
  if (config.kind === 'error') {
    deps.error(config.message);
    return 1;
  }
  const kv = restKv({ ...config, fetchImpl: deps.fetchImpl });
  let status: VpnRefreshStatus;
  try {
    status = await (deps.refresh ?? refreshVpnDataset)(kv as unknown as KVNamespace, { fetchImpl: deps.fetchImpl });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    deps.emit(['### VPN list refresh: FAILED', '', cell(message), ''].join('\n'));
    return 1;
  }
  deps.emit(renderStatus(status));
  return status.written ? 0 : 1;
}

function readWranglerToml(): string | null {
  try {
    return readFileSync(fileURLToPath(new URL('../wrangler.toml', import.meta.url)), 'utf8');
  } catch {
    return null;
  }
}

const isEntry = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;
if (isEntry) {
  const summaryFile = set(process.env.GITHUB_STEP_SUMMARY);
  process.exitCode = await run({
    env: process.env,
    wranglerToml: readWranglerToml(),
    emit: (markdown) => {
      process.stdout.write(`${markdown}\n`);
      if (summaryFile) appendFileSync(summaryFile, `${markdown}\n`);
    },
    error: (line) => process.stderr.write(`error: ${line}\n`),
  });
}
