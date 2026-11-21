// ── Redemption webhook ingestion ────────────────────────────────────────────
// What happens to a merchant-provider webhook after its signature is verified,
// shared by the webhook route and the scheduled retry (index.ts, every 10 min).
//
// Guarantees:
//  - Exactly-once counting. A redemption is keyed `provider:integration:eventId`
//    in webhook_events. The row is marked processed in the SAME transaction that
//    writes the rollup, with a conditional `processed = false → true` update, so
//    concurrent deliveries of one event (providers do send duplicates in
//    parallel) can never both count it, and a failure rolls both back.
//  - Nothing verified is lost to a transient failure. If parsing throws (e.g.
//    Gumroad's sale read-back failed), the raw body is stored as a
//    `redemption_unparsed` row before answering non-2xx, and the scheduled
//    retry keeps trying (with backoff, for RETRY_WINDOW_MS)
//    after the provider's own retries run out. Rows whose processing failed
//    after parsing (`redemption`, processed = false) are retried the same way.
//
// Only data that passed signature verification is ever stored here.

import { and, eq, isNull, lte, or, gt, sql } from "drizzle-orm";
import { ulid } from "ulid";
import type { Database } from "../db";
import type { Bindings } from "../bindings";
import { integrations, webhookEvents } from "../db/schema";
import { decrypt, tokenEncryptionSecret } from "../lib/crypto";
import {
  accessTokenEncFor,
  createProvider,
  providerConfigFor,
  type PaymentProvider,
  type RedemptionEvent,
} from "./providers";
import { handleRedemption } from "./redemption.service";
import { describeError, recordIntegrationIssue } from "./integration-health.service";

export const EVENT_TYPE_REDEMPTION = "redemption";
export const EVENT_TYPE_UNPARSED = "redemption_unparsed";

/** How long the scheduled job keeps retrying a stored webhook. */
export const RETRY_WINDOW_MS = 72 * 3600 * 1000;
/** Leave fresh rows to the request (and the provider's own retries) that created them. */
export const RETRY_MIN_AGE_MS = 2 * 60 * 1000;
/** Rows per scheduled run: each may cost a provider API call. */
export const RETRY_BATCH_SIZE = 25;

export interface WebhookContext {
  providerName: string;
  integrationId: string;
  organizationId: string;
  environment: "live" | "test";
  provider: PaymentProvider;
  rawBody: string;
}

export type IngestOutcome =
  /** Not a redemption (other event type, renewal, no code...): acknowledged. */
  | { kind: "ignored" }
  /** Counted (or deliberately not: `matched` false = not one of our coupons). */
  | { kind: "recorded"; matched: boolean }
  /** Already counted by an earlier delivery. */
  | { kind: "duplicate" }
  /** Transient failure; the provider should retry (and so will we). */
  | { kind: "retry"; error: string; persisted: boolean };

export interface UnparsedData {
  rawBody?: string;
  environment: "live" | "test";
  integrationId: string;
  attempts: number;
  nextAttemptAt?: string;
  resolvedEventId?: string;
  gaveUp?: boolean;
}

async function sha256Hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  let hex = "";
  for (const b of new Uint8Array(digest)) hex += b.toString(16).padStart(2, "0");
  return hex;
}

export async function unparsedKey(providerName: string, integrationId: string, rawBody: string): Promise<string> {
  return `${providerName}:${integrationId}:raw:${await sha256Hex(rawBody)}`;
}

/** Dedupe key for a parsed redemption; a missing event id falls back to the body hash. */
export async function redemptionKey(
  providerName: string,
  integrationId: string,
  eventId: string,
  rawBody: string,
): Promise<string> {
  const id = eventId && eventId.trim() ? eventId : `raw:${await sha256Hex(rawBody)}`;
  return `${providerName}:${integrationId}:${id}`;
}

/** Backoff for the scheduled retry: 10 min, 20, 40, ... capped at 6 h. */
export function nextAttemptDelayMs(attempts: number): number {
  return Math.min(10 * 60 * 1000 * 2 ** Math.max(0, attempts - 1), 6 * 3600 * 1000);
}

/**
 * Store a verified raw body so it can be parsed later. Idempotent per body.
 * Returns false (and logs) if even that write failed.
 */
export async function persistUnparsed(
  db: Database,
  ctx: Pick<WebhookContext, "providerName" | "integrationId" | "environment" | "rawBody">,
  error: string | null,
): Promise<boolean> {
  try {
    const data: UnparsedData = {
      rawBody: ctx.rawBody,
      environment: ctx.environment,
      integrationId: ctx.integrationId,
      attempts: 0,
    };
    const key = await unparsedKey(ctx.providerName, ctx.integrationId, ctx.rawBody);
    await db
      .insert(webhookEvents)
      .values({
        id: ulid(),
        webhookId: key,
        eventType: EVENT_TYPE_UNPARSED,
        provider: ctx.providerName,
        data: data as unknown as Record<string, unknown>,
        processed: false,
        errorMessage: error,
        createdAt: new Date(),
      })
      .onConflictDoNothing({ target: webhookEvents.webhookId });
    if (error) {
      // A redelivery of a body we already hold: refresh the error, keep the row.
      await db
        .update(webhookEvents)
        .set({ errorMessage: error })
        .where(and(eq(webhookEvents.webhookId, key), eq(webhookEvents.processed, false)));
    }
    return true;
  } catch (err) {
    console.error(
      `[webhook] could not persist ${ctx.providerName}:${ctx.integrationId} body for retry:`,
      describeError(err),
    );
    return false;
  }
}

/** Mark a stored raw body as done and drop it (it may carry customer data). */
export async function resolveUnparsed(
  db: Database,
  ctx: Pick<WebhookContext, "providerName" | "integrationId" | "environment" | "rawBody">,
  resolvedEventId: string | null,
): Promise<void> {
  const key = await unparsedKey(ctx.providerName, ctx.integrationId, ctx.rawBody);
  const data: UnparsedData = {
    environment: ctx.environment,
    integrationId: ctx.integrationId,
    attempts: 0,
    ...(resolvedEventId ? { resolvedEventId } : {}),
  };
  await db
    .update(webhookEvents)
    .set({
      processed: true,
      processedAt: new Date(),
      errorMessage: null,
      data: data as unknown as Record<string, unknown>,
    })
    .where(eq(webhookEvents.webhookId, key));
}

/**
 * Count a claimed redemption exactly once: flip its row to processed and write
 * the rollup in one transaction. 'duplicate' if another delivery got there first.
 */
export async function applyRedemption(
  db: Database,
  dedupeKey: string,
  integrationId: string,
  organizationId: string,
  redemption: RedemptionEvent,
): Promise<"recorded" | "unmatched" | "duplicate"> {
  return db.transaction(async (tx) => {
    const claimed = await tx
      .update(webhookEvents)
      .set({ processed: true, processedAt: new Date(), errorMessage: null })
      .where(and(eq(webhookEvents.webhookId, dedupeKey), eq(webhookEvents.processed, false)))
      .returning({ id: webhookEvents.id });
    if (!claimed || claimed.length === 0) return "duplicate";
    const matched = await handleRedemption(tx, integrationId, organizationId, redemption);
    return matched ? "recorded" : "unmatched";
  });
}

/** Dedupe-claim and count a parsed redemption. Never throws. */
export async function recordParsedRedemption(
  db: Database,
  ctx: Pick<WebhookContext, "providerName" | "integrationId" | "organizationId" | "rawBody">,
  redemption: RedemptionEvent,
): Promise<IngestOutcome> {
  let dedupeKey: string | null = null;
  try {
    dedupeKey = await redemptionKey(ctx.providerName, ctx.integrationId, redemption.eventId, ctx.rawBody);
    await db
      .insert(webhookEvents)
      .values({
        id: ulid(),
        webhookId: dedupeKey,
        eventType: EVENT_TYPE_REDEMPTION,
        provider: ctx.providerName,
        data: redemption as unknown as Record<string, unknown>,
        processed: false,
        createdAt: new Date(),
      })
      .onConflictDoNothing({ target: webhookEvents.webhookId });

    const result = await applyRedemption(db, dedupeKey, ctx.integrationId, ctx.organizationId, redemption);
    if (result === "duplicate") return { kind: "duplicate" };
    return { kind: "recorded", matched: result === "recorded" };
  } catch (err) {
    const error = describeError(err);
    console.error(`[webhook] recording ${ctx.providerName}:${ctx.integrationId} redemption failed:`, error);
    if (dedupeKey) {
      await db
        .update(webhookEvents)
        .set({ errorMessage: error, processedAt: new Date() })
        .where(and(eq(webhookEvents.webhookId, dedupeKey), eq(webhookEvents.processed, false)))
        .catch(() => {});
    }
    // persisted = the dedupe row (with the parsed event) exists for the retry job.
    return { kind: "retry", error, persisted: dedupeKey !== null };
  }
}

/**
 * Parse a verified body and record it. On a parse failure the body is stored
 * for the scheduled retry. Never throws.
 *
 * `bodyAlreadyStored`: the caller persisted the raw body up front (Gumroad, or
 * the scheduled retry), so success must resolve that row; on failure
 * persistUnparsed's insert is a no-op for the existing row and only its error
 * message is refreshed.
 */
export async function ingestVerifiedWebhook(
  db: Database,
  ctx: WebhookContext,
  opts: { bodyAlreadyStored?: boolean } = {},
): Promise<IngestOutcome> {
  let redemption: RedemptionEvent | null;
  try {
    redemption = await ctx.provider.parseRedemption!(ctx.rawBody);
  } catch (err) {
    const error = `parse failed: ${describeError(err)}`;
    console.error(`[webhook] ${ctx.providerName}:${ctx.integrationId} ${error}`);
    const persisted = await persistUnparsed(db, ctx, error);
    return { kind: "retry", error, persisted };
  }

  if (!redemption) {
    if (opts.bodyAlreadyStored) await resolveUnparsed(db, ctx, null).catch(() => {});
    return { kind: "ignored" };
  }

  const outcome = await recordParsedRedemption(db, ctx, redemption);
  if (opts.bodyAlreadyStored && outcome.kind !== "retry") {
    await resolveUnparsed(db, ctx, redemption.eventId).catch(() => {});
  }
  return outcome;
}

// ── Scheduled retry ─────────────────────────────────────────────────────────

/** `provider:integrationId:...` → the two leading parts (ids contain no colons). */
export function parseWebhookKey(key: string): { providerName: string; integrationId: string } | null {
  const [providerName, integrationId] = key.split(":");
  if (!providerName || !integrationId) return null;
  return { providerName, integrationId };
}

export interface RetryReport {
  attempted: number;
  recovered: number;
  failed: number;
  skipped: number;
}

/**
 * Retry stored webhooks the request path could not finish. Runs from the
 * 10-minute cron. Never throws for a single row; returns counts.
 */
export async function retryPendingRedemptions(
  db: Database,
  env: Bindings,
  now: Date = new Date(),
): Promise<RetryReport> {
  const report: RetryReport = { attempted: 0, recovered: 0, failed: 0, skipped: 0 };
  const minCreated = new Date(now.getTime() - RETRY_WINDOW_MS);
  const maxCreated = new Date(now.getTime() - RETRY_MIN_AGE_MS);

  const rows = await db
    .select()
    .from(webhookEvents)
    .where(
      and(
        eq(webhookEvents.processed, false),
        lte(webhookEvents.createdAt, maxCreated),
        or(
          and(eq(webhookEvents.eventType, EVENT_TYPE_REDEMPTION), gt(webhookEvents.createdAt, minCreated)),
          and(
            eq(webhookEvents.eventType, EVENT_TYPE_UNPARSED),
            isNull(sql`${webhookEvents.data}->>'gaveUp'`),
            or(
              isNull(sql`${webhookEvents.data}->>'nextAttemptAt'`),
              // A raw sql`` operand has no column type, so Drizzle cannot encode a
              // Date for it and the driver rejects the parameter. Send ISO text.
              lte(
                sql`(${webhookEvents.data}->>'nextAttemptAt')::timestamptz`,
                now.toISOString(),
              ),
            ),
          ),
        ),
      ),
    )
    .orderBy(webhookEvents.createdAt)
    .limit(RETRY_BATCH_SIZE);

  const integrationCache = new Map<string, typeof integrations.$inferSelect | null>();
  async function integrationFor(id: string) {
    if (!integrationCache.has(id)) {
      const [row] = await db.select().from(integrations).where(eq(integrations.id, id)).limit(1);
      integrationCache.set(id, row ?? null);
    }
    return integrationCache.get(id) ?? null;
  }

  for (const row of rows) {
    const parsedKey = parseWebhookKey(row.webhookId);
    if (!parsedKey) {
      report.skipped++;
      continue;
    }
    report.attempted++;
    try {
      const integration = await integrationFor(parsedKey.integrationId);
      if (!integration) {
        // Disconnected since: nothing can be attributed any more. Stop retrying.
        await db
          .update(webhookEvents)
          .set({
            processed: true,
            processedAt: now,
            errorMessage: "integration no longer exists",
            ...(row.eventType === EVENT_TYPE_UNPARSED ? { data: {} } : {}),
          })
          .where(eq(webhookEvents.id, row.id));
        report.skipped++;
        continue;
      }

      if (row.eventType === EVENT_TYPE_REDEMPTION) {
        await applyRedemption(
          db,
          row.webhookId,
          integration.id,
          integration.organizationId,
          row.data as unknown as RedemptionEvent,
        );
        report.recovered++;
        continue;
      }

      // redemption_unparsed
      const data = (row.data ?? {}) as unknown as UnparsedData;
      if (row.createdAt.getTime() <= minCreated.getTime() || !data.rawBody) {
        // Out of retries: keep the row (and its last error) visible, drop the body.
        const { rawBody: _drop, ...rest } = data;
        await db
          .update(webhookEvents)
          .set({ data: { ...rest, gaveUp: true } as unknown as Record<string, unknown> })
          .where(eq(webhookEvents.id, row.id));
        // A redemption is now lost for good: the merchant has to be able to see it.
        await recordIntegrationIssue(db, integration, {
          area: "webhook_delivery",
          environment: data.environment === "test" ? "test" : "live",
          message: `A redemption webhook could not be processed after ${RETRY_WINDOW_MS / 3600_000} hours of retries${
            row.errorMessage ? `: ${row.errorMessage}` : ""
          }`,
        });
        report.failed++;
        continue;
      }

      const environment = data.environment === "test" ? "test" : "live";
      const tokenEnc = accessTokenEncFor(integration, environment);
      const apiKey = tokenEnc ? await decrypt(tokenEnc, tokenEncryptionSecret(env)).catch(() => "") : "";
      const provider = createProvider(integration.provider, providerConfigFor(integration, environment, apiKey));
      if (!provider.parseRedemption) throw new Error("provider has no parseRedemption");

      const outcome = await ingestVerifiedWebhook(
        db,
        {
          providerName: parsedKey.providerName,
          integrationId: integration.id,
          organizationId: integration.organizationId,
          environment,
          provider,
          rawBody: data.rawBody,
        },
        { bodyAlreadyStored: true },
      );
      if (outcome.kind === "retry") throw new Error(outcome.error);
      report.recovered++;
    } catch (err) {
      report.failed++;
      const error = describeError(err);
      if (row.eventType === EVENT_TYPE_UNPARSED) {
        const data = (row.data ?? {}) as unknown as UnparsedData;
        const attempts = (data.attempts ?? 0) + 1;
        const nextAttemptAt = new Date(now.getTime() + nextAttemptDelayMs(attempts)).toISOString();
        await db
          .update(webhookEvents)
          .set({
            errorMessage: error,
            data: { ...data, attempts, nextAttemptAt } as unknown as Record<string, unknown>,
          })
          .where(and(eq(webhookEvents.id, row.id), eq(webhookEvents.processed, false)))
          .catch(() => {});
      } else {
        await db
          .update(webhookEvents)
          .set({ errorMessage: error })
          .where(and(eq(webhookEvents.id, row.id), eq(webhookEvents.processed, false)))
          .catch(() => {});
      }
    }
  }

  if (report.attempted > 0) {
    console.log(
      `[webhook-retry] attempted=${report.attempted} recovered=${report.recovered} ` +
        `failed=${report.failed} skipped=${report.skipped}`,
    );
  }
  return report;
}
