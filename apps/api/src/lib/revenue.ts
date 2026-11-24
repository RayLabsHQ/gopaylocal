/**
 * Revenue and activation figures for the admin, as pure functions over rows the
 * admin routes read. Test-mode subscriptions and internal workspaces (the
 * people running the deployment) never count.
 */

import { sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { COUNTRY_NAMES, PLAN_PRICES_USD, normalizePlan } from "@gopaylocal/shared/constants";
import type { Plan } from "@gopaylocal/shared/types";
import { minorUnitExponent } from "@gopaylocal/shared/currency";
import { internalOrganizations } from "../db/schema";
import { utcMonthStart } from "./limits";

/** WHERE condition: the organization in `orgIdColumn` is not internal. */
export const notInternal = (orgIdColumn: AnyPgColumn) =>
  sql`NOT EXISTS (SELECT 1 FROM ${internalOrganizations} WHERE ${internalOrganizations.organizationId} = ${orgIdColumn})`;

export type SubscriptionRevenueRow = {
  plan: string;
  environment: string;
  recurringAmount: number | null;
  currency: string | null;
};

/** One subscription's monthly amount in major units: what Dodo charges, or the list price for an older row. */
function monthlyAmount(row: SubscriptionRevenueRow): { currency: string; amount: number } {
  const known = row.recurringAmount !== null && row.currency !== null;
  const currency = known ? row.currency! : "USD";
  return { currency, amount: known ? row.recurringAmount! / 10 ** minorUnitExponent(currency) : PLAN_PRICES_USD.pro.month };
}

function addMoney(into: Record<string, number>, currency: string, amount: number): void {
  into[currency] = Math.round(((into[currency] ?? 0) + amount) * 100) / 100;
}

/**
 * Plan counts and monthly recurring revenue from active subscriptions.
 * Test-mode rows are counted apart and never as revenue. Each subscription
 * counts at the amount Dodo charges it (pre-tax); a row recorded before
 * amounts were stored counts at the Pro list price. `mrrByCurrency` is in
 * major units and never adds currencies together; `estimatedMRR` is its USD
 * entry, the figure for a business priced in USD.
 */
export function summarizeSubscriptions(rows: SubscriptionRevenueRow[]): {
  planCounts: Record<Plan, number>;
  testSubscriptions: number;
  mrrByCurrency: Record<string, number>;
  estimatedMRR: number;
} {
  const planCounts: Record<Plan, number> = { free: 0, pro: 0 };
  const mrrByCurrency: Record<string, number> = {};
  let testSubscriptions = 0;
  for (const row of rows) {
    if (normalizePlan(row.plan) !== "pro") continue;
    if (row.environment === "test") {
      testSubscriptions += 1;
      continue;
    }
    planCounts.pro += 1;
    const { currency, amount } = monthlyAmount(row);
    addMoney(mrrByCurrency, currency, amount);
  }
  return { planCounts, testSubscriptions, mrrByCurrency, estimatedMRR: mrrByCurrency.USD ?? 0 };
}

// ── Revenue page ────────────────────────────────────────────────────────────

export interface RevenueRow extends SubscriptionRevenueRow {
  organizationId: string;
  organizationName: string | null;
  status: string;
  billingCountry: string | null;
  createdAt: Date;
  updatedAt: Date;
  currentPeriodEnd: Date | null;
  internal: boolean;
}

const ended = (status: string) => status === "canceled" || status === "expired";

/**
 * Live Pro subscriptions of non-internal workspaces: how many, what they bring
 * in each month, what changed this UTC month, and where buyers are.
 *
 * A workspace has one subscription row, so "new this month" is a workspace
 * whose first subscription started this month, and a cancellation is a row
 * that ended (canceled or expired) this month. Churn is the share of the
 * subscriptions running on the 1st that have ended since.
 */
export function summarizeRevenue(rows: readonly RevenueRow[], now: Date = new Date()) {
  const monthStart = utcMonthStart(now);
  const counted = rows.filter((r) => r.environment === "live" && !r.internal && normalizePlan(r.plan) === "pro");
  const active = counted.filter((r) => r.status === "active");
  const atStart = counted.filter((r) => r.createdAt < monthStart && !(ended(r.status) && r.updatedAt < monthStart));
  const churned = atStart.filter((r) => ended(r.status)).length;

  const mrrByCurrency: Record<string, number> = {};
  const countries = new Map<string, { subscriptions: number; mrrByCurrency: Record<string, number> }>();
  for (const row of active) {
    const { currency, amount } = monthlyAmount(row);
    addMoney(mrrByCurrency, currency, amount);
    const key = row.billingCountry ?? "unknown";
    const entry = countries.get(key) ?? { subscriptions: 0, mrrByCurrency: {} };
    entry.subscriptions += 1;
    addMoney(entry.mrrByCurrency, currency, amount);
    countries.set(key, entry);
  }

  return {
    active: active.length,
    pastDue: counted.filter((r) => r.status === "past_due").length,
    newThisMonth: counted.filter((r) => r.createdAt >= monthStart).length,
    cancelledThisMonth: counted.filter((r) => ended(r.status) && r.updatedAt >= monthStart).length,
    churn: { runningOnFirst: atStart.length, ended: churned, rate: atStart.length > 0 ? churned / atStart.length : null },
    mrrByCurrency,
    estimatedMRR: mrrByCurrency.USD ?? 0,
    byCountry: [...countries.entries()]
      .map(([country, v]) => ({
        country: country === "unknown" ? null : country,
        countryName: country === "unknown" ? "Not recorded" : COUNTRY_NAMES[country] ?? country,
        ...v,
      }))
      .sort((a, b) => b.subscriptions - a.subscriptions || (a.countryName ?? "").localeCompare(b.countryName ?? "")),
    leftOut: {
      test: rows.filter((r) => r.environment === "test" && normalizePlan(r.plan) === "pro").length,
      internal: rows.filter((r) => r.environment === "live" && r.internal && normalizePlan(r.plan) === "pro").length,
    },
  };
}

// ── Activation ──────────────────────────────────────────────────────────────

export interface OrgActivationFacts {
  id: string;
  name: string;
  createdAt: Date;
  ownerEmail: string | null;
  hasProduct: boolean;
  hasActiveCampaign: boolean;
  hasLiveViews: boolean;
  isPro: boolean;
}

export const ACTIVATION_STEPS = [
  { key: "signedUp", label: "Signed up" },
  { key: "hasProduct", label: "Added a product" },
  { key: "hasActiveCampaign", label: "Started a campaign" },
  { key: "hasLiveViews", label: "Banner seen on a live site" },
  { key: "isPro", label: "On Pro" },
] as const;

/**
 * How far each workspace got, in order: a step counts only when every step
 * before it is done too. `stuck` lists, per step, the workspaces that reached
 * the step before and not this one, newest first.
 */
export function activationFunnel(orgs: readonly OrgActivationFacts[], now: Date = new Date(), stuckLimit = 25) {
  const furthest = (o: OrgActivationFacts): number => {
    const facts = [true, o.hasProduct, o.hasActiveCampaign, o.hasLiveViews, o.isPro];
    let i = 0;
    while (i + 1 < facts.length && facts[i + 1]) i++;
    return i;
  };
  const sorted = [...orgs].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  const reach = sorted.map((o) => ({ o, step: furthest(o) }));
  return ACTIVATION_STEPS.map((step, index) => {
    const reached = reach.filter((r) => r.step >= index).length;
    const stuckHere = index === 0 ? [] : reach.filter((r) => r.step === index - 1);
    return {
      key: step.key,
      label: step.label,
      reached,
      stuckCount: stuckHere.length,
      stuck: stuckHere.slice(0, stuckLimit).map(({ o }) => ({
        id: o.id,
        name: o.name,
        ownerEmail: o.ownerEmail,
        createdAt: o.createdAt.toISOString(),
        daysSinceSignup: Math.max(0, Math.floor((now.getTime() - o.createdAt.getTime()) / 86_400_000)),
      })),
    };
  });
}

/** Sign-ups per UTC week (weeks start Monday), oldest first, the last `weeks` weeks. */
export function signupsByWeek(createdAt: readonly Date[], now: Date = new Date(), weeks = 12) {
  const day = 86_400_000;
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const thisMonday = today - ((new Date(today).getUTCDay() + 6) % 7) * day;
  const out = Array.from({ length: weeks }, (_, i) => ({
    weekStart: new Date(thisMonday - (weeks - 1 - i) * 7 * day).toISOString().slice(0, 10),
    signups: 0,
  }));
  const first = thisMonday - (weeks - 1) * 7 * day;
  for (const d of createdAt) {
    const t = d.getTime();
    if (t < first) continue;
    const i = Math.floor((t - first) / (7 * day));
    if (i >= 0 && i < weeks) out[i]!.signups++;
  }
  return out;
}
