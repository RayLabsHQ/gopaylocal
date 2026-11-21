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
  estimatedMRR: number
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
}

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
  stats: {
    get: () =>
      apiFetch<{ data: AdminStats }>('/v1/admin/stats').then((r) => r.data),
    topOrgs: (limit = 10) =>
      apiFetch<{ data: TopOrg[] }>(`/v1/admin/stats/top-orgs?limit=${limit}`).then((r) => r.data),
  },
}
