import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useSession } from '~/lib/auth'
import { useEffect } from 'react'

export const Route = createFileRoute('/')({
  component: IndexPage,
})

function IndexPage() {
  const { data: session, isPending } = useSession()
  const navigate = useNavigate()

  useEffect(() => {
    if (!isPending) {
      if (session) {
        const user = session.user as Record<string, unknown> | undefined
        if (user?.role === 'admin') {
          navigate({ to: '/admin' })
        } else {
          navigate({ to: '/login' })
        }
      } else {
        navigate({ to: '/login' })
      }
    }
  }, [session, isPending, navigate])

  return (
    <div className="flex min-h-screen items-center justify-center bg-bg">
      <div className="h-8 w-8 animate-spin rounded-full border-4 border-border-strong border-t-accent" />
    </div>
  )
}
