import type { Context } from "hono";
import type { AppEnv, Bindings } from "../bindings";

/**
 * Thin wrapper around Cloudflare's native Workers Rate Limiting API binding
 * (https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/).
 *
 * Architecture decision (made with the founder): use the NATIVE binding, not KV
 * counters or Durable Objects. Accuracy is per-colo (each Cloudflare data center
 * keeps its own counter) — that's acceptable here; we only need to blunt abusive
 * floods, not enforce a globally exact quota.
 *
 * The binding's `limit({ key })` returns `{ success: boolean }`. Periods are
 * fixed by the wrangler config (only 10s or 60s windows are supported by the
 * platform), so the helper just consumes a token for the given key.
 *
 * FAIL-OPEN CONTRACT: if the binding is absent (local dev / unit tests, where
 * the binding is an OPTIONAL field and therefore undefined) or its `limit()`
 * call throws, we ALLOW the request. The product must NEVER break because the
 * limiter did — a rate limiter going sideways must not take down the banner hot
 * path or auth. Every failure mode below resolves to "allowed".
 */

/** A Cloudflare rate-limit binding may be undefined in local/test envs. */
type OptionalLimiter = RateLimit | undefined;

/**
 * Consume one token from `limiter` for `key`.
 *
 * @returns `true` if the request is allowed (under limit, OR the limiter is
 *          missing/threw — fail-open), `false` only when the limiter
 *          definitively reports the key is over its limit.
 */
export async function checkRateLimit(
  limiter: OptionalLimiter,
  key: string,
): Promise<boolean> {
  // No binding (local dev / tests without the binding configured): fail open.
  if (!limiter) return true;
  try {
    const { success } = await limiter.limit({ key });
    return success;
  } catch {
    // Binding threw (platform hiccup, mis-config): fail open. The product must
    // never break because the limiter did.
    return true;
  }
}

/**
 * The window length, in seconds, advertised in the Retry-After header. The
 * native binding does not return the window or a reset time, so we surface the
 * configured window. All our limiter namespaces use a 60s period, so a single
 * constant is honest; pass an override if a namespace uses the 10s window.
 */
const DEFAULT_RETRY_AFTER_SECONDS = 60;

/**
 * Build the standard 429 response: JSON `{ error: "rate_limited" }` plus a
 * `Retry-After` header (seconds). Callers `return` this directly from a route.
 */
export function rateLimitedResponse(
  c: Context<AppEnv>,
  retryAfterSeconds: number = DEFAULT_RETRY_AFTER_SECONDS,
) {
  return c.json({ error: "rate_limited" }, 429, {
    "Retry-After": String(retryAfterSeconds),
  });
}

/**
 * Convenience: consume a token and, if over limit, return the 429 response;
 * otherwise return `null` so the caller proceeds.
 *
 * Usage in a route:
 *   const limited = await enforceRateLimit(c, c.env.RL_BANNER_IP, ip);
 *   if (limited) return limited;
 */
export async function enforceRateLimit(
  c: Context<AppEnv>,
  limiter: OptionalLimiter,
  key: string,
  retryAfterSeconds: number = DEFAULT_RETRY_AFTER_SECONDS,
): Promise<Response | null> {
  const allowed = await checkRateLimit(limiter, key);
  if (allowed) return null;
  return rateLimitedResponse(c, retryAfterSeconds);
}

/** The rate-limit bindings that MUST be present in production. */
const REQUIRED_LIMITER_NAMES = [
  "RL_BANNER_IP",
  "RL_BANNER_MISS_IP",
  "RL_EVENTS_KEY",
  "RL_EVENTS_IP",
  "RL_AUTH_POST_IP",
  "RL_AUTH_GET_IP",
  "RL_API_KEY",
  "RL_API_KEY_FAIL_IP",
] as const;

/**
 * Observability backstop for the fail-OPEN contract. The limiter bindings are
 * optional and fail open by design, but that means a wrangler name typo or a
 * dropped `[[ratelimits]]` stanza makes a binding `undefined` in production and
 * its protection vanishes SILENTLY. This logs (does NOT throw — we keep failing
 * open) a `console.error` for any missing binding so the gap is visible in logs.
 *
 * Local/dev is expected to run without the bindings (they only exist in the
 * Cloudflare runtime), so we skip the check entirely for localhost origins to
 * avoid log noise. Intended to run ONCE per isolate (see the guard in index.ts).
 */
export function assertLimitersPresent(env: Bindings, origin: string): void {
  if (origin.includes("localhost") || origin.includes("127.0.0.1")) return;
  for (const name of REQUIRED_LIMITER_NAMES) {
    if (!env[name]) {
      console.error(
        `[ratelimit] binding ${name} is undefined on ${origin} — failing OPEN`,
      );
    }
  }
}
