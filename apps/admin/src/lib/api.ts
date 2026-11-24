// ── Types ────────────────────────────────────────────────────────────────────

export type AdminUser = {
  id: string
  name: string
  email: string
  role: string | null
  image: string | null
  banned: boolean | null
  banReason: string | null
  createdAt: string
  updatedAt: string
}

export type AdminUserDetail = AdminUser & {
  organizations: Array<{
    id: string
    name: string
    slug: string
    logo: string | null
    createdAt: string
    memberRole: string
  }>
}

export type AdminOrganization = {
  id: string
  name: string
  slug: string
  logo: string | null
  createdAt: string
  plan: string | null
  subscriptionStatus: string | null
  /** 'test' when the subscription was paid in Dodo test mode. */
  subscriptionEnvironment?: string | null
  /** Left out of every admin metric. */
  internal?: boolean
}

export type OrgMember = {
  id: string
  role: string
  userId: string
  name: string | null
  email: string
  image: string | null
  createdAt: string
}

export type AdminOrganizationDetail = {
  id: string
  name: string
  slug: string
  logo: string | null
  createdAt: string
  members: OrgMember[]
  subscription: Record<string, unknown>
  // Status-aware plan the org is entitled to now ('free' | 'pro').
  effectivePlan?: string
  // True on a self-hosted deployment: every org is unlimited.
  selfHosted?: boolean
  usage: {
    products: number
    teamMembers: number
    apiHitsThisMonth: number
  }
  // null = unlimited (Pro, self-hosted).
  effectiveLimits: {
    maxProducts: number | null
    maxApiHitsPerMonth: number | null
    maxTeamMembers: number | null
  }
  override: Record<string, unknown> | null
  internal?: { note: string | null; createdAt: string } | null
}

export type AdminAlert = {
  organizationId: string
  organizationName: string
  organizationSlug: string
  plan: string
  warnings: Array<{
    metric: string
    // 'cap': approaching an enforced cap. 'fair_use': unlimited Pro org past
    // the fair-use line (limit = the line). Optional for older API responses.
    kind?: 'cap' | 'fair_use'
    current: number
    limit: number
    percentage: number
  }>
}

export type AdminStats = {
  totalUsers: number
  totalOrganizations: number
  subscriptionsByPlan: Record<string, number>
  /** Live subscriptions billed in USD, per month (pre-tax). Test-mode subscriptions never count. */
  estimatedMRR: number
  /** Live MRR per currency, major units; currencies are never added together. Optional during a deploy window. */
  mrrByCurrency?: Record<string, number>
  /** Active Pro subscriptions paid in Dodo test mode: Pro, but not revenue. */
  testSubscriptions?: number
  activeOrgsLast30Days: number
  platformFunnel: {
    impressions: number
    clicks: number
    copies: number
    redemptions: number
    revenueSaved: number
  }
  revenueSavedThisMonth: number
  totalRevenueSaved: number
  totalProducts: number
  totalCampaigns: number
  activeCampaigns: number
  integrationsByProvider: Record<string, number>
  /** Internal workspaces, left out of every figure above. */
  internalOrganizations?: number
}

export type MoneyByCurrency = Record<string, number>

export type RevenueData = {
  summary: {
    active: number
    pastDue: number
    newThisMonth: number
    cancelledThisMonth: number
    churn: { runningOnFirst: number; ended: number; rate: number | null }
    mrrByCurrency: MoneyByCurrency
    estimatedMRR: number
    byCountry: Array<{ country: string | null; countryName: string; subscriptions: number; mrrByCurrency: MoneyByCurrency }>
    leftOut: { test: number; internal: number }
  }
  subscriptions: Array<{
    organizationId: string
    organizationName: string | null
    plan: string
    status: string
    environment: string
    recurringAmount: number | null
    currency: string | null
    billingCountry: string | null
    createdAt: string
    updatedAt: string
    currentPeriodEnd: string | null
    internal: boolean
  }>
}

export type ActivationStep = {
  key: string
  label: string
  reached: number
  stuckCount: number
  stuck: Array<{ id: string; name: string; ownerEmail: string | null; createdAt: string; daysSinceSignup: number }>
}

export type ActivationData = {
  totalOrganizations: number
  signupsLast7Days: number
  signupsLast30Days: number
  signupsByWeek: Array<{ weekStart: string; signups: number }>
  funnel: ActivationStep[]
  adoption: {
    pricingModes: Record<string, number>
    discountDelivery: Record<string, number>
    charmPricing: number
    activeCampaigns: number
    integrations: Record<string, number>
    runningAbTests: { tests: number; organizations: number }
    dealsNotEnded: { deals: number; organizations: number }
    teamsOfTwoOrMore: number
    serverApiLast30Days: number
  }
}

export type HouseSyncRecord = {
  at: string
  trigger: 'admin' | 'schedule'
  environment: 'test_mode' | 'live_mode'
  productId: string
  created: number
  updated: number
  archived: number
  failures: Array<{ country: string | null; status: number; message: string }>
  remaining: number
}

export type HealthData = {
  failedWebhooks: Array<{ provider: string; eventType: string; count: number; lastAt: string; lastError: string | null }>
  webhookBacklog: { unprocessed: number; oldest: string | null }
  integrations: Array<{
    id: string
    provider: string
    status: string
    organizationId: string
    organizationName: string
    internal: boolean
    issues: Array<{ area: string; message: string; environment?: string; at: string }>
  }>
  fxRates: { state: 'off' } | { state: 'fresh' | 'stale' | 'missing'; asOf: string | null }
  housePricing: { lastSync: HouseSyncRecord | null } | null
}

export type AuditEntry = {
  id: string
  action: string
  targetType: string
  targetId: string
  details: Record<string, unknown> | null
  createdAt: string
  adminName: string | null
  adminEmail: string | null
}

export type HouseCandidate = {
  campaignId: string
  campaignName: string
  status: string
  environment: string
  maxDiscountPercent: number
  pricingMode: string
  hasIntegration: boolean
  organizationId: string
  organizationName: string
  productName: string
  productPrice: number
  productCurrency: string
}

export type HouseDodoMatch = { status: 'match' } | { status: 'missing' } | { status: 'differs'; currency: string; amount: number }

export type HousePricingData = {
  unavailable: string | null
  dodoEnvironment: 'test_mode' | 'live_mode'
  settings: { organizationId: string; campaignId: string; campaign: HouseCandidate | null; lastSync: HouseSyncRecord | null } | null
  candidates: HouseCandidate[]
  table:
    | {
        ok: true
        fxAsOf: string | null
        charm: string
        rows: Array<{
          country: string
          countryName: string
          discount: number
          currency: string
          amount: number
          minorAmount: number
          local: boolean
          dodo: HouseDodoMatch | null
        }>
      }
    | { ok: false; problem: string }
    | null
  dodo: { ok: true; extraRules: number } | { ok: false; message: string } | null
}

export type HouseSyncResult =
  | { outcome: 'skipped'; reason: string }
  | { outcome: 'problem'; problem: string }
  | { outcome: 'synced'; record: HouseSyncRecord }

export type TopOrg = {
  organizationId: string
  name: string
  slug: string
  plan: string
  impressions: number
  clicks: number
  redemptions: number
  revenueSaved: number
}

export type Pagination = {
  page: number
  limit: number
  total: number
  totalPages: number
}

export type PaginatedResponse<T> = {
  data: T[]
  pagination: Pagination
}

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

async function apiFetch<T>(
  path: string,
  options?: RequestInit & { params?: Record<string, string | number | undefined> },
): Promise<T> {
  const { params, ...init } = options ?? {}

  let url = `${API_BASE}${path}`
  if (params) {
    const searchParams = new URLSearchParams()
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) searchParams.set(key, String(value))
    }
    const qs = searchParams.toString()
    if (qs) url += `?${qs}`
  }

  const res = await fetch(url, {
    ...init,
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...init?.headers,
    },
  })
  if (!res.ok) {
    throw new ApiError(res.status, await res.json())
  }
  return res.json()
}

// ── Typed Admin API ──────────────────────────────────────────────────────────

export const adminApi = {
  users: {
    list: (params?: { page?: number; search?: string }) =>
      apiFetch<PaginatedResponse<AdminUser>>('/v1/admin/users', { params }),
    get: (id: string) =>
      apiFetch<{ data: AdminUserDetail }>(`/v1/admin/users/${id}`).then((r) => r.data),
    ban: (id: string, reason?: string) =>
      apiFetch<{ data: AdminUser }>(`/v1/admin/users/${id}/ban`, {
        method: 'POST',
        body: JSON.stringify({ reason }),
      }).then((r) => r.data),
    unban: (id: string) =>
      apiFetch<{ data: AdminUser }>(`/v1/admin/users/${id}/unban`, {
        method: 'POST',
      }).then((r) => r.data),
  },
  organizations: {
    list: (params?: { page?: number; search?: string }) =>
      apiFetch<PaginatedResponse<AdminOrganization>>('/v1/admin/organizations', { params }),
    get: (id: string) =>
      apiFetch<{ data: AdminOrganizationDetail }>(`/v1/admin/organizations/${id}`).then((r) => r.data),
    setInternal: (id: string, internal: boolean, note?: string) =>
      apiFetch<{ data: { organizationId: string; internal: boolean } }>(`/v1/admin/organizations/${id}/internal`, {
        method: 'PUT',
        body: JSON.stringify({ internal, note }),
      }).then((r) => r.data),
    overrideLimits: (id: string, data: { maxProducts?: number | null; maxApiHitsPerMonth?: number | null; maxTeamMembers?: number | null; note?: string }) =>
      apiFetch<{ data: Record<string, unknown> }>(`/v1/admin/organizations/${id}/limits`, {
        method: 'PATCH',
        body: JSON.stringify(data),
      }).then((r) => r.data),
  },
  subscriptions: {
    list: (params?: { page?: number; plan?: string }) =>
      apiFetch<PaginatedResponse<Record<string, unknown>>>('/v1/admin/subscriptions', { params }),
  },
  alerts: {
    list: () =>
      apiFetch<{ data: AdminAlert[] }>('/v1/admin/alerts').then((r) => r.data),
  },
  revenue: {
    get: () => apiFetch<{ data: RevenueData }>('/v1/admin/revenue').then((r) => r.data),
  },
  activation: {
    get: () => apiFetch<{ data: ActivationData }>('/v1/admin/activation').then((r) => r.data),
  },
  health: {
    get: () => apiFetch<{ data: HealthData }>('/v1/admin/health').then((r) => r.data),
  },
  audit: {
    list: (page = 1) => apiFetch<PaginatedResponse<AuditEntry>>('/v1/admin/audit', { params: { page } }),
  },
  housePricing: {
    get: () => apiFetch<{ data: HousePricingData }>('/v1/admin/house-pricing').then((r) => r.data),
    set: (campaignId: string) =>
      apiFetch<{ data: { organizationId: string; campaignId: string } }>('/v1/admin/house-pricing', {
        method: 'PUT',
        body: JSON.stringify({ campaignId }),
      }).then((r) => r.data),
    sync: () =>
      apiFetch<{ data: HouseSyncResult }>('/v1/admin/house-pricing/sync', { method: 'POST' }).then((r) => r.data),
  },
  stats: {
    get: () =>
      apiFetch<{ data: AdminStats }>('/v1/admin/stats').then((r) => r.data),
    topOrgs: (limit = 10) =>
      apiFetch<{ data: TopOrg[] }>(`/v1/admin/stats/top-orgs?limit=${limit}`).then((r) => r.data),
  },
}
