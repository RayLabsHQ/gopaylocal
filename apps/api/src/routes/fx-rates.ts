import { Hono } from "hono";
import { usableFxRates, type FxRatesView } from "@gopaylocal/shared/currency";
import type { AppEnv } from "../bindings";
import { requirePermission } from "../middleware/permissions";
import { fxDisabled } from "../services/fx-refresh.service";
import { loadFxRates, parseExcludedCurrencies } from "../services/fx-cache";

// The exchange rates the banner endpoint converts prices with, for the dashboard
// banner editor's preview. `fx` is the stored document as localPricing() takes
// it (held currencies included, as `fx.held`; the refresh-only `baseline` left
// out), and `excludedCurrencies` is the deployment's FX_EXCLUDED_CURRENCIES,
// which the preview passes to localPricing() like the banner endpoint does.
// Excluded codes are not removed from `fx.rates`: a product priced in one still
// needs its rate for the cross rate. `available: false` is exactly when the
// banner endpoint would not convert.
//
// Read-only and organization-independent (the rates are public data), but kept
// behind the banner view permission like the rest of the editor. Works with any
// authentication the team routes accept; nothing here assumes a session.

const app = new Hono<AppEnv>();

app.get("/v1/teams/:orgId/fx-rates", requirePermission("banners.view"), async (c) => {
  const doc = fxDisabled(c.env) ? null : usableFxRates(await loadFxRates(c.env.CACHE), Date.now());
  if (!doc) return c.json({ data: { available: false } satisfies FxRatesView });
  const { baseline: _baseline, ...fx } = doc;
  const excludedCurrencies = [...parseExcludedCurrencies(c.env.FX_EXCLUDED_CURRENCIES)].sort();
  return c.json({ data: { available: true, fx, excludedCurrencies } satisfies FxRatesView });
});

export default app;
