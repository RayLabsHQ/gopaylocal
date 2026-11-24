import type { ReactNode } from 'react'

// Shared pieces of the admin's look: one bordered region per panel, mono caps
// eyebrows over big numbers, hairline dividers inside, accent for what matters.

export const btn =
  'cursor-pointer border border-border px-4 py-2 text-sm font-medium text-text-secondary transition-colors hover:border-accent hover:text-accent disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-border disabled:hover:text-text-secondary'

export const btnAccent =
  'cursor-pointer border border-accent bg-accent px-4 py-2 text-sm font-semibold text-bg transition-colors hover:bg-transparent hover:text-accent disabled:cursor-not-allowed disabled:opacity-40'

export function PageHeader({ title, subtitle, action }: { title: string; subtitle: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        <h1 className="font-display text-[42px] font-bold tracking-tight text-text-primary">{title}</h1>
        <p className="mt-1 text-base text-text-secondary">
          <span className="font-mono text-accent">//</span> {subtitle}
        </p>
      </div>
      {action}
    </div>
  )
}

/** One bordered region. `chip` carries a qualifier ("This month") so the title stays clean. */
export function Panel({
  title,
  chip,
  action,
  children,
  flush,
}: {
  title: string
  chip?: string
  action?: ReactNode
  children: ReactNode
  /** No inner padding below the title (for tables that run edge to edge). */
  flush?: boolean
}) {
  return (
    <div className="border border-border bg-surface">
      <div className="flex items-baseline justify-between gap-3 px-5 pt-5">
        <div className="flex min-w-0 items-baseline gap-2.5">
          <h2 className="truncate text-base font-semibold text-text-primary">{title}</h2>
          {chip && <span className="eyebrow shrink-0 text-text-muted">{chip}</span>}
        </div>
        {action}
      </div>
      <div className={flush ? 'mt-4' : 'mt-4 px-5 pb-5'}>{children}</div>
    </div>
  )
}

export function Spinner({ className = '' }: { className?: string }) {
  return (
    <div className={`flex items-center justify-center ${className}`}>
      <div className="h-4 w-4 animate-spin rounded-full border-2 border-border-strong border-t-accent" />
    </div>
  )
}

export function EmptyState({ title, body, className = 'h-48' }: { title: string; body: string; className?: string }) {
  return (
    <div className={`flex flex-col items-center justify-center px-4 text-center ${className}`}>
      <p className="text-base font-medium text-text-primary">{title}</p>
      <p className="mt-1.5 max-w-sm text-sm text-text-secondary">{body}</p>
    </div>
  )
}

export function ErrorBox({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border border-danger/40 bg-danger/10 px-4 py-3">
      <p className="text-sm text-danger">{message}</p>
      {onRetry && (
        <button type="button" onClick={onRetry} className={btn}>
          Try again
        </button>
      )}
    </div>
  )
}

/** A mono caps eyebrow sitting directly on one big number. */
export function KPICard({
  title,
  qualifier,
  value,
  sub,
  highlight,
}: {
  title: string
  qualifier?: string
  value: string
  sub?: ReactNode
  highlight?: boolean
}) {
  return (
    <div className="border border-border bg-surface p-5">
      <p className="eyebrow">
        {title}
        {qualifier && <span className="ml-1.5 font-normal text-text-muted">{qualifier}</span>}
      </p>
      <p className={`mt-2 font-display text-[28px] font-bold tabular-nums tracking-tight ${highlight ? 'text-accent' : 'text-text-primary'}`}>
        {value}
      </p>
      {sub && <div className="mt-1 text-[13px] text-text-secondary">{sub}</div>}
    </div>
  )
}

/** A cell inside a divided row of stats: sentence-case label, bold number. */
export function MiniStat({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <div className="py-3 sm:px-4 sm:py-0 sm:first:pl-0 sm:last:pr-0">
      <p className="text-[13px] text-text-secondary">{label}</p>
      <p className="mt-1.5 font-display text-lg font-bold tabular-nums text-text-primary">{value}</p>
      {sub && <p className="mt-0.5 text-[13px] text-text-secondary">{sub}</p>}
    </div>
  )
}

/** A plain table with the admin's header style. `headers` may carry an alignment. */
export function Table({ headers, children }: { headers: Array<string | { label: string; right?: boolean }>; children: ReactNode }) {
  return (
    <div className="overflow-x-auto">
      <table className="min-w-full divide-y divide-border">
        <thead className="bg-surface-raised">
          <tr>
            {headers.map((h) => {
              const label = typeof h === 'string' ? h : h.label
              const right = typeof h !== 'string' && h.right
              return (
                <th key={label} scope="col" className={`eyebrow whitespace-nowrap px-5 py-3 ${right ? 'text-right' : 'text-left'}`}>
                  {label}
                </th>
              )
            })}
          </tr>
        </thead>
        <tbody className="divide-y divide-border">{children}</tbody>
      </table>
    </div>
  )
}

export const td = 'whitespace-nowrap px-5 py-3 text-sm text-text-secondary'
export const tdRight = `${td} text-right tabular-nums`

export function Tag({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'accent' | 'warning' | 'danger' }) {
  const tones = {
    neutral: 'border-border bg-surface-raised text-text-secondary',
    accent: 'border-accent/40 bg-accent/10 text-accent',
    warning: 'border-warning/40 bg-warning/10 text-warning',
    danger: 'border-danger/40 bg-danger/10 text-danger',
  }
  return (
    <span className={`inline-flex border px-2 py-0.5 font-mono text-[11px] font-semibold uppercase tracking-[0.08em] ${tones[tone]}`}>
      {children}
    </span>
  )
}

// ── Formatting ──────────────────────────────────────────────────────────────

export function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(Math.round(n))
}

export function formatMoney(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency,
      maximumFractionDigits: Number.isInteger(amount) ? 0 : 2,
    }).format(amount)
  } catch {
    return `${currency} ${amount.toLocaleString('en-US')}`
  }
}

/** Amounts in several currencies, never added together: "$38 · ₹1,008". */
export function formatMoneyMap(byCurrency: Record<string, number> | undefined, empty = '$0'): string {
  const entries = Object.entries(byCurrency ?? {}).filter(([, v]) => v > 0)
  if (entries.length === 0) return empty
  return entries
    .sort(([a], [b]) => (a === 'USD' ? -1 : b === 'USD' ? 1 : a.localeCompare(b)))
    .map(([c, v]) => formatMoney(v, c))
    .join(' · ')
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  return Number.isNaN(d.getTime())
    ? '—'
    : d.toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' }) + ' UTC'
}

export function flag(country: string | null | undefined): string {
  if (!country || !/^[A-Za-z]{2}$/.test(country)) return ''
  return String.fromCodePoint(...country.toUpperCase().split('').map((c) => 0x1f1a5 + c.charCodeAt(0)))
}
