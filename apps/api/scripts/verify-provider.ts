/**
 * LOCAL tool: verify a payment-provider integration against YOUR OWN sandbox
 * account, through the same provider code the API runs. Never deployed:
 * scripts/ is outside the worker entry (src/index.ts).
 *
 *   pnpm --filter @gopaylocal/api verify:provider --help
 *   GPL_VERIFY_API_KEY=sk_test_... pnpm --filter @gopaylocal/api verify:provider stripe --product price_...
 *
 * Credentials come only from environment variables; they are never read from
 * .dev.vars, written anywhere, or printed unmasked. Runs on Node's built-in
 * TypeScript support (see verify-provider/register-ts-resolve.mjs); no tsx needed.
 *
 * Guide: apps/api/PROVIDER_VERIFICATION.md
 */

import { execFileSync } from 'node:child_process';
import { access, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import type { IntegrationProvider } from '@gopaylocal/shared/types';
import { createProvider } from '../src/services/providers';
import { captureOnce } from './verify-provider/capture';
import { main } from './verify-provider/main';
import { installNetworkGuard } from './verify-provider/network-guard';

// pnpm runs package scripts from apps/api; INIT_CWD is where the user typed the
// command, which is what relative --replay / --capture paths mean to them.
const userCwd = process.env.INIT_CWD ?? process.cwd();

let cachedCommit: string | null | undefined;
function commit(): string | null {
  if (cachedCommit !== undefined) return cachedCommit;
  try {
    const run = (args: string[]) =>
      execFileSync('git', args, { cwd: userCwd, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    const sha = run(['rev-parse', '--short', 'HEAD']);
    const dirty = run(['status', '--porcelain', '--untracked-files=no']);
    cachedCommit = dirty ? `${sha} + uncommitted changes` : sha;
  } catch {
    cachedCommit = null;
  }
  return cachedCommit;
}

function waitForEnter(prompt: string): Promise<void> {
  if (!process.stdin.isTTY) {
    process.stderr.write('(stdin is not a terminal; not waiting)\n');
    return Promise.resolve();
  }
  return new Promise((done) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    const finish = () => {
      rl.close();
      done();
    };
    // While readline owns the terminal, Ctrl-C arrives here, not as a process SIGINT.
    rl.on('SIGINT', finish);
    rl.question(prompt, finish);
  });
}

const code = await main(process.argv.slice(2), {
  env: process.env,
  createProvider: (name, config) => createProvider(name as IntegrationProvider, config),
  stdout: (text) => process.stdout.write(`${text}\n`),
  stderr: (text) => process.stderr.write(`${text}\n`),
  readFile: (path) => readFile(path, 'utf8'),
  writeNewFile: (path, contents) => writeFile(path, contents, { flag: 'wx', mode: 0o600 }),
  fileExists: (path) => access(path).then(() => true, () => false),
  resolvePath: (path) => resolve(userCwd, path),
  waitForEnter,
  onInterrupt: (handler) => {
    process.on('SIGINT', handler);
    return () => process.off('SIGINT', handler);
  },
  exit: (exitCode) => process.exit(exitCode),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  now: () => Date.now(),
  commit,
  nodeVersion: process.version,
  installNetworkGuard,
  captureOnce,
});

process.exitCode = code;
// SDK keep-alive sockets can hold the event loop open for a while; don't wait
// for them, but don't cut off buffered stdout either (process.exit would).
setTimeout(() => process.exit(code), 1500).unref();
