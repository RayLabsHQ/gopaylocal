import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { VPN_REFRESH_CRON, refreshVpnDataset, type VpnRefreshStatus } from "./vpn-refresh.service";
import { VPN_DATASET_KEY, VPN_STATUS_KEY, decodeDataset, encodeDataset, lookupIp, parseIp } from "./vpn-dataset";
import { createCountingKV, datasetFrom, fetchFrom, smallBodies, smallSources } from "./vpn-test-helpers";
import { createTestBindings } from "../test/helpers";

// index.ts -> routes/banner-script.ts imports the browser bundle as a wrangler text
// module; stub it. Stub the usage job so the scheduled-routing test never needs Postgres.
vi.mock("../../../../packages/banner/dist/banner.js", () => ({ default: "" }));
vi.mock("./usage.service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./usage.service")>()),
  recomputeUsageForAllOrgs: vi.fn(async () => {}),
}));

const NOW = 1_731_900_000_000;
const sources = smallSources();

function stored(state: { store: Map<string, string | Uint8Array> }) {
  const v = state.store.get(VPN_DATASET_KEY);
  return v instanceof Uint8Array ? decodeDataset(v) : null;
}

const hit = (ds: ReturnType<typeof decodeDataset>, ip: string) => (ds ? lookupIp(ds, parseIp(ip)!) : null);

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("refreshVpnDataset", () => {
  it("first run writes the dataset and a status record: exactly 2 KV writes", async () => {
    const { kv, state } = createCountingKV();
    const status = await refreshVpnDataset(kv, { fetchImpl: fetchFrom(smallBodies()), now: NOW, sources });

    expect(status.written).toBe(true);
    expect(state.writes).toEqual([VPN_DATASET_KEY, VPN_STATUS_KEY]);
    const ds = stored(state);
    expect(ds?.generatedAt).toBe(NOW / 1000);
    expect(hit(ds, "20.0.0.1")).toBe("datacenter");
    expect(hit(ds, "30.0.0.1")).toBeNull(); // Private Relay excluded
    const saved = JSON.parse(state.store.get(VPN_STATUS_KEY) as string) as VpnRefreshStatus;
    expect(saved).toMatchObject({ written: true, datasetGeneratedAt: new Date(NOW).toISOString() });
    expect(saved.sources.every((s) => s.ok)).toBe(true);
  });

  it("a truncated download on the next run keeps the previous section", async () => {
    const { kv, state } = createCountingKV();
    await refreshVpnDataset(kv, { fetchImpl: fetchFrom(smallBodies()), now: NOW, sources });
    const bodies = { ...smallBodies(), "https://test/dc4": "10.1.0.0/24\n20.0.0.0/1" }; // cut mid-line
    const status = await refreshVpnDataset(kv, { fetchImpl: fetchFrom(bodies), now: NOW + 86_400_000, sources });

    expect(status.written).toBe(true);
    expect(status.sections.find((s) => s.category === "datacenter")).toMatchObject({ status: "kept" });
    expect(hit(stored(state), "20.0.0.1")).toBe("datacenter");
  });

  it("refuses to overwrite good data when every source is empty or failing", async () => {
    const { kv, state } = createCountingKV();
    const good = encodeDataset(datasetFrom({ "datacenter/4": ["20.0.0.0/8"] }));
    state.store.set(VPN_DATASET_KEY, good);
    const bodies = {
      "https://test/vpn4": "",
      "https://test/dc4": { status: 500 },
      "https://test/vpn6": new Error("ECONNRESET"),
      "https://test/tor": "<html>maintenance</html>",
      "https://test/apple": { status: 404 },
    };
    const status = await refreshVpnDataset(kv, { fetchImpl: fetchFrom(bodies), now: NOW, sources });

    expect(status.written).toBe(false);
    expect(state.writes).toEqual([VPN_STATUS_KEY]); // dataset untouched
    expect(state.store.get(VPN_DATASET_KEY)).toEqual(good);
    expect(status.sources.every((s) => !s.ok)).toBe(true);
  });

  it("does not write anything if the existing dataset cannot be read", async () => {
    const { kv, state } = createCountingKV();
    state.getImpl = () => Promise.reject(new Error("KV unavailable"));
    const status = await refreshVpnDataset(kv, { fetchImpl: fetchFrom(smallBodies()), now: NOW, sources });
    expect(status.written).toBe(false);
    expect(state.writes).toEqual([]);
  });

  it("replaces a malformed existing value with a freshly built dataset", async () => {
    const { kv, state } = createCountingKV();
    state.store.set(VPN_DATASET_KEY, "10.20.30.40,10.20.30.41");
    const status = await refreshVpnDataset(kv, { fetchImpl: fetchFrom(smallBodies()), now: NOW, sources });
    expect(status.written).toBe(true);
    expect(stored(state)).not.toBeNull();
  });

  it("propagates a failed dataset write so the cron invocation fails instead of swallowing it", async () => {
    const { kv, state } = createCountingKV();
    state.failWrites = true;
    await expect(refreshVpnDataset(kv, { fetchImpl: fetchFrom(smallBodies()), now: NOW, sources })).rejects.toThrow(
      "KV write failed",
    );
  });
});

describe("cron wiring", () => {
  it("wrangler.toml schedules VPN_REFRESH_CRON alongside the usage cron", () => {
    const toml = readFileSync(new URL("../../wrangler.toml", import.meta.url), "utf8");
    const crons = toml.match(/^\s*crons\s*=\s*\[([^\]]*)\]/m)?.[1] ?? "";
    expect(crons).toContain(`"${VPN_REFRESH_CRON}"`);
    expect(crons).toContain('"*/10 * * * *"');
  });

  it("scheduled() routes the VPN cron to the refresh and everything else to the usage job", async () => {
    const { default: worker } = await import("../index");
    const usage = await import("./usage.service");
    const { kv, state } = createCountingKV();
    const env = createTestBindings({ VPN_DATA: kv });
    const waitUntil = vi.fn();
    const ctx = { waitUntil, passThroughOnException: () => {}, props: {} } as unknown as ExecutionContext;

    // Real sources are fetched via global fetch; serve them all as failures so the run is
    // quick and offline. The refresh must still complete (and write only its status).
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchFrom({}));
    await worker.scheduled!({ cron: VPN_REFRESH_CRON, scheduledTime: NOW, noRetry() {} } as ScheduledController, env, ctx);
    expect(state.reads).toBe(1);
    expect(state.writes).toEqual([VPN_STATUS_KEY]);
    expect(usage.recomputeUsageForAllOrgs).not.toHaveBeenCalled();
    expect(waitUntil).not.toHaveBeenCalled();

    await worker.scheduled!({ cron: "*/10 * * * *", scheduledTime: NOW, noRetry() {} } as ScheduledController, env, ctx);
    expect(usage.recomputeUsageForAllOrgs).toHaveBeenCalledOnce();
    expect(waitUntil).toHaveBeenCalledOnce();
    expect(state.reads).toBe(1); // the usage cron never touches VPN_DATA
  });
});
