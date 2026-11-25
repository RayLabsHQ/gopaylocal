import { Hono, type Context } from "hono";
import { eq, and, gt, inArray, sql } from "drizzle-orm";
import { ulid } from "ulid";
import type { AppEnv } from "../bindings";
import { createDb } from "../db";
import type { Database } from "../db";
import type { Bindings } from "../bindings";
import {
  campaigns,
  bannerConfigs,
  coupons,
  deals,
  integrations,
  products,
  parityGroups,
  countryParityMappings,
} from "../db/schema";
import {
  createCampaignSchema,
  updateCampaignSchema,
  PROVIDERS_WITHOUT_TEST_MODE,
  providerHasTestMode,
} from "@gopaylocal/shared/validation";
import { DEFAULT_BANNER_MESSAGE, DEFAULT_BANNER_MESSAGE_CHARGED, DEFAULT_CTA_TEXT } from "@gopaylocal/shared/constants";
import { countryDiscount, workspaceParityGroups } from "@gopaylocal/shared/parity";
import { pushBannerConfigForOrg } from "../services/banner-cache.service";
import { createCouponForCountry } from "../services/coupon.service";
import { syncDealCouponsForCampaign } from "../services/deal.service";
import {
  COUNTRY_PRICE_PROVIDERS,
  countryPriceStatus,
  countryPricesLeft,
  productTakenByAnotherCampaign,
  reconcileCampaignCountryPrices,
  syncCampaignCountryPrices,
  syncCountryPricesAfterCampaignChange,
} from "../services/campaign-country-prices.service";
import {
  assertCampaignNotInRunningExperiment,
  campaignUpdateBlockedByExperiment,
  CampaignInRunningExperimentError,
} from "../services/experiment.service";
import { allowedProductIdsFor, assertCampaignAccess, scopeOf } from "../lib/product-access";
import { errorSummary, logBannerPushFailure } from "../lib/log";
import { requirePermission } from "../middleware/permissions";

const app = new Hono<AppEnv>();

type CampaignEnvironment = "live" | "test";

/** What the campaign rules need to know about a linked integration (never its keys). */
interface IntegrationFacts {
  provider: string;
  hasLiveKey: boolean;
  hasTestKey: boolean;
}

const integrationFactColumns = {
  provider: integrations.provider,
  hasLiveKey: sql<boolean>`${integrations.liveAccessTokenEnc} is not null`,
  hasTestKey: sql<boolean>`${integrations.testAccessTokenEnc} is not null`,
};

/**
 * Verify that the productId / integrationId a campaign references belong to the
 * same org. Without this, a member could bind a campaign to ANOTHER org's
 * product or integration, bleeding that data into banner responses and coupon
 * generation. Returns an error message (null when the refs are valid), plus the
 * product's environment and the integration's facts for the rules below.
 */
async function validateOwnedRefs(
  db: Database,
  orgId: string,
  productId: string | undefined,
  integrationId: string | null | undefined,
): Promise<{ error: string | null; productEnvironment: CampaignEnvironment | null; integration: IntegrationFacts | null }> {
  let productEnvironment: CampaignEnvironment | null = null;
  if (productId) {
    const [p] = await db
      .select({ id: products.id, environment: products.environment })
      .from(products)
      .where(and(eq(products.id, productId), eq(products.organizationId, orgId)))
      .limit(1);
    if (!p) return { error: "Invalid productId for this organization", productEnvironment: null, integration: null };
    productEnvironment = p.environment ?? null;
  }
  if (integrationId) {
    const [i] = await db
      .select({ id: integrations.id, ...integrationFactColumns })
      .from(integrations)
      .where(and(eq(integrations.id, integrationId), eq(integrations.organizationId, orgId)))
      .limit(1);
    if (!i) return { error: "Invalid integrationId for this organization", productEnvironment, integration: null };
    return { error: null, productEnvironment, integration: { provider: i.provider, hasLiveKey: !!i.hasLiveKey, hasTestKey: !!i.hasTestKey } };
  }
  return { error: null, productEnvironment, integration: null };
}

async function loadProductEnvironment(db: Database, orgId: string, productId: string): Promise<CampaignEnvironment | null> {
  const [p] = await db
    .select({ environment: products.environment })
    .from(products)
    .where(and(eq(products.id, productId), eq(products.organizationId, orgId)))
    .limit(1);
  return p?.environment ?? null;
}

async function loadIntegrationFacts(db: Database, orgId: string, integrationId: string): Promise<IntegrationFacts | null> {
  const [i] = await db
    .select(integrationFactColumns)
    .from(integrations)
    .where(and(eq(integrations.id, integrationId), eq(integrations.organizationId, orgId)))
    .limit(1);
  return i ? { provider: i.provider, hasLiveKey: !!i.hasLiveKey, hasTestKey: !!i.hasTestKey } : null;
}

/**
 * A campaign serves its product's visitors in that product's environment, so
 * the two must match (the dashboard lists both per environment; a live
 * campaign on a test product would use live keys for a test page).
 */
function environmentMismatch(
  campaignEnvironment: string,
  productEnvironment: CampaignEnvironment | null,
): { error: string; code: "environment_mismatch" } | null {
  if (!productEnvironment || campaignEnvironment === productEnvironment) return null;
  return { error: `A campaign must be in its product's environment (${productEnvironment}).`, code: "environment_mismatch" };
}

/**
 * An active campaign creates discount codes with the integration's key for the
 * campaign's environment; without one every code fails. Drafts are fine (the
 * key can be added before going live).
 */
function missingKeyConflict(
  status: string,
  environment: string,
  integration: IntegrationFacts | null,
): { error: string; code: "integration_missing_key" } | null {
  if (status !== "active" || !integration) return null;
  if (environment === "test" ? integration.hasTestKey : integration.hasLiveKey) return null;
  return {
    error: `The linked integration has no ${environment} key, so this campaign can't create its discount codes. Add a ${environment} key on the Integrations page, or keep the campaign as a draft.`,
    code: "integration_missing_key",
  };
}

/**
 * 400 body for a test-environment campaign on a provider with no test mode
 * (PROVIDERS_WITHOUT_TEST_MODE): its coupons would be created in the real
 * account, or fail, so the combination is refused up front. Null when fine.
 */
function liveOnlyProviderConflict(
  environment: string | undefined,
  provider: string | null,
): { error: string; code: "provider_has_no_test_mode" } | null {
  if (environment !== "test" || !provider || providerHasTestMode(provider)) return null;
  const name = PROVIDERS_WITHOUT_TEST_MODE[provider as keyof typeof PROVIDERS_WITHOUT_TEST_MODE] ?? provider;
  return {
    error: `${name} has no test mode, so a test campaign can't use it. Make the campaign live or link another integration.`,
    code: "provider_has_no_test_mode",
  };
}

/**
 * The rules of a campaign whose payment platform charges each country's price
 * itself (discountDelivery 'provider_price', services/campaign-country-prices):
 * only Dodo Payments can, and an active one needs the integration and the Dodo
 * product to price. 400 body, or null when fine.
 */
export function countryPriceConflict(input: {
  status: string;
  delivery: string;
  provider: string | null;
  providerProductId: string | null | undefined;
}): { error: string; code: "country_prices_unsupported" | "country_prices_incomplete" } | null {
  if (input.delivery !== "provider_price") return null;
  if (input.provider && !COUNTRY_PRICE_PROVIDERS.has(input.provider)) {
    return {
      error: "Only Dodo Payments can charge each country's price itself. Link a Dodo Payments integration, or use discount codes.",
      code: "country_prices_unsupported",
    };
  }
  if (input.status === "active" && (!input.provider || !input.providerProductId)) {
    return {
      error:
        "A campaign where Dodo charges the country price needs a Dodo Payments integration and the Dodo product to price before it can go active.",
      code: "country_prices_incomplete",
    };
  }
  return null;
}

const COUNTRY_PRICES_PRODUCT_TAKEN = {
  error:
    "Another campaign sets this Dodo product's country prices, or GoPayLocal is still removing them. Pick another product, or pause that campaign and try again once its prices are gone.",
  code: "country_prices_product_taken" as const,
};

/**
 * Choosing the Dodo product whose prices GoPayLocal writes is for members with
 * access to every product: GoPayLocal products and Dodo products are not
 * linked, so a member limited to some products could otherwise change the
 * prices of a Dodo product sold under one they can't see.
 */
const COUNTRY_PRICES_NEED_FULL_ACCESS = {
  error: "Only members with access to every product can choose the Dodo product whose country prices GoPayLocal sets.",
  code: "country_prices_need_full_access" as const,
};

const CAMPAIGN_HAS_DEALS = {
  error:
    "This campaign has holiday deals that haven't ended, and Dodo would charge the country price, not the deal. Delete the deals first.",
  code: "campaign_has_deals" as const,
};

/** 409 body: codes would be offered while Dodo still charges this campaign's country prices. */
function countryPricesLeftBody(left: number) {
  return {
    error:
      `Dodo still charges the country prices this campaign set in ${left} ${left === 1 ? "country" : "countries"}, ` +
      "and a code on top would discount twice. Pause the campaign first: GoPayLocal removes its prices from Dodo " +
      "within a few minutes, then switch it to discount codes.",
    code: "country_prices_still_at_dodo" as const,
    remaining: left,
  };
}

/**
 * Create the coupon codes of a campaign that just became active with an
 * integration linked. Runs in waitUntil, so it doesn't block the response.
 *
 * Codes are created only for the countries of the workspace's OWN parity
 * groups, one per country, each at countryDiscount's percent: the same shared
 * calculation the banner serves, so a pre-created code always carries the
 * percent the banner shows. Nothing is created for the default tiers (a
 * workspace without groups) or for countries outside the groups; those codes
 * are created on a country's first banner load (getDiscountForCountry). The
 * provider calls run one after another inside waitUntil, so keeping them to the
 * merchant's own group countries also keeps activation inside the waitUntil
 * time limit and the per-request subrequest limit.
 */
export async function generateCouponsForCampaign(
  db: Database,
  env: Bindings,
  kv: KVNamespace,
  campaignId: string,
  orgId: string,
): Promise<void> {
  const [campaign] = await db
    .select()
    .from(campaigns)
    .where(and(eq(campaigns.id, campaignId), eq(campaigns.organizationId, orgId)))
    .limit(1);

  // A campaign whose payment platform charges the country price has no codes.
  if (!campaign || !campaign.integrationId || campaign.discountDelivery === "provider_price") return;

  // Tenant-scoped integration lookup
  const [integration] = await db
    .select()
    .from(integrations)
    .where(
      and(
        eq(integrations.id, campaign.integrationId),
        eq(integrations.organizationId, orgId),
      ),
    )
    .limit(1);

  if (!integration) return;

  // The workspace's own groups, in one query (the banner builder's shape). A
  // country in several groups is priced by one of them (lowest sort order, then
  // lowest id), exactly as the banner prices it, so it gets one code.
  const groupRows = await db
    .select({
      groupId: parityGroups.id,
      discountPercent: parityGroups.discountPercent,
      sortOrder: parityGroups.sortOrder,
      countryCode: countryParityMappings.countryCode,
    })
    .from(parityGroups)
    .leftJoin(countryParityMappings, eq(countryParityMappings.parityGroupId, parityGroups.id))
    .where(eq(parityGroups.organizationId, orgId));
  const groups = workspaceParityGroups(groupRows);

  for (const countryCode of [...groups.byCountry.keys()].sort()) {
    const { discount } = countryDiscount(campaign, countryCode, groups);
    if (discount <= 0) continue;

    try {
      await createCouponForCountry(db, env, campaign, integration, countryCode, discount);
    } catch (err: unknown) {
      const code = (err as { code?: string }).code;
      if (code === "ALREADY_EXISTS") continue;
      console.error(`Coupon creation failed for ${countryCode}:`, err);
    }
  }

  // Refresh KV cache now that coupons exist
  await pushBannerConfigForOrg(db, kv, orgId, env).catch(logBannerPushFailure(orgId));
}

/**
 * Catch handler for background coupon generation. Per-country provider
 * failures are already logged inside; this catches a failure of the whole run
 * (e.g. the campaign/integration lookup), which would otherwise leave an
 * active campaign with no coupon codes and no trace of why.
 */
function logCouponGenerationFailure(orgId: string, campaignId: string) {
  return (err: unknown) => {
    console.error("campaigns: coupon generation failed", {
      orgId,
      campaignId,
      error: errorSummary(err),
    });
  };
}

/**
 * Insert a campaign together with its default banner config, in one
 * transaction: a campaign without a banner config can't be shown or edited in
 * the dashboard, so a failure of either insert leaves neither behind.
 */
export async function insertCampaignWithBanner(
  db: Pick<Database, "transaction">,
  values: typeof campaigns.$inferInsert & { id: string },
  bannerId: string,
  messageTemplate: string = DEFAULT_BANNER_MESSAGE,
): Promise<typeof campaigns.$inferSelect> {
  const now = values.createdAt ?? new Date();
  return db.transaction(async (tx) => {
    const [campaign] = await tx.insert(campaigns).values(values).returning();
    if (!campaign) throw new Error("campaign insert returned no row");
    await tx.insert(bannerConfigs).values({
      id: bannerId,
      campaignId: values.id,
      position: "bottom",
      messageTemplate,
      ctaText: DEFAULT_CTA_TEXT,
      backgroundColor: "#1a1a2e",
      textColor: "#ffffff",
      ctaColor: "#e94560",
      ctaTextColor: "#ffffff",
      showFlag: true,
      showCloseBtn: true,
      updatedAt: now,
    });
    return campaign;
  });
}

// List campaigns for organization
app.get("/v1/teams/:orgId/campaigns", requirePermission("campaigns.view"), async (c) => {
  const orgId = c.req.param("orgId");
  const db = createDb(c.env);

  try {
    const env = c.req.query("environment") as "live" | "test" | undefined;
    const conditions = [eq(campaigns.organizationId, orgId)];
    if (env) conditions.push(eq(campaigns.environment, env));

    // Restrict scoped members to campaigns under products they can access.
    const allowed = await allowedProductIdsFor(c, db, orgId);
    if (allowed) conditions.push(inArray(campaigns.productId, Array.from(allowed)));

    const result = await db
      .select()
      .from(campaigns)
      .where(and(...conditions));

    return c.json({ data: result });
  } catch (err) {
    console.error("campaigns: failed to fetch campaigns", { error: errorSummary(err) });
    return c.json({ error: "Failed to fetch campaigns" }, 500);
  }
});

// Create campaign (also auto-creates a default banner config)
app.post("/v1/teams/:orgId/campaigns", requirePermission("campaigns.create"), async (c) => {
  const orgId = c.req.param("orgId");
  const db = createDb(c.env);

  try {
    const body = await c.req.json();
    const parsed = createCampaignSchema.safeParse(body);

    if (!parsed.success) {
      return c.json({ error: "Validation failed", details: parsed.error.flatten() }, 400);
    }

    const refs = await validateOwnedRefs(
      db,
      orgId,
      parsed.data.productId,
      parsed.data.integrationId,
    );
    if (refs.error) return c.json({ error: refs.error }, 400);
    // Without an explicit environment the campaign takes its product's (the
    // schema's 'live' default would put a test product's campaign in live).
    const environmentGiven =
      typeof body === "object" && body !== null && (body as Record<string, unknown>).environment !== undefined;
    const environment: CampaignEnvironment = environmentGiven
      ? parsed.data.environment
      : (refs.productEnvironment ?? parsed.data.environment);
    const conflict =
      environmentMismatch(environment, refs.productEnvironment) ??
      liveOnlyProviderConflict(environment, refs.integration?.provider ?? null) ??
      missingKeyConflict(parsed.data.status, environment, refs.integration);
    if (conflict) return c.json(conflict, 400);
    const priceConflict = countryPriceConflict({
      status: parsed.data.status,
      delivery: parsed.data.discountDelivery,
      provider: refs.integration?.provider ?? null,
      providerProductId: parsed.data.providerProductId,
    });
    if (priceConflict) return c.json(priceConflict, 400);
    if (
      parsed.data.status === "active" &&
      parsed.data.discountDelivery === "provider_price" &&
      (await productTakenByAnotherCampaign(db, {
        organizationId: orgId,
        campaignId: null,
        integrationId: parsed.data.integrationId!,
        providerProductId: parsed.data.providerProductId!,
      }))
    ) {
      return c.json(COUNTRY_PRICES_PRODUCT_TAKEN, 409);
    }

    // Scoped members can only create campaigns for products they can access.
    const allowedForCreate = await allowedProductIdsFor(c, db, orgId);
    if (allowedForCreate && !allowedForCreate.has(parsed.data.productId)) {
      return c.json({ error: "No access to that product" }, 403);
    }
    if (allowedForCreate && (parsed.data.discountDelivery === "provider_price" || parsed.data.providerProductId)) {
      return c.json(COUNTRY_PRICES_NEED_FULL_ACCESS, 403);
    }

    // Auto-apply needs a linked provider to apply the discount at checkout.
    // Drafting one without an integration is fine, but an ACTIVE auto-apply
    // campaign with no integration can't do anything — reject it up front.
    if (
      parsed.data.status === "active" &&
      parsed.data.discountDelivery === "auto_apply" &&
      !parsed.data.integrationId
    ) {
      return c.json(
        { error: "Auto-apply campaigns need a payment integration before they can go active." },
        400,
      );
    }

    const campaignId = ulid();
    const bannerId = ulid();
    const now = new Date();

    // Campaign + default banner config, both or neither.
    const campaign = await insertCampaignWithBanner(
      db,
      {
        id: campaignId,
        organizationId: orgId,
        productId: parsed.data.productId,
        integrationId: parsed.data.integrationId ?? null,
        name: parsed.data.name,
        status: parsed.data.status,
        pricingMode: parsed.data.pricingMode,
        discountDelivery: parsed.data.discountDelivery,
        providerProductId: parsed.data.providerProductId ?? null,
        charmPricingStrategy: parsed.data.charmPricingStrategy,
        maxDiscountPercent: parsed.data.maxDiscountPercent,
        discountOverrides: parsed.data.discountOverrides ?? null,
        couponPrefix: parsed.data.couponPrefix ?? null,
        allowedDomains: parsed.data.allowedDomains ?? null,
        environment,
        createdAt: now,
        updatedAt: now,
      },
      bannerId,
      parsed.data.discountDelivery === "provider_price" ? DEFAULT_BANNER_MESSAGE_CHARGED : DEFAULT_BANNER_MESSAGE,
    );

    // Push pre-computed banner config to KV (fire-and-forget)
    c.executionCtx.waitUntil(
      pushBannerConfigForOrg(db, c.env.CACHE, orgId, c.env).catch(logBannerPushFailure(orgId)),
    );

    // Dodo charges the country prices: write them (services/campaign-country-prices).
    if (campaign.discountDelivery === "provider_price") {
      c.executionCtx.waitUntil(syncCountryPricesAfterCampaignChange(db, c.env, campaignId, campaign));
    }

    // Auto-generate coupons if campaign is active and linked to a provider
    if (campaign.status === "active" && campaign.integrationId) {
      c.executionCtx.waitUntil(
        generateCouponsForCampaign(db, c.env, c.env.CACHE, campaignId, orgId).catch(
          logCouponGenerationFailure(orgId, campaignId),
        ),
      );
    }

    return c.json({ data: campaign }, 201);
  } catch (err) {
    console.error("campaigns: failed to create campaign", { error: errorSummary(err) });
    return c.json({ error: "Failed to create campaign" }, 500);
  }
});

// Get single campaign
app.get("/v1/teams/:orgId/campaigns/:id", requirePermission("campaigns.view"), async (c) => {
  const orgId = c.req.param("orgId");
  const campaignId = c.req.param("id");
  const db = createDb(c.env);

  try {
    const result = await db
      .select()
      .from(campaigns)
      .where(and(eq(campaigns.id, campaignId), eq(campaigns.organizationId, orgId)))
      .limit(1);

    const campaign = result[0];
    if (!campaign) {
      return c.json({ error: "Campaign not found" }, 404);
    }

    const allowed = await allowedProductIdsFor(c, db, orgId);
    if (allowed && !allowed.has(campaign.productId)) {
      return c.json({ error: "Campaign not found" }, 404);
    }

    return c.json({ data: campaign });
  } catch (err) {
    console.error("campaigns: failed to fetch campaign", { error: errorSummary(err) });
    return c.json({ error: "Failed to fetch campaign" }, 500);
  }
});

// Update campaign
app.patch("/v1/teams/:orgId/campaigns/:id", requirePermission("campaigns.update"), async (c) => {
  const orgId = c.req.param("orgId");
  const campaignId = c.req.param("id");
  const db = createDb(c.env);

  try {
    const body = await c.req.json();
    const parsed = updateCampaignSchema.safeParse(body);

    if (!parsed.success) {
      return c.json({ error: "Validation failed", details: parsed.error.flatten() }, 400);
    }

    // Re-validate any product/integration refs that the update tries to set.
    const upd = parsed.data as {
      productId?: string;
      integrationId?: string | null;
    };
    const refs = await validateOwnedRefs(db, orgId, upd.productId, upd.integrationId);
    if (refs.error) return c.json({ error: refs.error }, 400);

    // Load the current campaign once — needed for access scoping, the active
    // transition check, and the auto-apply guard below.
    const [existing] = await db
      .select({
        status: campaigns.status,
        discountDelivery: campaigns.discountDelivery,
        integrationId: campaigns.integrationId,
        providerProductId: campaigns.providerProductId,
        productId: campaigns.productId,
        environment: campaigns.environment,
      })
      .from(campaigns)
      .where(and(eq(campaigns.id, campaignId), eq(campaigns.organizationId, orgId)))
      .limit(1);
    if (!existing) return c.json({ error: "Campaign not found" }, 404);

    // Scoped members must already have access to this campaign, and if moving it
    // to a different product, must have access to that product too.
    const allowedForUpdate = await allowedProductIdsFor(c, db, orgId);
    if (allowedForUpdate) {
      if (!allowedForUpdate.has(existing.productId)) {
        return c.json({ error: "Campaign not found" }, 404);
      }
      if (upd.productId && !allowedForUpdate.has(upd.productId)) {
        return c.json({ error: "No access to that product" }, 403);
      }
      // Which Dodo product (and Dodo account) gets the prices is set by a
      // member with access to every product; others may edit the rest.
      const choosesDodoProduct =
        (parsed.data.providerProductId !== undefined && parsed.data.providerProductId !== existing.providerProductId) ||
        (parsed.data.discountDelivery === "provider_price" && existing.discountDelivery !== "provider_price") ||
        (upd.integrationId !== undefined &&
          upd.integrationId !== existing.integrationId &&
          (parsed.data.discountDelivery ?? existing.discountDelivery) === "provider_price");
      if (choosesDodoProduct) return c.json(COUNTRY_PRICES_NEED_FULL_ACCESS, 403);
    }

    // An arm of a running A/B test must stay active and in the test's product
    // and environment until the test ends (services/experiment.service.ts).
    // No query unless the update sets a non-active status, productId or environment.
    const experimentConflict = await campaignUpdateBlockedByExperiment(db, orgId, campaignId, parsed.data);
    if (experimentConflict) return c.json(experimentConflict, 409);

    // The rules on the campaign's environment, product and integration, checked
    // only for what the update changes (each lookup runs only when needed):
    //  - its environment must stay its product's;
    //  - a test campaign can't use a provider with no test mode;
    //  - an active campaign needs the integration's key for its environment.
    const environmentChanged = parsed.data.environment !== undefined;
    const integrationChanged = upd.integrationId !== undefined;
    const nextEnvironment = parsed.data.environment ?? existing.environment;
    if (environmentChanged || upd.productId !== undefined) {
      const productEnvironment =
        upd.productId !== undefined
          ? refs.productEnvironment
          : await loadProductEnvironment(db, orgId, existing.productId);
      const mismatch = environmentMismatch(nextEnvironment, productEnvironment);
      if (mismatch) return c.json(mismatch, 400);
    }
    const nextIntegrationId = integrationChanged ? upd.integrationId : existing.integrationId;
    const nextStatus = parsed.data.status ?? existing.status;
    const checkLiveOnly = (environmentChanged || integrationChanged) && nextEnvironment === "test";
    const checkKey = nextStatus === "active" && (environmentChanged || integrationChanged || parsed.data.status === "active");
    if (nextIntegrationId && (checkLiveOnly || checkKey)) {
      const integration = integrationChanged
        ? refs.integration
        : await loadIntegrationFacts(db, orgId, nextIntegrationId);
      const conflict =
        (checkLiveOnly ? liveOnlyProviderConflict(nextEnvironment, integration?.provider ?? null) : null) ??
        (checkKey ? missingKeyConflict(nextStatus, nextEnvironment, integration) : null);
      if (conflict) return c.json(conflict, 400);
    }

    // Auto-apply needs a linked provider. Compute the effective post-update
    // config and refuse to leave the campaign active-but-unwired (e.g. flipping
    // delivery to auto_apply, clearing the integration, or activating).
    const effectiveStatus = parsed.data.status ?? existing.status;
    const effectiveDelivery = parsed.data.discountDelivery ?? existing.discountDelivery;
    const effectiveIntegrationId =
      upd.integrationId !== undefined ? upd.integrationId : existing.integrationId;
    if (
      effectiveStatus === "active" &&
      effectiveDelivery === "auto_apply" &&
      !effectiveIntegrationId
    ) {
      return c.json(
        { error: "Auto-apply campaigns need a payment integration before they can go active." },
        400,
      );
    }

    // A campaign whose payment platform charges the country price: Dodo only,
    // complete before it goes active, one campaign per Dodo product, no deals.
    const effectiveProviderProductId =
      parsed.data.providerProductId !== undefined ? parsed.data.providerProductId : existing.providerProductId;
    if (effectiveDelivery === "provider_price") {
      const provider = !effectiveIntegrationId
        ? null
        : integrationChanged
          ? (refs.integration?.provider ?? null)
          : ((await loadIntegrationFacts(db, orgId, effectiveIntegrationId))?.provider ?? null);
      const priceConflict = countryPriceConflict({
        status: effectiveStatus,
        delivery: effectiveDelivery,
        provider,
        providerProductId: effectiveProviderProductId,
      });
      if (priceConflict) return c.json(priceConflict, 400);
      if (
        effectiveStatus === "active" &&
        (await productTakenByAnotherCampaign(db, {
          organizationId: orgId,
          campaignId,
          integrationId: effectiveIntegrationId!,
          providerProductId: effectiveProviderProductId!,
        }))
      ) {
        return c.json(COUNTRY_PRICES_PRODUCT_TAKEN, 409);
      }
      if (existing.discountDelivery !== "provider_price") {
        const [openDeal] = await db
          .select({ id: deals.id })
          .from(deals)
          .where(and(eq(deals.campaignId, campaignId), eq(deals.organizationId, orgId), gt(deals.endsAt, new Date())))
          .limit(1);
        if (openDeal) return c.json(CAMPAIGN_HAS_DEALS, 409);
      }
    } else if (
      effectiveStatus === "active" &&
      (existing.discountDelivery === "provider_price" || existing.status !== "active")
    ) {
      // Codes on an active campaign: never while Dodo may still charge the
      // country prices it set (a code on top would discount twice).
      const left = await countryPricesLeft(db, campaignId);
      if (left > 0) return c.json(countryPricesLeftBody(left), 409);
    }

    // Previous status drives the active-transition coupon generation below.
    const previousStatus = existing.status;

    const result = await db
      .update(campaigns)
      .set({ ...parsed.data, updatedAt: new Date() })
      .where(and(eq(campaigns.id, campaignId), eq(campaigns.organizationId, orgId)))
      .returning();

    const campaign = result[0];
    if (!campaign) {
      return c.json({ error: "Campaign not found" }, 404);
    }

    // Push pre-computed banner config to KV (fire-and-forget)
    c.executionCtx.waitUntil(
      pushBannerConfigForOrg(db, c.env.CACHE, orgId, c.env).catch(logBannerPushFailure(orgId)),
    );

    // Dodo charges the country prices: bring them in line, or remove them once
    // the campaign no longer wants them (services/campaign-country-prices).
    if (existing.discountDelivery === "provider_price" || campaign.discountDelivery === "provider_price") {
      c.executionCtx.waitUntil(syncCountryPricesAfterCampaignChange(db, c.env, campaignId, campaign));
    }

    // The codes of the campaign's holiday deals belong to its integration and
    // environment: after either changed, they are created there (and the old
    // ones removed). The document is written again only when a code changed.
    if (integrationChanged || environmentChanged) {
      c.executionCtx.waitUntil(
        syncDealCouponsForCampaign(db, c.env, orgId, campaignId).then((codesChanged) =>
          codesChanged
            ? pushBannerConfigForOrg(db, c.env.CACHE, orgId, c.env).catch(logBannerPushFailure(orgId))
            : undefined,
        ),
      );
    }

    // Auto-generate coupons only when transitioning to active
    const isTransitionToActive =
      parsed.data.status === "active" && previousStatus !== "active";
    if (isTransitionToActive && campaign.integrationId) {
      c.executionCtx.waitUntil(
        generateCouponsForCampaign(db, c.env, c.env.CACHE, campaignId, orgId).catch(
          logCouponGenerationFailure(orgId, campaignId),
        ),
      );
    }

    return c.json({ data: campaign });
  } catch (err) {
    console.error("campaigns: failed to update campaign", { error: errorSummary(err) });
    return c.json({ error: "Failed to update campaign" }, 500);
  }
});

/** The campaign when it is in the org and inside the caller's product scope. */
async function scopedCampaign(c: Context<AppEnv>, db: Database, orgId: string, campaignId: string) {
  const [campaign] = await db
    .select()
    .from(campaigns)
    .where(and(eq(campaigns.id, campaignId), eq(campaigns.organizationId, orgId)))
    .limit(1);
  if (!campaign) return null;
  const allowed = await allowedProductIdsFor(c, db, orgId);
  return allowed && !allowed.has(campaign.productId) ? null : campaign;
}

// The prices Dodo charges for a campaign it prices, and how the last sync went
// (services/campaign-country-prices).
app.get("/v1/teams/:orgId/campaigns/:id/country-prices", requirePermission("campaigns.view"), async (c) => {
  const orgId = c.req.param("orgId");
  const db = createDb(c.env);
  try {
    const campaign = await scopedCampaign(c, db, orgId, c.req.param("id"));
    if (!campaign) return c.json({ error: "Campaign not found" }, 404);
    return c.json({ data: await countryPriceStatus(db, campaign.id) });
  } catch (err) {
    console.error("campaigns: failed to read country prices", { error: errorSummary(err) });
    return c.json({ error: "Failed to read the country prices" }, 500);
  }
});

// Sync now: one batch of the campaign's country prices with Dodo, in the
// request, then the same answer as the GET. The scheduled job does the rest.
app.post("/v1/teams/:orgId/campaigns/:id/country-prices/sync", requirePermission("campaigns.update"), async (c) => {
  const orgId = c.req.param("orgId");
  const db = createDb(c.env);
  try {
    const campaign = await scopedCampaign(c, db, orgId, c.req.param("id"));
    if (!campaign) return c.json({ error: "Campaign not found" }, 404);
    if (campaign.discountDelivery !== "provider_price") {
      return c.json({ error: "This campaign doesn't let Dodo charge the country price.", code: "not_country_prices" }, 400);
    }
    const ids = await reconcileCampaignCountryPrices(db, campaign.id, campaign);
    await syncCampaignCountryPrices(db, c.env, ids, "manual");
    return c.json({ data: await countryPriceStatus(db, campaign.id) });
  } catch (err) {
    console.error("campaigns: country price sync failed", { error: errorSummary(err) });
    return c.json({ error: "Failed to sync the country prices" }, 500);
  }
});

/** Thrown inside the delete transaction to roll it back; the route answers 404. */
class CampaignNotFoundError extends Error {
  constructor() {
    super("Campaign not found");
    this.name = "CampaignNotFoundError";
  }
}

/**
 * Delete a campaign with its coupons and banner config: one transaction, every
 * statement scoped to `orgId`. Returns false (and rolls back) when the campaign
 * is not in `orgId`, is outside the caller's product scope, or is gone by the
 * time the final delete runs; nothing is deleted in any of those cases.
 *
 * Why each piece matters (campaign ids are public: the banner response carries
 * `campaignId`):
 *  - The ownership check runs inside the transaction, before any delete.
 *  - The child deletes match coupons/banner_configs only through a campaign
 *    row that belongs to `orgId` (those tables have no organization_id), so
 *    they cannot reach another org's rows even if the check were removed.
 *  - A campaign delete that matches zero rows throws, rolling back the child
 *    deletes instead of committing them.
 * coupons -> campaigns has no ON DELETE CASCADE, so children go first.
 * An arm of a running A/B test is refused (CampaignInRunningExperimentError,
 * thrown after the access check and before any delete).
 */
export async function deleteCampaignCascade(
  db: Pick<Database, "transaction">,
  params: { orgId: string; campaignId: string; userId: string; role: string | undefined },
): Promise<boolean> {
  const { orgId, campaignId, userId, role } = params;
  const inOrg = () => and(eq(campaigns.id, campaignId), eq(campaigns.organizationId, orgId));

  try {
    await db.transaction(async (tx) => {
      if (!(await assertCampaignAccess(tx, userId, role, orgId, campaignId))) {
        throw new CampaignNotFoundError();
      }
      // Throws CampaignInRunningExperimentError (route: 409) while the campaign
      // is an arm of a running A/B test. Ended tests keep their history.
      await assertCampaignNotInRunningExperiment(tx, orgId, campaignId);

      const ownedCampaign = () => tx.select({ id: campaigns.id }).from(campaigns).where(inOrg());
      await tx.delete(coupons).where(inArray(coupons.campaignId, ownedCampaign()));
      await tx.delete(bannerConfigs).where(inArray(bannerConfigs.campaignId, ownedCampaign()));

      const deleted = await tx
        .delete(campaigns)
        .where(inOrg())
        .returning({ id: campaigns.id });
      if (deleted.length === 0) throw new CampaignNotFoundError();
    });
    return true;
  } catch (err) {
    if (err instanceof CampaignNotFoundError) return false;
    throw err;
  }
}

// Delete campaign
app.delete("/v1/teams/:orgId/campaigns/:id", requirePermission("campaigns.delete"), async (c) => {
  const orgId = c.req.param("orgId");
  const campaignId = c.req.param("id");
  const db = createDb(c.env);

  try {
    const deleted = await deleteCampaignCascade(db, {
      orgId,
      campaignId,
      ...scopeOf(c),
    });
    if (!deleted) {
      return c.json({ error: "Campaign not found" }, 404);
    }

    // Push pre-computed banner config to KV (fire-and-forget)
    c.executionCtx.waitUntil(
      pushBannerConfigForOrg(db, c.env.CACHE, orgId, c.env).catch(logBannerPushFailure(orgId)),
    );
    // Country prices it set at Dodo are removed (nothing when it set none).
    c.executionCtx.waitUntil(syncCountryPricesAfterCampaignChange(db, c.env, campaignId, null));

    return c.json({ success: true });
  } catch (err) {
    if (err instanceof CampaignInRunningExperimentError) return c.json(err.body, 409);
    console.error("campaigns: delete failed", { orgId, campaignId, error: errorSummary(err) });
    return c.json({ error: "Failed to delete campaign" }, 500);
  }
});

export default app;
