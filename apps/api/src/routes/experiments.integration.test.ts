import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { eq } from "drizzle-orm";
import { ulid } from "ulid";
import worker from "../index";
import { analyticsRollups, campaigns, experiments, integrations, organizations, products } from "../db/schema";
import { createTestBindings, createTestClient, type TestClient } from "../test/helpers";
import { as, seedTenant, type TestTenant } from "../test/auth";
import { cleanupTestDb, closeTestDb, getTestDb } from "../test/setup";
import { pgErrorCode } from "../lib/log";

// index.ts pulls in the banner route, which imports the browser bundle as a
// wrangler text module; stub it so browser code never runs under Node.
vi.mock("../../../../packages/banner/dist/banner.js", () => ({ default: "" }));

/**
 * A/B tests through the real Worker and real Postgres: real sessions, the
 * session + team middleware, the experiments routes, the partial unique index
 * `experiments_one_running_idx`, and the campaign/workspace lifecycle guards.
 */

let client: TestClient;
let a: TestTenant;
let b: TestTenant;

function api(tenant: TestTenant, path: string, init: Parameters<TestClient["request"]>[1] = {}) {
  return client.request(`/v1/teams/${tenant.orgId}${path}`, { ...init, headers: as(tenant) });
}

async function createProduct(tenant: TestTenant, name = "Pro Plan"): Promise<string> {
  const res = await api(tenant, "/products", {
    method: "POST",
    json: { name, url: "https://shop.example.com/pricing", basePrice: 99 },
  });
  expect(res.status).toBe(201);
  return (await res.json()).data.id;
}

async function createCampaign(
  tenant: TestTenant,
  productId: string,
  name: string,
  status: "active" | "paused" | "draft" = "active",
): Promise<string> {
  const res = await api(tenant, "/campaigns", { method: "POST", json: { productId, name, status } });
  expect(res.status).toBe(201);
  return (await res.json()).data.id;
}

/** Product + two active campaigns (control, variant) in `tenant`. */
async function setUpArms(tenant: TestTenant) {
  const productId = await createProduct(tenant);
  const campaignAId = await createCampaign(tenant, productId, "Control 30%");
  const campaignBId = await createCampaign(tenant, productId, "Variant 45%");
  return { productId, campaignAId, campaignBId };
}

async function startExperiment(
  tenant: TestTenant,
  arms: { productId: string; campaignAId: string; campaignBId: string },
  extra: Record<string, unknown> = {},
) {
  return api(tenant, "/experiments", { method: "POST", json: { ...arms, name: "India 30 vs 45", ...extra } });
}

async function campaignStatus(id: string) {
  const [row] = await getTestDb().select({ status: campaigns.status }).from(campaigns).where(eq(campaigns.id, id));
  return row?.status;
}

function rollup(orgId: string, campaignId: string, periodStart: Date, counts: Partial<typeof analyticsRollups.$inferInsert>) {
  return {
    id: ulid(),
    organizationId: orgId,
    campaignId,
    countryCode: "IN",
    period: "day",
    periodStart,
    environment: "live" as const,
    ...counts,
  };
}

/** UTC midnight of the day `iso` falls on (the experiment's first results day). */
const utcDayOf = (iso: string) => {
  const d = new Date(iso);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
};

beforeEach(async () => {
  await cleanupTestDb();
  client = createTestClient(worker, createTestBindings());
  a = await seedTenant(client, "Org A");
  b = await seedTenant(client, "Org B");
});

afterAll(async () => {
  await cleanupTestDb();
  await closeTestDb();
});

describe("experiments lifecycle", () => {
  it("creates, lists, reads results, changes the split, and ends with the loser paused", async () => {
    const arms = await setUpArms(a);

    const created = await startExperiment(a, arms);
    expect(created.status).toBe(201);
    const exp = (await created.json()).data;
    expect(exp).toMatchObject({
      organizationId: a.orgId,
      productId: arms.productId,
      environment: "live",
      status: "running",
      campaignAId: arms.campaignAId,
      campaignBId: arms.campaignBId,
      campaignAName: "Control 30%",
      campaignBName: "Variant 45%",
      trafficSplitB: 50,
      winnerCampaignId: null,
      endedAt: null,
    });

    // List, with and without filters.
    const list = await (await api(a, `/experiments?productId=${arms.productId}&status=running`)).json();
    expect(list.data.map((e: { id: string }) => e.id)).toEqual([exp.id]);
    expect(list.data[0].campaignA).toEqual({ id: arms.campaignAId, name: "Control 30%", status: "active" });
    expect((await (await api(a, `/experiments?campaignId=${arms.campaignBId}`)).json()).data).toHaveLength(1);
    expect((await (await api(a, "/experiments?status=ended")).json()).data).toHaveLength(0);
    expect((await (await api(a, "/experiments?environment=test")).json()).data).toHaveLength(0);

    // Results: only day rollups of the two arms, this org, live, from the start day.
    // The start day comes from the row, not the clock, so a run that crosses
    // UTC midnight after the POST still expects the right day.
    const db = getTestDb();
    const today = utcDayOf(exp.startedAt);
    const yesterday = new Date(today.getTime() - 86_400_000);
    await db.insert(analyticsRollups).values([
      rollup(a.orgId, arms.campaignAId, today, {
        impressions: 100,
        clicks: 40,
        copies: 20,
        redemptions: 4,
        revenueSaved: 120,
        revenueSavedByCurrency: { USD: 12000 },
      }),
      { ...rollup(a.orgId, arms.campaignAId, today, { impressions: 50, copies: 8, redemptions: 1 }), countryCode: "BR" },
      rollup(a.orgId, arms.campaignBId, today, {
        impressions: 150,
        clicks: 30,
        copies: 45,
        redemptions: 9,
        revenueSaved: 300,
        revenueSavedByCurrency: { USD: 30000, INR: 900000 },
      }),
      // Excluded: before the start day, test environment, another org.
      rollup(a.orgId, arms.campaignAId, yesterday, { impressions: 999, redemptions: 99 }),
      { ...rollup(a.orgId, arms.campaignBId, today, { impressions: 777 }), countryCode: "DE", environment: "test" as const },
      rollup(b.orgId, arms.campaignBId, today, { impressions: 555 }),
    ]);

    const detail = await api(a, `/experiments/${exp.id}`);
    expect(detail.status).toBe(200);
    const { results } = (await detail.json()).data;
    expect(results.granularity).toBe("day");
    expect(results.from).toBe(today.toISOString());
    expect(results.to).toBeNull();
    expect(results.a).toMatchObject({ impressions: 150, clicks: 40, copies: 28, redemptions: 5 });
    expect(results.a.revenueSavedByCurrency).toEqual({ USD: 120 });
    expect(results.a.conversionRate).toBeCloseTo(5 / 150, 12);
    expect(results.b).toMatchObject({ impressions: 150, clicks: 30, copies: 45, redemptions: 9 });
    // Currencies are reported separately, never added together.
    expect(results.b.revenueSavedByCurrency).toEqual({ USD: 300, INR: 9000 });
    expect(results.observedShareB).toBeCloseTo(0.5, 12);

    // Split change while running.
    const patched = await api(a, `/experiments/${exp.id}`, { method: "PATCH", json: { trafficSplitB: 20 } });
    expect(patched.status).toBe(200);
    expect((await patched.json()).data.trafficSplitB).toBe(20);

    // End with B as the winner: B stays active, A is paused.
    const ended = await api(a, `/experiments/${exp.id}/end`, {
      method: "POST",
      json: { winnerCampaignId: arms.campaignBId },
    });
    expect(ended.status).toBe(200);
    const endBody = await ended.json();
    expect(endBody.data).toMatchObject({ status: "ended", winnerCampaignId: arms.campaignBId });
    expect(endBody.data.endedAt).not.toBeNull();
    expect(endBody.pausedCampaignId).toBe(arms.campaignAId);
    expect(await campaignStatus(arms.campaignAId)).toBe("paused");
    expect(await campaignStatus(arms.campaignBId)).toBe("active");

    // Ended: no second end, no split change, rename still allowed.
    expect((await api(a, `/experiments/${exp.id}/end`, { method: "POST", json: { winnerCampaignId: arms.campaignAId } })).status).toBe(409);
    expect((await api(a, `/experiments/${exp.id}`, { method: "PATCH", json: { trafficSplitB: 30 } })).status).toBe(409);
    expect((await api(a, `/experiments/${exp.id}`, { method: "PATCH", json: { name: "Done" } })).status).toBe(200);

    const after = (await (await api(a, `/experiments/${exp.id}`)).json()).data;
    expect(after.results.to).toBe(endBody.data.endedAt);
  });

  it("refuses arms that cannot serve, or do not match", async () => {
    const productId = await createProduct(a);
    const active = await createCampaign(a, productId, "Active");
    const paused = await createCampaign(a, productId, "Paused", "paused");
    const draft = await createCampaign(a, productId, "Draft", "draft");

    let res = await startExperiment(a, { productId, campaignAId: active, campaignBId: paused });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("campaign_not_active");
    res = await startExperiment(a, { productId, campaignAId: draft, campaignBId: active });
    expect(res.status).toBe(409);

    res = await startExperiment(a, { productId, campaignAId: active, campaignBId: active });
    expect(res.status).toBe(400);

    // Another product of the same org (inserted directly: Free allows one product).
    const otherProductId = ulid();
    await getTestDb().insert(products).values({
      id: otherProductId,
      organizationId: a.orgId,
      name: "Other",
      url: "https://shop.example.com/other",
      basePrice: 10,
    });
    const otherCampaign = ulid();
    await getTestDb().insert(campaigns).values({
      id: otherCampaign,
      organizationId: a.orgId,
      productId: otherProductId,
      name: "Other product campaign",
      status: "active",
    });
    res = await startExperiment(a, { productId, campaignAId: active, campaignBId: otherCampaign });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("campaign_product_mismatch");

    // Different environments.
    const testEnv = ulid();
    await getTestDb().insert(campaigns).values({
      id: testEnv,
      organizationId: a.orgId,
      productId,
      name: "Test env campaign",
      status: "active",
      environment: "test",
    });
    res = await startExperiment(a, { productId, campaignAId: active, campaignBId: testEnv });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("campaign_environment_mismatch");

    expect(await getTestDb().select().from(experiments)).toHaveLength(0);
  });
});

describe("one running experiment per product and environment", () => {
  it("answers 409 for a second running test, and allows a new one after the first ends", async () => {
    const arms = await setUpArms(a);
    const third = await createCampaign(a, arms.productId, "Variant 60%");

    const first = (await (await startExperiment(a, arms)).json()).data;
    const second = await startExperiment(a, { ...arms, campaignBId: third });
    expect(second.status).toBe(409);
    expect((await second.json()).code).toBe("experiment_already_running");

    await api(a, `/experiments/${first.id}/end`, { method: "POST", json: { winnerCampaignId: arms.campaignAId } });
    // B was paused by the end; start A vs the third campaign.
    const again = await startExperiment(a, { ...arms, campaignBId: third });
    expect(again.status).toBe(201);
  });

  it("is enforced by the partial unique index itself", async () => {
    const arms = await setUpArms(a);
    const db = getTestDb();
    const base = {
      organizationId: a.orgId,
      productId: arms.productId,
      name: "direct",
      campaignAId: arms.campaignAId,
      campaignBId: arms.campaignBId,
      campaignAName: "Control 30%",
      campaignBName: "Variant 45%",
    };
    await db.insert(experiments).values({ ...base, id: ulid(), status: "running" });
    // Ended rows and other environments do not conflict.
    await db.insert(experiments).values({ ...base, id: ulid(), status: "ended" });
    await db.insert(experiments).values({ ...base, id: ulid(), status: "running", environment: "test" });

    const err = await db
      .insert(experiments)
      .values({ ...base, id: ulid(), status: "running" })
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(pgErrorCode(err)).toBe("23505");
  });
});

describe("tenant isolation", () => {
  it("hides org A's experiment from org B and refuses org A's campaigns in org B", async () => {
    const arms = await setUpArms(a);
    const exp = (await (await startExperiment(a, arms)).json()).data;

    // Through org B's own URL with org A's ids.
    expect((await (await api(b, "/experiments")).json()).data).toEqual([]);
    expect((await api(b, `/experiments/${exp.id}`)).status).toBe(404);
    expect((await api(b, `/experiments/${exp.id}`, { method: "PATCH", json: { trafficSplitB: 90 } })).status).toBe(404);
    expect(
      (await api(b, `/experiments/${exp.id}/end`, { method: "POST", json: { winnerCampaignId: arms.campaignAId } })).status,
    ).toBe(404);

    const bProduct = await createProduct(b);
    const bCampaign = await createCampaign(b, bProduct, "B campaign");
    let res = await startExperiment(b, { productId: bProduct, campaignAId: bCampaign, campaignBId: arms.campaignBId });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("invalid_campaign");
    res = await startExperiment(b, arms);
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("invalid_product");

    // Through org A's URL: the team middleware refuses B's owner.
    const viaA = await client.request(`/v1/teams/${a.orgId}/experiments/${exp.id}`, { headers: as(b) });
    expect(viaA.status).toBe(403);

    // Nothing changed.
    const [row] = await getTestDb().select().from(experiments).where(eq(experiments.id, exp.id));
    expect(row).toMatchObject({ status: "running", trafficSplitB: 50 });
    expect(await campaignStatus(arms.campaignAId)).toBe("active");
  });
});

describe("campaign and workspace guards", () => {
  it("refuses to pause, draft, move or delete an arm of a running test", async () => {
    const arms = await setUpArms(a);
    const exp = (await (await startExperiment(a, arms)).json()).data;

    for (const status of ["paused", "draft"]) {
      const res = await api(a, `/campaigns/${arms.campaignBId}`, { method: "PATCH", json: { status } });
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ code: "campaign_in_running_experiment", experimentId: exp.id });
    }
    const moved = await api(a, `/campaigns/${arms.campaignAId}`, { method: "PATCH", json: { environment: "test" } });
    expect(moved.status).toBe(409);

    // Other edits are fine mid-test.
    const renamed = await api(a, `/campaigns/${arms.campaignAId}`, { method: "PATCH", json: { maxDiscountPercent: 40 } });
    expect(renamed.status).toBe(200);

    const del = await api(a, `/campaigns/${arms.campaignAId}`, { method: "DELETE" });
    expect(del.status).toBe(409);
    expect((await del.json()).code).toBe("campaign_in_running_experiment");
    expect(await campaignStatus(arms.campaignAId)).toBe("active");
    expect(await campaignStatus(arms.campaignBId)).toBe("active");
  });

  it("keeps an ended test, its arm names and its results when its campaigns are deleted", async () => {
    const arms = await setUpArms(a);
    const exp = (await (await startExperiment(a, arms)).json()).data;
    await getTestDb()
      .insert(analyticsRollups)
      .values(rollup(a.orgId, arms.campaignAId, utcDayOf(exp.startedAt), { impressions: 40, copies: 6, redemptions: 2 }));
    await api(a, `/experiments/${exp.id}/end`, { method: "POST", json: { winnerCampaignId: arms.campaignBId } });

    // Both the paused loser and the active winner can be deleted once the test ended.
    expect((await api(a, `/campaigns/${arms.campaignAId}`, { method: "DELETE" })).status).toBe(200);
    expect((await api(a, `/campaigns/${arms.campaignBId}`, { method: "DELETE" })).status).toBe(200);

    const res = await api(a, `/experiments/${exp.id}`);
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data).toMatchObject({
      status: "ended",
      campaignAId: arms.campaignAId,
      campaignBId: arms.campaignBId,
      campaignAName: "Control 30%",
      campaignBName: "Variant 45%",
      winnerCampaignId: arms.campaignBId,
      campaignA: null,
      campaignB: null,
    });
    expect(data.results.a).toMatchObject({ impressions: 40, copies: 6, redemptions: 2 });
    expect((await (await api(a, "/experiments?status=ended")).json()).data).toHaveLength(1);
  });

  it("keeps refusing to delete a product while its campaigns exist", async () => {
    const arms = await setUpArms(a);
    await startExperiment(a, arms);
    const res = await api(a, `/products/${arms.productId}`, { method: "DELETE" });
    expect(res.status).toBe(409);
    expect(await getTestDb().select().from(products).where(eq(products.id, arms.productId))).toHaveLength(1);
  });

  it("deletes a product whose campaigns are gone, together with its ended tests", async () => {
    const arms = await setUpArms(a);
    const exp = (await (await startExperiment(a, arms)).json()).data;
    await api(a, `/experiments/${exp.id}/end`, { method: "POST", json: { winnerCampaignId: arms.campaignAId } });
    expect((await api(a, `/campaigns/${arms.campaignAId}`, { method: "DELETE" })).status).toBe(200);
    expect((await api(a, `/campaigns/${arms.campaignBId}`, { method: "DELETE" })).status).toBe(200);

    // The ended test's row must not block the product delete (product_id is ON DELETE CASCADE).
    const res = await api(a, `/products/${arms.productId}`, { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(await getTestDb().select().from(experiments).where(eq(experiments.id, exp.id))).toHaveLength(0);
  });

  it("refuses to disconnect an integration that would pause an arm of a running test, and allows it after the test ends", async () => {
    // No credentials and no webhook endpoints: the disconnect never calls a provider.
    const integrationId = ulid();
    await getTestDb().insert(integrations).values({ id: integrationId, organizationId: a.orgId, provider: "stripe" });
    const productId = await createProduct(a);
    // Created as draft (no coupon generation), then activated directly.
    const created = await api(a, "/campaigns", {
      method: "POST",
      json: { productId, name: "Auto-apply 30%", status: "draft", discountDelivery: "auto_apply", integrationId },
    });
    expect(created.status).toBe(201);
    const autoApply = (await created.json()).data.id as string;
    await getTestDb().update(campaigns).set({ status: "active" }).where(eq(campaigns.id, autoApply));
    const other = await createCampaign(a, productId, "Banner 45%");
    const exp = (await (await startExperiment(a, { productId, campaignAId: autoApply, campaignBId: other })).json()).data;

    const refused = await api(a, `/integrations/${integrationId}`, { method: "DELETE" });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ code: "integration_in_running_experiment", experimentId: exp.id });
    expect(await campaignStatus(autoApply)).toBe("active");
    expect(await getTestDb().select().from(integrations).where(eq(integrations.id, integrationId))).toHaveLength(1);

    // Once the test has ended (auto-apply arm kept as the winner) the disconnect goes ahead.
    await api(a, `/experiments/${exp.id}/end`, { method: "POST", json: { winnerCampaignId: autoApply } });
    const done = await api(a, `/integrations/${integrationId}`, { method: "DELETE" });
    expect(done.status).toBe(200);
    expect((await done.json()).pausedCampaigns).toBe(1);
    expect(await campaignStatus(autoApply)).toBe("paused");
    const [detached] = await getTestDb()
      .select({ integrationId: campaigns.integrationId })
      .from(campaigns)
      .where(eq(campaigns.id, autoApply));
    expect(detached?.integrationId).toBeNull();
  });

  it("deletes a workspace that has experiments", async () => {
    const arms = await setUpArms(a);
    await startExperiment(a, arms);
    const res = await client.request(`/v1/teams/${a.orgId}`, { method: "DELETE", headers: as(a) });
    expect(res.status).toBe(200);
    const db = getTestDb();
    expect(await db.select().from(organizations).where(eq(organizations.id, a.orgId))).toHaveLength(0);
    expect(await db.select().from(experiments).where(eq(experiments.organizationId, a.orgId))).toHaveLength(0);
  });
});
