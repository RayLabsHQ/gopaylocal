import { describe, it, expect, vi, afterEach } from "vitest";
import {
  apiKeys,
  apiUsageDaily,
  subscriptions,
  organizationLimitOverrides,
} from "../db/schema";
import type { Database } from "../db";
import { createMockKV } from "../test/helpers";
import { discountEpochKey } from "./parity.service";
import {
  getQuotaState,
  isOverQuota,
  recomputeUsageForAllOrgs,
  usageKey,
  type UsageSnapshot,
} from "./usage.service";

afterEach(() => {
  vi.restoreAllMocks();
});

// Canned rows per table for any select chain (an Error rejects). Tables the
// cron's branding rebuild touches (api keys) return [], so the rebuild is a
// no-op unless a test makes it fail.
function fakeDb(rows: Map<object, unknown[] | Error>): Database {
  const chain = (result: unknown[] | Error) => {
    const builder: Record<string, unknown> = {
      where: () => builder,
      limit: () => builder,
      groupBy: () => builder,
      orderBy: () => builder,
      then: (resolve: (v: unknown[]) => unknown, reject?: (e: unknown) => unknown) =>
        (result instanceof Error ? Promise.reject(result) : Promise.resolve(result)).then(resolve, reject),
    };
    return builder;
  };
  return {
    select: () => ({ from: (table: object) => chain(rows.get(table) ?? []) }),
  } as unknown as Database;
}

const DAY = 86_400_000;

function cronRows() {
  return new Map<object, unknown[] | Error>([
    [
      apiUsageDaily,
      [
        { organizationId: "org_free", calls: "12000" },
        { organizationId: "org_free_under", calls: 9_999 },
        { organizationId: "org_pro", calls: 50_000_000 },
        { organizationId: "org_business", calls: 2_000_000 },
        { organizationId: "org_override", calls: 30_000 },
      ],
    ],
    [
      subscriptions,
      [
        {
          organizationId: "org_pro",
          plan: "pro",
          status: "active",
          currentPeriodEnd: new Date(Date.now() + 10 * DAY),
        },
        {
          organizationId: "org_business",
          plan: "business",
          status: "active",
          currentPeriodEnd: new Date(Date.now() + 10 * DAY),
        },
      ],
    ],
    [organizationLimitOverrides, [{ organizationId: "org_override", maxApiHitsPerMonth: 50_000 }]],
  ]);
}

async function snapshot(kv: KVNamespace, orgId: string): Promise<UsageSnapshot> {
  const raw = await kv.get(usageKey(orgId));
  expect(raw).not.toBeNull();
  return JSON.parse(raw as string) as UsageSnapshot;
}

describe("recomputeUsageForAllOrgs (hosted)", () => {
  it("caps free orgs at 10K live API calls/month (from api_usage_daily)", async () => {
    const kv = createMockKV();
    await recomputeUsageForAllOrgs(fakeDb(cronRows()), kv, { SELF_HOSTED: "false" });

    expect(await snapshot(kv, "org_free")).toMatchObject({ count: 12_000, limit: 10_000, over: true });
    expect(await snapshot(kv, "org_free_under")).toMatchObject({ count: 9_999, limit: 10_000, over: false });
    expect(await isOverQuota(kv, "org_free")).toBe(true);
    expect(await isOverQuota(kv, "org_free_under")).toBe(false);
  });

  it("writes unlimited pro (and legacy business) as limit null, never over", async () => {
    const kv = createMockKV();
    await recomputeUsageForAllOrgs(fakeDb(cronRows()), kv);

    const pro = await snapshot(kv, "org_pro");
    expect(pro).toMatchObject({ count: 50_000_000, limit: null, over: false });
    expect((await kv.get(usageKey("org_pro"))) ?? "").toContain('"limit":null');
    expect(await snapshot(kv, "org_business")).toMatchObject({ limit: null, over: false });
    expect(await isOverQuota(kv, "org_pro")).toBe(false);
  });

  it("honors an admin override cap", async () => {
    const kv = createMockKV();
    await recomputeUsageForAllOrgs(fakeDb(cronRows()), kv);
    expect(await snapshot(kv, "org_override")).toMatchObject({ limit: 50_000, over: false });
  });

  it("records the branding marker from entitlements (free 1, paid 0)", async () => {
    const kv = createMockKV();
    await recomputeUsageForAllOrgs(fakeDb(cronRows()), kv);
    expect(await kv.get("branding:org_free")).toBe("1");
    expect(await kv.get("branding:org_pro")).toBe("0");
    expect(await kv.get("branding:org_business")).toBe("0");
  });

  it("does not record the branding marker when the rebuild failed, so the next run retries", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const kv = createMockKV();
    const rows = cronRows();
    rows.set(apiKeys, new Error("connection reset"));
    await recomputeUsageForAllOrgs(fakeDb(rows), kv);

    // The snapshot is still written; only the branding marker waits for a good rebuild.
    expect(await snapshot(kv, "org_pro")).toMatchObject({ limit: null });
    expect(await kv.get("branding:org_pro")).toBeNull();
    expect(errorSpy).toHaveBeenCalledWith(
      "usage: branding rebuild failed; retrying next run",
      expect.objectContaining({ orgId: "org_pro", error: expect.stringContaining("connection reset") }),
    );

    // Next run with a healthy database records it.
    await recomputeUsageForAllOrgs(fakeDb(cronRows()), kv);
    expect(await kv.get("branding:org_pro")).toBe("0");
  });
});

describe("recomputeUsageForAllOrgs: KV is written only when a snapshot changes", () => {
  /** Rows for one organization: its calls this month and, optionally, an active Pro subscription. */
  function orgRows(orgId: string, calls: number, pro = false) {
    return new Map<object, unknown[] | Error>([
      [apiUsageDaily, [{ organizationId: orgId, calls }]],
      [
        subscriptions,
        pro
          ? [{ organizationId: orgId, plan: "pro", status: "active", currentPeriodEnd: new Date(Date.now() + 10 * DAY) }]
          : [],
      ],
      [organizationLimitOverrides, []],
    ]);
  }
  /** Runs the cron and returns the KV keys it wrote and read. */
  async function run(kv: KVNamespace, rows: Map<object, unknown[] | Error>) {
    const put = vi.spyOn(kv, "put");
    const get = vi.spyOn(kv, "get");
    await recomputeUsageForAllOrgs(fakeDb(rows), kv, { SELF_HOSTED: "false" });
    const result = { puts: put.mock.calls.map((c) => String(c[0])), gets: get.mock.calls.map((c) => String(c[0])) };
    put.mockRestore();
    get.mockRestore();
    return result;
  }

  it("the first run writes the snapshot; a run that changes nothing writes nothing and reads one key per org", async () => {
    const kv = createMockKV();
    const first = await run(kv, cronRows());
    expect(first.puts.filter((k) => k.startsWith("usage:"))).toHaveLength(5);

    const second = await run(kv, cronRows());
    expect(second.puts).toEqual([]);
    expect(second.gets.sort()).toEqual(
      ["org_free", "org_free_under", "org_pro", "org_business", "org_override"].map((o) => usageKey(o)).sort(),
    );
  });

  it("a growing count alone is not written; reaching the cap is, and so is the cap being lifted", async () => {
    const kv = createMockKV();
    await run(kv, orgRows("org_a", 100));
    expect((await run(kv, orgRows("org_a", 9_999))).puts).toEqual([]);
    expect(await snapshot(kv, "org_a")).toMatchObject({ count: 100, over: false });

    expect((await run(kv, orgRows("org_a", 10_000))).puts).toEqual([usageKey("org_a")]);
    expect(await snapshot(kv, "org_a")).toMatchObject({ count: 10_000, limit: 10_000, over: true });
    expect(await isOverQuota(kv, "org_a")).toBe(true);

    // An upgrade: the limit and the branding bit change, so the documents are
    // rebuilt (the epoch write is the rebuild) and the snapshot is rewritten.
    const upgraded = await run(kv, orgRows("org_a", 10_500, true));
    expect(upgraded.puts.sort()).toEqual(["branding:org_a", discountEpochKey("org_a"), usageKey("org_a")].sort());
    expect(await snapshot(kv, "org_a")).toMatchObject({ limit: null, over: false, branding: "0" });
    expect(await isOverQuota(kv, "org_a")).toBe(false);
    expect((await run(kv, orgRows("org_a", 11_000, true))).puts).toEqual([]);
  });

  it("a new month writes a new snapshot without a rebuild: the marker key carries the branding bit over", async () => {
    const kv = createMockKV();
    await kv.put("branding:org_a", "1"); // applied in an earlier month
    const result = await run(kv, orgRows("org_a", 3));
    expect(result.puts).toEqual([usageKey("org_a")]);
    expect(await snapshot(kv, "org_a")).toMatchObject({ count: 3, over: false, branding: "1" });
    expect(result.gets.sort()).toEqual(["branding:org_a", usageKey("org_a")].sort());
  });

  it("a snapshot from before the branding field existed is completed once, without a rebuild", async () => {
    const kv = createMockKV();
    await kv.put("branding:org_a", "1");
    await kv.put(usageKey("org_a"), JSON.stringify({ count: 5, limit: 10_000, over: false, updatedAt: "2026-11-01T00:00:00.000Z" }));
    expect((await run(kv, orgRows("org_a", 6))).puts).toEqual([usageKey("org_a")]);
    expect(await snapshot(kv, "org_a")).toMatchObject({ branding: "1" });
    const next = await run(kv, orgRows("org_a", 7));
    expect(next.puts).toEqual([]);
    expect(next.gets).toEqual([usageKey("org_a")]);
  });

  it("an unreadable snapshot is replaced", async () => {
    const kv = createMockKV();
    await kv.put("branding:org_a", "1");
    await kv.put(usageKey("org_a"), "not json");
    expect((await run(kv, orgRows("org_a", 6))).puts).toEqual([usageKey("org_a")]);
    expect(await snapshot(kv, "org_a")).toMatchObject({ count: 6, limit: 10_000, over: false, branding: "1" });
  });

  it("after a failed rebuild the snapshot does not claim the branding bit, and every run retries until one succeeds", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const kv = createMockKV();
    const failing = orgRows("org_a", 50, true);
    failing.set(apiKeys, new Error("connection reset"));

    const first = await run(kv, failing);
    expect(first.puts).toContain(usageKey("org_a"));
    expect(first.puts).not.toContain("branding:org_a");
    expect((await snapshot(kv, "org_a")).branding).toBeUndefined();

    // Still failing: retried (the epoch write is the attempt), nothing recorded.
    const second = await run(kv, failing);
    expect(second.puts).toEqual([discountEpochKey("org_a")]);

    const third = await run(kv, orgRows("org_a", 60, true));
    expect(third.puts.sort()).toEqual(["branding:org_a", discountEpochKey("org_a"), usageKey("org_a")].sort());
    expect(await snapshot(kv, "org_a")).toMatchObject({ limit: null, branding: "0" });
    expect((await run(kv, orgRows("org_a", 70, true))).puts).toEqual([]);
  });
});

describe("recomputeUsageForAllOrgs (self-hosted)", () => {
  it("treats every org as unlimited with branding off", async () => {
    const kv = createMockKV();
    await recomputeUsageForAllOrgs(fakeDb(cronRows()), kv, { SELF_HOSTED: "true" });

    for (const org of ["org_free", "org_pro", "org_override"]) {
      expect(await snapshot(kv, org)).toMatchObject({ limit: null, over: false });
      expect(await kv.get(`branding:${org}`)).toBe("0");
    }
  });
});

describe("getQuotaState (banner hot path)", () => {
  it("no snapshot yet: not over, metered as limited (exact)", async () => {
    expect(await getQuotaState(createMockKV(), "new_org", {})).toEqual({ over: false, limited: true });
  });

  it("a finite cap is limited; null is unlimited", async () => {
    const kv = createMockKV();
    await kv.put(usageKey("free"), JSON.stringify({ count: 10, limit: 10_000, over: false, updatedAt: "" }));
    await kv.put(usageKey("pro"), JSON.stringify({ count: 10, limit: null, over: false, updatedAt: "" }));
    expect(await getQuotaState(kv, "free", {})).toEqual({ over: false, limited: true });
    expect(await getQuotaState(kv, "pro", {})).toEqual({ over: false, limited: false });
  });

  it("fails open when KV throws", async () => {
    const kv = { get: async () => { throw new Error("kv down"); } } as unknown as KVNamespace;
    expect(await getQuotaState(kv, "o", {})).toEqual({ over: false, limited: true });
  });

  it("self-hosted: never over, never limited, no KV read", async () => {
    const get = vi.fn();
    expect(await getQuotaState({ get } as unknown as KVNamespace, "o", { SELF_HOSTED: "true" })).toEqual({
      over: false,
      limited: false,
    });
    expect(get).not.toHaveBeenCalled();
  });
});

describe("isOverQuota", () => {
  it("fails open on a missing or corrupt snapshot", async () => {
    const kv = createMockKV();
    expect(await isOverQuota(kv, "nobody")).toBe(false);
    await kv.put(usageKey("corrupt"), "{not json");
    expect(await isOverQuota(kv, "corrupt")).toBe(false);
  });

  it("is always false on a self-hosted deployment, even with an over snapshot", async () => {
    const kv = createMockKV();
    await kv.put(
      usageKey("org_x"),
      JSON.stringify({ count: 99_999, limit: 10_000, over: true, updatedAt: "" }),
    );
    expect(await isOverQuota(kv, "org_x")).toBe(true);
    expect(await isOverQuota(kv, "org_x", { SELF_HOSTED: "true" })).toBe(false);
  });
});
