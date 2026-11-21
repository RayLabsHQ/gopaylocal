import { useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { api, type AnalyticsRangeDays, type BillingInfo, type CountryAnalytics } from '~/lib/api'
import { getActiveTeamId, useSession } from '~/lib/auth'
import { useEnv } from '~/lib/env'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '~/components/ui/select'

export const Route = createFileRoute('/dashboard/')({
  component: OverviewPage,
})

const RANGE_OPTIONS: { value: AnalyticsRangeDays; label: string }[] = [
  { value: 7, label: 'Last 7 days' },
  { value: 30, label: 'Last 30 days' },
  { value: 90, label: 'Last 90 days' },
  // Pro keeps 365 days of history; the API clamps Free to its 7-day window.
  { value: 365, label: 'Last 365 days' },
]

function OverviewPage() {
  const { data: session } = useSession()
  const teamId = getActiveTeamId(session)
  const { env } = useEnv()
  const [rangeDays, setRangeDays] = useState<AnalyticsRangeDays>(7)

  const { data: stats, isPending } = useQuery({
    queryKey: ['overview', teamId, env, rangeDays],
    queryFn: () => api.analytics.overview(teamId, rangeDays),
    enabled: !!teamId,
  })

  const { data: products = [], isPending: isProductsPending } = useQuery({
    queryKey: ['products', teamId, env],
    queryFn: () => api.products.list(teamId, env),
    enabled: !!teamId,
  })

  const { data: topCountries = [], isPending: isCountriesPending } = useQuery({
    queryKey: ['analytics-by-country', teamId, rangeDays],
    queryFn: () => api.analytics.byCountry(teamId, rangeDays),
    enabled: !!teamId,
  })

  const { data: billing } = useQuery({
    queryKey: ['billing', teamId],
    queryFn: () => api.billing.get(teamId),
    enabled: !!teamId,
  })

  const isOverviewPending = isPending || isProductsPending || isCountriesPending

  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="font-display text-4xl font-medium tracking-tight text-text-primary">
            Overview
          </h1>
          <p className="mt-1 text-base text-text-secondary">
            Monitor your PPP discounts and banner traffic
          </p>
        </div>
        <div className="flex items-center gap-3">
          <div className="w-[140px]">
            <Select
              value={String(rangeDays)}
              onValueChange={(v) => setRangeDays(Number(v) as AnalyticsRangeDays)}
            >
              <SelectTrigger aria-label="Date range">
                <SelectValue />
              </SelectTrigger>
              <SelectContent position="item-aligned">
                <SelectGroup>
                  {RANGE_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={String(option.value)}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </div>
          <button
            type="button"
            onClick={() => downloadCountriesCsv(topCountries, rangeDays)}
            disabled={topCountries.length === 0}
            className="flex h-9 items-center gap-2 border border-border px-4 text-[13px] font-medium text-text-primary disabled:opacity-50"
          >
            <svg className="h-3.5 w-3.5 text-text-secondary" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5M16.5 12 12 16.5m0 0L7.5 12m4.5 4.5V3" />
            </svg>
            Export
          </button>
        </div>
      </div>

      {/* Stats Cards */}
      <div className="mt-8 grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-4">
        {/* Banner impressions in the selected range, not metered API calls
            (those are per calendar month, on the Billing page). */}
        <StatCard
          title="Impressions"
          value={isOverviewPending ? '--' : formatNumber(stats?.totalImpressions ?? 0)}
          subtitle={isOverviewPending ? undefined : `${formatNumber(stats?.totalRedemptions ?? 0)} redemptions`}
        />
        <StatCard
          title="Active Products"
          value={isOverviewPending ? '--' : String(products.length)}
          badge={planBadge(billing)}
        />
        <StatCard
          title="Revenue Impact"
          value={isOverviewPending ? '--' : formatRevenueByCurrency(stats?.revenueSavedByCurrency)}
          subtitle={isOverviewPending ? undefined : `${formatNumber(stats?.totalRedemptions ?? 0)} discounts applied`}
        />
        <StatCard
          title="Countries Reached"
          value={isOverviewPending ? '--' : String(topCountries.length)}
          subtitle="75 with PPP factors"
        />
      </div>

      {/* Top Countries */}
      <div className="mt-8">
        <div className="flex items-center justify-between">
          <h2 className="font-display text-lg font-semibold text-text-primary">Top Countries</h2>
        </div>
        <div className="mt-4 overflow-x-auto border border-border">
          {isOverviewPending ? (
            <div className="flex h-48 items-center justify-center">
              <div className="h-6 w-6 animate-spin rounded-full border-4 border-border border-t-brand" />
            </div>
          ) : topCountries.length > 0 ? (
            <table className="min-w-full">
              <thead>
                <tr className="border-b border-border bg-surface">
                  <th className="px-5 py-3 text-left text-[13px] font-semibold text-text-secondary">
                    Country
                  </th>
                  <th className="px-5 py-3 text-right text-[13px] font-semibold text-text-secondary">
                    Hits
                  </th>
                </tr>
              </thead>
              <tbody>
                {topCountries.map((entry, index) => (
                  <tr key={`${entry.countryCode ?? 'unknown'}-${index}`} className="border-b border-border last:border-b-0">
                    <td className="whitespace-nowrap px-5 py-3.5 font-mono text-sm font-medium text-text-primary">
                      {entry.countryCode ?? 'Unknown'}
                    </td>
                    <td className="whitespace-nowrap px-5 py-3.5 text-right font-mono text-sm font-medium tabular-nums text-text-primary">
                      {formatNumber(entry.impressions)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="flex h-48 flex-col items-center justify-center px-6 text-center">
              <p className="text-base font-medium text-text-primary">No traffic yet</p>
              <p className="mt-1.5 max-w-sm text-sm text-text-secondary">
                Countries appear here once your embed snippet starts serving discounts. Create a
                product, then a campaign, then paste the snippet on your pricing page.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function StatCard({
  title,
  value,
  badge,
  subtitle,
}: {
  title: string
  value: string
  badge?: string
  subtitle?: string
}) {
  return (
    <div className="border border-border p-7">
      <p className="text-sm font-medium text-text-secondary">{title}</p>
      <p className="mt-3 font-display text-4xl font-semibold tabular-nums tracking-tight text-text-primary">
        {value}
      </p>
      {badge && (
        <div className="mt-3">
          <span className="bg-brand-light px-2 py-0.5 text-xs font-medium text-brand-text">
            {badge}
          </span>
        </div>
      )}
      {subtitle && (
        <p className="mt-3 text-[13px] text-text-secondary">{subtitle}</p>
      )}
    </div>
  )
}

// "Free plan" / "Pro plan" from the effective plan; self-hosted has no plans.
function planBadge(billing: BillingInfo | undefined): string | undefined {
  if (!billing || billing.selfHosted) return undefined
  const plan = billing.effectivePlan ?? billing.plan
  return plan === 'pro' ? 'Pro plan' : 'Free plan'
}

function downloadCountriesCsv(rows: CountryAnalytics[], days: AnalyticsRangeDays) {
  const header = ['Country', 'Impressions', 'Clicks', 'Copies', 'Redemptions', 'Revenue Saved (by currency)']
  const csv = [
    header,
    ...rows.map((r) => [
      r.countryCode ?? 'Unknown',
      r.impressions,
      r.clicks,
      r.copies,
      r.redemptions,
      revenueCsvCell(r.revenueSavedByCurrency),
    ]),
  ]
    .map((cols) => cols.join(','))
    .join('\n')

  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
  const link = document.createElement('a')
  link.href = url
  link.download = `gopaylocal-countries-last-${days}-days.csv`
  link.click()
  URL.revokeObjectURL(url)
}

// Revenue saved is kept per currency (never added across currencies), so the
// card lists each currency in its own format, in code order (amounts in
// different currencies can't be ranked without exchange rates).
function revenueEntries(byCurrency: Record<string, number> | undefined): [string, number][] {
  return Object.entries(byCurrency ?? {})
    .filter(([, amount]) => amount > 0)
    .sort(([a], [b]) => a.localeCompare(b))
}

function formatCurrencyCompact(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency,
      notation: 'compact',
      maximumFractionDigits: 1,
    }).format(amount)
  } catch {
    return `${currency} ${formatNumber(Math.round(amount))}`
  }
}

function formatRevenueByCurrency(byCurrency: Record<string, number> | undefined): string {
  const entries = revenueEntries(byCurrency)
  if (entries.length === 0) return '0'
  const shown = entries.slice(0, 2).map(([currency, amount]) => formatCurrencyCompact(amount, currency))
  const more = entries.length - shown.length
  return more > 0 ? `${shown.join(' · ')} +${more}` : shown.join(' · ')
}

// "USD 12.5; INR 400": one cell, no commas.
function revenueCsvCell(byCurrency: Record<string, number> | undefined): string {
  return revenueEntries(byCurrency)
    .map(([currency, amount]) => `${currency} ${amount}`)
    .join('; ')
}

function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}
