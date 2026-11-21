import { describe, it, expect, vi, afterEach } from "vitest";
import { createMockKV } from "../test/helpers";
import { createSqlRecorder, type SqlRecorder } from "../lib/sql-recorder-test-helpers";
import {
  BANNER_DOC_VERSION,
  BANNER_DOC_MAX_AGE_MS,
  BANNER_REBUILD_EXTRA_PASSES,
  bannerDocKey,
  bannerDocRefreshDue,
  buildBannerDoc,
  isCurrentBannerDoc,
  pushBannerConfigForOrg,
  type BannerDocInput,
  type CachedBannerConfig,
  type CouponForDisplay,
  type ServingCampaign,
} from "./banner-cache.service";
import { discountEpochKey } from "./parity.service";
import { TEST_BANNER, bannerDocForCampaign } from "./banner-doc-test-helpers";

const at = (day: number) => new Date(Date.UTC(2026, 10, day));

function campaign(id: string, overrides: Partial<ServingCampaign> = {}): ServingCampaign {
  return {
    id,
    productId: "P1",
    environment: "live",
    status: "active",
    createdAt: at(1),
    hasBanner: true,
    integrationId: null,
    pricingMode: "custom",
    maxDiscountPercent: 70,
    discountOverrides: { IN: 40, BR: 25 },
    allowedDomains: null,
    banner: TEST_BANNER,
    pricing: { currency: "INR", basePrice: 1499, charm: "none" },
    ...overrides,
  };
}

function coupon(overrides: Partial<CouponForDisplay> = {}): CouponForDisplay {
  return {
    campaignId: "C1",
    countryCode: "IN",
    code: "IN40-GOOD",
    status: "active",
    integrationId: "int_1",
    environment: "live",
    discountPercent: 40,
    ...overrides,
  };
}

function input(overrides: Partial<BannerDocInput> = {}): BannerDocInput {
  return {
    organizationId: "org_1",
    epoch: "E1",
    builtAt: 1_795_089_600_000,
    showBranding: true,
    inputs: { campaigns: [campaign("C1")], experiments: [] },
    parityGroups: { byCountry: new Map(), hasOwnGroups: false },
    coupons: [],
    ...overrides,
  };
}

describe("isCurrentBannerDoc", () => {
  it("only a current-version document counts; anything else is a cache miss", () => {
    expect(BANNER_DOC_VERSION).toBe(3);
    expect(isCurrentBannerDoc(bannerDocForCampaign())).toBe(true);
    const v1 = { campaignId: "C1", allowedDomains: null, banner: TEST_BANNER, countries: {}, showBranding: true };
    expect(isCurrentBannerDoc(v1)).toBe(false);
    expect(isCurrentBannerDoc({ ...bannerDocForCampaign(), v: 1 })).toBe(false);
    // Version 2 had no campaign pricing: rebuilt, never served.
    expect(isCurrentBannerDoc({ ...bannerDocForCampaign(), v: 2 })).toBe(false);
    expect(isCurrentBannerDoc({ ...bannerDocForCampaign(), products: null })).toBe(false);
    expect(isCurrentBannerDoc(null)).toBe(false);
    expect(isCurrentBannerDoc("x")).toBe(false);
  });
});

describe("bannerDocRefreshDue", () => {
  const built = 1_795_089_600_000;
  const doc = (builtAt?: unknown) => ({ ...bannerDocForCampaign(), builtAt }) as CachedBannerConfig;

  it("is not due before BANNER_DOC_MAX_AGE_MS (15 minutes), and due from then on", () => {
    expect(BANNER_DOC_MAX_AGE_MS).toBe(15 * 60_000);
    expect(bannerDocRefreshDue(doc(built), built)).toBe(false);
    expect(bannerDocRefreshDue(doc(built), built + BANNER_DOC_MAX_AGE_MS - 1)).toBe(false);
    expect(bannerDocRefreshDue(doc(built), built + BANNER_DOC_MAX_AGE_MS)).toBe(true);
    expect(bannerDocRefreshDue(doc(built), built + 86_400_000)).toBe(true);
  });

  it("a document without builtAt (written before the field existed) is due", () => {
    const old = bannerDocForCampaign() as Partial<CachedBannerConfig>;
    delete old.builtAt;
    expect(isCurrentBannerDoc(old)).toBe(true); // still served
    expect(bannerDocRefreshDue(old as CachedBannerConfig, built)).toBe(true);
    for (const bad of [null, "2026-11-19", Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(bannerDocRefreshDue(doc(bad), built)).toBe(true);
    }
  });

  it("a builtAt ahead of this isolate's clock is not due", () => {
    expect(bannerDocRefreshDue(doc(built + 5_000), built)).toBe(false);
  });
});

describe("buildBannerDoc", () => {
  it("maps each product to its campaign and stores only referenced campaigns", () => {
    const doc = buildBannerDoc(
      input({
        inputs: {
          campaigns: [
            campaign("C1", { productId: "P1", createdAt: at(1) }),
            campaign("C2", { productId: "P2", createdAt: at(2) }),
            campaign("OLD", { productId: "P1", createdAt: at(0) }), // superseded by C1
            campaign("NOBANNER", { productId: "P3", hasBanner: false, banner: null }),
          ],
          experiments: [],
        },
      }),
    );
    expect(doc.v).toBe(BANNER_DOC_VERSION);
    expect(doc.epoch).toBe("E1");
    expect(doc.builtAt).toBe(1_795_089_600_000);
    expect(doc.products).toEqual({
      P1: { kind: "campaign", campaignId: "C1" },
      P2: { kind: "campaign", campaignId: "C2" },
    });
    expect(doc.defaultProductId).toBe("P2");
    expect(Object.keys(doc.campaigns).sort()).toEqual(["C1", "C2"]);
  });

  it("stores both arms of a running experiment", () => {
    const doc = buildBannerDoc(
      input({
        inputs: {
          campaigns: [campaign("A"), campaign("B", { discountOverrides: { IN: 20 } })],
          experiments: [
            {
              id: "EXP1",
              productId: "P1",
              environment: "live",
              status: "running",
              campaignAId: "A",
              campaignBId: "B",
              trafficSplitB: 30,
              startedAt: at(3),
            },
          ],
        },
      }),
    );
    expect(doc.products.P1).toEqual({
      kind: "experiment",
      experimentId: "EXP1",
      campaignAId: "A",
      campaignBId: "B",
      trafficSplitB: 30,
    });
    expect(doc.campaigns.A!.countries.IN!.discount).toBe(40);
    expect(doc.campaigns.B!.countries.IN!.discount).toBe(20);
  });

  it("an organization with nothing servable still gets a document (so the endpoint does not fall back to Postgres)", () => {
    const doc = buildBannerDoc(input({ inputs: { campaigns: [campaign("C1", { status: "paused" })], experiments: [] } }));
    expect(doc).toMatchObject({ v: BANNER_DOC_VERSION, defaultProductId: null, products: {}, campaigns: {} });
  });

  it("prices countries with the shared function and leaves zero discounts out", () => {
    const doc = buildBannerDoc(
      input({
        inputs: {
          campaigns: [campaign("C1", { pricingMode: "group", discountOverrides: null, maxDiscountPercent: 30 })],
          experiments: [],
        },
        parityGroups: {
          byCountry: new Map([
            ["IN", { discountPercent: 50, sortOrder: 2 }],
            ["BR", { discountPercent: 0, sortOrder: 1 }],
          ]),
          hasOwnGroups: true,
        },
      }),
    );
    const countries = doc.campaigns.C1!.countries;
    expect(countries.IN).toEqual({ discount: 30, tier: 2, code: null, countryName: "India" });
    expect(countries).not.toHaveProperty("BR");
  });

  it("stores each campaign's pricing (its product's price and currency, its charm strategy) once, not per country", () => {
    const doc = buildBannerDoc(
      input({
        inputs: {
          campaigns: [
            campaign("C1", { productId: "P1", pricing: { currency: "EUR", basePrice: 20, charm: "round_x9" } }),
            campaign("C2", { productId: "P2", createdAt: at(2), pricing: { currency: "USD", basePrice: 19.99, charm: "none" } }),
          ],
          experiments: [],
        },
      }),
    );
    expect(doc.campaigns.C1!.pricing).toEqual({ currency: "EUR", basePrice: 20, charm: "round_x9" });
    expect(doc.campaigns.C2!.pricing).toEqual({ currency: "USD", basePrice: 19.99, charm: "none" });
    for (const country of Object.values(doc.campaigns.C1!.countries)) {
      expect(country).not.toHaveProperty("currencySymbol");
    }
  });

  describe("coupon filter (isDisplayableCoupon)", () => {
    const withIntegration = (coupons: CouponForDisplay[]) =>
      buildBannerDoc(
        input({
          inputs: { campaigns: [campaign("C1", { integrationId: "int_1" })], experiments: [] },
          coupons,
        }),
      ).campaigns.C1!.countries;

    it("shows only a coupon for this integration, environment and exact percent; the newest wins", () => {
      const countries = withIntegration([
        coupon({ code: "IN30-WRONG-PERCENT", discountPercent: 30 }),
        coupon({ code: "IN40-OTHER-INT", integrationId: "int_old" }),
        coupon({ code: "IN40-TEST", environment: "test" }),
        coupon({ code: "IN40-REVOKED", status: "revoked" }),
        coupon({ code: "IN40-NEWEST" }),
        coupon({ code: "IN40-OLDER" }),
      ]);
      expect(countries.IN).toMatchObject({ code: "IN40-NEWEST", discount: 40 });
      expect(countries.IN).not.toHaveProperty("resolve");
    });

    it("a provider-backed country without a displayable code is marked resolve, never shown with a wrong code", () => {
      const countries = withIntegration([coupon({ code: "IN30-WRONG-PERCENT", discountPercent: 30 })]);
      expect(countries.IN).toMatchObject({ code: null, resolve: true });
      expect(countries.BR).toMatchObject({ code: null, resolve: true });
    });

    it("a campaign without an integration shows the discount with no code and no resolve flag", () => {
      const countries = buildBannerDoc(input({ coupons: [coupon()] })).campaigns.C1!.countries;
      expect(countries.IN).toEqual({ discount: 40, tier: 3, code: null, countryName: "India" });
    });
  });
});

// ── pushBannerConfigForOrg ─────────────────────────────────────────────────

type Tables = Record<string, unknown[] | Error>;

/**
 * Answers each statement by the table it reads, whatever the order. With a
 * function, each statement sees the tables current when it runs (a database
 * that changes between two rebuilds).
 */
function routedRecorder(tables: Tables | (() => Tables)): SqlRecorder {
  const r = createSqlRecorder();
  r.results = {
    shift: () => {
      const sql = r.queries[r.queries.length - 1]!.sql;
      const from = sql.match(/ from "([a-z_]+)"/)?.[1] ?? "";
      return (typeof tables === "function" ? tables() : tables)[from] ?? [];
    },
  } as unknown as SqlRecorder["results"];
  return r;
}

function recordingKV() {
  const kv = createMockKV();
  const puts: string[] = [];
  const put = kv.put.bind(kv);
  kv.put = (async (key: string, value: string, opts?: KVNamespacePutOptions) => {
    puts.push(key);
    return put(key, value, opts);
  }) as KVNamespace["put"];
  return { kv, puts };
}

const campaignRow = {
  id: "C1",
  organizationId: "org_1",
  productId: "P1",
  name: "C1",
  status: "active",
  environment: "live",
  pricingMode: "custom",
  maxDiscountPercent: 70,
  discountOverrides: { IN: 40 },
  integrationId: null,
  allowedDomains: null,
  charmPricingStrategy: "round_x9",
  createdAt: at(1),
  updatedAt: at(1),
};

const fullOrg = (sub: unknown[] = []) => ({
  api_keys: [{ id: "K1" }, { id: "K2" }],
  campaigns: [
    {
      campaign: campaignRow,
      banner: { id: "b1", campaignId: "C1", ...TEST_BANNER },
      product: { currency: "EUR", basePrice: 20 },
    },
  ],
  experiments: [],
  parity_groups: [],
  subscriptions: sub,
  coupons: [],
});

describe("pushBannerConfigForOrg", () => {
  it("starts a new discount-cache epoch first, then writes one identical document per public key", async () => {
    const { kv, puts } = recordingKV();
    const r = routedRecorder(fullOrg());

    await pushBannerConfigForOrg(r.db, kv, "org_1", {});

    expect(puts).toEqual([discountEpochKey("org_1"), bannerDocKey("K1"), bannerDocKey("K2")]);
    const epoch = await kv.get(discountEpochKey("org_1"));
    const doc = JSON.parse((await kv.get(bannerDocKey("K1")))!);
    expect(await kv.get(bannerDocKey("K2"))).toBe(JSON.stringify(doc));
    expect(doc).toMatchObject({
      v: BANNER_DOC_VERSION,
      organizationId: "org_1",
      epoch,
      showBranding: true, // no subscription: Free
      defaultProductId: "P1",
      products: { P1: { kind: "campaign", campaignId: "C1" } },
    });
    expect(doc.campaigns.C1.countries.IN).toEqual({ discount: 40, tier: expect.any(Number), code: null, countryName: "India" });
    expect(doc.campaigns.C1.pricing).toEqual({ currency: "EUR", basePrice: 20, charm: "round_x9" });
    // The product's price and currency come from the campaigns query itself
    // (one join), the same loader the endpoint's database fallback uses.
    const campaignQuery = r.queries.find((q) => q.sql.includes(' from "campaigns"'))!;
    expect(campaignQuery.sql).toContain('inner join "products" on "products"."id" = "campaigns"."product_id"');
    expect(campaignQuery.sql).toContain('"products"."base_price"');
    expect(r.queries.some((q) => q.sql.includes(' from "products"'))).toBe(false);
    // Coupons are read only for the campaigns the document references.
    const couponQuery = r.queries.find((q) => q.sql.includes(' from "coupons"'))!;
    expect(couponQuery.params).toContain("C1");
  });

  it("every rebuild writes a new epoch, so discount entries cached before a change are never served", async () => {
    const { kv } = recordingKV();
    await pushBannerConfigForOrg(routedRecorder(fullOrg()).db, kv, "org_1", {});
    const first = await kv.get(discountEpochKey("org_1"));
    await pushBannerConfigForOrg(routedRecorder(fullOrg()).db, kv, "org_1", {});
    expect(await kv.get(discountEpochKey("org_1"))).not.toBe(first);
  });

  it("no public key: only the epoch is written", async () => {
    const { kv, puts } = recordingKV();
    await pushBannerConfigForOrg(routedRecorder({ ...fullOrg(), api_keys: [] }).db, kv, "org_1", {});
    expect(puts).toEqual([discountEpochKey("org_1")]);
  });

  it("self-hosted: showBranding is false even for an organization without a plan", async () => {
    const { kv } = recordingKV();
    await pushBannerConfigForOrg(routedRecorder(fullOrg()).db, kv, "org_1", { SELF_HOSTED: "true" });
    expect(JSON.parse((await kv.get(bannerDocKey("K1")))!).showBranding).toBe(false);
  });

  it("an active Pro subscription removes branding", async () => {
    const { kv } = recordingKV();
    const pro = [{ plan: "pro", status: "active", currentPeriodEnd: new Date(Date.now() + 86_400_000) }];
    await pushBannerConfigForOrg(routedRecorder(fullOrg(pro)).db, kv, "org_1", {});
    expect(JSON.parse((await kv.get(bannerDocKey("K1")))!).showBranding).toBe(false);
  });

  it("an unknown charm strategy in the database is served as none", async () => {
    const { kv } = recordingKV();
    const org = fullOrg();
    org.campaigns[0]!.campaign = { ...campaignRow, charmPricingStrategy: "round_x8" };
    await pushBannerConfigForOrg(routedRecorder(org).db, kv, "org_1", {});
    expect(JSON.parse((await kv.get(bannerDocKey("K1")))!).campaigns.C1.pricing.charm).toBe("none");
  });

  it("a database failure rejects (callers log it) after the epoch is already bumped", async () => {
    const { kv, puts } = recordingKV();
    const r = routedRecorder({ ...fullOrg(), campaigns: new Error("db down") });
    await expect(pushBannerConfigForOrg(r.db, kv, "org_1", {})).rejects.toThrow("db down");
    expect(puts).toEqual([discountEpochKey("org_1")]);
  });

  it("stamps builtAt (the endpoint refreshes documents older than BANNER_DOC_MAX_AGE_MS)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(T0);
      const { kv } = recordingKV();
      await pushBannerConfigForOrg(routedRecorder(fullOrg()).db, kv, "org_1", {});
      expect(JSON.parse((await kv.get(bannerDocKey("K1")))!).builtAt).toBe(T0);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ── Two rebuilds of one workspace racing ───────────────────────────────────

const T0 = Date.parse("2026-11-19T12:00:00Z");

/** fullOrg() with India's override changed: what a campaign edit commits. */
function editedOrg(discount: number) {
  const org = fullOrg();
  org.campaigns[0]!.campaign = { ...campaignRow, discountOverrides: { IN: discount } };
  return org;
}

/**
 * A view of `store` whose banner-document writes wait for `gate`; `reached`
 * resolves when the first one is attempted, i.e. once that rebuild has read
 * every row it builds from.
 */
function gatedKV(store: KVNamespace, gate: Promise<void>) {
  let signal!: () => void;
  const reached = new Promise<void>((resolve) => (signal = resolve));
  const kv = {
    ...store,
    put: (async (key: string, value: string, opts?: KVNamespacePutOptions) => {
      if (key.startsWith("banner-config:")) {
        signal();
        await gate;
      }
      return store.put(key, value, opts);
    }) as KVNamespace["put"],
  } as KVNamespace;
  return { kv, reached };
}

describe("pushBannerConfigForOrg: concurrent rebuilds", () => {
  afterEach(() => vi.useRealTimers());

  /**
   * R1 starts (epoch e1) and reads the rows; the edit commits and starts R2
   * (epoch e2), which reads the new rows and writes; R1 then writes last. The
   * document R1 wrote is from before the edit: R1 must notice the newer epoch
   * and rebuild.
   */
  async function interleave() {
    vi.useFakeTimers({ toFake: ["Date"] });
    let db = fullOrg(); // India at 40%
    const store = createMockKV();
    let release!: () => void;
    const r1 = gatedKV(store, new Promise<void>((resolve) => (release = resolve)));

    vi.setSystemTime(T0);
    const first = pushBannerConfigForOrg(routedRecorder(() => db).db, r1.kv, "org_1", {});
    await r1.reached; // R1 has read India at 40% and is about to write
    const e1 = await store.get(discountEpochKey("org_1"));

    vi.setSystemTime(T0 + 1_000);
    db = editedOrg(25); // the edit commits, then its own rebuild runs to the end
    await pushBannerConfigForOrg(routedRecorder(() => db).db, store, "org_1", {});
    const e2 = await store.get(discountEpochKey("org_1"));

    vi.setSystemTime(T0 + 2_000);
    release();
    await first;
    return { store, e1: e1!, e2: e2! };
  }

  it("the late writer re-reads the epoch, sees a newer rebuild and rebuilds from the current rows", async () => {
    const { store, e1, e2 } = await interleave();
    expect(e2 > e1).toBe(true);
    for (const key of ["K1", "K2"]) {
      const doc = JSON.parse((await store.get(bannerDocKey(key)))!);
      expect(doc.campaigns.C1.countries.IN.discount).toBe(25);
      // The repair pass adopts the newer epoch instead of starting another one,
      // so R2 (which re-reads after its own write) has nothing to repair.
      expect(doc.epoch).toBe(e2);
      expect(doc.builtAt).toBe(T0 + 2_000);
    }
    expect(await store.get(discountEpochKey("org_1"))).toBe(e2);
  });

  it("a rebuild alone re-reads the epoch once and makes no extra pass", async () => {
    const { kv, puts } = recordingKV();
    const r = routedRecorder(fullOrg());
    await pushBannerConfigForOrg(r.db, kv, "org_1", {});
    expect(puts).toEqual([discountEpochKey("org_1"), bannerDocKey("K1"), bannerDocKey("K2")]);
    expect(r.queries.filter((q) => q.sql.includes(' from "api_keys"'))).toHaveLength(1);
  });

  it("an older or unreadable epoch is not followed (KV can return a stale value)", async () => {
    const reads = [
      async () => "01ARZ3NDEKTSV4RRFFQ69G5FAV", // 2016: older than any epoch written now
      async () => null,
      async () => {
        throw new Error("kv down");
      },
    ];
    for (const read of reads) {
      const { kv, puts } = recordingKV();
      kv.get = read as unknown as KVNamespace["get"];
      const r = routedRecorder(fullOrg());
      await pushBannerConfigForOrg(r.db, kv, "org_1", {});
      expect(puts).toHaveLength(3);
      expect(r.queries.filter((q) => q.sql.includes(' from "api_keys"'))).toHaveLength(1);
    }
  });

  it(`at most ${BANNER_REBUILD_EXTRA_PASSES} extra passes, however often the epoch moves`, async () => {
    const { kv, puts } = recordingKV();
    // Every re-read sees a newer epoch (a rebuild elsewhere after each write).
    let n = 0;
    kv.get = (async () => `7ZZZZZZZZZZZZZZZZZZZZZZZZ${n++}`) as unknown as KVNamespace["get"];
    const r = routedRecorder(fullOrg());
    await pushBannerConfigForOrg(r.db, kv, "org_1", {});
    expect(r.queries.filter((q) => q.sql.includes(' from "api_keys"'))).toHaveLength(1 + BANNER_REBUILD_EXTRA_PASSES);
    // One epoch write (the first pass); each pass writes both documents.
    expect(puts.filter((k) => k === discountEpochKey("org_1"))).toHaveLength(1);
    expect(puts.filter((k) => k.startsWith("banner-config:"))).toHaveLength(2 * (1 + BANNER_REBUILD_EXTRA_PASSES));
  });
});
