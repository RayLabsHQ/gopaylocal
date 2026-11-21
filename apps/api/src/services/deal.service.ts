/**
 * Holiday deals (db/schema.ts `deals`, packages/shared/src/deals): what the
 * deal routes and the campaign routes share. The provider calls themselves are
 * in coupon.service.ts (ensureDealCoupon, retireDealCoupons); which deal a
 * visitor is offered is decided in routes/banner-script.ts.
 */

import { and, asc, eq, gt, inArray } from "drizzle-orm";
import { dealPhase, type DealCodeSource, type DealPhase } from "@gopaylocal/shared/deals";
import type { Database } from "../db";
import type { Bindings } from "../bindings";
import { campaigns, coupons, deals, integrations } from "../db/schema";
import {
  COUPON_STATUS,
  campaignEnvironment,
  ensureDealCoupon,
  isDisplayableCoupon,
  isProviderAuthFailure,
  retireDealCoupons,
} from "./coupon.service";
import { clearIntegrationIssue, describeError, recordIntegrationIssue } from "./integration-health.service";
import { errorSummary } from "../lib/log";

export type DealRow = typeof deals.$inferSelect;
type CampaignRow = typeof campaigns.$inferSelect;
type IntegrationRow = typeof integrations.$inferSelect;
type CouponRow = typeof coupons.$inferSelect;

/** A deal as the API returns it. */
export interface DealView {
  id: string;
  campaignId: string;
  name: string;
  discountPercent: number;
  /** ISO 8601, UTC. The deal runs from startsAt (inclusive) to endsAt (exclusive). */
  startsAt: string;
  endsAt: string;
  messageTemplate: string;
  codeSource: DealCodeSource;
  /** The code visitors are given. Null for a deal without one, or while a provider deal's code is missing. */
  code: string | null;
  /**
   * False only for a `provider` deal that has no working code at the campaign's
   * integration (the integration was unlinked, or the deal has ended and its
   * code was removed). Such a deal is not offered.
   */
  codeReady: boolean;
  phase: DealPhase;
  createdAt: string;
  updatedAt: string;
}

export function toDealView(
  deal: DealRow,
  campaign: Pick<CampaignRow, "integrationId" | "environment">,
  dealCoupons: readonly Pick<CouponRow, "code" | "status" | "integrationId" | "environment" | "discountPercent">[],
  now: number,
): DealView {
  let code: string | null = null;
  let codeReady = true;
  if (deal.codeSource === "provider") {
    const coupon = dealCoupons.find((c) =>
      isDisplayableCoupon(c, {
        integrationId: campaign.integrationId,
        environment: campaignEnvironment(campaign),
        discountPercent: deal.discountPercent,
      }),
    );
    code = coupon?.code ?? null;
    codeReady = !!coupon;
  } else if (deal.codeSource === "manual") {
    code = deal.manualCode;
    codeReady = !!deal.manualCode;
  }
  const startsAt = new Date(deal.startsAt);
  const endsAt = new Date(deal.endsAt);
  return {
    id: deal.id,
    campaignId: deal.campaignId,
    name: deal.name,
    discountPercent: deal.discountPercent,
    startsAt: startsAt.toISOString(),
    endsAt: endsAt.toISOString(),
    messageTemplate: deal.messageTemplate,
    codeSource: deal.codeSource,
    code,
    codeReady,
    phase: dealPhase({ startsAt: startsAt.getTime(), endsAt: endsAt.getTime() }, now),
    createdAt: new Date(deal.createdAt).toISOString(),
    updatedAt: new Date(deal.updatedAt).toISOString(),
  };
}

/** The active coupon rows of some deals, by deal id. */
async function activeCouponsByDeal(db: Database, dealIds: string[]): Promise<Map<string, CouponRow[]>> {
  const byDeal = new Map<string, CouponRow[]>();
  if (dealIds.length === 0) return byDeal;
  const rows = await db
    .select()
    .from(coupons)
    .where(and(inArray(coupons.dealId, dealIds), eq(coupons.status, COUPON_STATUS.active)));
  for (const row of rows) {
    if (!row.dealId) continue;
    const list = byDeal.get(row.dealId);
    if (list) list.push(row);
    else byDeal.set(row.dealId, [row]);
  }
  return byDeal;
}

/** Every deal of a campaign, ended ones included, by start. */
export async function listDeals(db: Database, campaign: CampaignRow, now: number = Date.now()): Promise<DealView[]> {
  const rows = await db
    .select()
    .from(deals)
    .where(and(eq(deals.campaignId, campaign.id), eq(deals.organizationId, campaign.organizationId)))
    .orderBy(asc(deals.startsAt), asc(deals.id));
  const byDeal = await activeCouponsByDeal(db, rows.map((d) => d.id));
  return rows.map((deal) => toDealView(deal, campaign, byDeal.get(deal.id) ?? [], now));
}

/** One deal with its code, as the API returns it. */
export async function viewDeal(db: Database, campaign: CampaignRow, deal: DealRow, now: number = Date.now()): Promise<DealView> {
  const byDeal = await activeCouponsByDeal(db, [deal.id]);
  return toDealView(deal, campaign, byDeal.get(deal.id) ?? [], now);
}

/** Thrown by createDealCode when the provider refuses; the routes answer 502 with `message`. */
export class DealCodeError extends Error {
  constructor(
    message: string,
    readonly provider: string,
  ) {
    super(message);
    this.name = "DealCodeError";
  }
}

/**
 * Make sure a `provider` deal has its code at the campaign's integration, and
 * keep the integration's health in step (a refusal is the merchant's only
 * signal that the key or the account is the problem). Throws DealCodeError.
 */
export async function createDealCode(
  db: Database,
  env: Bindings,
  campaign: CampaignRow,
  integration: IntegrationRow,
  deal: DealRow,
): Promise<void> {
  try {
    await ensureDealCoupon(db, env, campaign, integration, deal);
    await clearIntegrationIssue(db, integration, "coupon_sync");
  } catch (err) {
    const reason = describeError(err);
    console.error(
      `[deal] code creation failed org=${campaign.organizationId} campaign=${campaign.id} deal=${deal.id} ` +
        `provider=${integration.provider}:`,
      reason,
    );
    await recordIntegrationIssue(db, integration, {
      area: isProviderAuthFailure(err) ? "credentials" : "coupon_sync",
      message: `Couldn't create the ${deal.discountPercent}% code for the deal "${deal.name}": ${reason}`,
      environment: campaignEnvironment(campaign),
    }).catch(() => {});
    throw new DealCodeError(reason, integration.provider);
  }
}

/**
 * After a campaign's integration or environment changed: bring the codes of
 * its `provider` deals that have not ended in line. With an active integration
 * each deal gets a code there (the codes of the previous integration or
 * environment are retired); without one, the codes are retired and the deals
 * are not offered until an integration is linked again. Never throws: a deal
 * whose code cannot be created is simply not offered, and the failure is on
 * the integration's health.
 *
 * Returns whether the campaign has such deals, that is, whether the banner
 * document can have changed and should be written again.
 */
export async function syncDealCouponsForCampaign(
  db: Database,
  env: Bindings,
  organizationId: string,
  campaignId: string,
  now: Date = new Date(),
): Promise<boolean> {
  try {
    const [campaign] = await db
      .select()
      .from(campaigns)
      .where(and(eq(campaigns.id, campaignId), eq(campaigns.organizationId, organizationId)))
      .limit(1);
    if (!campaign) return false;

    const open = await db
      .select()
      .from(deals)
      .where(and(eq(deals.campaignId, campaignId), eq(deals.codeSource, "provider"), gt(deals.endsAt, now)));
    if (open.length === 0) return false;

    const [integration] = campaign.integrationId
      ? await db
          .select()
          .from(integrations)
          .where(and(eq(integrations.id, campaign.integrationId), eq(integrations.organizationId, organizationId)))
          .limit(1)
      : [];

    for (const deal of open) {
      if (integration && integration.status === "active") {
        await createDealCode(db, env, campaign, integration, deal).catch(() => {});
      } else {
        await retireDealCoupons(db, env, deal.id, organizationId);
      }
    }
    return true;
  } catch (err) {
    console.error("deals: code sync failed", { organizationId, campaignId, error: errorSummary(err) });
    return true;
  }
}
