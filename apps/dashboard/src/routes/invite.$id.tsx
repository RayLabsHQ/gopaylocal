import { createFileRoute, useNavigate, useParams } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { organization, useSession } from '~/lib/auth'

export const Route = createFileRoute('/invite/$id')({
  component: InvitePage,
})

function InvitePage() {
  const { id: invitationId } = useParams({ from: '/invite/$id' })
  const navigate = useNavigate()
  const { data: session, isPending: sessionPending } = useSession()
  const [status, setStatus] = useState<'loading' | 'accepting' | 'success' | 'error'>('loading')
  const [error, setError] = useState<string | null>(null)

  // If not logged in, send the user to /login with a return destination so they
  // can pick their own provider (Google OR GitHub) and land back on the invite.
  // The old code hardcoded Google here, which dead-ended GitHub users.
  useEffect(() => {
    if (!sessionPending && !session) {
      navigate({
        to: '/login',
        search: { redirect: `/invite/${invitationId}` },
      })
    }
  }, [session, sessionPending, invitationId, navigate])

  // If logged in, accept the invitation
  useEffect(() => {
    if (!session || status !== 'loading') return

    setStatus('accepting')
    organization
      .acceptInvitation({ invitationId })
      .then((res) => {
        if (res.error) {
          setError(res.error.message || 'Failed to accept invitation.')
          setStatus('error')
          return
        }
        setStatus('success')
        sessionStorage.removeItem('pendingInvite')
        // Redirect to dashboard after a brief moment
        setTimeout(() => {
          window.location.href = '/dashboard'
        }, 1500)
      })
      .catch((err) => {
        setError(err?.message || 'Something went wrong.')
        setStatus('error')
      })
  }, [session, invitationId, status])

  if (sessionPending || status === 'loading' || status === 'accepting') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-bg font-body">
        <div className="text-center">
          <div className="mx-auto h-8 w-8 animate-spin rounded-full border-4 border-border border-t-brand" />
          <p className="mt-4 text-sm text-text-secondary">
            {status === 'accepting' ? 'Accepting invitation...' : 'Loading...'}
          </p>
        </div>
      </div>
    )
  }

  if (status === 'success') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-bg font-body">
        <div className="max-w-sm text-center">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-success-light">
            <svg className="h-7 w-7 text-success" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="m4.5 12.75 6 6 9-13.5" />
            </svg>
          </div>
          <h1 className="mt-4 font-display text-2xl font-semibold text-text-primary">
            You're in!
          </h1>
          <p className="mt-2 text-base text-text-secondary">
            Invitation accepted. Redirecting to dashboard...
          </p>
        </div>
      </div>
    )
  }

  // Error state
  return (
    <div className="flex min-h-screen items-center justify-center bg-bg font-body">
      <div className="max-w-sm text-center">
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-brand-light">
          <svg className="h-7 w-7 text-brand-text" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
          </svg>
        </div>
        <h1 className="mt-4 font-display text-2xl font-semibold text-text-primary">
          Invitation Failed
        </h1>
        <p className="mt-2 text-base text-text-secondary">
          {error || 'This invitation may have expired or already been used.'}
        </p>
        <button
          type="button"
          onClick={() => navigate({ to: '/dashboard' })}
          className="mt-6 border border-border px-4 py-2 text-sm font-medium text-text-primary transition-colors hover:bg-surface"
        >
          Go to Dashboard
        </button>
      </div>
    </div>
  )
}
