/**
 * Regional prices for Pro on the hosted service.
 *
 * The hosted service prices Pro with its own product: a campaign in the "house"
 * workspace (an internal workspace, chosen in the admin) holds the country
 * discounts, capped by the campaign's maximum discount. The price page and the
 * dashboard's Billing page show each visitor the price Dodo Payments charges in
 * their country: per-country prices ("Localized Pricing" rules on the Pro
 * product) that this module writes from that campaign, and records after every
 * sync for `GET /v1/pricing/pro` to serve. The pages can therefore never show a
 * price that Dodo doesn't charge, even between an exchange-rate refresh and the
 * sync that follows it. The house campaign has no payment platform, so it never
 * creates discount codes: the price itself is lower, nothing is entered at
 * checkout, and Dodo's own PPP setting must stay off (it would apply on top).
 *
 * The amounts come from regionalCharge (packages/shared), applied to the banner
 * document the config endpoint serves and the same exchange rates.
 *
 * Writes are batched: a sync makes at most `budget` Dodo calls and reports what
 * is left, so it fits the Workers Free subrequest limit. The admin's "Push to
 * Dodo" repeats it until nothing is left; the scheduled job runs it after each
 * exchange-rate refresh and keeps going on later runs while work remains.
 *
 * Not used on self-hosted deployments (there is no billing).
 */

import { eq } from "drizzle-orm";
import type { Bindings } from "../bindings";
import type { Database } from "../db";
import { campaigns, internalOrganizations, platformSettings } from "../db/schema";
import { COUNTRY_NAMES, PLAN_PRICES_USD } from "@gopaylocal/shared/constants";
import { localPricing } from "@gopaylocal/shared/currency";
import { isSelfHosted } from "../lib/entitlements";
import { buildBannerDocNow } from "./banner-cache.service";
import {
  applyCountryPrices,
  countryCharge,
  DODO_API_BASE,
  dodoRequester,
  listDodoRules as listRulesOf,
  publishedPrices,
  type CountryPriceRow,
  type DodoRule,
  type PublishedPrice,
} from "./dodo-country-prices";
import { loadFxRates, parseExcludedCurrencies } from "./fx-cache";
import { fxDisabled } from "./fx-refresh.service";

// The shared Dodo pieces, under the names the admin routes and tests use.
export {
  chargedLocalPrice,
  compareWithDodo,
  countryCharge as houseCharge,
  dodoErrorMessage,
  planDodoSync,
  publishedPrices,
  type DodoAction,
  type DodoMatch,
  type DodoRule,
} from "./dodo-country-prices";

export const HOUSE_PRICING_KEY = "house_pricing";

/** What the last sync did. */
export interface HouseSyncRecord {
  at: string;
  trigger: "admin" | "schedule";
  environment: "test_mode" | "live_mode";
  productId: string;
  created: number;
  updated: number;
  archived: number;
  failures: Array<{ country: string | null; status: number; message: string }>;
  /** Changes still to make; the scheduled job keeps going while this is above 0. */
  remaining: number;
}

/** One country's price as Dodo charges it after the last sync. */
export type HousePublishedPrice = PublishedPrice;

/** What Dodo charges per country, recorded after every sync. */
export interface HousePublished {
  at: string;
  environment: "test_mode" | "live_mode";
  productId: string;
  prices: Record<string, HousePublishedPrice>;
}

export interface HouseSettings {
  organizationId: string;
  campaignId: string;
  lastSync?: HouseSyncRecord;
  published?: HousePublished;
}

type HouseEnv = Pick<
  Bindings,
  "DODO_API_KEY" | "DODO_ENVIRONMENT" | "DODO_PRICE_ID_PRO_MONTHLY" | "SELF_HOSTED" | "CACHE" | "FX_RATES_URL" | "FX_EXCLUDED_CURRENCIES"
>;

// ── Settings ────────────────────────────────────────────────────────────────

export async function loadHouseSettings(db: Database): Promise<HouseSettings | null> {
  const [row] = await db
    .select({ value: platformSettings.value })
    .from(platformSettings)
    .where(eq(platformSettings.key, HOUSE_PRICING_KEY))
    .limit(1);
  const v = row?.value as Partial<HouseSettings> | undefined;
  if (!v || typeof v.organizationId !== "string" || typeof v.campaignId !== "string") return null;
  return { organizationId: v.organizationId, campaignId: v.campaignId, lastSync: v.lastSync, published: v.published };
}

export async function saveHouseSettings(db: Database, settings: HouseSettings, userId: string | null): Promise<void> {
  const value = settings as unknown as Record<string, unknown>;
  await db
    .insert(platformSettings)
    .values({ key: HOUSE_PRICING_KEY, value, updatedByUserId: userId, updatedAt: new Date() })
    .onConflictDoUpdate({ target: platformSettings.key, set: { value, updatedByUserId: userId, updatedAt: new Date() } });
}

// ── The price table ─────────────────────────────────────────────────────────

export type HousePriceRow = CountryPriceRow;

export type HousePriceTable =
  | {
      ok: true;
      basePrice: number;
      currency: string;
      charm: string;
      /** Date of the exchange rates the local prices use; null when none were usable. */
      fxAsOf: string | null;
      rows: HousePriceRow[];
    }
  | { ok: false; problem: string };

/** Every discounted country's price, as the house sync writes it to Dodo. */
export async function houseRegionalPrices(
  db: Database,
  env: HouseEnv,
  settings: Pick<HouseSettings, "organizationId" | "campaignId">,
  now: number = Date.now(),
): Promise<HousePriceTable> {
  // Re-checked on every read and every sync, not only when the campaign was
  // picked: a payment platform connected since would put codes on top of the
  // per-country price, and a workspace no longer internal would be counted.
  const [row] = await db
    .select({
      organizationId: campaigns.organizationId,
      integrationId: campaigns.integrationId,
      internal: internalOrganizations.organizationId,
    })
    .from(campaigns)
    .leftJoin(internalOrganizations, eq(internalOrganizations.organizationId, campaigns.organizationId))
    .where(eq(campaigns.id, settings.campaignId))
    .limit(1);
  if (!row || row.organizationId !== settings.organizationId) {
    return { ok: false, problem: "The house campaign no longer exists. Pick another one." };
  }
  if (!row.internal) return { ok: false, problem: "The house workspace is no longer internal. Mark it internal again." };
  if (row.integrationId) {
    return {
      ok: false,
      problem:
        "The house campaign has a payment platform connected, so its banner would offer codes on top of the per-country price. Disconnect it from the campaign.",
    };
  }

  const doc = await buildBannerDocNow(db, settings.organizationId, env);
  if (!doc) return { ok: false, problem: "The house workspace has no public key. Create one under Settings → API keys." };
  const campaign = Object.hasOwn(doc.campaigns, settings.campaignId) ? doc.campaigns[settings.campaignId]! : null;
  if (!campaign) {
    return { ok: false, problem: "The house campaign isn't being served. It must be active and set on a product." };
  }
  if (campaign.environment !== "live") return { ok: false, problem: "The house campaign is in test mode. Use a live campaign." };
  const { pricing } = campaign;
  const proPrice = PLAN_PRICES_USD.pro.month;
  if (pricing.currency !== "USD" || pricing.basePrice !== proPrice) {
    return {
      ok: false,
      problem: `The house product must cost ${proPrice} USD, the Pro price. It costs ${pricing.basePrice} ${pricing.currency}.`,
    };
  }

  const fx = fxDisabled(env) ? null : await loadFxRates(env.CACHE, now);
  const excluded = parseExcludedCurrencies(env.FX_EXCLUDED_CURRENCIES);
  let fxAsOf: string | null = null;
  const rows: HousePriceRow[] = [];
  for (const [country, info] of Object.entries(campaign.countries).sort(([a], [b]) => a.localeCompare(b))) {
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
    if (local?.fxAsOf) fxAsOf = local.fxAsOf;
    const charge = countryCharge({
      basePrice: pricing.basePrice,
      baseCurrency: pricing.currency,
      discount: info.discount,
      local,
      strategy: pricing.charm,
    });
    if (charge) rows.push({ country, countryName: COUNTRY_NAMES[country] ?? info.countryName ?? country, discount: info.discount, charge });
  }
  return { ok: true, basePrice: pricing.basePrice, currency: pricing.currency, charm: pricing.charm, fxAsOf, rows };
}

// ── Dodo ────────────────────────────────────────────────────────────────────

export function dodoMode(env: Pick<Bindings, "DODO_ENVIRONMENT">): "test_mode" | "live_mode" {
  return env.DODO_ENVIRONMENT === "test_mode" ? "test_mode" : "live_mode";
}

function houseDodo(env: HouseEnv) {
  return dodoRequester(dodoMode(env) === "test_mode" ? DODO_API_BASE.test : DODO_API_BASE.live, env.DODO_API_KEY ?? "");
}

/** The Pro product's per-country prices at Dodo. */
export async function listDodoRules(env: HouseEnv): Promise<{ ok: true; rules: DodoRule[] } | { ok: false; message: string }> {
  return listRulesOf(houseDodo(env), env.DODO_PRICE_ID_PRO_MONTHLY ?? "");
}

/** The published price for a country, if it was recorded for the Dodo mode and product in use now. */
export function publishedPriceFor(
  published: HousePublished | undefined | null,
  env: Pick<Bindings, "DODO_ENVIRONMENT" | "DODO_PRICE_ID_PRO_MONTHLY">,
  country: string,
): HousePublishedPrice | null {
  if (!published || published.environment !== dodoMode(env) || published.productId !== env.DODO_PRICE_ID_PRO_MONTHLY) return null;
  return Object.hasOwn(published.prices, country) ? published.prices[country]! : null;
}

export type HouseSyncResult =
  | { outcome: "skipped"; reason: string }
  | { outcome: "problem"; problem: string }
  | { outcome: "synced"; record: HouseSyncRecord };

/** Why the hosted Pro price can't be synced on this deployment, or null. */
export function houseSyncUnavailable(env: HouseEnv): string | null {
  if (isSelfHosted(env)) return "Self-hosted deployments have no billing.";
  if (!env.DODO_API_KEY || !env.DODO_PRICE_ID_PRO_MONTHLY) return "Dodo Payments isn't set up on this deployment.";
  return null;
}

/**
 * One batch: make the Pro product per-country priced if it isn't, then apply
 * planDodoSync's changes until `budget` calls are spent. Records the outcome on
 * the settings row.
 */
export async function syncHousePrices(
  db: Database,
  env: HouseEnv,
  opts: { budget: number; trigger: HouseSyncRecord["trigger"]; userId?: string | null; now?: number },
): Promise<HouseSyncResult> {
  const unavailable = houseSyncUnavailable(env);
  if (unavailable) return { outcome: "skipped", reason: unavailable };
  const settings = await loadHouseSettings(db);
  if (!settings) return { outcome: "skipped", reason: "No house campaign is set." };

  const table = await houseRegionalPrices(db, env, settings, opts.now);
  if (!table.ok) return { outcome: "problem", problem: table.problem };

  const productId = env.DODO_PRICE_ID_PRO_MONTHLY!;
  const applied = await applyCountryPrices(houseDodo(env), productId, table.rows, { budget: opts.budget, label: "the Pro product" });
  if (!applied.ok) return { outcome: "problem", problem: applied.problem };
  const { result } = applied;

  const record: HouseSyncRecord = {
    at: new Date(opts.now ?? Date.now()).toISOString(),
    trigger: opts.trigger,
    environment: dodoMode(env),
    productId,
    created: result.created,
    updated: result.updated,
    archived: result.archived,
    failures: result.failures,
    remaining: result.remaining,
  };
  const previous =
    settings.published && settings.published.environment === record.environment && settings.published.productId === record.productId
      ? settings.published.prices
      : null;
  const published: HousePublished = {
    at: record.at,
    environment: record.environment,
    productId: record.productId,
    prices: publishedPrices(result.rulesAfter, table.rows, previous),
  };
  await saveHouseSettings(db, { ...settings, lastSync: record, published }, opts.userId ?? null);
  return { outcome: "synced", record };
}

/** FX rates refresh at :40 every 6 hours; sync in the first run after the config endpoint's caches have caught up. */
export function isHouseSyncRun(scheduledTime: number): boolean {
  const d = new Date(scheduledTime);
  return d.getUTCHours() % 6 === 1 && d.getUTCMinutes() < 10;
}

/** The 10-minute job: sync after each rate refresh, and keep going while the last sync left work. */
export async function runScheduledHouseSync(db: Database, env: HouseEnv, scheduledTime: number): Promise<void> {
  if (houseSyncUnavailable(env)) return;
  const settings = await loadHouseSettings(db);
  if (!settings) return;
  if (!isHouseSyncRun(scheduledTime) && !(settings.lastSync && settings.lastSync.remaining > 0)) return;
  const result = await syncHousePrices(db, env, { budget: 12, trigger: "schedule", now: scheduledTime });
  if (result.outcome === "problem") console.error("House pricing sync:", result.problem);
}
