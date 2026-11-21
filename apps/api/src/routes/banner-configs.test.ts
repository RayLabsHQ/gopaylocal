import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import { createTestClient, mountRoutes, type InjectedMember } from "../test/helpers";
import { createSqlRecorder, type SqlRecorder } from "../lib/sql-recorder-test-helpers";

// PUT /v1/teams/:orgId/banner-configs/:campaignId is what the dashboard's
// banner editor calls. Visitors only see a new design once the precomputed
// banner config in KV is rebuilt, so these tests pin that a successful save
// hands pushBannerConfigForOrg to waitUntil, and that a refused one does not.
// No database: createDb() returns a recorder that builds the real Drizzle SQL
// and answers with canned rows.

const state = vi.hoisted(() => ({
  recorder: null as unknown as SqlRecorder,
  push: null as unknown as Mock<(...args: unknown[]) => Promise<void>>,
}));
vi.mock("../db", () => ({ createDb: () => state.recorder.db }));
vi.mock("../services/banner-cache.service", () => ({
  pushBannerConfigForOrg: (...args: unknown[]) => state.push(...args),
}));

const { default: bannerConfigsRoute } = await import("./banner-configs");

const ORG_A = "org_a";
const CAMPAIGN = "01JCAMPAIGNBBBBBBBBBBBBBBB";
const PATH = `/v1/teams/${ORG_A}/banner-configs/${CAMPAIGN}`;
const CAMPAIGN_ROW = { id: CAMPAIGN, organizationId: ORG_A, productId: "p1" };
const SAVED = {
  id: "01JBANNERCCCCCCCCCCCCCCCCC",
  campaignId: CAMPAIGN,
  position: "top",
  messageTemplate: "{{discount}}% off in {{countryName}}",
  ctaText: "Copy Code",
  backgroundColor: "#1a1a2e",
  textColor: "#ffffff",
  ctaColor: "#e94560",
  ctaTextColor: "#ffffff",
  showFlag: true,
  showCloseBtn: false,
};

function put(json: unknown, member: InjectedMember = { userId: "u_a", role: "owner" }) {
  const client = createTestClient(mountRoutes(bannerConfigsRoute, member));
  return { client, res: client.request(PATH, { method: "PUT", json }) };
}

beforeEach(() => {
  state.push = vi.fn(async (..._args: unknown[]) => {});
});

describe("PUT /v1/teams/:orgId/banner-configs/:campaignId", () => {
  it("saves and rebuilds the org's banner cache so visitors get the new design", async () => {
    state.recorder = createSqlRecorder([[CAMPAIGN_ROW], [SAVED]]);
    const { client, res } = put({ position: "top", showCloseBtn: false });

    const r = await res;
    expect(r.status).toBe(200);
    expect((await r.json()).data).toMatchObject({ position: "top", showCloseBtn: false });

    // The update writes only the fields sent (plus updatedAt), for this campaign.
    const update = state.recorder.queries.find((q) => q.sql.startsWith("update"))!;
    expect(update.sql).toMatch(
      /^update "banner_configs" set "position" = \$1, "show_close_btn" = \$2, "updated_at" = \$3 where "banner_configs"."campaign_id" = \$4 returning/,
    );
    expect(update.params.slice(0, 2)).toEqual(["top", false]);
    expect(update.params[3]).toBe(CAMPAIGN);

    expect(state.push).toHaveBeenCalledTimes(1);
    const [db, kv, orgId, env] = state.push.mock.calls[0]!;
    expect(db).toBe(state.recorder.db);
    expect(kv).toBe(client.env.CACHE);
    expect(orgId).toBe(ORG_A);
    expect(env).toBe(client.env);
  });

  it("answers 200 even when the cache rebuild fails (it runs after the response)", async () => {
    state.recorder = createSqlRecorder([[CAMPAIGN_ROW], [SAVED]]);
    state.push = vi.fn(async (..._args: unknown[]) => {
      throw new Error("KV unavailable");
    });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    const r = await put({ ctaText: "Get the deal" }).res;

    expect(r.status).toBe(200);
    expect(state.push).toHaveBeenCalledTimes(1);
    errors.mockRestore();
  });

  it("rejects an invalid body with 400 before touching the database or the cache", async () => {
    state.recorder = createSqlRecorder([]);

    const r = await put({ position: "middle", ctaText: "" }).res;

    expect(r.status).toBe(400);
    const body = await r.json();
    expect(body.error).toBe("Validation failed");
    expect(Object.keys(body.details.fieldErrors).sort()).toEqual(["ctaText", "position"]);
    expect(state.recorder.queries).toHaveLength(0);
    expect(state.push).not.toHaveBeenCalled();
  });

  it("answers 404 and rebuilds nothing for a campaign outside the org", async () => {
    state.recorder = createSqlRecorder([[]]);

    const r = await put({ position: "top" }).res;

    expect(r.status).toBe(404);
    expect(state.recorder.queries.some((q) => q.sql.startsWith("update"))).toBe(false);
    expect(state.push).not.toHaveBeenCalled();
  });

  it("answers 404 and rebuilds nothing for a member whose product scope excludes the campaign", async () => {
    // Membership row: scoped to specific products, none of them p1.
    state.recorder = createSqlRecorder([[CAMPAIGN_ROW], [{ memberId: "m1", allProducts: false, productId: "p2" }]]);

    const r = await put({ position: "top" }, { userId: "u_m", role: "member" }).res;

    expect(r.status).toBe(404);
    expect(state.recorder.queries.some((q) => q.sql.startsWith("update"))).toBe(false);
    expect(state.push).not.toHaveBeenCalled();
  });

  it("lets a member save the banner of a campaign in their product scope, and rebuilds the cache", async () => {
    state.recorder = createSqlRecorder([
      [CAMPAIGN_ROW],
      [{ memberId: "m1", allProducts: false, productId: "p1" }],
      [SAVED],
    ]);

    const r = await put({ textColor: "#000000" }, { userId: "u_m", role: "member" }).res;

    expect(r.status).toBe(200);
    expect(state.push).toHaveBeenCalledTimes(1);
  });
});
