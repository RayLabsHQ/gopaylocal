import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { Hono } from "hono";
import type { AppEnv, Bindings } from "../bindings";
import {
  assertLimitersPresent,
  checkRateLimit,
  enforceRateLimit,
  rateLimitedResponse,
} from "./rate-limit";

/** A limiter that always allows. */
const allowLimiter: RateLimit = {
  limit: async () => ({ success: true }),
};

/** A limiter that always blocks. */
const blockLimiter: RateLimit = {
  limit: async () => ({ success: false }),
};

/** A limiter whose limit() throws. */
const throwLimiter: RateLimit = {
  limit: async () => {
    throw new Error("binding blew up");
  },
};

describe("checkRateLimit", () => {
  it("allows when the limiter reports success", async () => {
    expect(await checkRateLimit(allowLimiter, "k")).toBe(true);
  });

  it("blocks when the limiter reports failure", async () => {
    expect(await checkRateLimit(blockLimiter, "k")).toBe(false);
  });

  it("FAILS OPEN (allows) when the binding is undefined (local/test)", async () => {
    expect(await checkRateLimit(undefined, "k")).toBe(true);
  });

  it("FAILS OPEN (allows) when the binding throws", async () => {
    expect(await checkRateLimit(throwLimiter, "k")).toBe(true);
  });

  it("passes the provided key through to the binding", async () => {
    const spy = vi.fn(async () => ({ success: true }));
    const limiter = { limit: spy } as unknown as RateLimit;
    await checkRateLimit(limiter, "my-key");
    expect(spy).toHaveBeenCalledWith({ key: "my-key" });
  });
});

describe("rateLimitedResponse", () => {
  it("returns 429 with { error: 'rate_limited' } and a Retry-After header", async () => {
    const app = new Hono<AppEnv>();
    app.get("/x", (c) => rateLimitedResponse(c));
    const res = await app.request("/x");

    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("60");
    expect(await res.json()).toEqual({ error: "rate_limited" });
  });

  it("honors a custom Retry-After value", async () => {
    const app = new Hono<AppEnv>();
    app.get("/x", (c) => rateLimitedResponse(c, 10));
    const res = await app.request("/x");

    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("10");
  });
});

describe("enforceRateLimit", () => {
  function appWith(limiter: RateLimit | undefined) {
    const app = new Hono<AppEnv>();
    app.get("/x", async (c) => {
      const limited = await enforceRateLimit(c, limiter, "ip-1.2.3.4");
      if (limited) return limited;
      return c.json({ ok: true });
    });
    return app;
  }

  it("returns null and lets the request proceed when under limit", async () => {
    const res = await appWith(allowLimiter).request("/x");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("returns a 429 response when over limit", async () => {
    const res = await appWith(blockLimiter).request("/x");
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("60");
    expect(await res.json()).toEqual({ error: "rate_limited" });
  });

  it("FAILS OPEN when the binding is absent", async () => {
    const res = await appWith(undefined).request("/x");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("FAILS OPEN when the binding throws", async () => {
    const res = await appWith(throwLimiter).request("/x");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("surfaces a custom Retry-After on the 429", async () => {
    const app = new Hono<AppEnv>();
    app.get("/x", async (c) => {
      const limited = await enforceRateLimit(c, blockLimiter, "k", 10);
      if (limited) return limited;
      return c.json({ ok: true });
    });
    const res = await app.request("/x");
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("10");
  });
});

describe("assertLimitersPresent", () => {
  const REQUIRED = [
    "RL_BANNER_IP",
    "RL_BANNER_MISS_IP",
    "RL_EVENTS_KEY",
    "RL_EVENTS_IP",
    "RL_AUTH_POST_IP",
    "RL_AUTH_GET_IP",
    "RL_API_KEY",
    "RL_API_KEY_FAIL_IP",
  ] as const;

  /** Bindings with every required limiter defined (value identity doesn't matter). */
  function envWithAllLimiters(): Bindings {
    const env = {} as Bindings;
    for (const name of REQUIRED) {
      (env as Record<string, unknown>)[name] = allowLimiter;
    }
    return env;
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("logs console.error for a missing binding on a non-localhost origin", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const env = envWithAllLimiters();
    delete (env as Record<string, unknown>).RL_EVENTS_KEY; // drop one
    assertLimitersPresent(env, "https://api.gopaylocal.com");
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![0]).toContain("RL_EVENTS_KEY");
    expect(spy.mock.calls[0]![0]).toContain("failing OPEN");
  });

  it("logs nothing for a localhost origin (even with missing bindings)", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    assertLimitersPresent({} as Bindings, "http://localhost:8787");
    assertLimitersPresent({} as Bindings, "http://127.0.0.1:8787");
    expect(spy).not.toHaveBeenCalled();
  });

  it("logs nothing when every required binding is present", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    assertLimitersPresent(envWithAllLimiters(), "https://api.gopaylocal.com");
    expect(spy).not.toHaveBeenCalled();
  });

  it("names a missing secret-key limiter", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const env = envWithAllLimiters();
    delete (env as Record<string, unknown>).RL_API_KEY_FAIL_IP;
    assertLimitersPresent(env, "https://api.gopaylocal.com");
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![0]).toContain("RL_API_KEY_FAIL_IP");
  });
});

describe("secret API key limiters (wrangler.toml)", () => {
  function limiter(name: string): { limit: number; period: number } {
    const toml = readFileSync(new URL("../../wrangler.toml", import.meta.url), "utf8");
    const block = toml.split("[[ratelimits]]").find((b) => b.includes(`name = "${name}"`));
    if (!block) throw new Error(`${name} not found in wrangler.toml`);
    return {
      limit: Number(block.match(/^\s*limit\s*=\s*(\d+)/m)![1]),
      period: Number(block.match(/^\s*period\s*=\s*(\d+)/m)![1]),
    };
  }

  it("300 requests per minute per key, 10 failed lookups per minute per IP", () => {
    expect(limiter("RL_API_KEY")).toEqual({ limit: 300, period: 60 });
    expect(limiter("RL_API_KEY_FAIL_IP")).toEqual({ limit: 10, period: 60 });
  });
});

describe("RL_EVENTS_KEY sizing (wrangler.toml)", () => {
  /** limit/period of one [[ratelimits]] entry, read from the deployed config. */
  function limiter(name: string): { limit: number; period: number } {
    const toml = readFileSync(new URL("../../wrangler.toml", import.meta.url), "utf8");
    const block = toml.split("[[ratelimits]]").find((b) => b.includes(`name = "${name}"`));
    if (!block) throw new Error(`${name} not found in wrangler.toml`);
    return {
      limit: Number(block.match(/^\s*limit\s*=\s*(\d+)/m)![1]),
      period: Number(block.match(/^\s*period\s*=\s*(\d+)/m)![1]),
    };
  }

  it("B-2: holds a busy site's events in one colo (it was 120/min, which dropped real events)", () => {
    // Every banner event of a site shares this per-key bucket. A Pro site at the
    // 20M calls/month fair-use line averages ~460 calls/min; ~1.5 events per
    // shown banner, a 4x peak and half the traffic in one colo is ~1,400/min.
    const { limit, period } = limiter("RL_EVENTS_KEY");
    expect(period).toBe(60);
    expect(limit).toBeGreaterThanOrEqual(1_400);
  });

  it("keeps the per-IP backstop tight", () => {
    expect(limiter("RL_EVENTS_IP")).toEqual({ limit: 120, period: 60 });
  });
});
