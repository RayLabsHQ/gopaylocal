import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FX_RATES_KEY, FX_REFRESH_CRON, FX_STATUS_KEY } from "./fx-refresh.service";
import { VPN_REFRESH_CRON } from "./vpn-refresh.service";
import { createCountingKV, fetchFrom } from "./vpn-test-helpers";
import { createTestBindings } from "../test/helpers";

// index.ts -> routes/banner-script.ts imports the browser bundle as a wrangler text
// module; stub it. Stub the usage job so the routing test never needs Postgres.
vi.mock("../../../../packages/banner/dist/banner.js", () => ({ default: "" }));
vi.mock("./usage.service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./usage.service")>()),
  recomputeUsageForAllOrgs: vi.fn(async () => {}),
}));

const NOW = Date.parse("2026-11-19T12:00:00Z");

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("FX cron wiring", () => {
  it("is distinct from the other crons", () => {
    expect(FX_REFRESH_CRON).not.toBe(VPN_REFRESH_CRON);
    expect(FX_REFRESH_CRON).not.toBe("*/10 * * * *");
  });

  it("scheduled() routes FX_REFRESH_CRON to the rate refresh, awaited, and nothing else", async () => {
    const { default: worker } = await import("../index");
    const usage = await import("./usage.service");
    const { kv, state } = createCountingKV();
    const env = createTestBindings({ CACHE: kv });
    const waitUntil = vi.fn();
    const ctx = { waitUntil, passThroughOnException: () => {}, props: {} } as unknown as ExecutionContext;

    // Every source fails (offline): the run must still finish, keep no rates and
    // write only its status.
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchFrom({}));
    await worker.scheduled!({ cron: FX_REFRESH_CRON, scheduledTime: NOW, noRetry() {} } as ScheduledController, env, ctx);

    expect(state.store.has(FX_RATES_KEY)).toBe(false);
    expect(state.writes).toEqual([FX_STATUS_KEY]);
    expect(usage.recomputeUsageForAllOrgs).not.toHaveBeenCalled();
    expect(waitUntil).not.toHaveBeenCalled();
  });

  it("FX_RATES_URL=off: the cron runs but fetches nothing and writes nothing", async () => {
    const { default: worker } = await import("../index");
    const { kv, state } = createCountingKV();
    const env = createTestBindings({ CACHE: kv, FX_RATES_URL: "off" });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(fetchFrom({}));
    const ctx = { waitUntil: vi.fn(), passThroughOnException: () => {}, props: {} } as unknown as ExecutionContext;

    await worker.scheduled!({ cron: FX_REFRESH_CRON, scheduledTime: NOW, noRetry() {} } as ScheduledController, env, ctx);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(state.writes).toEqual([]);
  });
});
