/**
 * Experiment (A/B test) service.
 *
 * An experiment links two campaigns of the same product and environment: A is
 * the control, B the variant, and `trafficSplitB` is the percent of visitors the
 * banner sends to B. The banner endpoint (banner-script.ts, contract C2) does the
 * per-visitor assignment; this module owns the rows and the rules:
 *
 *  - Both arms belong to the experiment's organization, product and
 *    environment, are different campaigns, and are `active` when the test
 *    starts (the only campaign status the banner serves).
 *  - At most one running experiment per (product, environment). The partial
 *    unique index `experiments_one_running_idx` enforces it; a violation is a
 *    409 here, never a pre-check race.
 *  - While a test runs, neither arm can be paused, moved back to draft, moved
 *    to another product or environment, or deleted (campaignUpdateBlockedBy-
 *    Experiment / assertCampaignNotInRunningExperiment, called by
 *    routes/campaigns.ts).
 *  - Ending a test records the winner, keeps it as it is (active) and pauses
 *    the loser.
 *  - An ended test is history: deleting one of its campaigns later keeps the
 *    test, its arm ids (the rollups are keyed by them) and the arm names taken
 *    when it started. Only deleting the product (or workspace) removes it.
 *
 * Every query is scoped to the organization. Product-scoped members
 * (lib/product-access.ts) only see experiments of products they can access.
 */

import { and, desc, eq, gte, inArray, lte, or, sql, type SQL } from "drizzle-orm";
import { ulid } from "ulid";
import type { Database } from "../db";
import { analyticsRollups, bannerConfigs, campaigns, experiments, products } from "../db/schema";
import { canAccessProduct } from "../lib/product-access";
import { pgErrorCode } from "../lib/log";
import { revenueSavedByCurrency, type RevenueByCurrency } from "./revenue.service";
import type { CampaignStatus, ExperimentStatus } from "@gopaylocal/shared/types";

/** Anything that can run a select: the database or an open transaction. */
type Queryable = Pick<Database, "select">;
type Transactional = Pick<Database, "transaction">;

export type ExperimentRow = typeof experiments.$inferSelect;
type Environment = "live" | "test";

/** An expected failure, mapped 1:1 to the HTTP response by the route. */
export class ExperimentError extends Error {
  readonly status: 400 | 403 | 404 | 409;
  readonly code: string;

  constructor(status: 400 | 403 | 404 | 409, message: string, code: string) {
    super(message);
    this.name = "ExperimentError";
    this.status = status;
    this.code = code;
  }
}

const notFound = () => new ExperimentError(404, "Experiment not found", "not_found");

// ── Create ──────────────────────────────────────────────────────────────────

export interface CreateExperimentInput {
  productId: string;
  campaignAId: string;
  campaignBId: string;
  name: string;
  trafficSplitB: number;
}

/**
 * Start an experiment. One transaction: the product and both arms are checked
 * inside it, and the two campaign rows are locked FOR UPDATE so a concurrent
 * pause or delete of an arm either finishes first (and this sees it) or waits
 * until the experiment row exists (and its guard sees that).
 */
export async function createExperiment(
  db: Transactional,
  params: {
    orgId: string;
    input: CreateExperimentInput;
    allowedProductIds: Set<string> | null;
    now?: Date;
  },
): Promise<ExperimentRow> {
  const { orgId, input, allowedProductIds } = params;
  const now = params.now ?? new Date();

  if (input.campaignAId === input.campaignBId) {
    throw new ExperimentError(400, "Campaign B must be a different campaign from campaign A", "same_campaign");
  }

  try {
    return await db.transaction(async (tx) => {
      const [product] = await tx
        .select({ id: products.id })
        .from(products)
        .where(and(eq(products.id, input.productId), eq(products.organizationId, orgId)))
        .limit(1);
      if (!product) {
        throw new ExperimentError(400, "Invalid productId for this organization", "invalid_product");
      }
      if (!canAccessProduct(allowedProductIds, product.id)) {
        throw new ExperimentError(403, "No access to that product", "no_product_access");
      }

      const arms = await tx
        .select({
          id: campaigns.id,
          name: campaigns.name,
          productId: campaigns.productId,
          environment: campaigns.environment,
          status: campaigns.status,
          discountDelivery: campaigns.discountDelivery,
        })
        .from(campaigns)
        .where(
          and(
            eq(campaigns.organizationId, orgId),
            inArray(campaigns.id, [input.campaignAId, input.campaignBId]),
          ),
        )
        // Id order: the same lock order as assertIntegrationDisconnectKeepsExperiments,
        // so the two never deadlock when both arms are on the integration.
        .orderBy(campaigns.id)
        .for("update");

      const armA = arms.find((a) => a.id === input.campaignAId);
      const armB = arms.find((a) => a.id === input.campaignBId);
      // Same message whether the id is unknown or another org's: campaign ids
      // are public (the banner response carries them).
      if (!armA || !armB) {
        throw new ExperimentError(400, "Both campaigns must belong to this organization", "invalid_campaign");
      }
      if (armA.productId !== product.id || armB.productId !== product.id) {
        throw new ExperimentError(400, "Both campaigns must belong to the selected product", "campaign_product_mismatch");
      }
      if (armA.environment !== armB.environment) {
        throw new ExperimentError(
          400,
          "Both campaigns must be in the same environment (live or test)",
          "campaign_environment_mismatch",
        );
      }
      // Same "servable" rule as the banner (banner-selection.ts
      // isServableCampaign): active, with a banner config row. Arms that
      // become unservable later are handled there (the other arm serves).
      const inactive = [armA, armB].find((a) => a.status !== "active");
      if (inactive) {
        throw new ExperimentError(
          409,
          `Both campaigns must be active to start an A/B test; "${inactive.name}" is ${inactive.status}.`,
          "campaign_not_active",
        );
      }
      // A campaign whose payment platform charges the country price can't be
      // an arm: the platform charges that price to every buyer of the product,
      // whichever arm they saw.
      const charged = [armA, armB].find((a) => a.discountDelivery === "provider_price");
      if (charged) {
        throw new ExperimentError(
          409,
          `"${charged.name}" lets Dodo charge each country's price, which every buyer of the product pays whichever arm they see. A/B tests need two campaigns with discount codes.`,
          "campaign_charges_country_prices",
        );
      }
      // banner_configs has no organization_id; both ids were just verified to
      // belong to this org.
      const withBanner = await tx
        .select({ campaignId: bannerConfigs.campaignId })
        .from(bannerConfigs)
        .where(inArray(bannerConfigs.campaignId, [armA.id, armB.id]));
      const noBanner = [armA, armB].find((a) => !withBanner.some((b) => b.campaignId === a.id));
      if (noBanner) {
        throw new ExperimentError(
          409,
          `"${noBanner.name}" has no banner configuration, so the banner cannot serve it.`,
          "campaign_not_servable",
        );
      }

      const [row] = await tx
        .insert(experiments)
        .values({
          id: ulid(),
          organizationId: orgId,
          productId: product.id,
          environment: armA.environment,
          name: input.name,
          status: "running",
          campaignAId: armA.id,
          campaignBId: armB.id,
          campaignAName: armA.name,
          campaignBName: armB.name,
          trafficSplitB: input.trafficSplitB,
          winnerCampaignId: null,
          startedAt: now,
          endedAt: null,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      return row!;
    });
  } catch (err) {
    // experiments_one_running_idx is the only unique index besides the ULID
    // primary key, so a unique violation here means a test is already running.
    if (pgErrorCode(err) === "23505") {
      throw new ExperimentError(
        409,
        "This product already has a running A/B test in this environment. End it before starting another.",
        "experiment_already_running",
      );
    }
    throw err;
  }
}

// ── Read ────────────────────────────────────────────────────────────────────

export interface ArmCampaign {
  id: string;
  name: string;
  status: CampaignStatus;
}

export type ExperimentWithArms = ExperimentRow & {
  campaignA: ArmCampaign | null;
  campaignB: ArmCampaign | null;
};

export interface ExperimentFilters {
  productId?: string;
  campaignId?: string;
  environment?: Environment;
  status?: ExperimentStatus;
}

/** Attach each arm's name and status (one org-scoped query for all rows). */
async function withArms(db: Queryable, orgId: string, rows: ExperimentRow[]): Promise<ExperimentWithArms[]> {
  if (rows.length === 0) return [];
  const ids = [...new Set(rows.flatMap((r) => [r.campaignAId, r.campaignBId]))];
  const arms = await db
    .select({ id: campaigns.id, name: campaigns.name, status: campaigns.status })
    .from(campaigns)
    .where(and(eq(campaigns.organizationId, orgId), inArray(campaigns.id, ids)));
  const byId = new Map(arms.map((a) => [a.id, a]));
  return rows.map((r) => ({
    ...r,
    campaignA: byId.get(r.campaignAId) ?? null,
    campaignB: byId.get(r.campaignBId) ?? null,
  }));
}

export async function listExperiments(
  db: Queryable,
  orgId: string,
  filters: ExperimentFilters,
  allowedProductIds: Set<string> | null,
): Promise<ExperimentWithArms[]> {
  const conditions: SQL[] = [eq(experiments.organizationId, orgId)];
  if (filters.productId) conditions.push(eq(experiments.productId, filters.productId));
  if (filters.environment) conditions.push(eq(experiments.environment, filters.environment));
  if (filters.status) conditions.push(eq(experiments.status, filters.status));
  if (filters.campaignId) {
    conditions.push(
      or(eq(experiments.campaignAId, filters.campaignId), eq(experiments.campaignBId, filters.campaignId))!,
    );
  }
  if (allowedProductIds) {
    if (allowedProductIds.size === 0) return [];
    conditions.push(inArray(experiments.productId, Array.from(allowedProductIds)));
  }

  const rows = await db
    .select()
    .from(experiments)
    .where(and(...conditions))
    .orderBy(desc(experiments.createdAt));
  return withArms(db, orgId, rows);
}

/** One experiment in `orgId` the caller may access, or null (route: 404). */
export async function getExperiment(
  db: Queryable,
  orgId: string,
  experimentId: string,
  allowedProductIds: Set<string> | null,
): Promise<ExperimentWithArms | null> {
  const [row] = await db
    .select()
    .from(experiments)
    .where(and(eq(experiments.id, experimentId), eq(experiments.organizationId, orgId)))
    .limit(1);
  if (!row || !canAccessProduct(allowedProductIds, row.productId)) return null;
  const [withArm] = await withArms(db, orgId, [row]);
  return withArm!;
}

// ── Results ─────────────────────────────────────────────────────────────────

const DAY_MS = 86_400_000;

export function utcDayStart(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

export interface ArmTotals {
  impressions: number;
  clicks: number;
  copies: number;
  redemptions: number;
  /**
   * Discount given on the redemptions, per currency in major units
   * ({ USD: 120, INR: 4000 }), the same figure as the analytics endpoints'
   * revenueSavedByCurrency. Currencies are never added together.
   */
  revenueSavedByCurrency: RevenueByCurrency;
}

/**
 * Per-arm numbers. Rates are fractions (0.04 = 4%), null when the denominator
 * is zero rather than 0 or NaN, so "no data yet" never reads as "0%".
 */
export interface ArmResult extends ArmTotals {
  campaignId: string;
  /** clicks / impressions */
  clickRate: number | null;
  /** copies / impressions */
  copyRate: number | null;
  /** redemptions / impressions */
  conversionRate: number | null;
  /** redemptions / copies */
  redemptionsPerCopy: number | null;
}

export interface ExperimentResults {
  /** analytics_rollups are daily (UTC) buckets; results cover whole days. */
  granularity: "day";
  /** First UTC day counted (the start day, or the retention limit if later). */
  from: string;
  /** Last moment counted: the end time for an ended test, null while running (through today). */
  to: string | null;
  /** True when the plan's analytics retention cut off the start of the test. */
  truncatedByRetention: boolean;
  a: ArmResult;
  b: ArmResult;
  /** Share of all impressions that went to B (compare with trafficSplitB), null with no impressions. */
  observedShareB: number | null;
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator > 0 ? numerator / denominator : null;
}

export function summarizeArm(campaignId: string, totals: ArmTotals): ArmResult {
  return {
    campaignId,
    ...totals,
    clickRate: ratio(totals.clicks, totals.impressions),
    copyRate: ratio(totals.copies, totals.impressions),
    conversionRate: ratio(totals.redemptions, totals.impressions),
    redemptionsPerCopy: ratio(totals.redemptions, totals.copies),
  };
}

/**
 * The window of daily rollups that belong to an experiment: from the UTC day it
 * started (whole day) to the moment it ended (so the end day's bucket, which
 * starts at midnight, is included), never earlier than the plan's retention
 * start (the same clamp routes/analytics.ts applies).
 */
export function resultsWindow(
  experiment: Pick<ExperimentRow, "startedAt" | "endedAt">,
  retentionStart: number,
): { from: Date; to: Date | null; truncatedByRetention: boolean } {
  const startDay = utcDayStart(experiment.startedAt).getTime();
  const truncatedByRetention = retentionStart > startDay;
  return {
    from: new Date(truncatedByRetention ? retentionStart : startDay),
    to: experiment.endedAt,
    truncatedByRetention,
  };
}

/** Retention start (ms) for `retentionDays` of history, as routes/analytics.ts computes it. */
export function retentionStartFor(retentionDays: number, nowMs: number = Date.now()): number {
  return nowMs - retentionDays * DAY_MS;
}

const ZERO_COUNTS = { impressions: 0, clicks: 0, copies: 0, redemptions: 0 };

export async function getExperimentResults(
  db: Queryable,
  experiment: Pick<
    ExperimentRow,
    "organizationId" | "environment" | "campaignAId" | "campaignBId" | "startedAt" | "endedAt"
  >,
  retentionStart: number,
): Promise<ExperimentResults> {
  const window = resultsWindow(experiment, retentionStart);
  const conditions: SQL[] = [
    eq(analyticsRollups.organizationId, experiment.organizationId),
    eq(analyticsRollups.environment, experiment.environment),
    eq(analyticsRollups.period, "day"),
    inArray(analyticsRollups.campaignId, [experiment.campaignAId, experiment.campaignBId]),
    // gte()/lte() map the Date through the column type (a raw sql param does not).
    gte(analyticsRollups.periodStart, window.from),
  ];
  if (window.to) conditions.push(lte(analyticsRollups.periodStart, window.to));

  const rows = await db
    .select({
      campaignId: analyticsRollups.campaignId,
      impressions: sql<number>`COALESCE(SUM(${analyticsRollups.impressions}), 0)`,
      clicks: sql<number>`COALESCE(SUM(${analyticsRollups.clicks}), 0)`,
      copies: sql<number>`COALESCE(SUM(${analyticsRollups.copies}), 0)`,
      redemptions: sql<number>`COALESCE(SUM(${analyticsRollups.redemptions}), 0)`,
    })
    .from(analyticsRollups)
    .where(and(...conditions))
    .groupBy(analyticsRollups.campaignId);
  // Same rows, per currency (revenue_saved itself is USD only).
  const revenue = await revenueSavedByCurrency(db, and(...conditions), analyticsRollups.campaignId);

  // SUM() comes back as a string from postgres-js; coerce like routes/analytics.ts.
  const totalsFor = (campaignId: string): ArmTotals => {
    const r = rows.find((row) => row.campaignId === campaignId);
    const counts = r
      ? {
          impressions: Number(r.impressions),
          clicks: Number(r.clicks),
          copies: Number(r.copies),
          redemptions: Number(r.redemptions),
        }
      : { ...ZERO_COUNTS };
    return { ...counts, revenueSavedByCurrency: revenue.get(campaignId) ?? {} };
  };

  const a = summarizeArm(experiment.campaignAId, totalsFor(experiment.campaignAId));
  const b = summarizeArm(experiment.campaignBId, totalsFor(experiment.campaignBId));
  return {
    granularity: "day",
    from: window.from.toISOString(),
    to: window.to ? window.to.toISOString() : null,
    truncatedByRetention: window.truncatedByRetention,
    a,
    b,
    observedShareB: ratio(b.impressions, a.impressions + b.impressions),
  };
}

// ── Update ──────────────────────────────────────────────────────────────────

export interface UpdateExperimentInput {
  name?: string;
  trafficSplitB?: number;
}

/**
 * Rename an experiment (any time) or change its traffic split (only while it
 * runs). The split condition is part of the UPDATE itself, so a test that
 * ends between the read and the write is not changed.
 */
export async function updateExperiment(
  db: Pick<Database, "select" | "update">,
  params: {
    orgId: string;
    experimentId: string;
    input: UpdateExperimentInput;
    allowedProductIds: Set<string> | null;
    now?: Date;
  },
): Promise<ExperimentRow> {
  const { orgId, experimentId, input, allowedProductIds } = params;
  const [existing] = await db
    .select({ productId: experiments.productId, status: experiments.status })
    .from(experiments)
    .where(and(eq(experiments.id, experimentId), eq(experiments.organizationId, orgId)))
    .limit(1);
  if (!existing || !canAccessProduct(allowedProductIds, existing.productId)) throw notFound();

  const changesSplit = input.trafficSplitB !== undefined;
  const splitEnded = () =>
    new ExperimentError(409, "The traffic split can only change while the test is running", "experiment_ended");
  if (changesSplit && existing.status !== "running") throw splitEnded();

  const set: Partial<typeof experiments.$inferInsert> = { updatedAt: params.now ?? new Date() };
  if (input.name !== undefined) set.name = input.name;
  if (changesSplit) set.trafficSplitB = input.trafficSplitB;

  const conditions: SQL[] = [eq(experiments.id, experimentId), eq(experiments.organizationId, orgId)];
  if (changesSplit) conditions.push(eq(experiments.status, "running"));

  const [row] = await db.update(experiments).set(set).where(and(...conditions)).returning();
  if (!row) throw changesSplit ? splitEnded() : notFound();
  return row;
}

// ── End ─────────────────────────────────────────────────────────────────────

/**
 * End a running experiment: record the winner, pause the loser (if it is
 * active), leave the winner as it is. One transaction, with the experiment row
 * locked so two concurrent "End Test" requests cannot both succeed.
 * Returns the ended row and the id of the campaign that was paused (null when
 * the loser was not active, e.g. already paused).
 */
export async function endExperiment(
  db: Transactional,
  params: {
    orgId: string;
    experimentId: string;
    winnerCampaignId: string;
    allowedProductIds: Set<string> | null;
    now?: Date;
  },
): Promise<{ experiment: ExperimentRow; pausedCampaignId: string | null }> {
  const { orgId, experimentId, winnerCampaignId, allowedProductIds } = params;
  const now = params.now ?? new Date();

  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(experiments)
      .where(and(eq(experiments.id, experimentId), eq(experiments.organizationId, orgId)))
      .limit(1)
      .for("update");
    if (!existing || !canAccessProduct(allowedProductIds, existing.productId)) throw notFound();
    if (existing.status !== "running") {
      throw new ExperimentError(409, "This A/B test has already ended", "experiment_ended");
    }
    if (winnerCampaignId !== existing.campaignAId && winnerCampaignId !== existing.campaignBId) {
      throw new ExperimentError(
        400,
        "winnerCampaignId must be campaign A or campaign B of this test",
        "invalid_winner",
      );
    }
    const loserId = winnerCampaignId === existing.campaignAId ? existing.campaignBId : existing.campaignAId;

    const paused = await tx
      .update(campaigns)
      .set({ status: "paused", updatedAt: now })
      .where(
        and(
          eq(campaigns.id, loserId),
          eq(campaigns.organizationId, orgId),
          eq(campaigns.status, "active"),
        ),
      )
      .returning({ id: campaigns.id });

    const [ended] = await tx
      .update(experiments)
      .set({ status: "ended", winnerCampaignId, endedAt: now, updatedAt: now })
      .where(and(eq(experiments.id, experimentId), eq(experiments.organizationId, orgId)))
      .returning();

    return { experiment: ended!, pausedCampaignId: paused[0]?.id ?? null };
  });
}

// ── Campaign lifecycle guards (used by routes/campaigns.ts) ─────────────────

/** The running experiment that uses `campaignId` as an arm, if any. */
export async function findRunningExperimentForCampaign(
  db: Queryable,
  orgId: string,
  campaignId: string,
): Promise<{ id: string; name: string; productId: string; environment: Environment } | null> {
  const [row] = await db
    .select({
      id: experiments.id,
      name: experiments.name,
      productId: experiments.productId,
      environment: experiments.environment,
    })
    .from(experiments)
    .where(
      and(
        eq(experiments.organizationId, orgId),
        eq(experiments.status, "running"),
        or(eq(experiments.campaignAId, campaignId), eq(experiments.campaignBId, campaignId)),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** 409 body for a campaign change refused because of a running experiment. */
export interface CampaignExperimentConflict {
  error: string;
  code: "campaign_in_running_experiment";
  experimentId: string;
}

function conflictFor(experiment: { id: string; name: string }, action: string): CampaignExperimentConflict {
  return {
    error: `This campaign is an arm of the running A/B test "${experiment.name}". End the test before you ${action}.`,
    code: "campaign_in_running_experiment",
    experimentId: experiment.id,
  };
}

/**
 * Guard for PATCH /campaigns/:id. Returns the 409 body when the update would
 * break a running experiment, otherwise null. Refused while the campaign is an
 * arm of a running experiment:
 *  - a status other than 'active' (pause, back to draft): the banner only
 *    serves active campaigns, so the split would silently stop;
 *  - a different productId or environment: both arms must stay in the
 *    experiment's product and environment.
 *  - its discount delivery can't become provider_price (the platform would
 *    charge that price to every buyer, whichever arm they saw).
 * Every other field (name, discounts, delivery, ...) can change mid-test.
 * Runs no query when the update touches none of those fields.
 */
export async function campaignUpdateBlockedByExperiment(
  db: Queryable,
  orgId: string,
  campaignId: string,
  update: { status?: string; productId?: string; environment?: string; discountDelivery?: string },
): Promise<CampaignExperimentConflict | null> {
  const touchesStatus = update.status !== undefined && update.status !== "active";
  const chargesCountryPrices = update.discountDelivery === "provider_price";
  if (!touchesStatus && !chargesCountryPrices && update.productId === undefined && update.environment === undefined) {
    return null;
  }

  const running = await findRunningExperimentForCampaign(db, orgId, campaignId);
  if (!running) return null;
  if (touchesStatus) return conflictFor(running, "pause it or move it back to draft");
  if (chargesCountryPrices) return conflictFor(running, "let Dodo charge each country's price");
  if (update.productId !== undefined && update.productId !== running.productId) {
    return conflictFor(running, "move it to another product");
  }
  if (update.environment !== undefined && update.environment !== running.environment) {
    return conflictFor(running, "move it to another environment");
  }
  return null;
}

/** Thrown by assertCampaignNotInRunningExperiment; the campaign route answers 409 with `body`. */
export class CampaignInRunningExperimentError extends Error {
  readonly body: CampaignExperimentConflict;
  constructor(experiment: { id: string; name: string }) {
    const body = conflictFor(experiment, "delete it");
    super(body.error);
    this.name = "CampaignInRunningExperimentError";
    this.body = body;
  }
}

/**
 * Call inside the campaign-delete transaction, after the access check and
 * before anything is deleted. Throws CampaignInRunningExperimentError when the
 * campaign is an arm of a running experiment. Ended experiments need nothing:
 * their arm ids are plain history columns, so the test and its results stay.
 *
 * The campaign row is locked first. createExperiment locks both arms FOR
 * UPDATE before inserting, so the two serialize: either the test exists by the
 * time this check runs (409), or the delete commits first and the create no
 * longer finds the campaign (400 invalid_campaign).
 */
export async function assertCampaignNotInRunningExperiment(
  tx: Queryable,
  orgId: string,
  campaignId: string,
): Promise<void> {
  await tx
    .select({ id: campaigns.id })
    .from(campaigns)
    .where(and(eq(campaigns.id, campaignId), eq(campaigns.organizationId, orgId)))
    .for("update");
  const running = await findRunningExperimentForCampaign(tx, orgId, campaignId);
  if (running) throw new CampaignInRunningExperimentError(running);
}

/** Thrown by assertIntegrationDisconnectKeepsExperiments; the route answers 409 with `body`. */
export class IntegrationInRunningExperimentError extends Error {
  readonly body: { error: string; code: "integration_in_running_experiment"; experimentId: string };
  constructor(experiment: { id: string; name: string }) {
    const error =
      `Disconnecting this integration would pause an auto-apply campaign of the running A/B test "${experiment.name}". ` +
      "End the test before you disconnect it.";
    super(error);
    this.name = "IntegrationInRunningExperimentError";
    this.body = { error, code: "integration_in_running_experiment", experimentId: experiment.id };
  }
}

/**
 * Call inside the integration-disconnect transaction, before the active
 * auto-apply campaigns linked to the integration are paused. Throws
 * IntegrationInRunningExperimentError when one of those campaigns is an arm of
 * a running experiment: pausing it would make the banner serve the other arm
 * to everyone, so the test would quietly stop being a test (the same rule as
 * pausing an arm by hand).
 *
 * The campaigns the disconnect will pause are locked first. createExperiment
 * locks its arms FOR UPDATE, so the two serialize: a test that commits first
 * is seen by the select below; one that starts later waits, and then finds
 * its arm paused (409 campaign_not_active).
 */
export async function assertIntegrationDisconnectKeepsExperiments(
  tx: Queryable,
  orgId: string,
  integrationId: string,
): Promise<void> {
  await tx
    .select({ id: campaigns.id })
    .from(campaigns)
    .where(
      and(
        eq(campaigns.organizationId, orgId),
        eq(campaigns.integrationId, integrationId),
        eq(campaigns.status, "active"),
        eq(campaigns.discountDelivery, "auto_apply"),
      ),
    )
    .orderBy(campaigns.id) // same lock order as createExperiment
    .for("update");
  const [running] = await tx
    .select({ id: experiments.id, name: experiments.name })
    .from(experiments)
    .innerJoin(
      campaigns,
      or(eq(campaigns.id, experiments.campaignAId), eq(campaigns.id, experiments.campaignBId)),
    )
    .where(
      and(
        eq(experiments.organizationId, orgId),
        eq(experiments.status, "running"),
        eq(campaigns.organizationId, orgId),
        eq(campaigns.integrationId, integrationId),
        eq(campaigns.status, "active"),
        eq(campaigns.discountDelivery, "auto_apply"),
      ),
    )
    .limit(1);
  if (running) throw new IntegrationInRunningExperimentError(running);
}
