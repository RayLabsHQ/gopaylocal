import { describe, it, expect, beforeEach, afterAll, afterEach, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import postgres from "postgres";
import { ulid } from "ulid";
import worker from "../index";
import { campaigns, experiments, integrations } from "../db/schema";
import { createTestBindings, createTestClient, type TestClient, type TestResponse } from "./helpers";
import { as, seedTenant, type TestTenant } from "./auth";
import { cleanupTestDb, closeTestDb, getTestDb, testDatabaseUrl } from "./setup";

vi.mock("../../../../packages/banner/dist/banner.js", () => ({ default: "" }));

/*
 * Starting an A/B test and disconnecting an integration race on the same
 * campaign rows: the disconnect pauses its active auto-apply campaigns, and an
 * experiment must not run with a paused arm. Both sides lock those rows with
 * SELECT ... FOR UPDATE inside their transaction (experiment.service.ts
 * createExperiment and assertIntegrationDisconnectKeepsExperiments).
 *
 * A single request cannot show that the locks serialize the two. Here one side
 * runs on its own connection as an open transaction doing what the other code
 * path does, the real route is fired against it, and we wait until Postgres
 * reports that request blocked on a lock before committing. The route must then
 * decide on the committed state. Without the lock on the route's side, case 1
 * ends 200 with the arm paused and case 2 never blocks.
 */

let client: TestClient;
let t: TestTenant;
let side: ReturnType<typeof postgres> | null = null;

function api(path: string, init: Parameters<TestClient["request"]>[1] = {}) {
  return client.request(`/v1/teams/${t.orgId}${path}`, { ...init, headers: as(t) });
}

/** Opens a transaction on its own connection, runs `work`, and keeps it open until release(). */
async function holdTransaction(work: (tx: postgres.TransactionSql) => Promise<void>) {
  side ??= postgres(testDatabaseUrl(), { max: 1 });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let ready!: () => void;
  let failed!: (err: unknown) => void;
  const started = new Promise<void>((resolve, reject) => ((ready = resolve), (failed = reject)));
  const done = side
    .begin(async (tx) => {
      await work(tx);
      ready();
      await gate;
    })
    .catch((err: unknown) => {
      failed(err);
      throw err;
    });
  await started;
  return { release, done };
}

/**
 * Resolves with the statement of the first backend of this database that is
 * waiting on a lock; fails after 10 s. Which statement waits matters: without
 * the route's FOR UPDATE, a later UPDATE of the same row would be the one to
 * block (too late, the check already ran), or nothing would block at all.
 */
async function untilARequestWaitsOnALock(): Promise<string> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const [row] = await getTestDb().execute<{ query: string }>(
      sql`SELECT query FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' LIMIT 1`,
    );
    if (row) return row.query;
    if (Date.now() > deadline) throw new Error("no request ever blocked on a lock: the route does not take the row lock");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function campaignStatus(id: string) {
  const [row] = await getTestDb().select({ status: campaigns.status }).from(campaigns).where(eq(campaigns.id, id));
  return row?.status;
}

/** A product with an active auto-apply campaign on a credential-less integration, and an active banner campaign. */
async function setUp() {
  const integrationId = ulid();
  await getTestDb().insert(integrations).values({ id: integrationId, organizationId: t.orgId, provider: "stripe" });
  const product = await api("/products", {
    method: "POST",
    json: { name: "Pro Plan", url: "https://shop.example.com/pricing", basePrice: 99 },
  });
  expect(product.status).toBe(201);
  const productId = (await product.json()).data.id as string;
  // Draft first (no coupon generation, no provider call), then activated directly.
  const auto = await api("/campaigns", {
    method: "POST",
    json: { productId, name: "Auto-apply 30%", status: "draft", discountDelivery: "auto_apply", integrationId },
  });
  expect(auto.status).toBe(201);
  const autoApply = (await auto.json()).data.id as string;
  await getTestDb().update(campaigns).set({ status: "active" }).where(eq(campaigns.id, autoApply));
  const banner = await api("/campaigns", { method: "POST", json: { productId, name: "Banner 45%", status: "active" } });
  expect(banner.status).toBe(201);
  const other = (await banner.json()).data.id as string;
  return { integrationId, productId, autoApply, other };
}

beforeEach(async () => {
  await cleanupTestDb();
  client = createTestClient(worker, createTestBindings());
  t = await seedTenant(client, "Race Org");
});

afterEach(async () => {
  // Never leave a held transaction behind (it would block cleanup).
  await side?.end({ timeout: 1 });
  side = null;
});

afterAll(async () => {
  await cleanupTestDb();
  await closeTestDb();
});

describe("starting an A/B test vs disconnecting its integration (two connections)", () => {
  it("a test that commits first wins: the waiting disconnect sees it and refuses (409), the arm stays active", async () => {
    const { integrationId, productId, autoApply, other } = await setUp();
    const experimentId = ulid();

    // What createExperiment does, held open: lock both arms, insert the running test.
    const held = await holdTransaction(async (tx) => {
      await tx`SELECT id FROM campaigns WHERE organization_id = ${t.orgId} AND id IN (${autoApply}, ${other}) ORDER BY id FOR UPDATE`;
      await tx`INSERT INTO experiments (id, organization_id, product_id, name, campaign_a_id, campaign_b_id, campaign_a_name, campaign_b_name)
               VALUES (${experimentId}, ${t.orgId}, ${productId}, ${"Race"}, ${autoApply}, ${other}, ${"Auto-apply 30%"}, ${"Banner 45%"})`;
    });

    const disconnect: Promise<TestResponse> = api(`/integrations/${integrationId}`, { method: "DELETE" });
    // The disconnect's guard select is what waits, before any check has run.
    expect(await untilARequestWaitsOnALock()).toMatch(/^select .* from "campaigns" .* for update$/is);
    held.release();
    await held.done;

    const res = await disconnect;
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "integration_in_running_experiment", experimentId });
    expect(await campaignStatus(autoApply)).toBe("active");
    expect(await getTestDb().select().from(integrations).where(eq(integrations.id, integrationId))).toHaveLength(1);
  });

  it("a disconnect that commits first wins: the waiting test start sees its arm paused and refuses (409), no test row", async () => {
    const { integrationId, productId, autoApply, other } = await setUp();

    // What the disconnect transaction does, held open: lock, pause, unlink.
    const held = await holdTransaction(async (tx) => {
      await tx`SELECT id FROM campaigns WHERE organization_id = ${t.orgId} AND integration_id = ${integrationId}
               AND status = 'active' AND discount_delivery = 'auto_apply' ORDER BY id FOR UPDATE`;
      await tx`UPDATE campaigns SET status = 'paused', updated_at = now() WHERE organization_id = ${t.orgId}
               AND integration_id = ${integrationId} AND status = 'active' AND discount_delivery = 'auto_apply'`;
      await tx`UPDATE campaigns SET integration_id = NULL, updated_at = now() WHERE organization_id = ${t.orgId} AND integration_id = ${integrationId}`;
    });

    const start: Promise<TestResponse> = api("/experiments", {
      method: "POST",
      json: { productId, campaignAId: autoApply, campaignBId: other, name: "Race" },
    });
    // createExperiment's arm lock is what waits (a plain select would not).
    expect(await untilARequestWaitsOnALock()).toMatch(/^select .* from "campaigns" .* for update$/is);
    held.release();
    await held.done;

    const res = await start;
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "campaign_not_active" });
    expect(await getTestDb().select().from(experiments)).toHaveLength(0);
    expect(await campaignStatus(autoApply)).toBe("paused");
  });
});
