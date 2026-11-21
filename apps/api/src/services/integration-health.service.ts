// ── Integration health (last error per area) ────────────────────────────────
// The merchant has to be able to SEE when their provider integration is broken:
// a coupon that could not be created, a webhook that could not be set up, a key
// that stopped authenticating. The last error per area lives on the
// integration row (`integrations.health`, jsonb) and is returned by
// GET /v1/teams/:orgId/integrations.
//
// Writes are rare by construction:
//  - recording rewrites an area only when the issue is new, different, or older
//    than REWRITE_AFTER_MS, decided inside the UPDATE itself (one statement, no
//    read-modify-write race);
//  - clearing is free on the healthy path: given the loaded row it checks the
//    area in memory and only issues an UPDATE when something is recorded.
// Every function here is best-effort and never throws: health reporting must
// not break the request that observed it.

import { and, eq, sql } from "drizzle-orm";
import type { Database } from "../db";
import { integrations } from "../db/schema";
import { errorSummary } from "../lib/log";

export type IntegrationHealthArea =
  | "coupon_sync" // creating/replacing a coupon at the provider failed
  | "webhook_setup" // provisioning the redemption webhook failed
  | "webhook_delivery" // deliveries can't be verified or processed
  | "credentials"; // the provider rejected the stored key

export const INTEGRATION_HEALTH_AREAS: readonly IntegrationHealthArea[] = [
  "coupon_sync",
  "webhook_setup",
  "webhook_delivery",
  "credentials",
];

export interface IntegrationHealthIssue {
  area: IntegrationHealthArea;
  message: string;
  environment?: "live" | "test";
  /** ISO timestamp of the last time this issue was observed (within REWRITE_AFTER_MS). */
  at: string;
}

export type IntegrationHealth = Partial<Record<IntegrationHealthArea, IntegrationHealthIssue>>;

/** Anything that can run an UPDATE: the db or a transaction. */
export type HealthDb = Pick<Database, "update">;

/** An integration id, or the loaded row (lets clearing skip the query when healthy). */
export type IntegrationRef = string | { id: string; health?: unknown };

export const REWRITE_AFTER_MS = 10 * 60 * 1000;
const MAX_MESSAGE_LENGTH = 300;

/**
 * Errors become merchant-visible text (and webhook_events.error_message): keep
 * it short and single-line. A Drizzle query error's own message embeds the SQL
 * and every parameter VALUE (which can be a stored webhook body with customer
 * data), so only its driver cause's message is used (same unwrapping as
 * lib/log.ts errorSummary, detected by shape).
 */
export function describeError(err: unknown): string {
  let source = err;
  const wrapped = err as { query?: unknown; cause?: unknown } | null;
  if (err instanceof Error && typeof wrapped?.query === "string") {
    source = wrapped.cause instanceof Error ? wrapped.cause : new Error("Database query failed");
  }
  const raw =
    source instanceof Error ? source.message : typeof source === "string" ? source : "Unknown error";
  const oneLine = raw.replace(/\s+/g, " ").trim();
  return oneLine.length > MAX_MESSAGE_LENGTH ? `${oneLine.slice(0, MAX_MESSAGE_LENGTH - 1)}…` : oneLine;
}

function isArea(v: unknown): v is IntegrationHealthArea {
  return typeof v === "string" && (INTEGRATION_HEALTH_AREAS as readonly string[]).includes(v);
}

/** The stored health of a loaded integration row, keeping only well-formed issues. */
export function integrationHealthOf(row: { health?: unknown } | null | undefined): IntegrationHealth {
  const raw = row?.health;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: IntegrationHealth = {};
  for (const [area, issue] of Object.entries(raw as Record<string, unknown>)) {
    if (!isArea(area) || !issue || typeof issue !== "object") continue;
    const i = issue as Partial<IntegrationHealthIssue>;
    if (typeof i.message !== "string" || typeof i.at !== "string") continue;
    out[area] = {
      area,
      message: i.message,
      at: i.at,
      ...(i.environment === "live" || i.environment === "test" ? { environment: i.environment } : {}),
    };
  }
  return out;
}

const idOf = (ref: IntegrationRef) => (typeof ref === "string" ? ref : ref.id);

/** A copy of a loaded row with `issue` recorded, for responses built from the row. */
export function withHealthIssue<T extends { health?: unknown }>(row: T, issue: IntegrationHealthIssue): T {
  return { ...row, health: { ...integrationHealthOf(row), [issue.area]: issue } };
}

/** A copy of a loaded row with `area` cleared. */
export function withoutHealthIssue<T extends { health?: unknown }>(row: T, area: IntegrationHealthArea): T {
  const { [area]: _cleared, ...rest } = integrationHealthOf(row);
  return { ...row, health: rest };
}

/**
 * Record `issue` on the integration. Returns the issue as it is stored (for
 * merging into a response with withHealthIssue), whether or not this call had
 * to write it.
 */
export async function recordIntegrationIssue(
  db: HealthDb,
  ref: IntegrationRef,
  issue: { area: IntegrationHealthArea; message: string; environment?: "live" | "test" },
  now: Date = new Date(),
): Promise<IntegrationHealthIssue> {
  const message = describeError(issue.message);
  const environment = issue.environment ?? null;
  const stored: IntegrationHealthIssue = {
    area: issue.area,
    message,
    ...(environment ? { environment } : {}),
    at: now.toISOString(),
  };
  // Cheap pre-check on a loaded row; the UPDATE's own condition is authoritative.
  if (typeof ref !== "string") {
    const prev = integrationHealthOf(ref)[issue.area];
    if (
      prev &&
      prev.message === message &&
      (prev.environment ?? null) === environment &&
      now.getTime() - Date.parse(prev.at) < REWRITE_AFTER_MS
    ) {
      return prev;
    }
  }
  const cutoff = new Date(now.getTime() - REWRITE_AFTER_MS).toISOString();
  const prevIssue = sql`${integrations.health} -> ${issue.area}::text`;
  try {
    await db
      .update(integrations)
      .set({ health: sql`${integrations.health} || jsonb_build_object(${issue.area}::text, ${JSON.stringify(stored)}::jsonb)` })
      .where(
        and(
          eq(integrations.id, idOf(ref)),
          // Skip when the same issue was recorded recently (ISO timestamps
          // compare correctly as text).
          sql`NOT COALESCE(
            ${prevIssue} ->> 'message' = ${message}::text
            AND COALESCE(${prevIssue} ->> 'environment', '') = ${environment ?? ""}::text
            AND ${prevIssue} ->> 'at' > ${cutoff}::text,
            false)`,
        ),
      );
  } catch (err) {
    console.error("[integration-health] could not record issue", {
      integrationId: idOf(ref),
      area: issue.area,
      error: errorSummary(err),
    });
  }
  return stored;
}

export async function clearIntegrationIssue(
  db: HealthDb,
  ref: IntegrationRef,
  area: IntegrationHealthArea,
): Promise<void> {
  if (typeof ref !== "string" && !integrationHealthOf(ref)[area]) return; // healthy: no query
  try {
    await db
      .update(integrations)
      .set({ health: sql`${integrations.health} - ${area}::text` })
      .where(and(eq(integrations.id, idOf(ref)), sql`${integrations.health} ? ${area}::text`));
  } catch (err) {
    console.error("[integration-health] could not clear issue", {
      integrationId: idOf(ref),
      area,
      error: errorSummary(err),
    });
  }
}
