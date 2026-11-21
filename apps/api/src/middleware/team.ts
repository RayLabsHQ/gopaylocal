import { createMiddleware } from "hono/factory";
import { eq, and, sql } from "drizzle-orm";
import type { AppEnv } from "../bindings";
import { createDb } from "../db";
import { members, users } from "../db/schema";
import { errorSummary } from "../lib/log";
import { resolveRole } from "@gopaylocal/shared/permissions";

/**
 * Org membership verification middleware.
 *
 * Checks that the authenticated user is a member of the organization
 * specified by the `:orgId` route parameter. Returns 403 if not a member.
 * This is the ONLY place `:orgId` is authenticated: every /v1/teams/:orgId
 * route trusts the path parameter because this ran first (index.ts mounts it
 * on "/v1/teams/:orgId/*", which Hono also matches for "/v1/teams/:orgId").
 *
 * Also refuses a banned user (403). Better Auth here has no admin plugin, so
 * nothing else enforces `user.banned`: the session cookie (and its 5-minute
 * cookie cache) stays valid after an admin bans someone. Reading `banned`
 * from the user row in the same query makes a ban effective on every team
 * route on the next request, at no extra round trip.
 *
 * Must be applied AFTER sessionOrApiKeyMiddleware (requires `user` or `apiKey`
 * on context).
 *
 * On success, sets `memberRole` (owner | admin | member) on context; routes
 * authorize with requirePermission (middleware/permissions.ts).
 */
export const teamMiddleware = createMiddleware<AppEnv>(async (c, next) => {
  const orgId = c.req.param("orgId");
  if (!orgId) {
    return c.json({ error: "Organization ID required" }, 400);
  }

  // A secret key (middleware/api-key.ts) belongs to one workspace: anywhere
  // else it gets exactly the answer a member of another workspace gets.
  // It sets no memberRole; requirePermission reads the key's own column.
  const apiKey = c.get("apiKey");
  if (apiKey) {
    if (apiKey.organizationId !== orgId) {
      return c.json({ error: "Forbidden: not a member of this organization" }, 403);
    }
    await next();
    return;
  }

  const user = c.get("user");
  if (!user) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const db = createDb(c.env);

  try {
    const row = await db
      // NOW() is there on purpose; do not remove it. Hyperdrive's query cache
      // serves a read for up to ~75 s and is never invalidated by writes, but
      // it never caches a statement that calls NOW() (detected by text, upper
      // case as Cloudflare documents it). Without it a ban or a removed
      // membership would apply that late.
      .select({ role: members.role, banned: users.banned, uncached: sql`NOW()` })
      .from(members)
      .innerJoin(users, eq(users.id, members.userId))
      .where(and(eq(members.organizationId, orgId), eq(members.userId, user.id)))
      .limit(1)
      .then((rows) => rows[0]);

    if (!row) {
      return c.json({ error: "Forbidden: not a member of this organization" }, 403);
    }
    if (row.banned === true) {
      return c.json({ error: "Forbidden: account suspended" }, 403);
    }

    // Better Auth may store several roles ("admin,member"); the permission
    // table applies the highest known one. A role the table doesn't know gets
    // nothing, so stop here rather than let it reach any route.
    const role = resolveRole(row.role);
    if (!role) {
      console.error("team: membership has no known role", { orgId, userId: user.id, role: row.role });
      return c.json({ error: "Forbidden: unknown role" }, 403);
    }
    c.set("memberRole", role);
  } catch (err) {
    // Fail closed, but say why in the logs: without this a database outage
    // looks exactly like "not a member" to everyone.
    console.error("team: membership check failed", {
      orgId,
      userId: user.id,
      error: errorSummary(err),
    });
    return c.json({ error: "Forbidden: not a member of this organization" }, 403);
  }

  await next();
});
