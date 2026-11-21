import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import type { AppEnv } from "../bindings";
import { createTestBindings } from "../test/helpers";
import { createSqlRecorder, type SqlRecorder } from "../lib/sql-recorder-test-helpers";

// Unit tests for the org-membership gate and the admin gate. createDb()
// returns a recorder (real Drizzle SQL, canned rows), so the tests pin what
// each gate reads and how it decides, without a database.

const state = vi.hoisted(() => ({ recorder: null as unknown as SqlRecorder }));
vi.mock("../db", () => ({ createDb: () => state.recorder.db }));

const { teamMiddleware } = await import("./team");
const { requirePermission } = await import("./permissions");
const { adminMiddleware } = await import("./admin");

function teamApp(user: { id: string; role?: string } | null) {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    if (user) c.set("user", user);
    await next();
  });
  app.use("/v1/teams/:orgId/*", teamMiddleware);
  app.get("/v1/teams/:orgId/thing", (c) => c.json({ role: c.get("memberRole") }));
  app.delete("/v1/teams/:orgId", requirePermission("workspace.delete"), (c) => c.json({ deleted: true }));
  return app;
}

function adminApp(user: { id: string; role?: string } | null) {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    if (user) c.set("user", user);
    await next();
  });
  app.use("/v1/admin/*", adminMiddleware);
  app.get("/v1/admin/stats", (c) => c.json({ ok: true }));
  return app;
}

const env = createTestBindings();

describe("teamMiddleware", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it("looks the membership up by the path org AND the session user, joined to the user row", async () => {
    state.recorder = createSqlRecorder([[{ role: "admin", banned: false }]]);
    const res = await teamApp({ id: "u1" }).request("/v1/teams/org_1/thing", {}, env);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ role: "admin" });
    const [q] = state.recorder.queries;
    expect(q!.sql).toBe(
      'select "member"."role", "user"."banned", NOW() from "member" inner join "user" on "user"."id" = "member"."userId" ' +
        'where ("member"."organizationId" = $1 and "member"."userId" = $2) limit $3',
    );
    expect(q!.params).toEqual(["org_1", "u1", 1]);
  });

  it("keeps the membership query out of Hyperdrive's query cache (NOW() in the text)", async () => {
    // Hyperdrive caches reads for up to ~75 s and never on statements calling
    // NOW(); without it a ban or a removed membership would apply that late.
    state.recorder = createSqlRecorder([[{ role: "admin", banned: false }]]);
    await teamApp({ id: "u1" }).request("/v1/teams/org_1/thing", {}, env);
    expect(state.recorder.queries[0]!.sql).toContain("NOW()");
  });

  it("answers 403 to a non-member", async () => {
    state.recorder = createSqlRecorder([[]]);
    const res = await teamApp({ id: "u1" }).request("/v1/teams/org_b/thing", {}, env);
    expect(res.status).toBe(403);
  });

  it("answers 403 to a banned member, whatever their role", async () => {
    state.recorder = createSqlRecorder([[{ role: "owner", banned: true }]]);
    const res = await teamApp({ id: "u1" }).request("/v1/teams/org_1/thing", {}, env);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Forbidden: account suspended" });
  });

  it("treats a NULL banned flag as not banned", async () => {
    state.recorder = createSqlRecorder([[{ role: "member", banned: null }]]);
    const res = await teamApp({ id: "u1" }).request("/v1/teams/org_1/thing", {}, env);
    expect(res.status).toBe(200);
  });

  it("fails closed (403) on a database error and logs why", async () => {
    state.recorder = createSqlRecorder([new Error("connection refused")]);
    const res = await teamApp({ id: "u1" }).request("/v1/teams/org_1/thing", {}, env);
    expect(res.status).toBe(403);
    expect(console.error).toHaveBeenCalledWith(
      "team: membership check failed",
      expect.objectContaining({ orgId: "org_1", userId: "u1", error: expect.stringContaining("connection refused") }),
    );
  });

  it("answers 401 without a session user, before touching the database", async () => {
    state.recorder = createSqlRecorder();
    const res = await teamApp(null).request("/v1/teams/org_1/thing", {}, env);
    expect(res.status).toBe(401);
    expect(state.recorder.queries).toHaveLength(0);
  });

  it("also guards the bare org path (/v1/teams/:orgId), so requirePermission sees the real role", async () => {
    state.recorder = createSqlRecorder([[{ role: "admin", banned: false }]]);
    const res = await teamApp({ id: "u1" }).request("/v1/teams/org_1", { method: "DELETE" }, env);
    expect(res.status).toBe(403); // workspace.delete is owner-only
    expect(state.recorder.queries).toHaveLength(1);
  });

  it("resolves Better Auth's comma-separated roles to the highest known one", async () => {
    state.recorder = createSqlRecorder([[{ role: "member, admin", banned: false }]]);
    const res = await teamApp({ id: "u1" }).request("/v1/teams/org_1/thing", {}, env);
    expect(await res.json()).toEqual({ role: "admin" });
  });

  it("refuses (403) and logs a membership whose role the permission table doesn't know", async () => {
    state.recorder = createSqlRecorder([[{ role: "billing", banned: false }]]);
    const res = await teamApp({ id: "u1" }).request("/v1/teams/org_1/thing", {}, env);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Forbidden: unknown role" });
    expect(console.error).toHaveBeenCalledWith(
      "team: membership has no known role",
      expect.objectContaining({ orgId: "org_1", role: "billing" }),
    );
  });
});

describe("adminMiddleware", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it("refuses a non-admin session without a database read", async () => {
    state.recorder = createSqlRecorder();
    const res = await adminApp({ id: "u1", role: "user" }).request("/v1/admin/stats", {}, env);
    expect(res.status).toBe(403);
    expect(state.recorder.queries).toHaveLength(0);
  });

  it("re-reads the role from the user row: a stale admin session of a demoted user is refused", async () => {
    state.recorder = createSqlRecorder([[{ role: "user", banned: false }]]);
    const res = await adminApp({ id: "u1", role: "admin" }).request("/v1/admin/stats", {}, env);
    expect(res.status).toBe(403);
    expect(state.recorder.queries[0]!.sql).toBe(
      'select "role", "banned", NOW() from "user" where "user"."id" = $1 limit $2',
    );
    expect(state.recorder.queries[0]!.params).toEqual(["u1", 1]);
  });

  it("keeps the role re-read out of Hyperdrive's query cache (NOW() in the text)", async () => {
    // Hyperdrive caches reads for up to ~75 s and never on statements calling
    // NOW(); without it a demoted admin would keep admin access that long.
    state.recorder = createSqlRecorder([[{ role: "admin", banned: false }]]);
    await adminApp({ id: "u1", role: "admin" }).request("/v1/admin/stats", {}, env);
    expect(state.recorder.queries[0]!.sql).toContain("NOW()");
  });

  it("refuses a banned admin", async () => {
    state.recorder = createSqlRecorder([[{ role: "admin", banned: true }]]);
    const res = await adminApp({ id: "u1", role: "admin" }).request("/v1/admin/stats", {}, env);
    expect(res.status).toBe(403);
  });

  it("admits an admin whose row still says admin", async () => {
    state.recorder = createSqlRecorder([[{ role: "admin", banned: null }]]);
    const res = await adminApp({ id: "u1", role: "admin" }).request("/v1/admin/stats", {}, env);
    expect(res.status).toBe(200);
  });

  it("fails closed (403) on a database error and logs it", async () => {
    state.recorder = createSqlRecorder([new Error("timeout")]);
    const res = await adminApp({ id: "u1", role: "admin" }).request("/v1/admin/stats", {}, env);
    expect(res.status).toBe(403);
    expect(console.error).toHaveBeenCalledWith("admin: role check failed", expect.objectContaining({ userId: "u1" }));
  });
});
