import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { API_KEY_PERMISSIONS, PERMISSIONS, PERMISSION_KEYS } from "@gopaylocal/shared/permissions";
import type { AppEnv } from "../bindings";
import { createExecutionContext, createTestBindings } from "../test/helpers";
import { createSqlRecorder, type SqlRecorder } from "../lib/sql-recorder-test-helpers";

// The secret-key principal: how a Bearer key is parsed, looked up, limited and
// refused, that it never falls back to (or mixes with) a session, and how
// teamMiddleware and requirePermission treat it. createDb() returns a recorder
// (real Drizzle SQL, canned rows); the session middleware is a stub that
// records whether it ran.

const state = vi.hoisted(() => ({
  recorder: null as unknown as SqlRecorder,
  sessionCalls: 0,
}));

vi.mock("../db", () => ({ createDb: () => state.recorder.db }));
vi.mock("./session", async () => {
  const { createMiddleware } = await import("hono/factory");
  return {
    sessionMiddleware: createMiddleware(async (c, next) => {
      state.sessionCalls++;
      c.set("user", { id: "session-user" });
      await next();
    }),
  };
});
vi.mock("../../../../packages/banner/dist/banner.js", () => ({ default: "" }));

const { sessionOrApiKeyMiddleware, apiKeyMiddleware, bearerToken, failureLimiterKey, resetApiKeyHoldsForTests, SECRET_KEY_RE } =
  await import("./api-key");
const { teamMiddleware } = await import("./team");
const { requirePermission } = await import("./permissions");
const me = (await import("../routes/me")).default;

const KEY = `gpl_sk_${"0123456789abcdef".repeat(4)}`;
const OTHER_KEY = `gpl_sk_${"fedcba9876543210".repeat(4)}`;
const THIRD_KEY = `gpl_sk_${"00112233445566778899aabbccddeeff".repeat(2)}`;
const PUBLIC_KEY = `gpl_pk_${"0123456789abcdef".repeat(4)}`;
const sha256 = (v: string) => createHash("sha256").update(v).digest("hex");

const CREATED_AT = new Date("2026-11-01T10:00:00.000Z");

function keyRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "key_1",
    name: "CI deploy",
    keyType: "secret",
    keyPrefix: "gpl_sk_01234567...",
    createdAt: CREATED_AT,
    organizationId: "org_a",
    organizationName: "Acme",
    ownerBanned: false,
    creatorBanned: false,
    lastUsedStale: false,
    ...overrides,
  };
}

/** A limiter binding whose answer the test controls; records every key it was asked about. */
function limiter(success = true) {
  const calls: string[] = [];
  const binding = {
    calls,
    success,
    limit: vi.fn(async ({ key }: { key: string }) => {
      calls.push(key);
      return { success: binding.success };
    }),
  };
  return binding;
}

function app() {
  const a = new Hono<AppEnv>();
  a.use("/v1/teams/*", sessionOrApiKeyMiddleware);
  a.use("/v1/teams/:orgId/*", teamMiddleware);
  a.get("/v1/teams/:orgId/products", requirePermission("products.view"), (c) =>
    c.json({ apiKey: c.get("apiKey") ?? null, user: c.get("user") ?? null, role: c.get("memberRole") ?? null }),
  );
  a.post("/v1/teams/:orgId/invitations", requirePermission("team.invite"), (c) => c.json({ ok: true }));
  a.post("/v1/teams/:orgId/api-keys", requirePermission("apiKeys.manage"), (c) => c.json({ ok: true }));
  a.delete("/v1/teams/:orgId", requirePermission("workspace.delete"), (c) => c.json({ ok: true }));
  a.use("/v1/me", apiKeyMiddleware);
  a.route("/", me);
  return a;
}

const bearer = (token: string, extra: Record<string, string> = {}) => ({
  headers: { authorization: `Bearer ${token}`, "cf-connecting-ip": "203.0.113.7", ...extra },
});

let failIp: ReturnType<typeof limiter>;
let perKey: ReturnType<typeof limiter>;
let env: ReturnType<typeof createTestBindings>;

beforeEach(() => {
  resetApiKeyHoldsForTests();
  state.sessionCalls = 0;
  state.recorder = createSqlRecorder();
  failIp = limiter();
  perKey = limiter();
  env = createTestBindings({
    RL_API_KEY_FAIL_IP: failIp as unknown as RateLimit,
    RL_API_KEY: perKey as unknown as RateLimit,
  });
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("bearerToken", () => {
  it.each([
    ["Bearer abc", "abc"],
    ["bearer abc", "abc"],
    ["BEARER  abc ", "abc"],
  ])("reads %j", (header, token) => {
    expect(bearerToken(header)).toBe(token);
  });

  it.each([undefined, "", "Bearer", "Bearer ", "Basic abc", "Bearer a b", "Token abc", "abc"])(
    "refuses %j",
    (header) => {
      expect(bearerToken(header)).toBeNull();
    },
  );

  it("matches exactly the shape api-keys.ts issues (prefix + 64 lowercase hex)", () => {
    expect(SECRET_KEY_RE.test(KEY)).toBe(true);
    expect(SECRET_KEY_RE.test(KEY.toUpperCase())).toBe(false);
    expect(SECRET_KEY_RE.test(`${KEY}0`)).toBe(false);
    expect(SECRET_KEY_RE.test(KEY.slice(0, -1))).toBe(false);
    expect(SECRET_KEY_RE.test(PUBLIC_KEY)).toBe(false);
  });
});

describe("failureLimiterKey", () => {
  it.each([
    ["203.0.113.7", "ip:203.0.113.7"],
    ["2001:db8:1:2:3:4:5:6", "ip:2001:db8:1:2::/64"],
    ["2001:0DB8:0001:0002::9", "ip:2001:db8:1:2::/64"],
    ["2001:db8::1", "ip:2001:db8:0:0::/64"],
    ["2a06:98c0:3600::103", "ip:2a06:98c0:3600:0::/64"],
    ["::1", "ip:0:0:0:0::/64"],
    ["::ffff:203.0.113.7", "ip:::ffff:203.0.113.7"],
    ["not-an-ip", "ip:not-an-ip"],
    ["1:2:3:4:5:6:7:8:9", "ip:1:2:3:4:5:6:7:8:9"],
    ["1::2::3", "ip:1::2::3"],
  ])("%j counts against %j", (ip, key) => {
    expect(failureLimiterKey(ip)).toBe(key);
  });
});

describe("which credential a request uses", () => {
  it("uses the session when there is no Authorization header", async () => {
    state.recorder = createSqlRecorder([[{ role: "owner", banned: false }]]);
    const res = await app().request("/v1/teams/org_a/products", { headers: { cookie: "s=1" } }, env);
    expect(res.status).toBe(200);
    expect(state.sessionCalls).toBe(1);
  });

  it("with a Bearer header, never reads the session, even with a session cookie", async () => {
    state.recorder = createSqlRecorder([[keyRow()]]);
    const res = await app().request("/v1/teams/org_a/products", bearer(KEY, { cookie: "better-auth.session_token=abc" }), env);
    expect(res.status).toBe(200);
    expect(state.sessionCalls).toBe(0);
    const body = (await res.json()) as { user: unknown; role: unknown };
    expect(body.user).toBeNull();
    expect(body.role).toBeNull();
  });

  it("a bad key with a valid session cookie is refused, not rescued by the cookie", async () => {
    const res = await app().request("/v1/teams/org_a/products", bearer("nope", { cookie: "better-auth.session_token=abc" }), env);
    expect(res.status).toBe(401);
    expect(state.sessionCalls).toBe(0);
  });

  it.each(["Bearer", "bearer ", "BEARER a b", `Bearer ${KEY} extra`])(
    "refuses a malformed Bearer header (%j) without a lookup or the session",
    async (header) => {
      const res = await app().request("/v1/teams/org_a/products", { headers: { authorization: header, cookie: "s=1" } }, env);
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "Invalid API key", code: "invalid_api_key" });
      expect(res.headers.get("www-authenticate")).toBe('Bearer error="invalid_token"');
      expect(state.recorder.queries).toHaveLength(0);
      expect(state.sessionCalls).toBe(0);
    },
  );

  // HTTP Basic (or any other scheme) in front of a self-hosted API must not
  // break the dashboard: only the Bearer scheme takes the key path.
  it.each(["Basic dXNlcjpwYXNz", 'Digest username="ops", realm="api"', "Token abc", "Bearerx abc", ""])(
    "ignores a non-Bearer Authorization header (%j) and uses the session",
    async (header) => {
      state.recorder = createSqlRecorder([[{ role: "owner", banned: false }]]);
      const res = await app().request("/v1/teams/org_a/products", { headers: { authorization: header, cookie: "s=1" } }, env);
      expect(res.status).toBe(200);
      expect(state.sessionCalls).toBe(1);
      expect(((await res.json()) as { user: unknown }).user).toEqual({ id: "session-user" });
      expect(failIp.calls).toEqual([]);
    },
  );
});

describe("refusals before any lookup", () => {
  it.each([
    ["truncated", KEY.slice(0, -1)],
    ["uppercase hex", KEY.toUpperCase().replace("GPL_SK_", "gpl_sk_")],
    ["unknown prefix", `gpl_xx_${"0".repeat(64)}`],
    ["random", "sk_live_abc"],
  ])("a malformed token (%s) is 401 invalid_api_key, no query, no limiter", async (_label, token) => {
    const res = await app().request("/v1/teams/org_a/products", bearer(token), env);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Invalid API key", code: "invalid_api_key" });
    expect(state.recorder.queries).toHaveLength(0);
    expect(failIp.calls).toEqual([]);
  });

  it("a public key is 401 public_key_not_allowed, no query", async () => {
    const res = await app().request("/v1/teams/org_a/products", bearer(PUBLIC_KEY), env);
    expect(res.status).toBe(401);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({
      error: "Public keys (gpl_pk_) only work in the banner. Use a secret key (gpl_sk_) for this API.",
      code: "public_key_not_allowed",
    });
    expect(text).not.toContain(PUBLIC_KEY);
    expect(state.recorder.queries).toHaveLength(0);
  });
});

describe("the lookup", () => {
  it("is one query by key hash, joined to the workspace, with the banned-owner, banned-creator and lastUsedAt checks", async () => {
    state.recorder = createSqlRecorder([[keyRow()]]);
    const res = await app().request("/v1/teams/org_a/products", bearer(KEY), env);
    expect(res.status).toBe(200);
    expect(state.recorder.queries).toHaveLength(1);
    const [q] = state.recorder.queries;
    expect(q!.sql).toBe(
      'select "api_keys"."id", "api_keys"."name", "api_keys"."key_type", "api_keys"."key_prefix", "api_keys"."created_at", ' +
        '"api_keys"."organization_id", "organization"."name", ' +
        'exists (select 1 from "member" inner join "user" on "user"."id" = "member"."userId" ' +
        'where "member"."organizationId" = "api_keys"."organization_id" and "user"."banned" = true ' +
        "and 'owner' = any(string_to_array(replace(\"member\".\"role\", ' ', ''), ','))), " +
        'exists (select 1 from "user" where "user"."id" = "api_keys"."created_by_user_id" and "user"."banned" = true), ' +
        "(\"api_keys\".\"last_used_at\" is null or \"api_keys\".\"last_used_at\" < NOW() - interval '5 minutes') " +
        'from "api_keys" inner join "organization" on "organization"."id" = "api_keys"."organization_id" ' +
        'where "api_keys"."key_hash" = $1 limit $2',
    );
    // Upper-case NOW(): the form Cloudflare documents as keeping a statement
    // out of Hyperdrive's query cache (detection is by text).
    expect(q!.sql).toContain("NOW()");
    // The hash, never the key.
    expect(q!.params).toEqual([sha256(KEY), 1]);
    expect(JSON.stringify(q!.params)).not.toContain(KEY);
  });

  it("sets the key principal (and no user or role) for the handler", async () => {
    state.recorder = createSqlRecorder([[keyRow()]]);
    const res = await app().request("/v1/teams/org_a/products", bearer(KEY), env);
    expect(await res.json()).toEqual({
      apiKey: {
        id: "key_1",
        name: "CI deploy",
        keyPrefix: "gpl_sk_01234567...",
        createdAt: CREATED_AT.toISOString(),
        organizationId: "org_a",
        organizationName: "Acme",
      },
      user: null,
      role: null,
    });
  });

  it("fails closed (503) on a database error, logs without the key, and holds nothing", async () => {
    state.recorder = createSqlRecorder([new Error("connection refused"), [keyRow()]]);
    const first = await app().request("/v1/teams/org_a/products", bearer(KEY), env);
    expect(first.status).toBe(503);
    expect(await first.json()).toEqual({ error: "Service unavailable" });
    expect(console.error).toHaveBeenCalledWith("api-key: lookup failed", expect.objectContaining({ error: expect.any(String) }));
    expect(failIp.calls).toEqual([]);
    // A database error is not a failed key: the next request looks it up again.
    const second = await app().request("/v1/teams/org_a/products", bearer(KEY), env);
    expect(second.status).toBe(200);
  });

  it("refuses a row that is not a secret key (defensive), like an unknown key", async () => {
    state.recorder = createSqlRecorder([[keyRow({ keyType: "public" })]]);
    const res = await app().request("/v1/teams/org_a/products", bearer(KEY), env);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Invalid API key", code: "invalid_api_key" });
  });
});

describe("unknown and revoked keys", () => {
  it("answer 401 and count against the IP's failure limiter", async () => {
    state.recorder = createSqlRecorder([[]]);
    const res = await app().request("/v1/teams/org_a/products", bearer(KEY), env);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Invalid API key", code: "invalid_api_key" });
    expect(failIp.calls).toEqual(["ip:203.0.113.7"]);
    expect(perKey.calls).toEqual([]);
  });

  it("a key hash that failed is refused without a lookup for 60 seconds (still counted)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-19T12:00:00Z"));
    state.recorder = createSqlRecorder([[], [keyRow()]]);
    expect((await app().request("/v1/teams/org_a/products", bearer(KEY), env)).status).toBe(401);
    expect((await app().request("/v1/teams/org_a/products", bearer(KEY), env)).status).toBe(401);
    expect(state.recorder.queries).toHaveLength(1);
    expect(failIp.calls).toHaveLength(2);

    // Other keys are unaffected.
    state.recorder.results.unshift([keyRow({ id: "key_2" })]);
    expect((await app().request("/v1/teams/org_a/products", bearer(OTHER_KEY), env)).status).toBe(200);

    vi.setSystemTime(new Date("2026-11-19T12:01:01Z"));
    expect((await app().request("/v1/teams/org_a/products", bearer(KEY), env)).status).toBe(200);
  });

  it("once the failure limiter refuses an IP, only failing requests get 429: a valid key from that IP still succeeds", async () => {
    // Many callers share one egress IP (every Cloudflare Worker, NAT, CI
    // runners): someone else's bad keys must never lock out a valid key.
    failIp.success = false;
    state.recorder = createSqlRecorder([[], [keyRow()], []]);
    const limited = await app().request("/v1/teams/org_a/products", bearer(KEY), env);
    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({ error: "rate_limited" });
    expect(limited.headers.get("retry-after")).toBe("60");

    // A valid key from the same IP is looked up and accepted; it never
    // touches the failure limiter.
    const valid = await app().request("/v1/teams/org_a/products", bearer(OTHER_KEY), env);
    expect(valid.status).toBe(200);
    expect(failIp.calls).toEqual(["ip:203.0.113.7"]);

    // Another unknown key from that IP costs one lookup and is refused with 429.
    const unknown = await app().request("/v1/teams/org_a/products", bearer(THIRD_KEY), env);
    expect(unknown.status).toBe(429);
    expect(state.recorder.queries).toHaveLength(3);
    expect(failIp.calls).toEqual(["ip:203.0.113.7", "ip:203.0.113.7"]);
  });

  it("a held key hash gets 429 while the IP's failure limiter refuses, 401 otherwise", async () => {
    state.recorder = createSqlRecorder([[]]);
    expect((await app().request("/v1/teams/org_a/products", bearer(KEY), env)).status).toBe(401);
    failIp.success = false;
    expect((await app().request("/v1/teams/org_a/products", bearer(KEY), env)).status).toBe(429);
    expect(state.recorder.queries).toHaveLength(1);
  });

  it("counts IPv6 failures per /64, so rotating addresses inside one allocation shares one bucket", async () => {
    state.recorder = createSqlRecorder([[], []]);
    await app().request("/v1/teams/org_a/products", bearer(KEY, { "cf-connecting-ip": "2001:db8:1:2::a" }), env);
    await app().request("/v1/teams/org_a/products", bearer(OTHER_KEY, { "cf-connecting-ip": "2001:db8:1:2:ffff:ffff:ffff:ffff" }), env);
    expect(failIp.calls).toEqual(["ip:2001:db8:1:2::/64", "ip:2001:db8:1:2::/64"]);
  });

  it("without the failure limiter binding, fails open (401, never 429)", async () => {
    const bare = createTestBindings();
    state.recorder = createSqlRecorder([[], []]);
    for (const token of [KEY, OTHER_KEY]) {
      const res = await app().request("/v1/teams/org_a/products", bearer(token), bare);
      expect(res.status).toBe(401);
    }
  });
});

describe("a valid key", () => {
  it("consumes its own per-key limiter token, keyed by key id", async () => {
    state.recorder = createSqlRecorder([[keyRow()]]);
    await app().request("/v1/teams/org_a/products", bearer(KEY), env);
    expect(perKey.calls).toEqual(["key:key_1"]);
    expect(failIp.calls).toEqual([]);
  });

  it("over its per-key limit: 429 with Retry-After", async () => {
    perKey.success = false;
    state.recorder = createSqlRecorder([[keyRow()]]);
    const res = await app().request("/v1/teams/org_a/products", bearer(KEY), env);
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("60");
  });

  it("of a workspace with a banned owner: 403 with the session path's body, after its per-key limiter", async () => {
    state.recorder = createSqlRecorder([[keyRow({ ownerBanned: true })]]);
    const res = await app().request("/v1/teams/org_a/products", bearer(KEY), env);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Forbidden: account suspended" });
    // A refused key is still rate limited.
    expect(perKey.calls).toEqual(["key:key_1"]);
    expect(failIp.calls).toEqual([]);
  });

  it("created by a banned user: the same 403 as a banned owner, from the same single query", async () => {
    state.recorder = createSqlRecorder([[keyRow({ creatorBanned: true })]]);
    const res = await app().request("/v1/teams/org_a/products", bearer(KEY), env);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Forbidden: account suspended" });
    expect(state.recorder.queries).toHaveLength(1);
    expect(perKey.calls).toEqual(["key:key_1"]);
    expect(console.warn).toHaveBeenCalledWith(
      "api-key: refused, the key's creator is banned",
      { apiKeyId: "key_1", orgId: "org_a" },
    );
  });

  it("over its per-key limit, a refused key (banned owner) answers 429, not 403", async () => {
    perKey.success = false;
    state.recorder = createSqlRecorder([[keyRow({ ownerBanned: true })]]);
    const res = await app().request("/v1/teams/org_a/products", bearer(KEY), env);
    expect(res.status).toBe(429);
  });

  it("writes lastUsedAt after the response, conditionally, only when it is stale", async () => {
    state.recorder = createSqlRecorder([[keyRow({ lastUsedStale: true })], []]);
    const ctx = createExecutionContext();
    const res = await app().request("/v1/teams/org_a/products", bearer(KEY), env, ctx);
    await ctx.settle();
    expect(res.status).toBe(200);
    expect(state.recorder.queries).toHaveLength(2);
    const update = state.recorder.queries[1]!;
    expect(update.sql).toBe(
      'update "api_keys" set "last_used_at" = $1 where ("api_keys"."id" = $2 and ' +
        "(\"api_keys\".\"last_used_at\" is null or \"api_keys\".\"last_used_at\" < NOW() - interval '5 minutes'))",
    );
    // The timestamp column serializes the Date to an ISO string.
    expect(Number.isNaN(Date.parse(String(update.params[0])))).toBe(false);
    expect(update.params[1]).toBe("key_1");
  });

  it("does not write lastUsedAt when it was written in the last 5 minutes", async () => {
    state.recorder = createSqlRecorder([[keyRow({ lastUsedStale: false })]]);
    const ctx = createExecutionContext();
    await app().request("/v1/teams/org_a/products", bearer(KEY), env, ctx);
    await ctx.settle();
    expect(state.recorder.queries).toHaveLength(1);
  });

  it("a failed lastUsedAt write is logged and does not fail the request", async () => {
    state.recorder = createSqlRecorder([[keyRow({ lastUsedStale: true })], new Error("deadlock")]);
    const ctx = createExecutionContext();
    const res = await app().request("/v1/teams/org_a/products", bearer(KEY), env, ctx);
    await ctx.settle();
    expect(res.status).toBe(200);
    expect(console.error).toHaveBeenCalledWith(
      "api-key: lastUsedAt update failed",
      expect.objectContaining({ apiKeyId: "key_1" }),
    );
  });
});

describe("the key's workspace and permissions (teamMiddleware, requirePermission)", () => {
  it("a key of workspace A on workspace B's routes gets exactly the cross-tenant session answer", async () => {
    state.recorder = createSqlRecorder([[keyRow()]]);
    const res = await app().request("/v1/teams/org_b/products", bearer(KEY), env);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Forbidden: not a member of this organization" });
    // No membership lookup for a key: the one query is the key lookup.
    expect(state.recorder.queries).toHaveLength(1);
  });

  it("on the bare workspace path too (DELETE /v1/teams/:orgId of another workspace)", async () => {
    state.recorder = createSqlRecorder([[keyRow()]]);
    const res = await app().request("/v1/teams/org_b", { method: "DELETE", ...bearer(KEY) }, env);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Forbidden: not a member of this organization" });
  });

  it.each([
    ["POST", "/v1/teams/org_a/invitations", "team.invite"],
    ["POST", "/v1/teams/org_a/api-keys", "apiKeys.manage"],
    ["DELETE", "/v1/teams/org_a", "workspace.delete"],
  ])("%s %s is refused to a key of that workspace (403 forbidden_api_key)", async (method, path, permission) => {
    state.recorder = createSqlRecorder([[keyRow()]]);
    const res = await app().request(path, { method, ...bearer(KEY) }, env);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "forbidden_api_key", permission });
  });
});

describe("GET /v1/me", () => {
  it("answers the key's workspace, identity and permissions", async () => {
    state.recorder = createSqlRecorder([[keyRow()]]);
    const res = await app().request("/v1/me", bearer(KEY), env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      data: {
        organization: { id: "org_a", name: "Acme" },
        apiKey: { id: "key_1", name: "CI deploy", keyPrefix: "gpl_sk_01234567...", createdAt: CREATED_AT.toISOString() },
        permissions: API_KEY_PERMISSIONS,
      },
    });
  });

  it("lists exactly the permissions whose apiKey cell is 'all'", () => {
    expect(API_KEY_PERMISSIONS).toEqual(PERMISSION_KEYS.filter((p) => PERMISSIONS[p].apiKey === "all"));
    expect(API_KEY_PERMISSIONS).toContain("products.create");
    expect(API_KEY_PERMISSIONS).not.toContain("apiKeys.manage");
  });

  it("without a key: 401 missing_api_key, the session is never consulted", async () => {
    const res = await app().request("/v1/me", { headers: { cookie: "better-auth.session_token=abc" } }, env);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Missing API key. Send Authorization: Bearer gpl_sk_...", code: "missing_api_key" });
    expect(state.sessionCalls).toBe(0);
  });

  it.each(["Basic dXNlcjpwYXNz", "Token abc"])("with a non-Bearer header (%j): 401 missing_api_key, no session", async (header) => {
    const res = await app().request("/v1/me", { headers: { authorization: header, cookie: "s=1" } }, env);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Missing API key. Send Authorization: Bearer gpl_sk_...", code: "missing_api_key" });
    expect(res.headers.get("www-authenticate")).toBe("Bearer");
    expect(state.sessionCalls).toBe(0);
    expect(state.recorder.queries).toHaveLength(0);
  });

  it("with a public key: 401 public_key_not_allowed", async () => {
    const res = await app().request("/v1/me", bearer(PUBLIC_KEY), env);
    expect(res.status).toBe(401);
    expect(((await res.json()) as { code: string }).code).toBe("public_key_not_allowed");
  });
});

describe("the key never reaches a log or a response", () => {
  it("across every refusal and success path", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
    state.recorder = createSqlRecorder([new Error("boom"), [], [keyRow({ ownerBanned: true })], [keyRow({ lastUsedStale: true })], new Error("write failed")]);
    const bodies: string[] = [];
    for (const [token, path] of [
      [KEY, "/v1/teams/org_a/products"],
      [OTHER_KEY, "/v1/teams/org_a/products"],
      [KEY, "/v1/teams/org_a/products"],
      [KEY, "/v1/teams/org_b/products"],
      [PUBLIC_KEY, "/v1/me"],
    ] as const) {
      const ctx = createExecutionContext();
      const res = await app().request(path, bearer(token), env, ctx);
      await ctx.settle();
      bodies.push(await res.text());
    }
    const logged = JSON.stringify([
      ...vi.mocked(console.error).mock.calls,
      ...vi.mocked(console.warn).mock.calls,
      ...log.mock.calls,
      ...info.mock.calls,
      ...debug.mock.calls,
    ]);
    // The failing paths did log (so the check is not vacuous).
    expect(logged).toContain("api-key: lookup failed");
    expect(logged).toContain("api-key: lastUsedAt update failed");
    for (const token of [KEY, OTHER_KEY, PUBLIC_KEY]) {
      expect(logged).not.toContain(token);
      expect(logged).not.toContain(token.slice(7));
      for (const body of bodies) expect(body).not.toContain(token.slice(7, 30));
    }
  });
});

// ── Handlers never assume a signed-in user ──────────────────────────────────
// A key request has no `user` and no `memberRole`. Product scope is resolved
// with lib/product-access.ts allowedProductIdsFor / allowedCampaignIdsFor /
// scopeOf, which know about keys; reading c.get("user") in a /v1/teams handler
// would 500 for a key. Admin routes are session-only and may read it.

describe("route handlers", () => {
  it("no /v1/teams route module reads c.get(\"user\") or c.get(\"memberRole\") directly", () => {
    const dir = fileURLToPath(new URL("../routes/", import.meta.url));
    const offenders = readdirSync(dir)
      .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && f !== "admin.ts")
      .filter((f) => /c\.get\("(user|memberRole)"\)/.test(readFileSync(dir + f, "utf8")));
    expect(offenders).toEqual([]);
  });
});
