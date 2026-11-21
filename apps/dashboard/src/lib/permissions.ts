import { useQuery } from '@tanstack/react-query'
import { can as roleCan, resolveRole, type Permission, type WorkspaceRole } from '@gopaylocal/shared'
import { api } from './api'
import { getActiveTeamId, useSession } from './auth'

// The dashboard side of the permission table in packages/shared/src/permissions.
// Controls a role cannot use are hidden or disabled from the same table the
// API enforces, so a member never gets a button that answers 403. The API
// stays the enforcement point; this only decides what to show.
//
// The role comes from the workspace's member list (it is not on the session).
// The query shares its cache key with the Team tab, so it is fetched once.

export function useMyRole(): { role: WorkspaceRole | null; isPending: boolean } {
  const { data: session } = useSession()
  const teamId = getActiveTeamId(session)
  const { data: members, isPending } = useQuery({
    queryKey: ['org-members', teamId],
    queryFn: () => api.team.members(teamId),
    enabled: !!teamId,
  })
  const raw = members?.find((m) => m.userId === session?.user?.id)?.role
  return { role: resolveRole(raw), isPending }
}

/**
 * `can(permission)` is false until the role has loaded, so controls appear
 * once it is known instead of flashing for roles that cannot use them.
 */
export function usePermissions() {
  const { role, isPending } = useMyRole()
  return {
    role,
    isPending,
    can: (permission: Permission) => role !== null && roleCan(role, permission),
  }
}
