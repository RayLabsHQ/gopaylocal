import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type { AppEnv, Bindings } from "../bindings";
import { createMockKV, createTestBindings } from "../test/helpers";
import { bannerDocForCampaign } from "../services/banner-doc-test-helpers";
import {
  corsClassFor,
  corsMiddleware,
  credentialedOrigins,
  isLocalDev,
} from "./cors";

// index.ts -> routes/banner-script.ts imports the pre-built browser bundle as a
// wrangler text module; stub it so the browser code never runs under Node.
vi.mock("../../../../packages/banner/dist/banner.js", () => ({ default: "/*bundle*/" }));

// The banner config requests are metered (services/usage-meter.ts); stub the
// api_usage_daily write so no database connection is attempted.
vi.mock("../services/usage-meter", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/usage-meter")>()),
  writeUsageRows: vi.fn(async () => {}),
}));

// No database on this machine: every request below stays on KV or never reaches
// a handler that queries Postgres.

const API = "https://api.gopaylocal.com";
const MERCHANT = "https://merchant-example.com";
const DASHBOARD = "https://app.gopaylocal.com";

/** The hosted production [vars] that matter here (apps/api/wrangler.toml). */
const HOSTED_VARS: Partial<Bindings> = {
  API_BASE_URL: "https://api.gopaylocal.com",
  APP_BASE_URL: "https://app.gopaylocal.com",
  ADMIN_BASE_URL: "https://admin.gopaylocal.com",
  SELF_HOSTED: "false",
};

/** Exactly the CORS-related response headers, so extra/missing ones fail. */
function corsHeaders(res: Response): Record<string, string> {
  const out: Record<string, string> = {};
  res.headers.forEach((value, key) => {
    if (key.startsWith("access-control-") || key === "vary") out[key] = value;
  });
  return out;
}

// ── Minimal app: the real middleware, mounted exactly like index.ts ─────────

function minimalApp() {
  const app = new Hono<AppEnv>();
  app.use("*", corsMiddleware);
  app.get("/v1/banner/script.js", (c) =>
    c.text("/*loader*/", 200, {
      "Content-Type": "application/javascript",
      "Cache-Control": "public, max-age=3600",
    }),
  );
  app.get("/v1/banner/bundle.js", (c) =>
    c.text("/*bundle*/", 200, {
      "Content-Type": "application/javascript",
      "Cache-Control": "public, max-age=86400",
    }),
  );
  app.get("/v1/banner/config/:publicKey", (c) => c.json({ show: false }));
  app.post("/v1/events", (c) => c.body(null, 204));
  app.get("/v1/teams/:orgId/products", (c) => c.json([]));
  app.post("/v1/teams/:orgId/products", (c) => c.json({}, 201));
  app.on(["GET", "POST"], "/api/auth/*", (c) => c.json({}));
  return app;
}

function send(
  path: string,
  init: RequestInit & { origin?: string } = {},
  env: Partial<Bindings> = HOSTED_VARS,
  base = API,
) {
  const { origin, ...rest } = init;
  const headers = new Headers(rest.headers);
  if (origin) headers.set("Origin", origin);
  return minimalApp().request(`${base}${path}`, { ...rest, headers }, env);
}

function preflight(
  path: string,
  origin: string,
  method: string,
  requestHeaders?: string,
  env: Partial<Bindings> = HOSTED_VARS,
  base = API,
) {
  const headers: Record<string, string> = { "Access-Control-Request-Method": method };
  if (requestHeaders) headers["Access-Control-Request-Headers"] = requestHeaders;
  return send(path, { method: "OPTIONS", origin, headers }, env, base);
}

describe("CORS: public banner/SDK endpoints work from any origin", () => {
  it("script.js / bundle.js: `*`, no credentials, no Vary, still publicly cacheable", async () => {
    for (const [path, cache] of [
      ["/v1/banner/script.js?key=gpl_pk_x", "public, max-age=3600"],
      ["/v1/banner/bundle.js", "public, max-age=86400"],
    ] as const) {
      const res = await send(path, { origin: MERCHANT });
      expect(res.status).toBe(200);
      expect(corsHeaders(res)).toEqual({ "access-control-allow-origin": "*" });
      expect(res.headers.get("cache-control")).toBe(cache);
    }
  });

  it("GET config, as the banner and both SDKs send it (Accept only, no credentials)", async () => {
    const res = await send("/v1/banner/config/gpl_pk_x", {
      origin: MERCHANT,
      headers: { Accept: "application/json" },
    });
    expect(res.status).toBe(200);
    // `*` is valid because the request is not credentialed; Vary: Origin because
    // the body depends on the origin (per-campaign allowedDomains).
    expect(corsHeaders(res)).toEqual({
      "access-control-allow-origin": "*",
      vary: "Origin",
    });
  });

  it("preflight for config (only a non-standard client would send one)", async () => {
    const res = await preflight("/v1/banner/config/gpl_pk_x", MERCHANT, "GET", "content-type");
    expect(res.status).toBe(204);
    expect(corsHeaders(res)).toEqual({
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET,HEAD,OPTIONS",
      "access-control-allow-headers": "Content-Type",
      "access-control-max-age": "86400",
      vary: "Access-Control-Request-Headers",
    });
  });

  it("preflight for POST /v1/events (legacy banner's application/json beacon): reflected origin + credentials", async () => {
    const res = await preflight("/v1/events", MERCHANT, "POST", "content-type");
    expect(res.status).toBe(204);
    expect(corsHeaders(res)).toEqual({
      "access-control-allow-origin": MERCHANT,
      "access-control-allow-credentials": "true",
      "access-control-allow-methods": "POST,OPTIONS",
      "access-control-allow-headers": "Content-Type",
      "access-control-max-age": "86400",
      vary: "Origin, Access-Control-Request-Headers",
    });
  });

  const eventBody = JSON.stringify({ key: "gpl_pk_x", event: "impression", url: `${MERCHANT}/` });
  const credentialedEventHeaders = {
    "access-control-allow-origin": MERCHANT,
    "access-control-allow-credentials": "true",
    vary: "Origin",
  };

  it("POST /v1/events as the current banner beacon sends it (text/plain string, no-cors)", async () => {
    const res = await send("/v1/events", {
      method: "POST",
      origin: MERCHANT,
      headers: { "Content-Type": "text/plain;charset=UTF-8" },
      body: eventBody,
    });
    expect(res.status).toBe(204);
    expect(corsHeaders(res)).toEqual(credentialedEventHeaders);
  });

  it("POST /v1/events as the legacy banner beacon sends it (application/json Blob, credentials include)", async () => {
    const res = await send("/v1/events", {
      method: "POST",
      origin: MERCHANT,
      headers: { "Content-Type": "application/json", Cookie: "irrelevant=1" },
      body: eventBody,
    });
    expect(res.status).toBe(204);
    expect(corsHeaders(res)).toEqual(credentialedEventHeaders);
  });

  it("POST /v1/events from an opaque origin (sandboxed iframe): `*`, never a reflected \"null\"", async () => {
    const res = await send("/v1/events", { method: "POST", origin: "null", body: eventBody });
    expect(corsHeaders(res)).toEqual({
      "access-control-allow-origin": "*",
      "access-control-allow-credentials": "true",
      vary: "Origin",
    });
  });

  it("public endpoints carry the same policy on a self-hosted deployment", async () => {
    const env = { SELF_HOSTED: "true", APP_BASE_URL: "https://pay.example.org" };
    const base = "https://ppp-api.example.org";
    const cfg = await send("/v1/banner/config/gpl_pk_x", { origin: MERCHANT }, env, base);
    expect(corsHeaders(cfg)).toEqual({ "access-control-allow-origin": "*", vary: "Origin" });
    const ev = await preflight("/v1/events", MERCHANT, "POST", "content-type", env, base);
    expect(ev.headers.get("access-control-allow-origin")).toBe(MERCHANT);
    expect(ev.headers.get("access-control-allow-credentials")).toBe("true");
  });
});

describe("CORS: management / auth endpoints stay on the credentialed allowlist", () => {
  it("arbitrary origin: no Access-Control-Allow-Origin on GET, POST or preflight", async () => {
    const get = await send("/v1/teams/org_1/products", { origin: MERCHANT });
    expect(get.headers.get("access-control-allow-origin")).toBeNull();
    // ACAC without ACAO is inert; same as before this change (Hono always emits it).
    expect(corsHeaders(get)).toEqual({
      "access-control-allow-credentials": "true",
      vary: "Origin",
    });

    const pre = await preflight("/v1/teams/org_1/products", MERCHANT, "POST", "content-type");
    expect(pre.status).toBe(204);
    expect(pre.headers.get("access-control-allow-origin")).toBeNull();

    const auth = await preflight("/api/auth/get-session", MERCHANT, "GET", "content-type");
    expect(auth.headers.get("access-control-allow-origin")).toBeNull();
  });

  // Secret API keys are for servers. A page on another origin that tries to
  // send one (Authorization header => preflight) is refused by the browser,
  // because the management routes never allow a foreign origin.
  it("a foreign origin's preflight with an Authorization header is refused (secret keys stay server-side)", async () => {
    for (const [path, method] of [
      ["/v1/teams/org_1/products", "POST"],
      ["/v1/teams/org_1/products", "GET"],
      ["/v1/me", "GET"],
    ] as const) {
      const pre = await preflight(path, MERCHANT, method, "authorization");
      // Without Access-Control-Allow-Origin the browser fails the preflight and
      // never sends the request (Hono still lists the allowed headers; inert).
      expect({ path, method, acao: pre.headers.get("access-control-allow-origin") }).toEqual({ path, method, acao: null });
    }
    expect(corsClassFor("/v1/me")).toBe("app");
  });

  it("configured dashboard origin: allowed with credentials (GET and preflight)", async () => {
    const get = await send("/v1/teams/org_1/products", { origin: DASHBOARD });
    expect(corsHeaders(get)).toEqual({
      "access-control-allow-origin": DASHBOARD,
      "access-control-allow-credentials": "true",
      vary: "Origin",
    });

    const pre = await preflight("/v1/teams/org_1/products", DASHBOARD, "POST", "content-type");
    expect(pre.status).toBe(204);
    expect(corsHeaders(pre)).toEqual({
      "access-control-allow-origin": DASHBOARD,
      "access-control-allow-credentials": "true",
      "access-control-allow-methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
      "access-control-allow-headers": "Content-Type,Authorization,X-Requested-With",
      "access-control-max-age": "86400",
      vary: "Origin, Access-Control-Request-Headers",
    });
  });

  it("hosted production keeps exactly app, admin and the marketing site", async () => {
    for (const origin of [DASHBOARD, "https://admin.gopaylocal.com", "https://gopaylocal.com"]) {
      const res = await send("/v1/teams/org_1/products", { origin });
      expect(res.headers.get("access-control-allow-origin")).toBe(origin);
    }
    // Not allowed in production: look-alikes, other schemes, and the localhost
    // dev servers (a deployed Worker is never on a loopback host).
    for (const origin of [
      "https://evil-app.gopaylocal.com",
      "http://app.gopaylocal.com",
      "https://app.gopaylocal.com.evil.test",
      "http://localhost:3000",
      "null",
    ]) {
      const res = await send("/v1/teams/org_1/products", { origin });
      expect(res.headers.get("access-control-allow-origin")).toBeNull();
    }
    expect([...credentialedOrigins(HOSTED_VARS, `${API}/v1/teams/x`)].sort()).toEqual([
      "https://admin.gopaylocal.com",
      "https://app.gopaylocal.com",
      "https://gopaylocal.com",
    ]);
  });

  it("local development (wrangler dev on a loopback host) allows the localhost dev servers", async () => {
    const env = { ...HOSTED_VARS }; // API_BASE_URL left at the wrangler.toml value
    for (const base of ["http://localhost:8787", "http://127.0.0.1:8787"]) {
      const res = await send("/v1/teams/org_1/products", { origin: "http://localhost:3000" }, env, base);
      expect(res.headers.get("access-control-allow-origin")).toBe("http://localhost:3000");
    }
    expect(isLocalDev({ API_BASE_URL: "http://localhost:8787" }, `${API}/x`)).toBe(true);
    expect(isLocalDev(HOSTED_VARS, `${API}/x`)).toBe(false);
  });

  it("self-hosted: allowlist comes only from APP_BASE_URL, ADMIN_BASE_URL and CORS_ALLOWED_ORIGINS", async () => {
    const env: Partial<Bindings> = {
      SELF_HOSTED: "true",
      API_BASE_URL: "https://ppp-api.example.org",
      APP_BASE_URL: "https://pay.example.org/", // trailing slash / path is normalized away
      ADMIN_BASE_URL: "https://ops.example.org/admin",
      CORS_ALLOWED_ORIGINS: " https://www.example.org, https://staging.example.org:8443 ,,not a url",
    };
    const base = "https://ppp-api.example.org";
    for (const origin of [
      "https://pay.example.org",
      "https://ops.example.org",
      "https://www.example.org",
      "https://staging.example.org:8443",
    ]) {
      const res = await send("/v1/teams/org_1/products", { origin }, env, base);
      expect(corsHeaders(res)).toEqual({
        "access-control-allow-origin": origin,
        "access-control-allow-credentials": "true",
        vary: "Origin",
      });
    }
    // The hosted gopaylocal.com origins and localhost are NOT trusted here.
    for (const origin of [
      DASHBOARD,
      "https://admin.gopaylocal.com",
      "https://gopaylocal.com",
      "http://localhost:3000",
      "https://staging.example.org", // wrong port
    ]) {
      const res = await send("/v1/teams/org_1/products", { origin }, env, base);
      expect(res.headers.get("access-control-allow-origin")).toBeNull();
    }
  });

  it("self-hosted with nothing configured trusts no origin at all", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(credentialedOrigins({ SELF_HOSTED: "true" }, "https://api.example.org/").size).toBe(0);
    warn.mockRestore();
  });
});

describe("CORS: requests without an Origin header (same-origin, curl, servers)", () => {
  it("management: no CORS grant; public: unchanged static policy", async () => {
    const mgmt = await send("/v1/teams/org_1/products");
    expect(mgmt.headers.get("access-control-allow-origin")).toBeNull();

    const cfg = await send("/v1/banner/config/gpl_pk_x");
    expect(corsHeaders(cfg)).toEqual({ "access-control-allow-origin": "*", vary: "Origin" });

    const ev = await send("/v1/events", { method: "POST", body: "{}" });
    expect(ev.headers.get("access-control-allow-origin")).toBe("*");

    const js = await send("/v1/banner/bundle.js");
    expect(corsHeaders(js)).toEqual({ "access-control-allow-origin": "*" });
  });
});

describe("corsClassFor", () => {
  it("only the exact public paths are public", () => {
    expect(corsClassFor("/v1/banner/script.js")).toBe("public-asset");
    expect(corsClassFor("/v1/banner/bundle.js")).toBe("public-asset");
    expect(corsClassFor("/v1/banner/config/gpl_pk_x")).toBe("public-read");
    expect(corsClassFor("/v1/events")).toBe("public-write");
    for (const p of [
      "/v1/events/",
      "/v1/eventsx",
      "/v1/banner/config",
      "/v1/banner/script.jsx",
      "/v1/teams/org_1/banner-configs/camp_1",
      "/api/auth/get-session",
      "/v1/admin/stats",
      "/v1/webhooks/dodo",
      "/health",
    ]) {
      expect(corsClassFor(p)).toBe("app");
    }
  });
});

// ── End to end through the real Worker (index.ts), KV only ──────────────────

describe("CORS through the real worker (index.ts)", () => {
  const PUBLIC_KEY = "gpl_pk_test_cors";
  const ORG_ID = "org_cors";
  const API_KEY_ID = "key_cors";
  let worker: { fetch: (req: Request, env: Bindings, ctx: ExecutionContext) => Promise<Response> };
  const silenced: Array<ReturnType<typeof vi.spyOn>> = [];

  beforeAll(async () => {
    // index.ts logs once per isolate that the rate-limit bindings are absent.
    silenced.push(vi.spyOn(console, "warn").mockImplementation(() => {}));
    silenced.push(vi.spyOn(console, "error").mockImplementation(() => {}));
    worker = (await import("../index")).default as unknown as typeof worker;
  });
  afterAll(() => silenced.forEach((s) => s.mockRestore()));

  async function sha256Hex(value: string): Promise<string> {
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
    return Array.from(new Uint8Array(buf))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }

  async function seededEnv(
    allowedDomains: string[] | null = null,
    overrides: Partial<Bindings> = {},
  ): Promise<Bindings> {
    const cache = createMockKV();
    await cache.put(
      `apikey:${await sha256Hex(PUBLIC_KEY)}`,
      JSON.stringify({ apiKeyId: API_KEY_ID, organizationId: ORG_ID }),
    );
    await cache.put(
      `banner-config:${API_KEY_ID}`,
      JSON.stringify(bannerDocForCampaign({ organizationId: ORG_ID, allowedDomains, showBranding: false })),
    );
    return createTestBindings({ ...HOSTED_VARS, CACHE: cache, ...overrides });
  }

  const ctx = {
    waitUntil: (p: Promise<unknown>) => void p.catch(() => {}),
    passThroughOnException: () => {},
    props: {},
  } as unknown as ExecutionContext;

  function bannerConfigRequest(origin?: string) {
    const headers: Record<string, string> = {
      Accept: "application/json",
      "cf-connecting-ip": "203.0.113.7",
    };
    if (origin) headers.Origin = origin;
    const req = new Request(`${API}/v1/banner/config/${PUBLIC_KEY}`, { headers });
    Object.defineProperty(req, "cf", { value: { country: "IN", asOrganization: "Example ISP" } });
    return req;
  }

  it("GET config from a merchant origin: readable (`*`) and shows the banner", async () => {
    const res = await worker.fetch(bannerConfigRequest(MERCHANT), await seededEnv(), ctx);
    expect(res.status).toBe(200);
    expect(corsHeaders(res)).toEqual({ "access-control-allow-origin": "*", vary: "Origin" });
    expect(((await res.json()) as { show: boolean }).show).toBe(true);
  });

  it("allowedDomains still decides the content: readable everywhere, banner only on allowed sites", async () => {
    const env = await seededEnv(["merchant-example.com"]);
    const allowed = await worker.fetch(bannerConfigRequest("https://shop.merchant-example.com"), env, ctx);
    expect(((await allowed.json()) as { show: boolean }).show).toBe(true);

    const other = await worker.fetch(bannerConfigRequest("https://copycat.test"), env, ctx);
    expect(other.headers.get("access-control-allow-origin")).toBe("*");
    expect(other.headers.get("vary")).toBe("Origin");
    expect(await other.json()).toEqual({ show: false, reason: "domain_not_allowed" });
  });

  it("script.js and bundle.js keep Cache-Control: public and gain `*` without Vary", async () => {
    const env = await seededEnv();
    const loader = await worker.fetch(
      new Request(`${API}/v1/banner/script.js?key=${PUBLIC_KEY}`, { headers: { Origin: MERCHANT } }),
      env,
      ctx,
    );
    expect(loader.status).toBe(200);
    expect(loader.headers.get("cache-control")).toBe("public, max-age=3600");
    expect(corsHeaders(loader)).toEqual({ "access-control-allow-origin": "*" });

    const bundle = await worker.fetch(new Request(`${API}/v1/banner/bundle.js`), env, ctx);
    expect(bundle.headers.get("cache-control")).toBe("public, max-age=86400");
    expect(corsHeaders(bundle)).toEqual({ "access-control-allow-origin": "*" });
  });

  // Malformed campaign id => dropped before any DB access (campaign-validation.ts),
  // so a 204 here proves the body was parsed and the key validated via KV.
  const event = JSON.stringify({
    key: PUBLIC_KEY,
    event: "impression",
    url: `${MERCHANT}/pricing`,
    campaignId: "not-a-ulid",
    countryCode: "IN",
  });

  it("POST /v1/events with a text/plain body (current banner) is parsed and accepted", async () => {
    const res = await worker.fetch(
      new Request(`${API}/v1/events`, {
        method: "POST",
        headers: { Origin: MERCHANT, "Content-Type": "text/plain;charset=UTF-8" },
        body: event,
      }),
      await seededEnv(),
      ctx,
    );
    expect(res.status).toBe(204);
    expect(corsHeaders(res)).toEqual({
      "access-control-allow-origin": MERCHANT,
      "access-control-allow-credentials": "true",
      vary: "Origin",
    });
  });

  it("POST /v1/events with application/json (legacy banner, curl) still works", async () => {
    const res = await worker.fetch(
      new Request(`${API}/v1/events`, {
        method: "POST",
        headers: { Origin: MERCHANT, "Content-Type": "application/json" },
        body: event,
      }),
      await seededEnv(),
      ctx,
    );
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe(MERCHANT);
  });

  it("a rate-limited event is still readable cross-origin (429 carries CORS headers)", async () => {
    const env = await seededEnv(null, {
      RL_EVENTS_IP: { limit: async () => ({ success: false }) } as unknown as RateLimit,
    });
    const res = await worker.fetch(
      new Request(`${API}/v1/events`, {
        method: "POST",
        headers: { Origin: MERCHANT, "cf-connecting-ip": "203.0.113.9" },
        body: event,
      }),
      env,
      ctx,
    );
    expect(res.status).toBe(429);
    expect(res.headers.get("access-control-allow-origin")).toBe(MERCHANT);
  });

  it("management preflight: refused for a merchant origin, granted for the dashboard", async () => {
    const env = await seededEnv();
    const pre = await worker.fetch(
      new Request(`${API}/v1/teams/org_1/products`, {
        method: "OPTIONS",
        headers: {
          Origin: MERCHANT,
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Headers": "content-type",
        },
      }),
      env,
      ctx,
    );
    expect(pre.status).toBe(204);
    expect(pre.headers.get("access-control-allow-origin")).toBeNull();

    const pre2 = await worker.fetch(
      new Request(`${API}/v1/teams/org_1/products`, {
        method: "OPTIONS",
        headers: { Origin: DASHBOARD, "Access-Control-Request-Method": "POST" },
      }),
      env,
      ctx,
    );
    expect(pre2.headers.get("access-control-allow-origin")).toBe(DASHBOARD);
    expect(pre2.headers.get("access-control-allow-credentials")).toBe("true");
  });
});
