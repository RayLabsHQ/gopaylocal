/**
 * Puts the banner into the Worker's static assets directory (apps/api/static),
 * as the two paths pages load it from:
 *
 *   static/v1/banner/script.js   <- packages/banner/dist/banner.js
 *   static/v1/banner/bundle.js   <- the same file (what the old loader asked for)
 *
 * Cloudflare answers a path that matches a file in that directory before the
 * Worker runs, from the location nearest the visitor. wrangler.toml runs this
 * script before
 * every `wrangler dev` and `wrangler deploy` ([build] command); it can also be
 * run by hand: node scripts/build-static.mjs
 *
 * The banner must be built first: `pnpm build:banner` from the repository root.
 * A file whose content is already current is left alone, so `wrangler dev`
 * does not see a change where there is none.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const apiDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = resolve(apiDir, '../../packages/banner/dist/banner.js');
const outDir = resolve(apiDir, 'static/v1/banner');

if (!existsSync(source)) {
  console.error(
    `build-static: ${relative(process.cwd(), source)} does not exist. ` +
      'Build the banner first: run `pnpm build:banner` from the repository root.',
  );
  process.exit(1);
}

const banner = readFileSync(source);
mkdirSync(outDir, { recursive: true });
let written = 0;
for (const name of ['script.js', 'bundle.js']) {
  const target = resolve(outDir, name);
  if (existsSync(target) && readFileSync(target).equals(banner)) continue;
  writeFileSync(target, banner);
  written++;
}
console.log(
  `build-static: banner (${banner.length} bytes) -> static/v1/banner/{script.js,bundle.js}` +
    (written ? '' : ' (already current)'),
);
