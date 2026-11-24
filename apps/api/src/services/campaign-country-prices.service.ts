/**
 * Campaigns whose payment platform charges each country's price itself
 * (discountDelivery 'provider_price', Dodo Payments only): instead of creating
 * discount codes, GoPayLocal writes one Localized Pricing rule per discounted
 * country on the campaign's Dodo product (campaigns.provider_product_id), and
 * the banner shows the price Dodo charges. Nothing is entered at checkout and
 * there is no code to share; Dodo matches the buyer's billing country.
 *
 * State lives in campaign_country_prices, one row per campaign and product:
 *  - wanted 'prices': keep the product's rules in line with the campaign;
 *  - wanted 'none': remove them all (campaign paused, deleted, switched to
 *    codes, or moved to another product); the row is deleted once Dodo has
 *    none left.
 * reconcileCampaignCountryPrices sets `wanted` after every campaign change;
 * syncCountryPriceRow does the Dodo calls, a batch at a time (the shared
 * applyCountryPrices); the scheduled job carries unfinished and due rows on.
 *
 * Before the first rule is written the product must cost what the GoPayLocal
 * product costs, have Dodo's PPP off (it would discount again) and have no
 * country prices of its own (a Dodo product holds one rule per country, and
 * the merchant's would be removed). After a sync the prices Dodo charges are
 * recorded on the row; the banner serves only those.
 */

import { and, asc, eq, isNull, lt, ne, or, sql } from "drizzle-orm";
import { ulid } from "ulid";
import type { Bindings } from "../bindings";
import type { Database } from "../db";
import { campaignCountryPrices, campaigns, integrations, products } from "../db/schema";
import { COUNTRY_NAMES } from "@gopaylocal/shared/constants";
import { localPricing, minorUnitExponent } from "@gopaylocal/shared/currency";
import { decrypt, tokenEncryptionSecret } from "../lib/crypto";
import { buildBannerDocNow, pushBannerConfigForOrg } from "./banner-cache.service";
import {
  applyCountryPrices,
  countryCharge,
  DODO_API_BASE,
  dodoRequester,
  publishedPrices,
  ruleCountry,
  type CountryPriceRow,
  type DodoRequest,
  type DodoRule,
  type PublishedPrice,
} from "./dodo-country-prices";
import { loadFxRates, parseExcludedCurrencies } from "./fx-cache";
import { fxDisabled } from "./fx-refresh.service";
import { accessTokenEncFor } from "./providers";

/** Payment platforms that can charge a per-country price GoPayLocal sets. */
export const COUNTRY_PRICE_PROVIDERS: ReadonlySet<string> = new Set(["dodopayments"]);

/** Dodo calls one sync started by a campaign change may make. */
export const CHANGE_SYNC_BUDGET = 30;
/** Dodo calls the 10-minute job may make across all campaigns. */
export const SCHEDULED_SYNC_BUDGET = 20;
/** A row is due again this long after its last sync: exchange rates refresh every 6 hours. */
export const COUNTRY_PRICE_RESYNC_MS = 6 * 60 * 60 * 1000;

export type CountryPriceRowRecord = typeof campaignCountryPrices.$inferSelect;

export interface CountryPriceSyncRecord {
  at: string;
  trigger: "change" | "schedule" | "manual";
  created: number;
  updated: number;
  archived: number;
  failures: Array<{ country: string | null; status: number; message: string }>;
  remaining: number;
  /** Set when the sync stopped before writing anything. */
  problem?: string;
}

type CountryPriceEnv = Bindings;

// ── Checks on the Dodo product ──────────────────────────────────────────────

/**
 * Why Dodo's product can't carry these country prices, or null. `body` is
 * GET /products/{id} as Dodo returns it; `product` is the GoPayLocal product.
 */
export function dodoProductProblem(body: unknown, product: { basePrice: number; currency: string }): string | null {
  const price = (body as { price?: unknown } | null)?.price as
    | { type?: unknown; price?: unknown; currency?: unknown; purchasing_power_parity?: unknown; pay_what_you_want?: unknown }
    | undefined;
  if (!price || typeof price !== "object") return "Dodo returned the product without a price.";
  if (price.type === "usage_based_price") return "This Dodo product is usage-based. Dodo has no country prices for usage-based products.";
  if (price.pay_what_you_want === true) return "This Dodo product is pay-what-you-want. Dodo applies no country prices to it.";
  if (price.purchasing_power_parity === true) {
    return "Dodo's Purchasing Power Parity is on for this product. Turn it off in Dodo, or it would take its own discount off these prices.";
  }
  const currency = typeof price.currency === "string" ? price.currency.toUpperCase() : "";
  const minor = typeof price.price === "number" ? price.price : NaN;
  const expected = Math.round(product.basePrice * 10 ** minorUnitExponent(product.currency));
  if (currency !== product.currency.toUpperCase() || minor !== expected) {
    const shown = Number.isFinite(minor) && currency ? `${minor / 10 ** minorUnitExponent(currency)} ${currency}` : "an unknown price";
    return `The Dodo product costs ${shown}, but the GoPayLocal product costs ${product.basePrice} ${product.currency}. Make them the same.`;
  }
  return null;
}

/**
 * The countries whose rule GoPayLocal wrote: published with the discount it
 * was written for. A rule listed without one (null) is someone else's.
 */
export function ownedCountries(published: Record<string, PublishedPrice> | null | undefined): Set<string> {
  return new Set(
    Object.entries(published ?? {})
      .filter(([, p]) => p.discount !== null)
      .map(([country]) => country),
  );
}

/** On the first sync: the product must have no country prices GoPayLocal didn't write. */
export function existingRulesProblem(rules: readonly DodoRule[]): string | null {
  if (rules.length === 0) return null;
  const countries = rules.map(ruleCountry).filter(Boolean).length;
  return `This Dodo product already has ${rules.length} ${rules.length === 1 ? "price rule" : "price rules"}${
    countries ? "" : " by currency"
  }. Remove them in Dodo (Products, Localized Pricing), or pick another product: GoPayLocal would replace them.`;
}

// ── Which rows should exist ─────────────────────────────────────────────────

type CampaignForPrices = Pick<
  typeof campaigns.$inferSelect,
  "id" | "organizationId" | "status" | "discountDelivery" | "integrationId" | "providerProductId" | "environment"
>;

/** Whether the campaign wants its prices on its Dodo product now. */
export function wantsCountryPrices(campaign: CampaignForPrices, provider: string | null): boolean {
  return (
    campaign.status === "active" &&
    campaign.discountDelivery === "provider_price" &&
    !!campaign.integrationId &&
    !!campaign.providerProductId &&
    !!provider &&
    COUNTRY_PRICE_PROVIDERS.has(provider)
  );
}

/**
 * After a campaign is created, changed or deleted (`campaign` null): mark its
 * rows. The row for its current product is 'prices' while it wants them;
 * every other row of the campaign is 'none'. Returns the ids of rows to sync.
 */
export async function reconcileCampaignCountryPrices(
  db: Database,
  campaignId: string,
  campaign: CampaignForPrices | null,
): Promise<string[]> {
  let provider: string | null = null;
  if (campaign?.integrationId) {
    const [integration] = await db
      .select({ provider: integrations.provider })
      .from(integrations)
      .where(and(eq(integrations.id, campaign.integrationId), eq(integrations.organizationId, campaign.organizationId)))
      .limit(1);
    provider = integration?.provider ?? null;
  }
  const keep = campaign && wantsCountryPrices(campaign, provider) ? campaign.providerProductId! : null;
  const now = new Date();

  const rows = await db
    .select({ id: campaignCountryPrices.id, providerProductId: campaignCountryPrices.providerProductId, wanted: campaignCountryPrices.wanted })
    .from(campaignCountryPrices)
    .where(eq(campaignCountryPrices.campaignId, campaignId));
  const touched: string[] = [];
  for (const row of rows) {
    const wanted = row.providerProductId === keep ? "prices" : "none";
    if (row.wanted !== wanted) {
      await db.update(campaignCountryPrices).set({ wanted, updatedAt: now }).where(eq(campaignCountryPrices.id, row.id));
    }
    touched.push(row.id);
  }
  if (keep && campaign && !rows.some((r) => r.providerProductId === keep)) {
    const id = ulid();
    await db.insert(campaignCountryPrices).values({
      id,
      campaignId,
      organizationId: campaign.organizationId,
      integrationId: campaign.integrationId!,
      environment: campaign.environment === "test" ? "test" : "live",
      providerProductId: keep,
      wanted: "prices",
    });
    touched.push(id);
  }
  return touched;
}

/** Another campaign of the workspace already prices this Dodo product. */
export async function productTakenByAnotherCampaign(
  db: Database,
  input: { organizationId: string; campaignId: string | null; integrationId: string; providerProductId: string },
): Promise<boolean> {
  const [row] = await db
    .select({ id: campaignCountryPrices.id })
    .from(campaignCountryPrices)
    .where(
      and(
        eq(campaignCountryPrices.organizationId, input.organizationId),
        eq(campaignCountryPrices.integrationId, input.integrationId),
        eq(campaignCountryPrices.providerProductId, input.providerProductId),
        eq(campaignCountryPrices.wanted, "prices"),
        input.campaignId ? ne(campaignCountryPrices.campaignId, input.campaignId) : sql`true`,
      ),
    )
    .limit(1);
  return !!row;
}

// ── The prices ──────────────────────────────────────────────────────────────

/**
 * Every discounted country's price for a campaign: its discounts as the banner
 * document holds them, priced with countryCharge (charm-rounded down, so the
 * stated discount is never more than the real one).
 */
export async function campaignCountryPriceTable(
  db: Database,
  env: CountryPriceEnv,
  campaign: Pick<typeof campaigns.$inferSelect, "id" | "organizationId">,
  now: number = Date.now(),
): Promise<{ ok: true; rows: CountryPriceRow[]; basePrice: number; currency: string } | { ok: false; problem: string }> {
  const doc = await buildBannerDocNow(db, campaign.organizationId, env);
  if (!doc) return { ok: false, problem: "The workspace has no public key. Create one under Settings, API keys." };
  const served = Object.hasOwn(doc.campaigns, campaign.id) ? doc.campaigns[campaign.id]! : null;
  if (!served) return { ok: false, problem: "The campaign isn't being served. It must be active and set on a product." };
  const { pricing } = served;
  const fx = fxDisabled(env) ? null : await loadFxRates(env.CACHE, now);
  const excluded = parseExcludedCurrencies(env.FX_EXCLUDED_CURRENCIES);
  const rows: CountryPriceRow[] = [];
  for (const [country, info] of Object.entries(served.countries).sort(([a], [b]) => a.localeCompare(b))) {
    const local = localPricing({
      basePrice: pricing.basePrice,
      baseCurrency: pricing.currency,
      discountPercent: info.discount,
      country,
      strategy: pricing.charm,
      fx,
      now,
      excludedCurrencies: excluded,
    });
    const charge = countryCharge({
      basePrice: pricing.basePrice,
      baseCurrency: pricing.currency,
      discount: info.discount,
      local,
      strategy: pricing.charm,
    });
    if (charge) rows.push({ country, countryName: COUNTRY_NAMES[country] ?? info.countryName ?? country, discount: info.discount, charge });
  }
  return { ok: true, rows, basePrice: pricing.basePrice, currency: pricing.currency };
}

// ── Syncing one row ─────────────────────────────────────────────────────────

async function dodoForRow(
  db: Database,
  env: CountryPriceEnv,
  row: Pick<CountryPriceRowRecord, "integrationId" | "organizationId" | "environment">,
): Promise<{ ok: true; request: DodoRequest } | { ok: false; problem: string; missingIntegration?: true }> {
  const [integration] = await db
    .select()
    .from(integrations)
    .where(and(eq(integrations.id, row.integrationId), eq(integrations.organizationId, row.organizationId)))
    .limit(1);
  if (!integration) {
    return { ok: false, problem: "The Dodo Payments integration was removed. Reconnect it to manage these prices.", missingIntegration: true };
  }
  if (!COUNTRY_PRICE_PROVIDERS.has(integration.provider)) return { ok: false, problem: "The campaign's payment platform can't set country prices." };
  const environment = row.environment === "test" ? "test" : "live";
  const enc = accessTokenEncFor(integration, environment);
  if (!enc) return { ok: false, problem: `There is no ${environment} Dodo key. Connect one under Integrations.` };
  const apiKey = await decrypt(enc, tokenEncryptionSecret(env));
  return { ok: true, request: dodoRequester(environment === "test" ? DODO_API_BASE.test : DODO_API_BASE.live, apiKey) };
}

export type CountryPriceSyncResult =
  | { outcome: "synced"; record: CountryPriceSyncRecord; removed: boolean }
  | { outcome: "problem"; problem: string };

/**
 * One batch for one row: bring the product's rules in line with the campaign
 * (wanted 'prices') or remove them (wanted 'none'). Records the outcome and
 * what Dodo charges on the row; deletes the row once a removal is complete.
 * Rebuilds the workspace's banner document when the published prices changed.
 */
export async function syncCountryPriceRow(
  db: Database,
  env: CountryPriceEnv,
  rowId: string,
  opts: { budget: number; trigger: CountryPriceSyncRecord["trigger"]; now?: number },
): Promise<CountryPriceSyncResult> {
  const now = opts.now ?? Date.now();
  const [row] = await db.select().from(campaignCountryPrices).where(eq(campaignCountryPrices.id, rowId)).limit(1);
  if (!row) return { outcome: "problem", problem: "Nothing to sync." };

  const fail = async (problem: string): Promise<CountryPriceSyncResult> => {
    const record: CountryPriceSyncRecord = {
      at: new Date(now).toISOString(),
      trigger: opts.trigger,
      created: 0,
      updated: 0,
      archived: 0,
      failures: [],
      remaining: row.remaining,
      problem,
    };
    await db
      .update(campaignCountryPrices)
      .set({ lastSync: record, syncedAt: new Date(now), updatedAt: new Date(now) })
      .where(eq(campaignCountryPrices.id, row.id));
    return { outcome: "problem", problem };
  };

  // Never verified means GoPayLocal never wrote a rule on this product: there
  // is nothing of ours to remove, and whatever is there is the merchant's.
  if (row.wanted === "none" && !row.verifiedAt) {
    await db.delete(campaignCountryPrices).where(eq(campaignCountryPrices.id, row.id));
    return {
      outcome: "synced",
      removed: true,
      record: { at: new Date(now).toISOString(), trigger: opts.trigger, created: 0, updated: 0, archived: 0, failures: [], remaining: 0 },
    };
  }

  const dodo = await dodoForRow(db, env, row);
  if (!dodo.ok) {
    // Prices to remove with no integration left to remove them with: nothing
    // more GoPayLocal can do (removing the integration removes them first).
    if (row.wanted === "none" && dodo.missingIntegration) {
      await db.delete(campaignCountryPrices).where(eq(campaignCountryPrices.id, row.id));
      console.error(`[country-prices] integration gone, prices left at Dodo for campaign ${row.campaignId}`);
      return { outcome: "problem", problem: dodo.problem };
    }
    return fail(dodo.problem);
  }

  let rows: CountryPriceRow[] = [];
  let check: ((body: unknown) => string | null) | undefined;
  if (row.wanted === "prices") {
    const [campaign] = await db
      .select({ id: campaigns.id, organizationId: campaigns.organizationId, productId: campaigns.productId })
      .from(campaigns)
      .where(eq(campaigns.id, row.campaignId))
      .limit(1);
    if (!campaign) return fail("The campaign no longer exists.");
    const [product] = await db
      .select({ basePrice: products.basePrice, currency: products.currency })
      .from(products)
      .where(eq(products.id, campaign.productId))
      .limit(1);
    if (!product) return fail("The campaign's product no longer exists.");
    const table = await campaignCountryPriceTable(db, env, campaign, now);
    if (!table.ok) return fail(table.problem);
    rows = table.rows;
    check = (body) => dodoProductProblem(body, product);
  }

  // Only rules GoPayLocal wrote may be removed: the countries it published a
  // discount for. A rule the merchant added later is left alone.
  const owned = ownedCountries(row.published);
  const applied = await applyCountryPrices(dodo.request, row.providerProductId, rows, {
    budget: opts.budget,
    label: "the Dodo product",
    check,
    checkRules: row.verifiedAt ? undefined : existingRulesProblem,
    beforeWrite: row.verifiedAt
      ? undefined
      : async () => {
          await db.update(campaignCountryPrices).set({ verifiedAt: new Date(now) }).where(eq(campaignCountryPrices.id, row.id));
        },
    mayArchive: (rule) => {
      const country = ruleCountry(rule);
      return !!country && owned.has(country);
    },
    ensureByCountry: row.wanted === "prices",
  });
  if (!applied.ok) {
    // A product deleted in Dodo has no prices left to remove.
    if (row.wanted === "none" && applied.status === 404) {
      await db.delete(campaignCountryPrices).where(eq(campaignCountryPrices.id, row.id));
      return {
        outcome: "synced",
        removed: true,
        record: { at: new Date(now).toISOString(), trigger: opts.trigger, created: 0, updated: 0, archived: 0, failures: [], remaining: 0 },
      };
    }
    return fail(applied.problem);
  }
  const { result } = applied;
  const record: CountryPriceSyncRecord = {
    at: new Date(now).toISOString(),
    trigger: opts.trigger,
    created: result.created,
    updated: result.updated,
    archived: result.archived,
    failures: result.failures,
    remaining: result.remaining,
  };

  if (row.wanted === "none" && result.remaining === 0 && result.failures.length === 0) {
    await db.delete(campaignCountryPrices).where(eq(campaignCountryPrices.id, row.id));
    if (row.published && Object.keys(row.published).length > 0) await rebuildBanner(db, env, row.organizationId);
    return { outcome: "synced", record, removed: true };
  }

  // A removal still in progress keeps its own rules listed (rows is empty, so
  // each keeps the discount it was written for) for the next batch to remove.
  const published: Record<string, PublishedPrice> = publishedPrices(result.rulesAfter, rows, row.published ?? null);
  await db
    .update(campaignCountryPrices)
    .set({
      published,
      lastSync: record,
      remaining: result.remaining,
      syncedAt: new Date(now),
      updatedAt: new Date(now),
    })
    .where(eq(campaignCountryPrices.id, row.id));
  if (JSON.stringify(published) !== JSON.stringify(row.published ?? {})) await rebuildBanner(db, env, row.organizationId);
  return { outcome: "synced", record, removed: false };
}

async function rebuildBanner(db: Database, env: CountryPriceEnv, organizationId: string): Promise<void> {
  try {
    await pushBannerConfigForOrg(db, env.CACHE, organizationId, env);
  } catch (err) {
    console.error("[country-prices] banner rebuild failed:", err instanceof Error ? err.message : String(err));
  }
}

/** Sync a campaign's rows after a change, within one budget. */
export async function syncCampaignCountryPrices(db: Database, env: CountryPriceEnv, rowIds: readonly string[]): Promise<void> {
  let budget = CHANGE_SYNC_BUDGET;
  for (const id of rowIds) {
    if (budget < 3) break;
    const result = await syncCountryPriceRow(db, env, id, { budget, trigger: "change" });
    if (result.outcome === "synced") {
      budget -= 3 + result.record.created + result.record.updated + result.record.archived + result.record.failures.length;
    } else budget -= 1;
  }
}

// ── The scheduled job ───────────────────────────────────────────────────────

/**
 * Rows the 10-minute job should sync, oldest first: removals, unfinished
 * batches, and prices last synced over 6 hours ago (exchange rates moved).
 */
export async function dueCountryPriceRows(db: Database, now: number, limit: number): Promise<string[]> {
  const rows = await db
    .select({ id: campaignCountryPrices.id })
    .from(campaignCountryPrices)
    .where(
      or(
        eq(campaignCountryPrices.wanted, "none"),
        sql`${campaignCountryPrices.remaining} > 0`,
        isNull(campaignCountryPrices.syncedAt),
        lt(campaignCountryPrices.syncedAt, new Date(now - COUNTRY_PRICE_RESYNC_MS)),
      ),
    )
    .orderBy(sql`${campaignCountryPrices.syncedAt} asc nulls first`, asc(campaignCountryPrices.id))
    .limit(limit);
  return rows.map((r) => r.id);
}

export async function runScheduledCountryPriceSync(db: Database, env: CountryPriceEnv, scheduledTime: number): Promise<void> {
  let budget = SCHEDULED_SYNC_BUDGET;
  for (const id of await dueCountryPriceRows(db, scheduledTime, 5)) {
    if (budget < 3) break;
    const result = await syncCountryPriceRow(db, env, id, { budget, trigger: "schedule", now: scheduledTime });
    if (result.outcome === "synced") {
      budget -= 3 + result.record.created + result.record.updated + result.record.archived + result.record.failures.length;
    } else {
      budget -= 1;
      console.error("[country-prices] scheduled sync:", result.problem);
    }
  }
}
