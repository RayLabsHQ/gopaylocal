// Every payment integration needs a logo in the dashboard: the Integrations
// page loads /logos/<provider>.svg and shows a broken image when the file is
// missing. This lives in the api test project because the dashboard has no
// test project of its own.

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { INTEGRATION_PROVIDERS } from '@gopaylocal/shared';

const logosDir = fileURLToPath(new URL('../../dashboard/public/logos/', import.meta.url));

describe('dashboard integration logos', () => {
  it.each(INTEGRATION_PROVIDERS)('%s has one', (provider) => {
    expect(existsSync(`${logosDir}${provider}.svg`), `apps/dashboard/public/logos/${provider}.svg`).toBe(true);
  });
});
