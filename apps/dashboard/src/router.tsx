import { createRouter, type ErrorComponentProps } from '@tanstack/react-router'
import { routeTree } from './routeTree.gen'

function NotFound() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-bg px-6 font-body">
      <div className="w-full max-w-md border border-border bg-surface p-10 text-center">
        <p className="font-display text-6xl font-bold tabular-nums tracking-tight text-text-primary">404</p>
        <p className="mt-3 text-base text-text-secondary">
          This page doesn't exist or has moved.
        </p>
        <a
          href="/dashboard"
          className="mt-8 inline-block bg-brand px-5 py-2.5 text-sm font-medium text-white"
        >
          Back to dashboard
        </a>
      </div>
    </div>
  )
}

// TanStack Router types a boundary error as `unknown` (anything can be thrown).
function ErrorScreen({ error }: ErrorComponentProps) {
  const message = error instanceof Error ? error.message : String(error)
  return (
    <div className="flex min-h-screen items-center justify-center bg-bg px-6 font-body">
      <div className="w-full max-w-md border border-border bg-surface p-10 text-center">
        <p className="font-display text-2xl font-semibold text-text-primary">Something went wrong</p>
        <p className="mt-3 break-words font-mono text-[13px] text-text-secondary">{message}</p>
        <div className="mt-8 flex justify-center gap-3">
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="bg-brand px-5 py-2.5 text-sm font-medium text-white"
          >
            Reload
          </button>
          <a
            href="/dashboard"
            className="border border-border px-5 py-2.5 text-sm font-medium text-text-primary"
          >
            Dashboard
          </a>
        </div>
      </div>
    </div>
  )
}

export function getRouter() {
  return createRouter({
    routeTree,
    scrollRestoration: true,
    defaultNotFoundComponent: NotFound,
    defaultErrorComponent: ErrorScreen,
  })
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof getRouter>
  }
}
