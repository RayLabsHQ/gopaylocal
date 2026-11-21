import { KNOWN_DATACENTER_ASNS } from "@gopaylocal/shared/constants";
import {
  VPN_DATASET_KEY,
  decodeDataset,
  lookupIp,
  parseIp,
  type VpnCategory,
  type VpnDataset,
} from "./vpn-dataset";

/**
 * VPN / proxy / Tor detection for the banner endpoint. A positive result makes
 * GET /v1/banner/config/:publicKey answer `{ show: false, reason: "vpn_detected" }`, so
 * the visitor sees no PPP discount (they can still buy at full price). A false positive
 * costs a legitimate buyer their discount, so every failure path here fails OPEN.
 *
 * Two checks, cheapest first:
 *  1. Network owner: `request.cf.asn` against KNOWN_DATACENTER_ASNS (exact numbers, no KV,
 *     works for IPv4 and IPv6, works even if the dataset below was never seeded).
 *  2. IP ranges: one binary blob in the VPN_DATA KV namespace (key VPN_DATASET_KEY) with
 *     sorted CIDR ranges for Tor exits, known VPN networks and datacenter networks
 *     (IPv4), plus known VPN networks (IPv6, per /64). It is read at most once per
 *     request and cached in module memory for DATASET_TTL_MS, so a warm isolate does no
 *     KV read at all; lookups are a binary search (~16 comparisons per section).
 *
 * The blob is produced by the daily cron (services/vpn-refresh.service.ts) or seeded by
 * hand with scripts/build-vpn-dataset.ts. Format and sources: services/vpn-dataset.ts.
 */

export { VPN_DATASET_KEY };

/** How long an isolate keeps a loaded dataset before re-reading KV. The data changes
 * daily, so an hour of staleness is irrelevant and keeps reads to ~1/hour/isolate. */
export const DATASET_TTL_MS = 60 * 60 * 1000;
/** KV edge-cache TTL for the blob (seconds; KV minimum is 30). */
export const DATASET_KV_CACHE_TTL_S = 60 * 60;
/** Re-check interval when the key is absent or the blob is unusable (unseeded deploys). */
export const MISSING_TTL_MS = 5 * 60 * 1000;
/** Re-check interval after a KV error. */
export const ERROR_TTL_MS = 60 * 1000;
/** Give up on a cold KV read after this long and treat the visitor as not-VPN. */
export const LOAD_TIMEOUT_MS = 1500;

const DATACENTER_ASNS: ReadonlySet<number> = new Set(Object.keys(KNOWN_DATACENTER_ASNS).map(Number));

export type VpnMatch = "asn" | VpnCategory;

export interface VpnDetection {
  detected: boolean;
  /** Which check matched; null when not detected. */
  match: VpnMatch | null;
}

/** Cloudflare request metadata we use. `asn` comes from `request.cf.asn`, which
 * Cloudflare sets at the edge and clients cannot spoof. */
export interface VpnNetworkInfo {
  asn?: number;
}

// ── Module-level dataset cache ───────────────────────────────────────────────────────
// Deliberately no cross-request promise sharing: in Workers, awaiting a promise whose
// I/O belongs to another request can hang if that request finishes first. Concurrent
// cold requests may each do one KV read; after the first resolves, everyone uses memory.

let cached: { dataset: VpnDataset | null; expiresAt: number } | null = null;

/** Test hook: forget the cached dataset. */
export function resetVpnDatasetCache(): void {
  cached = null;
}

async function loadDataset(kv: KVNamespace, now: number): Promise<VpnDataset | null> {
  try {
    const buf = await kv.get(VPN_DATASET_KEY, { type: "arrayBuffer", cacheTtl: DATASET_KV_CACHE_TTL_S });
    if (!buf) {
      // Never seeded (or deliberately deleted): only the ASN check applies.
      cached = { dataset: null, expiresAt: now + MISSING_TTL_MS };
      return null;
    }
    const dataset = decodeDataset(buf);
    if (!dataset) {
      // Keep using the last good copy, if this isolate has one.
      console.warn("vpn-detect: dataset in KV is malformed; ignoring it");
      const fallback = cached?.dataset ?? null;
      cached = { dataset: fallback, expiresAt: now + MISSING_TTL_MS };
      return fallback;
    }
    cached = { dataset, expiresAt: now + DATASET_TTL_MS };
    return dataset;
  } catch (err) {
    console.warn("vpn-detect: KV read failed; using last good copy or failing open", err);
    const fallback = cached?.dataset ?? null;
    cached = { dataset: fallback, expiresAt: now + ERROR_TTL_MS };
    return fallback;
  }
}

async function getDataset(kv: KVNamespace, now: number): Promise<VpnDataset | null> {
  if (cached && now < cached.expiresAt) return cached.dataset;
  // Serve the stale copy if the refresh does not finish in time.
  const stale = cached?.dataset ?? null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), LOAD_TIMEOUT_MS);
  });
  try {
    const result = await Promise.race([loadDataset(kv, now), timeout]);
    return result === "timeout" ? stale : result;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Classify a visitor. Never throws and never rejects: any error means "not detected".
 * Does at most one KV read (zero on a warm isolate, zero when the ASN check matches,
 * zero for an unparseable IP).
 */
export async function detectVpnOrProxy(
  ip: string,
  network: VpnNetworkInfo | undefined,
  vpnData: KVNamespace,
  now: number = Date.now(),
): Promise<VpnDetection> {
  try {
    const asn = network?.asn;
    if (typeof asn === "number" && DATACENTER_ASNS.has(asn)) return { detected: true, match: "asn" };

    const parsed = ip ? parseIp(ip) : null;
    if (!parsed) return { detected: false, match: null };

    const dataset = await getDataset(vpnData, now);
    if (!dataset) return { detected: false, match: null };
    const category = lookupIp(dataset, parsed);
    return category ? { detected: true, match: category } : { detected: false, match: null };
  } catch (err) {
    console.warn("vpn-detect: unexpected error; failing open", err);
    return { detected: false, match: null };
  }
}

/** Boolean form used by the banner route. */
export async function isVpnOrProxy(
  ip: string,
  network: VpnNetworkInfo | undefined,
  vpnData: KVNamespace,
): Promise<boolean> {
  return (await detectVpnOrProxy(ip, network, vpnData)).detected;
}
