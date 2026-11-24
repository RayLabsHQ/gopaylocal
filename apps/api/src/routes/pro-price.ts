import { Hono } from "hono";
import type { Bindings } from "../bindings";
import { createDb } from "../db";
import { COUNTRY_NAMES, PLAN_PRICES_USD } from "@gopaylocal/shared/constants";
import { minorToMajor } from "@gopaylocal/shared/currency";
import {
  houseSyncUnavailable,
  loadHouseSettings,
  publishedPriceFor,
  type HousePublished,
} from "../services/house-pricing.service";

/**
 * GET /v1/pricing/pro: the hosted Pro plan's price for this visitor's country,
 * as Dodo Payments charges it. The website's pricing card and the dashboard's
 * Billing page show it. The answer comes from the list the house pricing sync
 * records after every run (services/house-pricing.service.ts), so it is the
 * price checkout charges when the billing address is in that country, never a
 * price recomputed since.
 *
 * Public and read-only: no key, no cookies. The country is request.cf.country
 * only (never a client header). `offer` is null for the list price: an unknown
 * country, a country without a regional price, self-hosted deployments, and
 * before the first sync in the Dodo mode and product in use.
 */
const app = new Hono<{ Bindings: Bindings }>();

// The recorded list, kept in isolate memory for a minute: a sync shows here
// within about a minute, and a busy page reads the database once a minute.
const MEMO_MS = 60_000;
let memo: { at: number; published: HousePublished | null } | null = null;

/** Tests only: forget the memoised list. */
export function resetProPriceMemo(): void {
  memo = null;
}

async function recorded(env: Bindings, now: number): Promise<HousePublished | null> {
  if (memo && now - memo.at < MEMO_MS) return memo.published;
  const settings = await loadHouseSettings(createDb(env));
  memo = { at: now, published: settings?.published ?? null };
  return memo.published;
}

app.get("/v1/pricing/pro", async (c) => {
  const cf = (c.req.raw as { cf?: { country?: unknown } }).cf;
  const raw = typeof cf?.country === "string" ? cf.country.toUpperCase() : "";
  const country = /^[A-Z]{2}$/.test(raw) && raw !== "XX" && raw !== "T1" ? raw : null;

  let offer: { discount: number | null; currency: string; amount: number; minorAmount: number } | null = null;
  if (country && !houseSyncUnavailable(c.env)) {
    try {
      const price = publishedPriceFor(await recorded(c.env, Date.now()), c.env, country);
      if (price) {
        offer = {
          discount: price.discount,
          currency: price.currency,
          amount: minorToMajor(price.minorAmount, price.currency),
          minorAmount: price.minorAmount,
        };
      }
    } catch (err) {
      // The list price is always a true answer; never fail the pricing card.
      console.error("Pro price lookup failed:", err instanceof Error ? err.message : String(err));
    }
  }

  c.header("Cache-Control", "private, max-age=300");
  return c.json({
    data: {
      country,
      countryName: country ? (COUNTRY_NAMES[country] ?? country) : null,
      listPrice: PLAN_PRICES_USD.pro.month,
      listCurrency: "USD",
      offer,
    },
  });
});

export default app;
