import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createTestClient, mountRoutes, type InjectedMember } from "../test/helpers";
import { createSqlRecorder, type SqlRecorder } from "../lib/sql-recorder-test-helpers";

// Route tests for /v1/teams/:orgId/experiments. No database: createDb() returns
// a recorder that builds the real Drizzle SQL and answers with canned rows.
// The service's statement shapes are pinned in experiment.service.test.ts;
// these pin HTTP behaviour: validation, status codes, error bodies, member
// scoping and the banner KV rebuild. Postgres-backed: experiments.integration.test.ts.

const state = vi.hoisted(() => ({
  recorder: null as unknown as SqlRecorder,
  pushes: [] as unknown[][],
  retentionDays: 365,
  // getAllowedProductIds result: null = all products (owner/admin/unscoped member).
  allowed: null as Set<string> | null,
}));
vi.mock("../db", () => ({ createDb: () => state.recorder.db }));
vi.mock("../services/banner-cache.service", () => ({
  pushBannerConfigForOrg: async (...args: unknown[]) => {
    state.pushes.push(args);
  },
}));
vi.mock("../lib/limits", () => ({ getOrgRetentionDays: async () => state.retentionDays }));
// Product scoping is authz-audit's (lib/product-access.ts); stub only the
// lookup so these tests do not depend on its query shape. canAccessProduct
// stays real.
vi.mock("../lib/product-access", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/product-access")>()),
  getAllowedProductIds: async () => state.allowed,
  allowedProductIdsFor: async () => state.allowed,
}));

const { default: experimentsRoute } = await import("./experiments");

const ORG = "org_a";
const PRODUCT = "prod_1";
const A = "01JCAMPAIGNAAAAAAAAAAAAAAA";
const B = "01JCAMPAIGNBBBBBBBBBBBBBBB";
const EXP = "01JEXPERIMENTXXXXXXXXXXXXX";
const owner: InjectedMember = { userId: "u_owner", role: "owner" };
const member: InjectedMember = { userId: "u_member", role: "member" };

const arm = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  name: id === A ? "Control" : "Variant",
  productId: PRODUCT,
  environment: "live",
  status: "active",
  ...over,
});
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
  startedAt: new Date("2026-11-10T15:30:00.000Z"),
  endedAt: null,
  createdAt: new Date("2026-11-10T15:30:00.000Z"),
  updatedAt: new Date("2026-11-10T15:30:00.000Z"),
  ...over,
});
const valid = { productId: PRODUCT, campaignAId: A, campaignBId: B, name: "Pro plan discount" };

function client(who: InjectedMember = owner) {
  return createTestClient(mountRoutes(experimentsRoute, who));
}

beforeEach(() => {
  state.pushes = [];
  state.retentionDays = 365;
  state.allowed = null;
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("POST /v1/teams/:orgId/experiments", () => {
  const post = (json: unknown, who: InjectedMember = owner) =>
    client(who).request(`/v1/teams/${ORG}/experiments`, { method: "POST", json });

  it.each([
    ["missing campaign B", { productId: PRODUCT, campaignAId: A, name: "x" }],
    ["empty name", { ...valid, name: "   " }],
    ["split 0", { ...valid, trafficSplitB: 0 }],
    ["split 100", { ...valid, trafficSplitB: 100 }],
    ["fractional split", { ...valid, trafficSplitB: 33.5 }],
    ["same campaign twice", { ...valid, campaignBId: A }],
  ])("400s on %s without touching the database", async (_label, json) => {
    state.recorder = createSqlRecorder();
    const res = await post(json);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Validation failed");
    expect(state.recorder.queries).toHaveLength(0);
    expect(state.pushes).toHaveLength(0);
  });

  it("400s on a body that is not JSON", async () => {
    state.recorder = createSqlRecorder();
    const res = await client().request(`/v1/teams/${ORG}/experiments`, {
      method: "POST",
      body: "not json",
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(400);
  });

  it("creates with the default 50/50 split, answers 201 and rebuilds the banner config", async () => {
    state.recorder = createSqlRecorder([[{ id: PRODUCT }], [arm(A), arm(B)], [{ campaignId: A }, { campaignId: B }], [row()]]);
    const c = client();
    const res = await c.request(`/v1/teams/${ORG}/experiments`, { method: "POST", json: valid });

    expect(res.status).toBe(201);
    expect((await res.json()).data.id).toBe(EXP);
    const insert = state.recorder.queries.find((q) => q.sql.startsWith('insert into "experiments"'))!;
    expect(insert.params).toContain(50);
    expect(state.pushes).toHaveLength(1);
    const [, kv, orgId, env] = state.pushes[0]!;
    expect(kv).toBe(c.env.CACHE);
    expect(orgId).toBe(ORG);
    expect(env).toBe(c.env);
  });

  it("400s when a campaign belongs to another org, and does not rebuild the banner", async () => {
    state.recorder = createSqlRecorder([[{ id: PRODUCT }], [arm(A)]]);
    const res = await post(valid);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Both campaigns must belong to this organization", code: "invalid_campaign" });
    expect(state.pushes).toHaveLength(0);
  });

  it("400s when a campaign belongs to another product", async () => {
    state.recorder = createSqlRecorder([[{ id: PRODUCT }], [arm(A), arm(B, { productId: "prod_2" })]]);
    const res = await post(valid);
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("campaign_product_mismatch");
  });

  it("409s when an arm is not active", async () => {
    state.recorder = createSqlRecorder([[{ id: PRODUCT }], [arm(A), arm(B, { status: "paused" })]]);
    const res = await post(valid);
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("campaign_not_active");
  });

  it("409s with a clear message when the product already has a running test", async () => {
    const dup = Object.assign(new Error("duplicate key value violates unique constraint"), { code: "23505" });
    state.recorder = createSqlRecorder([[{ id: PRODUCT }], [arm(A), arm(B)], [{ campaignId: A }, { campaignId: B }], dup]);
    const res = await post(valid);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("experiment_already_running");
    expect(body.error).toMatch(/already has a running A\/B test/);
    expect(state.pushes).toHaveLength(0);
  });

  it("403s a product-scoped member creating a test on a product outside their scope", async () => {
    state.allowed = new Set(["prod_other"]);
    state.recorder = createSqlRecorder([[{ id: PRODUCT }]]);
    const res = await post(valid, member);
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("no_product_access");
  });

  it("500s (generic message, no detail) on an unexpected database error", async () => {
    state.recorder = createSqlRecorder([new Error("connection reset")]);
    const res = await post(valid);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Failed to create experiment" });
  });
});

describe("GET /v1/teams/:orgId/experiments", () => {
  it("400s on an unknown environment or status filter", async () => {
    state.recorder = createSqlRecorder();
    expect((await client().request(`/v1/teams/${ORG}/experiments?environment=prod`)).status).toBe(400);
    expect((await client().request(`/v1/teams/${ORG}/experiments?status=paused`)).status).toBe(400);
    expect(state.recorder.queries).toHaveLength(0);
  });

  it("passes productId, campaignId, environment and status through to an org-scoped query", async () => {
    state.recorder = createSqlRecorder([[row()], [{ id: A, name: "Control", status: "active" }, { id: B, name: "Variant", status: "active" }]]);
    const res = await client().request(
      `/v1/teams/${ORG}/experiments?productId=${PRODUCT}&campaignId=${A}&environment=live&status=running`,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(1);
    expect(body.data[0].campaignA.name).toBe("Control");
    expect(state.recorder.queries[0]!.params).toEqual([ORG, PRODUCT, "live", "running", A, A]);
  });

  it("limits a product-scoped member to their products", async () => {
    state.allowed = new Set([PRODUCT]);
    state.recorder = createSqlRecorder([[]]);
    const res = await client(member).request(`/v1/teams/${ORG}/experiments`);
    expect(res.status).toBe(200);
    expect(state.recorder.queries[0]!.sql).toContain('"experiments"."product_id" in ($2)');
  });
});

describe("GET /v1/teams/:orgId/experiments/:id", () => {
  it("404s for an experiment not in the org", async () => {
    state.recorder = createSqlRecorder([[]]);
    const res = await client().request(`/v1/teams/${ORG}/experiments/${EXP}`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Experiment not found" });
  });

  it("404s for a scoped member outside the experiment's product", async () => {
    state.allowed = new Set(["prod_other"]);
    state.recorder = createSqlRecorder([[row()]]);
    const res = await client(member).request(`/v1/teams/${ORG}/experiments/${EXP}`);
    expect(res.status).toBe(404);
  });

  it("returns the experiment with per-arm results", async () => {
    state.recorder = createSqlRecorder([
      [row()],
      [
        { id: A, name: "Control", status: "active" },
        { id: B, name: "Variant", status: "active" },
      ],
      [
        { campaignId: A, impressions: "5100", clicks: "0", copies: "1428", redemptions: "204" },
        { campaignId: B, impressions: "5080", clicks: "0", copies: "1524", redemptions: "279" },
      ],
      [
        { group: A, currency: "USD", amountMinor: "612000" },
        { group: B, currency: "EUR", amountMinor: "1116000" },
      ],
    ]);
    const res = await client().request(`/v1/teams/${ORG}/experiments/${EXP}`);
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data.id).toBe(EXP);
    expect(data.results.granularity).toBe("day");
    expect(data.results.from).toBe("2026-11-10T00:00:00.000Z");
    expect(data.results.a.conversionRate).toBeCloseTo(0.04, 12);
    expect(data.results.b.conversionRate).toBeCloseTo(279 / 5080, 12);
    expect(data.results.a.revenueSavedByCurrency).toEqual({ USD: 6120 });
    expect(data.results.b.revenueSavedByCurrency).toEqual({ EUR: 11160 });
    expect(data.results.truncatedByRetention).toBe(false);
    expect(data.campaignA).toEqual({ id: A, name: "Control", status: "active" });
  });

  it("keeps an ended test, its arm names and its results after an arm's campaign was deleted", async () => {
    const endedAt = new Date("2026-11-17T09:00:00.000Z");
    state.recorder = createSqlRecorder([
      [row({ status: "ended", winnerCampaignId: B, endedAt })],
      [{ id: B, name: "Variant", status: "active" }], // campaign A no longer exists
      [{ campaignId: A, impressions: "50", clicks: "0", copies: "5", redemptions: "1" }],
      [],
    ]);
    const res = await client().request(`/v1/teams/${ORG}/experiments/${EXP}`);
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data.campaignA).toBeNull();
    expect(data.campaignAName).toBe("Control");
    expect(data.campaignAId).toBe(A);
    expect(data.results.a).toMatchObject({ campaignId: A, impressions: 50, redemptions: 1 });
  });

  it("clamps results to the plan's analytics retention", async () => {
    state.retentionDays = 1;
    state.recorder = createSqlRecorder([[row()], [], [], []]);
    const res = await client().request(`/v1/teams/${ORG}/experiments/${EXP}`);
    const { data } = await res.json();
    expect(data.results.truncatedByRetention).toBe(true);
    expect(Date.parse(data.results.from)).toBeGreaterThan(Date.parse("2026-11-10T00:00:00.000Z"));
  });
});

describe("PATCH /v1/teams/:orgId/experiments/:id", () => {
  const patch = (json: unknown) =>
    client().request(`/v1/teams/${ORG}/experiments/${EXP}`, { method: "PATCH", json });

  it("400s on an empty update or an out-of-range split", async () => {
    state.recorder = createSqlRecorder();
    expect((await patch({})).status).toBe(400);
    expect((await patch({ trafficSplitB: 0 })).status).toBe(400);
    expect((await patch({ trafficSplitB: 99.5 })).status).toBe(400);
    expect(state.recorder.queries).toHaveLength(0);
  });

  it("changes the split while running and rebuilds the banner config", async () => {
    state.recorder = createSqlRecorder([[{ productId: PRODUCT, status: "running" }], [row({ trafficSplitB: 20 })]]);
    const res = await patch({ trafficSplitB: 20 });
    expect(res.status).toBe(200);
    expect((await res.json()).data.trafficSplitB).toBe(20);
    expect(state.pushes).toHaveLength(1);
  });

  it("does not rebuild the banner config for a rename", async () => {
    state.recorder = createSqlRecorder([[{ productId: PRODUCT, status: "running" }], [row({ name: "New" })]]);
    const res = await patch({ name: "New" });
    expect(res.status).toBe(200);
    expect(state.pushes).toHaveLength(0);
  });

  it("409s a split change on an ended test", async () => {
    state.recorder = createSqlRecorder([[{ productId: PRODUCT, status: "ended" }]]);
    const res = await patch({ trafficSplitB: 20 });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("experiment_ended");
  });

  it("404s for an experiment not in the org", async () => {
    state.recorder = createSqlRecorder([[]]);
    expect((await patch({ name: "x" })).status).toBe(404);
  });
});

describe("POST /v1/teams/:orgId/experiments/:id/end", () => {
  const endTest = (json: unknown) =>
    client().request(`/v1/teams/${ORG}/experiments/${EXP}/end`, { method: "POST", json });

  it("400s without a winner", async () => {
    state.recorder = createSqlRecorder();
    expect((await endTest({})).status).toBe(400);
  });

  it("400s for a winner that is not an arm", async () => {
    state.recorder = createSqlRecorder([[row()]]);
    const res = await endTest({ winnerCampaignId: "01JSOMEOTHERCAMPAIGNXXXXXX" });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("invalid_winner");
    expect(state.pushes).toHaveLength(0);
  });

  it("ends the test, pauses the loser and rebuilds the banner config", async () => {
    state.recorder = createSqlRecorder([
      [row()],
      [{ id: A }],
      [row({ status: "ended", winnerCampaignId: B, endedAt: new Date() })],
    ]);
    const res = await endTest({ winnerCampaignId: B });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.status).toBe("ended");
    expect(body.data.winnerCampaignId).toBe(B);
    expect(body.pausedCampaignId).toBe(A);
    expect(state.recorder.transactions).toEqual(["commit"]);
    expect(state.pushes).toHaveLength(1);
  });

  it("409s when the test already ended", async () => {
    state.recorder = createSqlRecorder([[row({ status: "ended" })]]);
    const res = await endTest({ winnerCampaignId: A });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("experiment_ended");
  });
});
