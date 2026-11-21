import { inArray } from "drizzle-orm";
import type { createDb } from "../db";
import { campaigns } from "../db/schema";
import { kvGet, kvSet } from "./kv";
import { errorSummary } from "./log";

/**
 * Analytics-poisoning guard for /v1/events.
 *
 * The public key lives in every customer's page source BY DESIGN, so a valid key
 * is not a secret. Without this check, a third party who reads the key can POST
 * events with ANY campaignId and (a) poison that customer's analytics and (b)
 * burn their event quota. So after we resolve the org from the key, we must also
 * verify the event's campaignId actually belongs to that org before writing.
 *
 * HOT-PATH CONSTRAINT: no unconditional per-event DB query. We KV-cache the
 * campaign→org mapping.
 *
 *   campaign-org:{campaignId} → organizationId   (positive)
 *   campaign-org:{campaignId} → "0"              (negative marker: unknown id)
 *
 * TTLs:
 *  - Positive entries get a LONG TTL. A campaignId is a ULID minted under exactly
 *    one org and org-ownership is IMMUTABLE (a campaign never changes orgs), so a
 *    positive mapping can never become stale/wrong — the only cost of a long TTL
 *    is a tiny window of stale-but-still-correct data. 24h keeps DB load minimal.
 *  - Negative entries get a SHORT TTL. An "unknown" id could be a campaign created
 *    moments ago whose KV entry we haven't warmed yet; we don't want to reject its
 *    legitimate early events for long. 60s bounds that window while still absorbing
 *    a burst of garbage ids from an attacker.
 *
 * SHAPE GUARD (Postgres-flood defense): campaign ids in this repo are ULIDs
 * (26-char Crockford base32). The batch resolver rejects any malformed id BEFORE
 * any KV/DB I/O, so a flood of random-garbage ids (which the negative cache can't
 * absorb because each id is distinct) never reaches Postgres — it's neutralized
 * at zero I/O cost. One request resolves AT MOST one DB query regardless of how
 * many (distinct, well-formed) campaign ids it carries.
 */

const POSITIVE_TTL_SECONDS = 24 * 60 * 60; // 24h — ownership is immutable
const NEGATIVE_TTL_SECONDS = 60; // unknown id: re-check soon (may be brand new)
const NEGATIVE_MARKER = "0";

/**
 * Strict ULID shape test. ULIDs are 26-char Crockford base32 (excludes I, L, O,
 * U). `/i` accepts both cases. A malformed id cannot name a real campaign, so we
 * treat it as unknown WITHOUT touching KV or the DB — this is what stops a flood
 * of random ids from turning into a flood of cold Postgres reads.
 */
const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/i;

/**
 * True iff `id` has the shape of a valid campaign id (ULID). Exported for tests.
 */
export function isWellFormedCampaignId(id: string): boolean {
  return ULID_RE.test(id);
}

/**
 * Resolve a batch of campaign ids to their owning organizationId in a SINGLE DB
 * query (at most). For each DISTINCT id the returned map holds either the owning
 * org id (positive) or `null` (unknown / malformed). Semantics mirror the
 * single-item `isCampaignOwnedByOrg` guard, but amortized across a batch so a
 * 50-event request can never fan out into 50 concurrent Postgres reads.
 *
 * Resolution order per distinct id:
 *  1. SHAPE GUARD — malformed ids resolve to `null` with ZERO I/O.
 *  2. KV read (campaign-org:{id}) for all well-formed ids in parallel; positive
 *     hits resolve to the org, the negative marker resolves to `null`.
 *  3. ONE DB query (`inArray`) for the KV MISSES only; any miss not returned is
 *     `null` (unknown). Results are written back to KV with the usual TTLs.
 *
 * FAIL CLOSED: if the DB query throws, every miss resolves to `null` and NOTHING
 * is cached, so a later request re-resolves (matches the single-item contract —
 * a dropped analytics event is far cheaper than a poisoned/garbage rollup).
 */
export async function resolveCampaignOwners(
  db: ReturnType<typeof createDb>,
  kv: KVNamespace,
  campaignIds: string[],
): Promise<Map<string, string | null>> {
  const result = new Map<string, string | null>();

  // Dedupe; split into well-formed vs malformed in one pass.
  const distinct = new Set(campaignIds);
  const wellFormed: string[] = [];
  for (const id of distinct) {
    if (isWellFormedCampaignId(id)) {
      wellFormed.push(id);
    } else {
      // Malformed → unknown, zero I/O. Neutralizes random-garbage floods.
      result.set(id, null);
    }
  }

  if (wellFormed.length === 0) return result;

  // KV read all well-formed ids in parallel; collect the misses for one DB query.
  const cached = await Promise.all(
    wellFormed.map((id) => kvGet<string>(kv, `campaign-org:${id}`)),
  );
  const misses: string[] = [];
  wellFormed.forEach((id, i) => {
    const hit = cached[i];
    if (hit === null || hit === undefined) {
      misses.push(id);
    } else if (hit === NEGATIVE_MARKER) {
      result.set(id, null); // known-unknown campaign id
    } else {
      result.set(id, hit); // positive: real owning org
    }
  });

  if (misses.length === 0) return result;

  // ONE DB query for all misses. On throw, FAIL CLOSED: every miss → null and we
  // cache NOTHING so a later request re-resolves. Logged: during a database
  // outage this drops every analytics event whose campaign is not KV-cached,
  // and without a log that loss is invisible.
  let rows: Array<{ id: string; organizationId: string }>;
  try {
    rows = await db
      .select({ id: campaigns.id, organizationId: campaigns.organizationId })
      .from(campaigns)
      .where(inArray(campaigns.id, misses));
  } catch (err) {
    console.error("analytics: campaign owner lookup failed; dropping these events", {
      campaigns: misses.length,
      error: errorSummary(err),
    });
    for (const id of misses) result.set(id, null);
    return result;
  }

  const owners = new Map<string, string>();
  for (const row of rows) owners.set(row.id, row.organizationId);

  for (const id of misses) {
    const ownerOrgId = owners.get(id) ?? null;
    result.set(id, ownerOrgId);
    if (ownerOrgId === null) {
      // Unknown id — short negative marker to absorb garbage-id floods without
      // re-hitting the DB, while staying short in case it's brand new.
      kvSet(kv, `campaign-org:${id}`, NEGATIVE_MARKER, NEGATIVE_TTL_SECONDS).catch(
        () => {},
      );
    } else {
      // Positive — cache the real owning org with a long TTL (immutable ownership).
      kvSet(kv, `campaign-org:${id}`, ownerOrgId, POSITIVE_TTL_SECONDS).catch(
        () => {},
      );
    }
  }

  return result;
}

/**
 * Returns true iff `campaignId` is owned by `organizationId`. Validates via a
 * KV-cached campaign→org lookup, falling back to a single DB read on cache miss
 * (then caching the result). On a DB error we FAIL CLOSED for validation (return
 * false → the event is dropped) rather than write a poisoned/garbage rollup; a
 * dropped analytics event is far cheaper than corrupted customer analytics.
 *
 * Thin wrapper over `resolveCampaignOwners` (so it also gets the ULID shape
 * guard: a malformed id returns false with zero I/O).
 */
export async function isCampaignOwnedByOrg(
  db: ReturnType<typeof createDb>,
  kv: KVNamespace,
  campaignId: string,
  organizationId: string,
): Promise<boolean> {
  if (!campaignId || !organizationId) return false;
  const owners = await resolveCampaignOwners(db, kv, [campaignId]);
  return owners.get(campaignId) === organizationId;
}
