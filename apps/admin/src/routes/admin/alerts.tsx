import { createFileRoute, Link } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import {
  useTable,
  tableFeatures,
  columnVisibilityFeature,
  rowSortingFeature,
  createSortedRowModel,
  sortFn_alphanumeric,
  sortFn_datetime,
  sortFn_text,
  flexRender,
  createColumnHelper,
  type SortingState,
} from '@tanstack/react-table'
import { useState } from 'react'
import { PRO_FAIR_USE_API_HITS_PER_MONTH } from '@gopaylocal/shared'
import { adminApi } from '~/lib/api'

export const Route = createFileRoute('/admin/alerts')({
  component: AlertsPage,
})

/** Flattened row: one row per warning per organization */
type AlertRow = {
  organizationId: string
  organizationName: string
  organizationSlug: string
  plan: string
  metric: string
  kind: 'cap' | 'fair_use'
  current: number
  limit: number
  percentage: number
}

// Table v9 only includes the features registered here. columnVisibilityFeature
// provides row.getVisibleCells(); the three sortFns are what the default
// 'auto' sort resolves to, matching v8's built-in behaviour.
const features = tableFeatures({
  columnVisibilityFeature,
  rowSortingFeature,
  sortedRowModel: createSortedRowModel(),
  sortFns: { alphanumeric: sortFn_alphanumeric, text: sortFn_text, datetime: sortFn_datetime },
})

const columnHelper = createColumnHelper<typeof features, AlertRow>()

function AlertsPage() {
  const [sorting, setSorting] = useState<SortingState>([
    { id: 'percentage', desc: true },
  ])

  const { data, isPending } = useQuery({
    queryKey: ['admin', 'alerts'],
    queryFn: () => adminApi.alerts.list(),
  })

  const alerts = data ?? []
  // Flatten the nested warnings into individual rows
  const allRows: AlertRow[] = alerts.flatMap((alert) =>
    alert.warnings.map((w) => ({
      organizationId: alert.organizationId,
      organizationName: alert.organizationName,
      organizationSlug: alert.organizationSlug,
      plan: alert.plan,
      metric: w.metric,
      kind: w.kind ?? 'cap',
      current: w.current,
      limit: w.limit,
      percentage: w.percentage,
    })),
  )
  // Only show alerts at >80% of any limit (fair-use rows are always >100%)
  const filteredAlerts = allRows.filter((a) => a.percentage >= 80)
  // Severity tiles count enforced caps only; fair use is informational.
  const capAlerts = filteredAlerts.filter((a) => a.kind === 'cap')
  const fairUseCount = filteredAlerts.length - capAlerts.length

  const columns = columnHelper.columns([
    columnHelper.accessor('organizationName', {
      header: 'Organization',
      cell: (info) => <span className="font-medium text-text-primary">{info.getValue()}</span>,
    }),
    columnHelper.accessor('metric', {
      header: 'Alert Type',
      cell: (info) => {
        const type = info.getValue()
        const labels: Record<string, string> = {
          products: 'Products',
          apiHitsPerMonth: 'API Calls',
          teamMembers: 'Members',
        }
        const fairUse = info.row.original.kind === 'fair_use'
        return (
          <span className="inline-flex border border-border bg-surface-raised px-2 py-0.5 font-mono text-[11px] font-semibold uppercase tracking-[0.08em] text-text-secondary">
            {labels[type] ?? type}
            {fairUse ? ' · Fair use' : ''}
          </span>
        )
      },
    }),
    columnHelper.accessor('current', {
      header: 'Current Usage',
      cell: (info) => (
        <span className="font-mono text-[13px] text-text-primary">{formatNumber(info.getValue())}</span>
      ),
    }),
    columnHelper.accessor('limit', {
      header: 'Limit',
      cell: (info) => (
        <span className="font-mono text-[13px] text-text-secondary">
          {formatNumber(info.getValue())}
          {info.row.original.kind === 'fair_use' ? ' (fair use)' : ''}
        </span>
      ),
    }),
    columnHelper.accessor('percentage', {
      header: 'Usage %',
      cell: (info) => {
        const pct = info.getValue()
        // Fair use is never enforced, so it doesn't get the danger colors.
        const tone =
          info.row.original.kind === 'fair_use'
            ? { bar: 'bg-border-strong', text: 'text-text-primary' }
            : severity(pct)
        return (
          <div className="flex items-center gap-3">
            <div className="h-2 w-20 bg-bg">
              <div
                className={`h-full ${tone.bar}`}
                style={{ width: `${Math.min(100, pct)}%` }}
              />
            </div>
            <span className={`font-display text-sm font-bold tabular-nums ${tone.text}`}>{pct}%</span>
          </div>
        )
      },
    }),
    columnHelper.accessor('plan', {
      header: 'Plan',
      cell: (info) => (
        <span className="font-mono text-[11px] font-semibold uppercase tracking-[0.08em] text-text-secondary">
          {info.getValue()}
        </span>
      ),
    }),
    columnHelper.display({
      id: 'actions',
      header: 'Actions',
      cell: () => (
        <Link
          to="/admin/organizations"
          className="inline-block cursor-pointer border border-border px-2.5 py-1 text-[13px] font-medium text-accent transition-colors hover:border-accent"
        >
          View org →
        </Link>
      ),
    }),
  ])

  const table = useTable({
    features,
    data: filteredAlerts,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
  })

  return (
    <div>
      <h1 className="font-display text-[42px] font-bold tracking-tight text-text-primary">Usage Alerts</h1>
      <p className="mt-1 text-base text-text-secondary">
        <span className="font-mono text-accent">//</span> Organizations above 80% of a plan limit. Seat and product caps of 1 never alert — that is the plan's steady state, not an emergency.
        {' '}Pro is unlimited; Pro organizations past {formatNumber(PRO_FAIR_USE_API_HITS_PER_MONTH)} API calls in a month are flagged for fair use (alert only, nothing is blocked).
        {' '}({filteredAlerts.length} alerts)
      </p>

      {/* Summary Stats */}
      <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-4">
        <SummaryCard
          label="Critical"
          qualifier="95%+"
          count={capAlerts.filter((r) => r.percentage >= 95).length}
          tone="border-danger/50 bg-danger/10"
          textTone="text-danger"
        />
        <SummaryCard
          label="Warning"
          qualifier="90–94%"
          count={capAlerts.filter((r) => r.percentage >= 90 && r.percentage < 95).length}
          tone="border-warning/50 bg-warning/10"
          textTone="text-warning"
        />
        <SummaryCard
          label="Approaching"
          qualifier="80–89%"
          count={capAlerts.filter((r) => r.percentage >= 80 && r.percentage < 90).length}
          tone="border-border bg-surface"
          textTone="text-text-primary"
          mutedLabel
        />
        <SummaryCard
          label="Fair use"
          qualifier={`Pro > ${formatNumber(PRO_FAIR_USE_API_HITS_PER_MONTH)}/mo`}
          count={fairUseCount}
          tone="border-border bg-surface"
          textTone="text-text-primary"
          mutedLabel
        />
      </div>

      {/* Table */}
      <div className="mt-6 border border-border bg-surface">
        {isPending ? (
          <div className="flex h-64 items-center justify-center">
            <div className="h-6 w-6 animate-spin rounded-full border-4 border-border-strong border-t-accent" />
          </div>
        ) : filteredAlerts.length === 0 ? (
          <div className="flex h-64 flex-col items-center justify-center px-4 text-center">
            <svg className="h-10 w-10 text-accent" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75 11.25 15 15 9.75M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" />
            </svg>
            <p className="mt-4 text-base font-medium text-text-primary">All clear</p>
            <p className="mt-1.5 max-w-sm text-sm text-text-secondary">
              No organization is within 20% of a plan limit. Rows appear here as accounts approach
              their product, API, or seat caps.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-border">
              <thead className="bg-surface-raised">
                {table.getHeaderGroups().map((headerGroup) => (
                  <tr key={headerGroup.id}>
                    {headerGroup.headers.map((header) => (
                      <th
                        key={header.id}
                        className="eyebrow cursor-pointer px-6 py-3 text-left transition-colors hover:text-accent"
                        onClick={header.column.getToggleSortingHandler()}
                      >
                        <div className="flex items-center gap-1">
                          {header.isPlaceholder
                            ? null
                            : flexRender(header.column.columnDef.header, header.getContext())}
                          {header.column.getIsSorted() === 'asc' && (
                            <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                              <path strokeLinecap="round" strokeLinejoin="round" d="m4.5 15.75 7.5-7.5 7.5 7.5" />
                            </svg>
                          )}
                          {header.column.getIsSorted() === 'desc' && (
                            <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                              <path strokeLinecap="round" strokeLinejoin="round" d="m19.5 8.25-7.5 7.5-7.5-7.5" />
                            </svg>
                          )}
                        </div>
                      </th>
                    ))}
                  </tr>
                ))}
              </thead>
              <tbody className="divide-y divide-border">
                {table.getRowModel().rows.map((row) => (
                  <tr
                    key={row.id}
                    className={`transition-colors hover:bg-surface-raised ${
                      row.original.kind === 'cap' && row.original.percentage >= 95 ? 'bg-danger/10' : ''
                    }`}
                  >
                    {row.getVisibleCells().map((cell) => (
                      <td key={cell.id} className="whitespace-nowrap px-6 py-4 text-sm">
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}

/** Static summary tile — no hover affordance, since it isn't clickable.
 *  L2: mono caps eyebrow over one big number. The severity tiles tint their
 *  label too; the neutral tile leaves it at the default so it doesn't
 *  out-shout the section titles. */
function SummaryCard({ label, qualifier, count, tone, textTone, mutedLabel }: {
  label: string
  qualifier: string
  count: number
  tone: string
  textTone: string
  mutedLabel?: boolean
}) {
  return (
    <div className={`border p-4 ${tone}`}>
      <p className={`eyebrow ${mutedLabel ? '' : textTone}`}>
        {label}
        <span className="ml-1.5 font-normal text-text-muted">{qualifier}</span>
      </p>
      <p className={`mt-2 font-display text-2xl font-bold tabular-nums ${textTone}`}>{count}</p>
    </div>
  )
}

/** Mirrors the three summary tiles: critical, warning, approaching. */
function severity(pct: number): { bar: string; text: string } {
  if (pct >= 95) return { bar: 'bg-danger', text: 'text-danger' }
  if (pct >= 90) return { bar: 'bg-warning', text: 'text-warning' }
  return { bar: 'bg-border-strong', text: 'text-text-primary' }
}

function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}
