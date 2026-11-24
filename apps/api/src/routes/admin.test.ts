import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import type { AppEnv } from "../bindings";
import { createTestBindings } from "../test/helpers";
import { createSqlRecorder, type SqlRecorder } from "../lib/sql-recorder-test-helpers";

// Admin route logic (the admin gate itself is tested in middleware/team.test.ts).
// No database: createDb() returns a recorder (real Drizzle SQL, canned rows).

const state = vi.hoisted(() => ({ recorder: null as unknown as SqlRecorder }));
vi.mock("../db", () => ({ createDb: () => state.recorder.db }));

const { default: adminRoute, summarizeSubscriptions } = await import("./admin");

function app() {
  const a = new Hono<AppEnv>();
  a.use("*", async (c, next) => {
    c.set("user", { id: "admin_1", role: "admin" });
    await next();
  });
  a.route("/", adminRoute);
  return a;
}

const env = createTestBindings();

describe("POST /v1/admin/users/:id/ban", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it("flags the user and deletes their sessions in one transaction, then audits", async () => {
    state.recorder = createSqlRecorder([
      [{ id: "u_x", name: "X", email: "x@example.test", banned: true, banReason: "spam" }],
      [],
      [],
    ]);

    const res = await app().request(
      "/v1/admin/users/u_x/ban",
      { method: "POST", body: JSON.stringify({ reason: "  spam  " }), headers: { "content-type": "application/json" } },
      env,
    );

    expect(res.status).toBe(200);
    expect(state.recorder.transactions).toEqual(["commit"]);
    const [update, sessionsDelete, audit] = state.recorder.queries;
    expect(update!.sql).toMatch(/^update "user" set "banned" = \$1, "banReason" = \$2, "updatedAt" = \$3 where "user"."id" = \$4/);
    expect(update!.params.slice(0, 2)).toEqual([true, "spam"]);
    expect(sessionsDelete!.sql).toBe('delete from "session" where "session"."userId" = $1');
    expect(sessionsDelete!.params).toEqual(["u_x"]);
    expect(audit!.sql).toContain('insert into "admin_audit_log"');
  });

  it("ignores a non-string reason instead of failing the insert", async () => {
    state.recorder = createSqlRecorder([[{ id: "u_x" }], [], []]);
    await app().request(
      "/v1/admin/users/u_x/ban",
      { method: "POST", body: JSON.stringify({ reason: { nested: true } }), headers: { "content-type": "application/json" } },
      env,
    );
    expect(state.recorder.queries[0]!.params[1]).toBe("Banned by admin");
  });

  it("answers 404 for an unknown user and deletes no sessions", async () => {
    state.recorder = createSqlRecorder([[]]);
    const res = await app().request("/v1/admin/users/nope/ban", { method: "POST" }, env);
    expect(res.status).toBe(404);
    expect(state.recorder.queries).toHaveLength(1);
  });
});

describe("admin list paging", () => {
  it("falls back to defaults for non-numeric page/limit instead of sending NaN", async () => {
    state.recorder = createSqlRecorder([[], [{ total: 0 }]]);
    const res = await app().request("/v1/admin/users?page=abc&limit=xyz", {}, env);

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ pagination: { page: 1, limit: 50 } });
    const list = state.recorder.queries.find((q) => q.sql.includes("limit"))!;
    // Drizzle omits OFFSET 0; the point is that no NaN reaches the query.
    expect(list.params).toEqual([50]);
    expect(list.params.some((p) => Number.isNaN(p))).toBe(false);
  });

  it("clamps an oversized limit", async () => {
    state.recorder = createSqlRecorder([[], [{ total: 0 }]]);
    const res = await app().request("/v1/admin/organizations?limit=100000&page=2", {}, env);
    expect(await res.json()).toMatchObject({ pagination: { page: 2, limit: 100 } });
  });
});

describe("GET /v1/admin/stats/top-orgs", () => {
  it("filters plans with a bound IN list for the returned orgs", async () => {
    state.recorder = createSqlRecorder([
      [{ organizationId: "o1", name: "O1", slug: "o1", impressions: 5, clicks: 1, redemptions: 0, revenueSaved: 0 }],
      [{ organizationId: "o1", plan: "pro" }],
    ]);
    const res = await app().request("/v1/admin/stats/top-orgs", {}, env);
    expect(res.status).toBe(200);
    const planQuery = state.recorder.queries[1]!;
    expect(planQuery.sql).toContain('"subscriptions"."organization_id" in ($1)');
    expect(planQuery.params[0]).toBe("o1");
    expect(((await res.json()) as any).data[0].plan).toBe("pro");
  });
});

describe("summarizeSubscriptions (admin MRR)", () => {
  const row = (fields: Partial<{ plan: string; environment: string; recurringAmount: number | null; currency: string | null }>) => ({
    plan: "pro",
    environment: "live",
    recurringAmount: null,
    currency: null,
    ...fields,
  });

  it("leaves test-mode subscriptions out of MRR and the Pro count, and reports how many", () => {
    const out = summarizeSubscriptions([row({ environment: "test" }), row({ environment: "test" })]);
    expect(out).toMatchObject({ estimatedMRR: 0, mrrByCurrency: {}, testSubscriptions: 2 });
    expect(out.planCounts.pro).toBe(0);
  });

  it("counts each live subscription at the amount it is charged, per currency, never adding currencies", () => {
    const out = summarizeSubscriptions([
      row({ recurringAmount: 1900, currency: "USD" }),
      row({ recurringAmount: 570, currency: "USD" }),
      row({ recurringAmount: 48_000, currency: "INR" }),
      row({ recurringAmount: 600, currency: "JPY" }),
    ]);
    expect(out.planCounts.pro).toBe(4);
    expect(out.mrrByCurrency).toEqual({ USD: 24.7, INR: 480, JPY: 600 });
    expect(out.estimatedMRR).toBe(24.7);
  });

  it("counts a row recorded before amounts were stored at the Pro list price, and folds legacy business into Pro", () => {
    const out = summarizeSubscriptions([row({}), row({ plan: "business" }), row({ plan: "free" })]);
    expect(out.planCounts.pro).toBe(2);
    expect(out.estimatedMRR).toBe(38);
  });
});
