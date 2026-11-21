import { createRouter, type ErrorComponentProps } from '@tanstack/react-router'
import { routeTree } from './routeTree.gen'

function NotFound() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-bg px-6">
      <div className="w-full max-w-md border border-border bg-surface p-10 text-center">
        <p className="eyebrow text-accent">// error</p>
        <p className="mt-2 font-display text-6xl font-bold tabular-nums tracking-tight text-text-primary">404</p>
        <p className="mt-3 text-base text-text-secondary">
          That route doesn&apos;t exist in the admin app.
        </p>
        <a
          href="/admin"
          className="mt-8 inline-block cursor-pointer border border-accent px-5 py-2.5 text-sm font-medium text-accent transition-colors hover:bg-accent hover:text-bg"
        >
          Back to Command Center →
        </a>
      </div>
    </div>
  )
}

// TanStack Router types a boundary error as `unknown` (anything can be thrown).
function ErrorScreen({ error }: ErrorComponentProps) {
  const message = error instanceof Error ? error.message : String(error)
  return (
    <div className="flex min-h-screen items-center justify-center bg-bg px-6">
      <div className="w-full max-w-md border border-border bg-surface p-10 text-center">
        <p className="eyebrow text-danger">// error</p>
        <p className="mt-2 font-display text-2xl font-bold text-text-primary">Something broke</p>
        <p className="mt-3 text-base text-text-secondary">
          The page failed to render. The message below is the raw error.
        </p>
        <p className="mt-3 break-words border border-border bg-bg p-3 text-left font-mono text-xs text-text-muted">
          {message}
        </p>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="mt-8 cursor-pointer border border-accent px-5 py-2.5 text-sm font-medium text-accent transition-colors hover:bg-accent hover:text-bg"
        >
          Reload
        </button>
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
