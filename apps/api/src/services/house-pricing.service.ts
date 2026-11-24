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
import { localPricing, regionalCharge, type RegionalCharge } from "@gopaylocal/shared/currency";
import { isSelfHosted } from "../lib/entitlements";
import { buildBannerDocNow } from "./banner-cache.service";
import { loadFxRates, parseExcludedCurrencies } from "./fx-cache";
import { fxDisabled } from "./fx-refresh.service";

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
export interface HousePublishedPrice {
  currency: string;
  /** Minor units, as Dodo stores it. */
  minorAmount: number;
  /** The discount this amount was written for; null for a price this module didn't write. */
  discount: number | null;
}

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

export interface HousePriceRow {
  country: string;
  countryName: string;
  discount: number;
  charge: RegionalCharge;
}

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

/** Every discounted country's price, exactly as the config endpoint serves it now. */
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
    const charge = regionalCharge({
      basePrice: pricing.basePrice,
      baseCurrency: pricing.currency,
      discount: info.discount,
      local: local ? { currencyCode: local.currencyCode, localPrice: local.localPrice } : null,
    });
    if (charge) rows.push({ country, countryName: COUNTRY_NAMES[country] ?? info.countryName ?? country, discount: info.discount, charge });
  }
  return { ok: true, basePrice: pricing.basePrice, currency: pricing.currency, charm: pricing.charm, fxAsOf, rows };
}

// ── Dodo ────────────────────────────────────────────────────────────────────

/** A Localized Pricing rule as Dodo lists it. */
export interface DodoRule {
  id: string;
  country_code?: string | null;
  currency: string;
  amount: number;
}

interface DodoReply {
  ok: boolean;
  status: number;
  body: unknown;
}

export function dodoMode(env: Pick<Bindings, "DODO_ENVIRONMENT">): "test_mode" | "live_mode" {
  return env.DODO_ENVIRONMENT === "test_mode" ? "test_mode" : "live_mode";
}

function dodoBase(env: Pick<Bindings, "DODO_ENVIRONMENT">): string {
  return dodoMode(env) === "test_mode" ? "https://test.dodopayments.com" : "https://live.dodopayments.com";
}

async function dodo(env: HouseEnv, method: string, path: string, body?: unknown): Promise<DodoReply> {
  const res = await fetch(`${dodoBase(env)}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${env.DODO_API_KEY}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  return { ok: res.ok, status: res.status, body: parsed };
}

/** A short, one-line description of a refused Dodo call. */
export function dodoErrorMessage(reply: Pick<DodoReply, "status" | "body">): string {
  const b = reply.body as { message?: unknown; code?: unknown } | string | null;
  const raw =
    typeof b === "string" ? b : b && typeof b.message === "string" ? b.message : b && typeof b.code === "string" ? b.code : "";
  const line = raw.replace(/\s+/g, " ").trim().slice(0, 200);
  return line ? `Dodo answered ${reply.status}: ${line}` : `Dodo answered ${reply.status}`;
}

function rulesOf(body: unknown): DodoRule[] {
  const items = (body as { items?: unknown } | null)?.items;
  if (!Array.isArray(items)) return [];
  return items.filter(
    (r): r is DodoRule =>
      !!r && typeof r === "object" && typeof (r as DodoRule).id === "string" && typeof (r as DodoRule).currency === "string" && typeof (r as DodoRule).amount === "number",
  );
}

function productPath(env: HouseEnv): string {
  return `/products/${encodeURIComponent(env.DODO_PRICE_ID_PRO_MONTHLY ?? "")}`;
}

export async function listDodoRules(env: HouseEnv): Promise<{ ok: true; rules: DodoRule[] } | { ok: false; message: string }> {
  const reply = await dodo(env, "GET", `${productPath(env)}/localized-prices`);
  return reply.ok ? { ok: true, rules: rulesOf(reply.body) } : { ok: false, message: dodoErrorMessage(reply) };
}

// ── Comparing and syncing ───────────────────────────────────────────────────

export type DodoAction =
  | { kind: "create"; country: string; currency: string; amount: number }
  | { kind: "update"; ruleId: string; country: string; currency: string; amount: number; from: number }
  /** Dodo can't change a rule's currency: archive it and create a new one. */
  | { kind: "replace"; ruleId: string; country: string; currency: string; amount: number }
  | { kind: "archive"; ruleId: string; country: string | null };

const actionCost = (a: DodoAction): number => (a.kind === "replace" ? 2 : 1);

const ruleCountry = (r: DodoRule): string | null =>
  typeof r.country_code === "string" && r.country_code ? r.country_code.toUpperCase() : null;

/**
 * The Dodo calls that make the rules match the table: one rule per discounted
 * country with its amount; no rule for any other country, and none without a
 * country (left from a per-currency setup). Changes to existing rules first,
 * then new rules, then removals.
 */
export function planDodoSync(rows: readonly HousePriceRow[], rules: readonly DodoRule[]): DodoAction[] {
  const wanted = new Map(rows.map((r) => [r.country, r]));
  const seen = new Set<string>();
  const changes: DodoAction[] = [];
  const archives: DodoAction[] = [];
  for (const rule of rules) {
    const country = ruleCountry(rule);
    const row = country ? wanted.get(country) : undefined;
    if (!country || !row || seen.has(country)) {
      archives.push({ kind: "archive", ruleId: rule.id, country });
      continue;
    }
    seen.add(country);
    const { currency, minorAmount } = row.charge;
    if (rule.currency.toUpperCase() !== currency) {
      changes.push({ kind: "replace", ruleId: rule.id, country, currency, amount: minorAmount });
    } else if (rule.amount !== minorAmount) {
      changes.push({ kind: "update", ruleId: rule.id, country, currency, amount: minorAmount, from: rule.amount });
    }
  }
  const creates: DodoAction[] = rows
    .filter((r) => !seen.has(r.country))
    .map((r) => ({ kind: "create", country: r.country, currency: r.charge.currency, amount: r.charge.minorAmount }));
  return [...changes, ...creates, ...archives];
}

export type DodoMatch =
  | { status: "match" }
  | { status: "missing" }
  | { status: "differs"; currency: string; amount: number };

/** Per country of the table: whether Dodo charges the same. */
export function compareWithDodo(rows: readonly HousePriceRow[], rules: readonly DodoRule[]): {
  byCountry: Record<string, DodoMatch>;
  extraRules: number;
} {
  const byRuleCountry = new Map<string, DodoRule>();
  let extraRules = 0;
  for (const rule of rules) {
    const c = ruleCountry(rule);
    if (!c || byRuleCountry.has(c)) extraRules++;
    else byRuleCountry.set(c, rule);
  }
  const byCountry: Record<string, DodoMatch> = {};
  const wanted = new Set<string>();
  for (const row of rows) {
    wanted.add(row.country);
    const rule = byRuleCountry.get(row.country);
    if (!rule) byCountry[row.country] = { status: "missing" };
    else if (rule.currency.toUpperCase() !== row.charge.currency || rule.amount !== row.charge.minorAmount) {
      byCountry[row.country] = { status: "differs", currency: rule.currency.toUpperCase(), amount: rule.amount };
    } else byCountry[row.country] = { status: "match" };
  }
  for (const c of byRuleCountry.keys()) if (!wanted.has(c)) extraRules++;
  return { byCountry, extraRules };
}

/**
 * Dodo's per-country prices as a published list: one entry per country that has
 * a rule. The discount comes from the table row when the rule has the row's
 * amount (just written, or already right), else from the previous list when
 * the amount is unchanged, else null.
 */
export function publishedPrices(
  rules: readonly DodoRule[],
  rows: readonly HousePriceRow[],
  previous: HousePublished["prices"] | null,
): HousePublished["prices"] {
  const byCountry = new Map(rows.map((r) => [r.country, r]));
  const prices: HousePublished["prices"] = {};
  for (const rule of rules) {
    const country = ruleCountry(rule);
    if (!country || Object.hasOwn(prices, country)) continue;
    const currency = rule.currency.toUpperCase();
    const row = byCountry.get(country);
    const before = previous && Object.hasOwn(previous, country) ? previous[country]! : null;
    const discount =
      row && row.charge.currency === currency && row.charge.minorAmount === rule.amount
        ? row.discount
        : before && before.currency === currency && before.minorAmount === rule.amount
          ? before.discount
          : null;
    prices[country] = { currency, minorAmount: rule.amount, discount };
  }
  return prices;
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

  let calls = 0;
  const product = await dodo(env, "GET", productPath(env));
  calls++;
  if (!product.ok) return { outcome: "problem", problem: `Couldn't read the Pro product. ${dodoErrorMessage(product)}` };
  if ((product.body as { pricing_mode?: unknown } | null)?.pricing_mode !== "by_country") {
    const set = await dodo(env, "PATCH", productPath(env), { pricing_mode: "by_country" });
    calls++;
    if (!set.ok) return { outcome: "problem", problem: `Couldn't switch the Pro product to per-country prices. ${dodoErrorMessage(set)}` };
  }
  const listed = await dodo(env, "GET", `${productPath(env)}/localized-prices`);
  calls++;
  if (!listed.ok) return { outcome: "problem", problem: `Couldn't list the Pro product's prices. ${dodoErrorMessage(listed)}` };

  const rulesBefore = rulesOf(listed.body);
  const actions = planDodoSync(table.rows, rulesBefore);
  // Dodo's rules as each call leaves them, for the published list.
  const after = new Map<string, DodoRule>();
  for (const rule of rulesBefore) {
    const country = ruleCountry(rule);
    if (country && !after.has(country)) after.set(country, rule);
  }
  const record: HouseSyncRecord = {
    at: new Date(opts.now ?? Date.now()).toISOString(),
    trigger: opts.trigger,
    environment: dodoMode(env),
    productId: env.DODO_PRICE_ID_PRO_MONTHLY!,
    created: 0,
    updated: 0,
    archived: 0,
    failures: [],
    remaining: 0,
  };
  const rulesPath = `${productPath(env)}/localized-prices`;
  let done = 0;
  for (const action of actions) {
    if (calls + actionCost(action) > opts.budget) break;
    done++;
    calls += actionCost(action);
    const fail = (reply: DodoReply) =>
      record.failures.push({ country: action.country, status: reply.status, message: dodoErrorMessage(reply) });
    if (action.kind === "archive" || action.kind === "replace") {
      const reply = await dodo(env, "DELETE", `${rulesPath}/${encodeURIComponent(action.ruleId)}`);
      if (!reply.ok) {
        fail(reply);
        continue;
      }
      if (action.country && after.get(action.country)?.id === action.ruleId) after.delete(action.country);
      if (action.kind === "archive") {
        record.archived++;
        continue;
      }
    }
    if (action.kind === "update") {
      const reply = await dodo(env, "PATCH", `${rulesPath}/${encodeURIComponent(action.ruleId)}`, { amount: action.amount });
      if (reply.ok) {
        record.updated++;
        after.set(action.country, { id: action.ruleId, country_code: action.country, currency: action.currency, amount: action.amount });
      } else fail(reply);
      continue;
    }
    // create, or the second half of replace
    const reply = await dodo(env, "POST", rulesPath, {
      currency: action.currency,
      country_code: action.country,
      amount: action.amount,
    });
    if (!reply.ok) {
      fail(reply);
      continue;
    }
    if (action.kind === "replace") record.updated++;
    else record.created++;
    const id = typeof (reply.body as { id?: unknown } | null)?.id === "string" ? (reply.body as { id: string }).id : "";
    after.set(action.country, { id, country_code: action.country, currency: action.currency, amount: action.amount });
  }
  record.remaining = actions.length - done;
  record.failures = record.failures.slice(0, 20);
  const previous =
    settings.published && settings.published.environment === record.environment && settings.published.productId === record.productId
      ? settings.published.prices
      : null;
  const published: HousePublished = {
    at: record.at,
    environment: record.environment,
    productId: record.productId,
    prices: publishedPrices([...after.values()], table.rows, previous),
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
