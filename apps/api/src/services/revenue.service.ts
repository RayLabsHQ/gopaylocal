// ── Revenue saved, per currency ─────────────────────────────────────────────
// analytics_rollups.revenue_saved_by_currency holds integer minor units keyed
// by ISO 4217 code ({"USD": 1250, "INR": 40000}). Amounts in different
// currencies are never added together: readers get one total per currency,
// converted to major units with the currency's own exponent (JPY 0, KWD 3).
// analytics_rollups.revenue_saved stays as the USD-only dollar figure.

import { sql, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import type { Database } from "../db";
import { analyticsRollups } from "../db/schema";
import { minorToMajor, normalizeCurrency } from "../lib/currency";

/** Major-unit totals keyed by ISO 4217 code, e.g. { USD: 12.5, INR: 400 }. */
export type RevenueByCurrency = Record<string, number>;

/** Group key used when the query is not grouped. */
export const ALL = "";

/**
 * Sum revenue_saved_by_currency over the rollup rows matching `where`, per
 * currency, optionally grouped by one rollup column (country, campaign).
 * Returns a map from group value (or ALL) to its per-currency totals; groups
 * with no recorded savings are absent.
 */
export async function revenueSavedByCurrency(
  db: Pick<Database, "select">,
  where: SQL | undefined,
  groupBy?: AnyPgColumn,
): Promise<Map<string, RevenueByCurrency>> {
  const group = groupBy ? sql`${groupBy}` : sql`''`;
  const rows = await db
    .select({
      group: sql<string | null>`${group}`,
      currency: sql<string>`kv.key`,
      amountMinor: sql<string | number>`SUM((kv.value)::bigint)`,
    })
    .from(sql`${analyticsRollups} CROSS JOIN LATERAL jsonb_each_text(${analyticsRollups.revenueSavedByCurrency}) AS kv(key, value)`)
    .where(where)
    .groupBy(groupBy ? sql`${groupBy}, kv.key` : sql`kv.key`);

  const out = new Map<string, RevenueByCurrency>();
  for (const r of rows) {
    const code = normalizeCurrency(r.currency);
    const minor = Number(r.amountMinor);
    if (!code || !Number.isFinite(minor) || minor === 0) continue;
    const key = r.group ?? ALL;
    const totals = out.get(key) ?? {};
    totals[code] = (totals[code] ?? 0) + minorToMajor(minor, code);
    out.set(key, totals);
  }
  return out;
}
