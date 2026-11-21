/**
 * LOCAL script: build the VPN / datacenter / Tor IP dataset and write it to disk so it
 * can be uploaded to the VPN_DATA KV namespace by hand. Use it to seed a new deployment,
 * or instead of the daily cron on the Workers Free plan (whose 10 ms cron CPU limit is
 * too small for the in-Worker refresh). It only downloads the public lists and writes
 * files; it never talks to Cloudflare. Never deployed (outside src/, not in the bundle).
 *
 * Runs on plain Node 22.18+ (built-in TypeScript type stripping), no extra packages:
 *
 *   cd apps/api && node scripts/build-vpn-dataset.ts [--out-dir DIR] [--previous FILE]
 *   # or: pnpm --filter @gopaylocal/api vpn:build-dataset -- --out-dir DIR
 *
 *   --out-dir DIR     where to write the files (default: ./vpn-dataset-out)
 *   --previous FILE   a dataset .bin currently in KV (e.g. fetched with
 *                     `wrangler kv key get --binding VPN_DATA vpn:v1:dataset --remote > prev.bin`);
 *                     enables the same shrink/growth guard the cron uses. Without it,
 *                     every section is built from scratch (absolute checks still apply).
 *
 * Outputs (then upload ONE of them yourself; this script does not):
 *   vpn-dataset.bin        raw value:
 *                          wrangler kv key put --binding VPN_DATA vpn:v1:dataset --path vpn-dataset.bin --remote
 *   vpn-dataset.bulk.json  same value for:
 *                          wrangler kv bulk put --binding VPN_DATA vpn-dataset.bulk.json --remote
 *                          (remote only: wrangler's --local bulk put corrupts binary values)
 *
 * Data licensing: the X4BNet lists are MIT and derived from the IPLocate.io database
 * (CC BY-SA 4.0, attribution "IP address data powered by IPLocate.io"). If you publish
 * the generated file, keep that attribution and license. See services/vpn-dataset.ts.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  VPN_DATASET_KEY,
  buildVpnDataset,
  createFetchText,
  decodeDataset,
  encodeDataset,
  summarizeDataset,
  toWranglerBulkJson,
  type VpnDataset,
} from "../src/services/vpn-dataset.ts";

function argValue(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

const outDir = resolve(argValue("--out-dir") ?? "vpn-dataset-out");
const previousPath = argValue("--previous");

let previous: VpnDataset | null = null;
if (previousPath) {
  const prevBytes = new Uint8Array(await readFile(previousPath));
  previous = decodeDataset(prevBytes);
  if (!previous) {
    console.error(`--previous ${previousPath} is not a valid dataset file`);
    process.exit(1);
  }
}

const started = performance.now();
const build = await buildVpnDataset({ fetchText: createFetchText(fetch), previous, now: Date.now() });
const elapsedMs = Math.round(performance.now() - started);

console.log("Sources:");
for (const s of build.sources) {
  console.log(`  ${s.ok ? "ok  " : "FAIL"} ${s.id}${s.ok ? ` (${s.entries} entries, ${s.chars} chars)` : `: ${s.reason}`}`);
}
console.log("Sections:");
for (const s of build.sections) {
  console.log(`  ${s.status.padEnd(7)} ${s.category}/ipv${s.family}: ${s.ranges} ranges${s.reason ? ` (${s.reason})` : ""}`);
}

if (build.updatedSections === 0) {
  console.error("No section could be built; nothing written.");
  process.exit(1);
}

const encoded = encodeDataset(build.dataset);
await mkdir(outDir, { recursive: true });
const binPath = join(outDir, "vpn-dataset.bin");
const jsonPath = join(outDir, "vpn-dataset.bulk.json");
await writeFile(binPath, encoded);
await writeFile(jsonPath, toWranglerBulkJson(encoded));

console.log("Summary:");
for (const row of summarizeDataset(build.dataset)) {
  console.log(`  ${row.section.padEnd(18)} ${String(row.ranges).padStart(7)} ranges  ${row.covered} ${row.section.endsWith("6") ? "/64s" : "addresses"}`);
}
console.log(`Built in ${elapsedMs} ms; ${encoded.byteLength} bytes.`);
console.log(`Wrote ${binPath}`);
console.log(`Wrote ${jsonPath}`);
console.log("\nUpload (not done by this script), from apps/api:");
console.log(`  pnpm wrangler kv key put --binding VPN_DATA ${VPN_DATASET_KEY} --path ${binPath} --remote`);
console.log("Edge caches pick it up within about an hour.");
