/**
 * What the banner config endpoint remembers between requests, in the
 * isolate's memory (lib/isolate-cache.ts), so that a request reads one KV key
 * (the banner document) instead of three:
 *
 *   apikey:{hash}          -> which organization a public key belongs to
 *   usage:{orgId}:{YYYYMM} -> whether the organization is over its monthly
 *                             cap, and whether it has a cap at all
 *
 * Both are kept for BANNER_HOT_CACHE_TTL_MS. What that delays, on top of the
 * up to 60 s KV itself takes to carry a write to every location:
 *
 *  - a revoked public key is still answered for up to a minute longer;
 *  - a quota that was just reached, or just lifted (upgrade, new month's
 *    first snapshot), takes up to a minute longer to apply. The quota is
 *    recomputed every 10 minutes to begin with.
 *
 * The banner document is not kept here: a dashboard edit should show as soon
 * as KV has it.
 *
 * This module imports types only, so a test setup file can load it without
 * loading the route.
 */

import { IsolateCache } from "../lib/isolate-cache";
import type { CachedApiKey } from "./banner-cache.service";
import type { QuotaState } from "./usage.service";

export const BANNER_HOT_CACHE_TTL_MS = 60_000;

/** Key hash -> the key's mapping. Only valid public keys are stored. */
export const apiKeyCache = new IsolateCache<CachedApiKey>(BANNER_HOT_CACHE_TTL_MS);

/** `usage:` KV key (it carries the month) -> the quota state read from it. */
export const quotaCache = new IsolateCache<QuotaState>(BANNER_HOT_CACHE_TTL_MS);

/** Empty both caches and set their time limit (0 turns them off). */
export function configureBannerHotCache(options: { ttlMs: number }): void {
  for (const cache of [apiKeyCache, quotaCache]) {
    cache.configure(options);
    cache.clear();
  }
}
