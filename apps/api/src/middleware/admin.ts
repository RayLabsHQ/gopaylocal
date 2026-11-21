import { createMiddleware } from "hono/factory";
import { eq, sql } from "drizzle-orm";
import type { AppEnv } from "../bindings";
import { createDb } from "../db";
import { users } from "../db/schema";
import { errorSummary } from "../lib/log";

/**
 * Platform-admin gate for /v1/admin/*. Must run after sessionMiddleware.
 *
 * The session's `user.role` can be up to 5 minutes stale (Better Auth cookie
 * cache), so a demoted or banned admin would keep full admin access for that
 * window. The admin surface reads and changes every tenant's data, so the
 * role and ban flag are re-read from the user row on every request (admin
 * traffic is tiny). The session value is still checked first, so a
 * non-admin never causes a database read.
 */
export const adminMiddleware = createMiddleware<AppEnv>(async (c, next) => {
  const user = c.get("user");
  if (!user || user.role !== "admin") {
    return c.json({ error: "Forbidden" }, 403);
  }

  try {
    const [row] = await createDb(c.env)
      // NOW() is there on purpose; do not remove it. Hyperdrive's query cache
      // serves a read for up to ~75 s and is never invalidated by writes, but
      // it never caches a statement that calls NOW() (detected by text, upper
      // case as Cloudflare documents it). Without it a demoted admin would
      // keep admin access that long.
      .select({ role: users.role, banned: users.banned, uncached: sql`NOW()` })
      .from(users)
      .where(eq(users.id, user.id))
      .limit(1);
    if (!row || row.role !== "admin" || row.banned === true) {
      return c.json({ error: "Forbidden" }, 403);
    }
  } catch (err) {
    console.error("admin: role check failed", { userId: user.id, error: errorSummary(err) });
    return c.json({ error: "Forbidden" }, 403);
  }

  await next();
});
