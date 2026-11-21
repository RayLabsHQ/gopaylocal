/**
 * Test-only helpers for the VPN detection tests (vpn-*.test.ts). Never imported by
 * Worker code.
 */
import {
  mergeRanges,
  parseCidr,
  toSection,
  type KeyRange,
  type VpnCategory,
  type VpnDataset,
  type VpnSourceId,
  type VpnSourceSpec,
} from "./vpn-dataset";

export interface KvState {
  store: Map<string, string | Uint8Array>;
  reads: number;
  writes: string[];
  /** When set, every get() calls this instead of reading the store. */
  getImpl: (() => Promise<unknown>) | null;
  failWrites: boolean;
}

/** In-memory KV that honours get() types ("text" | "arrayBuffer" | "json"), copies
 * binary values like real KV, and counts reads and writes. */
export function createCountingKV(): { kv: KVNamespace; state: KvState } {
  const state: KvState = { store: new Map(), reads: 0, writes: [], getImpl: null, failWrites: false };
  const kv = {
    async get(key: string, typeOrOpts?: string | { type?: string }) {
      state.reads++;
      if (state.getImpl) return state.getImpl();
      const type = typeof typeOrOpts === "string" ? typeOrOpts : (typeOrOpts?.type ?? "text");
      const v = state.store.get(key);
      if (v === undefined) return null;
      const bytes = typeof v === "string" ? new TextEncoder().encode(v) : v;
      if (type === "arrayBuffer") return bytes.slice().buffer;
      const text = typeof v === "string" ? v : new TextDecoder().decode(v);
      return type === "json" ? JSON.parse(text) : text;
    },
    async put(key: string, value: string | ArrayBuffer | ArrayBufferView) {
      if (state.failWrites) throw new Error("KV write failed");
      state.writes.push(key);
      if (typeof value === "string") state.store.set(key, value);
      else if (value instanceof ArrayBuffer) state.store.set(key, new Uint8Array(value.slice(0)));
      else state.store.set(key, new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength)));
    },
  } as unknown as KVNamespace;
  return { kv, state };
}

/** Build a dataset from CIDR strings, e.g. { "vpn/4": ["10.0.0.0/24"] }. */
export function datasetFrom(
  spec: Partial<Record<`${VpnCategory}/${4 | 6}`, string[]>>,
  generatedAt = 1_700_000_000,
): VpnDataset {
  const sections = Object.entries(spec).map(([id, cidrs]) => {
    const [category, fam] = id.split("/") as [VpnCategory, string];
    const family = Number(fam) as 4 | 6;
    const ranges: KeyRange[] = (cidrs ?? []).map((c) => {
      const p = parseCidr(c);
      if (!p || p.family !== family) throw new Error(`bad test CIDR ${c} for ${id}`);
      return { start: p.start, end: p.end };
    });
    return toSection(family, category, mergeRanges(ranges));
  });
  return { generatedAt, sections };
}

/** `count` consecutive IPv4 networks of size /`prefix`, starting at a.b.c.d. */
export function v4Lines(count: number, prefix: number, first = "1.0.0.0"): string[] {
  const p = parseCidr(`${first}/${prefix}`);
  if (!p) throw new Error("bad start");
  const size = 2 ** (32 - prefix);
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const n = Number(p.start) + i * size;
    out.push(`${n >>> 24}.${(n >>> 16) & 255}.${(n >>> 8) & 255}.${n & 255}/${prefix}`);
  }
  return out;
}

/** Source specs with tiny bounds, pointing at fake URLs, for build/refresh tests. */
export function smallSources(): Record<VpnSourceId, VpnSourceSpec> {
  const base = { minBytes: 1, maxBytes: 1_000_000, minEntries: 1 };
  return {
    "x4b-vpn-v4": { ...base, id: "x4b-vpn-v4", url: "https://test/vpn4", format: "lines", family: 4 },
    "x4b-datacenter-v4": { ...base, id: "x4b-datacenter-v4", url: "https://test/dc4", format: "lines", family: 4 },
    "x4b-vpn-v6": { ...base, id: "x4b-vpn-v6", url: "https://test/vpn6", format: "lines", family: 6 },
    "tor-exits": { ...base, id: "tor-exits", url: "https://test/tor", format: "lines", family: "any" },
    "apple-private-relay": {
      ...base,
      id: "apple-private-relay",
      url: "https://test/apple",
      format: "csv-first-column",
      family: "any",
    },
  };
}

/** Bodies for smallSources(), keyed by URL. Override entries to simulate failures. */
export function smallBodies(): Record<string, string> {
  return {
    "https://test/vpn4": "10.1.0.0/24\n10.2.0.0/24\n",
    "https://test/dc4": "10.1.0.0/24\n10.2.0.0/24\n20.0.0.0/16\n30.0.0.0/24\n",
    "https://test/vpn6": "2001:db8:aa::/48\n",
    "https://test/tor": "198.51.100.7\n198.51.100.8\n",
    // 30.0.0.0/25 is "Private Relay" inside the datacenter list.
    "https://test/apple": "30.0.0.0/25,GB,GB-EN,London,\n2001:db8:aa:1::/64,GB,GB-EN,London,\n",
  };
}

/** A fetch stub serving `bodies` by URL (404 for anything else). */
export function fetchFrom(bodies: Record<string, string | { status: number; body?: string } | Error>): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const b = bodies[url];
    if (b === undefined) return new Response("not found", { status: 404 });
    if (b instanceof Error) throw b;
    if (typeof b === "string") return new Response(b, { status: 200 });
    return new Response(b.body ?? "", { status: b.status });
  }) as typeof fetch;
}
