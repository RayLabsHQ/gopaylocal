import { Hono, type Context } from "hono";
import { eq } from "drizzle-orm";
import { ulid } from "ulid";
import type { AppEnv, Bindings } from "../bindings";
import { createDb, type Database } from "../db";
import { webhookEvents, subscriptions, integrations } from "../db/schema";
import type { Plan } from "@gopaylocal/shared/types";
import { normalizePlan } from "@gopaylocal/shared/constants";
import { verifyStandardWebhook } from "../lib/standard-webhooks";
import { decrypt, tokenEncryptionSecret } from "../lib/crypto";
import { checkRateLimit } from "../lib/rate-limit";
import { isSelfHosted } from "../lib/entitlements";
import { errorSummary, logBannerPushFailure } from "../lib/log";
import {
  accessTokenEncFor,
  createProvider,
  providerConfigFor,
  webhookSlotFor,
} from "../services/providers";
import type { PaymentProvider } from "../services/providers/types";
import {
  ingestVerifiedWebhook,
  persistUnparsed,
  type IngestOutcome,
  type WebhookContext,
} from "../services/redemption-webhook.service";
import {
  clearIntegrationIssue,
  describeError,
  recordIntegrationIssue,
  type IntegrationRef,
} from "../services/integration-health.service";
import { pushBannerConfigForOrg } from "../services/banner-cache.service";

const app = new Hono<AppEnv>();

/**
 * Resolve the plan from the VERIFIED Dodo price/product id rather than trusting
 * client-supplied checkout metadata (which a buyer could tamper with to claim a
 * higher tier). Pro is the only paid plan (monthly or annual product). Returns
 * null when the id matches neither configured product.
 */
function planFromDodoPriceId(env: Bindings, priceId: string | undefined | null): Plan | null {
  if (!priceId) return null;
  if (priceId === env.DODO_PRICE_ID_PRO_MONTHLY || priceId === env.DODO_PRICE_ID_PRO_ANNUAL) {
    return "pro";
  }
  return null;
}

/**
 * POST /v1/webhooks/dodo
 * Dodo Payments webhook handler.
 * - Verifies the Standard Webhooks (standardwebhooks.com) signature
 * - Idempotency keyed off the `webhook-id` header
 * - Processes subscription + payment events
 *
 * NOTE: the exact payload field paths below (product_id, current_period_end,
 * customer_id, subscription_id) are read defensively from the Dodo event `data`
 * object; confirm them against a real test-mode Dodo webhook before launch.
 */
app.post("/v1/webhooks/dodo", async (c) => {
  // GoPayLocal's own billing: off on self-hosted deployments, like the billing
  // endpoints in routes/billing.ts (same response).
  if (isSelfHosted(c.env)) {
    return c.json({ error: "Billing is disabled on self-hosted deployments.", code: "billing_disabled" }, 404);
  }
  const db = createDb(c.env);

  try {
    const rawBody = await c.req.text();

    // Standard Webhooks headers (all lowercase).
    const webhookId = c.req.header("webhook-id");
    const isValid = await verifyStandardWebhook(
      rawBody,
      {
        id: webhookId,
        timestamp: c.req.header("webhook-timestamp"),
        signature: c.req.header("webhook-signature"),
      },
      c.env.DODO_WEBHOOK_SECRET,
      "whsec",
    );

    if (!isValid || !webhookId) {
      return c.json({ error: "Invalid webhook signature" }, 401);
    }

    const payload = JSON.parse(rawBody) as {
      type: string;
      data: Record<string, any>;
    };

    // Atomic idempotency: claim the webhook-id (unique). If no row is inserted,
    // we've already seen this delivery — skip if it was processed successfully.
    const eventId = ulid();
    const claimed = await db
      .insert(webhookEvents)
      .values({
        id: eventId,
        webhookId,
        eventType: payload.type,
        provider: "dodo",
        data: payload.data,
        processed: false,
        createdAt: new Date(),
      })
      .onConflictDoNothing({ target: webhookEvents.webhookId })
      .returning({ id: webhookEvents.id });

    if (claimed.length === 0) {
      const existing = await db
        .select({ processed: webhookEvents.processed })
        .from(webhookEvents)
        .where(eq(webhookEvents.webhookId, webhookId))
        .limit(1)
        .then((rows) => rows[0]);
      if (existing?.processed) {
        return c.json({ received: true, duplicate: true });
      }
      // A prior attempt failed mid-processing — fall through and retry it.
    }

    try {
      await processWebhookEvent(c.env, db, payload.type, payload.data, c.executionCtx);
      await db
        .update(webhookEvents)
        .set({ processed: true, processedAt: new Date(), errorMessage: null })
        .where(eq(webhookEvents.webhookId, webhookId));
    } catch (processErr) {
      console.error("[webhook] dodo billing event failed", {
        webhookId,
        type: payload.type,
        error: errorSummary(processErr),
      });
      // describeError: a query error's own message embeds its parameter values.
      const errorMessage = describeError(processErr);
      await db
        .update(webhookEvents)
        .set({ errorMessage, processedAt: new Date() })
        .where(eq(webhookEvents.webhookId, webhookId));
      // 500 so Dodo retries this delivery.
      return c.json({ error: "Event processing failed" }, 500);
    }

    return c.json({ received: true });
  } catch (err) {
    console.error("[webhook] dodo billing webhook failed", { error: errorSummary(err) });
    return c.json({ error: "Webhook processing failed" }, 500);
  }
});

/**
 * Process a Dodo Payments webhook event.
 * Event names per Dodo docs: subscription.active, subscription.renewed,
 * subscription.plan_changed, subscription.on_hold, subscription.cancelled,
 * subscription.expired, payment.succeeded, payment.failed.
 */
async function processWebhookEvent(
  env: Bindings,
  db: ReturnType<typeof createDb>,
  eventType: string,
  data: Record<string, any>,
  // Only waitUntil is used. Hono's c.executionCtx type is narrower than the
  // full Workers ExecutionContext (workers-types 5 added mapVirtualHost,
  // tracing and abort), so ask for exactly what this function needs.
  ctx: Pick<ExecutionContext, "waitUntil">,
): Promise<void> {
  switch (eventType) {
    case "subscription.active":
    case "subscription.renewed":
    // Upgrades/downgrades arrive as plan_changed with the new product_id;
    // the same plan re-derivation below applies.
    case "subscription.plan_changed": {
      const orgId = data.metadata?.organizationId as string | undefined;
      if (!orgId) throw new Error("Missing organizationId in subscription metadata");

      // Derive the plan from the verified price/product id; fall back to a
      // VALIDATED metadata hint only if the id is unconfigured, never to 'pro'.
      // normalizePlan folds a legacy 'business' hint (old checkouts renewing
      // on retired products) into 'pro' and rejects anything unknown.
      const productId =
        (data.product_id as string | undefined) ??
        (data.product?.product_id as string | undefined);
      const resolvedPlan =
        planFromDodoPriceId(env, productId) ?? normalizePlan(data.metadata?.plan);

      const periodEnd =
        (data.current_period_end as string | undefined) ??
        (data.next_billing_date as string | undefined);
      const custId =
        (data.customer_id as string | undefined) ??
        (data.customer?.customer_id as string | undefined) ??
        null;
      const subId =
        (data.subscription_id as string | undefined) ??
        (data.subscription?.subscription_id as string | undefined) ??
        null;

      const existing = await db
        .select()
        .from(subscriptions)
        .where(eq(subscriptions.organizationId, orgId))
        .limit(1)
        .then((rows) => rows[0]);

      if (existing) {
        await db
          .update(subscriptions)
          .set({
            plan: resolvedPlan ?? existing.plan,
            dodoCustId: custId ?? existing.dodoCustId,
            dodoSubId: subId ?? existing.dodoSubId,
            status: "active",
            currentPeriodEnd: periodEnd ? new Date(periodEnd) : existing.currentPeriodEnd,
            updatedAt: new Date(),
          })
          .where(eq(subscriptions.organizationId, orgId));
      } else {
        await db.insert(subscriptions).values({
          id: ulid(),
          organizationId: orgId,
          // Safe default: only a verified/validated plan grants paid limits.
          plan: resolvedPlan ?? "free",
          dodoCustId: custId,
          dodoSubId: subId,
          status: "active",
          currentPeriodEnd: periodEnd ? new Date(periodEnd) : null,
          createdAt: new Date(),
          updatedAt: new Date(),
        });
      }

      // Plan may have changed (e.g. Free → Pro): rebuild the banner cache so the
      // "Powered by GoPayLocal" branding is removed on the live banner now,
      // rather than waiting for the usage-cron reconciler. Best-effort, and
      // deferred off the webhook ack path so a slow rebuild can't delay (or, on
      // timeout, trigger a needless retry of) the Dodo delivery.
      ctx.waitUntil(pushBannerConfigForOrg(db, env.CACHE, orgId, env).catch(logBannerPushFailure(orgId)));
      break;
    }

    case "subscription.on_hold": {
      // Dunning / payment trouble — mark past_due. Entitlements keep the plan
      // until currentPeriodEnd, then drop to free.
      const orgId = data.metadata?.organizationId as string | undefined;
      if (!orgId) break;
      await db
        .update(subscriptions)
        .set({ status: "past_due", updatedAt: new Date() })
        .where(eq(subscriptions.organizationId, orgId));
      break;
    }

    case "subscription.cancelled": {
      const orgId = data.metadata?.organizationId as string | undefined;
      if (!orgId) throw new Error("Missing organizationId in subscription metadata");
      await db
        .update(subscriptions)
        .set({ status: "canceled", updatedAt: new Date() })
        .where(eq(subscriptions.organizationId, orgId));
      break;
    }

    case "subscription.expired": {
      const orgId = data.metadata?.organizationId as string | undefined;
      if (!orgId) break;
      await db
        .update(subscriptions)
        .set({ status: "expired", updatedAt: new Date() })
        .where(eq(subscriptions.organizationId, orgId));
      break;
    }

    case "payment.failed": {
      const orgId = data.metadata?.organizationId as string | undefined;
      if (!orgId) break;
      await db
        .update(subscriptions)
        .set({ status: "past_due", updatedAt: new Date() })
        .where(eq(subscriptions.organizationId, orgId));
      break;
    }

    // payment.succeeded: billing-only event (our own subscription invoices).
    // PPP redemption tracking lives on the per-integration provider webhooks
    // (handleRedemption), which store revenue-saved in major units.
    default:
      // Unknown event type — stored for audit, no processing needed.
      break;
  }
}

/**
 * Gumroad allows 5 s for a ping response and does not retry timeouts, so the
 * sale read-back gets this long before we answer anyway. Gumroad retries
 * 499/500/502/503/504 (about 1 min, 3 min, 10 min, 1 h); see the Gumroad
 * adapter header, citing https://gumroad.com/ping.
 */
export const GUMROAD_ACK_BUDGET_MS = 3500;

/**
 * POST /v1/webhooks/:provider/:integrationId        (the live webhook)
 * POST /v1/webhooks/:provider/:integrationId/test   (a test-mode webhook)
 * Customer-facing provider webhooks → record PPP coupon redemptions. Each
 * integration auto-provisions a unique URL + signing secret at connect time, so
 * the :integrationId routes us to the right tenant + secret.
 *
 * Status contract: 2xx only once the delivery is durably recorded or
 * deliberately ignored. 401 = bad signature. 500 (503 for Gumroad) = transient
 * failure; the verified body is stored and retried by the scheduled job too.
 */
app.post("/v1/webhooks/:provider/:integrationId", (c) => handleProviderWebhook(c, "live"));
app.post("/v1/webhooks/:provider/:integrationId/test", (c) => handleProviderWebhook(c, "test"));

async function handleProviderWebhook(c: Context<AppEnv>, urlEnvironment: "live" | "test") {
  const providerName = c.req.param("provider")!;
  const integrationId = c.req.param("integrationId")!;
  const db = createDb(c.env);

  try {
    const rawBody = await c.req.text();

    const [integration] = await db
      .select()
      .from(integrations)
      .where(eq(integrations.id, integrationId))
      .limit(1);
    // Each environment with credentials has its own endpoint (…/test for test
    // mode); a delivery for an environment the integration has no credentials
    // for is not one we provisioned.
    if (
      !integration ||
      integration.provider !== providerName ||
      !accessTokenEncFor(integration, urlEnvironment)
    ) {
      return c.json({ error: "Unknown integration" }, 404);
    }
    const environment = urlEnvironment;
    const slot = webhookSlotFor(integration, environment);

    const encSecret = tokenEncryptionSecret(c.env);
    // Some providers (e.g. Gumroad) need the merchant key, in the
    // webhook's own environment, for a follow-up lookup; verification itself
    // only needs the signing secret.
    const tokenEnc = accessTokenEncFor(integration, environment);
    // A stored value that no longer decrypts (e.g. the token encryption secret
    // was changed) must not fail silently: log it and show it on the integration.
    const decryptFailed = async (what: string, err: unknown) => {
      console.error(`[webhook] ${providerName}:${integrationId} could not decrypt the stored ${what}:`, describeError(err));
      await recordIntegrationIssue(db, integration, {
        area: what === "API key" ? "credentials" : "webhook_delivery",
        environment,
        message: `GoPayLocal couldn't decrypt the stored ${environment} ${what} (was the token encryption secret changed?). ${
          what === "API key" ? "Reconnect the integration." : "Re-create the webhook from the integrations page."
        }`,
      });
    };
    const apiKey = tokenEnc
      ? await decrypt(tokenEnc, encSecret).catch(async (err: unknown) => {
          await decryptFailed("API key", err);
          return "";
        })
      : "";

    let provider: PaymentProvider;
    try {
      provider = createProvider(integration.provider, providerConfigFor(integration, environment, apiKey));
    } catch (err) {
      // Constructor threw (missing/invalid store or site id): permanent
      // misconfiguration that a provider retry can't fix, and the body can't be
      // verified without a provider, so it can't be stored either. Ack, but
      // make it loud and visible on the integration.
      console.error(`[webhook] ${providerName}:${integrationId} provider init failed:`, describeError(err));
      await recordIntegrationIssue(db, integration, {
        area: "webhook_delivery",
        environment,
        message: `A webhook arrived but couldn't be processed: ${describeError(err)}`,
      });
      return c.json({ received: true, unsupported: true });
    }

    if (!provider.verifyWebhook || !provider.parseRedemption) {
      // Handler not implemented for this provider yet — ack so it isn't retried.
      return c.json({ received: true, unsupported: true });
    }

    // A setup ping (no event, no signature) gets a plain 200: nothing is
    // stored or counted, and it is neither a failed nor a working delivery.
    if (provider.isHandshake?.({ rawBody, headers: c.req.raw.headers })) {
      return c.json({ received: true });
    }

    let secretUndecryptable = false;
    const secret = slot.secretEnc
      ? await decrypt(slot.secretEnc, encSecret).catch(async (err: unknown) => {
          secretUndecryptable = true;
          await decryptFailed("webhook signing secret", err);
          return null;
        })
      : null;

    const valid = await provider.verifyWebhook({ rawBody, headers: c.req.raw.headers, secret });
    if (!valid) {
      console.warn(`[webhook] ${providerName}:${integrationId} signature verification failed`);
      // An undecryptable secret was already reported with its real cause.
      if (!secretUndecryptable) {
        await recordIntegrationIssue(db, integration, {
          area: "webhook_delivery",
          environment,
          message:
            "A webhook delivery failed signature verification. If this keeps happening, re-create the webhook from the integrations page.",
        });
      }
      return c.json({ error: "Invalid webhook signature" }, 401);
    }

    const ctx: WebhookContext = {
      providerName,
      integrationId,
      organizationId: integration.organizationId,
      environment,
      provider,
      rawBody,
    };

    if (providerName === "gumroad") return await handleGumroadPing(c, db, ctx, integration);

    const outcome = await ingestVerifiedWebhook(db, ctx);
    await noteDeliveryHealth(db, integration, environment, outcome);
    return respond(c, outcome, 500);
  } catch (err) {
    console.error(`[webhook] ${providerName}:${integrationId} failed:`, describeError(err));
    return c.json({ error: "Webhook processing failed" }, 500);
  }
}

/**
 * Keep the integration's "webhook_delivery" health in step with what deliveries
 * do: a delivery that can't be processed yet is shown (it is retried, but the
 * merchant should know redemptions are delayed); a processed one proves the
 * webhook works and clears it. Best-effort, never throws.
 */
async function noteDeliveryHealth(
  db: Database,
  integration: IntegrationRef,
  environment: "live" | "test",
  outcome: IngestOutcome,
): Promise<void> {
  if (outcome.kind === "retry") {
    await recordIntegrationIssue(db, integration, {
      area: "webhook_delivery",
      environment,
      message: `A redemption couldn't be recorded yet and will be retried: ${outcome.error}`,
    });
  } else {
    await clearIntegrationIssue(db, integration, "webhook_delivery");
  }
}

function respond(c: Context<AppEnv>, outcome: IngestOutcome, retryStatus: 500 | 503) {
  switch (outcome.kind) {
    case "ignored":
      return c.json({ received: true });
    case "duplicate":
      return c.json({ received: true, duplicate: true });
    case "recorded":
      return c.json({ received: true });
    case "retry":
      // Non-2xx so the provider retries; the body is also stored for our retry job.
      return c.json({ error: "Event processing failed" }, retryStatus);
  }
}

/**
 * Gumroad pings are unsigned and carry only a sale id, so every ping costs a
 * sale read-back with the merchant's token. The ping is (1) rate limited per
 * integration so forged pings can't burn the merchant's API quota, (2) stored
 * BEFORE the read-back so nothing is lost if the isolate dies or the read-back
 * fails, and (3) answered within GUMROAD_ACK_BUDGET_MS: 200 once recorded or
 * ignored, 503 on a transient failure or when out of time (Gumroad retries 503;
 * the stored ping is also retried by the scheduled job). Retries are idempotent:
 * redemptions dedupe on Gumroad's canonical sale id.
 */
async function handleGumroadPing(
  c: Context<AppEnv>,
  db: Database,
  ctx: WebhookContext,
  integration: IntegrationRef,
) {
  // Its own limiter (120/min per integration, per colo; wrangler.toml), not
  // RL_EVENTS_KEY, which is sized for banner analytics (3000/min). Fails open.
  const allowed = await checkRateLimit(c.env.RL_GUMROAD_PING, `gumroad-ping:${ctx.integrationId}`);
  if (!allowed) return c.json({ error: "rate_limited" }, 503);

  const stored = await persistUnparsed(db, ctx, null);
  if (!stored) return c.json({ error: "Event processing failed" }, 503);

  const work = ingestVerifiedWebhook(db, ctx, { bodyAlreadyStored: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const outOfTime = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), GUMROAD_ACK_BUDGET_MS);
  });
  const outcome = await Promise.race([work, outOfTime]);
  if (timer) clearTimeout(timer);

  if (outcome) {
    await noteDeliveryHealth(db, integration, ctx.environment, outcome);
    return respond(c, outcome, 503);
  }

  // Out of time: let the read-back finish after the response. The stored ping
  // is the safety net if it doesn't.
  try {
    c.executionCtx.waitUntil(work);
  } catch {
    // No ExecutionContext (unit tests): the promise still settles on its own.
  }
  return c.json({ error: "Still processing" }, 503);
}

export default app;
