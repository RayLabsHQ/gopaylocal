import { Hono } from "hono";
import type { AppEnv, Bindings } from "./bindings";
import { createDb } from "./db";
import { recomputeUsageForAllOrgs } from "./services/usage.service";
import { retryPendingRedemptions } from "./services/redemption-webhook.service";
import { retireEndedDealCoupons } from "./services/coupon.service";
import { isRetentionRun, runRetention } from "./services/retention.service";
import { VPN_REFRESH_CRON, refreshVpnDataset } from "./services/vpn-refresh.service";
import { FX_REFRESH_CRON, fxSourcesFromEnv, refreshFxRates } from "./services/fx-refresh.service";
import { corsMiddleware } from "./middleware/cors";
import { assertLimitersPresent } from "./lib/rate-limit";
import { sessionMiddleware } from "./middleware/session";
import { adminMiddleware } from "./middleware/admin";
import { teamMiddleware } from "./middleware/team";
import { apiKeyMiddleware, sessionOrApiKeyMiddleware } from "./middleware/api-key";
import auth from "./routes/auth";
import products from "./routes/products";
import campaigns from "./routes/campaigns";
import deals from "./routes/deals";
import experiments from "./routes/experiments";
import parityGroups from "./routes/parity-groups";
import bannerConfigs from "./routes/banner-configs";
import fxRates from "./routes/fx-rates";
import bannerScript from "./routes/banner-script";
import analytics from "./routes/analytics";
import analyticsIngest from "./routes/analytics-ingest";
import integrations from "./routes/integrations";
import apiKeys from "./routes/api-keys";
import me from "./routes/me";
import billing from "./routes/billing";
import teamMembers from "./routes/team-members";
import webhooks from "./routes/webhooks";
import admin from "./routes/admin";
import adminInsights from "./routes/admin-insights";
import adminHousePricing from "./routes/admin-house-pricing";
import { runScheduledHouseSync } from "./services/house-pricing.service";

const app = new Hono<AppEnv>();

// ── Global middleware ───────────────────────────────────────────────────────

// Once per isolate, verify the rate-limit bindings are actually wired up. They
// fail OPEN by design, so a wrangler typo/dropped stanza would otherwise disable
// protection in prod with no signal. This only LOGS (never throws), skips
// localhost, and runs before CORS/session handling without altering their order.
let limitersChecked = false;
app.use("*", async (c, next) => {
  if (!limitersChecked) {
    limitersChecked = true;
    const origin = c.env.API_BASE_URL ?? new URL(c.req.url).origin;
    assertLimitersPresent(c.env, origin);
  }
  await next();
});

app.use("*", corsMiddleware);

// ── Health check ────────────────────────────────────────────────────────────

app.get("/health", (c) => c.json({ status: "ok", timestamp: new Date().toISOString() }));

// ── Public routes (no auth) ─────────────────────────────────────────────────

app.route("/", auth);
app.route("/", bannerScript);
app.route("/", analyticsIngest);
app.route("/", webhooks);

// ── Admin routes (require session + admin role) ────────────────────────────

app.use("/v1/admin/*", sessionMiddleware);
app.use("/v1/admin/*", adminMiddleware);
app.route("/", admin);
app.route("/", adminInsights);
app.route("/", adminHousePricing);

// ── Authenticated routes ────────────────────────────────────────────────────

// A request with an `Authorization: Bearer` header (any case) is authenticated
// by its secret API key alone (cookies ignored); otherwise by the session, also
// when the header carries another scheme such as HTTP Basic
// (middleware/api-key.ts). GET /v1/me answers only to a key.
app.use("/v1/me", apiKeyMiddleware);
app.route("/", me);

app.use("/v1/teams/*", sessionOrApiKeyMiddleware);
app.use("/v1/teams/:orgId/*", teamMiddleware);

app.route("/", products);
app.route("/", campaigns);
app.route("/", deals);
app.route("/", experiments);
app.route("/", parityGroups);
app.route("/", bannerConfigs);
app.route("/", fxRates);
app.route("/", analytics);
app.route("/", integrations);
app.route("/", apiKeys);
app.route("/", billing);
app.route("/", teamMembers);

// ── 404 fallback ────────────────────────────────────────────────────────────

app.notFound((c) => c.json({ error: "Not found" }, 404));

// ── Global error handler ────────────────────────────────────────────────────

app.onError((err, c) => {
  console.error("Unhandled error:", err);
  return c.json({ error: "Internal server error" }, 500);
});

// Hono handles `fetch`. The scheduled handler is routed by cron expression (all are
// listed in wrangler.toml [triggers]):
//  - VPN_REFRESH_CRON (daily): rebuild the VPN/datacenter/Tor IP dataset in VPN_DATA
//    (services/vpn-refresh.service.ts). Awaited directly: the runtime waits for the
//    scheduled() promise (up to the 15-min cron duration limit), and a thrown error
//    (e.g. a failed KV write) fails the invocation instead of being swallowed.
//  - FX_REFRESH_CRON (every 6 hours): fetch, validate and store the exchange rates
//    for local prices in CACHE `fx:rates` (services/fx-refresh.service.ts). Awaited
//    the same way; upstream problems never throw, a failed KV write does.
//  - anything else (the */10 usage cron): recompute per-org API-hit usage snapshots
//    (services/usage.service.ts). Kept as the default so its behavior is unchanged.
//    It also retries unfinished redemption webhooks and removes the codes of
//    holiday deals that have ended (retireEndedDealCoupons).
//    The run scheduled at 03:00 UTC also deletes old data
//    (services/retention.service.ts). It is here, not on the daily VPN cron,
//    because that run cannot finish on Workers Free.
export default {
  fetch: app.fetch,
  async scheduled(controller, env, ctx) {
    if (controller.cron === VPN_REFRESH_CRON) {
      await refreshVpnDataset(env.VPN_DATA);
      return;
    }
    if (controller.cron === FX_REFRESH_CRON) {
      await refreshFxRates(env.CACHE, { sources: fxSourcesFromEnv(env) });
      return;
    }
    const db = createDb(env);
    ctx.waitUntil(
      Promise.all([
        recomputeUsageForAllOrgs(db, env.CACHE, env).catch((err) => {
          console.error("Usage recompute failed:", err);
        }),
        // Redemption webhooks the request path couldn't finish (provider lookup
        // down, DB hiccup, Gumroad's 5s window): see redemption-webhook.service.
        retryPendingRedemptions(db, env).catch((err) => {
          console.error("Redemption webhook retry failed:", err);
        }),
        // Codes of holiday deals that have ended (or were deleted while their
        // code could not be removed) are removed at the payment platform.
        retireEndedDealCoupons(db, env).catch((err) => {
          console.error("Deal code clean-up failed:", err);
        }),
        // The regional Pro price at Dodo follows the house campaign and the
        // exchange rates (services/house-pricing.service.ts).
        runScheduledHouseSync(db, env, controller.scheduledTime).catch((err) => {
          console.error("House pricing sync failed:", err);
        }),
        isRetentionRun(controller.scheduledTime)
          ? runRetention(db, env).catch((err) => {
              console.error("Retention clean-up failed:", err);
            })
          : null,
      ]),
    );
  },
} satisfies ExportedHandler<Bindings>;
