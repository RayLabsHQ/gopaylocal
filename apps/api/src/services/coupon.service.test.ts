import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";
import { createSqlRecorder, type SqlRecorder } from "../lib/sql-recorder-test-helpers";
import { createTestBindings } from "../test/helpers";
import { ProviderAuthError, ProviderError, type ProviderConfig } from "./providers";

// Unit tests for coupon.service with a fake provider factory and the SQL
// recorder (real Drizzle statements, canned rows in order). They pin the
// invariants the banner relies on: a code is created and deleted with the key
// of the environment it lives in, a (campaign, country) converges on one
// displayable coupon, and failures never leave a stale code on display.

type FakeProvider = {
  createDiscount: Mock;
  deleteDiscount: Mock;
  listDiscounts: Mock;
};

const fake = vi.hoisted(() => ({
  create: null as unknown as Mock,
}));

vi.mock("./providers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./providers")>();
  return { ...actual, createProvider: (...args: unknown[]) => fake.create(...args) };
});

vi.mock("../lib/crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/crypto")>();
  return { ...actual, decrypt: async (v: string) => `key:${v}`, tokenEncryptionSecret: () => "secret" };
});

const {
  createCouponForCountry,
  deleteCoupon,
  findDisplayableCoupon,
  getOrCreateCoupon,
  isDisplayableCoupon,
  isProviderAuthFailure,
  syncProviderCoupons,
} = await import("./coupon.service");

const env = createTestBindings();

function makeProvider(): FakeProvider {
  return {
    createDiscount: vi.fn(async (p: { code: string }) => ({
      providerDiscountId: "disc_new",
      code: p.code,
      providerPromoCodeId: null,
    })),
    deleteDiscount: vi.fn(async () => {}),
    listDiscounts: vi.fn(async () => []),
  };
}

let providers: Record<string, Record<"live" | "test", FakeProvider>>;
let configs: Array<{ provider: string; config: ProviderConfig }>;

function integration(overrides: Record<string, unknown> = {}) {
  return {
    id: "int_1",
    organizationId: "org_1",
    provider: "stripe",
    liveAccessTokenEnc: "live-enc",
    liveRefreshTokenEnc: null,
    testAccessTokenEnc: "test-enc",
    testRefreshTokenEnc: null,
    providerAccountId: null,
    webhookEndpointId: null,
    webhookSecretEnc: null,
    status: "active",
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as never;
}

function campaign(overrides: Record<string, unknown> = {}) {
  return {
    id: "cmp_1",
    organizationId: "org_1",
    productId: "prd_1",
    integrationId: "int_1",
    name: "PPP",
    environment: "test",
    status: "active",
    pricingMode: "group",
    discountDelivery: "banner_coupon",
    charmPricingStrategy: "none",
    maxDiscountPercent: 70,
    discountOverrides: null,
    couponPrefix: null,
    allowedDomains: null,
    createdAt: new Date(),
    ...overrides,
  } as never;
}

function coupon(overrides: Record<string, unknown> = {}) {
  return {
    id: "cpn_old",
    campaignId: "cmp_1",
    integrationId: "int_1",
    parityGroupId: null,
    countryCode: "IN",
    environment: "test" as "live" | "test",
    code: "PPP-IN40-OLD1",
    discountPercent: 40,
    providerCouponId: "disc_old",
    providerPromoCodeId: null,
    status: "active",
    expiresAt: null,
    createdAt: new Date(),
    ...overrides,
  };
}

const NEW_ROW = coupon({ id: "cpn_new", code: "PPP-IN40-NEW1", providerCouponId: "disc_new" });

let r: SqlRecorder;

beforeEach(() => {
  providers = {};
  configs = [];
  fake.create = vi.fn((provider: string, config: ProviderConfig) => {
    configs.push({ provider, config });
    providers[provider] ??= { live: makeProvider(), test: makeProvider() };
    return providers[provider]![config.environment ?? "live"];
  });
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

function provider(name = "stripe", e: "live" | "test" = "test"): FakeProvider {
  providers[name] ??= { live: makeProvider(), test: makeProvider() };
  return providers[name]![e];
}

describe("createCouponForCountry", () => {
  it("creates a test campaign's coupon with the test key and records environment=test", async () => {
    // reconcile lookup, code-collision check, insert
    r = createSqlRecorder([[], [], [NEW_ROW]]);

    await createCouponForCountry(r.db, env, campaign(), integration(), "IN", 40);

    expect(configs).toEqual([
      { provider: "stripe", config: expect.objectContaining({ apiKey: "key:test-enc", environment: "test" }) },
    ]);
    const insert = r.queries.find((q) => q.sql.startsWith('insert into "coupons"'))!;
    expect(insert.params).toContain("test");
    expect(insert.params).not.toContain("live");
  });

  it("is idempotent: an existing coupon for the same integration, environment and percent is reused", async () => {
    // Re-activating a campaign used to mint a second set of provider discounts.
    const existing = coupon();
    r = createSqlRecorder([[existing]]);

    const out = await createCouponForCountry(r.db, env, campaign(), integration(), "IN", 40);

    expect(out).toBe(existing);
    expect(fake.create).not.toHaveBeenCalled();
    expect(r.queries).toHaveLength(1);
  });

  it("surfaces a provider constructor failure as PROVIDER_ERROR", async () => {
    fake.create = vi.fn(() => {
      throw new ProviderError("chargebee", "init", "Invalid Chargebee site");
    });
    r = createSqlRecorder([[], []]);

    await expect(
      createCouponForCountry(r.db, env, campaign(), integration({ provider: "chargebee" }), "IN", 40),
    ).rejects.toMatchObject({ code: "PROVIDER_ERROR" });
  });

  it("keeps the provider error so callers can tell a rejected key apart", async () => {
    provider("stripe", "test").createDiscount.mockRejectedValueOnce(new ProviderAuthError("stripe", "Invalid API key"));
    r = createSqlRecorder([[], []]);

    const err = await createCouponForCountry(r.db, env, campaign(), integration(), "IN", 40).catch((e: unknown) => e);

    expect(err).toMatchObject({ code: "PROVIDER_ERROR" });
    expect(isProviderAuthFailure(err)).toBe(true);
    expect(isProviderAuthFailure(new Error("boom"))).toBe(false);
  });

  it("deletes the new provider discount when the database insert fails", async () => {
    r = createSqlRecorder([[], [], new Error("duplicate key value violates unique constraint")]);

    await expect(createCouponForCountry(r.db, env, campaign(), integration(), "IN", 40)).rejects.toThrow(
      "duplicate key",
    );
    expect(provider("stripe", "test").deleteDiscount).toHaveBeenCalledWith("disc_new");
  });
});

describe("createCouponForCountry: concurrent first creation", () => {
  // Shape of the error postgres-js raises for the partial unique index,
  // wrapped by drizzle (DrizzleQueryError: query + cause).
  const raceError = () =>
    Object.assign(new Error('Failed query: insert into "coupons" ...'), {
      query: 'insert into "coupons" ...',
      cause: Object.assign(new Error('duplicate key value violates unique constraint "coupons_one_active_per_country_idx"'), {
        code: "23505",
        constraint_name: "coupons_one_active_per_country_idx",
      }),
    });

  it("undoes its own provider discount and returns the winner's row when it loses the race", async () => {
    const winner = coupon({ id: "cpn_winner", code: "PPP-IN40-WIN1", providerCouponId: "disc_winner" });
    // reconcile select → code check → insert (race) → findDisplayableCoupon select
    r = createSqlRecorder([[], [], raceError(), [winner]]);

    const result = await createCouponForCountry(r.db, env, campaign(), integration(), "IN", 40);

    expect(result.id).toBe("cpn_winner");
    expect(provider("stripe", "test").deleteDiscount).toHaveBeenCalledWith("disc_new");
  });

  it("still throws when the row that won is not displayable for this campaign", async () => {
    const other = coupon({ id: "cpn_other", discountPercent: 55 });
    r = createSqlRecorder([[], [], raceError(), [other]]);
    await expect(createCouponForCountry(r.db, env, campaign(), integration(), "IN", 40)).rejects.toThrow("Failed query");
  });

  it("does not treat other unique violations (the code itself) as a lost race", async () => {
    const codeClash = raceError();
    (codeClash.cause as { constraint_name: string }).constraint_name = "coupons_code_unique";
    r = createSqlRecorder([[], [], codeClash]);
    await expect(createCouponForCountry(r.db, env, campaign(), integration(), "IN", 40)).rejects.toThrow("Failed query");
    expect(r.queries).toHaveLength(3); // no follow-up lookup
  });
});

describe("getOrCreateCoupon", () => {
  it("treats a float4-rounded percent as the same percent (no delete/re-create churn)", async () => {
    // coupons.discount_percent is `real`: 33.3 comes back as 33.29999923706055.
    const existing = coupon({ discountPercent: Math.fround(33.3) });
    r = createSqlRecorder([[existing]]);

    const out = await getOrCreateCoupon(r.db, env, campaign(), integration(), "IN", 33.3);

    expect(out).toBe(existing);
    expect(fake.create).not.toHaveBeenCalled();
  });

  it("does not reuse a coupon from the other environment: retires it with ITS key and creates one with the campaign's", async () => {
    // Campaign switched to test; the stored code is a live one.
    const stale = coupon({ environment: "live" });
    r = createSqlRecorder([[stale], [integration()], [], [], [NEW_ROW]]);

    const out = await getOrCreateCoupon(r.db, env, campaign({ environment: "test" }), integration(), "IN", 40);

    expect(out).toBe(NEW_ROW);
    expect(provider("stripe", "live").deleteDiscount).toHaveBeenCalledWith("disc_old");
    expect(provider("stripe", "test").createDiscount).toHaveBeenCalledOnce();
    expect(configs.map((c) => c.config.environment)).toEqual(["live", "test"]);
  });

  it("deletes a superseded test coupon with the TEST key, not the live one", async () => {
    const stale = coupon({ discountPercent: 30 });
    r = createSqlRecorder([[stale], [integration()], [], [], [NEW_ROW]]);

    await getOrCreateCoupon(r.db, env, campaign(), integration(), "IN", 40);

    expect(provider("stripe", "test").deleteDiscount).toHaveBeenCalledWith("disc_old");
    expect(provider("stripe", "live").deleteDiscount).not.toHaveBeenCalled();
    expect(r.queries.some((q) => q.sql === 'delete from "coupons" where "coupons"."id" = $1')).toBe(true);
  });

  it("deletes a coupon left by a previous integration at THAT integration's provider", async () => {
    const stale = coupon({ integrationId: "int_old" });
    const oldIntegration = integration({ id: "int_old", provider: "paddle" });
    r = createSqlRecorder([[stale], [oldIntegration], [], [], [NEW_ROW]]);

    await getOrCreateCoupon(r.db, env, campaign(), integration(), "IN", 40);

    expect(provider("paddle", "test").deleteDiscount).toHaveBeenCalledWith("disc_old");
    expect(provider("stripe", "test").deleteDiscount).not.toHaveBeenCalled();
  });

  it("parks the old coupon as retiring when the provider refuses the delete, and still returns a fresh code", async () => {
    provider("stripe", "test").deleteDiscount.mockRejectedValueOnce(
      new ProviderError("stripe", "deleteDiscount", "upstream error", 500),
    );
    const stale = coupon({ discountPercent: 30 });
    r = createSqlRecorder([[stale], [integration()], [], [], [NEW_ROW]]);

    const out = await getOrCreateCoupon(r.db, env, campaign(), integration(), "IN", 40);

    expect(out).toBe(NEW_ROW);
    const park = r.queries.find((q) => q.sql.startsWith('update "coupons" set "status"'))!;
    expect(park.params).toEqual(["retiring", "cpn_old"]);
    expect(r.queries.some((q) => q.sql.startsWith('delete from "coupons"'))).toBe(false);
  });

  it("never hands back a retiring row, even with the right percent", async () => {
    const parked = coupon({ status: "retiring" });
    r = createSqlRecorder([[parked], [integration()], [], [], [NEW_ROW]]);

    const out = await getOrCreateCoupon(r.db, env, campaign(), integration(), "IN", 40);

    expect(out).toBe(NEW_ROW);
    expect(provider("stripe", "test").deleteDiscount).toHaveBeenCalledWith("disc_old");
  });
});

describe("deleteCoupon", () => {
  it("uses the coupon's own environment by default", async () => {
    r = createSqlRecorder([[coupon({ environment: "test" })], []]);

    await deleteCoupon(r.db, env, "cpn_old", integration());

    expect(provider("stripe", "test").deleteDiscount).toHaveBeenCalledWith("disc_old");
    expect(provider("stripe", "live").deleteDiscount).not.toHaveBeenCalled();
  });

  it("retries a legacy row (recorded live) in test when live answers 404", async () => {
    provider("stripe", "live").deleteDiscount.mockRejectedValueOnce(
      new ProviderError("stripe", "deleteDiscount", "No such coupon", 404),
    );
    r = createSqlRecorder([[coupon({ environment: "live" })], []]);

    await deleteCoupon(r.db, env, "cpn_old", integration());

    expect(provider("stripe", "test").deleteDiscount).toHaveBeenCalledWith("disc_old");
    expect(r.queries[1]!.sql).toBe('delete from "coupons" where "coupons"."id" = $1');
  });

  it("keeps the row and throws PROVIDER_ERROR when the provider refuses", async () => {
    provider("stripe", "test").deleteDiscount.mockRejectedValueOnce(
      new ProviderError("stripe", "deleteDiscount", "upstream error", 500),
    );
    r = createSqlRecorder([[coupon()]]);

    await expect(deleteCoupon(r.db, env, "cpn_old", integration())).rejects.toMatchObject({ code: "PROVIDER_ERROR" });
    expect(r.queries).toHaveLength(1);
  });

  it("gives up quietly on the fallback environment when its key is rejected", async () => {
    provider("stripe", "live").deleteDiscount.mockRejectedValueOnce(
      new ProviderError("stripe", "deleteDiscount", "No such coupon", 404),
    );
    provider("stripe", "test").deleteDiscount.mockRejectedValueOnce(new ProviderAuthError("stripe", "expired key"));
    r = createSqlRecorder([[coupon({ environment: "live" })], []]);

    await deleteCoupon(r.db, env, "cpn_old", integration());

    expect(r.queries[1]!.sql).toBe('delete from "coupons" where "coupons"."id" = $1');
  });
});

describe("findDisplayableCoupon / isDisplayableCoupon", () => {
  const expected = { integrationId: "int_1", environment: "test" as const, discountPercent: 40 };

  it("accepts only an active row with the same integration, environment and percent", () => {
    expect(isDisplayableCoupon(coupon(), expected)).toBe(true);
    expect(isDisplayableCoupon(coupon({ discountPercent: Math.fround(40) }), expected)).toBe(true);
    expect(isDisplayableCoupon(coupon({ discountPercent: 30 }), expected)).toBe(false);
    expect(isDisplayableCoupon(coupon({ environment: "live" }), expected)).toBe(false);
    expect(isDisplayableCoupon(coupon({ integrationId: "int_old" }), expected)).toBe(false);
    expect(isDisplayableCoupon(coupon({ status: "retiring" }), expected)).toBe(false);
    expect(isDisplayableCoupon(coupon(), { ...expected, integrationId: null })).toBe(false);
  });

  it("picks the displayable row out of stale ones", async () => {
    const right = coupon({ id: "cpn_right" });
    r = createSqlRecorder([
      [coupon({ discountPercent: 30 }), coupon({ environment: "live" }), coupon({ integrationId: "int_old" }), right],
    ]);

    const out = await findDisplayableCoupon(r.db, campaign(), "IN", 40);

    expect(out).toBe(right);
  });

  it("returns nothing (and does not query) for a campaign without an integration", async () => {
    r = createSqlRecorder([]);
    expect(await findDisplayableCoupon(r.db, campaign({ integrationId: null }), "IN", 40)).toBeUndefined();
    expect(r.queries).toHaveLength(0);
  });
});

describe("syncProviderCoupons", () => {
  it("only compares coupons from the environment it listed", async () => {
    // A live listing says nothing about test coupons; the old query marked every
    // test coupon of the integration as deleted.
    r = createSqlRecorder([[]]);

    await syncProviderCoupons(r.db, env, integration(), "live");

    expect(configs[0]!.config.environment).toBe("live");
    expect(r.queries[0]!.sql).toContain('"coupons"."environment" = $');
    expect(r.queries[0]!.params).toContain("live");
  });

  it("marks missing coupons deleted, comparing Gumroad offer codes by offer id", async () => {
    provider("gumroad", "live").listDiscounts.mockResolvedValueOnce([
      { providerDiscountId: "prodB:offer1", code: "A", discountType: "percentage", amount: 40 },
    ]);
    const kept = coupon({ id: "cpn_kept", environment: "live", providerCouponId: "prodA:offer1" });
    const gone = coupon({ id: "cpn_gone", environment: "live", providerCouponId: "prodA:offer2" });
    r = createSqlRecorder([[kept, gone], []]);

    const out = await syncProviderCoupons(r.db, env, integration({ provider: "gumroad" }), "live");

    expect(out).toEqual({ synced: 1, orphaned: 1 });
    expect(r.queries[1]!.params).toEqual(["deleted", "cpn_gone"]);
  });
});
