import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { signIn, signOut, useSession } from '~/lib/auth'
import { BrandMark } from '~/components/brand-mark'

export const Route = createFileRoute('/login')({
  component: LoginPage,
})

function LoginPage() {
  const navigate = useNavigate()
  const { data: session, isPending } = useSession()

  if (isPending) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-border-strong border-t-accent" />
      </div>
    )
  }

  if (session) {
    const user = session.user as Record<string, unknown> | undefined
    if (user?.role === 'admin') {
      navigate({ to: '/admin' })
      return null
    }
    // Not an admin
    return (
      <div className="flex min-h-screen items-center justify-center px-6">
        <div className="max-w-sm text-center">
          <div className="mx-auto mb-5 flex h-14 w-14 items-center justify-center border border-danger bg-danger/10">
            <svg className="h-7 w-7 text-danger" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m0-10.036A11.959 11.959 0 0 1 3.598 6 11.99 11.99 0 0 0 3 9.75c0 5.592 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.249-8.25-3.286Zm0 13.036h.008v.008H12v-.008Z" />
            </svg>
          </div>
          <h1 className="font-display text-2xl font-bold text-text-primary">Access denied</h1>
          <p className="mt-3 text-base text-text-secondary">
            You&apos;re signed in as{' '}
            <span className="font-mono text-sm text-text-primary">{session.user?.email}</span>, which
            doesn&apos;t have admin access.
          </p>
          <button
            type="button"
            onClick={async () => {
              await signOut()
              window.location.reload()
            }}
            className="mt-6 cursor-pointer border border-border-strong px-4 py-2.5 text-sm font-medium text-text-primary transition-colors hover:border-accent hover:text-accent"
          >
            Sign out &amp; try another account
          </button>
        </div>
      </div>
    )
  }

  const handleOAuth = () => {
    signIn.social({
      provider: 'google',
      callbackURL: `${window.location.origin}/admin`,
      errorCallbackURL: `${window.location.origin}/login?error=oauth_failed`,
    })
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-bg px-6">
      <div className="w-full max-w-sm space-y-8">
        {/* Logo & Title */}
        <div className="text-center">
          <div className="flex items-center justify-center gap-3">
            <BrandMark className="h-8 w-8" />
            <h1 className="font-display text-3xl font-bold tracking-tight text-text-primary">
              GoPayLocal
            </h1>
          </div>
          <p className="eyebrow mt-2 text-accent">// platform admin</p>
          <p className="mt-3 text-base text-text-secondary">
            Restricted access — administrators only.
          </p>
        </div>

        {/* Auth Card */}
        <div className="border border-border bg-surface p-8">
          <h2 className="mb-6 text-center text-base font-semibold text-text-primary">
            Sign in to continue
          </h2>

          <button
            type="button"
            onClick={handleOAuth}
            className="flex w-full cursor-pointer items-center justify-center gap-3 border border-border-strong bg-surface-raised px-4 py-3 text-sm font-medium text-text-primary transition-colors hover:border-accent hover:text-accent focus:outline-none focus:border-accent"
          >
            <svg className="h-5 w-5" viewBox="0 0 24 24">
              <path
                d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"
                fill="#4285F4"
              />
              <path
                d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                fill="#34A853"
              />
              <path
                d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
                fill="#FBBC05"
              />
              <path
                d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
                fill="#EA4335"
              />
            </svg>
            Continue with Google
          </button>
        </div>
      </div>
    </div>
  )
}
