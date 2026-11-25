import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createTestClient, mountRoutes, type InjectedMember } from "../test/helpers";
import { createSqlRecorder, type SqlRecorder } from "../lib/sql-recorder-test-helpers";

// Unit tests for DELETE /v1/teams/:orgId/campaigns/:id. No database: createDb()
// returns a recorder that builds the real Drizzle SQL and answers with canned
// rows, so these tests pin the statement shape (every delete scoped to the
// org) and the transaction outcome (rollback on a miss). The Postgres-backed
// counterpart is the tenant-isolation integration test.

const state = vi.hoisted(() => ({ recorder: null as unknown as SqlRecorder }));
vi.mock("../db", () => ({ createDb: () => state.recorder.db }));
vi.mock("../services/banner-cache.service", () => ({ pushBannerConfigForOrg: async () => {} }));

const { default: campaignsRoute, countryPriceConflict, deleteCampaignCascade, insertCampaignWithBanner } = await import("./campaigns");
const { CampaignInRunningExperimentError } = await import("../services/experiment.service");

const ORG_A = "org_a";
const CAMPAIGN = "01JCAMPAIGNBBBBBBBBBBBBBBB";

const SCOPED_TO_ORG_A = '("campaigns"."id" = $1 and "campaigns"."organization_id" = $2)';

// A/B test guard (services/experiment.service.ts): the delete locks the
// campaign row, then looks for a running experiment that uses it as an arm.
const LOCK_CAMPAIGN = `select "id" from "campaigns" where ${SCOPED_TO_ORG_A} for update`;
const RUNNING_EXPERIMENT_LOOKUP =
  'select "id", "name", "product_id", "environment" from "experiments" where ("experiments"."organization_id" = $1 and "experiments"."status" = $2 and ("experiments"."campaign_a_id" = $3 or "experiments"."campaign_b_id" = $4)) limit $5';
const EXP = "01JEXPERIMENTXXXXXXXXXXXXX";
const RUNNING_EXPERIMENT = { id: EXP, name: "India 30 vs 45", productId: "p1", environment: "live" };
// Canned rows for "access check passed, not in a running test".
const NOT_IN_TEST = [[{ id: CAMPAIGN }], []];

describe("deleteCampaignCascade", () => {
  it("answers false and deletes NOTHING when the campaign is not in the org (owner of another org)", async () => {
    // Ownership check finds no campaign with this id in org A.
    const r = createSqlRecorder([[]]);

    const ok = await deleteCampaignCascade(r.db, { orgId: ORG_A, campaignId: CAMPAIGN, userId: "u_a", role: "owner" });

    expect(ok).toBe(false);
    expect(r.transactions).toEqual(["rollback"]);
    expect(r.queries).toHaveLength(1);
    expect(r.queries[0]!.sql).toBe(`select "product_id" from "campaigns" where ${SCOPED_TO_ORG_A} limit $3`);
    expect(r.queries[0]!.params).toEqual([CAMPAIGN, ORG_A, 1]);
    expect(r.queries.some((q) => q.sql.startsWith("delete"))).toBe(false);
  });

  it("scopes every child delete through a campaign row owned by the org, then commits", async () => {
    const r = createSqlRecorder([[{ productId: "p1" }], ...NOT_IN_TEST, [], [], [{ id: CAMPAIGN }]]);

    const ok = await deleteCampaignCascade(r.db, { orgId: ORG_A, campaignId: CAMPAIGN, userId: "u_a", role: "admin" });

    expect(ok).toBe(true);
    expect(r.transactions).toEqual(["commit"]);
    expect(r.queries.map((q) => q.sql)).toEqual([
      `select "product_id" from "campaigns" where ${SCOPED_TO_ORG_A} limit $3`,
      LOCK_CAMPAIGN,
      RUNNING_EXPERIMENT_LOOKUP,
      `delete from "coupons" where "coupons"."campaign_id" in (select "id" from "campaigns" where ${SCOPED_TO_ORG_A})`,
      `delete from "banner_configs" where "banner_configs"."campaign_id" in (select "id" from "campaigns" where ${SCOPED_TO_ORG_A})`,
      `delete from "campaigns" where ${SCOPED_TO_ORG_A} returning "id"`,
    ]);
    expect(r.queries[2]!.params).toEqual([ORG_A, "running", CAMPAIGN, CAMPAIGN, 1]);
    for (const q of r.queries.slice(3)) expect(q.params).toEqual([CAMPAIGN, ORG_A]);
  });

  it("refuses an arm of a running A/B test: throws the 409 conflict and deletes NOTHING", async () => {
    const r = createSqlRecorder([[{ productId: "p1" }], [{ id: CAMPAIGN }], [RUNNING_EXPERIMENT]]);

    const err = await deleteCampaignCascade(r.db, { orgId: ORG_A, campaignId: CAMPAIGN, userId: "u_a", role: "owner" }).then(
      () => null,
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(CampaignInRunningExperimentError);
    expect((err as InstanceType<typeof CampaignInRunningExperimentError>).body).toMatchObject({
      code: "campaign_in_running_experiment",
      experimentId: EXP,
    });
    expect(r.transactions).toEqual(["rollback"]);
    expect(r.queries.map((q) => q.sql)).toEqual([
      `select "product_id" from "campaigns" where ${SCOPED_TO_ORG_A} limit $3`,
      LOCK_CAMPAIGN,
      RUNNING_EXPERIMENT_LOOKUP,
    ]);
  });

  it("rolls back the child deletes when the campaign delete matches zero rows", async () => {
    // Check passes, but the campaign is gone by the time the last delete runs.
    const r = createSqlRecorder([[{ productId: "p1" }], ...NOT_IN_TEST, [], [], []]);

    const ok = await deleteCampaignCascade(r.db, { orgId: ORG_A, campaignId: CAMPAIGN, userId: "u_a", role: "owner" });

    expect(ok).toBe(false);
    expect(r.transactions).toEqual(["rollback"]);
    expect(r.queries).toHaveLength(6);
  });

  it("refuses a product-scoped member outside their scope, deleting nothing", async () => {
    // Campaign is in org A under p1; the member is only granted p2.
    // Rows: membership joined with its scope row and grants (lib/product-access.ts).
    const r = createSqlRecorder([[{ productId: "p1" }], [{ memberId: "m1", allProducts: false, productId: "p2" }]]);

    const ok = await deleteCampaignCascade(r.db, { orgId: ORG_A, campaignId: CAMPAIGN, userId: "u_m", role: "member" });

    expect(ok).toBe(false);
    expect(r.transactions).toEqual(["rollback"]);
    expect(r.queries.some((q) => q.sql.startsWith("delete"))).toBe(false);
  });

  it("lets a product-scoped member delete a campaign in their scope", async () => {
    const r = createSqlRecorder([
      [{ productId: "p1" }],
      [{ memberId: "m1", allProducts: false, productId: "p1" }],
      ...NOT_IN_TEST,
      [],
      [],
      [{ id: CAMPAIGN }],
    ]);

    const ok = await deleteCampaignCascade(r.db, { orgId: ORG_A, campaignId: CAMPAIGN, userId: "u_m", role: "member" });

    expect(ok).toBe(true);
    expect(r.transactions).toEqual(["commit"]);
  });

  it("propagates database errors (route answers 500) after rolling back", async () => {
    const r = createSqlRecorder([[{ productId: "p1" }], new Error("connection reset")]);
    await expect(
      deleteCampaignCascade(r.db, { orgId: ORG_A, campaignId: CAMPAIGN, userId: "u_a", role: "owner" }),
    ).rejects.toThrow("connection reset");
    expect(r.transactions).toEqual(["rollback"]);
  });
});

describe("DELETE /v1/teams/:orgId/campaigns/:id", () => {
  const owner: InjectedMember = { userId: "u_a", role: "owner" };

  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("answers 404 for another org's campaign id and commits nothing", async () => {
    state.recorder = createSqlRecorder([[]]);
    const client = createTestClient(mountRoutes(campaignsRoute, owner));

    const res = await client.request(`/v1/teams/${ORG_A}/campaigns/${CAMPAIGN}`, { method: "DELETE" });

    expect(res.status).toBe(404);
    expect(state.recorder.transactions).toEqual(["rollback"]);
    expect(state.recorder.queries.some((q) => q.sql.startsWith("delete"))).toBe(false);
  });

  it("answers 409 with the conflict body for an arm of a running A/B test, deleting nothing", async () => {
    state.recorder = createSqlRecorder([[{ productId: "p1" }], [{ id: CAMPAIGN }], [RUNNING_EXPERIMENT]]);
    const client = createTestClient(mountRoutes(campaignsRoute, owner));

    const res = await client.request(`/v1/teams/${ORG_A}/campaigns/${CAMPAIGN}`, { method: "DELETE" });

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "campaign_in_running_experiment", experimentId: EXP });
    expect(state.recorder.transactions).toEqual(["rollback"]);
    expect(state.recorder.queries.some((q) => q.sql.startsWith("delete"))).toBe(false);
  });

  it("answers 200 when the campaign is deleted", async () => {
    state.recorder = createSqlRecorder([[{ productId: "p1" }], ...NOT_IN_TEST, [], [], [{ id: CAMPAIGN }]]);
    const client = createTestClient(mountRoutes(campaignsRoute, owner));

    const res = await client.request(`/v1/teams/${ORG_A}/campaigns/${CAMPAIGN}`, { method: "DELETE" });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    expect(state.recorder.transactions).toEqual(["commit"]);
  });

  it("answers 500 and logs when the database fails", async () => {
    state.recorder = createSqlRecorder([new Error("connection reset")]);
    const client = createTestClient(mountRoutes(campaignsRoute, owner));

    const res = await client.request(`/v1/teams/${ORG_A}/campaigns/${CAMPAIGN}`, { method: "DELETE" });

    expect(res.status).toBe(500);
    expect(console.error).toHaveBeenCalledWith(
      "campaigns: delete failed",
      expect.objectContaining({ orgId: ORG_A, campaignId: CAMPAIGN }),
    );
  });
});

describe("PATCH /v1/teams/:orgId/campaigns/:id (A/B test guard)", () => {
  const owner: InjectedMember = { userId: "u_a", role: "owner" };
  const OTHER_PRODUCT = "01JPRODUCTBBBBBBBBBBBBBBBB";
  const existing = { status: "active", discountDelivery: "banner_coupon", integrationId: null, productId: "p1" };
  const patch = (json: unknown) =>
    createTestClient(mountRoutes(campaignsRoute, owner)).request(`/v1/teams/${ORG_A}/campaigns/${CAMPAIGN}`, {
      method: "PATCH",
      json,
    });

  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  for (const status of ["paused", "draft"]) {
    it(`refuses status '${status}' for an arm of a running test with 409, updating nothing`, async () => {
      state.recorder = createSqlRecorder([[existing], [RUNNING_EXPERIMENT]]);

      const res = await patch({ status });

      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ code: "campaign_in_running_experiment", experimentId: EXP });
      expect(state.recorder.queries[1]!.sql).toBe(RUNNING_EXPERIMENT_LOOKUP);
      expect(state.recorder.queries[1]!.params).toEqual([ORG_A, "running", CAMPAIGN, CAMPAIGN, 1]);
      expect(state.recorder.queries.some((q) => q.sql.startsWith("update"))).toBe(false);
    });
  }

  it("refuses moving an arm of a running test to another product", async () => {
    // product ownership check (validateOwnedRefs), existing row, experiment lookup
    state.recorder = createSqlRecorder([[{ id: OTHER_PRODUCT }], [existing], [RUNNING_EXPERIMENT]]);

    const res = await patch({ productId: OTHER_PRODUCT });

    expect(res.status).toBe(409);
    expect(state.recorder.queries.some((q) => q.sql.startsWith("update"))).toBe(false);
  });

  it("refuses moving an arm of a running test to the other environment", async () => {
    state.recorder = createSqlRecorder([[existing], [RUNNING_EXPERIMENT]]);

    const res = await patch({ environment: "test" });

    expect(res.status).toBe(409);
    expect(state.recorder.queries.some((q) => q.sql.startsWith("update"))).toBe(false);
  });

  it("allows other edits of an arm mid-test without looking up experiments", async () => {
    state.recorder = createSqlRecorder([[existing], [{ id: CAMPAIGN, status: "active", integrationId: null }]]);

    const res = await patch({ maxDiscountPercent: 40 });

    expect(res.status).toBe(200);
    expect(state.recorder.queries.some((q) => q.sql.includes('from "experiments"'))).toBe(false);
  });

  it("allows pausing a campaign that is in no running test", async () => {
    state.recorder = createSqlRecorder([[existing], [], [{ id: CAMPAIGN, status: "paused", integrationId: null }]]);

    const res = await patch({ status: "paused" });

    expect(res.status).toBe(200);
    expect(state.recorder.queries.filter((q) => q.sql.startsWith("update"))).toHaveLength(1);
  });
});

describe("countryPriceConflict", () => {
  const base = { status: "active", delivery: "provider_price", provider: "dodopayments", providerProductId: "pdt_FAKE1" };

  it("lets a complete Dodo campaign through, and ignores other deliveries", () => {
    expect(countryPriceConflict(base)).toBeNull();
    expect(countryPriceConflict({ ...base, delivery: "banner_coupon", provider: "stripe" })).toBeNull();
  });

  it("refuses any platform but Dodo Payments, even for a draft", () => {
    expect(countryPriceConflict({ ...base, provider: "stripe" })?.code).toBe("country_prices_unsupported");
    expect(countryPriceConflict({ ...base, status: "draft", provider: "paddle" })?.code).toBe("country_prices_unsupported");
  });

  it("lets a draft wait for its integration and product, but not an active campaign", () => {
    expect(countryPriceConflict({ ...base, status: "draft", provider: null, providerProductId: null })).toBeNull();
    expect(countryPriceConflict({ ...base, provider: null })?.code).toBe("country_prices_incomplete");
    expect(countryPriceConflict({ ...base, providerProductId: null })?.code).toBe("country_prices_incomplete");
  });
});

describe("PATCH /v1/teams/:orgId/campaigns/:id (Dodo charges the country price)", () => {
  const owner: InjectedMember = { userId: "u_a", role: "owner" };
  const charged = {
    status: "active",
    discountDelivery: "provider_price",
    integrationId: "int_1",
    providerProductId: "pdt_FAKE1",
    productId: "p1",
    environment: "live",
  };
  const dodoFacts = { provider: "dodopayments", hasLiveKey: true, hasTestKey: true };
  const patch = (json: unknown) =>
    createTestClient(mountRoutes(campaignsRoute, owner)).request(`/v1/teams/${ORG_A}/campaigns/${CAMPAIGN}`, {
      method: "PATCH",
      json,
    });
  const updates = () => state.recorder.queries.filter((q) => q.sql.startsWith("update"));

  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("refuses discount codes on an active campaign while Dodo still charges its country prices", async () => {
    const published = {
      IN: { currency: "INR", minorAmount: 52900, discount: 70 },
      BR: { currency: "BRL", minorAmount: 4900, discount: 50 },
    };
    state.recorder = createSqlRecorder([[charged], [{ published, verifiedAt: new Date() }]]);

    const res = await patch({ discountDelivery: "banner_coupon" });

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "country_prices_still_at_dodo", remaining: 2 });
    expect(updates()).toHaveLength(0);
  });

  it("refuses activating a code campaign whose Dodo prices aren't removed yet", async () => {
    const paused = { ...charged, status: "paused", discountDelivery: "banner_coupon" };
    state.recorder = createSqlRecorder([
      [paused],
      [{ provider: "dodopayments", hasLiveKey: true, hasTestKey: true }], // key check for going active
      [{ published: { IN: { currency: "INR", minorAmount: 52900, discount: 70 } }, verifiedAt: new Date() }],
    ]);

    const res = await patch({ status: "active" });

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "country_prices_still_at_dodo", remaining: 1 });
    expect(updates()).toHaveLength(0);
  });

  it("refuses the delivery on a platform other than Dodo Payments", async () => {
    const onStripe = { ...charged, discountDelivery: "banner_coupon", providerProductId: null };
    state.recorder = createSqlRecorder([[onStripe], [], [{ provider: "stripe", hasLiveKey: true, hasTestKey: true }]]);

    const res = await patch({ discountDelivery: "provider_price" });

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "country_prices_unsupported" });
    expect(updates()).toHaveLength(0);
  });

  it("refuses going active without the Dodo product to price", async () => {
    state.recorder = createSqlRecorder([[{ ...charged, status: "paused", providerProductId: null }], [dodoFacts], [dodoFacts]]);

    const res = await patch({ status: "active" });

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "country_prices_incomplete" });
  });

  it("refuses a Dodo product another campaign prices", async () => {
    state.recorder = createSqlRecorder([[charged], [dodoFacts], [{ id: "ccp_other" }]]);

    const res = await patch({ providerProductId: "pdt_FAKE2" });

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "country_prices_product_taken" });
    expect(state.recorder.queries[2]!.params).toEqual(expect.arrayContaining([ORG_A, "int_1", "pdt_FAKE2", CAMPAIGN]));
  });

  it("refuses switching a campaign with holiday deals that haven't ended", async () => {
    const withCodes = { ...charged, discountDelivery: "banner_coupon" };
    state.recorder = createSqlRecorder([[withCodes], [], [dodoFacts], [], [{ id: "deal_1" }]]);

    const res = await patch({ discountDelivery: "provider_price" });

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "campaign_has_deals" });
    expect(updates()).toHaveLength(0);
  });
});

describe("POST /v1/teams/:orgId/campaigns (B-12: campaign and banner config are one transaction)", () => {
  const owner: InjectedMember = { userId: "u_a", role: "owner" };
  const PRODUCT = "01JPRODUCTAAAAAAAAAAAAAAAA";

  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("inserts the campaign and its banner config inside one committed transaction", async () => {
    // product ownership check, campaign insert (returning), banner config insert
    state.recorder = createSqlRecorder([[{ id: PRODUCT }], [{ id: "c1", status: "draft", integrationId: null }], []]);
    const client = createTestClient(mountRoutes(campaignsRoute, owner));

    const res = await client.request(`/v1/teams/${ORG_A}/campaigns`, {
      method: "POST",
      json: { name: "Launch", productId: PRODUCT },
    });

    expect(res.status).toBe(201);
    expect(state.recorder.transactions).toEqual(["commit"]);
    const inserts = state.recorder.queries.filter((q) => q.sql.startsWith("insert"));
    expect(inserts.map((q) => q.sql.split(" (")[0])).toEqual(['insert into "campaigns"', 'insert into "banner_configs"']);
  });

  it("rolls the campaign back when the banner config insert fails (no campaign without a banner)", async () => {
    // Without the transaction the campaign row stayed behind on this failure.
    state.recorder = createSqlRecorder([[{ id: PRODUCT }], [{ id: "c1", status: "draft", integrationId: null }], new Error("connection reset")]);
    const client = createTestClient(mountRoutes(campaignsRoute, owner));

    const res = await client.request(`/v1/teams/${ORG_A}/campaigns`, {
      method: "POST",
      json: { name: "Launch", productId: PRODUCT },
    });

    expect(res.status).toBe(500);
    expect(state.recorder.transactions).toEqual(["rollback"]);
  });

  it("insertCampaignWithBanner gives the banner config the campaign's id and creation time", async () => {
    const r = createSqlRecorder([[{ id: "c1" }], []]);
    const at = new Date("2026-11-18T10:00:00Z");

    const campaign = await insertCampaignWithBanner(
      r.db,
      { id: "c1", organizationId: ORG_A, productId: PRODUCT, name: "Launch", createdAt: at, updatedAt: at },
      "b1",
    );

    expect(campaign).toEqual({ id: "c1" });
    const banner = r.queries[1]!;
    expect(banner.sql).toMatch(/^insert into "banner_configs"/);
    expect(banner.params).toEqual(expect.arrayContaining(["b1", "c1"]));
    expect(r.transactions).toEqual(["commit"]);
  });
});

describe("test campaigns and live-only providers (PROVIDERS_WITHOUT_TEST_MODE)", () => {
  const owner: InjectedMember = { userId: "u_a", role: "owner" };
  const PRODUCT = "01JPRODUCTAAAAAAAAAAAAAAAA";
  const INT = "01JINTEGRATIONAAAAAAAAAAAA";
  const request = (method: "POST" | "PATCH", json: unknown) =>
    createTestClient(mountRoutes(campaignsRoute, owner)).request(
      method === "POST" ? `/v1/teams/${ORG_A}/campaigns` : `/v1/teams/${ORG_A}/campaigns/${CAMPAIGN}`,
      { method, json },
    );
  const writes = () => state.recorder.queries.filter((q) => /^(insert|update)/.test(q.sql));

  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  for (const [provider, name] of [["gumroad", "Gumroad"], ["woocommerce", "WooCommerce"]] as const) {
    it(`refuses to create a test campaign on ${name} with a 400 that says why`, async () => {
      // product ownership (a test product), integration ownership (with its provider)
      state.recorder = createSqlRecorder([[{ id: PRODUCT, environment: "test" }], [{ id: INT, provider }]]);

      const res = await request("POST", { name: "Launch", productId: PRODUCT, integrationId: INT, environment: "test" });

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error: `${name} has no test mode, so a test campaign can't use it. Make the campaign live or link another integration.`,
        code: "provider_has_no_test_mode",
      });
      expect(writes()).toHaveLength(0);
    });
  }

  it("still creates a live campaign on Gumroad, and a test campaign on a provider with a test mode", async () => {
    for (const [provider, environment] of [["gumroad", "live"], ["stripe", "test"]]) {
      state.recorder = createSqlRecorder([
        [{ id: PRODUCT, environment }],
        [{ id: INT, provider }],
        [{ id: "c1", status: "draft", integrationId: INT }],
        [],
      ]);
      const res = await request("POST", { name: "Launch", productId: PRODUCT, integrationId: INT, environment });
      expect(res.status, `${provider} ${environment}`).toBe(201);
    }
  });

  it("refuses moving a live Gumroad campaign to a test product, updating nothing", async () => {
    state.recorder = createSqlRecorder([
      [{ id: "p_test", environment: "test" }], // product ownership: a test product
      [{ status: "draft", discountDelivery: "banner_coupon", integrationId: INT, productId: "p1", environment: "live" }],
      [], // A/B guard: in no running test
      [{ provider: "gumroad", hasLiveKey: true, hasTestKey: false }], // the linked integration
    ]);

    const res = await request("PATCH", { environment: "test", productId: "p_test" });

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "provider_has_no_test_mode" });
    expect(writes()).toHaveLength(0);
  });

  it("refuses linking a test campaign to a WooCommerce integration, updating nothing", async () => {
    state.recorder = createSqlRecorder([
      [{ id: INT, provider: "woocommerce" }], // integration ownership (with its provider)
      [{ status: "draft", discountDelivery: "banner_coupon", integrationId: null, productId: "p1", environment: "test" }],
    ]);

    const res = await request("PATCH", { integrationId: INT });

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining("WooCommerce has no test mode") });
    expect(writes()).toHaveLength(0);
  });

  it("doesn't look the provider up for an edit that changes neither environment nor integration", async () => {
    state.recorder = createSqlRecorder([
      [{ status: "draft", discountDelivery: "banner_coupon", integrationId: INT, productId: "p1", environment: "test" }],
      [{ id: CAMPAIGN, status: "draft", integrationId: INT }],
    ]);

    const res = await request("PATCH", { name: "Renamed" });

    expect(res.status).toBe(200);
    expect(state.recorder.queries.some((q) => q.sql.includes('from "integrations"'))).toBe(false);
  });
});

describe("a campaign lives in its product's environment", () => {
  const owner: InjectedMember = { userId: "u_a", role: "owner" };
  const PRODUCT = "01JPRODUCTAAAAAAAAAAAAAAAA";
  const LIVE_PRODUCT = "01JPRODUCTLLLLLLLLLLLLLLLL";
  const INT = "01JINTEGRATIONAAAAAAAAAAAA";
  const request = (method: "POST" | "PATCH", json: unknown) =>
    createTestClient(mountRoutes(campaignsRoute, owner)).request(
      method === "POST" ? `/v1/teams/${ORG_A}/campaigns` : `/v1/teams/${ORG_A}/campaigns/${CAMPAIGN}`,
      { method, json },
    );
  const writes = () => state.recorder.queries.filter((q) => /^(insert|update)/.test(q.sql));
  const testCampaign = { status: "draft", discountDelivery: "banner_coupon", integrationId: null, productId: "p1", environment: "test" };
  const MISMATCH = { error: "A campaign must be in its product's environment (test).", code: "environment_mismatch" };

  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("creates the campaign in its product's environment when the body names none", async () => {
    state.recorder = createSqlRecorder([[{ id: PRODUCT, environment: "test" }], [{ id: "c1", status: "draft" }], []]);

    const res = await request("POST", { name: "Launch", productId: PRODUCT });

    expect(res.status).toBe(201);
    const insert = state.recorder.queries.find((q) => q.sql.startsWith('insert into "campaigns"'))!;
    expect(insert.params).toContain("test");
    expect(insert.params).not.toContain("live");
  });

  it("refuses an environment that differs from the product's on create, writing nothing", async () => {
    state.recorder = createSqlRecorder([[{ id: PRODUCT, environment: "test" }]]);

    const res = await request("POST", { name: "Launch", productId: PRODUCT, environment: "live" });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual(MISMATCH);
    expect(writes()).toHaveLength(0);
  });

  it("refuses switching a test campaign to live while its product is a test product", async () => {
    state.recorder = createSqlRecorder([
      [testCampaign],
      [], // A/B guard: in no running test
      [{ environment: "test" }], // its product's environment
    ]);

    const res = await request("PATCH", { environment: "live" });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual(MISMATCH);
    expect(writes()).toHaveLength(0);
  });

  it("refuses moving a test campaign to a live product", async () => {
    state.recorder = createSqlRecorder([
      [{ id: LIVE_PRODUCT, environment: "live" }], // product ownership
      [testCampaign],
      [], // A/B guard
    ]);

    const res = await request("PATCH", { productId: LIVE_PRODUCT });

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "environment_mismatch" });
    expect(writes()).toHaveLength(0);
  });

  it("allows moving a campaign to a live product together with switching it to live", async () => {
    state.recorder = createSqlRecorder([
      [{ id: LIVE_PRODUCT, environment: "live" }],
      [testCampaign],
      [], // A/B guard
      [{ id: CAMPAIGN, status: "draft", integrationId: null, environment: "live" }], // update returning
    ]);

    const res = await request("PATCH", { productId: LIVE_PRODUCT, environment: "live" });

    expect(res.status).toBe(200);
    expect(writes()).toHaveLength(1);
  });

  it("refuses an active campaign whose integration has no key for the campaign's environment", async () => {
    // Create: a test product, an integration with only a live key.
    state.recorder = createSqlRecorder([
      [{ id: PRODUCT, environment: "test" }],
      [{ id: INT, provider: "stripe", hasLiveKey: true, hasTestKey: false }],
    ]);
    const created = await request("POST", { name: "Launch", productId: PRODUCT, integrationId: INT, status: "active" });
    expect(created.status).toBe(400);
    expect(await created.json()).toMatchObject({
      code: "integration_missing_key",
      error: expect.stringContaining("no test key"),
    });
    expect(writes()).toHaveLength(0);

    // Activate: an existing test draft linked to that integration.
    state.recorder = createSqlRecorder([
      [{ ...testCampaign, integrationId: INT }],
      [{ provider: "stripe", hasLiveKey: true, hasTestKey: false }],
    ]);
    const activated = await request("PATCH", { status: "active" });
    expect(activated.status).toBe(400);
    expect(await activated.json()).toMatchObject({ code: "integration_missing_key" });
    expect(writes()).toHaveLength(0);
  });

  it("keeps a draft on an integration without that key (keys can be added before going live)", async () => {
    state.recorder = createSqlRecorder([
      [{ id: PRODUCT, environment: "test" }],
      [{ id: INT, provider: "stripe", hasLiveKey: true, hasTestKey: false }],
      [{ id: "c1", status: "draft", integrationId: INT }],
      [],
    ]);

    const res = await request("POST", { name: "Launch", productId: PRODUCT, integrationId: INT });

    expect(res.status).toBe(201);
  });
});
