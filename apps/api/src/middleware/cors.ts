import { cors } from "hono/cors";
import { createMiddleware } from "hono/factory";
import type { MiddlewareHandler } from "hono";
import type { AppEnv, Bindings } from "../bindings";
import { isSelfHosted } from "../lib/entitlements";

/**
 * CORS policy, one class per kind of caller.
 *
 * The banner script and the JS/React SDKs run in a visitor's browser on the
 * MERCHANT'S site, so the few endpoints they call must work from any origin.
 * Everything else (auth, dashboard/admin management) is credentialed and stays
 * on an allowlist derived from the environment.
 *
 *  class          paths                                  Access-Control-Allow-Origin            credentials
 *  public-asset   GET /v1/banner/script.js, bundle.js    `*` (no Vary: stays publicly cacheable)  no
 *  public-read    GET /v1/banner/config/:publicKey,      `*` + Vary: Origin                      no
 *                 GET /v1/pricing/pro
 *  public-write   POST /v1/events                        request origin reflected + Vary: Origin  yes
 *  app            everything else                        allowlisted origin only + Vary: Origin   yes
 *
 * Why public-write is credentialed: navigator.sendBeacon() always uses
 * credentials mode "include", and banner bundles shipped before this change send
 * a Blob typed `application/json` (not CORS-safelisted), which makes the beacon a
 * CORS request with a preflight. For credentialed requests the Fetch standard's
 * CORS check rejects `Access-Control-Allow-Origin: *` and requires
 * `Access-Control-Allow-Credentials: true` on both the preflight and the actual
 * response (https://fetch.spec.whatwg.org/#cors-check,
 * https://fetch.spec.whatwg.org/#cors-preflight-fetch). (Observed in Chrome 158:
 * OPTIONS preflight, then a `Sec-Fetch-Mode: cors` POST.) Current banner builds
 * send a text/plain string instead (CORS-safelisted, so no-cors and no
 * preflight), but cached copies of the old bundle and vendored copies keep
 * working.
 *
 * Why that is safe: none of the public routes reads cookies, the session or an
 * Authorization header (they are mounted before, and outside of, the session
 * middleware, and identify the merchant only by the public key in the URL or
 * body). A credentialed response therefore carries nothing a credential-less
 * request (or curl) could not already get. public-read deliberately stays
 * non-credentialed (`*`) so that if a public read route ever starts depending
 * on the session, browsers still refuse to hand that response to other sites.
 *
 * Classification uses c.req.path, the same path the router matches on, with
 * exact paths (plus the /v1/banner/config/ prefix, under which only the public
 * config route lives). Management routes live under /v1/teams and /v1/admin and
 * auth under /api/auth, so they can never fall into a public class.
 */

// ── Public endpoints ────────────────────────────────────────────────────────

export type CorsClass = "public-asset" | "public-read" | "public-write" | "app";

export function corsClassFor(path: string): CorsClass {
  if (path === "/v1/banner/script.js" || path === "/v1/banner/bundle.js") {
    return "public-asset";
  }
  if (path.startsWith("/v1/banner/config/") || path === "/v1/pricing/pro") return "public-read";
  if (path === "/v1/events") return "public-write";
  return "app";
}

// Firefox caps preflight caching at 86400s and Chromium at 7200s
// (https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Access-Control-Max-Age).
const PREFLIGHT_MAX_AGE = 86400;

// Static scripts. Loaded with <script src> they need no CORS at all; `*` lets a
// merchant add crossorigin="anonymous" (SRI, error reporting) or fetch() them.
// The response never depends on the origin, so no Vary and it stays cacheable
// (https://fetch.spec.whatwg.org/#cors-protocol-and-http-caches).
const publicAssetCors = cors({
  origin: "*",
  allowMethods: ["GET", "HEAD", "OPTIONS"],
  allowHeaders: ["Content-Type"],
  maxAge: PREFLIGHT_MAX_AGE,
});

// Banner config. Every shipped client (banner, JS SDK, React SDK) sends a plain
// GET with only `Accept` (CORS-safelisted, default credentials "same-origin"),
// so `*` is accepted by the browser and no preflight happens.
const publicReadCorsBase = cors({
  origin: "*",
  allowMethods: ["GET", "HEAD", "OPTIONS"],
  allowHeaders: ["Content-Type"],
  maxAge: PREFLIGHT_MAX_AGE,
});
const publicReadCors = createMiddleware<AppEnv>(async (c, next) => {
  const res = await publicReadCorsBase(c, next);
  // The body DOES depend on the origin: the per-campaign allowedDomains check in
  // routes/banner-script.ts reads Origin/Referer. Tell caches so.
  if (c.req.method !== "OPTIONS") c.header("Vary", "Origin", { append: true });
  return res;
});

/** A well-formed http(s) serialized origin, as browsers send it; never "null". */
function isHttpOrigin(origin: string): boolean {
  if (!origin || origin === "null") return false;
  try {
    const url = new URL(origin);
    return (
      (url.protocol === "https:" || url.protocol === "http:") &&
      url.origin === origin
    );
  } catch {
    return false;
  }
}

// Events beacon. Reflect the caller's origin (any site may post events for a
// public key) so credentialed beacons pass the CORS check. Opaque/missing/odd
// origins get `*`: never reflect "null" (MDN: Access-Control-Allow-Origin
// "null" should not be used), and `*` still lets credential-less callers in.
const publicWriteCors = cors({
  origin: (origin) => (isHttpOrigin(origin) ? origin : "*"),
  allowMethods: ["POST", "OPTIONS"],
  // Explicit list: with credentials, `*` is not a wildcard for headers
  // (https://fetch.spec.whatwg.org/#cors-preflight-fetch).
  allowHeaders: ["Content-Type"],
  credentials: true,
  maxAge: PREFLIGHT_MAX_AGE,
});

// ── Credentialed allowlist (dashboard, admin, auth, management) ─────────────

// Hosted (gopaylocal.com) defaults, used only when the deployment is not
// self-hosted and the corresponding variable is unset. The hosted wrangler.toml
// sets APP_BASE_URL / ADMIN_BASE_URL explicitly; the marketing origin has no
// variable of its own (a self-hosted marketing site goes in CORS_ALLOWED_ORIGINS).
const HOSTED_APP_ORIGIN = "https://app.gopaylocal.com";
const HOSTED_ADMIN_ORIGIN = "https://admin.gopaylocal.com";
const HOSTED_MARKETING_ORIGIN = "https://gopaylocal.com";

// Vite dev servers: dashboard :3000, admin :3001, generic Vite :5173.
const LOCAL_DEV_ORIGINS = [
  "http://localhost:3000",
  "http://localhost:3001",
  "http://localhost:5173",
];

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

function isLoopbackUrl(value: string | undefined): boolean {
  if (!value) return false;
  try {
    return LOOPBACK_HOSTS.has(new URL(value).hostname);
  } catch {
    return false;
  }
}

/**
 * Local development = the API itself is served from a loopback host (wrangler
 * dev on :8787), detected from API_BASE_URL or the request URL. A deployed
 * Worker is only ever reached through its public hostname, so this is never
 * true in production.
 */
export function isLocalDev(env: Partial<Bindings>, requestUrl?: string): boolean {
  return isLoopbackUrl(env.API_BASE_URL) || isLoopbackUrl(requestUrl);
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

let warnedInvalidOrigin = false;

/** Normalize a configured URL/origin to its serialized origin, or null. */
function toOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url.origin;
  } catch {
    if (!warnedInvalidOrigin) {
      warnedInvalidOrigin = true;
      console.warn(`CORS: ignoring invalid origin in configuration: ${JSON.stringify(value)}`);
    }
    return null;
  }
}

/**
 * Origins allowed to make credentialed (cookie) requests to the API:
 * APP_BASE_URL, ADMIN_BASE_URL, the hosted marketing site (hosted only), every
 * entry of the comma-separated CORS_ALLOWED_ORIGINS, and the localhost dev
 * servers when running locally. Values may be full URLs; only the origin is
 * kept (scheme + host + port, exact match, no wildcards).
 *
 * Exported so the Better Auth trustedOrigins list can share one source of truth.
 */
export function credentialedOrigins(
  env: Partial<Bindings>,
  requestUrl?: string,
): Set<string> {
  const hosted = !isSelfHosted(env);
  const candidates: Array<string | undefined> = [
    nonEmpty(env.APP_BASE_URL) ?? (hosted ? HOSTED_APP_ORIGIN : undefined),
    nonEmpty(env.ADMIN_BASE_URL) ?? (hosted ? HOSTED_ADMIN_ORIGIN : undefined),
    hosted ? HOSTED_MARKETING_ORIGIN : undefined,
    ...(env.CORS_ALLOWED_ORIGINS ?? "").split(",").map(nonEmpty),
    ...(isLocalDev(env, requestUrl) ? LOCAL_DEV_ORIGINS : []),
  ];
  const origins = new Set<string>();
  for (const candidate of candidates) {
    if (!candidate) continue;
    const origin = toOrigin(candidate);
    if (origin) origins.add(origin);
  }
  return origins;
}

const appCors = cors({
  origin: (origin, c) =>
    origin && credentialedOrigins(c.env as Bindings, c.req.url).has(origin)
      ? origin
      : null,
  allowHeaders: ["Content-Type", "Authorization", "X-Requested-With"],
  allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  credentials: true,
  maxAge: PREFLIGHT_MAX_AGE,
});

// ── Dispatcher (mounted once: app.use("*", corsMiddleware)) ────────────────

const byClass: Record<CorsClass, MiddlewareHandler<AppEnv>> = {
  "public-asset": publicAssetCors,
  "public-read": publicReadCors,
  "public-write": publicWriteCors,
  app: appCors,
};

export const corsMiddleware = createMiddleware<AppEnv>((c, next) =>
  byClass[corsClassFor(c.req.path)](c, next),
);
