import { Hono, type Context } from "hono";
import { eq, and } from "drizzle-orm";
import { ulid } from "ulid";
import type { AppEnv } from "../bindings";
import { createDb, type Database } from "../db";
import { campaigns, coupons, integrations, products } from "../db/schema";
import { createIntegrationSchema, normalizeProviderAccountId } from "@gopaylocal/shared/validation";
import type { IntegrationProvider } from "@gopaylocal/shared";
import { supportedCurrency } from "@gopaylocal/shared/currency";
import { encrypt, decrypt, tokenEncryptionSecret } from "../lib/crypto";
import {
  createProvider,
  ProviderError,
  ProviderAuthError,
  accessTokenEncFor,
  providerAccountIdFor,
  providerConfigFor,
  webhookCallbackPath,
  webhookSlotColumns,
  webhookSlotFor,
  type PaymentProvider,
  type ProviderConfig,
} from "../services/providers";
import { getProductLimitInfo } from "../lib/limits";
import { errorSummary, logBannerPushFailure } from "../lib/log";
import { requirePermission } from "../middleware/permissions";
import {
  clearIntegrationIssue,
  describeError,
  integrationHealthOf,
  recordIntegrationIssue,
  withHealthIssue,
  withoutHealthIssue,
  type IntegrationHealthIssue,
} from "../services/integration-health.service";
import { removeIntegrationWebhooks } from "../services/integration-webhooks.service";
import {
  assertIntegrationDisconnectKeepsExperiments,
  IntegrationInRunningExperimentError,
} from "../services/experiment.service";
import { pushBannerConfigForOrg } from "../services/banner-cache.service";

const app = new Hono<AppEnv>();

type IntegrationRow = typeof integrations.$inferSelect;
type Environment = "live" | "test";

/** Providers whose webhooks carry no signature (Gumroad pings are unsigned by design). */
const UNSIGNED_WEBHOOK_PROVIDERS = new Set(["gumroad"]);

/**
 * Redemption tracking state of one environment, from the integration row:
 *  - active: an endpoint is provisioned (with a signing secret where the provider signs)
 *  - missing: none is provisioned; redemptions are not being tracked
 *  - needs_attention: an endpoint exists but no secret was stored, so no
 *    delivery can ever verify; re-create it
 * Each environment with credentials has its own endpoint (live and test).
 */
export interface WebhookStatus {
  status: "active" | "missing" | "needs_attention";
}

/** Per environment; null when the integration has no credentials for it. */
export type WebhookStatuses = Record<Environment, WebhookStatus | null>;

/** Outcome of a provisioning attempt, returned to the dashboard right away. */
export interface WebhookSetupResult {
  status: "active" | "failed" | "unsupported" | "skipped";
  environment: Environment | null;
  error?: string;
}

function webhookStatusOf(i: IntegrationRow, environment: Environment): WebhookStatus | null {
  if (!accessTokenEncFor(i, environment)) return null;
  const slot = webhookSlotFor(i, environment);
  if (!slot.endpointId) return { status: "missing" };
  if (!slot.secretEnc && !UNSIGNED_WEBHOOK_PROVIDERS.has(i.provider)) return { status: "needs_attention" };
  return { status: "active" };
}

function healthIssues(i: IntegrationRow): IntegrationHealthIssue[] {
  return Object.values(integrationHealthOf(i))
    .filter((x): x is IntegrationHealthIssue => !!x)
    .sort((a, b) => b.at.localeCompare(a.at));
}

/** The public shape of an integration: flags instead of encrypted tokens. */
function serializeIntegration(i: IntegrationRow) {
  return {
    id: i.id,
    organizationId: i.organizationId,
    provider: i.provider,
    providerAccountId: i.providerAccountId,
    testProviderAccountId: i.testProviderAccountId,
    status: i.status,
    hasLiveCredentials: !!i.liveAccessTokenEnc,
    hasTestCredentials: !!i.testAccessTokenEnc,
    webhooks: { live: webhookStatusOf(i, "live"), test: webhookStatusOf(i, "test") } satisfies WebhookStatuses,
    health: healthIssues(i),
    createdAt: i.createdAt,
    updatedAt: i.updatedAt,
  };
}

async function providerForIntegration(
  c: Context<AppEnv>,
  integration: IntegrationRow,
  environment: Environment,
): Promise<PaymentProvider> {
  const enc = accessTokenEncFor(integration, environment);
  if (!enc) throw new Error(`No ${environment} credentials stored`);
  const apiKey = await decrypt(enc, tokenEncryptionSecret(c.env));
  return createProvider(integration.provider, providerConfigFor(integration, environment, apiKey));
}

type KeyCheck = { ok: true } | { ok: false; status: 400 | 502; code: string; message: string };

/**
 * Asks the platform to list discounts with a key before the key is stored:
 * the same call as the Test button, with the same permissions. A key the
 * platform refuses (wrong, revoked, or missing a permission that listing
 * needs) is reported and nothing is saved. The platform's own message is
 * passed on, because it usually names what is missing.
 */
async function checkKey(provider: IntegrationProvider, config: ProviderConfig): Promise<KeyCheck> {
  try {
    await createProvider(provider, config).listDiscounts();
    return { ok: true };
  } catch (err) {
    if (err instanceof ProviderAuthError) {
      return { ok: false, status: 400, code: "key_rejected", message: `The key was rejected: ${err.message}` };
    }
    if (err instanceof ProviderError) {
      return { ok: false, status: 502, code: "key_unchecked", message: `Couldn't check the key: ${err.message}` };
    }
    console.error(`[integrations] key check failed for ${provider}:`, describeError(err));
    return { ok: false, status: 502, code: "key_unchecked", message: "Couldn't check the key with the platform. Try again." };
  }
}

function isNotFound(err: unknown): boolean {
  return err instanceof ProviderError && err.statusCode === 404;
}

/** Best-effort removal of a webhook endpoint at the provider. Never throws. */
async function teardownWebhook(
  c: Context<AppEnv>,
  integration: IntegrationRow,
  environment: Environment,
  endpointId: string,
): Promise<void> {
  try {
    const provider = await providerForIntegration(c, integration, environment);
    await provider.deleteWebhook?.(endpointId);
  } catch (err) {
    if (isNotFound(err)) return;
    console.error(
      `[integrations] webhook teardown failed ${integration.provider}:${integration.id} endpoint=${endpointId}:`,
      describeError(err),
    );
  }
}

/**
 * Make sure the integration has its redemption webhook for `environment`.
 * With `replace`, an existing endpoint is removed and a fresh one created (the
 * dashboard's "re-create" action). Failures are returned, logged and recorded
 * on the integration's health.
 */
async function ensureWebhook(
  c: Context<AppEnv>,
  db: Database,
  integration: IntegrationRow,
  environment: Environment,
  opts: { replace?: boolean } = {},
): Promise<{ result: WebhookSetupResult; integration: IntegrationRow }> {
  if (!accessTokenEncFor(integration, environment)) {
    return { result: { status: "skipped", environment: null }, integration };
  }
  const slot = webhookSlotFor(integration, environment);
  if (slot.endpointId && !opts.replace) {
    return { result: { status: "active", environment }, integration };
  }

  // `base`: the row as it stands at the failure (a replaced endpoint may already be cleared).
  const fail = async (err: unknown, base: IntegrationRow = integration, userMessage?: string) => {
    const message = userMessage ?? (err instanceof ProviderError ? err.message : describeError(err));
    console.error(
      `[integrations] webhook setup failed ${integration.provider}:${integration.id} env=${environment}:`,
      describeError(err),
    );
    const issue = await recordIntegrationIssue(db, integration, {
      area: "webhook_setup",
      environment,
      message: `Redemption tracking isn't set up: ${message}`,
    });
    return {
      result: { status: "failed" as const, environment, error: message },
      integration: withHealthIssue(base, issue),
    };
  };

  let provider: PaymentProvider;
  try {
    provider = await providerForIntegration(c, integration, environment);
  } catch (err) {
    return fail(err);
  }
  if (!provider.provisionWebhook) {
    return { result: { status: "unsupported", environment }, integration };
  }

  const emptySlot = webhookSlotColumns(environment, { endpointId: null, secretEnc: null });
  let current = integration;
  if (opts.replace && slot.endpointId) {
    // Remove the old endpoint first: two endpoints would deliver every event
    // twice, and some providers cap endpoints per account (Chargebee: 5).
    try {
      await provider.deleteWebhook?.(slot.endpointId);
    } catch (err) {
      if (!isNotFound(err)) {
        console.error(
          `[integrations] could not remove old ${environment} webhook ${slot.endpointId} for ${integration.id}:`,
          describeError(err),
        );
      }
    }
    try {
      const [cleared] = await db
        .update(integrations)
        .set({ ...emptySlot, updatedAt: new Date() })
        .where(eq(integrations.id, integration.id))
        .returning();
      current = cleared ?? { ...integration, ...emptySlot };
    } catch (err) {
      return fail(err, integration, "Couldn't save the webhook configuration. Try again.");
    }
  }

  let endpointId: string;
  let secret: string | null;
  try {
    const base = c.env.API_BASE_URL ?? new URL(c.req.url).origin;
    ({ endpointId, secret } = await provider.provisionWebhook(
      `${base}${webhookCallbackPath(integration.provider, integration.id, environment)}`,
    ));
  } catch (err) {
    return fail(err, current);
  }

  try {
    const stored = webhookSlotColumns(environment, {
      endpointId,
      secretEnc: secret ? await encrypt(secret, tokenEncryptionSecret(c.env)) : null,
    });
    const [updated] = await db
      .update(integrations)
      .set({ ...stored, updatedAt: new Date() })
      .where(eq(integrations.id, integration.id))
      .returning();
    const final = updated ?? { ...current, ...stored };
    await clearIntegrationIssue(db, current, "webhook_setup");
    return { result: { status: "active", environment }, integration: withoutHealthIssue(final, "webhook_setup") };
  } catch (err) {
    // The endpoint exists at the provider but we couldn't store it: it would
    // post to us forever with a secret we don't have. Undo it.
    await provider.deleteWebhook?.(endpointId).catch((undoErr: unknown) => {
      console.error(`[integrations] orphaned webhook ${endpointId} for ${integration.id}:`, describeError(undoErr));
    });
    return fail(err, current, "Couldn't save the webhook configuration. Try again.");
  }
}

// List integrations for organization
app.get("/v1/teams/:orgId/integrations", requirePermission("integrations.view"), async (c) => {
  const orgId = c.req.param("orgId");
  const db = createDb(c.env);

  try {
    const rows = await db.select().from(integrations).where(eq(integrations.organizationId, orgId));
    return c.json({ data: rows.map(serializeIntegration) });
  } catch (err) {
    console.error("Failed to fetch integrations:", errorSummary(err));
    return c.json({ error: "Failed to fetch integrations" }, 500);
  }
});

// Connect a payment provider (or update credentials for an environment)
app.post("/v1/teams/:orgId/integrations", requirePermission("integrations.manage"), async (c) => {
  const orgId = c.req.param("orgId");
  const db = createDb(c.env);

  try {
    const body = await c.req.json();
    const parsed = createIntegrationSchema.safeParse(body);

    if (!parsed.success) {
      // The schema's own messages (account id format, WooCommerce key pair, no
      // test mode) say what to fix; the dashboard shows `error`.
      const message = parsed.error.issues.find((i) => i.code === "custom")?.message;
      return c.json({ error: message ?? "Validation failed", details: parsed.error.flatten() }, 400);
    }

    const env: Environment = parsed.data.environment ?? "live";
    const encryptionSecret = tokenEncryptionSecret(c.env);
    const account = normalizeProviderAccountId(parsed.data.provider, parsed.data.providerAccountId, env);
    const providerAccountId = account.ok ? account.value : undefined;

    // Check for existing integration for this provider
    const [existing] = await db
      .select()
      .from(integrations)
      .where(
        and(
          eq(integrations.organizationId, orgId),
          eq(integrations.provider, parsed.data.provider),
        ),
      )
      .limit(1);

    // Nothing is stored until the platform accepts the key, checked with the
    // account id it will be saved with.
    const check = await checkKey(parsed.data.provider, {
      apiKey: parsed.data.accessToken,
      environment: env,
      siteId: providerAccountId,
    });
    if (!check.ok) {
      return c.json({ error: check.message, code: check.code }, check.status);
    }

    const accessTokenEnc = await encrypt(parsed.data.accessToken, encryptionSecret);
    const refreshTokenEnc = parsed.data.refreshToken
      ? await encrypt(parsed.data.refreshToken, encryptionSecret)
      : null;

    if (existing) {
      // Each environment has its own account id (test falls back to the live
      // one when none was given) and its own webhook endpoint, so updating one
      // environment never touches the other.
      const storedAccount = providerAccountIdFor(existing, env);
      const accountChanged = !!providerAccountId && providerAccountId !== storedAccount;

      // This environment's webhook must be replaced (cleared in the same write
      // that stores the new credentials, old endpoint removed with the OLD
      // credentials, new one provisioned below) when its key or account id
      // changes: the endpoint may belong to another account now, and then no
      // redemption would ever arrive. Re-submitting the same key changes nothing.
      const slot = webhookSlotFor(existing, env);
      let replaceSlot = false;
      if (slot.endpointId) {
        const oldEnc = accessTokenEncFor(existing, env);
        const oldKey = oldEnc ? await decrypt(oldEnc, encryptionSecret).catch(() => null) : null;
        replaceSlot = accountChanged || oldKey !== parsed.data.accessToken;
      }

      const accountUpdate: Partial<typeof integrations.$inferInsert> = {};
      if (providerAccountId) {
        if (env === "test") {
          accountUpdate.testProviderAccountId = providerAccountId;
        } else {
          accountUpdate.providerAccountId = providerAccountId;
          // Test mode without its own id has been following the live one; keep
          // it on the account it was using when the live id moves elsewhere.
          if (accountChanged && existing.testAccessTokenEnc && !existing.testProviderAccountId && existing.providerAccountId) {
            accountUpdate.testProviderAccountId = existing.providerAccountId;
          }
        }
      }

      const updateData: Partial<typeof integrations.$inferInsert> = {
        updatedAt: new Date(),
        ...(env === "test"
          ? { testAccessTokenEnc: accessTokenEnc, testRefreshTokenEnc: refreshTokenEnc }
          : { liveAccessTokenEnc: accessTokenEnc, liveRefreshTokenEnc: refreshTokenEnc }),
        ...accountUpdate,
        ...(replaceSlot ? webhookSlotColumns(env, { endpointId: null, secretEnc: null }) : {}),
      };

      const [updated] = await db
        .update(integrations)
        .set(updateData)
        .where(eq(integrations.id, existing.id))
        .returning();

      if (replaceSlot && slot.endpointId) {
        // `existing` still carries the old key and account id.
        await teardownWebhook(c, existing, env, slot.endpointId);
      }

      // Provisions when this environment has no endpoint: its first
      // credentials, replaced credentials, or a previous failure.
      const { result: webhookSetup, integration: final } = await ensureWebhook(c, db, updated!, env);
      return c.json({ data: { ...serializeIntegration(final), webhookSetup } });
    }

    // Create new integration
    const id = ulid();
    const now = new Date();

    const values: typeof integrations.$inferInsert = {
      id,
      organizationId: orgId,
      provider: parsed.data.provider,
      ...(env === "test"
        ? { testProviderAccountId: providerAccountId ?? null }
        : { providerAccountId: providerAccountId ?? null }),
      status: "active",
      createdAt: now,
      updatedAt: now,
      ...(env === "test"
        ? { testAccessTokenEnc: accessTokenEnc, testRefreshTokenEnc: refreshTokenEnc }
        : { liveAccessTokenEnc: accessTokenEnc, liveRefreshTokenEnc: refreshTokenEnc }),
    };

    const [integration] = await db.insert(integrations).values(values).returning();

    // Auto-provision the redemption-tracking webhook in the credentials'
    // environment. Non-fatal: the integration still connects if this fails
    // (e.g. the key lacks webhook scope), but the result is returned so the
    // dashboard can say so, and it stays visible on the integration.
    const { result: webhookSetup, integration: final } = await ensureWebhook(c, db, integration!, env);
    return c.json({ data: { ...serializeIntegration(final), webhookSetup } }, 201);
  } catch (err) {
    // errorSummary: SQLSTATE + driver message, never the query's parameter
    // values (which here include the encrypted credentials).
    console.error("Failed to create integration:", errorSummary(err));
    return c.json({ error: "Failed to create integration" }, 500);
  }
});

// (Re-)create the redemption webhook, e.g. after fixing key permissions.
app.post("/v1/teams/:orgId/integrations/:id/webhook", requirePermission("integrations.manage"), async (c) => {
  const orgId = c.req.param("orgId");
  const integrationId = c.req.param("id");
  const db = createDb(c.env);

  try {
    const [integration] = await db
      .select()
      .from(integrations)
      .where(and(eq(integrations.id, integrationId), eq(integrations.organizationId, orgId)))
      .limit(1);
    if (!integration) return c.json({ error: "Integration not found" }, 404);

    // ?environment=live|test picks the endpoint; without it, live when live
    // credentials exist, otherwise test.
    const requested = c.req.query("environment");
    const environment: Environment =
      requested === "test" || requested === "live" ? requested : integration.liveAccessTokenEnc ? "live" : "test";
    if (!accessTokenEncFor(integration, environment)) {
      return c.json({ error: `No ${environment} credentials stored` }, 400);
    }

    const { result: webhookSetup, integration: final } = await ensureWebhook(c, db, integration, environment, {
      replace: true,
    });
    return c.json({ data: { ...serializeIntegration(final), webhookSetup } });
  } catch (err) {
    console.error("Failed to set up webhook:", describeError(err));
    return c.json({ error: "Failed to set up webhook" }, 500);
  }
});

// Test connection for an integration
app.post("/v1/teams/:orgId/integrations/:id/test", requirePermission("integrations.manage"), async (c) => {
  const orgId = c.req.param("orgId");
  const integrationId = c.req.param("id");
  const env = (c.req.query("environment") === "test" ? "test" : "live") as Environment;
  const db = createDb(c.env);

  try {
    const [integration] = await db
      .select()
      .from(integrations)
      .where(
        and(
          eq(integrations.id, integrationId),
          eq(integrations.organizationId, orgId),
        ),
      )
      .limit(1);

    if (!integration) {
      return c.json({ ok: false, message: "Integration not found" }, 404);
    }

    if (!accessTokenEncFor(integration, env)) {
      return c.json({ ok: false, message: `No ${env} credentials stored` }, 400);
    }

    try {
      const provider = await providerForIntegration(c, integration, env);
      await provider.listDiscounts();
    } catch (err) {
      if (err instanceof ProviderAuthError) {
        await recordIntegrationIssue(db, integration, {
          area: "credentials",
          environment: env,
          message: `The ${env} API key was rejected: ${err.message}`,
        });
        return c.json({ ok: false, message: "Authentication failed — check your API key" });
      }
      if (err instanceof ProviderError) {
        return c.json({ ok: false, message: `Provider error: ${err.message}` });
      }
      return c.json({ ok: false, message: "Connection test failed" });
    }

    await clearIntegrationIssue(db, integration, "credentials");
    return c.json({ ok: true, message: "Connection successful" });
  } catch (err) {
    return c.json({ ok: false, message: "Connection test failed" });
  }
});

// List products from a connected provider
app.get("/v1/teams/:orgId/integrations/:id/products", requirePermission("integrations.import"), async (c) => {
  const orgId = c.req.param("orgId");
  const integrationId = c.req.param("id");
  const env = (c.req.query("environment") === "test" ? "test" : "live") as Environment;
  const db = createDb(c.env);

  try {
    const [integration] = await db
      .select()
      .from(integrations)
      .where(
        and(
          eq(integrations.id, integrationId),
          eq(integrations.organizationId, orgId),
        ),
      )
      .limit(1);

    if (!integration) {
      return c.json({ error: "Integration not found" }, 404);
    }

    if (!accessTokenEncFor(integration, env)) {
      return c.json({ error: `No ${env} credentials stored` }, 400);
    }

    const provider = await providerForIntegration(c, integration, env);

    if (!provider.listProducts) {
      return c.json({ error: "This provider does not support product listing" }, 400);
    }

    const providerProducts = await provider.listProducts();
    return c.json({ data: providerProducts });
  } catch (err) {
    if (err instanceof ProviderAuthError) {
      return c.json({ error: "Authentication failed" }, 401);
    }
    if (err instanceof ProviderError) {
      return c.json({ error: err.message }, 500);
    }
    return c.json({ error: "Failed to fetch provider products" }, 500);
  }
});

// Import products from a connected provider
app.post("/v1/teams/:orgId/integrations/:id/products/import", requirePermission("integrations.import"), async (c) => {
  const orgId = c.req.param("orgId");
  const integrationId = c.req.param("id");
  const db = createDb(c.env);

  try {
    const body = (await c.req.json()) as { productIds?: unknown; environment?: unknown };
    const env: Environment = body.environment === "test" ? "test" : "live";

    if (!Array.isArray(body.productIds) || body.productIds.length === 0) {
      return c.json({ error: "No product IDs provided" }, 400);
    }
    if (!body.productIds.every((id): id is string => typeof id === "string")) {
      return c.json({ error: "productIds must be an array of strings" }, 400);
    }
    const productIds: string[] = body.productIds;

    const [integration] = await db
      .select()
      .from(integrations)
      .where(
        and(
          eq(integrations.id, integrationId),
          eq(integrations.organizationId, orgId),
        ),
      )
      .limit(1);

    if (!integration) {
      return c.json({ error: "Integration not found" }, 404);
    }

    if (!accessTokenEncFor(integration, env)) {
      return c.json({ error: `No ${env} credentials stored` }, 400);
    }

    const provider = await providerForIntegration(c, integration, env);

    if (!provider.listProducts) {
      return c.json({ error: "This provider does not support product listing" }, 400);
    }

    const allProviderProducts = await provider.listProducts();

    const toImport = allProviderProducts.filter((p) =>
      productIds.includes(p.providerProductId),
    );

    // Check product limits before importing
    const limitInfo = await getProductLimitInfo(db, orgId, c.env);
    if (limitInfo.remaining <= 0) {
      return c.json({
        error: "Product limit reached",
        plan: limitInfo.plan,
        maxProducts: limitInfo.maxProducts,
        currentCount: limitInfo.currentCount,
        remaining: 0,
      }, 403);
    }

    // Products already in this org + environment are skipped: matched by URL,
    // or by name for one stored without a URL.
    const existingProducts = await db
      .select({ url: products.url, name: products.name })
      .from(products)
      .where(and(eq(products.organizationId, orgId), eq(products.environment, env)));
    const importKey = (url: string, name: string) => (url ? `url:${url}` : `name:${name}`);
    const existing = new Set(existingProducts.map((p) => importKey(p.url, p.name)));

    let imported = 0;
    const skipped: Array<{ providerProductId: string; name: string; currency: string; reason: "unsupported_currency" }> = [];
    const now = new Date();

    for (const pp of toImport) {
      if (imported >= limitInfo.remaining) break;

      // Never invent a URL (a guessed https://{provider}.com/... address is
      // someone else's site). Providers without product pages (Stripe and
      // Paddle never return one) leave it empty for the merchant to fill in.
      const url = pp.url ?? "";
      const key = importKey(url, pp.name);
      if (existing.has(key)) continue;

      // This insert bypasses the product schema, so it applies the schema's
      // currency rule itself: upper case (Stripe, Gumroad and others return
      // "usd") and one of SUPPORTED_CURRENCIES. A product priced in another
      // currency is skipped and reported, not imported under a made-up code
      // and not failing the rest of the import. A provider that returns no
      // currency at all still gets USD, as before.
      const currency = pp.currency ? supportedCurrency(pp.currency) : "USD";
      if (currency === null) {
        skipped.push({
          providerProductId: pp.providerProductId,
          name: pp.name,
          currency: pp.currency!,
          reason: "unsupported_currency",
        });
        continue;
      }

      await db.insert(products).values({
        id: ulid(),
        organizationId: orgId,
        name: pp.name,
        url,
        currency,
        basePrice: pp.price ?? 0,
        environment: env,
        createdAt: now,
        updatedAt: now,
      });
      existing.add(key);
      imported++;
    }

    return c.json({
      data: {
        imported,
        limitReached: imported >= limitInfo.remaining,
        skipped,
      },
    });
  } catch (err) {
    if (err instanceof ProviderError) {
      return c.json({ error: err.message }, 500);
    }
    return c.json({ error: "Failed to import products" }, 500);
  }
});

// Disconnect an integration
app.delete("/v1/teams/:orgId/integrations/:id", requirePermission("integrations.manage"), async (c) => {
  const orgId = c.req.param("orgId");
  const integrationId = c.req.param("id");
  const db = createDb(c.env);

  try {
    const [integration] = await db
      .select()
      .from(integrations)
      .where(and(eq(integrations.id, integrationId), eq(integrations.organizationId, orgId)))
      .limit(1);

    if (!integration) {
      return c.json({ error: "Integration not found" }, 404);
    }

    // Database first, in one transaction. (Tearing the webhooks down first and
    // then failing here used to leave a connected-looking integration whose
    // redemptions no longer arrived.) The foreign keys would null
    // campaigns.integration_id and delete the coupon rows on their own; doing it
    // explicitly here lets the response say what happened.
    const now = new Date();
    const { pausedCampaigns, codesLeftAtProvider } = await db.transaction(async (tx) => {
      // Refused (409) before anything changes, here or at the provider, when
      // the pause below would hit an arm of a running A/B test
      // (services/experiment.service.ts).
      await assertIntegrationDisconnectKeepsExperiments(tx, orgId, integrationId);
      // An active auto-apply campaign can't work without a provider (the
      // campaigns route refuses that state), so pause it rather than leave it
      // active but unwired.
      const paused = await tx
        .update(campaigns)
        .set({ status: "paused", updatedAt: now })
        .where(
          and(
            eq(campaigns.organizationId, orgId),
            eq(campaigns.integrationId, integrationId),
            eq(campaigns.status, "active"),
            eq(campaigns.discountDelivery, "auto_apply"),
          ),
        )
        .returning({ id: campaigns.id });
      await tx
        .update(campaigns)
        .set({ integrationId: null, updatedAt: now })
        .where(and(eq(campaigns.organizationId, orgId), eq(campaigns.integrationId, integrationId)));
      const removed = await tx
        .delete(coupons)
        .where(eq(coupons.integrationId, integrationId))
        .returning({ status: coupons.status });
      await tx
        .delete(integrations)
        .where(and(eq(integrations.id, integrationId), eq(integrations.organizationId, orgId)));
      return {
        pausedCampaigns: paused.length,
        codesLeftAtProvider: removed.filter((r) => r.status !== "deleted").length,
      };
    });

    // Then best-effort provider cleanup: each environment's endpoint with that
    // environment's credentials.
    await removeIntegrationWebhooks(c.env, integration);

    // Banners must stop showing this provider's codes now, not at the next
    // unrelated config push.
    const refresh = pushBannerConfigForOrg(db, c.env.CACHE, orgId, c.env).catch(logBannerPushFailure(orgId));
    try {
      c.executionCtx.waitUntil(refresh);
    } catch {
      await refresh;
    }

    // Discount codes already created in the provider are left there (they may
    // be in customers' hands); the dashboard tells the merchant.
    return c.json({ success: true, pausedCampaigns, codesLeftAtProvider });
  } catch (err) {
    if (err instanceof IntegrationInRunningExperimentError) return c.json(err.body, 409);
    console.error("Failed to delete integration:", describeError(err));
    return c.json({ error: "Failed to delete integration" }, 500);
  }
});

export default app;
