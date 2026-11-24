// Lets plain `node` (22.18 or newer, which strips TypeScript types itself) run
// e2e/support/seed-user.ts, which imports the API's TypeScript sources. Node
// strips the types itself but resolves imports the ESM way, while the API and
// packages/shared use bundler-style specifiers: extensionless ('../db') and
// '.js' pointing at a '.ts' file ('./types/index.js'). On a failed relative
// import outside node_modules this hook retries '<spec>.ts', '<spec>/index.ts'
// and, for '.js' specifiers, the '.ts' sibling. Everything else resolves as
// Node normally does. No dependency (tsx is not installed in this workspace).
//
// Used as: node --import ./e2e/support/ts-resolve.mjs <entry.ts>

import * as nodeModule from "node:module";
import { statSync } from "node:fs";
import { fileURLToPath } from "node:url";

const { registerHooks } = nodeModule;
if (typeof registerHooks !== "function" || !process.features.typescript) {
  process.stderr.write(`e2e seeding needs Node 22.18 or newer (.nvmrc pins 26); this is ${process.version}.\n`);
  process.exit(2);
}

const RETRYABLE = new Set(["ERR_MODULE_NOT_FOUND", "ERR_UNSUPPORTED_DIR_IMPORT"]);

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
      const relative = specifier.startsWith("./") || specifier.startsWith("../");
      if (!RETRYABLE.has(err?.code) || !relative || !parent?.startsWith("file:") || parent.includes("/node_modules/")) {
        throw err;
      }
      const candidates = specifier.endsWith(".js")
        ? [specifier.slice(0, -3) + ".ts"]
        : [specifier + ".ts", specifier + "/index.ts"];
      for (const candidate of candidates) {
        const url = new URL(candidate, parent);
        if (isFile(url)) return nextResolve(url.href, context);
      }
      throw err;
    }
  },
});
