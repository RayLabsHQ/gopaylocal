import { Hono, type Context } from "hono";
import type { AppEnv } from "../bindings";
import { createDb } from "../db";
import {
  createExperimentSchema,
  updateExperimentSchema,
  endExperimentSchema,
} from "@gopaylocal/shared/validation";
import type { ExperimentStatus } from "@gopaylocal/shared/types";
import { pushBannerConfigForOrg } from "../services/banner-cache.service";
import {
  ExperimentError,
  createExperiment,
  endExperiment,
  getExperiment,
  getExperimentResults,
  listExperiments,
  retentionStartFor,
  updateExperiment,
} from "../services/experiment.service";
import { getOrgRetentionDays } from "../lib/limits";
import { allowedProductIdsFor } from "../lib/product-access";
import { requirePermission } from "../middleware/permissions";
import { errorSummary, logBannerPushFailure } from "../lib/log";

// A/B tests ("experiments"): two campaigns of one product, split by traffic.
// The rules live in services/experiment.service.ts; this file maps HTTP to it.
// Same conventions as routes/campaigns.ts: mounted behind session + team
// middleware (index.ts), every query scoped to :orgId, product-scoped members
// limited to their products, banner KV rebuilt after every change.
// Permissions (contract C5): the experiments.* rows of the shared permission
// table, which give the same rights as managing campaigns.

const app = new Hono<AppEnv>();

const ENVIRONMENTS = new Set(["live", "test"]);
const STATUSES = new Set<ExperimentStatus>(["running", "ended"]);

async function allowedProducts(c: Context<AppEnv>, db: ReturnType<typeof createDb>) {
  return allowedProductIdsFor(c, db, c.req.param("orgId")!);
}

/** Rebuild the banner config so the split (or its end) reaches visitors. */
function pushBanner(c: Context<AppEnv>, db: ReturnType<typeof createDb>, orgId: string) {
  c.executionCtx.waitUntil(
    pushBannerConfigForOrg(db, c.env.CACHE, orgId, c.env).catch(logBannerPushFailure(orgId)),
  );
}

function experimentErrorResponse(c: Context<AppEnv>, err: ExperimentError) {
  return c.json({ error: err.message, code: err.code }, err.status);
}

// List experiments (?productId=, ?campaignId=, ?environment=live|test, ?status=running|ended)
app.get("/v1/teams/:orgId/experiments", requirePermission("experiments.view"), async (c) => {
  const orgId = c.req.param("orgId");
  const db = createDb(c.env);

  try {
    const environment = c.req.query("environment");
    const status = c.req.query("status");
    if (environment !== undefined && !ENVIRONMENTS.has(environment)) {
      return c.json({ error: "environment must be live or test" }, 400);
    }
    if (status !== undefined && !STATUSES.has(status as ExperimentStatus)) {
      return c.json({ error: "status must be running or ended" }, 400);
    }

    const data = await listExperiments(
      db,
      orgId,
      {
        productId: c.req.query("productId") || undefined,
        campaignId: c.req.query("campaignId") || undefined,
        environment: environment as "live" | "test" | undefined,
        status: status as ExperimentStatus | undefined,
      },
      await allowedProducts(c, db),
    );
    return c.json({ data });
  } catch (err) {
    console.error("experiments: failed to list experiments", { orgId, error: errorSummary(err) });
    return c.json({ error: "Failed to fetch experiments" }, 500);
  }
});

// Start an experiment
app.post("/v1/teams/:orgId/experiments", requirePermission("experiments.create"), async (c) => {
  const orgId = c.req.param("orgId");
  const db = createDb(c.env);

  try {
    const body = await c.req.json().catch(() => null);
    const parsed = createExperimentSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Validation failed", details: parsed.error.flatten() }, 400);
    }

    const experiment = await createExperiment(db, {
      orgId,
      input: parsed.data,
      allowedProductIds: await allowedProducts(c, db),
    });
    pushBanner(c, db, orgId);
    return c.json({ data: experiment }, 201);
  } catch (err) {
    if (err instanceof ExperimentError) return experimentErrorResponse(c, err);
    console.error("experiments: failed to create experiment", { orgId, error: errorSummary(err) });
    return c.json({ error: "Failed to create experiment" }, 500);
  }
});

// One experiment with per-arm results
app.get("/v1/teams/:orgId/experiments/:id", requirePermission("experiments.view"), async (c) => {
  const orgId = c.req.param("orgId");
  const experimentId = c.req.param("id");
  const db = createDb(c.env);

  try {
    const experiment = await getExperiment(db, orgId, experimentId, await allowedProducts(c, db));
    if (!experiment) return c.json({ error: "Experiment not found" }, 404);

    // Same retention clamp as the analytics endpoints: a Free org cannot read
    // older history through an experiment than through analytics.
    const retentionDays = await getOrgRetentionDays(db, orgId, c.env);
    const results = await getExperimentResults(db, experiment, retentionStartFor(retentionDays));
    return c.json({ data: { ...experiment, results } });
  } catch (err) {
    console.error("experiments: failed to fetch experiment", { orgId, experimentId, error: errorSummary(err) });
    return c.json({ error: "Failed to fetch experiment" }, 500);
  }
});

// Rename, or change the traffic split while running
app.patch("/v1/teams/:orgId/experiments/:id", requirePermission("experiments.update"), async (c) => {
  const orgId = c.req.param("orgId");
  const experimentId = c.req.param("id");
  const db = createDb(c.env);

  try {
    const body = await c.req.json().catch(() => null);
    const parsed = updateExperimentSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Validation failed", details: parsed.error.flatten() }, 400);
    }

    const experiment = await updateExperiment(db, {
      orgId,
      experimentId,
      input: parsed.data,
      allowedProductIds: await allowedProducts(c, db),
    });
    if (parsed.data.trafficSplitB !== undefined) pushBanner(c, db, orgId);
    return c.json({ data: experiment });
  } catch (err) {
    if (err instanceof ExperimentError) return experimentErrorResponse(c, err);
    console.error("experiments: failed to update experiment", { orgId, experimentId, error: errorSummary(err) });
    return c.json({ error: "Failed to update experiment" }, 500);
  }
});

// End the test: the winner stays as it is, the loser is paused
app.post("/v1/teams/:orgId/experiments/:id/end", requirePermission("experiments.update"), async (c) => {
  const orgId = c.req.param("orgId");
  const experimentId = c.req.param("id");
  const db = createDb(c.env);

  try {
    const body = await c.req.json().catch(() => null);
    const parsed = endExperimentSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Validation failed", details: parsed.error.flatten() }, 400);
    }

    const { experiment, pausedCampaignId } = await endExperiment(db, {
      orgId,
      experimentId,
      winnerCampaignId: parsed.data.winnerCampaignId,
      allowedProductIds: await allowedProducts(c, db),
    });
    pushBanner(c, db, orgId);
    return c.json({ data: experiment, pausedCampaignId });
  } catch (err) {
    if (err instanceof ExperimentError) return experimentErrorResponse(c, err);
    console.error("experiments: failed to end experiment", { orgId, experimentId, error: errorSummary(err) });
    return c.json({ error: "Failed to end experiment" }, 500);
  }
});

export default app;
