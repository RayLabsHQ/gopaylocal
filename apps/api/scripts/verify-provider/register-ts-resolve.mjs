// Lets plain `node` run the API's TypeScript sources directly, with no build
// step and no extra dependency (tsx is not a dependency of this workspace).
//
// Node >= 22.15 strips/transforms TypeScript itself (run with
// --experimental-transform-types, needed for the parameter properties in
// providers/types.ts), but it resolves imports the ESM way, which requires file
// extensions. The API source uses bundler-style extensionless imports
// ('./types', '../db'), so this hook retries a failed relative import with
// `.ts` and `/index.ts`. Everything else resolves exactly as Node normally does.
//
// Used as: node --experimental-transform-types --import ./scripts/verify-provider/register-ts-resolve.mjs <entry.ts>

import * as nodeModule from 'node:module';
import { statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// A namespace import, so an older Node reaches this friendly message instead of
// a SyntaxError about a missing named export.
const { registerHooks } = nodeModule;
if (typeof registerHooks !== 'function') {
  process.stderr.write(
    `verify:provider needs Node 22.15 or newer (the repo's .nvmrc pins 24); this is ${process.version}.\n`,
  );
  process.exit(2);
}

const RETRYABLE = new Set(['ERR_MODULE_NOT_FOUND', 'ERR_UNSUPPORTED_DIR_IMPORT']);

function isFile(url) {
  try {
    return statSync(fileURLToPath(url)).isFile();
  } catch {
    return false;
  }
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (err) {
      const parent = context.parentURL;
      const relative = specifier.startsWith('./') || specifier.startsWith('../');
      if (
        !RETRYABLE.has(err?.code) ||
        !relative ||
        !parent?.startsWith('file:') ||
        parent.includes('/node_modules/')
      ) {
        throw err;
      }
      for (const suffix of ['.ts', '/index.ts']) {
        const candidate = new URL(specifier + suffix, parent);
        if (isFile(candidate)) return nextResolve(candidate.href, context);
      }
      throw err;
    }
  },
});
