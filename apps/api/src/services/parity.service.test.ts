import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";
import { createSqlRecorder } from "../lib/sql-recorder-test-helpers";
import { createTestBindings } from "../test/helpers";
import { ProviderAuthError, ProviderError } from "./providers";

// Unit tests for the coupon step of getDiscountForCountry. getOrCreateCoupon
// (the provider round trip) is faked; the stored-coupon fallback runs for real
// against canned rows. Query order for a group-mode campaign with an
// integration: campaign, parity group, integration, [stored coupons].

const fake = vi.hoisted(() => ({ getOrCreate: null as unknown as Mock }));

vi.mock("./coupon.service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./coupon.service")>();
  return { ...actual, getOrCreateCoupon: (...args: unknown[]) => fake.getOrCreate(...args) };
});

const {
  getDiscountForCountry,
  computeCountryDiscount,
  pickCountryGroups,
  discountCacheKey,
  discountEpochKey,
  DISCOUNT_CACHE_TTL_SECONDS,
  DISCOUNT_FAILURE_TTL_SECONDS,
} = await import("./parity.service");

/** KV fake that remembers each put's TTL. */
function recordingKV() {
  const store = new Map<string, string>();
  const puts: Array<{ key: string; value: unknown; ttl?: number }> = [];
  const kv = {
    get: async (key: string) => store.get(key) ?? null,
    put: async (key: string, value: string, opts?: { expirationTtl?: number }) => {
      store.set(key, value);
      puts.push({ key, value: JSON.parse(value), ttl: opts?.expirationTtl });
    },
    delete: async (key: string) => {
      store.delete(key);
    },
  } as unknown as KVNamespace;
  return { kv, store, puts };
}

const ORG = "org_1";
const CAMPAIGN_ID = "cmp_1";
// No discount-cache epoch stored yet: the default epoch "0".
const CACHE_KEY = discountCacheKey("0", CAMPAIGN_ID, "IN");

/** The recorded UPDATE of integrations.health, if any. */
const healthUpdate = (queries: Array<{ sql: string; params: unknown[] }>) =>
  queries.find((q) => q.sql.startsWith('update "integrations" set "health"'));

const campaignRow = {
  id: CAMPAIGN_ID,
  organizationId: ORG,
  productId: "prd_1",
  integrationId: "int_1",
  name: "PPP",
  environment: "live",
  status: "active",
  pricingMode: "group",
  discountDelivery: "banner_coupon",
  charmPricingStrategy: "none",
  maxDiscountPercent: 70,
  discountOverrides: null,
  couponPrefix: null,
  allowedDomains: null,
  createdAt: new Date(),
};
// The parity-group query's row for a country mapped to a group (a null
// countryCode would mean "the workspace has groups, none with this country").
const groupRow = { discountPercent: 40, sortOrder: 2, countryCode: "IN" };
const integrationRow = {
  id: "int_1",
  organizationId: ORG,
  provider: "stripe",
  liveAccessTokenEnc: "enc",
  testAccessTokenEnc: null,
  providerAccountId: null,
  status: "active",
};

function storedCoupon(overrides: Record<string, unknown> = {}) {
  return {
    id: "cpn_1",
    campaignId: CAMPAIGN_ID,
    integrationId: "int_1",
    countryCode: "IN",
    environment: "live",
    code: "PPP-IN40-AAAA",
    discountPercent: 40,
    providerCouponId: "disc_1",
    providerPromoCodeId: null,
    status: "active",
    createdAt: new Date(),
    ...overrides,
  };
}

const env = createTestBindings();
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  fake.getOrCreate = vi.fn(async () => storedCoupon({ code: "PPP-IN40-FRESH" }));
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("getDiscountForCountry: provider-backed codes", () => {
  it("returns the provider's code for exactly this percent and caches it for an hour", async () => {
    const { kv, puts } = recordingKV();
    const r = createSqlRecorder([[campaignRow], [groupRow], [integrationRow]]);

    const out = await getDiscountForCountry(r.db, env, ORG, CAMPAIGN_ID, "IN", kv);

    expect(out).toEqual({ discount: 40, tier: 2, code: "PPP-IN40-FRESH" });
    expect(fake.getOrCreate.mock.calls[0]![5]).toBe(40);
    expect(puts).toEqual([{ key: CACHE_KEY, value: out, ttl: DISCOUNT_CACHE_TTL_SECONDS }]);
  });

  it("shows nothing (null) when the provider fails and only a different-percent code is stored", async () => {
    // Old behavior: fell back to ANY active coupon for the country, so the banner
    // advertised 40% next to a code that gives 30%.
    fake.getOrCreate.mockRejectedValueOnce(new ProviderError("stripe", "createDiscount", "rate limited", 429));
    const { kv, puts } = recordingKV();
    const r = createSqlRecorder([
      [campaignRow],
      [groupRow],
      [integrationRow],
      [], // UPDATE integrations.health (the failure is recorded)
      [storedCoupon({ discountPercent: 30, code: "PPP-IN30-OLD" })],
    ]);

    const out = await getDiscountForCountry(r.db, env, ORG, CAMPAIGN_ID, "IN", kv);

    expect(out).toBeNull();
    const cached = puts.find((p) => p.key === CACHE_KEY)!;
    expect(cached.ttl).toBe(DISCOUNT_FAILURE_TTL_SECONDS);
    expect(cached.value).toMatchObject({ code: null, codeUnavailable: true });
  });

  it("serves the short-lived 'no code' marker from cache as null", async () => {
    const { kv, store } = recordingKV();
    store.set(CACHE_KEY, JSON.stringify({ discount: 40, tier: 2, code: null, codeUnavailable: true }));
    const r = createSqlRecorder([]);

    expect(await getDiscountForCountry(r.db, env, ORG, CAMPAIGN_ID, "IN", kv)).toBeNull();
    expect(r.queries).toHaveLength(0);
  });

  it("falls back to a stored code for the same integration, environment and percent, cached briefly", async () => {
    fake.getOrCreate.mockRejectedValueOnce(new ProviderError("stripe", "createDiscount", "upstream 502", 502));
    const { kv, puts } = recordingKV();
    const r = createSqlRecorder([
      [campaignRow],
      [groupRow],
      [integrationRow],
      [], // UPDATE integrations.health (the failure is recorded)
      [
        storedCoupon({ code: "PPP-IN40-TEST", environment: "test" }),
        storedCoupon({ code: "PPP-IN40-OTHERINT", integrationId: "int_old" }),
        storedCoupon({ code: "PPP-IN40-GOOD" }),
      ],
    ]);

    const out = await getDiscountForCountry(r.db, env, ORG, CAMPAIGN_ID, "IN", kv);

    expect(out).toEqual({ discount: 40, tier: 2, code: "PPP-IN40-GOOD" });
    expect(puts.find((p) => p.key === CACHE_KEY)!.ttl).toBe(DISCOUNT_FAILURE_TTL_SECONDS);
  });

  it("logs the failure and records it on the integration's health", async () => {
    fake.getOrCreate.mockRejectedValueOnce(new ProviderError("stripe", "createDiscount", "upstream 502", 502));
    const { kv, store } = recordingKV();
    const r = createSqlRecorder([[campaignRow], [groupRow], [integrationRow], []]);

    await getDiscountForCountry(r.db, env, ORG, CAMPAIGN_ID, "IN", kv);

    expect(errorSpy).toHaveBeenCalledOnce();
    const logged = String(errorSpy.mock.calls[0]![0]);
    expect(logged).toContain(`org=${ORG}`);
    expect(logged).toContain(`campaign=${CAMPAIGN_ID}`);
    expect(logged).toContain("country=IN");
    expect(logged).toContain("provider=stripe");
    // Recorded on the integration row (integrations.health), not in KV.
    expect(store.size).toBe(1); // only the failure marker
    const update = healthUpdate(r.queries)!;
    expect(update).toBeDefined();
    const stored = JSON.parse(update.params.find((p) => typeof p === "string" && p.startsWith("{")) as string);
    expect(stored).toMatchObject({ area: "coupon_sync", environment: "live" });
    expect(stored.message).toContain("40%");
    expect(stored.message).toContain("upstream 502");
  });

  it("files a rejected key under credentials", async () => {
    fake.getOrCreate.mockRejectedValueOnce(
      Object.assign(new Error("[stripe] auth: Invalid API key"), {
        code: "PROVIDER_ERROR",
        providerError: new ProviderAuthError("stripe", "Invalid API key"),
      }),
    );
    const { kv } = recordingKV();
    const r = createSqlRecorder([[campaignRow], [groupRow], [integrationRow], []]);

    await getDiscountForCountry(r.db, env, ORG, CAMPAIGN_ID, "IN", kv);

    const update = healthUpdate(r.queries)!;
    expect(update.params).toContain("credentials");
    expect(update.params).not.toContain("coupon_sync");
  });

  it("clears a recorded coupon_sync issue once a code is created again", async () => {
    const { kv } = recordingKV();
    const unhealthy = {
      ...integrationRow,
      health: { coupon_sync: { area: "coupon_sync", message: "old", at: new Date().toISOString() } },
    };
    const r = createSqlRecorder([[campaignRow], [groupRow], [unhealthy], []]);

    await getDiscountForCountry(r.db, env, ORG, CAMPAIGN_ID, "IN", kv);

    const update = healthUpdate(r.queries)!;
    expect(update.sql).toContain('"health" = "integrations"."health" - $1');
    expect(update.params[0]).toBe("coupon_sync");
  });

  it("a healthy integration costs no health query on success", async () => {
    const { kv } = recordingKV();
    const r = createSqlRecorder([[campaignRow], [groupRow], [integrationRow]]);
    await getDiscountForCountry(r.db, env, ORG, CAMPAIGN_ID, "IN", kv);
    expect(healthUpdate(r.queries)).toBeUndefined();
  });

  it("does not call the provider for a disabled integration, and shows nothing without a matching stored code", async () => {
    const { kv } = recordingKV();
    const r = createSqlRecorder([[campaignRow], [groupRow], [{ ...integrationRow, status: "disabled" }], []]);

    const out = await getDiscountForCountry(r.db, env, ORG, CAMPAIGN_ID, "IN", kv);

    expect(out).toBeNull();
    expect(fake.getOrCreate).not.toHaveBeenCalled();
  });

  it("returns the discount without a code for a campaign with no integration", async () => {
    const { kv, puts } = recordingKV();
    const r = createSqlRecorder([[{ ...campaignRow, integrationId: null }], [groupRow]]);

    const out = await getDiscountForCountry(r.db, env, ORG, CAMPAIGN_ID, "IN", kv);

    expect(out).toEqual({ discount: 40, tier: 2, code: null });
    expect(puts[0]!.ttl).toBe(DISCOUNT_CACHE_TTL_SECONDS);
    expect(r.queries).toHaveLength(2);
  });
});

describe("discount cache epoch (invalidated by every banner rebuild)", () => {
  it("uses the epoch the caller passes, without reading KV for it", async () => {
    const { kv, puts } = recordingKV();
    const get = vi.spyOn(kv, "get");
    const r = createSqlRecorder([[{ ...campaignRow, integrationId: null }], [groupRow]]);

    await getDiscountForCountry(r.db, env, ORG, CAMPAIGN_ID, "IN", kv, "EPOCH7");

    expect(get).not.toHaveBeenCalledWith(discountEpochKey(ORG));
    expect(puts.map((p) => p.key)).toEqual([discountCacheKey("EPOCH7", CAMPAIGN_ID, "IN")]);
  });

  it("reads the organization's current epoch otherwise, so an entry from before a rebuild is never served", async () => {
    const { kv, store } = recordingKV();
    // Cached under the old epoch: 30% (the campaign has since changed to 40%).
    store.set(discountCacheKey("OLD", CAMPAIGN_ID, "IN"), JSON.stringify({ discount: 30, tier: 2, code: null }));
    store.set(discountEpochKey(ORG), "NEW");
    const r = createSqlRecorder([[{ ...campaignRow, integrationId: null }], [groupRow]]);

    const out = await getDiscountForCountry(r.db, env, ORG, CAMPAIGN_ID, "IN", kv);

    expect(out).toEqual({ discount: 40, tier: 2, code: null });
    expect(store.has(discountCacheKey("NEW", CAMPAIGN_ID, "IN"))).toBe(true);
  });

  it("a failing cache write does not fail the request", async () => {
    const { kv } = recordingKV();
    vi.spyOn(kv, "put").mockRejectedValue(new Error("KV PUT failed: 429"));
    const r = createSqlRecorder([[{ ...campaignRow, integrationId: null }], [groupRow]]);
    expect(await getDiscountForCountry(r.db, env, ORG, CAMPAIGN_ID, "IN", kv)).toEqual({
      discount: 40,
      tier: 2,
      code: null,
    });
    expect(errorSpy).toHaveBeenCalledWith("parity: discount cache write failed", expect.anything());
  });
});

describe("computeCountryDiscount (shared by the KV builder and the database path)", () => {
  const group = { discountPercent: 50, sortOrder: 3 };

  it("group mode: the group's percent capped at the campaign max", () => {
    expect(computeCountryDiscount({ pricingMode: "group", maxDiscountPercent: 40, discountOverrides: null }, "IN", group)).toEqual({ discount: 40, tier: 3 });
    expect(computeCountryDiscount({ pricingMode: "group", maxDiscountPercent: 40, discountOverrides: null }, "IN", null)).toEqual({ discount: 0, tier: 0 });
  });

  it("custom mode: an override wins; without one (or without any overrides) the group applies", () => {
    const custom = { pricingMode: "custom", maxDiscountPercent: 70, discountOverrides: { IN: 25 } };
    expect(computeCountryDiscount(custom, "IN", group)).toEqual({ discount: 25, tier: 2 });
    expect(computeCountryDiscount(custom, "BR", group)).toEqual({ discount: 50, tier: 3 });
    // Before: custom with null overrides gave 0 on the database path but the
    // group's percent on the KV path.
    expect(computeCountryDiscount({ ...custom, discountOverrides: null }, "BR", group)).toEqual({ discount: 50, tier: 3 });
  });

  it("ppp_factor: from the multiplier table, no group needed", () => {
    const out = computeCountryDiscount({ pricingMode: "ppp_factor", maxDiscountPercent: 70, discountOverrides: null }, "IN", null);
    expect(out.discount).toBeGreaterThan(0);
    expect(out.tier).toBeGreaterThan(0);
  });

  it("a custom campaign with null overrides now reads the parity group on the database path", async () => {
    const { kv } = recordingKV();
    const r = createSqlRecorder([
      [{ ...campaignRow, integrationId: null, pricingMode: "custom", discountOverrides: null }],
      [groupRow],
    ]);
    expect(await getDiscountForCountry(r.db, env, ORG, CAMPAIGN_ID, "IN", kv)).toEqual({ discount: 40, tier: 2, code: null });
  });
});

describe("pickCountryGroups", () => {
  it("a country in several groups resolves to the lowest sort order, then the lowest group id", () => {
    const map = pickCountryGroups([
      { countryCode: "IN", groupId: "G2", discountPercent: 30, sortOrder: 2 },
      { countryCode: "IN", groupId: "G1", discountPercent: 50, sortOrder: 1 },
      { countryCode: "BR", groupId: "G9", discountPercent: 20, sortOrder: 4 },
      { countryCode: "BR", groupId: "G3", discountPercent: 25, sortOrder: 4 },
    ]);
    expect(map.get("IN")).toEqual({ discountPercent: 50, sortOrder: 1 });
    expect(map.get("BR")).toEqual({ discountPercent: 25, sortOrder: 4 });
  });
});
