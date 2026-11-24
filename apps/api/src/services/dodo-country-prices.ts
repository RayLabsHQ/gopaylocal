/**
 * Per-country prices on a Dodo Payments product ("Localized Pricing" rules,
 * pricing_mode "by_country"): what to charge each country, and making Dodo's
 * rules match.
 *
 * Shared by the hosted Pro price (house-pricing.service.ts, with the Worker's
 * own key) and by merchant campaigns that let Dodo charge the country price
 * instead of handing out codes (with the merchant's key). A rule that matches
 * the buyer's billing country is charged exactly, with Dodo's PPP and Charm
 * Pricing skipped for it, so the price written here is the price checkout
 * charges.
 *
 * Writes are batched: applyCountryPrices makes at most `budget` Dodo calls and
 * reports what is left, so a sync fits the Workers subrequest limit and the
 * caller carries on in a later run.
 */

import {
  charm,
  DODO_MIN_SUBSCRIPTION_USD,
  minorUnitExponent,
  regionalCharge,
  type CharmStrategy,
  type LocalPricing,
  type RegionalCharge,
} from "@gopaylocal/shared/currency";

// ── What each country is charged ────────────────────────────────────────────

/** One discounted country and what Dodo is told to charge it. */
export interface CountryPriceRow {
  country: string;
  countryName: string;
  discount: number;
  charge: RegionalCharge;
}

/**
 * The local amount Dodo is told to charge, from the visitor's converted price:
 * charm-rounded DOWN with the campaign's strategy, so it is never above the
 * exact discounted price and at most 8% below it (charm.ts). The discount the
 * pages state ("70% off") is therefore never more than the real one. The config
 * endpoint rounds a visitor's estimate UP instead, which is right next to a code
 * for the exact percentage and wrong for a price that is charged as shown. A
 * price in the product's own currency is exact here; countryCharge rounds it.
 */
export function chargedLocalPrice(
  basePrice: number,
  discount: number,
  local: Pick<LocalPricing, "currencyCode" | "fxRate" | "fxAsOf" | "localPrice">,
  strategy: CharmStrategy,
): number | null {
  if (!local.fxAsOf) return local.localPrice;
  return charm(basePrice * (1 - discount / 100) * local.fxRate, local.currencyCode, strategy, "down");
}

/**
 * What Dodo charges one country: regionalCharge with the local price from
 * chargedLocalPrice, and a charge in the product's own currency (a currency
 * Dodo can't charge, or a visitor who pays in that currency) charm-rounded
 * down the same way, with the same 8% limit. A price no charm point fits under
 * stays exact, as does one that would fall under Dodo's minimum.
 */
export function countryCharge(input: {
  basePrice: number;
  baseCurrency: string;
  discount: number;
  local: Pick<LocalPricing, "currencyCode" | "fxRate" | "fxAsOf" | "localPrice"> | null;
  strategy: CharmStrategy;
}): RegionalCharge | null {
  const { basePrice, baseCurrency, discount, local, strategy } = input;
  const charge = regionalCharge({
    basePrice,
    baseCurrency,
    discount,
    local: local ? { currencyCode: local.currencyCode, localPrice: chargedLocalPrice(basePrice, discount, local, strategy) } : null,
  });
  if (!charge || charge.local) return charge;
  const rounded = charm(charge.amount, charge.currency, strategy, "down");
  if (rounded === null || rounded >= charge.amount) return charge;
  if (charge.currency === "USD" && rounded < DODO_MIN_SUBSCRIPTION_USD) return charge;
  return { ...charge, amount: rounded, minorAmount: Math.round(rounded * 10 ** minorUnitExponent(charge.currency)) };
}

// ── Talking to Dodo ─────────────────────────────────────────────────────────

/** A Localized Pricing rule as Dodo lists it. */
export interface DodoRule {
  id: string;
  country_code?: string | null;
  currency: string;
  amount: number;
}

export interface DodoReply {
  ok: boolean;
  status: number;
  body: unknown;
}

export type DodoRequest = (method: string, path: string, body?: unknown) => Promise<DodoReply>;

export const DODO_API_BASE = {
  test: "https://test.dodopayments.com",
  live: "https://live.dodopayments.com",
} as const;

/** A Dodo API caller for one key and mode. */
export function dodoRequester(baseUrl: string, apiKey: string): DodoRequest {
  return async (method, path, body) => {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${apiKey}`,
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
  };
}

/** A short, one-line description of a refused Dodo call. */
export function dodoErrorMessage(reply: Pick<DodoReply, "status" | "body">): string {
  const b = reply.body as { message?: unknown; code?: unknown } | string | null;
  const raw =
    typeof b === "string" ? b : b && typeof b.message === "string" ? b.message : b && typeof b.code === "string" ? b.code : "";
  const line = raw.replace(/\s+/g, " ").trim().slice(0, 200);
  return line ? `Dodo answered ${reply.status}: ${line}` : `Dodo answered ${reply.status}`;
}

export function rulesOf(body: unknown): DodoRule[] {
  const items = (body as { items?: unknown } | null)?.items;
  if (!Array.isArray(items)) return [];
  return items.filter(
    (r): r is DodoRule =>
      !!r &&
      typeof r === "object" &&
      typeof (r as DodoRule).id === "string" &&
      typeof (r as DodoRule).currency === "string" &&
      typeof (r as DodoRule).amount === "number",
  );
}

export const ruleCountry = (r: DodoRule): string | null =>
  typeof r.country_code === "string" && r.country_code ? r.country_code.toUpperCase() : null;

export const productPath = (productId: string): string => `/products/${encodeURIComponent(productId)}`;

export async function listDodoRules(
  request: DodoRequest,
  productId: string,
): Promise<{ ok: true; rules: DodoRule[] } | { ok: false; message: string }> {
  const reply = await request("GET", `${productPath(productId)}/localized-prices`);
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

/**
 * The Dodo calls that make the rules match the table: one rule per discounted
 * country with its amount; no rule for any other country, and none without a
 * country (left from a per-currency setup). Changes to existing rules first,
 * then new rules, then removals.
 */
export function planDodoSync(rows: readonly CountryPriceRow[], rules: readonly DodoRule[]): DodoAction[] {
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
export function compareWithDodo(rows: readonly CountryPriceRow[], rules: readonly DodoRule[]): {
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

/** One country's price as Dodo charges it after the last sync. */
export interface PublishedPrice {
  currency: string;
  /** Minor units, as Dodo stores it. */
  minorAmount: number;
  /** The discount this amount was written for; null for a price GoPayLocal didn't write. */
  discount: number | null;
}

/**
 * Dodo's per-country prices as a published list: one entry per country that has
 * a rule. The discount comes from the table row when the rule has the row's
 * amount (just written, or already right), else from the previous list when
 * the amount is unchanged, else null.
 */
export function publishedPrices(
  rules: readonly DodoRule[],
  rows: readonly CountryPriceRow[],
  previous: Record<string, PublishedPrice> | null,
): Record<string, PublishedPrice> {
  const byCountry = new Map(rows.map((r) => [r.country, r]));
  const prices: Record<string, PublishedPrice> = {};
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

export interface ApplyResult {
  created: number;
  updated: number;
  archived: number;
  failures: Array<{ country: string | null; status: number; message: string }>;
  /** Changes still to make. */
  remaining: number;
  /** Dodo's rules as the calls left them, one per country. */
  rulesAfter: DodoRule[];
}

/**
 * One batch: make the product per-country priced if it isn't, then apply
 * planDodoSync's changes until `budget` calls are spent. `label` names the
 * product in problem messages ("the Pro product").
 *
 * `check` sees the product as Dodo returns it and `checkRules` its rules before
 * anything is written; either can stop the batch with a problem. With
 * `ensureByCountry: false` (removing every rule) the product's pricing mode is
 * left as it is.
 */
export async function applyCountryPrices(
  request: DodoRequest,
  productId: string,
  rows: readonly CountryPriceRow[],
  opts: {
    budget: number;
    label: string;
    check?: (product: unknown) => string | null;
    checkRules?: (rules: readonly DodoRule[]) => string | null;
    ensureByCountry?: boolean;
  },
): Promise<{ ok: true; result: ApplyResult } | { ok: false; problem: string; status?: number }> {
  const path = productPath(productId);
  let calls = 0;
  const product = await request("GET", path);
  calls++;
  if (!product.ok) return { ok: false, problem: `Couldn't read ${opts.label}. ${dodoErrorMessage(product)}`, status: product.status };
  const refused = opts.check?.(product.body);
  if (refused) return { ok: false, problem: refused };
  if (opts.ensureByCountry !== false && (product.body as { pricing_mode?: unknown } | null)?.pricing_mode !== "by_country") {
    const set = await request("PATCH", path, { pricing_mode: "by_country" });
    calls++;
    if (!set.ok) return { ok: false, problem: `Couldn't switch ${opts.label} to per-country prices. ${dodoErrorMessage(set)}` };
  }
  const listed = await request("GET", `${path}/localized-prices`);
  calls++;
  if (!listed.ok) return { ok: false, problem: `Couldn't list ${opts.label}'s prices. ${dodoErrorMessage(listed)}` };

  const rulesBefore = rulesOf(listed.body);
  const refusedRules = opts.checkRules?.(rulesBefore);
  if (refusedRules) return { ok: false, problem: refusedRules };
  const actions = planDodoSync(rows, rulesBefore);
  const after = new Map<string, DodoRule>();
  for (const rule of rulesBefore) {
    const country = ruleCountry(rule);
    if (country && !after.has(country)) after.set(country, rule);
  }
  const result: ApplyResult = { created: 0, updated: 0, archived: 0, failures: [], remaining: 0, rulesAfter: [] };
  const rulesPath = `${path}/localized-prices`;
  let done = 0;
  for (const action of actions) {
    if (calls + actionCost(action) > opts.budget) break;
    done++;
    calls += actionCost(action);
    const fail = (reply: DodoReply) =>
      result.failures.push({ country: action.country, status: reply.status, message: dodoErrorMessage(reply) });
    if (action.kind === "archive" || action.kind === "replace") {
      const reply = await request("DELETE", `${rulesPath}/${encodeURIComponent(action.ruleId)}`);
      if (!reply.ok) {
        fail(reply);
        continue;
      }
      if (action.country && after.get(action.country)?.id === action.ruleId) after.delete(action.country);
      if (action.kind === "archive") {
        result.archived++;
        continue;
      }
    }
    if (action.kind === "update") {
      const reply = await request("PATCH", `${rulesPath}/${encodeURIComponent(action.ruleId)}`, { amount: action.amount });
      if (reply.ok) {
        result.updated++;
        after.set(action.country, { id: action.ruleId, country_code: action.country, currency: action.currency, amount: action.amount });
      } else fail(reply);
      continue;
    }
    // create, or the second half of replace
    const reply = await request("POST", rulesPath, {
      currency: action.currency,
      country_code: action.country,
      amount: action.amount,
    });
    if (!reply.ok) {
      fail(reply);
      continue;
    }
    if (action.kind === "replace") result.updated++;
    else result.created++;
    const id = typeof (reply.body as { id?: unknown } | null)?.id === "string" ? (reply.body as { id: string }).id : "";
    after.set(action.country, { id, country_code: action.country, currency: action.currency, amount: action.amount });
  }
  result.remaining = actions.length - done;
  result.failures = result.failures.slice(0, 20);
  result.rulesAfter = [...after.values()];
  return { ok: true, result };
}
