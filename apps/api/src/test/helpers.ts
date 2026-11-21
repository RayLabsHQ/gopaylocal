import { Hono } from "hono";
import type { AppEnv, Bindings } from "../bindings";
import { DEFAULT_TEST_DATABASE_URL, testDatabaseUrl } from "./setup";

/**
 * Create mock KV namespace for tests.
 */
export function createMockKV(): KVNamespace {
  const store = new Map<string, { value: string; expiration?: number }>();
  return {
    // Like Workers KV: get(key, "json") and get(key, { type: "json" }) return the
    // parsed value (and throw on invalid JSON); other types return what was put.
    get: async (key: string, typeOrOptions?: string | { type?: string }) => {
      const entry = store.get(key);
      if (!entry) return null;
      if (entry.expiration && Date.now() / 1000 > entry.expiration) {
        store.delete(key);
        return null;
      }
      const type = typeof typeOrOptions === "string" ? typeOrOptions : typeOrOptions?.type;
      return type === "json" ? JSON.parse(entry.value) : entry.value;
    },
    put: async (key: string, value: string, opts?: { expirationTtl?: number }) => {
      store.set(key, {
        value,
        expiration: opts?.expirationTtl
          ? Date.now() / 1000 + opts.expirationTtl
          : undefined,
      });
    },
    delete: async (key: string) => {
      store.delete(key);
    },
    list: async () => ({ keys: [...store.keys()].map((k) => ({ name: k })), list_complete: true, cacheStatus: null }),
    getWithMetadata: async () => ({ value: null, metadata: null, cacheStatus: null }),
  } as unknown as KVNamespace;
}

/**
 * Seconds before an idle Postgres connection is closed. Route handlers call
 * createDb() per request, which in Workers is cheap (Hyperdrive pools for us)
 * but under Node opens a fresh postgres-js client per request whose sockets
 * would otherwise stay open until the process exits and exhaust Postgres'
 * max_connections in a long test file. Closing idle sockets quickly emulates
 * the pooling Hyperdrive gives the deployed Worker. postgres-js reads this
 * from the connection string's query (an "int" option, fractions allowed).
 */
const IDLE_TIMEOUT_SECONDS = "0.2";

/**
 * Mock Hyperdrive binding pointing at the local test database.
 *
 * Unit tests (no database) also build this binding, so an unsafe DATABASE_URL
 * (non-loopback or a database without "test" in its name) falls back to the
 * default local test URL here instead of throwing. The integration tests still
 * fail fast on it: their direct handle (getTestDb) and the integration setup
 * file use the strict testDatabaseUrl().
 */
export function createMockHyperdrive(): Hyperdrive {
  let base: string;
  try {
    base = testDatabaseUrl();
  } catch {
    base = DEFAULT_TEST_DATABASE_URL;
  }
  const url = new URL(base);
  url.searchParams.set("idle_timeout", IDLE_TIMEOUT_SECONDS);
  return {
    connectionString: url.toString(),
    host: url.hostname,
    port: Number(url.port || 5432),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: decodeURIComponent(url.pathname.replace(/^\//, "")),
  } as unknown as Hyperdrive;
}

/**
 * Create a complete mock bindings object for testing.
 */
export function createTestBindings(overrides?: Partial<Bindings>): Bindings {
  return {
    HYPERDRIVE: createMockHyperdrive(),
    CACHE: createMockKV(),
    VPN_DATA: createMockKV(),
    BETTER_AUTH_SECRET: "test-secret-at-least-32-characters-long",
    GOOGLE_CLIENT_ID: "test-google-client-id",
    GOOGLE_CLIENT_SECRET: "test-google-client-secret",
    GITHUB_CLIENT_ID: "test-github-client-id",
    GITHUB_CLIENT_SECRET: "test-github-client-secret",
    DODO_API_KEY: "test-dodo-api-key",
    DODO_WEBHOOK_SECRET: "test-dodo-webhook-secret",
    ...overrides,
  };
}

// ── Execution context ───────────────────────────────────────────────────────

export interface TestExecutionContext extends ExecutionContext {
  /**
   * Wait for every promise handed to waitUntil(), including ones scheduled
   * while waiting. Rejects with an AggregateError if any of them rejected, so
   * background work is asserted instead of silently dropped.
   */
  settle(): Promise<void>;
}

/**
 * A Workers ExecutionContext for tests. Routes call c.executionCtx.waitUntil()
 * for background work (KV cache pushes, coupon generation, analytics writes);
 * without a context Hono throws "This context has no ExecutionContext".
 */
export function createExecutionContext(): TestExecutionContext {
  const pending: Promise<unknown>[] = [];
  const ctx = {
    waitUntil(promise: Promise<unknown>) {
      pending.push(Promise.resolve(promise));
    },
    passThroughOnException() {},
    props: {},
    async settle() {
      const errors: unknown[] = [];
      while (pending.length > 0) {
        const batch = pending.splice(0);
        for (const result of await Promise.allSettled(batch)) {
          if (result.status === "rejected") errors.push(result.reason);
        }
      }
      if (errors.length > 0) {
        throw new AggregateError(errors, "A waitUntil() promise rejected");
      }
    },
  };
  // Cast: only waitUntil/passThroughOnException are used by Hono; newer
  // workers-types may add members that a test context does not need.
  return ctx as unknown as TestExecutionContext;
}

// ── Request client ──────────────────────────────────────────────────────────

/** Anything with a Workers-style fetch: a Hono app or the Worker's default export. */
export interface Fetchable {
  fetch(request: Request, env: Bindings, ctx: ExecutionContext): Response | Promise<Response>;
}

export interface TestRequestInit extends RequestInit {
  /**
   * The request's `cf` object as Cloudflare's edge sets it (country, asn,
   * asOrganization, ...). Omit to simulate a request without `cf` (local or
   * non-Cloudflare). Headers such as cf-ipcountry are client-controlled and
   * are NOT a substitute.
   */
  cf?: Record<string, unknown>;
  /** JSON request body; sets content-type: application/json. */
  json?: unknown;
}

/**
 * The app's real Response, typed for tests: workers-types declares
 * `json<T>(): Promise<T>`, which is `unknown` without a type argument, and the
 * tests read bodies untyped. Type-only; nothing parses or validates the body.
 */
export type TestResponse = Omit<Response, "json"> & { json<T = any>(): Promise<T> };

export interface TestClient {
  env: Bindings;
  /**
   * Send a request through the app with a fresh ExecutionContext and wait for
   * all of its waitUntil() work before resolving, so assertions made after
   * `await client.request(...)` see the background writes.
   */
  request(path: string, init?: TestRequestInit): Promise<TestResponse>;
}

export function createTestClient(app: Fetchable, env: Bindings = createTestBindings()): TestClient {
  return {
    env,
    async request(path, init = {}) {
      const { cf, json, ...rest } = init;
      const headers = new Headers(rest.headers);
      let body = rest.body;
      if (json !== undefined) {
        headers.set("content-type", "application/json");
        body = JSON.stringify(json);
      }
      const request = new Request(new URL(path, "http://localhost"), { ...rest, headers, body });
      if (cf) Object.defineProperty(request, "cf", { value: cf, enumerable: true });
      const ctx = createExecutionContext();
      const response = await app.fetch(request, env, ctx);
      await ctx.settle();
      return response;
    },
  };
}

// ── Route-level apps with an injected identity ──────────────────────────────

export interface InjectedMember {
  userId: string;
  role: "owner" | "admin" | "member";
}

/**
 * Mount route modules behind a middleware that injects an authenticated user
 * and a team role, bypassing session and team middleware. Use it to test a
 * route's own logic; use the Worker's default export (src/index.ts) with a real
 * session (see test/auth.ts) to test authentication and tenant isolation.
 */
export function mountRoutes(
  routes: Hono<AppEnv> | Hono<AppEnv>[],
  member: InjectedMember = { userId: "test-user-id", role: "owner" },
): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("user", { id: member.userId, name: "Test User", email: "test@example.com", role: "user" });
    c.set("session", { id: "test-session-id" });
    c.set("memberRole", member.role);
    await next();
  });
  for (const route of Array.isArray(routes) ? routes : [routes]) app.route("/", route);
  return app;
}
