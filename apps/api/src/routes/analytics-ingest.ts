import { Hono } from "hono";
import { eq, sql, type SQL } from "drizzle-orm";
import { ulid } from "ulid";
import type { AppEnv } from "../bindings";
import { createDb, type Database } from "../db";
import { apiKeys, analyticsRollups } from "../db/schema";
import { kvGet } from "../lib/kv";
import type { CachedApiKey } from "../services/banner-cache.service";
import { analyticsEventBatchSchema } from "@gopaylocal/shared/validation";
import { z } from "zod";
import { enforceRateLimit } from "../lib/rate-limit";
import { resolveCampaignOwners } from "../lib/campaign-validation";
import { errorSummary } from "../lib/log";
import { SECRET_KEY_NOT_ALLOWED, isSecretKey } from "../lib/public-key";

const app = new Hono<AppEnv>();

/**
 * Schema for the simple single-event payload the banner sends:
 * { key, event, url, code? }
 *
 * `redemption` still parses (an old client sending it gets the same 204, and
 * a batch containing one is not rejected as a whole) but is never stored:
 * redemptions are recorded only from signature-verified payment-provider
 * webhooks (routes/webhooks.ts). Anyone holding a public key could otherwise
 * inflate a merchant's redemption counts from a browser.
 */
const bannerEventSchema = z.object({
  key: z.string().min(1),
  event: z.enum(["impression", "click", "copy", "dismiss", "redemption"]),
  campaignId: z.string().optional(),
  countryCode: z.string().optional(),
  url: z.string().optional(),
  code: z.string().optional(),
});

/**
 * Hash a key using SHA-256.
 */
async function hashKey(key: string): Promise<string> {
  const data = new TextEncoder().encode(key);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The rollup counter column each tracked banner event increments. */
type RollupCounter = "impressions" | "clicks" | "copies";

/**
 * Event type → counter. `dismiss`, `redemption` (webhooks only, see
 * bannerEventSchema) and anything unknown are not stored.
 */
const COUNTER_FOR_EVENT: ReadonlyMap<string, RollupCounter> = new Map([
  ["impression", "impressions"],
  ["click", "clicks"],
  ["copy", "copies"],
]);

/** Exported for tests: the counter an event type increments, or null if untracked. */
export function counterForEvent(eventType: string): RollupCounter | null {
  return COUNTER_FOR_EVENT.get(eventType) ?? null;
}

/**
 * Country codes in rollups are ISO 3166-1 alpha-2 (what request.cf.country
 * gives the banner). The batch schema already enforces length 2; the simple
 * banner schema does not, and an unbounded string would mint a new rollup row
 * per distinct junk value, so anything else is dropped.
 */
const COUNTRY_CODE_RE = /^[A-Za-z]{2}$/;

/** UTC midnight of `now`: the day bucket (matches the usage cron's UTC month). */
function utcDayStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/**
 * Build the UPSERT that adds `amount` to one counter on the org's daily rollup
 * row for (campaign, country), creating the row if needed. Returns null when
 * the event must be dropped (no campaign/country, untracked event type).
 *
 * Built with Drizzle's query builder, not a raw `sql` template, on purpose:
 *  - A column object interpolated into raw `sql` renders table-qualified
 *    ("analytics_rollups"."impressions"; https://orm.drizzle.team/docs/sql:
 *    "the escaped table names are appended to column names"), which Postgres
 *    rejects in an INSERT column list and as a DO UPDATE SET target. The
 *    builder emits bare names there (https://orm.drizzle.team/docs/insert,
 *    "On conflict do update"; https://orm.drizzle.team/docs/guides/upsert).
 *  - A JS Date passed as a raw `sql` parameter is not serialized by the
 *    postgres-js driver (drizzle installs pass-through timestamp serializers);
 *    through `.values()` the timestamp column maps it to an ISO string.
 *
 * The conflict target must list all 6 columns of `analytics_rollups_upsert_idx`
 * (including `environment`), or Postgres raises "no unique or exclusion
 * constraint matching the ON CONFLICT specification". Banner events are always
 * 'live'. campaign_id and country_code are never NULL here (checked below):
 * the unique index treats NULLs as distinct, so a NULL key would insert a new
 * row on every event instead of incrementing.
 */
export function buildRollupUpsert(
  db: Pick<Database, "insert">,
  input: {
    organizationId: string;
    campaignId: string;
    countryCode: string;
    eventType: string;
    amount?: number;
    now?: Date;
  },
) {
  const { organizationId, campaignId, eventType } = input;
  if (!organizationId || !campaignId || !COUNTRY_CODE_RE.test(input.countryCode ?? "")) {
    return null;
  }
  const counter = counterForEvent(eventType);
  if (!counter) return null;

  const amount = Math.max(1, Math.trunc(input.amount ?? 1));
  const now = input.now ?? new Date();
  const increment: Partial<Record<RollupCounter, number>> = { [counter]: amount };
  const onConflict: Partial<Record<RollupCounter, SQL>> = {
    [counter]: sql`${analyticsRollups[counter]} + ${amount}`,
  };

  return db
    .insert(analyticsRollups)
    .values({
      id: ulid(),
      organizationId,
      campaignId,
      countryCode: input.countryCode.toUpperCase(),
      period: "day",
      periodStart: utcDayStart(now),
      environment: "live",
      ...increment,
      createdAt: now,
    })
    .onConflictDoUpdate({
      target: [
        analyticsRollups.organizationId,
        analyticsRollups.campaignId,
        analyticsRollups.countryCode,
        analyticsRollups.period,
        analyticsRollups.periodStart,
        analyticsRollups.environment,
      ],
      set: onConflict,
    });
}

/** One rollup increment: events of a request grouped by (campaign, country, counter). */
export interface RollupIncrement {
  campaignId: string;
  countryCode: string;
  eventType: string;
  amount: number;
}

/**
 * Collapse a request's events into one increment per (campaign, country,
 * counter), dropping untracked event types and malformed keys. A 50-event
 * batch then costs one statement per distinct key instead of 50, and two
 * rows of the same INSERT never hit the same conflict key.
 */
export function groupRollupIncrements(
  events: Array<{ campaignId: string; countryCode: string; eventType: string }>,
): RollupIncrement[] {
  const grouped = new Map<string, RollupIncrement>();
  for (const ev of events) {
    if (!ev.campaignId || !COUNTRY_CODE_RE.test(ev.countryCode ?? "")) continue;
    const counter = counterForEvent(ev.eventType);
    if (!counter) continue;
    const countryCode = ev.countryCode.toUpperCase();
    const key = `${ev.campaignId}\u0000${countryCode}\u0000${counter}`;
    const existing = grouped.get(key);
    if (existing) existing.amount += 1;
    else grouped.set(key, { campaignId: ev.campaignId, countryCode, eventType: ev.eventType, amount: 1 });
  }
  return [...grouped.values()];
}

/**
 * POST /v1/events
 * Public endpoint for banner analytics ingestion (used by sendBeacon).
 * Accepts both:
 *   - Simple banner payload: { key, event, url }
 *   - Batch payload: { key, events: [{ eventType, campaignId, ... }] }
 * Validates the API key and UPSERTs events into analytics_rollups via waitUntil.
 */
app.post("/v1/events", async (c) => {
  try {
    // Per-IP backstop (always applied, before any work). Catches floods that
    // rotate keys or send no/invalid key. 120/min/IP — see wrangler.toml
    // RL_EVENTS_IP. Fail-open if the binding is absent/throws (lib/rate-limit.ts).
    // Skip the per-IP gate when the IP is empty — bucketing all header-less
    // traffic into one shared "" key is meaningless and lets one client DoS it.
    // The per-KEY gate below still protects this endpoint when the IP is absent.
    const ip = c.req.header("cf-connecting-ip") ?? "";
    const ipLimited = ip
      ? await enforceRateLimit(c, c.env.RL_EVENTS_IP, `ip:${ip}`)
      : null;
    if (ipLimited) return ipLimited;

    const body = await c.req.json();

    // Try the simple banner payload first, then fall back to batch schema
    const simpleParsed = bannerEventSchema.safeParse(body);
    const batchParsed = !simpleParsed.success
      ? analyticsEventBatchSchema.safeParse(body)
      : null;

    if (!simpleParsed.success && (!batchParsed || !batchParsed.success)) {
      return c.json({ error: "Validation failed" }, 400);
    }

    const apiKeyValue = simpleParsed.success
      ? simpleParsed.data.key
      : batchParsed!.data!.key;

    // A secret key is refused before the per-key limiter, KV or Postgres see
    // it, and is never echoed or logged (lib/public-key.ts).
    if (isSecretKey(apiKeyValue)) {
      return c.json(SECRET_KEY_NOT_ALLOWED, 401);
    }

    // Per-KEY rate limit, derived from the key hash AFTER cheap parsing. Bounds
    // analytics inflation and rollup writes per key; it no longer guards the
    // plan quota (that is metered server-side on /v1/banner/config). Sized for
    // a large merchant's real beacon traffic: see wrangler.toml RL_EVENTS_KEY.
    const keyHash = await hashKey(apiKeyValue);
    const keyLimited = await enforceRateLimit(c, c.env.RL_EVENTS_KEY, `key:${keyHash}`);
    if (keyLimited) return keyLimited;

    // Validate API key — try KV fast path first, then DB fallback
    let organizationId: string | null = null;

    const cachedKey = await kvGet<CachedApiKey>(c.env.CACHE, `apikey:${keyHash}`);
    if (cachedKey) {
      organizationId = cachedKey.organizationId;
    } else {
      const db = createDb(c.env);
      const apiKeyRow = await db
        .select()
        .from(apiKeys)
        .where(eq(apiKeys.keyHash, keyHash))
        .limit(1)
        .then((rows) => rows[0]);

      // Only a public key may report events (a secret key's row never can).
      if (!apiKeyRow || apiKeyRow.keyType !== "public") {
        return c.json({ error: "Invalid API key" }, 401);
      }
      organizationId = apiKeyRow.organizationId;
    }

    const orgId = organizationId;
    const db = createDb(c.env);

    // ── Analytics-poisoning guard ──────────────────────────────────────────
    // A valid public key is NOT a secret (it's in the customer's page source),
    // so we must also verify each event's campaignId belongs to THIS org before
    // writing a rollup — otherwise a third party can poison another org's
    // analytics. The check is KV-cached (campaign-org:{id}); see
    // campaign-validation.ts.
    //
    // On mismatch/unknown we DROP the event SILENTLY and still return success.
    // We deliberately do NOT surface a 4xx: a distinguishable error would be an
    // oracle that lets an attacker probe which campaignIds are valid for a key.
    // Redemptions never come through here (see bannerEventSchema): the
    // provider-webhook path in routes/webhooks.ts resolves the campaign from
    // the coupon and is signature-authenticated.
    //
    // BATCH RESOLUTION (Postgres-flood defense): collect both the simple and
    // batch shapes into ONE uniform event list, then resolve ALL their campaign
    // ids in a SINGLE resolveCampaignOwners() call inside ONE waitUntil — at most
    // ONE DB query per request regardless of batch size. Without this, a 50-event
    // batch of distinct random ids fanned out into up to 50 concurrent cold DB
    // reads (the negative cache can't dedupe distinct ids), so one public key
    // could drive thousands of Postgres reads/min.
    const pending: Array<{
      campaignId: string;
      countryCode: string;
      eventType: string;
    }> = [];

    if (simpleParsed.success) {
      const { event, campaignId, countryCode } = simpleParsed.data;
      // Preserve existing semantics: a simple event missing/empty campaignId or
      // countryCode is dropped (upsertRollup would also drop it, but skipping it
      // here keeps it out of the resolver batch entirely).
      if (campaignId && countryCode) {
        pending.push({ campaignId, countryCode, eventType: event });
      }
    } else {
      const { events } = batchParsed!.data!;
      for (const event of events) {
        pending.push({
          campaignId: event.campaignId,
          countryCode: event.countryCode,
          eventType: event.eventType,
        });
      }
    }

    const increments = groupRollupIncrements(pending);
    if (increments.length > 0) {
      c.executionCtx.waitUntil(
        (async () => {
          const owners = await resolveCampaignOwners(
            db,
            c.env.CACHE,
            increments.map((inc) => inc.campaignId),
          );
          for (const inc of increments) {
            // Upsert ONLY if the campaign belongs to THIS org; otherwise drop the
            // item silently (no oracle). Each upsert is wrapped so one failure
            // doesn't abort the rest. Failures are logged (never surfaced to the
            // client, which already got its 204): a failing write here means
            // the merchant's analytics go blind.
            if (owners.get(inc.campaignId) !== orgId) continue;
            const query = buildRollupUpsert(db, { organizationId: orgId, ...inc });
            if (!query) continue;
            await query.catch((err: unknown) => {
              console.error("analytics: rollup upsert failed", {
                organizationId: orgId,
                campaignId: inc.campaignId,
                countryCode: inc.countryCode,
                eventType: inc.eventType,
                amount: inc.amount,
                error: errorSummary(err),
              });
            });
          }
        })().catch((err: unknown) => {
          console.error("analytics: event ingestion failed", {
            organizationId: orgId,
            events: increments.length,
            error: errorSummary(err),
          });
        }),
      );
    }

    // Return 204 No Content for sendBeacon compatibility
    return c.body(null, 204);
  } catch (err) {
    // A malformed JSON body is client noise, not a server fault: don't log it.
    if (!(err instanceof SyntaxError)) {
      console.error("analytics: /v1/events request failed", { error: errorSummary(err) });
    }
    return c.json({ error: "Failed to ingest events" }, 500);
  }
});

export default app;
