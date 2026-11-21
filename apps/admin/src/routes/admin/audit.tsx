import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/admin/audit')({
  component: AuditLogPage,
})

function AuditLogPage() {
  return (
    <div>
      <h1 className="font-display text-[42px] font-bold tracking-tight text-text-primary">Audit Log</h1>
      <p className="mt-1 text-base text-text-secondary">
        <span className="font-mono text-accent">//</span> Admin actions and system events
      </p>

      <div className="mt-8 flex h-64 flex-col items-center justify-center border border-border bg-surface px-4 text-center">
        <svg className="h-10 w-10 text-text-muted" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h3.75M9 15h3.75M9 18h3.75m3 .75H18a2.25 2.25 0 0 0 2.25-2.25V6.108c0-1.135-.845-2.098-1.976-2.192a48.424 48.424 0 0 0-1.123-.08m-5.801 0c-.065.21-.1.433-.1.664 0 .414.336.75.75.75h4.5a.75.75 0 0 0 .75-.75 2.25 2.25 0 0 0-.1-.664m-5.8 0A2.251 2.251 0 0 1 13.5 2.25H15a2.25 2.25 0 0 1 2.15 1.586m-5.8 0c-.376.023-.75.05-1.124.08C9.095 4.01 8.25 4.973 8.25 6.108V8.25m0 0H4.875c-.621 0-1.125.504-1.125 1.125v11.25c0 .621.504 1.125 1.125 1.125h9.75c.621 0 1.125-.504 1.125-1.125V9.375c0-.621-.504-1.125-1.125-1.125H8.25ZM6.75 12h.008v.008H6.75V12Zm0 3h.008v.008H6.75V15Zm0 3h.008v.008H6.75V18Z" />
        </svg>
        <p className="mt-4 text-base font-medium text-text-primary">Not built yet</p>
        <p className="mt-1.5 max-w-sm text-sm text-text-secondary">
          Once audit logging ships, every admin action — bans, limit overrides, plan changes —
          will be recorded here with the actor and timestamp.
        </p>
      </div>
    </div>
  )
}
