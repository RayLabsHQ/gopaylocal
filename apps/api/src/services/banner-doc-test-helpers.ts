// Test-only helper (imported by unit tests, never by the Worker).
//
// Builds a current-version KV banner document (services/banner-cache.service.ts)
// for tests that seed `banner-config:{apiKeyId}` directly and exercise the
// endpoint's KV fast path. Documents of another version are cache misses (the
// endpoint goes to Postgres), so hand-written older shapes no longer work.

import type { BannerConfig } from "@gopaylocal/shared/types";
import {
  BANNER_DOC_VERSION,
  type CachedBannerConfig,
  type CachedCampaign,
  type CachedCountryData,
  type CampaignPricing,
} from "./banner-cache.service";

export const TEST_BANNER: BannerConfig = {
  position: "bottom",
  messageTemplate: "{{country}} {{code}} {{discount}}",
  ctaText: "Copy Code",
  backgroundColor: "#000",
  textColor: "#fff",
  ctaColor: "#f00",
  ctaTextColor: "#fff",
  showFlag: true,
  showCloseBtn: true,
};

/** India at 40% with code PPP40: what most fast-path tests need. */
export const TEST_COUNTRIES: Record<string, CachedCountryData> = {
  IN: { discount: 40, tier: 3, code: "PPP40", countryName: "India" },
};

/** A $19 product without charm pricing. */
export const TEST_PRICING: CampaignPricing = { currency: "USD", basePrice: 19, charm: "none" };

export function cachedCampaign(overrides: Partial<CachedCampaign> = {}): CachedCampaign {
  return {
    environment: "live",
    allowedDomains: null,
    banner: TEST_BANNER,
    pricing: TEST_PRICING,
    countries: TEST_COUNTRIES,
    ...overrides,
  };
}

/**
 * A document where one product is served by one campaign (the default
 * product), like a single-product organization.
 */
export function bannerDocForCampaign(opts: {
  campaignId?: string;
  productId?: string;
  organizationId?: string;
  allowedDomains?: string[] | null;
  countries?: Record<string, CachedCountryData>;
  banner?: BannerConfig;
  showBranding?: boolean;
  environment?: "live" | "test";
  pricing?: CampaignPricing;
  /** Defaults to now: a fresh document, not due for a refresh. */
  builtAt?: number;
} = {}): CachedBannerConfig {
  const campaignId = opts.campaignId ?? "camp_1";
  const productId = opts.productId ?? "prod_1";
  return {
    v: BANNER_DOC_VERSION,
    organizationId: opts.organizationId ?? "org_1",
    epoch: "test-epoch",
    builtAt: opts.builtAt ?? Date.now(),
    showBranding: opts.showBranding ?? true,
    defaultProductId: productId,
    products: { [productId]: { kind: "campaign", campaignId } },
    campaigns: {
      [campaignId]: cachedCampaign({
        environment: opts.environment ?? "live",
        allowedDomains: opts.allowedDomains ?? null,
        countries: opts.countries ?? TEST_COUNTRIES,
        banner: opts.banner ?? TEST_BANNER,
        pricing: opts.pricing ?? TEST_PRICING,
      }),
    },
  };
}
