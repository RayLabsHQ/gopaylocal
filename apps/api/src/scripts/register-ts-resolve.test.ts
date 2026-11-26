// The scheduled checks (provider-checks.yml, woocommerce-store.yml) run the
// verify-provider tool with plain Node and register-ts-resolve.mjs, not through
// Vite. An import that Node cannot resolve there makes the tool stop before it
// checks anything, which happened when the shared package re-exported
// './provider-key-access.js'. Loading the tool here catches that on every push
// instead of in the nightly run.

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const apiDir = fileURLToPath(new URL('../..', import.meta.url));

describe('register-ts-resolve', () => {
  it('lets plain node load the verify-provider tool and its imports', () => {
    const run = spawnSync(
      process.execPath,
      [
        '--disable-warning=ExperimentalWarning',
        '--import',
        './scripts/verify-provider/register-ts-resolve.mjs',
        'scripts/verify-provider.ts',
        '--help',
      ],
      { cwd: apiDir, encoding: 'utf8', timeout: 60_000 },
    );
    expect(run.stderr).not.toContain('ERR_MODULE_NOT_FOUND');
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('Usage:');
  });
});
