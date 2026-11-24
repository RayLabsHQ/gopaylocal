import type { ReactNode } from 'react'

// The pieces every dashboard page is built from, so pages share one header,
// one section label and one set of buttons.

export const btnPrimary =
  'inline-flex h-10 items-center justify-center gap-2 bg-brand px-4 text-[13px] font-semibold text-white transition-colors hover:bg-brand/90 disabled:opacity-50'
export const btnSecondary =
  'inline-flex h-10 items-center justify-center gap-2 border border-border-strong px-3.5 text-[13px] font-medium text-text-primary transition-colors hover:bg-surface disabled:opacity-50'

/** The page title, one line saying what the page is for, and its actions. */
export function PageHeader({
  title,
  description,
  actions,
  status,
}: {
  title: ReactNode
  description?: ReactNode
  actions?: ReactNode
  status?: ReactNode
}) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-4">
      <div className="flex min-w-0 flex-col gap-1.5">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="font-display text-[32px] font-semibold tracking-tight text-text-primary">{title}</h1>
          {status}
        </div>
        {description && <div className="max-w-[640px] text-[15px] text-text-secondary">{description}</div>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </header>
  )
}

/** A small uppercase label above a section, with an optional count. */
export function SectionTitle({ id, children, count, aside }: { id?: string; children: ReactNode; count?: number; aside?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-2">
      <div className="flex items-baseline gap-2.5">
        <h2 id={id} className="text-xs font-semibold uppercase tracking-[0.08em] text-text-secondary">
          {children}
        </h2>
        {count !== undefined && <span className="text-xs text-text-muted">{count}</span>}
      </div>
      {aside && <div className="text-[13px] text-text-muted">{aside}</div>}
    </div>
  )
}

export function Spinner({ className = 'h-48' }: { className?: string }) {
  return (
    <div className={`flex items-center justify-center ${className}`}>
      <div className="h-6 w-6 animate-spin rounded-full border-4 border-border border-t-brand" />
    </div>
  )
}

/** A centred message in an empty table or panel. */
export function EmptyState({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-1.5 px-6 py-14 text-center">
      <p className="font-semibold text-text-primary">{title}</p>
      {children && <div className="max-w-[460px] text-[13px] text-text-secondary">{children}</div>}
      {action && <div className="mt-3">{action}</div>}
    </div>
  )
}
