import {
  VPN_DATASET_KEY,
  VPN_STATUS_KEY,
  buildVpnDataset,
  createFetchText,
  decodeDataset,
  encodeDataset,
  type SectionReport,
  type SourceReport,
  type VpnDataset,
  type VpnSourceId,
  type VpnSourceSpec,
} from "./vpn-dataset";

/**
 * Daily refresh of the VPN / datacenter / Tor IP dataset (see vpn-dataset.ts for sources).
 *
 * Schedule: MUST match an entry in wrangler.toml `[triggers] crons` (vpn-refresh.test.ts
 * checks this). 09:30 UTC runs after X4BNet's daily list build (cron `45 8 * * *` UTC).
 *
 * Budget, per Cloudflare's limits (checked 2026-11-18):
 *  - KV writes: at most 2 per run (dataset + status), against 1,000 writes/day on the free
 *    plan (https://developers.cloudflare.com/kv/platform/limits/). The dataset is one
 *    value of a few hundred KB; KV's value limit is 25 MiB.
 *  - Subrequests: 5 fetches + 1 KV read + 2 KV writes, against 50 per invocation on the
 *    free plan (https://developers.cloudflare.com/workers/platform/limits/#subrequests).
 *  - CPU: parsing ~345K list lines (mostly Apple's egress CSV) and merging took 0.2-0.3 s
 *    in Node measurements. That fits the Workers Paid cron limit (15 min CPU for schedules
 *    with an interval of 1 hour or more) but NOT the free plan's 10 ms per cron invocation
 *    (https://developers.cloudflare.com/workers/platform/limits/#cpu-time). On the free
 *    plan the run is expected to be cut off before it reaches the write (the dataset is
 *    written last, so existing data is left alone); seed and refresh with
 *    scripts/build-vpn-dataset.ts instead.
 *  - Memory: in Node the full build completes with V8's old space capped at 24 MB (and
 *    fails at 16 MB), against 128 MB per Worker isolate. Raw bodies are dropped as soon
 *    as they are validated, and sorted input is coalesced while parsing.
 *  - Duration: cron invocations may run 15 min wall-clock; downloads take seconds.
 */
export const VPN_REFRESH_CRON = "30 9 * * *";

export interface VpnRefreshStatus {
  ranAt: string;
  written: boolean;
  reason: string;
  /** generatedAt of the dataset now in KV (new or previous), ISO; null if none. */
  datasetGeneratedAt: string | null;
  sections: SectionReport[];
  sources: SourceReport[];
}

async function writeStatus(kv: KVNamespace, status: VpnRefreshStatus): Promise<void> {
  try {
    await kv.put(VPN_STATUS_KEY, JSON.stringify(status));
  } catch (err) {
    console.warn("vpn-refresh: could not write status record", err);
  }
}

function iso(seconds: number | undefined): string | null {
  return seconds ? new Date(seconds * 1000).toISOString() : null;
}

/**
 * Download, validate and (if anything changed for the better) store a new dataset.
 * Bad or missing upstream data never replaces good data: the previous version of each
 * affected section is kept, and if nothing could be rebuilt nothing is written.
 */
export async function refreshVpnDataset(
  kv: KVNamespace,
  opts: {
    fetchImpl?: typeof fetch;
    now?: number;
    /** Override the source list (tests). Defaults to VPN_SOURCES. */
    sources?: Record<VpnSourceId, VpnSourceSpec>;
  } = {},
): Promise<VpnRefreshStatus> {
  const now = opts.now ?? Date.now();
  const ranAt = new Date(now).toISOString();

  let previous: VpnDataset | null = null;
  try {
    const buf = await kv.get(VPN_DATASET_KEY, "arrayBuffer");
    if (buf) {
      previous = decodeDataset(buf);
      if (!previous) console.warn("vpn-refresh: existing dataset is malformed; rebuilding from scratch");
    }
  } catch (err) {
    // Without the current dataset we cannot run the shrink/growth guard, so do not write.
    console.error("vpn-refresh: could not read the existing dataset; skipping this run", err);
    return { ranAt, written: false, reason: "could not read existing dataset", datasetGeneratedAt: null, sections: [], sources: [] };
  }

  const build = await buildVpnDataset({
    fetchText: createFetchText(opts.fetchImpl ?? fetch),
    previous,
    now,
    sources: opts.sources,
  });

  for (const s of build.sources) {
    if (!s.ok) console.warn(`vpn-refresh: source ${s.id} rejected: ${s.reason}`);
  }
  for (const s of build.sections) {
    if (s.status === "kept" || s.status === "absent") console.warn(`vpn-refresh: section ${s.category}/v${s.family} ${s.status}: ${s.reason}`);
  }

  if (build.updatedSections === 0) {
    const status: VpnRefreshStatus = {
      ranAt,
      written: false,
      reason: "no section could be rebuilt; existing dataset left untouched",
      datasetGeneratedAt: iso(previous?.generatedAt),
      sections: build.sections,
      sources: build.sources,
    };
    console.error(`vpn-refresh: ${status.reason}`);
    await writeStatus(kv, status);
    return status;
  }

  const encoded = encodeDataset(build.dataset);
  await kv.put(VPN_DATASET_KEY, encoded);

  const status: VpnRefreshStatus = {
    ranAt,
    written: true,
    reason: `rebuilt ${build.updatedSections}/${build.sections.length} sections (${encoded.byteLength} bytes)`,
    datasetGeneratedAt: iso(build.dataset.generatedAt),
    sections: build.sections,
    sources: build.sources,
  };
  console.log(`vpn-refresh: ${status.reason}`);
  await writeStatus(kv, status);
  return status;
}
