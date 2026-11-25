import { Hono, type Context } from "hono";
import { and, count, eq, gt } from "drizzle-orm";
import { ulid } from "ulid";
import type { AppEnv } from "../bindings";
import { createDb, type Database } from "../db";
import { campaigns, deals, integrations } from "../db/schema";
import { createDealSchema, dealWindowError, updateDealSchema } from "@gopaylocal/shared/validation";
import { MAX_DEALS_PER_CAMPAIGN, defaultDealMessage, type DealCodeSource } from "@gopaylocal/shared/deals";
import { pushBannerConfigForOrg } from "../services/banner-cache.service";
import { retireDealCoupons } from "../services/coupon.service";
import { DealCodeError, createDealCode, listDeals, viewDeal } from "../services/deal.service";
import { allowedProductIdsFor, canAccessProduct } from "../lib/product-access";
import { errorSummary, logBannerPushFailure } from "../lib/log";
import { requirePermission } from "../middleware/permissions";

/**
 * Holiday deals of a campaign (packages/shared/src/deals).
 *
 *   GET    /v1/teams/:orgId/campaigns/:campaignId/deals
 *   POST   /v1/teams/:orgId/campaigns/:campaignId/deals
 *   PATCH  /v1/teams/:orgId/campaigns/:campaignId/deals/:dealId
 *   DELETE /v1/teams/:orgId/campaigns/:campaignId/deals/:dealId
 *
 * A deal on a campaign with a payment integration gets its code created there
 * when the deal is created; if the provider refuses, no deal is stored. A
 * deal's percentage cannot be changed afterwards (the code carries it): delete
 * the deal and create another.
 */
const app = new Hono<AppEnv>();

type CampaignRow = typeof campaigns.$inferSelect;
type IntegrationRow = typeof integrations.$inferSelect;

/** The campaign, when it is in the organization and inside the caller's product scope. */
async function loadCampaign(c: Context<AppEnv>, db: Database, orgId: string, campaignId: string): Promise<CampaignRow | null> {
  const [campaign] = await db
    .select()
    .from(campaigns)
    .where(and(eq(campaigns.id, campaignId), eq(campaigns.organizationId, orgId)))
    .limit(1);
  if (!campaign) return null;
  const allowed = await allowedProductIdsFor(c, db, orgId);
  return canAccessProduct(allowed, campaign.productId) ? campaign : null;
}

async function loadDeal(db: Database, orgId: string, campaignId: string, dealId: string) {
  const [deal] = await db
    .select()
    .from(deals)
    .where(and(eq(deals.id, dealId), eq(deals.campaignId, campaignId), eq(deals.organizationId, orgId)))
    .limit(1);
  return deal ?? null;
}

/** The campaign's integration when codes can be created with it, else null. */
async function usableIntegration(db: Database, campaign: CampaignRow): Promise<IntegrationRow | null> {
  if (!campaign.integrationId) return null;
  const [integration] = await db
    .select()
    .from(integrations)
    .where(and(eq(integrations.id, campaign.integrationId), eq(integrations.organizationId, campaign.organizationId)))
    .limit(1);
  return integration && integration.status === "active" ? integration : null;
}

/** Deals of the campaign that have not ended (they count towards MAX_DEALS_PER_CAMPAIGN). */
async function openDealCount(db: Database, campaignId: string, now: Date): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(deals)
    .where(and(eq(deals.campaignId, campaignId), gt(deals.endsAt, now)));
  return Number(row?.n ?? 0);
}

const DEAL_LIMIT_BODY = {
  error: `A campaign can have at most ${MAX_DEALS_PER_CAMPAIGN} deals that have not ended. Delete one first.`,
  code: "deal_limit" as const,
};

const INTEGRATION_UNAVAILABLE_BODY = {
  error:
    "This campaign's payment integration is not active, so the deal's code can't be created. Reconnect it on the Integrations page.",
  code: "integration_unavailable" as const,
};

/**
 * A campaign whose payment platform charges each country's price itself has no
 * deals: the platform charges the country price, never a deal's percentage.
 */
const COUNTRY_PRICES_BODY = {
  error:
    "This campaign lets Dodo charge each country's price, and Dodo would charge that price, not the deal. Holiday deals need a campaign with discount codes.",
  code: "deals_unavailable_with_country_prices" as const,
};

function providerRefusedBody(err: DealCodeError) {
  return {
    error: `Couldn't create the deal's code at ${err.provider}: ${err.message}`,
    code: "provider_error" as const,
  };
}

function rebuild(c: Context<AppEnv>, db: Database, orgId: string): void {
  c.executionCtx.waitUntil(
    pushBannerConfigForOrg(db, c.env.CACHE, orgId, c.env).catch(logBannerPushFailure(orgId)),
  );
}

// List a campaign's deals, ended ones included.
app.get("/v1/teams/:orgId/campaigns/:campaignId/deals", requirePermission("campaigns.view"), async (c) => {
  const orgId = c.req.param("orgId");
  const db = createDb(c.env);
  try {
    const campaign = await loadCampaign(c, db, orgId, c.req.param("campaignId"));
    if (!campaign) return c.json({ error: "Campaign not found" }, 404);
    return c.json({ data: await listDeals(db, campaign) });
  } catch (err) {
    console.error("deals: failed to list deals", { error: errorSummary(err) });
    return c.json({ error: "Failed to fetch deals" }, 500);
  }
});

// Create a deal.
app.post("/v1/teams/:orgId/campaigns/:campaignId/deals", requirePermission("campaigns.update"), async (c) => {
  const orgId = c.req.param("orgId");
  const db = createDb(c.env);
  try {
    const parsed = createDealSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: "Validation failed", details: parsed.error.flatten() }, 400);
    }
    const campaign = await loadCampaign(c, db, orgId, c.req.param("campaignId"));
    if (!campaign) return c.json({ error: "Campaign not found" }, 404);
    if (campaign.discountDelivery === "provider_price") return c.json(COUNTRY_PRICES_BODY, 409);

    const now = new Date();
    const startsAt = new Date(parsed.data.startsAt);
    const endsAt = new Date(parsed.data.endsAt);
    if (endsAt.getTime() <= now.getTime()) {
      return c.json({ error: "A deal must end in the future", code: "deal_in_the_past" }, 400);
    }

    // Where the code comes from follows from the campaign: with a payment
    // integration GoPayLocal creates it there, and a typed code is refused
    // (it would not exist at the provider).
    let codeSource: DealCodeSource;
    let integration: IntegrationRow | null = null;
    if (campaign.integrationId) {
      if (parsed.data.code) {
        return c.json(
          {
            error: "This campaign creates its codes in your payment platform. Leave `code` out.",
            code: "code_not_allowed",
          },
          400,
        );
      }
      integration = await usableIntegration(db, campaign);
      if (!integration) return c.json(INTEGRATION_UNAVAILABLE_BODY, 400);
      codeSource = "provider";
    } else {
      codeSource = parsed.data.code ? "manual" : "none";
    }

    if ((await openDealCount(db, campaign.id, now)) >= MAX_DEALS_PER_CAMPAIGN) {
      return c.json(DEAL_LIMIT_BODY, 409);
    }

    const [deal] = await db
      .insert(deals)
      .values({
        id: ulid(),
        organizationId: orgId,
        campaignId: campaign.id,
        name: parsed.data.name,
        discountPercent: parsed.data.discountPercent,
        startsAt,
        endsAt,
        messageTemplate: parsed.data.messageTemplate ?? defaultDealMessage(codeSource),
        codeSource,
        manualCode: codeSource === "manual" ? (parsed.data.code ?? null) : null,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    if (!deal) throw new Error("deal insert returned no row");

    if (integration) {
      try {
        await createDealCode(db, c.env, campaign, integration, deal);
      } catch (err) {
        // No code, no deal: nothing is left behind for the banner to offer.
        await db.delete(deals).where(eq(deals.id, deal.id));
        if (err instanceof DealCodeError) return c.json(providerRefusedBody(err), 502);
        throw err;
      }
    }

    rebuild(c, db, orgId);
    return c.json({ data: await viewDeal(db, campaign, deal) }, 201);
  } catch (err) {
    console.error("deals: failed to create deal", { error: errorSummary(err) });
    return c.json({ error: "Failed to create deal" }, 500);
  }
});

// Change a deal's name, window or message.
app.patch("/v1/teams/:orgId/campaigns/:campaignId/deals/:dealId", requirePermission("campaigns.update"), async (c) => {
  const orgId = c.req.param("orgId");
  const db = createDb(c.env);
  try {
    const parsed = updateDealSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: "Validation failed", details: parsed.error.flatten() }, 400);
    }
    const campaign = await loadCampaign(c, db, orgId, c.req.param("campaignId"));
    if (!campaign) return c.json({ error: "Campaign not found" }, 404);
    const deal = await loadDeal(db, orgId, campaign.id, c.req.param("dealId"));
    if (!deal) return c.json({ error: "Deal not found" }, 404);
    if (campaign.discountDelivery === "provider_price") return c.json(COUNTRY_PRICES_BODY, 409);

    const now = new Date();
    const startsAt = parsed.data.startsAt ? new Date(parsed.data.startsAt) : new Date(deal.startsAt);
    const endsAt = parsed.data.endsAt ? new Date(parsed.data.endsAt) : new Date(deal.endsAt);
    const windowError = dealWindowError(startsAt, endsAt);
    if (windowError) return c.json({ error: windowError, code: "invalid_window" }, 400);

    const wasOpen = new Date(deal.endsAt).getTime() > now.getTime();
    const isOpen = endsAt.getTime() > now.getTime();
    // Moving the end of a finished deal into the future makes it count again.
    if (isOpen && !wasOpen && (await openDealCount(db, campaign.id, now)) >= MAX_DEALS_PER_CAMPAIGN) {
      return c.json(DEAL_LIMIT_BODY, 409);
    }

    // A deal that will run (again) needs its code: the one of a finished deal
    // was removed at the provider. Created before the row changes, so a
    // refusal leaves the deal as it was.
    if (isOpen && deal.codeSource === "provider" && campaign.integrationId) {
      const integration = await usableIntegration(db, campaign);
      if (!integration) return c.json(INTEGRATION_UNAVAILABLE_BODY, 400);
      try {
        await createDealCode(db, c.env, campaign, integration, deal);
      } catch (err) {
        if (err instanceof DealCodeError) return c.json(providerRefusedBody(err), 502);
        throw err;
      }
    }

    const [updated] = await db
      .update(deals)
      .set({
        ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
        ...(parsed.data.messageTemplate !== undefined ? { messageTemplate: parsed.data.messageTemplate } : {}),
        startsAt,
        endsAt,
        updatedAt: now,
      })
      .where(and(eq(deals.id, deal.id), eq(deals.organizationId, orgId)))
      .returning();
    if (!updated) return c.json({ error: "Deal not found" }, 404);

    rebuild(c, db, orgId);
    return c.json({ data: await viewDeal(db, campaign, updated) });
  } catch (err) {
    console.error("deals: failed to update deal", { error: errorSummary(err) });
    return c.json({ error: "Failed to update deal" }, 500);
  }
});

// Delete a deal and remove its code at the payment platform.
app.delete("/v1/teams/:orgId/campaigns/:campaignId/deals/:dealId", requirePermission("campaigns.update"), async (c) => {
  const orgId = c.req.param("orgId");
  const db = createDb(c.env);
  try {
    const campaign = await loadCampaign(c, db, orgId, c.req.param("campaignId"));
    if (!campaign) return c.json({ error: "Campaign not found" }, 404);
    const deal = await loadDeal(db, orgId, campaign.id, c.req.param("dealId"));
    if (!deal) return c.json({ error: "Deal not found" }, 404);

    // A code the provider refuses to remove stays behind as a `retiring`
    // coupon: never shown, tried again by the scheduled job.
    const notRemoved = await retireDealCoupons(db, c.env, deal.id, orgId);
    await db.delete(deals).where(and(eq(deals.id, deal.id), eq(deals.organizationId, orgId)));

    rebuild(c, db, orgId);
    return c.json({
      success: true,
      ...(notRemoved.length > 0
        ? {
            warning: `The code ${notRemoved.join(", ")} could not be removed from your payment platform yet. GoPayLocal keeps trying; you can also remove it there yourself.`,
          }
        : {}),
    });
  } catch (err) {
    console.error("deals: failed to delete deal", { error: errorSummary(err) });
    return c.json({ error: "Failed to delete deal" }, 500);
  }
});

export default app;
