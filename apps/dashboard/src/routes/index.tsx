import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useSession, getActiveTeamId, organization } from '~/lib/auth'
import { useEffect, useRef } from 'react'

export const Route = createFileRoute('/')({
  component: IndexPage,
})

function IndexPage() {
  const { data: session, isPending } = useSession()
  const navigate = useNavigate()
  const restoringRef = useRef(false)

  useEffect(() => {
    if (isPending) return

    if (!session) {
      navigate({ to: '/login' })
      return
    }

    const teamId = getActiveTeamId(session)
    if (teamId) {
      navigate({ to: '/dashboard' })
      return
    }

    // No active org in session — try to restore from user's memberships
    if (restoringRef.current) return
    restoringRef.current = true

    organization.list().then(({ data: orgs }) => {
      const first = orgs?.[0]
      if (first) {
        return organization.setActive({ organizationId: first.id }).then(() => {
          window.location.href = '/dashboard'
        })
      }
      navigate({ to: '/onboarding' })
    }).catch(() => {
      navigate({ to: '/onboarding' })
    })
  }, [session, isPending, navigate])

  return (
    <div className="flex min-h-screen items-center justify-center bg-bg">
      <div className="h-8 w-8 animate-spin rounded-full border-4 border-border border-t-brand" />
    </div>
  )
}
