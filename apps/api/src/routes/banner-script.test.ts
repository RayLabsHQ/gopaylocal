import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Bindings } from "../bindings";
import type { Database } from "../db";
import { createExecutionContext, createMockKV, createTestBindings, type TestExecutionContext } from "../test/helpers";
import { createSqlRecorder, type SqlRecorder } from "../lib/sql-recorder-test-helpers";
import { usageKey } from "../services/usage.service";
import { discountCacheKey } from "../services/parity.service";
import { assignVariant, visitorKey } from "../services/banner-selection";
import type { BannerConfig } from "@gopaylocal/shared/types";
import type { CachedBannerConfig, CachedDeal } from "../services/banner-cache.service";
import { TEST_BANNER, TEST_COUNTRIES, bannerDocForCampaign, cachedCampaign } from "../services/banner-doc-test-helpers";
import { resetFxCacheForTests } from "../services/fx-cache";
import { FX_RATES_KEY } from "../services/fx-refresh.service";
import type { UsageRow } from "../services/usage-meter";
import type { ImpressionRow } from "../services/impression-meter";
import {
  BANNER_DOC_CHECK_TTL_MS,
  BANNER_DOC_MEMORY_TTL_MS,
  BANNER_HOT_CACHE_TTL_MS,
  apiKeyMissCache,
  bannerDocCache,
  configureBannerHotCache,
} from "../services/banner-hot-cache";

// The route imports the pre-built browser bundle as a wrangler text module;
// stub it so the browser code never runs under Node.
vi.mock("../../../../packages/banner/dist/banner.js", () => ({ default: "/* banner bundle */" }));

const state = vi.hoisted(() => ({
  db: null as unknown,
  written: [] as Array<Array<Record<string, unknown>>>,
  writeError: null as Error | null,
  impressions: [] as ImpressionRow[][],
  impressionWriteError: null as Error | null,
}));

// Postgres: every createDb() returns the current test's SQL recorder.
vi.mock("../db", () => ({ createDb: () => state.db }));

// Metering: the real UsageMeter, with the api_usage_daily write captured.
vi.mock("../services/usage-meter", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/usage-meter")>();
  return {
    ...actual,
    writeUsageRows: vi.fn(async (_db: unknown, rows: UsageRow[]) => {
      if (state.writeError) throw state.writeError;
      state.written.push(rows.map((r) => ({ ...r })));
    }),
  };
});

// Impressions: the real ImpressionMeter, with the analytics_rollups write captured.
vi.mock("../services/impression-meter", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/impression-meter")>();
  return {
    ...actual,
    writeImpressionRows: vi.fn(async (_db: unknown, rows: ImpressionRow[]) => {
      if (state.impressionWriteError) throw state.impressionWriteError;
      state.impressions.push(rows.map((r) => ({ ...r })));
    }),
  };
});

// Background rebuilds are asserted, not run (banner-cache.service.test.ts
// covers the builder).
vi.mock("../services/banner-cache.service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/banner-cache.service")>();
  return {
    ...actual,
    pushBannerConfigForOrg: vi.fn(async () => {}),
    refreshBannerConfigForOrg: vi.fn(async () => "current" as const),
  };
});

const { default: bannerScriptRoute } = await import("./banner-script");
const { usageMeter } = await import("../services/usage-meter");
const { impressionMeter } = await import("../services/impression-meter");
const { pushBannerConfigForOrg, refreshBannerConfigForOrg } = await import("../services/banner-cache.service");

const PUBLIC_KEY = "gpl_pk_test_fastpath";
const API_KEY_ID = "key_fastpath";
const IP = "203.0.113.7";
const UA = "Mozilla/5.0 (test)";

async function sha256Hex(value: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

interface Seed {
  org?: string;
  /** The KV banner document; `null` leaves it out (cache miss). */
  doc?: CachedBannerConfig | Record<string, unknown> | null;
  /** Leave the `apikey:{hash}` mapping out (the key resolves through Postgres). */
  keyInKv?: boolean;
  selfHosted?: boolean;
  /** usage snapshot: "over" (Free, over its cap), "pro" (unlimited), or none. */
  usage?: "over" | "pro";
}

async function seededEnv(seed: Seed = {}): Promise<Bindings> {
  const org = seed.org ?? "org_1";
  const cache = createMockKV();
  if (seed.keyInKv !== false) {
    await cache.put(
      `apikey:${await sha256Hex(PUBLIC_KEY)}`,
      JSON.stringify({ apiKeyId: API_KEY_ID, organizationId: org }),
    );
  }
  const doc = seed.doc === undefined ? bannerDocForCampaign({ organizationId: org }) : seed.doc;
  if (doc) await cache.put(`banner-config:${API_KEY_ID}`, JSON.stringify(doc));
  if (seed.usage === "over") {
    await cache.put(usageKey(org), JSON.stringify({ count: 12_000, limit: 10_000, over: true, updatedAt: "" }));
  } else if (seed.usage === "pro") {
    await cache.put(usageKey(org), JSON.stringify({ count: 12_000, limit: null, over: false, updatedAt: "" }));
  }
  return createTestBindings({ CACHE: cache, SELF_HOSTED: seed.selfHosted ? "true" : "false" });
}

interface CallOptions {
  query?: Record<string, string>;
  headers?: Record<string, string>;
  country?: string;
  ip?: string;
  ua?: string;
  /** Pass a context to keep (and settle later); otherwise one is created and settled. */
  ctx?: TestExecutionContext | null;
}

async function call(env: Bindings, opts: CallOptions = {}) {
  const url = new URL(`https://api.test/v1/banner/config/${PUBLIC_KEY}`);
  for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, v);
  const req = new Request(url, {
    headers: { "cf-connecting-ip": opts.ip ?? IP, "user-agent": opts.ua ?? UA, ...opts.headers },
  });
  // request.cf is set by Cloudflare at the edge; emulate it.
  Object.defineProperty(req, "cf", { value: { country: opts.country ?? "IN", asOrganization: "Example ISP" } });
  const own = opts.ctx === undefined ? createExecutionContext() : null;
  const ctx = opts.ctx ?? own ?? undefined;
  const res = await bannerScriptRoute.fetch(req, env, ctx);
  if (own) await own.settle();
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  state.db = createSqlRecorder().db;
  state.written = [];
  state.writeError = null;
  state.impressions = [];
  state.impressionWriteError = null;
  usageMeter.reset();
  impressionMeter.reset();
  impressionMeter.configure({ flushDelayMs: 5, flushThreshold: 1_000, failureBackoffMs: 5_000 });
  // The route remembers key and quota lookups for a minute. Off here: every
  // test seeds its own KV. "remembered lookups" below turns it on.
  configureBannerHotCache({ ttlMs: 0 });
  // The FX document is memoised per isolate; no test may see another's rates.
  resetFxCacheForTests();
  // Short unlimited window so settle() doesn't wait 15 s (self-hosted and Pro
  // orgs are unlimited); the coalescing tests set their own.
  usageMeter.configure({ unlimitedFlushDelayMs: 5, unlimitedFlushThreshold: 1_000, failureBackoffMs: 5_000 });
  vi.mocked(pushBannerConfigForOrg).mockClear();
  vi.mocked(refreshBannerConfigForOrg).mockReset();
  vi.mocked(refreshBannerConfigForOrg).mockResolvedValue("current");
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

const total = () => state.written.flat().reduce((n, r) => n + (r.count as number), 0);
const impressionTotal = () => state.impressions.flat().reduce((n, r) => n + r.count, 0);

// ── KV document (fast path) ────────────────────────────────────────────────

describe("GET /v1/banner/config/:publicKey: KV document", () => {
  it("hosted Free org: shows the banner with branding, without touching Postgres", async () => {
    const r = createSqlRecorder();
    state.db = r.db;
    const { body } = await call(await seededEnv({ doc: bannerDocForCampaign({ showBranding: true }) }));
    expect(body).toMatchObject({ show: true, discount: 40, code: "PPP40", campaignId: "camp_1", showBranding: true });
    expect(body).not.toHaveProperty("experimentId");
    expect(r.queries).toHaveLength(0);
  });

  it("hosted Pro org: the cached branding bit is respected", async () => {
    const { body } = await call(await seededEnv({ doc: bannerDocForCampaign({ showBranding: false }) }));
    expect(body.showBranding).toBe(false);
  });

  it("hosted org over its monthly quota is suppressed", async () => {
    const { body } = await call(await seededEnv({ usage: "over" }));
    expect(body).toEqual({ show: false, reason: "quota_exceeded" });
  });

  it("self-hosted: branding is off even when the cache says on", async () => {
    const { body } = await call(await seededEnv({ selfHosted: true, doc: bannerDocForCampaign({ showBranding: true }) }));
    expect(body.show).toBe(true);
    expect(body.showBranding).toBe(false);
  });

  it("self-hosted: a stale over-quota snapshot never suppresses the banner", async () => {
    const { body } = await call(await seededEnv({ selfHosted: true, usage: "over" }));
    expect(body.show).toBe(true);
    expect(body.showBranding).toBe(false);
  });

  it("enforces the served campaign's allowed domains (subdomains included)", async () => {
    const env = await seededEnv({ doc: bannerDocForCampaign({ allowedDomains: ["shop.example"] }) });
    expect((await call(env)).body).toEqual({ show: false, reason: "domain_not_allowed" });
    expect((await call(env, { headers: { origin: "https://evil.example" } })).body.reason).toBe("domain_not_allowed");
    expect((await call(env, { headers: { origin: "https://www.shop.example" } })).body.show).toBe(true);
  });

  it("a country the campaign does not discount gets no_discount", async () => {
    expect((await call(await seededEnv(), { country: "US" })).body).toEqual({ show: false, reason: "no_discount" });
  });

  it("a provider-backed country marked `resolve` is answered under the document's epoch", async () => {
    const doc = bannerDocForCampaign({
      countries: { IN: { discount: 40, tier: 3, code: null, countryName: "India", resolve: true } },
    });
    const env = await seededEnv({ doc });
    // getDiscountForCountry's cache entry for this epoch (written by an earlier request).
    await env.CACHE.put(
      discountCacheKey("test-epoch", "camp_1", "IN"),
      JSON.stringify({ discount: 40, tier: 3, code: "LIVE40" }),
    );
    const r = createSqlRecorder();
    state.db = r.db;
    const { body } = await call(env);
    expect(body).toMatchObject({ show: true, discount: 40, code: "LIVE40" });
    expect(r.queries).toHaveLength(0);
  });
});

// ── product parameter (contract C2) ────────────────────────────────────────

describe("product parameter", () => {
  const twoProducts: CachedBannerConfig = {
    ...bannerDocForCampaign(),
    defaultProductId: "P2",
    products: {
      P1: { kind: "campaign", campaignId: "C1" },
      P2: { kind: "campaign", campaignId: "C2" },
    },
    campaigns: {
      C1: cachedCampaign({ countries: { IN: { discount: 30, tier: 2, code: "ONE30", countryName: "India" } } }),
      C2: cachedCampaign({ countries: { IN: { discount: 50, tier: 4, code: "TWO50", countryName: "India" } } }),
    },
  };

  it("two products on one key each get their own campaign", async () => {
    const env = await seededEnv({ doc: twoProducts });
    expect((await call(env, { query: { product: "P1" } })).body).toMatchObject({ campaignId: "C1", code: "ONE30" });
    expect((await call(env, { query: { product: "P2" } })).body).toMatchObject({ campaignId: "C2", code: "TWO50" });
  });

  it("without `product`, the document's default product answers (empty counts as absent)", async () => {
    const env = await seededEnv({ doc: twoProducts });
    expect((await call(env)).body).toMatchObject({ campaignId: "C2" });
    expect((await call(env, { query: { product: "" } })).body).toMatchObject({ campaignId: "C2" });
  });

  it("an unknown, malformed or prototype-named product gets nothing, never another product's campaign", async () => {
    const env = await seededEnv({ doc: twoProducts });
    for (const product of ["P3", "../P1", "x".repeat(65), "constructor", "__proto__", "toString"]) {
      const { status, body } = await call(env, { query: { product } });
      expect(status).toBe(200);
      expect(body).toEqual({ show: false, reason: "no_active_campaign" });
    }
  });

  it("an organization with nothing servable gets no_active_campaign", async () => {
    const empty = { ...bannerDocForCampaign(), defaultProductId: null, products: {}, campaigns: {} };
    expect((await call(await seededEnv({ doc: empty }))).body).toEqual({ show: false, reason: "no_active_campaign" });
  });
});

// ── experiments (contracts C1/C2) ──────────────────────────────────────────

describe("experiment arm assignment", () => {
  const armCountry = (discount: number, code: string) => ({
    IN: { discount, tier: 3, code, countryName: "India" },
  });
  const experimentDoc = (overrides: Partial<CachedBannerConfig> = {}): CachedBannerConfig => ({
    ...bannerDocForCampaign(),
    defaultProductId: "P1",
    products: {
      P1: { kind: "experiment", experimentId: "EXP1", campaignAId: "A", campaignBId: "B", trafficSplitB: 50 },
    },
    campaigns: {
      A: cachedCampaign({ countries: armCountry(40, "ARM-A") }),
      B: cachedCampaign({ countries: armCountry(25, "ARM-B") }),
    },
    ...overrides,
  });

  it("adds experimentId and variant, serves the assigned arm, and is sticky per vid", async () => {
    const env = await seededEnv({ doc: experimentDoc() });
    const seen = new Set<string>();
    for (let i = 0; i < 24; i++) {
      const vid = `visitor-${String(i).padStart(12, "0")}`;
      const expected = await assignVariant("EXP1", visitorKey(vid, IP, UA), 50);
      const first = (await call(env, { query: { vid } })).body;
      expect(first).toMatchObject({
        show: true,
        experimentId: "EXP1",
        variant: expected,
        campaignId: expected === "b" ? "B" : "A",
        code: expected === "b" ? "ARM-B" : "ARM-A",
      });
      // Same visitor from another IP and browser: same arm (the vid is the key).
      const again = (await call(env, { query: { vid }, ip: "198.51.100.9", ua: "Other/1.0" })).body;
      expect(again.variant).toBe(first.variant);
      seen.add(first.variant as string);
    }
    expect(seen).toEqual(new Set(["a", "b"]));
  });

  it("without a valid vid, the arm is keyed on IP + user agent", async () => {
    const env = await seededEnv({ doc: experimentDoc() });
    const queries: Array<Record<string, string>> = [{}, { vid: "short" }, { vid: "bad vid with spaces!" }];
    for (const query of queries) {
      const expected = await assignVariant("EXP1", visitorKey(null, IP, UA), 50);
      expect((await call(env, { query })).body.variant).toBe(expected);
    }
  });

  it("the assigned arm without a discount for the country: no_discount, still tagged, no fallback to the other arm", async () => {
    // Only arm A discounts India; find a visitor assigned to B.
    let vid = "";
    for (let i = 0; !vid; i++) {
      const candidate = `visitor-${String(i).padStart(12, "0")}`;
      if ((await assignVariant("EXP1", visitorKey(candidate, IP, UA), 50)) === "b") vid = candidate;
    }
    const doc = experimentDoc({
      campaigns: {
        A: cachedCampaign({ countries: armCountry(40, "ARM-A") }),
        B: cachedCampaign({ countries: {} }),
      },
    });
    const { body } = await call(await seededEnv({ doc }), { query: { vid } });
    expect(body).toEqual({ show: false, reason: "no_discount", experimentId: "EXP1", variant: "b" });
  });

  it("the experiment applies to its product only", async () => {
    const doc = experimentDoc({
      products: {
        P1: { kind: "experiment", experimentId: "EXP1", campaignAId: "A", campaignBId: "B", trafficSplitB: 50 },
        P2: { kind: "campaign", campaignId: "A" },
      },
    });
    const { body } = await call(await seededEnv({ doc }), { query: { product: "P2", vid: "visitor-000000000001" } });
    expect(body).toMatchObject({ show: true, campaignId: "A" });
    expect(body).not.toHaveProperty("experimentId");
    expect(body).not.toHaveProperty("variant");
  });
});

// ── metering (api_usage_daily) ─────────────────────────────────────────────

describe("server-side metering", () => {
  it("counts a valid call once, as live, for an organization without a snapshot (written at once)", async () => {
    await call(await seededEnv());
    expect(state.written).toEqual([[{ organizationId: "org_1", day: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/), environment: "live", count: 1 }]]);
  });

  it("a call served by a test-environment campaign is stored as test", async () => {
    await call(await seededEnv({ doc: bannerDocForCampaign({ environment: "test" }) }));
    expect(state.written.flat()).toEqual([expect.objectContaining({ environment: "test", count: 1 })]);
  });

  it("a call that reaches resolution but has nothing to serve still counts (as live)", async () => {
    await call(await seededEnv(), { query: { product: "NOPE" } });
    await call(await seededEnv(), { country: "US" }); // no_discount
    await call(await seededEnv({ doc: bannerDocForCampaign({ allowedDomains: ["a.example"] }) })); // domain_not_allowed
    expect(total()).toBe(3);
    expect(state.written.flat().every((r) => r.environment === "live")).toBe(true);
  });

  it("does not count requests that never reach campaign resolution", async () => {
    await call(await seededEnv({ usage: "over" })); // quota_exceeded
    await call(await seededEnv(), { country: "XX" }); // unknown_country
    const noKey = await seededEnv({ keyInKv: false });
    state.db = createSqlRecorder([[]]).db; // key not in Postgres either
    expect((await call(noKey)).status).toBe(401);
    expect(state.written).toEqual([]);
  });

  it("an unlimited organization's calls are coalesced into one write per window", async () => {
    usageMeter.configure({ unlimitedFlushDelayMs: 20 });
    const env = await seededEnv({ usage: "pro" });
    const ctxs = [createExecutionContext(), createExecutionContext(), createExecutionContext()];
    for (const ctx of ctxs) await call(env, { ctx });
    expect(state.written).toEqual([]); // nothing written on the request path
    for (const ctx of ctxs) await ctx.settle();
    expect(state.written).toEqual([[expect.objectContaining({ organizationId: "org_1", environment: "live", count: 3 })]]);
  });

  it("self-hosted organizations are metered as unlimited (coalesced), never as over quota", async () => {
    usageMeter.configure({ unlimitedFlushDelayMs: 20 });
    const env = await seededEnv({ selfHosted: true });
    const a = createExecutionContext();
    const b = createExecutionContext();
    await call(env, { ctx: a });
    await call(env, { ctx: b });
    await a.settle();
    await b.settle();
    expect(state.written).toEqual([[expect.objectContaining({ count: 2 })]]);
  });

  it("fails open: a failing usage write never affects the banner and is logged", async () => {
    state.writeError = new Error("db down");
    const { status, body } = await call(await seededEnv());
    expect(status).toBe(200);
    expect(body.show).toBe(true);
    expect(errorSpy).toHaveBeenCalledWith(
      "usage-meter: write failed; counts kept for the next flush",
      expect.objectContaining({ organizationId: "org_1" }),
    );
  });
});

// ── KV miss / old document: the database path, same selection ─────────────

describe("missing or old document: answered from Postgres and rebuilt", () => {
  const campaignRow = (id: string, productId: string, overrides: Record<string, unknown> = {}) => ({
    id,
    organizationId: "org_db",
    productId,
    name: id,
    status: "active",
    environment: "live",
    pricingMode: "custom",
    maxDiscountPercent: 70,
    discountOverrides: { IN: 35 },
    integrationId: null,
    allowedDomains: null,
    createdAt: new Date("2026-11-01T00:00:00Z"),
    updatedAt: new Date("2026-11-01T00:00:00Z"),
    ...overrides,
  });
  const bannerRow = (campaignId: string) => ({ id: `b_${campaignId}`, campaignId, ...TEST_BANNER });

  /**
   * loadServingInputs (campaigns joined with their product's price and
   * currency, then experiments, then deals), getDiscountForCountry, subscription.
   */
  function dbPath(
    rows: Array<ReturnType<typeof campaignRow>>,
    servedId: string,
    product: { currency: string; basePrice: number } = { currency: "INR", basePrice: 1499 },
  ): SqlRecorder {
    const served = rows.find((r) => r.id === servedId)!;
    return createSqlRecorder([
      rows.map((campaign) => ({ campaign, banner: bannerRow(campaign.id), product })),
      [],
      [],
      [served],
      [],
    ]);
  }

  it("a version-1 document is a cache miss: Postgres answers and a rebuild is scheduled", async () => {
    const r = dbPath([campaignRow("C1", "P1")], "C1");
    state.db = r.db;
    const v1 = { campaignId: "C1", allowedDomains: null, banner: TEST_BANNER, countries: {}, showBranding: true };
    const env = await seededEnv({ org: "org_db", doc: v1 });

    const { body } = await call(env);

    // An INR product for an Indian visitor: the exact price, no conversion.
    expect(body).toMatchObject({
      show: true,
      campaignId: "C1",
      discount: 35,
      baseCurrencyCode: "INR",
      currencyCode: "INR",
      currencySymbol: "₹",
      fxRate: 1,
      localPrice: 974.35,
      localOriginalPrice: 1499,
      charmPricingStrategy: "none",
      showBranding: true,
    });
    expect(r.queries[0]!.sql).toContain('from "campaigns" inner join "products"');
    expect(r.queries[0]!.sql).toContain('left join "banner_configs"');
    expect(r.queries[1]!.sql).toContain('from "experiments"');
    // Deals that have not ended, with their active coupon.
    expect(r.queries[2]!.sql).toContain('from "deals" left join "coupons"');
    expect(r.queries[2]!.sql).toContain('"deals"."ends_at" >');
    expect(pushBannerConfigForOrg).toHaveBeenCalledWith(state.db, env.CACHE, "org_db", env);
  });

  it("a version-2 document (no campaign pricing) is a cache miss too", async () => {
    state.db = dbPath([campaignRow("C1", "P1")], "C1").db;
    const v2 = { ...bannerDocForCampaign({ organizationId: "org_db_v2" }), v: 2 };
    const env = await seededEnv({ org: "org_db_v2", doc: v2 });
    expect((await call(env)).body).toMatchObject({ show: true, campaignId: "C1", currencyCode: "INR" });
    expect(pushBannerConfigForOrg).toHaveBeenCalledWith(state.db, env.CACHE, "org_db_v2", env);
  });

  it("the database path applies the product parameter with the same selection", async () => {
    const rows = [
      campaignRow("C1", "P1", { createdAt: new Date("2026-11-01T00:00:00Z") }),
      campaignRow("C2", "P2", { createdAt: new Date("2026-11-02T00:00:00Z") }),
    ];
    state.db = dbPath(rows, "C1").db;
    const env = await seededEnv({ org: "org_db_products", doc: null });
    expect((await call(env, { query: { product: "P1" } })).body).toMatchObject({ show: true, campaignId: "C1" });

    // No product: the newest servable campaign's product (P2).
    state.db = dbPath(rows, "C2").db;
    expect((await call(env)).body).toMatchObject({ show: true, campaignId: "C2" });
  });

  it("rebuilds at most once per organization per minute from one isolate", async () => {
    const env = await seededEnv({ org: "org_db_throttle", doc: null });
    for (let i = 0; i < 3; i++) {
      state.db = dbPath([campaignRow("C1", "P1")], "C1").db;
      await call(env);
    }
    expect(pushBannerConfigForOrg).toHaveBeenCalledTimes(1);
  });

  it("a database failure on this path is logged and answered with internal_error", async () => {
    state.db = createSqlRecorder([new Error("connection refused")]).db;
    const { status, body } = await call(await seededEnv({ org: "org_db_down", doc: null }));
    expect(status).toBe(500);
    expect(body).toEqual({ show: false, reason: "internal_error" });
    expect(errorSpy).toHaveBeenCalledWith(
      "banner: config request failed",
      expect.objectContaining({ error: expect.stringContaining("connection refused") }),
    );
  });

  describe("with the document memory on (services/banner-hot-cache.ts)", () => {
    /** How many times `run` made the route read the banner document from KV. */
    async function docReads(env: Bindings, run: () => Promise<void>): Promise<number> {
      const get = vi.spyOn(env.CACHE, "get");
      await run();
      return get.mock.calls.filter(([key]) => String(key).startsWith("banner-config:")).length;
    }

    it("a missing document is not remembered: the one a rebuild writes is used by the next request", async () => {
      configureBannerHotCache({ ttlMs: BANNER_HOT_CACHE_TTL_MS });
      const env = await seededEnv({ org: "org_mem_missing", doc: null });
      // No document: answered from Postgres, and KV is asked again on every
      // request until it has one.
      const reads = await docReads(env, async () => {
        for (let i = 0; i < 2; i++) {
          state.db = dbPath([campaignRow("C1", "P1")], "C1").db;
          expect((await call(env)).body).toMatchObject({ show: true, campaignId: "C1" });
        }
      });
      expect(reads).toBe(2);
      expect(bannerDocCache.size()).toBe(0);

      await env.CACHE.put(
        `banner-config:${API_KEY_ID}`,
        JSON.stringify(bannerDocForCampaign({ organizationId: "org_mem_missing" })),
      );
      expect((await call(env)).body).toMatchObject({ show: true, campaignId: "camp_1", discount: 40 });
      expect(bannerDocCache.size()).toBe(1);
    });

    it("a document of an older version is not remembered either", async () => {
      configureBannerHotCache({ ttlMs: BANNER_HOT_CACHE_TTL_MS });
      const old = { ...bannerDocForCampaign({ organizationId: "org_mem_old" }), v: 2 };
      const env = await seededEnv({ org: "org_mem_old", doc: old });
      const reads = await docReads(env, async () => {
        for (let i = 0; i < 2; i++) {
          state.db = dbPath([campaignRow("C1", "P1")], "C1").db;
          expect((await call(env)).body).toMatchObject({ show: true, campaignId: "C1" });
        }
      });
      expect(reads).toBe(2);
      expect(bannerDocCache.size()).toBe(0);
    });
  });
});

// ── Check of an aging document (backstop for a lost rebuild) ───────────────

describe("a served document older than 15 minutes is checked against the database in the background", () => {
  const BUILT = Date.parse("2026-11-19T12:00:00Z");
  const MIN = 60_000;

  afterEach(() => vi.useRealTimers());

  /** The env with every KV read counted, and a recorder to see database work. */
  async function aged(org: string, builtAt: number | undefined) {
    const doc = bannerDocForCampaign({ organizationId: org, builtAt }) as Partial<CachedBannerConfig>;
    if (builtAt === undefined) delete doc.builtAt;
    const env = await seededEnv({ org, doc: doc as CachedBannerConfig });
    const reads: string[] = [];
    const get = env.CACHE.get.bind(env.CACHE);
    env.CACHE.get = ((key: string, opts?: unknown) => {
      reads.push(key);
      return get(key, opts as "text");
    }) as KVNamespace["get"];
    const r = createSqlRecorder();
    state.db = r.db;
    return { env, reads, r };
  }

  it("a fresh document: no check and no rebuild", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(BUILT + 15 * MIN - 1);
    const { env } = await aged("org_fresh", BUILT);
    expect((await call(env)).body).toMatchObject({ show: true, campaignId: "camp_1" });
    expect(refreshBannerConfigForOrg).not.toHaveBeenCalled();
    expect(pushBannerConfigForOrg).not.toHaveBeenCalled();
  });

  it("at 15 minutes: still answered from the document, a check (not a rebuild) is scheduled, and the request does no extra KV or database work", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(BUILT + 15 * MIN - 1);
    const fresh = await aged("org_aging_fresh", BUILT);
    await call(fresh.env);

    vi.setSystemTime(BUILT + 15 * MIN);
    resetFxCacheForTests(); // the FX document is memoised per isolate; read it again like the first request
    const due = await aged("org_aging", BUILT);
    expect((await call(due.env)).body).toMatchObject({ show: true, campaignId: "camp_1", discount: 40 });
    expect(refreshBannerConfigForOrg).toHaveBeenCalledTimes(1);
    expect(refreshBannerConfigForOrg).toHaveBeenCalledWith(state.db, due.env.CACHE, "org_aging", due.env);
    // The document is only rewritten by the check, and only if it differs.
    expect(pushBannerConfigForOrg).not.toHaveBeenCalled();
    expect(due.r.queries).toHaveLength(0);
    // Same KV keys read as for a fresh document (the org part differs).
    expect(due.reads.map((k) => k.replace("org_aging", "ORG"))).toEqual(
      fresh.reads.map((k) => k.replace("org_aging_fresh", "ORG")),
    );
  });

  it("a document without builtAt (written before the field existed) is served and due", async () => {
    const { env, r } = await aged("org_no_built_at", undefined);
    expect((await call(env)).body).toMatchObject({ show: true, campaignId: "camp_1" });
    expect(refreshBannerConfigForOrg).toHaveBeenCalledTimes(1);
    expect(pushBannerConfigForOrg).not.toHaveBeenCalled();
    expect(r.queries).toHaveLength(0);
  });

  it("a busy workspace whose document nothing changed: one check per isolate per 14 minutes, however many requests", async () => {
    configureBannerHotCache({ ttlMs: BANNER_HOT_CACHE_TTL_MS });
    expect(BANNER_DOC_CHECK_TTL_MS).toBe(14 * MIN);
    vi.useFakeTimers({ toFake: ["Date"] });
    const { env } = await aged("org_busy", BUILT);
    // The document stays as old as it is: a check that finds it current does
    // not write it. A request every 3 seconds for the next hour.
    const start = BUILT + 15 * MIN;
    for (let t = 0; t < 60 * MIN; t += 3_000) {
      vi.setSystemTime(start + t);
      await call(env);
    }
    // At 0, 14, 28, 42 and 56 minutes.
    expect(refreshBannerConfigForOrg).toHaveBeenCalledTimes(5);
    expect(pushBannerConfigForOrg).not.toHaveBeenCalled();
  });

  it("a check that failed is not remembered: tried again after a minute, then quiet once one succeeds", async () => {
    configureBannerHotCache({ ttlMs: BANNER_HOT_CACHE_TTL_MS });
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.useFakeTimers({ toFake: ["Date"] });
    const { env } = await aged("org_check_fails", BUILT);
    vi.mocked(refreshBannerConfigForOrg).mockRejectedValueOnce(new Error("db down"));

    // 200 requests over the first minute: one check (it fails).
    for (let i = 0; i < 200; i++) {
      vi.setSystemTime(BUILT + 15 * MIN + i * 299);
      await call(env);
    }
    expect(refreshBannerConfigForOrg).toHaveBeenCalledTimes(1);
    expect(console.error).toHaveBeenCalledWith(
      "banner-cache: rebuild failed",
      expect.objectContaining({ orgId: "org_check_fails", error: expect.stringContaining("db down") }),
    );

    // A minute later: one more (it succeeds), then nothing for 14 minutes.
    vi.setSystemTime(BUILT + 16 * MIN);
    for (let i = 0; i < 50; i++) await call(env);
    expect(refreshBannerConfigForOrg).toHaveBeenCalledTimes(2);
    vi.setSystemTime(BUILT + 29 * MIN);
    await call(env);
    expect(refreshBannerConfigForOrg).toHaveBeenCalledTimes(2);
    vi.setSystemTime(BUILT + 30 * MIN);
    await call(env);
    expect(refreshBannerConfigForOrg).toHaveBeenCalledTimes(3);
  });

  it("with the memory off, the per-minute throttle still bounds the checks", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { env } = await aged("org_throttle", BUILT);
    for (let i = 0; i < 200; i++) {
      vi.setSystemTime(BUILT + 15 * MIN + i * 299);
      await call(env);
    }
    expect(refreshBannerConfigForOrg).toHaveBeenCalledTimes(1);
    vi.setSystemTime(BUILT + 16 * MIN);
    for (let i = 0; i < 50; i++) await call(env);
    expect(refreshBannerConfigForOrg).toHaveBeenCalledTimes(2);
  });

  it("a missing document is rebuilt, not checked, also right after a check", async () => {
    configureBannerHotCache({ ttlMs: BANNER_HOT_CACHE_TTL_MS, docTtlMs: 0 });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(BUILT + 15 * MIN);
    const { env } = await aged("org_then_missing", BUILT);
    await call(env);
    expect(refreshBannerConfigForOrg).toHaveBeenCalledTimes(1);

    // The document disappears; two minutes later (past the throttle) a request finds none.
    await env.CACHE.delete(`banner-config:${API_KEY_ID}`);
    vi.setSystemTime(BUILT + 17 * MIN);
    await call(env);
    expect(pushBannerConfigForOrg).toHaveBeenCalledTimes(1);
    expect(refreshBannerConfigForOrg).toHaveBeenCalledTimes(1);
  });
});

// ── Local prices (multi-currency and charm pricing) ────────────────────────

describe("local prices", () => {
  // fawazahmed0 rates for 2026-11-18 (the same values as the shared fixture
  // behind docs-examples.test.ts).
  const NOW = Date.parse("2026-11-19T12:00:00Z");
  const fxDoc = (overrides: Record<string, unknown> = {}) => ({
    v: 1,
    base: "USD",
    asOf: "2026-11-18",
    fetchedAt: "2026-11-18T18:40:00.000Z",
    source: "primary",
    rates: { USD: 1, INR: 93.32614706, EUR: 0.91080569, BRL: 5.77828238 },
    held: [],
    ...overrides,
  });
  const PRICE_FIELDS = [
    "baseCurrencyCode",
    "baseCurrencySymbol",
    "currencyCode",
    "currencySymbol",
    "fxRate",
    "fxAsOf",
    "localPrice",
    "localOriginalPrice",
    "charmPricingStrategy",
  ] as const;
  const priceFields = (body: Record<string, unknown>) =>
    Object.fromEntries(PRICE_FIELDS.filter((k) => k in body).map((k) => [k, body[k]]));

  /**
   * createMockKV ignores get()'s type; real KV parses `{ type: "json" }`, which
   * is how services/fx-cache.ts reads the rates. Seed them through this.
   */
  async function withRates(e: Bindings, fx: unknown): Promise<Bindings> {
    // createMockKV parses { type: "json" } reads as Workers KV does.
    if (fx !== undefined) await e.CACHE.put(FX_RATES_KEY, JSON.stringify(fx));
    return e;
  }

  /** A $19 round_x9 campaign discounting India and the US by 40%. */
  async function env(opts: { fx?: unknown; vars?: Partial<Bindings>; pricing?: CachedBannerConfig["campaigns"][string]["pricing"] } = {}) {
    const e = await seededEnv({
      doc: bannerDocForCampaign({
        pricing: opts.pricing ?? { currency: "USD", basePrice: 19, charm: "round_x9" },
        countries: { ...TEST_COUNTRIES, US: { discount: 40, tier: 1, code: "US40", countryName: "United States" } },
      }),
    });
    return { ...(await withRates(e, opts.fx)), ...opts.vars } as Bindings;
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("converts the product's price into the visitor's currency and charm-rounds it", async () => {
    const { body } = await call(await env({ fx: fxDoc() }));
    expect(priceFields(body)).toEqual({
      baseCurrencyCode: "USD",
      baseCurrencySymbol: "$",
      currencyCode: "INR",
      currencySymbol: "₹",
      fxRate: 93.32614706,
      fxAsOf: "2026-11-18",
      // $11.40 x 93.32614706 = 1,063.92 and $19 -> 1,773.20. The tidiest pair,
      // 1,099 / 1,699, implies 35.3%, under the 38% floor (40% - 2 points), so
      // the next one is taken: 1,069 / 1,769 implies 39.6%.
      localPrice: 1069,
      localOriginalPrice: 1769,
      charmPricingStrategy: "round_x9",
    });
    expect(body).toMatchObject({ show: true, discount: 40, code: "PPP40" });
  });

  it("uses the cross rate for a product not priced in USD (€20 at 60% off -> ₹829, was ₹1,999)", async () => {
    const e = await seededEnv({
      doc: bannerDocForCampaign({
        pricing: { currency: "EUR", basePrice: 20, charm: "round_x9" },
        countries: { IN: { discount: 60, tier: 4, code: "IN60", countryName: "India" } },
      }),
    });
    const { body } = await call(await withRates(e, fxDoc()));
    expect(body).toMatchObject({ baseCurrencyCode: "EUR", baseCurrencySymbol: "€", currencyCode: "INR", fxRate: 102.4654853, localPrice: 829, localOriginalPrice: 1999 });
  });

  it("a visitor who pays in the product's currency gets the exact price, never charm", async () => {
    const { body } = await call(await env({ fx: fxDoc() }), { country: "US" });
    expect(priceFields(body)).toEqual({
      baseCurrencyCode: "USD",
      baseCurrencySymbol: "$",
      currencyCode: "USD",
      currencySymbol: "$",
      fxRate: 1,
      localPrice: 11.4,
      localOriginalPrice: 19,
      charmPricingStrategy: "round_x9",
    });
  });

  it.each<[string, () => Promise<Bindings>]>([
    ["no rates document", () => env()],
    ["rates older than 96 hours", () => env({ fx: fxDoc({ asOf: "2026-11-15" }) })],
    ["a malformed rates document", () => env({ fx: { ...fxDoc(), rates: { USD: 2, INR: 93 } } })],
    ["the visitor's currency missing (held)", () => env({ fx: fxDoc({ rates: { USD: 1, EUR: 0.91 } }) })],
    ["FX_RATES_URL=off", () => env({ fx: fxDoc(), vars: { FX_RATES_URL: "off" } })],
    ["the visitor's currency excluded", () => env({ fx: fxDoc(), vars: { FX_EXCLUDED_CURRENCIES: "ARS, inr" } })],
  ])("without a usable rate (%s) the answer equals the same-currency answer, field for field", async (_label, make) => {
    const e = await make();
    const india = (await call(e)).body;
    resetFxCacheForTests();
    const us = (await call(e, { country: "US" })).body;
    expect(priceFields(india)).toEqual(priceFields(us));
    expect(india).not.toHaveProperty("fxAsOf");
    expect(india).toMatchObject({ show: true, country: "IN", currencyCode: "USD", fxRate: 1, localPrice: 11.4 });
  });

  it("control: the same seeding converts when the rate is usable (so the cases above are not vacuous)", async () => {
    expect((await call(await env({ fx: fxDoc() }))).body).toMatchObject({ currencyCode: "INR", fxAsOf: "2026-11-18" });
  });

  it("a no-banner answer carries no price fields", async () => {
    const { body } = await call(await env({ fx: fxDoc() }), { country: "BR" });
    expect(body).toEqual({ show: false, reason: "no_discount" });
  });

  it("the database path prices exactly like the KV document (same loader, same function)", async () => {
    const fromDoc = (await call(await env({ fx: fxDoc() }))).body;

    const row = {
      id: "camp_1",
      organizationId: "org_db_prices",
      productId: "prod_1",
      name: "camp_1",
      status: "active",
      environment: "live",
      pricingMode: "custom",
      maxDiscountPercent: 70,
      discountOverrides: { IN: 40 },
      integrationId: null,
      allowedDomains: null,
      charmPricingStrategy: "round_x9",
      createdAt: new Date("2026-11-01T00:00:00Z"),
      updatedAt: new Date("2026-11-01T00:00:00Z"),
    };
    state.db = createSqlRecorder([
      [{ campaign: row, banner: { id: "b1", campaignId: "camp_1", ...TEST_BANNER }, product: { currency: "USD", basePrice: 19 } }],
      [],
      [],
      [row],
      [],
    ]).db;
    const e = await withRates(await seededEnv({ org: "org_db_prices", doc: null }), fxDoc());
    resetFxCacheForTests();
    const fromDb = (await call(e)).body;

    expect(fromDb).toMatchObject({ show: true, campaignId: "camp_1", discount: 40 });
    expect(priceFields(fromDb)).toEqual(priceFields(fromDoc));
  });
});

// ── API key resolved through Postgres (B-4, B-6) ───────────────────────────

describe("API key not in KV", () => {
  const keyRow = { id: API_KEY_ID, organizationId: "org_1", keyType: "public" };

  it("B-4: a failing key lookup is logged, answered 500, and not remembered as a miss", async () => {
    configureBannerHotCache({ ttlMs: BANNER_HOT_CACHE_TTL_MS });
    state.db = createSqlRecorder([new Error("too many connections")]).db;
    const env = await seededEnv({ keyInKv: false });
    const { status, body } = await call(env);
    expect(status).toBe(500);
    expect(body).toEqual({ show: false, reason: "internal_error" });
    expect(errorSpy).toHaveBeenCalledWith(
      "banner: API key lookup failed",
      expect.objectContaining({ error: expect.stringContaining("too many connections") }),
    );
    expect(apiKeyMissCache.size()).toBe(0);
    // The next request asks the database again.
    state.db = createSqlRecorder([[keyRow], []]).db;
    expect((await call(env)).status).toBe(200);
  });

  it("an unknown key is refused, remembered in memory for a minute, and writes nothing to KV", async () => {
    configureBannerHotCache({ ttlMs: BANNER_HOT_CACHE_TTL_MS });
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const T = Date.parse("2026-11-21T10:00:00Z");
      vi.setSystemTime(T);
      const r = createSqlRecorder([[], []]);
      state.db = r.db;
      const env = await seededEnv({ keyInKv: false });
      const put = vi.spyOn(env.CACHE, "put");
      const get = vi.spyOn(env.CACHE, "get");

      expect((await call(env)).status).toBe(401);
      expect(r.queries).toHaveLength(1);
      const readsOfFirst = get.mock.calls.length;

      // 500 more requests in the same minute: no database, no KV read, no KV write.
      for (let i = 1; i <= 500; i++) {
        vi.setSystemTime(T + i * 100);
        const res = await call(env);
        expect(res.status).toBe(401);
        expect(res.body).toEqual({ error: "Invalid API key" });
      }
      expect(r.queries).toHaveLength(1);
      expect(get.mock.calls.length).toBe(readsOfFirst);
      expect(put).not.toHaveBeenCalled();

      // A minute after the lookup the database is asked once more.
      vi.setSystemTime(T + BANNER_HOT_CACHE_TTL_MS);
      expect((await call(env)).status).toBe(401);
      expect(r.queries).toHaveLength(2);
      expect(put).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("with the memory off, an unknown key still writes nothing to KV", async () => {
    state.db = createSqlRecorder([[], []]).db;
    const env = await seededEnv({ keyInKv: false });
    const put = vi.spyOn(env.CACHE, "put");
    expect((await call(env)).status).toBe(401);
    expect((await call(env)).status).toBe(401);
    expect(put).not.toHaveBeenCalled();
  });

  it("B-6: lastUsedAt is written inside waitUntil, so the runtime keeps it alive after the response", async () => {
    const r = createSqlRecorder([[keyRow], []]);
    let lastUsedWritten = false;
    // Delay the UPDATE: only a promise handed to waitUntil is awaited by settle().
    state.db = new Proxy(r.db, {
      get(target, prop, receiver) {
        if (prop !== "update") return Reflect.get(target, prop, receiver);
        return (table: unknown) => ({
          set: (values: unknown) => ({
            where: (cond: unknown) => {
              const query = (target as Database).update(table as never).set(values as never).where(cond as never);
              return new Promise((resolve) => setTimeout(resolve, 20))
                .then(() => query)
                .then((v) => {
                  lastUsedWritten = true;
                  return v;
                });
            },
          }),
        });
      },
    });
    const env = await seededEnv({ keyInKv: false });
    const ctx = createExecutionContext();

    const { body } = await call(env, { ctx });
    expect(body.show).toBe(true);
    expect(lastUsedWritten).toBe(false);

    await ctx.settle();
    expect(lastUsedWritten).toBe(true);
    expect(r.queries.some((q) => q.sql.startsWith('update "api_keys" set "last_used_at"'))).toBe(true);
    // And the KV mapping was backfilled for the fast path.
    expect(await env.CACHE.get(`apikey:${await sha256Hex(PUBLIC_KEY)}`)).not.toBeNull();
  });

  it("B-6: a failing lastUsedAt update is logged, not swallowed, and never affects the banner", async () => {
    state.db = createSqlRecorder([[keyRow], new Error("write timeout")]).db;
    const { body } = await call(await seededEnv({ keyInKv: false }));
    expect(body.show).toBe(true);
    expect(errorSpy).toHaveBeenCalledWith(
      "banner: lastUsedAt update failed",
      expect.objectContaining({ apiKeyId: API_KEY_ID, error: expect.stringContaining("write timeout") }),
    );
  });
});

// ── Secret keys on the public endpoints ────────────────────────────────────

describe("a secret key (gpl_sk_) on the banner endpoints", () => {
  const SECRET = `gpl_sk_${"ab12".repeat(16)}`;
  const HEX = SECRET.slice(7);

  /** Bindings whose limiter, KV and database record every key they are asked about. */
  async function watchedEnv() {
    const env = await seededEnv();
    const limiterKeys: string[] = [];
    const limiter = { limit: vi.fn(async ({ key }: { key: string }) => (limiterKeys.push(key), { success: true })) };
    const kvKeys: string[] = [];
    const get = env.CACHE.get.bind(env.CACHE);
    env.CACHE.get = (async (key: string, ...rest: unknown[]) => (kvKeys.push(key), (get as (...a: unknown[]) => unknown)(key, ...rest))) as KVNamespace["get"];
    const r = createSqlRecorder();
    state.db = r.db;
    return { env: { ...env, RL_BANNER_IP: limiter, RL_BANNER_MISS_IP: limiter } as unknown as Bindings, limiterKeys, kvKeys, r };
  }

  it("config: 401 before any limiter key, KV read or database lookup, and the key is never echoed or logged", async () => {
    const { env, limiterKeys, kvKeys, r } = await watchedEnv();
    for (const key of [SECRET, `GPL_SK_${HEX}`]) {
      const url = new URL(`https://api.test/v1/banner/config/${key}`);
      const req = new Request(url, { headers: { "cf-connecting-ip": IP } });
      Object.defineProperty(req, "cf", { value: { country: "IN" } });
      const ctx = createExecutionContext();
      const res = await bannerScriptRoute.fetch(req, env, ctx);
      await ctx.settle();
      const text = await res.text();
      expect(res.status).toBe(401);
      expect(JSON.parse(text)).toMatchObject({ code: "secret_key_not_allowed" });
      expect(text).not.toContain(HEX);
    }
    expect(limiterKeys).toEqual([]);
    expect(kvKeys).toEqual([]);
    expect(r.queries).toEqual([]);
    expect(state.written).toEqual([]); // not metered
    for (const call of errorSpy.mock.calls) expect(JSON.stringify(call)).not.toContain(HEX);
  });

  // script.js is one static file for every key: nothing from the request can
  // be written into it. The banner refuses a secret key in the browser
  // (packages/banner/src/index.test.ts).
  it("script.js: the same file whatever the key, with nothing of the key in it", async () => {
    const res = await bannerScriptRoute.fetch(
      new Request(`https://api.test/v1/banner/script.js?key=${SECRET}`),
      createTestBindings(),
    );
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(text).toBe("/* banner bundle */");
    expect(text).not.toContain(HEX);
  });

  it("a public key still works (control)", async () => {
    const { body } = await call(await seededEnv());
    expect(body.show).toBe(true);
  });
});

// ── the banner file ────────────────────────────────────────────────────────

// In a deployment these paths are static assets and never reach the Worker
// (wrangler.toml [assets]); these handlers are what answers without them.
describe("GET /v1/banner/script.js and bundle.js", () => {
  async function get(path: string) {
    const res = await bannerScriptRoute.fetch(new Request(`https://api.test${path}`), createTestBindings());
    return { status: res.status, text: await res.text(), headers: res.headers };
  }

  it("script.js is the banner itself, not a loader, cached for an hour", async () => {
    const { status, text, headers } = await get("/v1/banner/script.js?key=gpl_pk_abc123");
    expect(status).toBe(200);
    expect(text).toBe("/* banner bundle */");
    expect(headers.get("content-type")).toContain("application/javascript");
    expect(headers.get("cache-control")).toBe("public, max-age=3600");
  });

  it("bundle.js (what the old loader asked for) is the same file, cached for a day", async () => {
    const { status, text, headers } = await get("/v1/banner/bundle.js?key=gpl_pk_abc123");
    expect(status).toBe(200);
    expect(text).toBe("/* banner bundle */");
    expect(headers.get("cache-control")).toBe("public, max-age=86400");
  });

  it("the answer does not depend on the key: missing, odd or hostile keys change nothing", async () => {
    for (const query of ["", "?key=", "?key=abc%27%3Balert(1)%2F%2F", "?key=%3C%2Fscript%3E"]) {
      const { status, text } = await get(`/v1/banner/script.js${query}`);
      expect(status).toBe(200);
      expect(text).toBe("/* banner bundle */");
    }
  });
});

// ── impressions, counted by the API ────────────────────────────────────────

describe("impressions", () => {
  const DAY = expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/);

  it("an answer with an offer counts one impression of the served campaign, for the visitor's country", async () => {
    const { body } = await call(await seededEnv());
    expect(body.show).toBe(true);
    expect(state.impressions).toEqual([
      [{ organizationId: "org_1", campaignId: "camp_1", countryCode: "IN", day: DAY, count: 1 }],
    ]);
  });

  it("an answer without an offer counts none", async () => {
    await call(await seededEnv(), { query: { product: "NOPE" } }); // no_active_campaign
    await call(await seededEnv(), { country: "US" }); // no_discount
    await call(await seededEnv({ doc: bannerDocForCampaign({ allowedDomains: ["a.example"] }) })); // domain_not_allowed
    await call(await seededEnv({ usage: "over" })); // quota_exceeded
    await call(await seededEnv(), { country: "XX" }); // unknown_country
    expect(state.impressions).toEqual([]);
    expect(total()).toBe(3); // the first three are still API calls
  });

  it("a test-environment campaign's impression is counted too", async () => {
    await call(await seededEnv({ doc: bannerDocForCampaign({ environment: "test" }) }));
    expect(impressionTotal()).toBe(1);
  });

  it("during an experiment the impression goes to the arm that was served", async () => {
    const doc = bannerDocForCampaign({});
    doc.campaigns.camp_2 = cachedCampaign({});
    doc.products = {
      prod_1: { kind: "experiment", experimentId: "exp_1", campaignAId: "camp_1", campaignBId: "camp_2", trafficSplitB: 50 },
    };
    const { body } = await call(await seededEnv({ doc }), { query: { vid: "visitor_0123456789abcdef" } });
    expect(body.show).toBe(true);
    expect(state.impressions.flat()).toEqual([expect.objectContaining({ campaignId: body.campaignId, count: 1 })]);
  });

  it("an unlimited organization's impressions go out as one statement per window, one row per campaign and country", async () => {
    impressionMeter.configure({ flushDelayMs: 20 });
    usageMeter.configure({ unlimitedFlushDelayMs: 20 });
    const doc = bannerDocForCampaign({});
    doc.campaigns.camp_1!.countries.BR = { discount: 30, tier: 2, code: "PPP30", countryName: "Brazil" };
    const env = await seededEnv({ usage: "pro", doc });
    const ctxs = [createExecutionContext(), createExecutionContext(), createExecutionContext()];
    await call(env, { ctx: ctxs[0], country: "IN" });
    await call(env, { ctx: ctxs[1], country: "IN" });
    await call(env, { ctx: ctxs[2], country: "BR" });
    expect(state.impressions).toEqual([]); // nothing written on the request path
    for (const ctx of ctxs) await ctx.settle();
    expect(state.impressions).toHaveLength(1);
    expect(state.impressions[0]).toEqual([
      expect.objectContaining({ campaignId: "camp_1", countryCode: "IN", count: 2 }),
      expect.objectContaining({ campaignId: "camp_1", countryCode: "BR", count: 1 }),
    ]);
  });

  it("fails open: a failing impression write never affects the banner or the usage count, and is logged", async () => {
    state.impressionWriteError = new Error("db down");
    const { status, body } = await call(await seededEnv());
    expect(status).toBe(200);
    expect(body.show).toBe(true);
    expect(total()).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith(
      "impression-meter: write failed; counts kept for the next flush",
      expect.objectContaining({ organizationId: "org_1", count: 1 }),
    );
  });
});

// ── remembered lookups: one KV read per request on a warm isolate ──────────

describe("remembered lookups (services/banner-hot-cache.ts)", () => {
  /** The CACHE keys a request read, in order. */
  function watchReads(env: Bindings): string[] {
    const keys: string[] = [];
    const get = env.CACHE.get.bind(env.CACHE);
    env.CACHE.get = (async (key: string, ...rest: unknown[]) => (
      keys.push(key), (get as (...a: unknown[]) => unknown)(key, ...rest)
    )) as KVNamespace["get"];
    return keys;
  }
  const strip = (keys: string[]) => keys.filter((k) => k !== FX_RATES_KEY);

  beforeEach(() => {
    configureBannerHotCache({ ttlMs: BANNER_HOT_CACHE_TTL_MS });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("the first request reads the key mapping, the quota and the document; the next ones read nothing", async () => {
    const env = await seededEnv({ usage: "pro" });
    const keyHash = await sha256Hex(PUBLIC_KEY);
    const reads = watchReads(env);

    expect((await call(env)).body.show).toBe(true);
    expect(strip(reads)).toEqual([`apikey:${keyHash}`, usageKey("org_1"), `banner-config:${API_KEY_ID}`]);

    reads.length = 0;
    expect((await call(env)).body.show).toBe(true);
    expect((await call(env)).body.show).toBe(true);
    expect(strip(reads)).toEqual([]);
  });

  it("the document is read again after 15 seconds, the key and the quota after a minute", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const env = await seededEnv({ usage: "pro" });
    const keyHash = await sha256Hex(PUBLIC_KEY);
    const reads = watchReads(env);
    const start = Date.now();
    await call(env);

    reads.length = 0;
    vi.setSystemTime(start + BANNER_DOC_MEMORY_TTL_MS - 1);
    await call(env);
    expect(strip(reads)).toEqual([]);
    vi.setSystemTime(start + BANNER_DOC_MEMORY_TTL_MS);
    await call(env);
    expect(strip(reads)).toEqual([`banner-config:${API_KEY_ID}`]);

    reads.length = 0;
    vi.setSystemTime(start + BANNER_HOT_CACHE_TTL_MS);
    await call(env);
    expect(strip(reads)).toEqual([`apikey:${keyHash}`, usageKey("org_1"), `banner-config:${API_KEY_ID}`]);
  });

  it("a dashboard change shows once the 15 seconds are over, not before", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const env = await seededEnv();
    const start = Date.now();
    expect((await call(env)).body.discount).toBe(40);
    const edited = structuredClone(bannerDocForCampaign({}));
    edited.campaigns.camp_1!.countries.IN!.discount = 55;
    await env.CACHE.put(`banner-config:${API_KEY_ID}`, JSON.stringify(edited));

    vi.setSystemTime(start + BANNER_DOC_MEMORY_TTL_MS - 1);
    expect((await call(env)).body.discount).toBe(40);
    vi.setSystemTime(start + BANNER_DOC_MEMORY_TTL_MS);
    expect((await call(env)).body.discount).toBe(55);
  });

  it("with the document memory off, a change shows on the next request (the key and quota stay remembered)", async () => {
    configureBannerHotCache({ ttlMs: BANNER_HOT_CACHE_TTL_MS, docTtlMs: 0 });
    const env = await seededEnv();
    const reads = watchReads(env);
    expect((await call(env)).body.discount).toBe(40);
    const edited = structuredClone(bannerDocForCampaign({}));
    edited.campaigns.camp_1!.countries.IN!.discount = 55;
    await env.CACHE.put(`banner-config:${API_KEY_ID}`, JSON.stringify(edited));
    reads.length = 0;
    expect((await call(env)).body.discount).toBe(55);
    expect(strip(reads)).toEqual([`banner-config:${API_KEY_ID}`]);
  });

  it("the remembered document is frozen and answers every request the same", async () => {
    const env = await seededEnv();
    const first = (await call(env)).body;
    const second = (await call(env, { country: "IN" })).body;
    expect(second).toEqual(first);
    const remembered = bannerDocCache.get(`banner-config:${API_KEY_ID}`)!;
    expect(Object.isFrozen(remembered)).toBe(true);
    expect(Object.isFrozen(remembered.campaigns.camp_1!.countries.IN)).toBe(true);
    expect(Object.isFrozen(remembered.campaigns.camp_1!.banner)).toBe(true);
  });

  it("a quota that was just reached applies once the minute is over, not before", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const env = await seededEnv();
    expect((await call(env)).body.show).toBe(true);
    await env.CACHE.put(usageKey("org_1"), JSON.stringify({ count: 12_000, limit: 10_000, over: true, updatedAt: "" }));

    vi.setSystemTime(Date.now() + BANNER_HOT_CACHE_TTL_MS - 1);
    expect((await call(env)).body.show).toBe(true);
    vi.setSystemTime(Date.now() + 1);
    expect((await call(env)).body).toEqual({ show: false, reason: "quota_exceeded" });
  });

  it("a revoked key is answered for at most the same minute", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const env = await seededEnv();
    expect((await call(env)).status).toBe(200);
    // Revocation removes the mapping and the document (routes/api-keys.ts).
    await env.CACHE.delete(`apikey:${await sha256Hex(PUBLIC_KEY)}`);
    await env.CACHE.delete(`banner-config:${API_KEY_ID}`);
    state.db = createSqlRecorder([[], [], [], []]).db; // no campaigns, then no key row

    vi.setSystemTime(Date.now() + BANNER_HOT_CACHE_TTL_MS);
    expect((await call(env)).status).toBe(401);
  });

  it("an unknown key is never remembered as valid", async () => {
    state.db = createSqlRecorder([[]]).db;
    const env = await seededEnv({ keyInKv: false });
    expect((await call(env)).status).toBe(401);
    expect((await call(env)).status).toBe(401);
  });

  it("a key resolved through Postgres is remembered like one from KV", async () => {
    const r = createSqlRecorder([[{ id: API_KEY_ID, organizationId: "org_1", keyType: "public" }]]);
    state.db = r.db;
    const env = await seededEnv({ keyInKv: false });
    expect((await call(env)).body.show).toBe(true);
    const lookups = r.queries.filter((q) => /from "api_keys"/.test(q.sql)).length;
    // The KV backfill is mocked out with the rebuild; memory alone answers now.
    await env.CACHE.delete(`apikey:${await sha256Hex(PUBLIC_KEY)}`);
    expect((await call(env)).body.show).toBe(true);
    expect(r.queries.filter((q) => /from "api_keys"/.test(q.sql)).length).toBe(lookups);
  });
});

// ── Holiday deals ──────────────────────────────────────────────────────────

describe("holiday deals", () => {
  const NOW = Date.parse("2026-11-27T12:00:00Z");
  const HOUR = 3_600_000;

  const deal = (overrides: Partial<CachedDeal> = {}): CachedDeal => ({
    id: "deal_1",
    name: "Black Friday",
    discount: 50,
    code: "BLACKFRIDAY50K7QX",
    startsAt: NOW - HOUR,
    endsAt: Date.parse("2026-12-01T00:00:00Z"),
    message: "{{deal}}: {{discount}}% off with code {{code}}. Ends {{ends}}.",
    ...overrides,
  });

  /** A request at `at` against a document with these deals (India: 40% with PPP40). */
  async function at(time: number, deals: CachedDeal[], opts: CallOptions = {}, seed: Seed = {}) {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(time);
      const r = createSqlRecorder();
      state.db = r.db;
      const env = await seededEnv({ doc: bannerDocForCampaign({ deals }), ...seed });
      const { body } = await call(env, opts);
      return { body, queries: r.queries };
    } finally {
      vi.useRealTimers();
    }
  }

  it("a running deal larger than the country's discount is offered in its place, without touching Postgres", async () => {
    const { body, queries } = await at(NOW, [deal()]);
    expect(body).toMatchObject({
      show: true,
      country: "IN",
      countryName: "India",
      discount: 50,
      code: "BLACKFRIDAY50K7QX",
      campaignId: "camp_1",
      deal: { id: "deal_1", name: "Black Friday", endsAt: "2026-12-01T00:00:00.000Z" },
    });
    // The campaign's banner, with the deal's message (its name and last day
    // filled in; the rest is left for the banner script) and without the flag.
    expect(body.banner).toEqual({
      ...TEST_BANNER,
      messageTemplate: "Black Friday: {{discount}}% off with code {{code}}. Ends 30 November.",
      showFlag: false,
    });
    expect(queries).toHaveLength(0);
  });

  it("a visitor whose country has no discount is offered the deal", async () => {
    const { body } = await at(NOW, [deal({ discount: 10 })], { country: "US" });
    expect(body).toMatchObject({ show: true, country: "US", countryName: "United States", discount: 10, deal: { id: "deal_1" } });
  });

  it("a smaller deal leaves the country's discount alone", async () => {
    const { body } = await at(NOW, [deal({ discount: 30 })]);
    expect(body).toMatchObject({ show: true, discount: 40, code: "PPP40", banner: TEST_BANNER });
    expect(body).not.toHaveProperty("deal");
  });

  it("on a tie the deal is offered", async () => {
    const { body } = await at(NOW, [deal({ discount: 40 })]);
    expect(body).toMatchObject({ discount: 40, code: "BLACKFRIDAY50K7QX", deal: { id: "deal_1" } });
  });

  it("a deal is offered from its start up to, not including, its end, by the clock of the request", async () => {
    const d = deal({ startsAt: NOW, endsAt: NOW + HOUR });
    expect((await at(NOW - 1, [d])).body).toMatchObject({ discount: 40, code: "PPP40" });
    expect((await at(NOW, [d])).body).toMatchObject({ discount: 50, deal: { id: "deal_1" } });
    expect((await at(NOW + HOUR - 1, [d])).body).toMatchObject({ discount: 50, deal: { id: "deal_1" } });
    // The stored document still lists the deal; it is not offered any more.
    const after = await at(NOW + HOUR, [d]);
    expect(after.body).toMatchObject({ discount: 40, code: "PPP40" });
    expect(after.body).not.toHaveProperty("deal");
    expect((await at(NOW + HOUR, [d], { country: "US" })).body).toEqual({ show: false, reason: "no_discount" });
  });

  it("of several running deals the largest is offered", async () => {
    const { body } = await at(NOW, [
      deal({ id: "small", discount: 45, code: "SMALL" }),
      deal({ id: "big", discount: 60, code: "BIG" }),
      deal({ id: "later", discount: 90, code: "LATER", startsAt: NOW + HOUR }),
    ]);
    expect(body).toMatchObject({ discount: 60, code: "BIG", deal: { id: "big" } });
  });

  it("a deal without a code answers with code null", async () => {
    const { body } = await at(NOW, [deal({ code: null, message: "{{deal}}: {{discount}}% off. Ends {{ends}}." })]);
    expect(body).toMatchObject({ show: true, discount: 50, code: null });
    expect((body.banner as BannerConfig).messageTemplate).toBe("Black Friday: {{discount}}% off. Ends 30 November.");
  });

  it("prices are computed from the deal's percentage", async () => {
    // TEST_PRICING: a $19 product. Without exchange rates the price stays in USD.
    const { body } = await at(NOW, [deal()], { country: "US" });
    expect(body).toMatchObject({ localOriginalPrice: 19, localPrice: 9.5, currencyCode: "USD" });
  });

  it("a deal's impression is counted on its campaign and the visitor's country", async () => {
    const { body } = await at(NOW, [deal()], { country: "US" });
    expect(body.deal).toBeDefined();
    expect(state.impressions.flat()).toEqual([
      expect.objectContaining({ campaignId: "camp_1", countryCode: "US", count: 1 }),
    ]);
  });

  it("the checks that come first still apply: quota and allowed domains", async () => {
    expect((await at(NOW, [deal()], {}, { usage: "over" })).body).toEqual({ show: false, reason: "quota_exceeded" });
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(NOW);
      const env = await seededEnv({ doc: bannerDocForCampaign({ deals: [deal()], allowedDomains: ["shop.example"] }) });
      expect((await call(env)).body).toEqual({ show: false, reason: "domain_not_allowed" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("a larger deal is offered without resolving a provider-backed country's code", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(NOW);
      const r = createSqlRecorder();
      state.db = r.db;
      const doc = bannerDocForCampaign({
        deals: [deal()],
        countries: { IN: { discount: 40, tier: 3, code: null, countryName: "India", resolve: true } },
      });
      const { body } = await call(await seededEnv({ doc }));
      expect(body).toMatchObject({ discount: 50, code: "BLACKFRIDAY50K7QX", deal: { id: "deal_1" } });
      // No lookup of the country's code: nothing read from Postgres.
      expect(r.queries).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
