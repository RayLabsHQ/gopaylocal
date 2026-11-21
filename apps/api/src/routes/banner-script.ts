import { Hono, type Context } from "hono";
import { eq } from "drizzle-orm";
import type { AppEnv } from "../bindings";
import { createDb, type Database } from "../db";
import { apiKeys, subscriptions } from "../db/schema";
import { getDiscountForCountry } from "../services/parity.service";
import { isVpnOrProxy } from "../services/vpn-detect.service";
import { kvGet } from "../lib/kv";
import { getQuotaState, usageKey, type QuotaState } from "../services/usage.service";
import { bannerShowsBranding, resolveEntitlements } from "../lib/entitlements";
import { COUNTRY_NAMES } from "@gopaylocal/shared/constants";
import { localPricing } from "@gopaylocal/shared/currency";
import type { BannerConfig, BannerResponse } from "@gopaylocal/shared/types";
import {
  bannerDocKey,
  bannerDocRefreshDue,
  isCurrentBannerDoc,
  loadServingInputs,
  pushApiKeyToKV,
  pushBannerConfigForOrg,
  refreshBannerConfigForOrg,
  type CachedApiKey,
  type CachedBannerConfig,
  type CampaignPricing,
  type ServingInputs,
} from "../services/banner-cache.service";
import { loadFxRates, parseExcludedCurrencies } from "../services/fx-cache";
import { fxDisabled } from "../services/fx-refresh.service";
import {
  assignVariant,
  parseProductParam,
  parseVisitorId,
  selectServing,
  visitorKey,
  type BannerEnvironment,
  type ProductServing,
} from "../services/banner-selection";
import { usageMeter, writeUsageRows } from "../services/usage-meter";
import { impressionMeter, writeImpressionRows } from "../services/impression-meter";
import {
  apiKeyCache,
  bannerDocCache,
  bannerDocCheckCache,
  quotaCache,
  rememberBannerDoc,
} from "../services/banner-hot-cache";
import { enforceRateLimit } from "../lib/rate-limit";
import { errorSummary, logBannerPushFailure } from "../lib/log";
import { SECRET_KEY_NOT_ALLOWED, isSecretKey } from "../lib/public-key";
// @ts-expect-error -- text module import handled by wrangler's esbuild bundler
import bannerBundleJs from "../../../../packages/banner/dist/banner.js";

const app = new Hono<AppEnv>();

/**
 * GET /v1/banner/script.js and GET /v1/banner/bundle.js: the banner itself.
 *
 * In a deployment these two paths are static assets (wrangler.toml [assets],
 * filled by scripts/build-static.mjs from packages/banner/dist): Cloudflare
 * answers them before the Worker runs. These handlers answer only where the
 * assets are absent (the tests, a deployment whose wrangler.toml has no
 * [assets]), with the same file and the same cache times as static/_headers.
 *
 * script.js used to be a loader that injected bundle.js. Both are the banner
 * now, so a visitor fetches one script instead of two; bundle.js stays for
 * pages that cached the old loader. The file is the same for every key, so
 * nothing from the request is written into it: the banner reads its key from
 * its own <script> tag, and refuses a secret key there
 * (packages/banner/src/index.ts).
 */
function serveBanner(maxAgeSeconds: number) {
  return async (c: Context<AppEnv>) => {
    // Same generous per-IP limit as the config hot path (cheap static response).
    // Skip the gate when the IP is empty — don't bucket header-less traffic on "".
    const ip = c.req.header("cf-connecting-ip") ?? "";
    const limited = ip ? await enforceRateLimit(c, c.env.RL_BANNER_IP, `ip:${ip}`) : null;
    if (limited) return limited;

    return c.text(bannerBundleJs as string, 200, {
      "Content-Type": "application/javascript",
      "Cache-Control": `public, max-age=${maxAgeSeconds}`,
    });
  };
}

app.get("/v1/banner/script.js", serveBanner(3600));
app.get("/v1/banner/bundle.js", serveBanner(86400));

/**
 * Hash a public key using SHA-256 (same algorithm as api-keys route).
 */
async function hashPublicKey(publicKey: string): Promise<string> {
  const data = new TextEncoder().encode(publicKey);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ── Background work ─────────────────────────────────────────────────────────

/** The request's ExecutionContext, or null where none exists (some unit tests). */
function executionContext(c: Context<AppEnv>): { waitUntil(promise: Promise<unknown>): void } | null {
  try {
    return c.executionCtx;
  } catch {
    return null;
  }
}

/** Run `task` after the response. `task` must already handle its own errors. */
function background(c: Context<AppEnv>, task: Promise<unknown>): void {
  executionContext(c)?.waitUntil(task);
}

/**
 * Count this request as one API call (it carries a valid key and reached
 * campaign resolution). Memory only on the request path; the database write
 * happens in waitUntil (see services/usage-meter.ts). Never throws: a
 * metering fault must not affect the banner.
 */
function meterApiCall(
  c: Context<AppEnv>,
  organizationId: string,
  environment: BannerEnvironment,
  limited: boolean,
): void {
  const ctx = executionContext(c);
  if (!ctx) return;
  try {
    usageMeter.record(
      { organizationId, environment, limited },
      {
        waitUntil: (promise) => ctx.waitUntil(promise),
        write: (rows) => writeUsageRows(createDb(c.env), rows),
      },
    );
  } catch (err) {
    console.error("banner: usage metering failed", { organizationId, error: errorSummary(err) });
  }
}

/**
 * Count one impression: this request is answered with an offer (`show: true`)
 * for `campaignId`. Counted here, not reported by the client, so a visitor is
 * served with one request (services/impression-meter.ts). Memory only on the
 * request path; never throws: an analytics fault must not affect the banner.
 */
function countImpression(
  c: Context<AppEnv>,
  organizationId: string,
  campaignId: string,
  countryCode: string,
  limited: boolean,
): void {
  const ctx = executionContext(c);
  if (!ctx) return;
  try {
    impressionMeter.record(
      { organizationId, campaignId, countryCode, limited },
      {
        waitUntil: (promise) => ctx.waitUntil(promise),
        write: (rows) => writeImpressionRows(createDb(c.env), rows),
      },
    );
  } catch (err) {
    console.error("banner: impression count failed", { organizationId, error: errorSummary(err) });
  }
}

/**
 * The quota state of an organization: from the isolate's memory when it was
 * read in the last minute (services/banner-hot-cache.ts), else from the
 * `usage:` KV snapshot. The key carries the month, so a new month never sees
 * the old month's answer.
 */
async function quotaState(c: Context<AppEnv>, organizationId: string): Promise<QuotaState> {
  const key = usageKey(organizationId);
  const remembered = quotaCache.get(key);
  if (remembered) return remembered;
  const state = await getQuotaState(c.env.CACHE, organizationId, c.env);
  quotaCache.set(key, state);
  return state;
}

/**
 * Isolate-local throttle for the background work the endpoint starts on a
 * document: a rebuild (a missing document, or one of an older version) or a
 * check (a current document older than 15 minutes, or without builtAt). One
 * per organization per isolate per REBUILD_THROTTLE_MS, however many requests
 * see the document, so a busy workspace never gets one per request.
 *
 * A check compares the stored document with the database and rewrites it only
 * when it differs (refreshBannerConfigForOrg), so a document that nothing
 * changed is not written again. After a check this isolate leaves the
 * organization alone for BANNER_DOC_CHECK_TTL_MS; a check that failed is not
 * remembered and is tried again after the throttle.
 *
 * The check is the backstop for two rebuilds racing in different locations
 * (pushBannerConfigForOrg repairs a race it can see) and for a rebuild that
 * failed. The worst case for a stale document is about 15 minutes plus about
 * 60 seconds after the last write: the age limit, then the time KV takes to
 * carry the rebuilt document to every location.
 */
const REBUILD_THROTTLE_MS = 60_000;
const lastRebuildAt = new Map<string, number>();

function scheduleDocWork(c: Context<AppEnv>, organizationId: string, work: "rebuild" | "check"): void {
  if (work === "check" && bannerDocCheckCache.get(organizationId)) return;
  const now = Date.now();
  if (now - (lastRebuildAt.get(organizationId) ?? 0) < REBUILD_THROTTLE_MS) return;
  if (lastRebuildAt.size > 10_000) lastRebuildAt.clear();
  lastRebuildAt.set(organizationId, now);
  const db = createDb(c.env);
  const done =
    work === "rebuild"
      ? pushBannerConfigForOrg(db, c.env.CACHE, organizationId, c.env)
      : refreshBannerConfigForOrg(db, c.env.CACHE, organizationId, c.env).then(() => {
          bannerDocCheckCache.set(organizationId, true);
        });
  background(c, done.catch(logBannerPushFailure(organizationId)));
}

// ── Campaign resolution: KV document or database, same selection ────────────

interface ServedCampaign {
  environment: BannerEnvironment;
  allowedDomains: string[] | null;
  banner: BannerConfig;
  pricing: CampaignPricing;
}

interface CountryOffer {
  discount: number;
  code: string | null;
  countryName: string;
}

interface Resolver {
  serving(productId: string | null): ProductServing | null;
  campaign(campaignId: string): ServedCampaign | null;
  country(campaignId: string, countryCode: string): Promise<CountryOffer | null>;
  showBranding(): Promise<boolean>;
}

interface ResolverDeps {
  c: Context<AppEnv>;
  organizationId: string;
  db: () => Database;
}

/** Answers from the KV document (no database, except `resolve` countries). */
function documentResolver(doc: CachedBannerConfig, deps: ResolverDeps): Resolver {
  return {
    serving(productId) {
      const target = productId ?? doc.defaultProductId;
      if (!target || !Object.hasOwn(doc.products, target)) return null;
      return doc.products[target] ?? null;
    },
    campaign(campaignId) {
      return Object.hasOwn(doc.campaigns, campaignId) ? doc.campaigns[campaignId]! : null;
    },
    async country(campaignId, countryCode) {
      const campaign = doc.campaigns[campaignId];
      if (!campaign || !Object.hasOwn(campaign.countries, countryCode)) return null;
      const info = campaign.countries[countryCode]!;
      if (!info.resolve) return { discount: info.discount, code: info.code, countryName: info.countryName };
      // Provider-backed campaign without a stored code for this percent yet:
      // resolve (and create) it exactly like the database path does.
      const result = await getDiscountForCountry(
        deps.db(),
        deps.c.env,
        deps.organizationId,
        campaignId,
        countryCode,
        deps.c.env.CACHE,
        doc.epoch,
      );
      if (!result) return null;
      return { discount: result.discount, code: result.code, countryName: info.countryName };
    },
    async showBranding() {
      return doc.showBranding;
    },
  };
}

/** Answers from Postgres when the document is missing or of an older version. */
function databaseResolver(inputs: ServingInputs, deps: ResolverDeps): Resolver {
  const byId = new Map(inputs.campaigns.map((c) => [c.id, c]));
  return {
    serving(productId) {
      return selectServing(inputs, productId);
    },
    campaign(campaignId) {
      const row = byId.get(campaignId);
      if (!row?.banner) return null;
      return {
        environment: row.environment === "test" ? "test" : "live",
        allowedDomains: row.allowedDomains,
        banner: row.banner,
        pricing: row.pricing,
      };
    },
    async country(campaignId, countryCode) {
      const row = byId.get(campaignId);
      if (!row) return null;
      const result = await getDiscountForCountry(
        deps.db(),
        deps.c.env,
        deps.organizationId,
        campaignId,
        countryCode,
        deps.c.env.CACHE,
      );
      if (!result) return null;
      return {
        discount: result.discount,
        code: result.code,
        countryName: COUNTRY_NAMES[countryCode] ?? countryCode,
      };
    },
    async showBranding() {
      // Plan-derived branding (Free shows "Powered by GoPayLocal").
      const sub = await deps
        .db()
        .select({
          plan: subscriptions.plan,
          status: subscriptions.status,
          currentPeriodEnd: subscriptions.currentPeriodEnd,
        })
        .from(subscriptions)
        .where(eq(subscriptions.organizationId, deps.organizationId))
        .limit(1)
        .then((rows) => rows[0] ?? null);
      return resolveEntitlements(sub, deps.c.env).showBranding;
    },
  };
}

// ── Local prices ────────────────────────────────────────────────────────────

/** FX_EXCLUDED_CURRENCIES parsed once per value (Worker vars are fixed per isolate). */
let excludedMemo: { raw: string | undefined; set: ReadonlySet<string> } | null = null;
function excludedCurrencies(raw: string | undefined): ReadonlySet<string> {
  if (!excludedMemo || excludedMemo.raw !== raw) excludedMemo = { raw, set: parseExcludedCurrencies(raw) };
  return excludedMemo.set;
}

/**
 * The price fields of a `show: true` answer (packages/shared/src/currency/
 * local-price.ts): converted and charm-rounded when a usable rate exists, else
 * the exact price in the product's currency. Never throws; the rates read is
 * memoised per isolate (services/fx-cache.ts).
 */
async function priceFields(
  c: Context<AppEnv>,
  pricing: CampaignPricing,
  discount: number,
  countryCode: string,
): Promise<Partial<BannerResponse>> {
  const local = localPricing({
    basePrice: pricing.basePrice,
    baseCurrency: pricing.currency,
    discountPercent: discount,
    country: countryCode,
    strategy: pricing.charm,
    fx: fxDisabled(c.env) ? null : await loadFxRates(c.env.CACHE),
    now: Date.now(),
    excludedCurrencies: excludedCurrencies(c.env.FX_EXCLUDED_CURRENCIES),
  });
  // Only an impossible product (base_price is validated positive) has no prices.
  if (!local) return { charmPricingStrategy: pricing.charm };
  return { ...local, charmPricingStrategy: pricing.charm };
}

/** Origin/Referer host must equal an allowed domain or be a subdomain of one. */
function domainAllowed(allowedDomains: string[] | null, origin: string): boolean {
  if (!allowedDomains || allowedDomains.length === 0) return true;
  if (!origin) return false;
  try {
    const originHost = new URL(origin).hostname;
    return allowedDomains.some((d) => originHost === d || originHost.endsWith(`.${d}`));
  } catch {
    return false;
  }
}

/**
 * Resolve the key on a KV miss: negative cache, the cold-path rate limit, then
 * Postgres. Returns the key mapping or the response to send.
 */
async function resolveKeyFromDatabase(
  c: Context<AppEnv>,
  keyHash: string,
  clientIp: string,
  db: () => Database,
): Promise<CachedApiKey | Response> {
  // Cached negative result (invalid key) prevents DB abuse.
  const negativeKey = `apikey-miss:${keyHash}`;
  if (await c.env.CACHE.get(negativeKey)) {
    return c.json({ error: "Invalid API key" }, 401);
  }

  // Tight per-IP gate on the unknown-key path ONLY. A flood of DISTINCT invalid
  // keys each produces a fresh apikey-miss, so the 60s negative cache above
  // doesn't help — every request would otherwise reach Postgres. This caps
  // cold DB lookups per IP (20/min, see wrangler.toml RL_BANNER_MISS_IP). Legit
  // sites use ~1 key and never trip it. Keyed IP-WIDE (NOT per publicKey) on
  // purpose — it must bound an attacker's total cold lookups across ALL the
  // keys they rotate. Skip on empty IP.
  const missLimited = clientIp
    ? await enforceRateLimit(c, c.env.RL_BANNER_MISS_IP, `ip:${clientIp}`)
    : null;
  if (missLimited) return missLimited;

  let row: { id: string; organizationId: string; keyType: string } | undefined;
  try {
    row = await db()
      .select({ id: apiKeys.id, organizationId: apiKeys.organizationId, keyType: apiKeys.keyType })
      .from(apiKeys)
      .where(eq(apiKeys.keyHash, keyHash))
      .limit(1)
      .then((rows) => rows[0]);
  } catch (err) {
    // DB error: don't write the negative cache, just fail this request.
    console.error("banner: API key lookup failed", { error: errorSummary(err) });
    return c.json({ show: false, reason: "internal_error" }, 500);
  }

  if (!row || row.keyType !== "public") {
    // Cache the miss for 60s to prevent repeated DB lookups for invalid keys
    await c.env.CACHE.put(negativeKey, "1", { expirationTtl: 60 }).catch(() => {});
    return c.json({ error: "Invalid API key" }, 401);
  }

  const { id, organizationId } = row;
  // Backfill the KV mapping so future requests use the fast path, and record
  // the key's last use. Both after the response.
  background(
    c,
    pushApiKeyToKV(c.env.CACHE, keyHash, id, organizationId).catch((err: unknown) => {
      console.error("banner: API key KV backfill failed", { apiKeyId: id, error: errorSummary(err) });
    }),
  );
  background(
    c,
    db()
      .update(apiKeys)
      .set({ lastUsedAt: new Date() })
      .where(eq(apiKeys.id, id))
      .then(() => {})
      .catch((err: unknown) => {
        console.error("banner: lastUsedAt update failed", { apiKeyId: id, error: errorSummary(err) });
      }),
  );
  return { apiKeyId: id, organizationId };
}

/**
 * GET /v1/banner/config/:publicKey?product=<productId>&vid=<visitorId>
 * Public endpoint: returns banner config + discount for the visitor's country.
 *
 *   0. A secret key (gpl_sk_) is refused with 401 before anything else.
 *   1. Country from request.cf (never a client header).
 *   2. Key -> organization: KV `apikey:{hash}`, else Postgres (negative-cached,
 *      cold-path rate limited).
 *   3. VPN check, then the monthly quota (KV usage snapshot; fails open).
 *      The answers of 2 and 3 are kept in the isolate's memory for a minute
 *      (services/banner-hot-cache.ts), so a busy key reads one KV key per
 *      request: the document of step 4.
 *   4. Campaign resolution from the KV document `banner-config:{apiKeyId}`
 *      (version 3); a missing or older document is answered from Postgres with
 *      the same selection and rebuilt in the background.
 *   5. The request is metered as one API call (services/usage-meter.ts).
 *   6. A running experiment assigns the visitor's arm; then the allowed-domain
 *      check and the visitor's country decide the answer.
 *   7. Local prices: the product's price after the discount, in the visitor's
 *      currency when a usable exchange rate exists (KV `fx:rates`, written by
 *      the FX cron), otherwise exactly in the product's currency.
 *   8. An answer with an offer (`show: true`) is counted as one impression of
 *      the served campaign (services/impression-meter.ts).
 */
app.get("/v1/banner/config/:publicKey", async (c) => {
  const publicKey = c.req.param("publicKey");

  // A secret key is refused before it reaches a limiter key, KV or Postgres,
  // and is never echoed or logged (lib/public-key.ts).
  if (isSecretKey(publicKey)) {
    return c.json(SECRET_KEY_NOT_ALLOWED, 401);
  }

  // Generous per-IP limit for the banner hot path. Read cf-connecting-ip here so
  // it's available for this gate, the VPN check and the experiment fallback key.
  // 300/min/IP — see wrangler.toml RL_BANNER_IP reasoning. Valid cached traffic
  // is gated only by this; the tighter RL_BANNER_MISS_IP only fires on the
  // unknown-key path.
  //
  // KEY SPLIT: RL_BANNER_IP is keyed per (IP × customer) so one big customer
  // behind a CGNAT/corporate egress IP can't exhaust the fair-use budget for a
  // DIFFERENT customer on the same IP. RL_BANNER_MISS_IP stays IP-WIDE on
  // purpose (see resolveKeyFromDatabase). Skip the gate on empty IP.
  const clientIp = c.req.header("cf-connecting-ip") ?? "";
  const ipLimited = clientIp
    ? await enforceRateLimit(c, c.env.RL_BANNER_IP, `ip:${clientIp}:${publicKey}`)
    : null;
  if (ipLimited) return ipLimited;

  try {
    // 1. Country: ONLY the authoritative request.cf.country — never the
    // cf-ipcountry header, which a client can spoof to claim a high-discount
    // country (e.g. a US visitor sending `cf-ipcountry: IN` to grab a 65%
    // discount). If cf is absent (non-Cloudflare/local), refuse.
    const cfData = (c.req.raw as any).cf as
      | { country?: string; asOrganization?: string; asn?: number }
      | undefined;
    const countryCode = cfData?.country ?? "";

    if (!countryCode || countryCode === "XX" || countryCode === "T1") {
      return c.json({ show: false, reason: "unknown_country" });
    }

    const productParam = parseProductParam(c.req.query("product"));
    const vid = parseVisitorId(c.req.query("vid"));

    let db: Database | null = null;
    const getDb = () => (db ??= createDb(c.env));

    // 2. Key -> organization.
    const keyHash = await hashPublicKey(publicKey);
    let apiKey = apiKeyCache.get(keyHash) ?? null;
    if (!apiKey) {
      apiKey = await kvGet<CachedApiKey>(c.env.CACHE, `apikey:${keyHash}`);
      if (!apiKey) {
        const resolved = await resolveKeyFromDatabase(c, keyHash, clientIp, getDb);
        if (resolved instanceof Response) return resolved;
        apiKey = resolved;
      }
      apiKeyCache.set(keyHash, apiKey);
    }
    const organizationId = apiKey.organizationId;

    // 3. VPN detection (KV-based), then the monthly quota (soft cap,
    // recomputed by cron from api_usage_daily; never applies self-hosted).
    if (await isVpnOrProxy(clientIp, cfData, c.env.VPN_DATA)) {
      return c.json({ show: false, reason: "vpn_detected" });
    }
    const quota = await quotaState(c, organizationId);
    if (quota.over) {
      return c.json({ show: false, reason: "quota_exceeded" });
    }

    // 4. Campaign resolution.
    const deps: ResolverDeps = { c, organizationId, db: getDb };
    // The document comes from memory when this isolate read it in the last
    // seconds (services/banner-hot-cache.ts), otherwise from KV. Only a
    // current document is remembered.
    const docKey = bannerDocKey(apiKey.apiKeyId);
    let doc: unknown = bannerDocCache.get(docKey);
    if (doc === undefined) {
      doc = await kvGet<unknown>(c.env.CACHE, docKey);
      if (isCurrentBannerDoc(doc)) doc = rememberBannerDoc(docKey, doc);
    }
    let resolver: Resolver;
    if (isCurrentBannerDoc(doc)) {
      // Still served; compared with the database in the background (no KV or
      // database work here), and rewritten only if it differs.
      if (bannerDocRefreshDue(doc, Date.now())) scheduleDocWork(c, organizationId, "check");
      resolver = documentResolver(doc, deps);
    } else {
      scheduleDocWork(c, organizationId, "rebuild");
      resolver = databaseResolver(await loadServingInputs(getDb(), organizationId), deps);
    }

    const serving = resolver.serving(productParam);
    let campaignId: string | null = null;
    let experiment: { experimentId: string; variant: "a" | "b" } | null = null;
    if (serving?.kind === "campaign") {
      campaignId = serving.campaignId;
    } else if (serving?.kind === "experiment") {
      const variant = await assignVariant(
        serving.experimentId,
        visitorKey(vid, clientIp, c.req.header("user-agent") ?? ""),
        serving.trafficSplitB,
      );
      campaignId = variant === "b" ? serving.campaignBId : serving.campaignAId;
      experiment = { experimentId: serving.experimentId, variant };
    }
    const campaign = campaignId ? resolver.campaign(campaignId) : null;

    // 5. One API call: valid key, reached campaign resolution. Requests served
    // by a test-environment campaign are stored apart and don't count against
    // the plan; with nothing to serve, the call counts as live.
    meterApiCall(c, organizationId, campaign?.environment ?? "live", quota.limited);

    if (!campaignId || !campaign) {
      return c.json({ show: false, reason: "no_active_campaign" });
    }

    // 6. The served campaign's own rules.
    const origin = c.req.header("origin") ?? c.req.header("referer") ?? "";
    if (!domainAllowed(campaign.allowedDomains, origin)) {
      return c.json({ show: false, reason: "domain_not_allowed", ...(experiment ?? {}) });
    }

    const offer = await resolver.country(campaignId, countryCode);
    if (!offer || offer.discount <= 0) {
      return c.json({ show: false, reason: "no_discount", ...(experiment ?? {}) });
    }

    const response: BannerResponse = {
      show: true,
      country: countryCode,
      countryName: offer.countryName,
      discount: offer.discount,
      code: offer.code,
      banner: campaign.banner,
      ...(await priceFields(c, campaign.pricing, offer.discount, countryCode)),
      campaignId,
      ...(experiment ?? {}),
      // Self-hosted deployments always get false, whatever the cache holds.
      showBranding: bannerShowsBranding(await resolver.showBranding(), c.env),
    };

    // 8. The offer is served: one impression of this campaign.
    countImpression(c, organizationId, campaignId, countryCode, quota.limited);

    return c.json(response);
  } catch (err) {
    console.error("banner: config request failed", { error: errorSummary(err) });
    return c.json({ show: false, reason: "internal_error" }, 500);
  }
});

export default app;
