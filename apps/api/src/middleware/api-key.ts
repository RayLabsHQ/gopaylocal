import { createMiddleware } from "hono/factory";
import type { Context, Next } from "hono";
import { and, eq, isNull, lt, or, sql } from "drizzle-orm";
import { API_KEY_PREFIX_PUBLIC, API_KEY_PREFIX_SECRET } from "@gopaylocal/shared/constants";
import type { AppEnv } from "../bindings";
import { createDb, type Database } from "../db";
import { apiKeys, members, organizations, users } from "../db/schema";
import { checkRateLimit, enforceRateLimit, rateLimitedResponse } from "../lib/rate-limit";
import { errorSummary } from "../lib/log";
import { sessionMiddleware } from "./session";

/**
 * Secret API keys (gpl_sk_) on the management API.
 *
 * A request whose Authorization header uses the Bearer scheme (any case) is
 * authenticated by its key and nothing else: cookies are never read, so a key
 * never borrows a browser session and a session never borrows a key. Any other
 * scheme (Basic, Digest, ...) is not ours: it is ignored and the request is
 * authenticated by the session, so HTTP Basic auth in front of a self-hosted
 * API does not break the dashboard. A key is its own principal: the `apiKey`
 * column of the permission table (packages/shared/src/permissions) says what it
 * may do, with every product of its workspace in scope. teamMiddleware refuses
 * a key whose workspace is not the path's `:orgId`.
 *
 * Cost of a request:
 *  - a malformed token, or a public key (gpl_pk_), is refused before any lookup;
 *  - a well-formed key costs one indexed query (key, workspace name, banned
 *    owner, banned creator, lastUsedAt staleness). There is no positive cache,
 *    so revoking a key, or banning an owner or the key's creator, applies on
 *    the next request. The query calls NOW(), which also keeps Hyperdrive's
 *    query cache from serving it: Hyperdrive never caches statements that call
 *    non-IMMUTABLE functions, and detects them by text, so keep the upper-case
 *    form Cloudflare documents;
 *  - accepted cost: each distinct well-formed unknown key costs one indexed
 *    query, the same as an unknown session cookie. Nothing refuses an IP as a
 *    whole: many callers share one (every Cloudflare Worker calling us egresses
 *    from the same address, and so do NATs and CI runners), and someone else's
 *    bad keys must never lock out a valid key;
 *  - an unknown or revoked key consumes a token of RL_API_KEY_FAIL_IP, keyed by
 *    the IPv4 address or the IPv6 /64. When that limiter refuses, the failing
 *    request gets 429 instead of 401; nothing else changes for that address. A
 *    key hash that failed is refused without a lookup for 60 seconds (still
 *    counted; isolate-local, free). A valid request never touches KV;
 *  - a found key consumes a token of RL_API_KEY (per key) before it is refused
 *    for a banned owner or creator, so a refused key is still rate limited;
 *  - lastUsedAt is written after the response, at most once per 5 minutes per key.
 *
 * The token is never logged and never echoed.
 */

export const SECRET_KEY_RE = new RegExp(`^${API_KEY_PREFIX_SECRET}[0-9a-f]{64}$`);

/** How long a failed key hash is held in this isolate. */
const FAILURE_HOLD_MS = 60_000;
/** Bound on the isolate-local map. */
const MAX_HELD = 10_000;

const failedKeyHashes = new Map<string, number>();

/** Test hook: forget every isolate-local hold. */
export function resetApiKeyHoldsForTests(): void {
  failedKeyHashes.clear();
}

function hold(map: Map<string, number>, key: string, now: number): void {
  if (map.size >= MAX_HELD && !map.has(key)) {
    for (const [k, until] of map) if (until <= now) map.delete(k);
    if (map.size >= MAX_HELD) {
      const oldest = map.keys().next().value;
      if (oldest !== undefined) map.delete(oldest);
    }
  }
  map.set(key, now + FAILURE_HOLD_MS);
}

function isHeld(map: Map<string, number>, key: string, now: number): boolean {
  const until = map.get(key);
  if (until === undefined) return false;
  if (until <= now) {
    map.delete(key);
    return false;
  }
  return true;
}

// ── Responses ───────────────────────────────────────────────────────────────

const BEARER_CHALLENGE = { "WWW-Authenticate": 'Bearer error="invalid_token"' };

export const INVALID_API_KEY = { error: "Invalid API key", code: "invalid_api_key" } as const;
export const PUBLIC_KEY_NOT_ALLOWED = {
  error: "Public keys (gpl_pk_) only work in the banner. Use a secret key (gpl_sk_) for this API.",
  code: "public_key_not_allowed",
} as const;
export const MISSING_API_KEY = {
  error: "Missing API key. Send Authorization: Bearer gpl_sk_...",
  code: "missing_api_key",
} as const;
/** Same body the session path answers for a banned user (middleware/session.ts, team.ts). */
export const ACCOUNT_SUSPENDED = { error: "Forbidden: account suspended" } as const;

// ── Lookup ──────────────────────────────────────────────────────────────────

/**
 * Whether an Authorization header uses the Bearer scheme (any case). Only
 * those take the key path; a malformed one is then refused, never handed to
 * the session.
 */
export function isBearerScheme(header: string | undefined): boolean {
  return header !== undefined && /^Bearer(?:\s|$)/i.test(header);
}

/** The token of `Authorization: Bearer <token>`, or null for any other shape. */
export function bearerToken(header: string | undefined): string | null {
  if (header === undefined) return null;
  const match = /^Bearer +(\S+) *$/i.exec(header);
  return match ? match[1]! : null;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * The RL_API_KEY_FAIL_IP key for a client address: the full IPv4 address, or
 * the /64 of an IPv6 address, so rotating addresses inside one allocation does
 * not reset the count. Anything that is not plain IPv6 counts as itself.
 */
export function failureLimiterKey(ip: string): string {
  return `ip:${ipv6Slash64(ip) ?? ip}`;
}

function ipv6Slash64(ip: string): string | null {
  if (!ip.includes(":") || ip.includes(".")) return null;
  const halves = ip.split("::");
  if (halves.length > 2) return null;
  const compressed = halves.length === 2;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = compressed && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - tail.length;
  if (compressed ? missing < 1 : missing !== 0) return null;
  const groups = [...head, ...Array<string>(compressed ? missing : 0).fill("0"), ...tail];
  if (!groups.every((g) => /^[0-9a-f]{1,4}$/i.test(g))) return null;
  return `${groups
    .slice(0, 4)
    .map((g) => parseInt(g, 16).toString(16))
    .join(":")}::/64`;
}

/**
 * Resolution of `lastUsedAt`: a key used more often than this is written at
 * most this often. Upper-case NOW() on purpose: it also keeps the lookup out of
 * Hyperdrive's query cache (see the header comment); do not "clean it up".
 */
const LAST_USED_STALE = sql`NOW() - interval '5 minutes'`;

function lookupKey(db: Database, keyHash: string) {
  return db
    .select({
      id: apiKeys.id,
      name: apiKeys.name,
      keyType: apiKeys.keyType,
      keyPrefix: apiKeys.keyPrefix,
      createdAt: apiKeys.createdAt,
      organizationId: apiKeys.organizationId,
      organizationName: organizations.name,
      // Keys belong to the workspace; its owners answer for them. While any
      // owner is banned the workspace's keys refuse (the owner's co-owners can
      // remove the banned owner, an admin can lift the ban). Better Auth may
      // store several roles ("admin,owner"), hence the array match.
      ownerBanned: sql<boolean>`exists (select 1 from ${members} inner join ${users} on ${users.id} = ${members.userId} where ${members.organizationId} = ${apiKeys.organizationId} and ${users.banned} = true and 'owner' = any(string_to_array(replace(${members.role}, ' ', ''), ',')))`,
      // A banned user's keys refuse too. The key itself stays workspace-owned:
      // it keeps working after its creator leaves the workspace (revoke it
      // then), and a key whose creator was deleted (NULL) is not refused.
      creatorBanned: sql<boolean>`exists (select 1 from ${users} where ${users.id} = ${apiKeys.createdByUserId} and ${users.banned} = true)`,
      lastUsedStale: sql<boolean>`(${apiKeys.lastUsedAt} is null or ${apiKeys.lastUsedAt} < ${LAST_USED_STALE})`,
    })
    .from(apiKeys)
    .innerJoin(organizations, eq(organizations.id, apiKeys.organizationId))
    .where(eq(apiKeys.keyHash, keyHash))
    .limit(1)
    .then((rows) => rows[0]);
}

/** Record the key's use. Conditional, so concurrent requests write at most once. */
function touchLastUsed(db: Database, apiKeyId: string): Promise<void> {
  return db
    .update(apiKeys)
    .set({ lastUsedAt: new Date() })
    .where(and(eq(apiKeys.id, apiKeyId), or(isNull(apiKeys.lastUsedAt), lt(apiKeys.lastUsedAt, LAST_USED_STALE))))
    .then(() => {})
    .catch((err: unknown) => {
      console.error("api-key: lastUsedAt update failed", { apiKeyId, error: errorSummary(err) });
    });
}

function background(c: Context<AppEnv>, task: Promise<unknown>): void {
  try {
    c.executionCtx.waitUntil(task);
  } catch {
    // No ExecutionContext (some unit tests): the task still runs, unawaited.
  }
}

/**
 * An unknown or revoked key: hold its hash, count the failure against the
 * address. When the limiter refuses, this request gets 429 instead of 401; no
 * other request from that address is affected.
 */
async function refuseUnknownKey(c: Context<AppEnv>, ip: string, keyHash: string, now: number): Promise<Response> {
  hold(failedKeyHashes, keyHash, now);
  if (ip && !(await checkRateLimit(c.env.RL_API_KEY_FAIL_IP, failureLimiterKey(ip)))) {
    return rateLimitedResponse(c);
  }
  return c.json(INVALID_API_KEY, 401, BEARER_CHALLENGE);
}

async function authenticateApiKey(c: Context<AppEnv>, next: Next): Promise<Response | void> {
  const token = bearerToken(c.req.header("authorization"));
  if (token === null) return c.json(INVALID_API_KEY, 401, BEARER_CHALLENGE);
  if (token.startsWith(API_KEY_PREFIX_PUBLIC)) return c.json(PUBLIC_KEY_NOT_ALLOWED, 401, BEARER_CHALLENGE);
  if (!SECRET_KEY_RE.test(token)) return c.json(INVALID_API_KEY, 401, BEARER_CHALLENGE);

  const now = Date.now();
  // Empty IP (no Cloudflare edge): skip the failure limiter, as the other limiters do.
  const ip = c.req.header("cf-connecting-ip") ?? "";

  const keyHash = await sha256Hex(token);
  if (isHeld(failedKeyHashes, keyHash, now)) return refuseUnknownKey(c, ip, keyHash, now);

  const db = createDb(c.env);
  let row: Awaited<ReturnType<typeof lookupKey>>;
  try {
    row = await lookupKey(db, keyHash);
  } catch (err) {
    // Fail closed, like the session path's ban check.
    console.error("api-key: lookup failed", { error: errorSummary(err) });
    return c.json({ error: "Service unavailable" }, 503);
  }
  // A revoked key is a deleted row. keyType is checked too, so a public key
  // can never authenticate here even if its hash were presented.
  if (!row || row.keyType !== "secret") return refuseUnknownKey(c, ip, keyHash, now);

  // Before any refusal of a found key, so a refused key is still rate limited.
  const limited = await enforceRateLimit(c, c.env.RL_API_KEY, `key:${row.id}`);
  if (limited) return limited;

  if (row.ownerBanned === true) {
    console.warn("api-key: refused, an owner of the workspace is banned", {
      apiKeyId: row.id,
      orgId: row.organizationId,
    });
    return c.json(ACCOUNT_SUSPENDED, 403);
  }
  if (row.creatorBanned === true) {
    console.warn("api-key: refused, the key's creator is banned", {
      apiKeyId: row.id,
      orgId: row.organizationId,
    });
    return c.json(ACCOUNT_SUSPENDED, 403);
  }

  if (row.lastUsedStale === true) background(c, touchLastUsed(db, row.id));

  c.set("apiKey", {
    id: row.id,
    name: row.name,
    keyPrefix: row.keyPrefix,
    createdAt: row.createdAt,
    organizationId: row.organizationId,
    organizationName: row.organizationName,
  });
  await next();
}

/**
 * /v1/teams/*: a secret key when the Authorization header uses the Bearer
 * scheme, otherwise the session (sessionMiddleware), also when the header
 * carries another scheme such as HTTP Basic. Never both.
 */
export const sessionOrApiKeyMiddleware = createMiddleware<AppEnv>(async (c, next) => {
  if (isBearerScheme(c.req.header("authorization"))) return authenticateApiKey(c, next);
  return sessionMiddleware(c, next);
});

/** Routes only a secret key may call (GET /v1/me). Without a Bearer header: missing_api_key. */
export const apiKeyMiddleware = createMiddleware<AppEnv>(async (c, next) => {
  if (!isBearerScheme(c.req.header("authorization"))) {
    return c.json(MISSING_API_KEY, 401, { "WWW-Authenticate": "Bearer" });
  }
  return authenticateApiKey(c, next);
});
