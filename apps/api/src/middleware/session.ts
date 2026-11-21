import { createMiddleware } from "hono/factory";
import type { AppEnv } from "../bindings";
import { createAuth, isUserBanned } from "../auth";
import { createDb } from "../db";
import { errorSummary } from "../lib/log";

/**
 * Authenticates every /v1 route that needs a signed-in user (mounted on
 * /v1/teams/* and /v1/admin/* in index.ts, and the place to mount any future
 * authenticated route).
 *
 * The session may come from Better Auth's cookie cache (up to 5 minutes old),
 * so it cannot reflect a ban made after it was issued. The ban is therefore
 * re-read from the user row on every request: a banned user is refused here,
 * on every authenticated route, whatever middleware comes after.
 */
export const sessionMiddleware = createMiddleware<AppEnv>(async (c, next) => {
  const auth = createAuth(c.env);
  const session = await auth.api.getSession({ headers: c.req.raw.headers });

  if (!session) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  let banned: boolean;
  try {
    banned = await isUserBanned(createDb(c.env), session.user.id);
  } catch (err) {
    // Fail closed: an unverifiable account gets nothing.
    console.error("session: ban check failed", { userId: session.user.id, error: errorSummary(err) });
    return c.json({ error: "Service unavailable" }, 503);
  }
  if (banned) {
    return c.json({ error: "Forbidden: account suspended" }, 403);
  }

  c.set("user", session.user);
  c.set("session", session.session);
  await next();
});
