/**
 * What the banner config endpoint remembers between requests, in the
 * isolate's memory (lib/isolate-cache.ts), so that a busy key is answered
 * without a lookup:
 *
 *   apikey:{hash}              -> which organization a public key belongs to,
 *                                 or that no public key has this hash
 *   usage:{orgId}:{YYYYMM}     -> whether the organization is over its monthly
 *                                 cap, and whether it has a cap at all
 *   banner-config:{apiKeyId}   -> the organization's banner document
 *
 * The first two are kept for BANNER_HOT_CACHE_TTL_MS, the document for
 * BANNER_DOC_MEMORY_TTL_MS. What that delays, on top of the up to 60 s KV
 * itself takes to carry a write to every location:
 *
 *  - a revoked public key is still answered for up to a minute longer;
 *  - an unknown key is refused from memory for a minute (apiKeyMissCache),
 *    without a lookup. A key's value does not exist before the key is created,
 *    so a new key is never held back by this;
 *  - a quota that was just reached, or just lifted (upgrade, new month's
 *    first snapshot), takes up to a minute longer to apply. The quota is
 *    recomputed every 10 minutes to begin with;
 *  - a dashboard change (campaign, discount, banner design, experiment,
 *    allowed domains, branding) takes up to 15 seconds longer to show. Every
 *    isolate keeps its own copy, so for those seconds two requests can get the
 *    old and the new answer.
 *
 * Only a current document is kept. A missing or outdated one is not
 * remembered, so the document a rebuild writes is used by the next request,
 * and a workspace that was just set up is not held back.
 *
 * A fourth entry is not a lookup: bannerDocCheckCache remembers that this
 * isolate compared an organization's stored document with the database, so
 * the comparison runs once per BANNER_DOC_CHECK_TTL_MS, not on every request
 * that sees an old document (routes/banner-script.ts).
 *
 * This module imports types only, so a test setup file can load it without
 * loading the route.
 */

import { IsolateCache, deepFreeze } from "../lib/isolate-cache";
import type { CachedApiKey, CachedBannerConfig } from "./banner-cache.service";
import type { QuotaState } from "./usage.service";

export const BANNER_HOT_CACHE_TTL_MS = 60_000;
export const BANNER_DOC_MEMORY_TTL_MS = 15_000;

/**
 * Bound on the documents kept, in weight units (bannerDocWeight: about one
 * per country entry). Documents differ in size by orders of magnitude, so the
 * bound is on what they hold, not on how many there are.
 */
export const BANNER_DOC_MEMORY_MAX_WEIGHT = 100_000;

/** Key hash -> the key's mapping. Only valid public keys are stored. */
export const apiKeyCache = new IsolateCache<CachedApiKey>(BANNER_HOT_CACHE_TTL_MS);

/**
 * Key hash -> no public key has this hash (the database was asked). Kept in
 * memory only: a request with a key that does not exist writes nothing.
 */
export const apiKeyMissCache = new IsolateCache<true>(BANNER_HOT_CACHE_TTL_MS);

/** `usage:` KV key (it carries the month) -> the quota state read from it. */
export const quotaCache = new IsolateCache<QuotaState>(BANNER_HOT_CACHE_TTL_MS);

/** `banner-config:` KV key -> the current document read from it, frozen. */
export const bannerDocCache = new IsolateCache<CachedBannerConfig>(
  BANNER_DOC_MEMORY_TTL_MS,
  BANNER_DOC_MEMORY_MAX_WEIGHT,
);

/**
 * Age from which the endpoint has a served document compared with the
 * database, in the background (refreshBannerConfigForOrg). The comparison
 * rewrites the document only when it differs: after a rebuild that lost a
 * race, or one that failed after the change was saved.
 */
export const BANNER_DOC_MAX_AGE_MS = 15 * 60_000;

/**
 * How long an isolate remembers that it compared an organization's document.
 * A minute less than BANNER_DOC_MAX_AGE_MS: a comparison can read a document
 * that another location replaced up to a minute before (KV), and that minute
 * must not come on top of the 15.
 */
export const BANNER_DOC_CHECK_TTL_MS = BANNER_DOC_MAX_AGE_MS - 60_000;

/** Organization id -> its stored document was compared with the database. */
export const bannerDocCheckCache = new IsolateCache<true>(BANNER_DOC_CHECK_TTL_MS);

/** A document's size for the memory bound: 1, plus 1 per campaign, plus 1 per country entry. */
export function bannerDocWeight(doc: CachedBannerConfig): number {
  let weight = 1;
  for (const campaign of Object.values(doc.campaigns)) {
    weight += 1 + Object.keys(campaign?.countries ?? {}).length;
  }
  return weight;
}

/** Keep a current document for the next requests. Returns it frozen: it is shared from here on. */
export function rememberBannerDoc(key: string, doc: CachedBannerConfig): CachedBannerConfig {
  const frozen = deepFreeze(doc);
  bannerDocCache.set(key, frozen, { weight: bannerDocWeight(frozen) });
  return frozen;
}

/**
 * Empty the caches and set their time limits (0 turns one off). `docTtlMs`
 * defaults to the document's own limit, or to `ttlMs` when that is shorter;
 * `checkTtlMs` defaults to its own limit, or to 0 when `ttlMs` is 0. So
 * `{ ttlMs: 0 }` turns everything off.
 */
export function configureBannerHotCache(options: { ttlMs: number; docTtlMs?: number; checkTtlMs?: number }): void {
  for (const cache of [apiKeyCache, apiKeyMissCache, quotaCache]) {
    cache.configure({ ttlMs: options.ttlMs });
    cache.clear();
  }
  bannerDocCache.configure({ ttlMs: options.docTtlMs ?? Math.min(options.ttlMs, BANNER_DOC_MEMORY_TTL_MS) });
  bannerDocCache.clear();
  bannerDocCheckCache.configure({ ttlMs: options.checkTtlMs ?? (options.ttlMs > 0 ? BANNER_DOC_CHECK_TTL_MS : 0) });
  bannerDocCheckCache.clear();
}
