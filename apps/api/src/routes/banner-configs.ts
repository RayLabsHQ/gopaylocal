import { Hono } from "hono";
import { eq, and } from "drizzle-orm";
import type { AppEnv } from "../bindings";
import { createDb } from "../db";
import { bannerConfigs, campaigns } from "../db/schema";
import { updateBannerConfigSchema } from "@gopaylocal/shared/validation";
import { pushBannerConfigForOrg } from "../services/banner-cache.service";
import { allowedProductIdsFor, canAccessProduct } from "../lib/product-access";
import { errorSummary, logBannerPushFailure } from "../lib/log";
import { requirePermission } from "../middleware/permissions";

const app = new Hono<AppEnv>();

// Get banner config for a campaign
app.get("/v1/teams/:orgId/banner-configs/:campaignId", requirePermission("banners.view"), async (c) => {
  const orgId = c.req.param("orgId");
  const campaignId = c.req.param("campaignId");
  const db = createDb(c.env);

  try {
    // Verify campaign belongs to org
    const campaign = await db
      .select()
      .from(campaigns)
      .where(and(eq(campaigns.id, campaignId), eq(campaigns.organizationId, orgId)))
      .limit(1)
      .then((rows) => rows[0]);

    if (!campaign) {
      return c.json({ error: "Campaign not found" }, 404);
    }

    // Scoped members may only touch banners for campaigns in their product scope.
    const allowed = await allowedProductIdsFor(c, db, orgId);
    if (!canAccessProduct(allowed, campaign.productId)) {
      return c.json({ error: "Campaign not found" }, 404);
    }

    const config = await db
      .select()
      .from(bannerConfigs)
      .where(eq(bannerConfigs.campaignId, campaignId))
      .limit(1)
      .then((rows) => rows[0]);

    if (!config) {
      return c.json({ error: "Banner config not found" }, 404);
    }

    return c.json({ data: config });
  } catch (err) {
    console.error("banner-configs: failed to fetch banner config", { error: errorSummary(err) });
    return c.json({ error: "Failed to fetch banner config" }, 500);
  }
});

// Update banner config for a campaign
app.put("/v1/teams/:orgId/banner-configs/:campaignId", requirePermission("banners.update"), async (c) => {
  const orgId = c.req.param("orgId");
  const campaignId = c.req.param("campaignId");
  const db = createDb(c.env);

  try {
    const body = await c.req.json();
    const parsed = updateBannerConfigSchema.safeParse(body);

    if (!parsed.success) {
      return c.json({ error: "Validation failed", details: parsed.error.flatten() }, 400);
    }

    // Verify campaign belongs to org
    const campaign = await db
      .select()
      .from(campaigns)
      .where(and(eq(campaigns.id, campaignId), eq(campaigns.organizationId, orgId)))
      .limit(1)
      .then((rows) => rows[0]);

    if (!campaign) {
      return c.json({ error: "Campaign not found" }, 404);
    }

    // Scoped members may only edit banners for campaigns in their product scope.
    const allowed = await allowedProductIdsFor(c, db, orgId);
    if (!canAccessProduct(allowed, campaign.productId)) {
      return c.json({ error: "Campaign not found" }, 404);
    }

    const result = await db
      .update(bannerConfigs)
      .set({ ...parsed.data, updatedAt: new Date() })
      .where(eq(bannerConfigs.campaignId, campaignId))
      .returning();

    const config = result[0];
    if (!config) {
      return c.json({ error: "Banner config not found" }, 404);
    }

    // Push pre-computed banner config to KV (fire-and-forget)
    c.executionCtx.waitUntil(
      pushBannerConfigForOrg(db, c.env.CACHE, orgId, c.env).catch(logBannerPushFailure(orgId)),
    );

    return c.json({ data: config });
  } catch (err) {
    console.error("banner-configs: failed to update banner config", { error: errorSummary(err) });
    return c.json({ error: "Failed to update banner config" }, 500);
  }
});

export default app;
