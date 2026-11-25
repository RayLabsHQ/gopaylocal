import { useState } from 'react'
import { createFileRoute, Link } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { PPP_MULTIPLIERS } from '@gopaylocal/shared'
import { api, PROVIDER_LABELS, type AnalyticsRangeDays, type CountryAnalytics } from '~/lib/api'
import { getActiveTeamId, useSession } from '~/lib/auth'
import { useEnv } from '~/lib/env'
import { usePermissions } from '~/lib/permissions'
import { countryName, flagEmoji } from '~/lib/countries'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '~/components/ui/select'
import { btnPrimary, btnSecondary, EmptyState, PageHeader, SectionTitle, Spinner } from '~/components/ui/page'
import { ToneIcon } from '~/components/ui/status'

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

/** Countries with a PPP factor in the built-in table. */
const PPP_COUNTRY_COUNT = Object.keys(PPP_MULTIPLIERS).length

/** Rows shown before "Show all". */
const TOP_ROWS = 10

function OverviewPage() {
  const { data: session } = useSession()
  const teamId = getActiveTeamId(session)
  const { env } = useEnv()
  const { can } = usePermissions()
  // The checklist is for whoever sets the workspace up; members can't add products.
  const canSetUp = can('products.create')
  const [rangeDays, setRangeDays] = useState<AnalyticsRangeDays>(7)
  const [showAll, setShowAll] = useState(false)

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

  const { data: integrations = [], isPending: isIntegrationsPending } = useQuery({
    queryKey: ['integrations', teamId],
    queryFn: () => api.integrations.list(teamId),
    enabled: !!teamId && canSetUp,
  })

  const { data: campaigns = [], isPending: isCampaignsPending } = useQuery({
    queryKey: ['campaigns', teamId, env],
    queryFn: () => api.campaigns.list(teamId, env),
    enabled: !!teamId && canSetUp,
  })

  const isOverviewPending = isPending || isProductsPending || isCountriesPending
  const impressions = stats?.totalImpressions ?? 0
  const redemptions = stats?.totalRedemptions ?? 0
  const shownCountries = showAll ? topCountries : topCountries.slice(0, TOP_ROWS)
  const maxImpressions = topCountries[0]?.impressions ?? 0

  // Setup steps, all from data the workspace already has.
  const connected = integrations.filter((i) => (env === 'live' ? i.hasLiveCredentials : i.hasTestCredentials))
  const activeCampaigns = campaigns.filter((c) => c.status === 'active')
  const steps: SetupStep[] = [
    {
      title: 'Connect your payment platform',
      done: connected.length > 0,
      doneNote: connected[0] ? PROVIDER_LABELS[connected[0].provider] : undefined,
      action: { to: '/dashboard/integrations', label: 'Choose a platform' },
    },
    {
      title: 'Add a product',
      done: products.length > 0,
      doneNote: products[0]?.name,
      action: { to: '/dashboard/products/new', label: 'Add product' },
    },
    {
      title: 'Create a campaign',
      done: activeCampaigns.length > 0,
      doneNote: activeCampaigns[0]?.name,
      todoNote: campaigns.length > 0 ? 'You have a campaign; activate it to start.' : undefined,
      action: { to: campaigns.length > 0 ? '/dashboard/campaigns' : '/dashboard/campaigns/new', label: campaigns.length > 0 ? 'Open campaigns' : 'New campaign' },
    },
    {
      title: 'Paste the snippet on your pricing page',
      done: impressions > 0,
      doneNote: 'Banner views are arriving',
      todoNote: 'Done when the first banner view arrives. The snippet is on the campaign page.',
    },
  ]
  const setupPending = isOverviewPending || isIntegrationsPending || isCampaignsPending
  const showSetup = canSetUp && !setupPending && steps.some((s) => !s.done)

  return (
    <div className="flex max-w-[1080px] flex-col gap-8">
      <PageHeader
        title="Overview"
        description="What visitors saw on your site and what they used."
        actions={
          <>
            <div className="w-[150px]">
              <Select value={String(rangeDays)} onValueChange={(v) => setRangeDays(Number(v) as AnalyticsRangeDays)}>
                <SelectTrigger aria-label="Date range" className="h-10">
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
              className={btnSecondary}
            >
              Export CSV
            </button>
          </>
        }
      />

      {showSetup && <SetupChecklist steps={steps} />}

      {/* Banner views in the selected range, not metered API calls (those are
          per calendar month, on the Billing page). */}
      <section aria-label="Totals" className="grid grid-cols-1 gap-px border border-border bg-border sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Banner views" value={isOverviewPending ? '--' : formatNumber(impressions)} note={isOverviewPending ? undefined : `${formatNumber(redemptions)} redemptions`} />
        <Stat label="Products" value={isOverviewPending ? '--' : String(products.length)} note={`in ${env} mode`} />
        <Stat
          label="Discount given"
          value={isOverviewPending ? '--' : formatRevenueByCurrency(stats?.revenueSavedByCurrency)}
          note={isOverviewPending ? undefined : `${formatNumber(redemptions)} codes used`}
        />
        <Stat
          label="Countries reached"
          value={isOverviewPending ? '--' : String(topCountries.length)}
          note={`${PPP_COUNTRY_COUNT} countries have a PPP factor`}
        />
      </section>

      <section aria-labelledby="countries-title" className="flex flex-col gap-3.5">
        <SectionTitle id="countries-title" aside={`By banner views, ${rangeLabel(rangeDays)}`}>
          Top countries
        </SectionTitle>
        <div className="overflow-x-auto border border-border bg-panel">
          {isOverviewPending ? (
            <Spinner />
          ) : topCountries.length > 0 ? (
            <table className="w-full min-w-[760px] text-sm">
              <thead>
                <tr className="border-b border-border text-xs text-text-muted">
                  <th scope="col" className="px-6 py-3 text-left font-semibold">Country</th>
                  <th scope="col" className="w-[240px] px-4 py-3 text-left font-semibold">Banner views</th>
                  <th scope="col" className="px-4 py-3 text-right font-semibold">Clicks</th>
                  <th scope="col" className="px-4 py-3 text-right font-semibold">Codes copied</th>
                  <th scope="col" className="px-4 py-3 text-right font-semibold">Redemptions</th>
                  <th scope="col" className="px-6 py-3 text-right font-semibold">Discount given</th>
                </tr>
              </thead>
              <tbody className="tabular-nums">
                {shownCountries.map((entry, index) => (
                  <tr key={`${entry.countryCode ?? 'unknown'}-${index}`} className="border-b border-border last:border-b-0">
                    <td className="whitespace-nowrap px-6 py-3 text-text-primary">
                      <span className="inline-flex items-center gap-2.5">
                        <span aria-hidden="true">{flagEmoji(entry.countryCode)}</span>
                        {countryName(entry.countryCode)}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2.5">
                        <span className="w-14 text-right text-text-primary">{formatNumber(entry.impressions)}</span>
                        <span aria-hidden="true" className="h-1.5 flex-1 bg-tile">
                          <span
                            className="block h-1.5 bg-brand"
                            style={{ width: `${maxImpressions > 0 ? Math.max(2, Math.round((entry.impressions / maxImpressions) * 100)) : 0}%` }}
                          />
                        </span>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-right text-text-secondary">{formatNumber(entry.clicks)}</td>
                    <td className="px-4 py-3 text-right text-text-secondary">{formatNumber(entry.copies)}</td>
                    <td className="px-4 py-3 text-right text-text-primary">{formatNumber(entry.redemptions)}</td>
                    <td className="whitespace-nowrap px-6 py-3 text-right text-text-secondary">
                      {revenueEntries(entry.revenueSavedByCurrency).length > 0 ? formatRevenueByCurrency(entry.revenueSavedByCurrency) : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <EmptyState title="No banner views yet">
              Countries appear here once the snippet on your pricing page starts showing discounts.
            </EmptyState>
          )}
        </div>
        {topCountries.length > TOP_ROWS && (
          <div>
            <button type="button" onClick={() => setShowAll((v) => !v)} className="text-[13px] font-medium text-brand-text hover:underline">
              {showAll ? 'Show the top 10' : `Show all ${topCountries.length} countries`}
            </button>
          </div>
        )}
      </section>

      <p className="text-[13px] text-text-muted">
        Discount given is what visitors saved with your codes, per currency; amounts in different currencies are never
        added together. Banner views count both live and test traffic.
      </p>
    </div>
  )
}

type SetupStep = {
  title: string
  done: boolean
  doneNote?: string
  todoNote?: string
  action?: { to: string; label: string }
}

function SetupChecklist({ steps }: { steps: SetupStep[] }) {
  const done = steps.filter((s) => s.done).length
  // The first open step gets the red button; the others wait their turn.
  const next = steps.findIndex((s) => !s.done)
  return (
    <section aria-labelledby="setup-title" className="border border-border bg-panel">
      <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-border px-6 py-4">
        <h2 id="setup-title" className="font-display text-lg font-semibold text-text-primary">
          Get the banner on your site
        </h2>
        <span className="text-[13px] text-text-muted">
          {done} of {steps.length} done
        </span>
      </div>
      <ol className="grid grid-cols-1 gap-px bg-border sm:grid-cols-2 lg:grid-cols-4">
        {steps.map((step, i) => (
          <li key={step.title} className="flex flex-col gap-1.5 bg-panel px-6 py-4">
            {step.done ? (
              <span className="inline-flex items-center gap-2 text-[13px] text-success">
                <ToneIcon tone="ok" className="h-3.5 w-3.5" />
                Done
              </span>
            ) : (
              <span className={`font-mono text-xs ${i === next ? 'text-brand-text' : 'text-text-muted'}`}>0{i + 1}</span>
            )}
            <span className="font-semibold text-text-primary">{step.title}</span>
            {step.done
              ? step.doneNote && <span className="truncate text-[13px] text-text-muted">{step.doneNote}</span>
              : step.todoNote && <span className="text-[13px] text-text-muted">{step.todoNote}</span>}
            {/* mt-auto pins every button to the bottom of its cell (the cells of a
                row share its height), so a title that wraps doesn't push one
                button lower than its neighbours. */}
            {!step.done && step.action && (
              <div className="mt-auto pt-3">
                <Link to={step.action.to} className={i === next ? `${btnPrimary} h-9` : `${btnSecondary} h-9`}>
                  {step.action.label}
                </Link>
              </div>
            )}
          </li>
        ))}
      </ol>
    </section>
  )
}

function Stat({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="flex flex-col gap-1.5 bg-panel px-6 py-5">
      <p className="text-xs font-semibold uppercase tracking-[0.08em] text-text-muted">{label}</p>
      <p className="font-display text-[30px] font-semibold tabular-nums tracking-tight text-text-primary">{value}</p>
      {note && <p className="text-[13px] text-text-secondary">{note}</p>}
    </div>
  )
}

function rangeLabel(days: AnalyticsRangeDays): string {
  return RANGE_OPTIONS.find((o) => o.value === days)?.label.toLowerCase() ?? `last ${days} days`
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

/** "$489.80" below 10,000, "$31.4K" from there; same locale as formatPrice. */
function formatCurrencyCompact(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat(
      'en-US',
      amount >= 10_000
        ? { style: 'currency', currency, notation: 'compact', maximumFractionDigits: 1 }
        : { style: 'currency', currency, minimumFractionDigits: 2, maximumFractionDigits: 2 },
    ).format(amount)
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
