// PROVIDER_KEY_ACCESS (packages/shared) tells merchants which permissions their
// payment platform key needs, and leaves out checkout permissions because the
// app never creates a checkout with their key. Only the verify:provider tool
// does. If the app starts calling a checkout method, add the permission it
// needs to PROVIDER_KEY_ACCESS and to the integration's docs page, then update
// this test.
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const srcDir = fileURLToPath(new URL('.', import.meta.url));

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

describe('provider key permissions', () => {
  it('the app never builds a checkout with a merchant key', () => {
    const callers = sourceFiles(srcDir)
      .filter((path) => !relative(srcDir, path).startsWith(join('services', 'providers')))
      .filter((path) => /\.(buildCheckoutUrl|createCheckoutSession)\s*\(/.test(readFileSync(path, 'utf8')))
      .map((path) => relative(srcDir, path));
    expect(callers).toEqual([]);
  });
});
