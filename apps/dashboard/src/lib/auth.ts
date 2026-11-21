import { createAuthClient } from 'better-auth/react'
import { organizationClient } from 'better-auth/client/plugins'

const authClient = createAuthClient({
  baseURL: import.meta.env.VITE_API_URL || 'http://localhost:8787',
  plugins: [organizationClient()],
})

export const { signIn, signUp, signOut, useSession } = authClient
export const organization = authClient.organization

type SessionData = {
  user?: Record<string, unknown>
  session?: Record<string, unknown>
} | null | undefined

export function getActiveTeamId(data: SessionData): string {
  if (!data) return ''

  // activeOrganizationId lives on the session object (set via organization.setActive)
  const sessionOrgId = data.session?.activeOrganizationId
  if (typeof sessionOrgId === 'string' && sessionOrgId.length > 0) {
    return sessionOrgId
  }

  // Fallback: check user object fields
  const user = data.user
  if (!user) return ''

  for (const key of ['activeTeamId', 'activeOrganizationId', 'organizationId'] as const) {
    const val = user[key]
    if (typeof val === 'string' && val.length > 0) return val
  }

  return ''
}
