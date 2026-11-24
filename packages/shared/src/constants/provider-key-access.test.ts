import { describe, expect, it } from 'vitest';
import { INTEGRATION_PROVIDERS } from '../validation/index.js';
import { PROVIDER_KEY_ACCESS } from './provider-key-access.js';

describe('PROVIDER_KEY_ACCESS', () => {
  it.each(INTEGRATION_PROVIDERS)('says what a %s key needs', (provider) => {
    const access = PROVIDER_KEY_ACCESS[provider];
    expect(access.key.trim()).not.toBe('');
    expect(access.permissions.length).toBeGreaterThan(0);
    for (const p of access.permissions) {
      expect(p.name.trim()).not.toBe('');
      expect(p.usedFor.trim()).not.toBe('');
    }
  });

  it('asks for no checkout permission: GoPayLocal never creates a checkout with a merchant key', () => {
    for (const [provider, access] of Object.entries(PROVIDER_KEY_ACCESS)) {
      for (const p of access.permissions) {
        expect(`${provider}: ${p.name} ${p.usedFor}`).not.toMatch(/checkout|transaction/i);
      }
    }
  });
});
