import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import type { AppEnv } from "../bindings";
import { createTestBindings } from "../test/helpers";
import { createSqlRecorder, type SqlRecorder } from "../lib/sql-recorder-test-helpers";

// sessionMiddleware: session lookup (Better Auth stubbed) plus the per-request
// ban re-read from the user row (real Drizzle SQL against a recorder).

const state = vi.hoisted(() => ({
  recorder: null as unknown as SqlRecorder,
  session: null as null | { user: { id: string }; session: { id: string } },
}));

vi.mock("../db", () => ({ createDb: () => state.recorder.db }));
vi.mock("../auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../auth")>();
  return { ...actual, createAuth: () => ({ api: { getSession: async () => state.session } }) };
});

const { sessionMiddleware } = await import("./session");

function app() {
  const a = new Hono<AppEnv>();
  a.use("/v1/*", sessionMiddleware);
  a.get("/v1/me", (c) => c.json({ userId: c.get("user").id }));
  return a;
}

const env = createTestBindings();

describe("sessionMiddleware", () => {
  beforeEach(() => {
    state.recorder = createSqlRecorder();
    state.session = null;
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it("answers 401 without a session, before any database read", async () => {
    const res = await app().request("/v1/me", {}, env);
    expect(res.status).toBe(401);
    expect(state.recorder.queries).toHaveLength(0);
  });

  it("re-reads the ban from the user row and refuses a banned user (even with a cached session)", async () => {
    state.session = { user: { id: "u_banned" }, session: { id: "s" } };
    state.recorder = createSqlRecorder([[{ banned: true }]]);
    const res = await app().request("/v1/me", {}, env);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Forbidden: account suspended" });
    expect(state.recorder.queries[0]).toEqual({
      // NOW() keeps the ban check out of Hyperdrive's query cache (auth.ts isUserBanned).
      sql: 'select "banned", NOW() from "user" where "user"."id" = $1 limit $2',
      params: ["u_banned", 1],
    });
  });

  it("lets a non-banned user through and sets the user", async () => {
    state.session = { user: { id: "u_ok" }, session: { id: "s" } };
    state.recorder = createSqlRecorder([[{ banned: null }]]);
    const res = await app().request("/v1/me", {}, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ userId: "u_ok" });
  });

  it("fails closed (503) when the ban check cannot run, and logs it", async () => {
    state.session = { user: { id: "u1" }, session: { id: "s" } };
    state.recorder = createSqlRecorder([new Error("connection refused")]);
    const res = await app().request("/v1/me", {}, env);
    expect(res.status).toBe(503);
    expect(console.error).toHaveBeenCalledWith(
      "session: ban check failed",
      expect.objectContaining({ userId: "u1", error: expect.stringContaining("connection refused") }),
    );
  });
});
