import { Hono } from "hono";
import type { AppEnv } from "../bindings";
import { createAuth } from "../auth";
import { enforceRateLimit } from "../lib/rate-limit";

const app = new Hono<AppEnv>();

// Hono catch-all is a single `*` (matches across segments); `**` is treated as
// a literal path segment and never matches — which 404'd every auth route.
app.on(["POST", "GET"], "/api/auth/*", async (c) => {
  // Per-IP rate limit, split by method (see wrangler.toml RL_AUTH_*).
  // POST is tight (sign-in/sign-up/credential endpoints — credential stuffing &
  // signup abuse): 10/min/IP. GET is loose (120/min/IP) because the dashboard
  // polls GET /api/auth/get-session (cookieCache 300s but still frequent) and
  // OAuth callbacks bounce through GET — we must NOT throttle those aggressively.
  // Skip the per-IP gate when the IP is empty — don't bucket header-less traffic
  // on a shared "" key. Prefix real IP keys with `ip:` for namespace clarity.
  const ip = c.req.header("cf-connecting-ip") ?? "";
  const limiter =
    c.req.method === "POST" ? c.env.RL_AUTH_POST_IP : c.env.RL_AUTH_GET_IP;
  const limited = ip
    ? await enforceRateLimit(c, limiter, `ip:${ip}`)
    : null;
  if (limited) return limited;

  // Emails Better Auth triggers (the welcome email) go out after the response.
  const auth = createAuth(c.env, { waitUntil: (promise) => backgroundOf(c)(promise) });
  return auth.handler(c.req.raw);
});

export default app;

/** The request's waitUntil; awaiting nothing when there is no execution context (some tests). */
function backgroundOf(c: { executionCtx: Pick<ExecutionContext, "waitUntil"> }): (promise: Promise<unknown>) => void {
  try {
    const ctx = c.executionCtx;
    return (promise) => ctx.waitUntil(promise);
  } catch {
    return (promise) => void promise;
  }
}
