import { describe, it, expect, vi, afterEach } from "vitest";
import {
  apiKeys,
  apiUsageDaily,
  subscriptions,
  organizationLimitOverrides,
} from "../db/schema";
import type { Database } from "../db";
import { createMockKV } from "../test/helpers";
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
