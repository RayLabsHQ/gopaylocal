import type {
  PricingMode,
  DiscountDelivery,
  CharmPricingStrategy,
  CampaignStatus,
  IntegrationProvider,
  BannerConfig,
  Plan,
  Limit,
  ExperimentStatus,
} from '@gopaylocal/shared'
import type { FxRatesView } from '@gopaylocal/shared/currency'
import type { DealCodeSource, DealPhase } from '@gopaylocal/shared/deals'

// ── Types ────────────────────────────────────────────────────────────────────

export type Product = {
  id: string
  name: string
  url: string
  currency: string
  basePrice: number
  /** Saved with the sidebar's Live/Test mode at creation; lists filter on it. */
  environment: 'live' | 'test'
  organizationId: string
  createdAt: string
  updatedAt: string
}

export type Campaign = {
  id: string
  name: string
  productId: string
  integrationId: string | null
  pricingMode: PricingMode
  discountDelivery: DiscountDelivery
  charmPricingStrategy: CharmPricingStrategy
  maxDiscountPercent: number
  status: CampaignStatus
  organizationId: string
  discountOverrides: Record<string, number> | null
  couponPrefix: string | null
  allowedDomains: string[] | null
  /** Saved with the sidebar's Live/Test mode at creation; test campaigns use the providers' test keys. */
  environment: 'live' | 'test'
  createdAt: string
  updatedAt: string
}

/**
 * GET /v1/teams/:orgId/fx-rates: the stored rates document, as localPricing()
 * takes it. The type is shared with the route, which checks its body against it.
 */
export type { FxRatesView }

export type IntegrationEnvironment = 'live' | 'test'

/** Redemption-tracking webhook state for one environment (each environment has its own endpoint). */
export type IntegrationWebhook = {
  status: 'active' | 'missing' | 'needs_attention'
}

/** Last problem seen per area (coupon creation, webhook setup/delivery, credentials). */
export type IntegrationHealthIssue = {
  area: 'coupon_sync' | 'webhook_setup' | 'webhook_delivery' | 'credentials'
  message: string
  environment?: IntegrationEnvironment
  at: string
}

/** Result of a webhook provisioning attempt (connect / re-create). */
export type WebhookSetupResult = {
  status: 'active' | 'failed' | 'unsupported' | 'skipped'
  environment: IntegrationEnvironment | null
  error?: string
}

export type Integration = {
  id: string
  provider: IntegrationProvider
  providerAccountId: string | null
  /** Test-mode account when it differs from the live one; null means test uses providerAccountId. */
  testProviderAccountId: string | null
  status: string
  hasLiveCredentials: boolean
  hasTestCredentials: boolean
  /** null for an environment without credentials. */
  webhooks: Record<IntegrationEnvironment, IntegrationWebhook | null>
  health: IntegrationHealthIssue[]
  organizationId: string
  createdAt: string
  updatedAt: string
}

/** Connect / re-create responses also say what happened to the webhook. */
export type IntegrationWithSetup = Integration & { webhookSetup: WebhookSetupResult }

export type IntegrationDisconnectResult = {
  success: boolean
  /** Active auto-apply campaigns paused because they lost their provider. */
  pausedCampaigns: number
  /** Codes still live at the provider (they may be in customers' hands). */
  codesLeftAtProvider: number
}

// Human-friendly labels for campaign enums. Naive title-casing produces wrong
// results ("Ppp Factor", "Banner Coupon"), so map them explicitly.
export const PRICING_MODE_LABELS: Record<PricingMode, string> = {
  ppp_factor: 'PPP Factor',
  group: 'Group',
  custom: 'Custom',
}

export const DISCOUNT_DELIVERY_LABELS: Record<DiscountDelivery, string> = {
  banner_coupon: 'Banner + Coupon Code',
  // The merchant's own checkout applies the code; same name as the form option.
  auto_apply: 'Auto-apply at checkout',
}

// Human-friendly provider names for selectors and labels.
export const PROVIDER_LABELS: Record<IntegrationProvider, string> = {
  dodopayments: 'Dodo Payments',
  stripe: 'Stripe',
  paddle: 'Paddle',
  gumroad: 'Gumroad',
  chargebee: 'Chargebee',
  whop: 'Whop',
  polar: 'Polar',
  creem: 'Creem',
  woocommerce: 'WooCommerce',
}

export type ApiKey = {
  id: string
  name: string
  keyPrefix: string
  keyType: 'public' | 'secret'
  // Plaintext key — only present for public keys created after the full-key
  // migration (public keys are public by design). Null for secret keys and for
  // legacy public keys created before the column existed.
  fullKey: string | null
  createdAt: string
  lastUsedAt: string | null
  // Who created the key. Null for keys created before this was recorded, or
  // whose creator's account was deleted.
  createdBy: { id: string; name: string | null } | null
}

export type TeamMember = {
  id: string
  userId: string
  name: string | null
  email: string
  image: string | null
  role: string
  createdAt: string
}

export type OverviewStats = {
  totalImpressions: number
  totalClicks: number
  totalCopies: number
  totalRedemptions: number
  /** USD redemptions only; see revenueSavedByCurrency. */
  totalRevenueSaved: number
  /** Revenue saved per ISO 4217 code, in that currency's major unit. Never summed across currencies. */
  revenueSavedByCurrency: Record<string, number>
}

export type CountryAnalytics = {
  countryCode: string | null
  impressions: number
  clicks: number
  copies: number
  redemptions: number
  /** USD redemptions only; see revenueSavedByCurrency. */
  revenueSaved: number
  revenueSavedByCurrency: Record<string, number>
}

// Ranges the analytics endpoints can actually serve. The API clamps `from` to
// the plan's retention window (Free = 7 days), so wider selections silently
// return the retained slice rather than erroring.
export type AnalyticsRangeDays = 7 | 30 | 90 | 365

export type ProviderProduct = {
  providerProductId: string
  name: string
  price: number | null
  currency: string | null
  url: string | null
}

export type ImportProductsResult = {
  imported: number
  limitReached: boolean
  // Selected products that were not imported because the provider prices them
  // in a currency GoPayLocal does not support. Optional during a deploy window.
  skipped?: Array<{
    providerProductId: string
    name: string
    currency: string
    reason: 'unsupported_currency'
  }>
}

export type BillingInfo = {
  // Stored plan (legacy 'business' is reported as 'pro').
  plan: Plan
  // What the org is entitled to right now: a lapsed Pro subscription reads
  // plan 'pro' but effectivePlan 'free'. Optional during a deploy window.
  effectivePlan?: Plan
  status: string
  currentPeriodEnd: string | null
  dodoCustId: string | null
  dodoSubId: string | null
  // What Dodo charges each month, pre-tax, in the smallest unit of `currency`.
  // Null until a subscription event carried it.
  recurringAmount?: number | null
  currency?: string | null
  // Self-hosted deployments have no billing: hide checkout/upgrade UI.
  selfHosted?: boolean
  billingEnabled?: boolean
}

// `max: null` means unlimited (Pro and self-hosted). Never a bar, never a ratio.
export type UsageMeterInfo = { current: number; max: Limit }

export type UsageInfo = {
  plan: Plan
  selfHosted?: boolean
  billingEnabled?: boolean
  // Flat product fields (back-compat with the product-creation / import gates).
  // null = unlimited.
  maxProducts: Limit
  currentCount: number
  remaining: number | null
  // Structured per-resource meters for the billing usage panel.
  meters: {
    products: UsageMeterInfo
    apiHits: UsageMeterInfo
    teamMembers: UsageMeterInfo
  }
}

// Per-member product scoping. `allProducts: true` (productIds === []) means the
// member can access every product; otherwise they're limited to `productIds`.
export type ProductAccess = {
  allProducts: boolean
  productIds: string[]
}

// A/B test between two campaigns of one product. A = control, B = variant;
// trafficSplitB is the percent of visitors the banner sends to B.
export type ExperimentArm = {
  id: string
  name: string
  status: CampaignStatus
}

export type ExperimentRow = {
  id: string
  organizationId: string
  productId: string
  environment: 'live' | 'test'
  name: string
  status: ExperimentStatus
  campaignAId: string
  campaignBId: string
  // The arms' names when the test started; shown once a campaign is deleted.
  campaignAName: string
  campaignBName: string
  trafficSplitB: number
  winnerCampaignId: string | null
  startedAt: string
  endedAt: string | null
  createdAt: string
  updatedAt: string
}

// List and detail responses carry each arm's current name and status (null
// once the campaign is deleted; an ended test is kept); create/update/end
// return the bare row.
export type Experiment = ExperimentRow & {
  campaignA: ExperimentArm | null
  campaignB: ExperimentArm | null
}

// Rates are fractions (0.04 = 4%); null when the denominator is 0.
export type ExperimentArmResult = {
  campaignId: string
  impressions: number
  clicks: number
  copies: number
  redemptions: number
  // Discount given, per currency in major units ({ USD: 120, INR: 4000 });
  // currencies are never added together.
  revenueSavedByCurrency: Record<string, number>
  clickRate: number | null
  copyRate: number | null
  conversionRate: number | null
  redemptionsPerCopy: number | null
}

export type ExperimentResults = {
  granularity: 'day'
  from: string
  to: string | null
  truncatedByRetention: boolean
  a: ExperimentArmResult
  b: ExperimentArmResult
  observedShareB: number | null
}

export type ExperimentWithResults = Experiment & { results: ExperimentResults }

// A holiday deal of a campaign (GET /v1/teams/:orgId/campaigns/:campaignId/deals).
export type Deal = {
  id: string
  campaignId: string
  name: string
  discountPercent: number
  /** ISO 8601, UTC. The deal runs from startsAt up to, not including, endsAt. */
  startsAt: string
  endsAt: string
  messageTemplate: string
  codeSource: DealCodeSource
  /** The code visitors are given; null for a deal without one, or while its code is missing. */
  code: string | null
  /** False when the deal should have a code at the payment platform and has none: it is not offered. */
  codeReady: boolean
  phase: DealPhase
  createdAt: string
  updatedAt: string
}

export type CreateDealInput = {
  name: string
  discountPercent: number
  startsAt: string
  endsAt: string
  messageTemplate?: string
  code?: string
}

export type UpdateDealInput = Partial<Pick<CreateDealInput, 'name' | 'startsAt' | 'endsAt' | 'messageTemplate'>>

// ── API Client ───────────────────────────────────────────────────────────────

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:8787'

export class ApiError extends Error {
  constructor(
    public status: number,
    public data: Record<string, unknown>,
  ) {
    super((data?.error as string) || 'API Error')
  }
}

async function apiFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...options?.headers,
    },
  })
  if (!res.ok) {
    throw new ApiError(res.status, await res.json())
  }
  return res.json()
}

const DAY_MS = 86_400_000

// Rollups are only ever written at 'day' granularity, but the analytics
// endpoints default `period` to 'month' — leaving it unset matches zero rows.
// `from` is floored to UTC midnight so the window covers whole rollup buckets.
function analyticsRangeQuery(days: AnalyticsRangeDays): string {
  const now = new Date()
  const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  const from = new Date(todayUtc - (days - 1) * DAY_MS).toISOString()
  return `?period=day&from=${encodeURIComponent(from)}`
}

/** A parity group with its countries (GET /v1/teams/:orgId/parity-groups). */
export type ParityGroup = {
  id: string
  name: string
  discountPercent: number
  sortOrder: number
  countries: string[]
}

// ── Typed API Methods ────────────────────────────────────────────────────────

export const api = {
  products: {
    list: (teamId: string, env?: 'live' | 'test') =>
      apiFetch<{ data: Product[] }>(`/v1/teams/${teamId}/products${env ? `?environment=${env}` : ''}`).then((r) => r.data),
    get: (teamId: string, productId: string) =>
      apiFetch<{ data: Product }>(`/v1/teams/${teamId}/products/${productId}`).then((r) => r.data),
    create: (teamId: string, data: Omit<Product, 'id' | 'organizationId' | 'createdAt' | 'updatedAt'>) =>
      apiFetch<{ data: Product }>(`/v1/teams/${teamId}/products`, {
        method: 'POST',
        body: JSON.stringify(data),
      }).then((r) => r.data),
    update: (teamId: string, productId: string, data: Partial<Product>) =>
      apiFetch<{ data: Product }>(`/v1/teams/${teamId}/products/${productId}`, {
        method: 'PATCH',
        body: JSON.stringify(data),
      }).then((r) => r.data),
    delete: (teamId: string, productId: string) =>
      apiFetch<{ success: boolean }>(`/v1/teams/${teamId}/products/${productId}`, {
        method: 'DELETE',
      }),
  },

  campaigns: {
    list: (teamId: string, env?: 'live' | 'test') =>
      apiFetch<{ data: Campaign[] }>(`/v1/teams/${teamId}/campaigns${env ? `?environment=${env}` : ''}`).then((r) => r.data),
    get: (teamId: string, campaignId: string) =>
      apiFetch<{ data: Campaign }>(`/v1/teams/${teamId}/campaigns/${campaignId}`).then((r) => r.data),
    create: (
      teamId: string,
      data: {
        productId: string
        integrationId?: string | null
        name: string
        status?: CampaignStatus
        pricingMode?: PricingMode
        discountDelivery?: DiscountDelivery
        charmPricingStrategy?: CharmPricingStrategy
        maxDiscountPercent?: number
        discountOverrides?: Record<string, number> | null
        couponPrefix?: string | null
        allowedDomains?: string[] | null
        // Required, not defaulted: the API would otherwise save the campaign
        // as live whatever mode the dashboard is in.
        environment: 'live' | 'test'
      },
    ) =>
      apiFetch<{ data: Campaign }>(`/v1/teams/${teamId}/campaigns`, {
        method: 'POST',
        body: JSON.stringify(data),
      }).then((r) => r.data),
    update: (teamId: string, campaignId: string, data: Partial<Campaign>) =>
      apiFetch<{ data: Campaign }>(`/v1/teams/${teamId}/campaigns/${campaignId}`, {
        method: 'PATCH',
        body: JSON.stringify(data),
      }).then((r) => r.data),
    delete: (teamId: string, campaignId: string) =>
      apiFetch<{ success: boolean }>(`/v1/teams/${teamId}/campaigns/${campaignId}`, {
        method: 'DELETE',
      }),
  },

  experiments: {
    list: (
      teamId: string,
      filters: { environment?: 'live' | 'test'; productId?: string; campaignId?: string; status?: ExperimentStatus } = {},
    ) => {
      const qs = new URLSearchParams(
        Object.entries(filters).filter((e): e is [string, string] => typeof e[1] === 'string' && e[1] !== ''),
      ).toString()
      return apiFetch<{ data: Experiment[] }>(`/v1/teams/${teamId}/experiments${qs ? `?${qs}` : ''}`).then((r) => r.data)
    },
    get: (teamId: string, experimentId: string) =>
      apiFetch<{ data: ExperimentWithResults }>(`/v1/teams/${teamId}/experiments/${experimentId}`).then((r) => r.data),
    create: (
      teamId: string,
      data: { productId: string; campaignAId: string; campaignBId: string; name: string; trafficSplitB?: number },
    ) =>
      apiFetch<{ data: ExperimentRow }>(`/v1/teams/${teamId}/experiments`, {
        method: 'POST',
        body: JSON.stringify(data),
      }).then((r) => r.data),
    update: (teamId: string, experimentId: string, data: { name?: string; trafficSplitB?: number }) =>
      apiFetch<{ data: ExperimentRow }>(`/v1/teams/${teamId}/experiments/${experimentId}`, {
        method: 'PATCH',
        body: JSON.stringify(data),
      }).then((r) => r.data),
    end: (teamId: string, experimentId: string, winnerCampaignId: string) =>
      apiFetch<{ data: ExperimentRow; pausedCampaignId: string | null }>(`/v1/teams/${teamId}/experiments/${experimentId}/end`, {
        method: 'POST',
        body: JSON.stringify({ winnerCampaignId }),
      }),
  },

  integrations: {
    list: (teamId: string) =>
      apiFetch<{ data: Integration[] }>(`/v1/teams/${teamId}/integrations`).then((r) => r.data),
    connect: (teamId: string, provider: IntegrationProvider, config: Record<string, unknown>) =>
      apiFetch<{ data: IntegrationWithSetup }>(`/v1/teams/${teamId}/integrations`, {
        method: 'POST',
        body: JSON.stringify({ provider, ...config }),
      }).then((r) => r.data),
    setupWebhook: (teamId: string, integrationId: string, environment: IntegrationEnvironment) =>
      apiFetch<{ data: IntegrationWithSetup }>(
        `/v1/teams/${teamId}/integrations/${integrationId}/webhook?environment=${environment}`,
        { method: 'POST' },
      ).then((r) => r.data),
    disconnect: (teamId: string, integrationId: string) =>
      apiFetch<IntegrationDisconnectResult>(`/v1/teams/${teamId}/integrations/${integrationId}`, {
        method: 'DELETE',
      }),
    test: (teamId: string, integrationId: string, env?: 'live' | 'test') =>
      apiFetch<{ ok: boolean; message?: string }>(`/v1/teams/${teamId}/integrations/${integrationId}/test${env ? `?environment=${env}` : ''}`, {
        method: 'POST',
      }),
    listProducts: (teamId: string, integrationId: string, env?: 'live' | 'test') =>
      apiFetch<{ data: ProviderProduct[] }>(`/v1/teams/${teamId}/integrations/${integrationId}/products${env ? `?environment=${env}` : ''}`).then((r) => r.data),
    importProducts: (teamId: string, integrationId: string, productIds: string[], env?: 'live' | 'test') =>
      apiFetch<{ data: ImportProductsResult }>(`/v1/teams/${teamId}/integrations/${integrationId}/products/import`, {
        method: 'POST',
        body: JSON.stringify({ productIds, environment: env }),
      }).then((r) => r.data),
  },

  parityGroups: {
    // An empty list means the workspace has no parity groups of its own:
    // group-mode campaigns then use the default tiers.
    list: (teamId: string) =>
      apiFetch<{ data: ParityGroup[] }>(`/v1/teams/${teamId}/parity-groups`).then((r) => r.data),
  },

  deals: {
    list: (teamId: string, campaignId: string) =>
      apiFetch<{ data: Deal[] }>(`/v1/teams/${teamId}/campaigns/${campaignId}/deals`).then((r) => r.data),
    create: (teamId: string, campaignId: string, data: CreateDealInput) =>
      apiFetch<{ data: Deal }>(`/v1/teams/${teamId}/campaigns/${campaignId}/deals`, {
        method: 'POST',
        body: JSON.stringify(data),
      }).then((r) => r.data),
    update: (teamId: string, campaignId: string, dealId: string, data: UpdateDealInput) =>
      apiFetch<{ data: Deal }>(`/v1/teams/${teamId}/campaigns/${campaignId}/deals/${dealId}`, {
        method: 'PATCH',
        body: JSON.stringify(data),
      }).then((r) => r.data),
    // `warning` is set when the code could not be removed at the payment platform yet.
    delete: (teamId: string, campaignId: string, dealId: string) =>
      apiFetch<{ success: boolean; warning?: string }>(`/v1/teams/${teamId}/campaigns/${campaignId}/deals/${dealId}`, {
        method: 'DELETE',
      }),
  },

  banner: {
    get: (teamId: string, campaignId: string) =>
      apiFetch<{ data: BannerConfig }>(`/v1/teams/${teamId}/banner-configs/${campaignId}`).then((r) => r.data),
    update: (teamId: string, campaignId: string, data: Partial<BannerConfig>) =>
      apiFetch<{ data: BannerConfig }>(`/v1/teams/${teamId}/banner-configs/${campaignId}`, {
        method: 'PUT',
        body: JSON.stringify(data),
      }).then((r) => r.data),
  },

  // Today's exchange rates (units per USD), the ones the banner endpoint
  // converts prices with; the banner editor's preview runs the same
  // localPricing() over them. `available: false` when there are none usable.
  fxRates: {
    get: (teamId: string) =>
      apiFetch<{ data: FxRatesView }>(`/v1/teams/${teamId}/fx-rates`).then((r) => r.data),
  },

  analytics: {
    overview: (teamId: string, days: AnalyticsRangeDays) =>
      apiFetch<{ data: OverviewStats }>(
        `/v1/teams/${teamId}/analytics/overview${analyticsRangeQuery(days)}`,
      ).then((r) => r.data),
    byCountry: (teamId: string, days: AnalyticsRangeDays) =>
      apiFetch<{ data: CountryAnalytics[] }>(
        `/v1/teams/${teamId}/analytics/by-country${analyticsRangeQuery(days)}`,
      ).then((r) => r.data),
  },

  billing: {
    get: (teamId: string) =>
      apiFetch<{ data: BillingInfo }>(`/v1/teams/${teamId}/billing`).then((r) => r.data),
    usage: (teamId: string) =>
      apiFetch<{ data: UsageInfo }>(`/v1/teams/${teamId}/billing/usage`).then((r) => r.data),
    createCheckout: (teamId: string) =>
      apiFetch<{ data: { checkoutUrl: string; sessionId: string } }>(`/v1/teams/${teamId}/billing/checkout`, {
        method: 'POST',
        body: JSON.stringify({ plan: 'pro' }),
      }).then((r) => r.data),
    createPortal: (teamId: string) =>
      apiFetch<{ data: { portalUrl: string } }>(`/v1/teams/${teamId}/billing/portal`, {
        method: 'POST',
      }).then((r) => r.data),
  },

  team: {
    members: (teamId: string) =>
      apiFetch<{ data: TeamMember[] }>(`/v1/teams/${teamId}/members`).then((r) => r.data),
    invitations: (teamId: string) =>
      apiFetch<{ data: Array<{ id: string; email: string; role: string | null; status: string; expiresAt: string; createdAt: string }> }>(`/v1/teams/${teamId}/invitations`).then((r) => r.data),
    apiKeys: (teamId: string) =>
      apiFetch<{ data: ApiKey[] }>(`/v1/teams/${teamId}/api-keys`).then((r) => r.data),
    createApiKey: (teamId: string, data: { name: string; keyType: 'public' | 'secret' }) =>
      apiFetch<{ data: ApiKey & { key: string } }>(`/v1/teams/${teamId}/api-keys`, {
        method: 'POST',
        body: JSON.stringify(data),
      }).then((r) => r.data),
    deleteApiKey: (teamId: string, keyId: string) =>
      apiFetch<{ success: boolean }>(`/v1/teams/${teamId}/api-keys/${keyId}`, {
        method: 'DELETE',
      }),
    deleteOrganization: (teamId: string) =>
      apiFetch<{ success: boolean }>(`/v1/teams/${teamId}`, {
        method: 'DELETE',
      }),
    // Read a member's product scope (admin+). [] / allProducts=true means full access.
    memberProductAccess: (teamId: string, userId: string) =>
      apiFetch<{ data: ProductAccess }>(
        `/v1/teams/${teamId}/members/${userId}/product-access`,
      ).then((r) => r.data),
    // Replace a member's product access (owner only): all products, or exactly
    // the listed ones, where an empty list means no products.
    setMemberProductAccess: (
      teamId: string,
      userId: string,
      scope: { allProducts: true } | { productIds: string[] },
    ) =>
      apiFetch<{ data: ProductAccess }>(
        `/v1/teams/${teamId}/members/${userId}/product-access`,
        { method: 'PUT', body: JSON.stringify(scope) },
      ).then((r) => r.data),
  },
}
