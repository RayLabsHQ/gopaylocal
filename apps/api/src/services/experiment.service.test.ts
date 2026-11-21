import { describe, it, expect } from "vitest";
import { createSqlRecorder } from "../lib/sql-recorder-test-helpers";
import {
  CampaignInRunningExperimentError,
  ExperimentError,
  IntegrationInRunningExperimentError,
  assertIntegrationDisconnectKeepsExperiments,
  campaignUpdateBlockedByExperiment,
  createExperiment,
  endExperiment,
  getExperiment,
  getExperimentResults,
  listExperiments,
  assertCampaignNotInRunningExperiment,
  resultsWindow,
  retentionStartFor,
  summarizeArm,
  updateExperiment,
  utcDayStart,
} from "./experiment.service";

// No database: createSqlRecorder builds the real Drizzle SQL and answers with
// canned rows, so these pin the statement shape (every statement scoped to the
// org) and the transaction outcome. The Postgres-backed counterpart, including
// the partial unique index, is routes/experiments.integration.test.ts.

const ORG = "org_a";
const PRODUCT = "prod_1";
const A = "01JCAMPAIGNAAAAAAAAAAAAAAA";
const B = "01JCAMPAIGNBBBBBBBBBBBBBBB";
const EXP = "01JEXPERIMENTXXXXXXXXXXXXX";
const NOW = new Date("2026-11-18T12:00:00.000Z");

const input = { productId: PRODUCT, campaignAId: A, campaignBId: B, name: "Pro plan discount", trafficSplitB: 50 };
const arm = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  name: id === A ? "Control" : "Variant",
  productId: PRODUCT,
  environment: "live",
  status: "active",
  ...over,
});
const BOTH_BANNERS = [{ campaignId: A }, { campaignId: B }];
const uniqueViolation = () =>
  Object.assign(new Error('duplicate key value violates unique constraint "experiments_one_running_idx"'), {
    code: "23505",
  });

async function expectExperimentError(p: Promise<unknown>, status: number, code: string) {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ExperimentError);
  expect((err as ExperimentError).status).toBe(status);
  expect((err as ExperimentError).code).toBe(code);
}

// ── Results maths ───────────────────────────────────────────────────────────

describe("summarizeArm", () => {
  it("computes every rate from the raw counts", () => {
    const revenue = { USD: 6120, INR: 1000 };
    const r = summarizeArm(A, { impressions: 5100, clicks: 2040, copies: 1428, redemptions: 204, revenueSavedByCurrency: revenue });
    expect(r.campaignId).toBe(A);
    expect(r.clickRate).toBeCloseTo(0.4, 12);
    expect(r.copyRate).toBeCloseTo(0.28, 12);
    expect(r.conversionRate).toBeCloseTo(0.04, 12);
    expect(r.redemptionsPerCopy).toBeCloseTo(204 / 1428, 12);
    expect(r).toMatchObject({ impressions: 5100, clicks: 2040, copies: 1428, redemptions: 204, revenueSavedByCurrency: revenue });
    // No per-redemption revenue: redemptions are not split by currency, so any
    // single figure would mix currencies.
    expect(r).not.toHaveProperty("revenueSavedPerRedemption");
    expect(r).not.toHaveProperty("revenueSaved");
  });

  it("answers null, never 0 or NaN, for a rate whose denominator is zero", () => {
    const r = summarizeArm(B, { impressions: 0, clicks: 0, copies: 0, redemptions: 0, revenueSavedByCurrency: {} });
    expect(r.clickRate).toBeNull();
    expect(r.copyRate).toBeNull();
    expect(r.conversionRate).toBeNull();
    expect(r.redemptionsPerCopy).toBeNull();
  });

  it("keeps a real 0% (impressions but no redemptions) distinct from no data", () => {
    const r = summarizeArm(B, { impressions: 10, clicks: 0, copies: 0, redemptions: 0, revenueSavedByCurrency: {} });
    expect(r.conversionRate).toBe(0);
    expect(r.redemptionsPerCopy).toBeNull();
  });
});

describe("resultsWindow", () => {
  const startedAt = new Date("2026-11-10T15:30:00.000Z");

  it("starts at the UTC midnight of the start day and is open-ended while running", () => {
    const w = resultsWindow({ startedAt, endedAt: null }, Date.parse("2026-01-01T00:00:00Z"));
    expect(w.from.toISOString()).toBe("2026-11-10T00:00:00.000Z");
    expect(w.to).toBeNull();
    expect(w.truncatedByRetention).toBe(false);
  });

  it("ends at the end time of an ended test", () => {
    const endedAt = new Date("2026-11-17T09:00:00.000Z");
    const w = resultsWindow({ startedAt, endedAt }, Date.parse("2026-01-01T00:00:00Z"));
    expect(w.to).toEqual(endedAt);
  });

  it("is clamped to the plan's retention start, and says so", () => {
    const retentionStart = retentionStartFor(7, NOW.getTime()); // 2026-11-11T12:00Z
    const w = resultsWindow({ startedAt, endedAt: null }, retentionStart);
    expect(w.from.toISOString()).toBe("2026-11-11T12:00:00.000Z");
    expect(w.truncatedByRetention).toBe(true);
  });

  it("utcDayStart floors to UTC midnight", () => {
    expect(utcDayStart(new Date("2026-11-10T23:59:59.999Z")).toISOString()).toBe("2026-11-10T00:00:00.000Z");
  });
});

describe("getExperimentResults", () => {
  const experiment = {
    organizationId: ORG,
    environment: "test" as const,
    campaignAId: A,
    campaignBId: B,
    startedAt: new Date("2026-11-10T15:30:00.000Z"),
    endedAt: null,
  };

  it("sums day rollups for the two arms only, in the experiment's org and environment", async () => {
    const r = createSqlRecorder([
      [
        // postgres-js returns SUM() as strings
        { campaignId: A, impressions: "100", clicks: "40", copies: "20", redemptions: "4" },
        { campaignId: B, impressions: "300", clicks: "90", copies: "60", redemptions: "15" },
      ],
      // revenueSavedByCurrency: minor units per (campaign, currency)
      [
        { group: A, currency: "USD", amountMinor: "12050" },
        { group: A, currency: "INR", amountMinor: "400000" },
        { group: B, currency: "USD", amountMinor: "60000" },
      ],
    ]);

    const res = await getExperimentResults(r.db, experiment, Date.parse("2026-01-01T00:00:00Z"));

    expect(r.queries).toHaveLength(2);
    const q = r.queries[0]!;
    expect(q.sql).toContain('"analytics_rollups"."organization_id" = $');
    expect(q.sql).toContain('"analytics_rollups"."environment" = $');
    expect(q.sql).toContain('"analytics_rollups"."period" = $');
    expect(q.sql).toContain('"analytics_rollups"."campaign_id" in ($');
    expect(q.sql).toContain('"analytics_rollups"."period_start" >= $');
    expect(q.sql).not.toContain('"analytics_rollups"."period_start" <= $');
    expect(q.sql).toContain('group by "analytics_rollups"."campaign_id"');
    expect(q.params).toEqual(
      expect.arrayContaining([ORG, "test", "day", A, B, "2026-11-10T00:00:00.000Z"]),
    );
    // The per-currency query reads the same rows (same filters), grouped by campaign.
    const rev = r.queries[1]!;
    expect(rev.sql).toContain("jsonb_each_text");
    expect(rev.sql).toContain('"analytics_rollups"."organization_id" = $');
    expect(rev.sql).toContain('"analytics_rollups"."environment" = $');
    expect(rev.sql).toContain('"analytics_rollups"."campaign_id" in ($');
    expect(rev.sql).toContain('"analytics_rollups"."period_start" >= $');
    expect(rev.params).toEqual(expect.arrayContaining([ORG, "test", "day", A, B, "2026-11-10T00:00:00.000Z"]));

    expect(res.granularity).toBe("day");
    expect(res.from).toBe("2026-11-10T00:00:00.000Z");
    expect(res.to).toBeNull();
    expect(res.a).toMatchObject({
      campaignId: A,
      impressions: 100,
      redemptions: 4,
      revenueSavedByCurrency: { USD: 120.5, INR: 4000 },
      conversionRate: 0.04,
    });
    expect(res.b).toMatchObject({
      campaignId: B,
      impressions: 300,
      redemptions: 15,
      revenueSavedByCurrency: { USD: 600 },
      conversionRate: 0.05,
    });
    expect(res.observedShareB).toBeCloseTo(0.75, 12);
  });

  it("bounds an ended test at its end time and reports zeros for an arm with no rollups", async () => {
    const r = createSqlRecorder([[{ campaignId: A, impressions: "10", clicks: "0", copies: "0", redemptions: "0" }], []]);
    const endedAt = new Date("2026-11-17T09:00:00.000Z");

    const res = await getExperimentResults(r.db, { ...experiment, endedAt }, Date.parse("2026-01-01T00:00:00Z"));

    expect(r.queries[0]!.sql).toContain('"analytics_rollups"."period_start" <= $');
    expect(r.queries[0]!.params).toContain("2026-11-17T09:00:00.000Z");
    expect(r.queries[1]!.sql).toContain('"analytics_rollups"."period_start" <= $');
    expect(res.to).toBe("2026-11-17T09:00:00.000Z");
    expect(res.b).toMatchObject({
      impressions: 0,
      clicks: 0,
      copies: 0,
      redemptions: 0,
      revenueSavedByCurrency: {},
      conversionRate: null,
    });
    expect(res.observedShareB).toBe(0);
  });

  it("answers observedShareB null when neither arm has impressions", async () => {
    const r = createSqlRecorder([[], []]);
    const res = await getExperimentResults(r.db, experiment, 0);
    expect(res.observedShareB).toBeNull();
  });
});

// ── Create ──────────────────────────────────────────────────────────────────

describe("createExperiment", () => {
  it("rejects A === B before touching the database", async () => {
    const r = createSqlRecorder();
    await expectExperimentError(
      createExperiment(r.db, { orgId: ORG, input: { ...input, campaignBId: A }, allowedProductIds: null }),
      400,
      "same_campaign",
    );
    expect(r.queries).toHaveLength(0);
  });

  it("refuses a product that is not in the org (another org's product id), inserting nothing", async () => {
    const r = createSqlRecorder([[]]);
    await expectExperimentError(
      createExperiment(r.db, { orgId: ORG, input, allowedProductIds: null }),
      400,
      "invalid_product",
    );
    expect(r.queries[0]!.sql).toBe(
      'select "id" from "products" where ("products"."id" = $1 and "products"."organization_id" = $2) limit $3',
    );
    expect(r.queries[0]!.params).toEqual([PRODUCT, ORG, 1]);
    expect(r.queries.some((q) => q.sql.startsWith("insert"))).toBe(false);
    expect(r.transactions).toEqual(["rollback"]);
  });

  it("refuses a product-scoped member outside their scope with 403", async () => {
    const r = createSqlRecorder([[{ id: PRODUCT }]]);
    await expectExperimentError(
      createExperiment(r.db, { orgId: ORG, input, allowedProductIds: new Set(["prod_other"]) }),
      403,
      "no_product_access",
    );
    expect(r.queries).toHaveLength(1);
  });

  // Locks are taken in id order here and in assertIntegrationDisconnectKeepsExperiments,
  // so the two cannot deadlock when both arms belong to the integration being disconnected.
  it("looks the arms up in the org only, and locks them FOR UPDATE in id order", async () => {
    const r = createSqlRecorder([[{ id: PRODUCT }], [arm(A), arm(B)], BOTH_BANNERS, [{ id: EXP }]]);
    await createExperiment(r.db, { orgId: ORG, input, allowedProductIds: null, now: NOW });
    const q = r.queries[1]!;
    expect(q.sql).toBe(
      'select "id", "name", "product_id", "environment", "status" from "campaigns" where ("campaigns"."organization_id" = $1 and "campaigns"."id" in ($2, $3)) order by "campaigns"."id" for update',
    );
    expect(q.params).toEqual([ORG, A, B]);
  });

  it("refuses a campaign from another org (it is simply not found in this one)", async () => {
    const r = createSqlRecorder([[{ id: PRODUCT }], [arm(A)]]);
    await expectExperimentError(
      createExperiment(r.db, { orgId: ORG, input, allowedProductIds: null }),
      400,
      "invalid_campaign",
    );
    expect(r.queries.some((q) => q.sql.startsWith("insert"))).toBe(false);
  });

  it("refuses a campaign of another product in the same org", async () => {
    const r = createSqlRecorder([[{ id: PRODUCT }], [arm(A), arm(B, { productId: "prod_2" })]]);
    await expectExperimentError(
      createExperiment(r.db, { orgId: ORG, input, allowedProductIds: null }),
      400,
      "campaign_product_mismatch",
    );
  });

  it("refuses arms in different environments", async () => {
    const r = createSqlRecorder([[{ id: PRODUCT }], [arm(A), arm(B, { environment: "test" })]]);
    await expectExperimentError(
      createExperiment(r.db, { orgId: ORG, input, allowedProductIds: null }),
      400,
      "campaign_environment_mismatch",
    );
  });

  for (const status of ["paused", "draft"]) {
    it(`refuses a ${status} arm with 409 (the banner only serves active campaigns)`, async () => {
      const r = createSqlRecorder([[{ id: PRODUCT }], [arm(A), arm(B, { status })]]);
      await expectExperimentError(
        createExperiment(r.db, { orgId: ORG, input, allowedProductIds: null }),
        409,
        "campaign_not_active",
      );
      expect(r.queries.some((q) => q.sql.startsWith("insert"))).toBe(false);
    });
  }

  it("refuses an arm without a banner config (the banner cannot serve it)", async () => {
    const r = createSqlRecorder([[{ id: PRODUCT }], [arm(A), arm(B)], [{ campaignId: A }]]);
    await expectExperimentError(
      createExperiment(r.db, { orgId: ORG, input, allowedProductIds: null }),
      409,
      "campaign_not_servable",
    );
    expect(r.queries[2]!.sql).toBe(
      'select "campaign_id" from "banner_configs" where "banner_configs"."campaign_id" in ($1, $2)',
    );
    expect(r.queries.some((q) => q.sql.startsWith("insert"))).toBe(false);
  });

  it("inserts a running experiment in the arms' environment and commits", async () => {
    const r = createSqlRecorder([
      [{ id: PRODUCT }],
      [arm(A, { environment: "test" }), arm(B, { environment: "test" })],
      BOTH_BANNERS,
      [{ id: EXP }],
    ]);
    const row = await createExperiment(r.db, {
      orgId: ORG,
      input: { ...input, trafficSplitB: 30 },
      allowedProductIds: new Set([PRODUCT]),
      now: NOW,
    });
    expect(row).toEqual({ id: EXP });
    expect(r.transactions).toEqual(["commit"]);
    const insert = r.queries[3]!;
    expect(insert.sql).toMatch(/^insert into "experiments" /);
    expect(insert.params).toEqual(
      expect.arrayContaining([ORG, PRODUCT, "test", "Pro plan discount", "running", A, B, 30, NOW.toISOString()]),
    );
    // The arm names are kept on the row, so an ended test still shows them
    // after a campaign is deleted.
    expect(insert.sql).toContain('"campaign_a_name", "campaign_b_name"');
    expect(insert.params).toEqual(expect.arrayContaining(["Control", "Variant"]));
  });

  it("turns the one-running-per-product unique violation into a 409", async () => {
    const r = createSqlRecorder([[{ id: PRODUCT }], [arm(A), arm(B)], BOTH_BANNERS, uniqueViolation()]);
    await expectExperimentError(
      createExperiment(r.db, { orgId: ORG, input, allowedProductIds: null }),
      409,
      "experiment_already_running",
    );
    expect(r.transactions).toEqual(["rollback"]);
  });

  it("recognizes the unique violation when Drizzle wraps the driver error", async () => {
    const wrapped = Object.assign(new Error("Failed query: insert ..."), {
      query: 'insert into "experiments" ...',
      cause: uniqueViolation(),
    });
    const r = createSqlRecorder([[{ id: PRODUCT }], [arm(A), arm(B)], BOTH_BANNERS, wrapped]);
    await expectExperimentError(
      createExperiment(r.db, { orgId: ORG, input, allowedProductIds: null }),
      409,
      "experiment_already_running",
    );
  });

  it("propagates any other database error", async () => {
    const r = createSqlRecorder([[{ id: PRODUCT }], new Error("connection reset")]);
    await expect(createExperiment(r.db, { orgId: ORG, input, allowedProductIds: null })).rejects.toThrow(
      "connection reset",
    );
  });
});

// ── Read ────────────────────────────────────────────────────────────────────

const row = (over: Record<string, unknown> = {}) => ({
  id: EXP,
  organizationId: ORG,
  productId: PRODUCT,
  environment: "live",
  name: "Pro plan discount",
  status: "running",
  campaignAId: A,
  campaignBId: B,
  campaignAName: "Control",
  campaignBName: "Variant",
  trafficSplitB: 50,
  winnerCampaignId: null,
  startedAt: NOW,
  endedAt: null,
  createdAt: NOW,
  updatedAt: NOW,
  ...over,
});

describe("listExperiments", () => {
  it("scopes to the org, applies every filter, and attaches arm names from the same org", async () => {
    const r = createSqlRecorder([
      [row()],
      [
        { id: A, name: "Control", status: "active" },
        { id: B, name: "Variant", status: "active" },
      ],
    ]);

    const list = await listExperiments(
      r.db,
      ORG,
      { productId: PRODUCT, campaignId: B, environment: "live", status: "running" },
      null,
    );

    expect(r.queries[0]!.sql).toBe(
      'select "id", "organization_id", "product_id", "environment", "name", "status", "campaign_a_id", "campaign_b_id", "campaign_a_name", "campaign_b_name", "traffic_split_b", "winner_campaign_id", "started_at", "ended_at", "created_at", "updated_at" from "experiments" where ("experiments"."organization_id" = $1 and "experiments"."product_id" = $2 and "experiments"."environment" = $3 and "experiments"."status" = $4 and ("experiments"."campaign_a_id" = $5 or "experiments"."campaign_b_id" = $6)) order by "experiments"."created_at" desc',
    );
    expect(r.queries[0]!.params).toEqual([ORG, PRODUCT, "live", "running", B, B]);
    expect(r.queries[1]!.sql).toBe(
      'select "id", "name", "status" from "campaigns" where ("campaigns"."organization_id" = $1 and "campaigns"."id" in ($2, $3))',
    );
    expect(list).toHaveLength(1);
    expect(list[0]!.campaignA).toEqual({ id: A, name: "Control", status: "active" });
    expect(list[0]!.campaignB).toEqual({ id: B, name: "Variant", status: "active" });
  });

  it("restricts a product-scoped member to their products", async () => {
    const r = createSqlRecorder([[]]);
    await listExperiments(r.db, ORG, {}, new Set([PRODUCT]));
    expect(r.queries[0]!.sql).toContain('"experiments"."product_id" in ($2)');
    expect(r.queries[0]!.params).toEqual([ORG, PRODUCT]);
    expect(r.queries).toHaveLength(1); // no rows, no arm lookup
  });

  it("answers [] without a query for a scoped member with no products", async () => {
    const r = createSqlRecorder();
    expect(await listExperiments(r.db, ORG, {}, new Set())).toEqual([]);
    expect(r.queries).toHaveLength(0);
  });
});

describe("getExperiment", () => {
  it("looks the experiment up by id AND org", async () => {
    const r = createSqlRecorder([[]]);
    expect(await getExperiment(r.db, ORG, EXP, null)).toBeNull();
    expect(r.queries[0]!.sql).toContain('where ("experiments"."id" = $1 and "experiments"."organization_id" = $2) limit $3');
    expect(r.queries[0]!.params).toEqual([EXP, ORG, 1]);
  });

  it("hides an experiment of a product outside a scoped member's access", async () => {
    const r = createSqlRecorder([[row()]]);
    expect(await getExperiment(r.db, ORG, EXP, new Set(["prod_other"]))).toBeNull();
    expect(r.queries).toHaveLength(1);
  });

  it("returns the row with its arms", async () => {
    const r = createSqlRecorder([[row()], [{ id: A, name: "Control", status: "active" }]]);
    const exp = await getExperiment(r.db, ORG, EXP, new Set([PRODUCT]));
    expect(exp?.campaignA?.name).toBe("Control");
    expect(exp?.campaignB).toBeNull();
  });
});

// ── Update ──────────────────────────────────────────────────────────────────

describe("updateExperiment", () => {
  it("404s for an id outside the org", async () => {
    const r = createSqlRecorder([[]]);
    await expectExperimentError(
      updateExperiment(r.db, { orgId: ORG, experimentId: EXP, input: { name: "x" }, allowedProductIds: null }),
      404,
      "not_found",
    );
    expect(r.queries.some((q) => q.sql.startsWith("update"))).toBe(false);
  });

  it("404s for a scoped member outside the product", async () => {
    const r = createSqlRecorder([[{ productId: PRODUCT, status: "running" }]]);
    await expectExperimentError(
      updateExperiment(r.db, { orgId: ORG, experimentId: EXP, input: { name: "x" }, allowedProductIds: new Set() }),
      404,
      "not_found",
    );
  });

  it("refuses a split change on an ended test with 409", async () => {
    const r = createSqlRecorder([[{ productId: PRODUCT, status: "ended" }]]);
    await expectExperimentError(
      updateExperiment(r.db, { orgId: ORG, experimentId: EXP, input: { trafficSplitB: 20 }, allowedProductIds: null }),
      409,
      "experiment_ended",
    );
    expect(r.queries.some((q) => q.sql.startsWith("update"))).toBe(false);
  });

  it("renames an ended test", async () => {
    const r = createSqlRecorder([[{ productId: PRODUCT, status: "ended" }], [row({ name: "Renamed", status: "ended" })]]);
    const out = await updateExperiment(r.db, {
      orgId: ORG,
      experimentId: EXP,
      input: { name: "Renamed" },
      allowedProductIds: null,
      now: NOW,
    });
    expect(out.name).toBe("Renamed");
    expect(r.queries[1]!.sql).toBe(
      'update "experiments" set "name" = $1, "updated_at" = $2 where ("experiments"."id" = $3 and "experiments"."organization_id" = $4) returning "id", "organization_id", "product_id", "environment", "name", "status", "campaign_a_id", "campaign_b_id", "campaign_a_name", "campaign_b_name", "traffic_split_b", "winner_campaign_id", "started_at", "ended_at", "created_at", "updated_at"',
    );
  });

  it("changes the split only where the test is still running, and 409s if it ended meanwhile", async () => {
    const r = createSqlRecorder([[{ productId: PRODUCT, status: "running" }], []]);
    await expectExperimentError(
      updateExperiment(r.db, { orgId: ORG, experimentId: EXP, input: { trafficSplitB: 20 }, allowedProductIds: null }),
      409,
      "experiment_ended",
    );
    expect(r.queries[1]!.sql).toContain(
      'where ("experiments"."id" = $3 and "experiments"."organization_id" = $4 and "experiments"."status" = $5)',
    );
    expect(r.queries[1]!.params.slice(0, 5)).toEqual([20, expect.any(String), EXP, ORG, "running"]);
  });
});

// ── End ─────────────────────────────────────────────────────────────────────

describe("endExperiment", () => {
  const end = (r: ReturnType<typeof createSqlRecorder>, winnerCampaignId: string, allowedProductIds: Set<string> | null = null) =>
    endExperiment(r.db, { orgId: ORG, experimentId: EXP, winnerCampaignId, allowedProductIds, now: NOW });

  it("locks the experiment row, scoped to the org", async () => {
    const r = createSqlRecorder([[]]);
    await expectExperimentError(end(r, A), 404, "not_found");
    expect(r.queries[0]!.sql).toMatch(
      /from "experiments" where \("experiments"."id" = \$1 and "experiments"."organization_id" = \$2\) limit \$3 for update$/,
    );
    expect(r.transactions).toEqual(["rollback"]);
  });

  it("404s for a scoped member outside the product", async () => {
    const r = createSqlRecorder([[row()]]);
    await expectExperimentError(end(r, A, new Set(["prod_other"])), 404, "not_found");
  });

  it("409s when the test already ended, changing nothing", async () => {
    const r = createSqlRecorder([[row({ status: "ended" })]]);
    await expectExperimentError(end(r, A), 409, "experiment_ended");
    expect(r.queries).toHaveLength(1);
  });

  it("400s for a winner that is not one of the two arms", async () => {
    const r = createSqlRecorder([[row()]]);
    await expectExperimentError(end(r, "01JSOMEOTHERCAMPAIGNXXXXXX"), 400, "invalid_winner");
    expect(r.queries).toHaveLength(1);
  });

  it("pauses the loser (only if active, only in the org), records the winner, and commits", async () => {
    const r = createSqlRecorder([[row()], [{ id: A }], [row({ status: "ended", winnerCampaignId: B, endedAt: NOW })]]);

    const out = await end(r, B);

    expect(r.transactions).toEqual(["commit"]);
    expect(out.pausedCampaignId).toBe(A);
    expect(out.experiment).toMatchObject({ status: "ended", winnerCampaignId: B });
    expect(r.queries[1]!.sql).toBe(
      'update "campaigns" set "status" = $1, "updated_at" = $2 where ("campaigns"."id" = $3 and "campaigns"."organization_id" = $4 and "campaigns"."status" = $5) returning "id"',
    );
    expect(r.queries[1]!.params).toEqual(["paused", NOW.toISOString(), A, ORG, "active"]);
    expect(r.queries[2]!.sql).toMatch(
      /^update "experiments" set "status" = \$1, "winner_campaign_id" = \$2, "ended_at" = \$3, "updated_at" = \$4 where \("experiments"."id" = \$5 and "experiments"."organization_id" = \$6\)/,
    );
    expect(r.queries[2]!.params).toEqual(["ended", B, NOW.toISOString(), NOW.toISOString(), EXP, ORG]);
    // The winner is never touched.
    expect(r.queries.some((q) => q.sql.startsWith('update "campaigns"') && q.params.includes(B))).toBe(false);
  });

  it("reports pausedCampaignId null when the loser was not active", async () => {
    const r = createSqlRecorder([[row()], [], [row({ status: "ended", winnerCampaignId: A })]]);
    const out = await end(r, A);
    expect(out.pausedCampaignId).toBeNull();
    expect(r.queries[1]!.params).toContain(B);
  });
});

// ── Campaign guards ─────────────────────────────────────────────────────────

describe("campaignUpdateBlockedByExperiment", () => {
  const running = { id: EXP, name: "Pro plan discount", productId: PRODUCT, environment: "live" };

  it("runs no query for updates that cannot break a test", async () => {
    const r = createSqlRecorder();
    expect(await campaignUpdateBlockedByExperiment(r.db, ORG, A, { status: "active" })).toBeNull();
    expect(await campaignUpdateBlockedByExperiment(r.db, ORG, A, {})).toBeNull();
    expect(r.queries).toHaveLength(0);
  });

  for (const status of ["paused", "draft"]) {
    it(`refuses status '${status}' for an arm of a running test`, async () => {
      const r = createSqlRecorder([[running]]);
      const conflict = await campaignUpdateBlockedByExperiment(r.db, ORG, A, { status });
      expect(conflict).toMatchObject({ code: "campaign_in_running_experiment", experimentId: EXP });
      expect(conflict!.error).toContain("End the test");
      expect(r.queries[0]!.sql).toBe(
        'select "id", "name", "product_id", "environment" from "experiments" where ("experiments"."organization_id" = $1 and "experiments"."status" = $2 and ("experiments"."campaign_a_id" = $3 or "experiments"."campaign_b_id" = $4)) limit $5',
      );
      expect(r.queries[0]!.params).toEqual([ORG, "running", A, A, 1]);
    });
  }

  it("refuses moving an arm to another product or environment, allows the same values", async () => {
    let r = createSqlRecorder([[running]]);
    expect(await campaignUpdateBlockedByExperiment(r.db, ORG, A, { productId: "prod_2" })).not.toBeNull();
    r = createSqlRecorder([[running]]);
    expect(await campaignUpdateBlockedByExperiment(r.db, ORG, A, { environment: "test" })).not.toBeNull();
    r = createSqlRecorder([[running]]);
    expect(await campaignUpdateBlockedByExperiment(r.db, ORG, A, { productId: PRODUCT, environment: "live" })).toBeNull();
  });

  it("allows pausing a campaign that is in no running test", async () => {
    const r = createSqlRecorder([[]]);
    expect(await campaignUpdateBlockedByExperiment(r.db, ORG, A, { status: "paused" })).toBeNull();
  });
});

describe("assertCampaignNotInRunningExperiment", () => {
  const lockSql =
    'select "id" from "campaigns" where ("campaigns"."id" = $1 and "campaigns"."organization_id" = $2) for update';

  it("locks the campaign row in the org first, then throws a 409 body for an arm of a running test", async () => {
    const r = createSqlRecorder([[{ id: B }], [{ id: EXP, name: "Pro plan discount", productId: PRODUCT, environment: "live" }]]);
    const err = await assertCampaignNotInRunningExperiment(r.db, ORG, B).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(CampaignInRunningExperimentError);
    expect((err as CampaignInRunningExperimentError).body).toMatchObject({
      code: "campaign_in_running_experiment",
      experimentId: EXP,
    });
    expect(r.queries[0]!.sql).toBe(lockSql);
    expect(r.queries[0]!.params).toEqual([B, ORG]);
    expect(r.queries[1]!.params).toEqual([ORG, "running", B, B, 1]);
  });

  it("allows the delete when only ended tests used the campaign, and deletes nothing itself", async () => {
    const r = createSqlRecorder([[{ id: B }], []]);
    await expect(assertCampaignNotInRunningExperiment(r.db, ORG, B)).resolves.toBeUndefined();
    expect(r.queries).toHaveLength(2);
    expect(r.queries.some((q) => !q.sql.startsWith("select"))).toBe(false);
  });
});

describe("assertIntegrationDisconnectKeepsExperiments", () => {
  it("locks the integration's active auto-apply campaigns, then looks for a running test using one", async () => {
    const r = createSqlRecorder([[{ id: A }], []]);
    await expect(assertIntegrationDisconnectKeepsExperiments(r.db, ORG, "int_1")).resolves.toBeUndefined();
    // The lock serializes with createExperiment (which locks its arms FOR
    // UPDATE): a test started concurrently is either seen here or cannot
    // start on a campaign the disconnect is about to pause.
    expect(r.queries[0]!.sql).toBe(
      'select "id" from "campaigns" where ("campaigns"."organization_id" = $1 and "campaigns"."integration_id" = $2 and "campaigns"."status" = $3 and "campaigns"."discount_delivery" = $4) order by "campaigns"."id" for update',
    );
    expect(r.queries[0]!.params).toEqual([ORG, "int_1", "active", "auto_apply"]);
    expect(r.queries[1]!.sql).toBe(
      'select "experiments"."id", "experiments"."name" from "experiments" inner join "campaigns" on ("campaigns"."id" = "experiments"."campaign_a_id" or "campaigns"."id" = "experiments"."campaign_b_id") where ("experiments"."organization_id" = $1 and "experiments"."status" = $2 and "campaigns"."organization_id" = $3 and "campaigns"."integration_id" = $4 and "campaigns"."status" = $5 and "campaigns"."discount_delivery" = $6) limit $7',
    );
    expect(r.queries[1]!.params).toEqual([ORG, "running", ORG, "int_1", "active", "auto_apply", 1]);
  });

  it("throws a 409 body naming the test when the disconnect would pause an arm", async () => {
    const r = createSqlRecorder([[{ id: A }], [{ id: EXP, name: "Pro plan discount" }]]);
    const err = await assertIntegrationDisconnectKeepsExperiments(r.db, ORG, "int_1").then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(IntegrationInRunningExperimentError);
    expect((err as IntegrationInRunningExperimentError).body).toMatchObject({
      code: "integration_in_running_experiment",
      experimentId: EXP,
    });
  });
});
