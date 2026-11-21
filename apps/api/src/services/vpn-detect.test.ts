import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  DATASET_TTL_MS,
  ERROR_TTL_MS,
  LOAD_TIMEOUT_MS,
  MISSING_TTL_MS,
  VPN_DATASET_KEY,
  detectVpnOrProxy,
  isVpnOrProxy,
  resetVpnDatasetCache,
} from "./vpn-detect.service";
import { encodeDataset } from "./vpn-dataset";
import { createCountingKV, datasetFrom } from "./vpn-test-helpers";
import { createMockKV } from "../test/helpers";

const T0 = 1_731_900_000_000;

function seeded() {
  const { kv, state } = createCountingKV();
  state.store.set(
    VPN_DATASET_KEY,
    encodeDataset(
      datasetFrom({
        "tor/4": ["198.51.100.7"],
        "vpn/4": ["10.20.0.0/16"],
        "datacenter/4": ["20.0.0.0/8"],
        "vpn/6": ["2001:db8:aa::/48"],
      }),
    ),
  );
  return { kv, state };
}

beforeEach(() => {
  resetVpnDatasetCache();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

// ── Network-owner (ASN) check ───────────────────────────────────────────────────────

describe("ASN check", () => {
  it.each([
    [16509, "AWS"],
    [14618, "AWS"],
    [8075, "Microsoft Azure"],
    [396982, "Google Cloud"],
    [14061, "DigitalOcean"],
    [24940, "Hetzner"],
    [216025, "Mullvad"],
    [60729, "Tor exit operator"],
  ])("flags AS%i (%s) without touching KV", async (asn) => {
    const { kv, state } = createCountingKV();
    expect(await detectVpnOrProxy("1.2.3.4", { asn }, kv, T0)).toEqual({ detected: true, match: "asn" });
    expect(state.reads).toBe(0);
  });

  it.each([
    [7922, "Comcast"],
    [7018, "AT&T"],
    [55836, "Reliance Jio"],
    [701, "Verizon"],
    [16591, "Google Fiber (the old 'google' substring matched it)"],
    [13335, "Cloudflare (WARP, iCloud Private Relay egress)"],
    [36183, "Akamai (iCloud Private Relay egress)"],
    [54113, "Fastly (iCloud Private Relay egress)"],
    [15169, "Google consumer services"],
  ])("does not flag AS%i (%s)", async (asn) => {
    const { kv } = createCountingKV();
    expect(await isVpnOrProxy("1.2.3.4", { asn }, kv)).toBe(false);
  });

  it("ignores a missing or non-numeric asn", async () => {
    const { kv } = createCountingKV();
    expect(await isVpnOrProxy("1.2.3.4", undefined, kv)).toBe(false);
    expect(await isVpnOrProxy("1.2.3.4", {}, kv)).toBe(false);
    expect(await isVpnOrProxy("1.2.3.4", { asn: "16509" as unknown as number }, kv)).toBe(false);
  });

  it("applies to IPv6 visitors too", async () => {
    const { kv } = createCountingKV();
    expect(await isVpnOrProxy("2600:1f18::1", { asn: 16509 }, kv)).toBe(true);
  });
});

// ── IP-range check against the KV dataset ───────────────────────────────────────────

describe("IP-range check", () => {
  it("reports the matching category for IPv4 and IPv6", async () => {
    const { kv } = seeded();
    expect(await detectVpnOrProxy("198.51.100.7", { asn: 7922 }, kv, T0)).toEqual({ detected: true, match: "tor" });
    expect(await detectVpnOrProxy("10.20.30.40", undefined, kv, T0)).toEqual({ detected: true, match: "vpn" });
    expect(await detectVpnOrProxy("20.1.2.3", undefined, kv, T0)).toEqual({ detected: true, match: "datacenter" });
    expect(await detectVpnOrProxy("2001:db8:aa:1::9", undefined, kv, T0)).toEqual({ detected: true, match: "vpn" });
    expect(await detectVpnOrProxy("::ffff:10.20.0.1", undefined, kv, T0)).toEqual({ detected: true, match: "vpn" });
  });

  it("misses addresses just outside a range", async () => {
    const { kv } = seeded();
    expect(await isVpnOrProxy("10.19.255.255", undefined, kv)).toBe(false);
    expect(await isVpnOrProxy("10.21.0.0", undefined, kv)).toBe(false);
    expect(await isVpnOrProxy("198.51.100.8", undefined, kv)).toBe(false);
    expect(await isVpnOrProxy("2001:db8:ab::1", undefined, kv)).toBe(false);
  });

  it("an empty or unparseable IP is not-VPN and costs no KV read", async () => {
    const { kv, state } = seeded();
    for (const ip of ["", "unknown", "1.2.3", "10.20.0.1, 1.1.1.1", "fe80::1%en0"]) {
      expect(await isVpnOrProxy(ip, undefined, kv)).toBe(false);
    }
    expect(state.reads).toBe(0);
  });

  it("an unseeded namespace means only the ASN check applies", async () => {
    const { kv } = createCountingKV();
    expect(await isVpnOrProxy("10.20.30.40", undefined, kv)).toBe(false);
    expect(await isVpnOrProxy("10.20.30.40", { asn: 16509 }, kv)).toBe(true);
  });

  it("works with the shared createMockKV used by route tests (no data -> not VPN)", async () => {
    expect(await isVpnOrProxy("10.20.30.40", undefined, createMockKV())).toBe(false);
  });

  it("the legacy comma-separated vpn:ip:* keys are ignored", async () => {
    const { kv, state } = createCountingKV();
    state.store.set("vpn:ip:10.20", "10.20.30.40,10.20.30.41");
    expect(await isVpnOrProxy("10.20.30.40", undefined, kv)).toBe(false);
  });
});

// ── KV budget and in-memory caching ─────────────────────────────────────────────────

describe("KV reads and caching", () => {
  it("reads KV at most once per request and not at all on a warm isolate", async () => {
    const { kv, state } = seeded();
    await detectVpnOrProxy("10.20.0.1", undefined, kv, T0);
    expect(state.reads).toBe(1);
    for (let i = 0; i < 50; i++) await detectVpnOrProxy(`20.0.0.${i}`, undefined, kv, T0 + i * 1000);
    expect(state.reads).toBe(1);
  });

  it("re-reads after the TTL and picks up a new dataset", async () => {
    const { kv, state } = seeded();
    expect(await detectVpnOrProxy("30.0.0.1", undefined, kv, T0)).toMatchObject({ detected: false });
    state.store.set(VPN_DATASET_KEY, encodeDataset(datasetFrom({ "datacenter/4": ["30.0.0.0/8"] })));
    // Still inside the TTL: served from memory, the new blob is not seen yet.
    expect(await detectVpnOrProxy("30.0.0.1", undefined, kv, T0 + DATASET_TTL_MS - 1)).toMatchObject({ detected: false });
    expect(state.reads).toBe(1);
    expect(await detectVpnOrProxy("30.0.0.1", undefined, kv, T0 + DATASET_TTL_MS + 1)).toEqual({ detected: true, match: "datacenter" });
    expect(state.reads).toBe(2);
  });

  it("re-checks a missing key after MISSING_TTL_MS, not on every request", async () => {
    const { kv, state } = createCountingKV();
    await detectVpnOrProxy("10.20.0.1", undefined, kv, T0);
    await detectVpnOrProxy("10.20.0.1", undefined, kv, T0 + MISSING_TTL_MS - 1);
    expect(state.reads).toBe(1);
    state.store.set(VPN_DATASET_KEY, encodeDataset(datasetFrom({ "vpn/4": ["10.20.0.0/16"] })));
    expect(await detectVpnOrProxy("10.20.0.1", undefined, kv, T0 + MISSING_TTL_MS + 1)).toMatchObject({ detected: true });
    expect(state.reads).toBe(2);
  });
});

// ── Failure modes: always fail open, never throw ────────────────────────────────────

describe("failure modes", () => {
  it("a KV error is not-VPN, does not throw, and is retried after ERROR_TTL_MS", async () => {
    const { kv, state } = seeded();
    state.getImpl = () => Promise.reject(new Error("KV unavailable"));
    await expect(detectVpnOrProxy("10.20.0.1", undefined, kv, T0)).resolves.toEqual({ detected: false, match: null });
    await detectVpnOrProxy("10.20.0.1", undefined, kv, T0 + ERROR_TTL_MS - 1);
    expect(state.reads).toBe(1);
    state.getImpl = null;
    expect(await detectVpnOrProxy("10.20.0.1", undefined, kv, T0 + ERROR_TTL_MS + 1)).toMatchObject({ detected: true });
  });

  it("a malformed blob is ignored (not-VPN), never misread", async () => {
    const { kv, state } = createCountingKV();
    state.store.set(VPN_DATASET_KEY, new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17]));
    expect(await isVpnOrProxy("10.20.0.1", undefined, kv)).toBe(false);
  });

  it("keeps using the last good dataset if the stored blob later turns malformed or KV errors", async () => {
    const { kv, state } = seeded();
    expect(await detectVpnOrProxy("10.20.0.1", undefined, kv, T0)).toMatchObject({ detected: true });
    state.store.set(VPN_DATASET_KEY, "garbage");
    expect(await detectVpnOrProxy("10.20.0.1", undefined, kv, T0 + DATASET_TTL_MS + 1)).toMatchObject({ detected: true });
    state.getImpl = () => Promise.reject(new Error("KV unavailable"));
    expect(await detectVpnOrProxy("10.20.0.1", undefined, kv, T0 + 2 * DATASET_TTL_MS)).toMatchObject({ detected: true });
  });

  it("a hung KV read gives up after LOAD_TIMEOUT_MS and treats the visitor as not-VPN", async () => {
    vi.useFakeTimers();
    const { kv, state } = seeded();
    state.getImpl = () => new Promise(() => {}); // never settles
    const pending = detectVpnOrProxy("10.20.0.1", undefined, kv, T0);
    await vi.advanceTimersByTimeAsync(LOAD_TIMEOUT_MS);
    await expect(pending).resolves.toEqual({ detected: false, match: null });
  });

  it("on a slow refresh, a stale in-memory dataset is used rather than nothing", async () => {
    const { kv, state } = seeded();
    await detectVpnOrProxy("10.20.0.1", undefined, kv, T0);
    vi.useFakeTimers();
    state.getImpl = () => new Promise(() => {});
    const pending = detectVpnOrProxy("10.20.0.1", undefined, kv, T0 + DATASET_TTL_MS + 1);
    await vi.advanceTimersByTimeAsync(LOAD_TIMEOUT_MS);
    await expect(pending).resolves.toEqual({ detected: true, match: "vpn" });
  });

  it("isVpnOrProxy never rejects, even with a broken binding", async () => {
    const broken = {} as KVNamespace; // .get is not a function
    await expect(isVpnOrProxy("10.20.0.1", undefined, broken)).resolves.toBe(false);
  });
});
