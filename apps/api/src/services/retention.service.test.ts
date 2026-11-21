import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ANALYTICS_STORAGE_MONTHS } from "@gopaylocal/shared";
import { analyticsCutoff, isRetentionRun, RETENTION_HOUR_UTC } from "./retention.service";
import { VPN_REFRESH_CRON } from "./vpn-refresh.service";
import { FX_REFRESH_CRON } from "./fx-refresh.service";
import { createTestBindings } from "../test/helpers";

// index.ts -> routes/banner-script.ts imports the browser bundle as a wrangler text
// module; stub it. Stub every job of the */10 cron so routing needs no Postgres.
vi.mock("../../../../packages/banner/dist/banner.js", () => ({ default: "" }));
vi.mock("./usage.service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./usage.service")>()),
  recomputeUsageForAllOrgs: vi.fn(async () => {}),
}));
vi.mock("./redemption-webhook.service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./redemption-webhook.service")>()),
  retryPendingRedemptions: vi.fn(async () => {}),
}));
vi.mock("./retention.service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./retention.service")>()),
  runRetention: vi.fn(async () => ({ analyticsRollups: 0, apiUsageDaily: 0, sessions: 0 })),
}));

const USAGE_CRON = "*/10 * * * *";

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe("isRetentionRun", () => {
  it("is true only for the run scheduled at 03:00 UTC", () => {
    expect(RETENTION_HOUR_UTC).toBe(3);
    expect(isRetentionRun(Date.parse("2026-11-21T03:00:00Z"))).toBe(true);
    // The runtime reports the scheduled minute, but tolerate a late timestamp.
    expect(isRetentionRun(Date.parse("2026-11-21T03:09:59Z"))).toBe(true);
    expect(isRetentionRun(Date.parse("2026-11-21T03:10:00Z"))).toBe(false);
    expect(isRetentionRun(Date.parse("2026-11-21T02:50:00Z"))).toBe(false);
    expect(isRetentionRun(Date.parse("2026-11-21T15:00:00Z"))).toBe(false);
  });

  it("matches exactly one of a day's 144 runs", () => {
    const start = Date.parse("2026-11-21T00:00:00Z");
    const runs = Array.from({ length: 144 }, (_, i) => start + i * 10 * 60 * 1000);
    expect(runs.filter(isRetentionRun)).toEqual([Date.parse("2026-11-21T03:00:00Z")]);
  });
});

describe("analyticsCutoff", () => {
  it("is the start of the UTC day 24 months back", () => {
    expect(ANALYTICS_STORAGE_MONTHS).toBe(24);
    expect(analyticsCutoff(new Date("2026-11-21T03:00:00Z")).toISOString()).toBe("2024-11-21T00:00:00.000Z");
    expect(analyticsCutoff(new Date("2027-01-01T23:59:59Z")).toISOString()).toBe("2025-01-01T00:00:00.000Z");
    expect(analyticsCutoff(new Date("2027-03-31T12:00:00Z")).toISOString()).toBe("2025-03-31T00:00:00.000Z");
  });

  it("moves forward, never back, when the day does not exist", () => {
    // 29 February 2028 minus 24 months is 29 February 2026, which does not
    // exist. 1 March keeps everything that is not yet 24 months old.
    expect(analyticsCutoff(new Date("2028-02-29T03:00:00Z")).toISOString()).toBe("2026-03-01T00:00:00.000Z");
  });
});

describe("retention cron wiring", () => {
  async function run(cron: string, at: string) {
    const { default: worker } = await import("../index");
    const retention = await import("./retention.service");
    const pending: Promise<unknown>[] = [];
    const ctx = {
      waitUntil: (p: Promise<unknown>) => pending.push(p),
      passThroughOnException: () => {},
      props: {},
    } as unknown as ExecutionContext;
    // The VPN and FX runs fetch their sources: fail them so nothing leaves the test.
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));
    await Promise.resolve(
      worker.scheduled!({ cron, scheduledTime: Date.parse(at), noRetry() {} } as ScheduledController, createTestBindings(), ctx),
    ).catch(() => {});
    await Promise.all(pending);
    return vi.mocked(retention.runRetention);
  }

  it("runs with the */10 cron's 03:00 UTC run", async () => {
    const runRetention = await run(USAGE_CRON, "2026-11-21T03:00:00Z");
    expect(runRetention).toHaveBeenCalledTimes(1);
  });

  it("does not run with any other */10 run", async () => {
    expect(await run(USAGE_CRON, "2026-11-21T03:10:00Z")).not.toHaveBeenCalled();
    expect(await run(USAGE_CRON, "2026-11-21T09:30:00Z")).not.toHaveBeenCalled();
  });

  it("does not run with the VPN or exchange-rate crons, whatever the time", async () => {
    expect(await run(VPN_REFRESH_CRON, "2026-11-21T03:00:00Z")).not.toHaveBeenCalled();
    expect(await run(FX_REFRESH_CRON, "2026-11-21T03:00:00Z")).not.toHaveBeenCalled();
  });

  it("a failing clean-up does not fail the run or the other jobs", async () => {
    const retention = await import("./retention.service");
    const usage = await import("./usage.service");
    vi.mocked(retention.runRetention).mockRejectedValueOnce(new Error("db down"));
    await run(USAGE_CRON, "2026-11-21T03:00:00Z");
    expect(vi.mocked(usage.recomputeUsageForAllOrgs)).toHaveBeenCalledTimes(1);
    expect(console.error).toHaveBeenCalledWith("Retention clean-up failed:", expect.any(Error));
  });
});
