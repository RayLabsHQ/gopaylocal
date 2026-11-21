/**
 * Impressions, counted by the API.
 *
 * An impression is one offer served: a banner config request answered with
 * `show: true`. The config endpoint counts it here, in the same request,
 * for the campaign it served and the visitor's country (request.cf.country).
 * Clients do not report impressions: a second request per visitor would cost
 * as much as the one that served the offer, and anyone holding a public key
 * could post as many as they liked.
 *
 * What this means for the number: a visitor who gets the offer counts once per
 * config request. The script-tag banner keeps the answer for five minutes per
 * browser tab, so page views inside those five minutes are one impression.
 *
 * Counts go to `analytics_rollups.impressions` (organization, campaign,
 * country, UTC day), the row clicks, copies and redemptions are added to.
 * They are buffered per organization (services/count-buffer.ts) with the usage
 * meter's two speeds: at once for organizations with a monthly cap, one
 * statement per organization per isolate per 15 s window (or 1,000 buffered
 * impressions) for unlimited ones. A failed write is retried with the next
 * flush; what is in memory when an isolate dies is lost.
 */

import { sql } from "drizzle-orm";
import { ulid } from "ulid";
import type { Database } from "../db";
import { analyticsRollups } from "../db/schema";
import { CountBuffer, type CountBufferHooks, type CountBufferOptions } from "./count-buffer";
import { utcDay } from "./usage-meter";

export interface ImpressionRow {
  organizationId: string;
  campaignId: string;
  /** ISO 3166-1 alpha-2, upper case. */
  countryCode: string;
  /** UTC calendar day, YYYY-MM-DD. */
  day: string;
  count: number;
}

export interface ImpressionRecord {
  organizationId: string;
  campaignId: string;
  countryCode: string;
  /** The organization has a finite cap (or its cap is not known yet): write at once. */
  limited: boolean;
  now?: Date;
}

export const DEFAULT_IMPRESSION_METER_OPTIONS: CountBufferOptions = {
  flushDelayMs: 15_000,
  flushThreshold: 1_000,
  failureBackoffMs: 5_000,
};

/** A rollup row per distinct junk value is the alternative; see analytics-ingest.ts. */
const COUNTRY_CODE_RE = /^[A-Za-z]{2}$/;

export class ImpressionMeter {
  private readonly buffer: CountBuffer<ImpressionRow>;

  constructor(options: Partial<CountBufferOptions> = {}) {
    this.buffer = new CountBuffer<ImpressionRow>(
      "impression-meter",
      { ...DEFAULT_IMPRESSION_METER_OPTIONS, ...options },
      (rows) => ({ organizationId: rows[0]?.organizationId, rows: rows.length }),
    );
  }

  /** Test hook (integration tests set the window to 0). */
  configure(options: Partial<CountBufferOptions>): void {
    this.buffer.configure(options);
  }

  /** Test hook: drop buffered counts and state. */
  reset(): void {
    this.buffer.reset();
  }

  /** Buffered, not yet written impressions (tests and diagnostics). */
  bufferedCount(): number {
    return this.buffer.bufferedCount();
  }

  /**
   * Count one impression. Synchronous; never throws on account of the
   * database. An impression without a campaign or a two-letter country is
   * dropped.
   */
  record(event: ImpressionRecord, hooks: CountBufferHooks<ImpressionRow>): void {
    if (!event.organizationId || !event.campaignId || !COUNTRY_CODE_RE.test(event.countryCode ?? "")) return;
    const countryCode = event.countryCode.toUpperCase();
    const day = utcDay(event.now ?? new Date());
    this.buffer.add(
      {
        group: event.organizationId,
        rowKey: `${event.campaignId}\u0000${countryCode}\u0000${day}`,
        create: () => ({
          organizationId: event.organizationId,
          campaignId: event.campaignId,
          countryCode,
          day,
          count: 0,
        }),
        urgent: event.limited,
      },
      hooks,
    );
  }
}

/** The isolate-wide meter the banner route uses. */
export const impressionMeter = new ImpressionMeter();

/**
 * Add impressions to analytics_rollups. One statement; rows must have distinct
 * (organization, campaign, country, day) keys (the meter guarantees it).
 *
 * The conflict target lists all 6 columns of `analytics_rollups_upsert_idx`,
 * like every other rollup upsert (routes/analytics-ingest.ts explains why).
 * The environment is 'live' for every campaign, as it is for the click and
 * copy counters stored there. The SET value adds the incoming count to the
 * stored one.
 */
export function buildImpressionUpsert(db: Pick<Database, "insert">, rows: ImpressionRow[], now: Date = new Date()) {
  return db
    .insert(analyticsRollups)
    .values(
      rows.map((r) => ({
        id: ulid(),
        organizationId: r.organizationId,
        campaignId: r.campaignId,
        countryCode: r.countryCode,
        period: "day",
        periodStart: new Date(`${r.day}T00:00:00.000Z`),
        environment: "live" as const,
        impressions: r.count,
        createdAt: now,
      })),
    )
    .onConflictDoUpdate({
      target: [
        analyticsRollups.organizationId,
        analyticsRollups.campaignId,
        analyticsRollups.countryCode,
        analyticsRollups.period,
        analyticsRollups.periodStart,
        analyticsRollups.environment,
      ],
      set: { impressions: sql`${analyticsRollups.impressions} + excluded."impressions"` },
    });
}

export async function writeImpressionRows(db: Pick<Database, "insert">, rows: ImpressionRow[]): Promise<void> {
  if (rows.length === 0) return;
  await buildImpressionUpsert(db, rows);
}
