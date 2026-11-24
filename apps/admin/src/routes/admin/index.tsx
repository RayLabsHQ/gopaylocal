import { createFileRoute, Link, type LinkProps } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { adminApi } from '~/lib/api'
import { EmptyState, KPICard, MiniStat, Panel, Spinner, formatNumber } from '~/components/ui'

export const Route = createFileRoute('/admin/')({
  component: AdminDashboardPage,
})

function AdminDashboardPage() {
  const { data: stats, isPending: statsLoading } = useQuery({
    queryKey: ['admin', 'stats'],
    queryFn: () => adminApi.stats.get(),
  })

  const { data: topOrgs = [], isPending: topOrgsLoading } = useQuery({
    queryKey: ['admin', 'top-orgs'],
    queryFn: () => adminApi.stats.topOrgs(5),
  })

  const funnel = stats?.platformFunnel
  const conversionRate = funnel && funnel.impressions > 0
    ? ((funnel.redemptions / funnel.impressions) * 100).toFixed(1)
    : '0.0'

  return (
    <div>
      <h1 className="font-display text-[42px] font-bold tracking-tight text-text-primary">
        Command Center
      </h1>
      <p className="mt-1 text-base text-text-secondary">
        <span className="font-mono text-accent">//</span> Business intelligence, in real time
      </p>
      {!statsLoading && (stats?.internalOrganizations ?? 0) > 0 && (
        <p className="mt-2 text-[13px] text-text-muted">
          Live data only. {stats?.internalOrganizations} internal{' '}
          {stats?.internalOrganizations === 1 ? 'workspace and its members are' : 'workspaces and their members are'} left out.
        </p>
      )}

      {/* KPI Cards */}
      <div className="mt-8 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-5">
        <KPICard
          title="MRR"
          qualifier="Live"
          value={statsLoading ? '--' : formatUsd(stats?.estimatedMRR ?? 0)}
          sub={statsLoading ? undefined : mrrNote(stats?.mrrByCurrency, stats?.testSubscriptions)}
          highlight
        />
        <KPICard
          title="Organizations"
          value={statsLoading ? '--' : String(stats?.totalOrganizations ?? 0)}
          sub={statsLoading ? undefined : `${stats?.activeOrgsLast30Days ?? 0} active (30d)`}
        />
        <KPICard
          title="Users"
          value={statsLoading ? '--' : String(stats?.totalUsers ?? 0)}
        />
        <KPICard
          title="Conversion Rate"
          value={statsLoading ? '--' : `${conversionRate}%`}
          sub="Impressions → redemptions"
        />
        <KPICard
          title="Revenue Saved"
          qualifier="MTD"
          value={statsLoading ? '--' : `$${formatNumber(stats?.revenueSavedThisMonth ?? 0)}`}
          sub={statsLoading ? undefined : `$${formatNumber(stats?.totalRevenueSaved ?? 0)} all time`}
        />
      </div>

      {/* Two Column Layout */}
      <div className="mt-8 grid grid-cols-1 gap-6 lg:grid-cols-5">
        {/* Left: Subscription + Funnel */}
        <div className="space-y-6 lg:col-span-3">
          <Panel title="Subscription distribution">
            {statsLoading ? (
              <Spinner className="h-12" />
            ) : (
              <PlanBar plans={stats?.subscriptionsByPlan ?? {}} total={stats?.totalOrganizations ?? 0} />
            )}
          </Panel>

          <Panel title="Platform funnel" chip="This month, live sites">
            {statsLoading ? (
              <Spinner className="h-20" />
            ) : (
              <div className="grid grid-cols-1 divide-y divide-border sm:grid-cols-4 sm:divide-x sm:divide-y-0">
                <FunnelStep label="Impressions" value={funnel?.impressions ?? 0} />
                <FunnelStep label="Clicks" value={funnel?.clicks ?? 0} rate={funnel && funnel.impressions > 0 ? (funnel.clicks / funnel.impressions * 100) : 0} />
                <FunnelStep label="Copies" value={funnel?.copies ?? 0} rate={funnel && funnel.impressions > 0 ? (funnel.copies / funnel.impressions * 100) : 0} />
                <FunnelStep label="Redemptions" value={funnel?.redemptions ?? 0} rate={funnel && funnel.impressions > 0 ? (funnel.redemptions / funnel.impressions * 100) : 0} />
              </div>
            )}
          </Panel>

          <Panel title="Product adoption">
            {statsLoading ? (
              <Spinner className="h-12" />
            ) : (
              <div className="grid grid-cols-1 divide-y divide-border sm:grid-cols-3 sm:divide-x sm:divide-y-0">
                <MiniStat label="Products" value={stats?.totalProducts ?? 0} />
                <MiniStat label="Campaigns" value={stats?.totalCampaigns ?? 0} sub={`${stats?.activeCampaigns ?? 0} active`} />
                <MiniStat label="Integrations" value={Object.values(stats?.integrationsByProvider ?? {}).reduce((a, b) => a + b, 0)} sub={`${Object.keys(stats?.integrationsByProvider ?? {}).length} providers`} />
              </div>
            )}
          </Panel>
        </div>

        {/* Right: Top Orgs */}
        <div className="space-y-6 lg:col-span-2">
          <Panel
            title="Top organizations"
            chip="MTD"
            action={
              <Link
                to="/admin/organizations"
                className="shrink-0 cursor-pointer whitespace-nowrap text-[13px] font-medium text-accent transition-colors hover:text-text-primary"
              >
                View all →
              </Link>
            }
          >
            {topOrgsLoading ? (
              <Spinner className="h-48" />
            ) : topOrgs.length > 0 ? (
              <div className="divide-y divide-border">
                {topOrgs.map((org, i) => (
                  <div key={org.organizationId} className="flex items-center justify-between gap-3 py-3">
                    <div className="flex min-w-0 items-center gap-3">
                      <span className="w-5 shrink-0 font-mono text-xs font-semibold text-text-muted">{i + 1}</span>
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium text-text-primary">{org.name}</p>
                        <PlanBadge plan={org.plan} />
                      </div>
                    </div>
                    <div className="shrink-0 text-right">
                      <p className="font-display text-sm font-bold tabular-nums text-text-primary">
                        {formatNumber(org.impressions)}
                      </p>
                      {/* The label can't shrink; drop it where the column is too narrow. */}
                      <p className="hidden text-[13px] text-text-secondary sm:block">Impressions</p>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <EmptyState
                title="No traffic yet"
                body="Organizations show up here once their sites start sending API calls."
              />
            )}
          </Panel>

          {/* Integration Adoption */}
          {!statsLoading && stats?.integrationsByProvider && Object.keys(stats.integrationsByProvider).length > 0 && (
            <Panel title="Integration providers">
              <div className="divide-y divide-border">
                {Object.entries(stats.integrationsByProvider)
                  .sort(([, a], [, b]) => b - a)
                  .map(([provider, cnt]) => (
                    <div key={provider} className="flex items-center justify-between py-2">
                      <span className="text-sm capitalize text-text-secondary">{provider}</span>
                      <span className="font-display text-sm font-bold tabular-nums text-text-primary">{cnt}</span>
                    </div>
                  ))}
              </div>
            </Panel>
          )}

          {/* Quick Links */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <ActionTile to="/admin/revenue" title="Revenue" body="Subscriptions and buyers" />
            <ActionTile to="/admin/activation" title="Activation" body="Who is stuck where" />
            <ActionTile to="/admin/health" title="Health" body="Failures and backlog" />
            <ActionTile to="/admin/alerts" title="Alerts" body="Usage warnings" />
          </div>
        </div>
      </div>
    </div>
  )
}

// ── Components ──────────────────────────────────────────────────────────────

/** Interactive tile: accent left rule + arrow + hover border, so it never
 *  reads as one of the static stat cards. */
function ActionTile({ to, title, body }: { to: LinkProps['to']; title: string; body: string }) {
  return (
    <Link
      to={to}
      className="group flex cursor-pointer items-center justify-between gap-3 border border-border border-l-2 border-l-accent bg-surface p-4 transition-colors hover:border-accent hover:bg-surface-raised"
    >
      <span className="min-w-0">
        <span className="block text-sm font-semibold text-text-primary">{title}</span>
        <span className="mt-0.5 block text-[13px] text-text-secondary">{body}</span>
      </span>
      <span className="shrink-0 font-mono text-accent transition-transform group-hover:translate-x-0.5">→</span>
    </Link>
  )
}

function PlanBar({ plans, total }: { plans: Record<string, number>; total: number }) {
  if (total === 0) {
    return (
      <EmptyState
        title="No organizations yet"
        body="The plan split appears once the first organization signs up."
      />
    )
  }

  // Two plans. The API already folds legacy 'business' subscriptions into Pro.
  const items = [
    { key: 'free', label: 'Free', color: 'var(--text-3)', count: plans.free ?? 0 },
    { key: 'pro', label: 'Pro', color: 'var(--accent-color)', count: plans.pro ?? 0 },
  ]

  return (
    <div>
      <div className="flex h-4 bg-bg">
        {items.map((item) => {
          const pct = (item.count / total) * 100
          if (pct === 0) return null
          return (
            <div key={item.key} style={{ width: `${pct}%`, backgroundColor: item.color }} className="transition-all" />
          )
        })}
      </div>
      <div className="mt-4 flex flex-wrap gap-x-6 gap-y-2">
        {items.map((item) => (
          <div key={item.key} className="flex items-center gap-2">
            <div className="h-3 w-3 shrink-0" style={{ backgroundColor: item.color }} />
            <span className="text-sm text-text-secondary">{item.label}</span>
            <span className="font-display text-sm font-bold tabular-nums text-text-primary">{item.count}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

/** L3: cell label inside a panel — sentence case, not a mono eyebrow. */
function FunnelStep({ label, value, rate }: { label: string; value: number; rate?: number }) {
  return (
    <div className="py-3 sm:px-4 sm:py-0 sm:first:pl-0 sm:last:pr-0">
      <p className="text-[13px] text-text-secondary">{label}</p>
      <p className="mt-1.5 font-display text-lg font-bold tabular-nums text-text-primary">
        {formatNumber(value)}
      </p>
      {rate !== undefined && (
        <p className="mt-0.5 font-mono text-xs text-accent">{rate.toFixed(1)}%</p>
      )}
    </div>
  )
}

function PlanBadge({ plan }: { plan: string }) {
  const colors: Record<string, string> = {
    free: 'text-text-muted',
    pro: 'text-accent',
  }
  return (
    <span className={`font-mono text-[11px] font-semibold uppercase tracking-[0.08em] ${colors[plan] ?? 'text-text-muted'}`}>
      {plan}
    </span>
  )
}

function formatUsd(n: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: n % 1 === 0 ? 0 : 2 }).format(n)
}

/** Other currencies (never added to USD) and the test subscriptions left out. */
function mrrNote(byCurrency: Record<string, number> | undefined, test: number | undefined): string | undefined {
  const parts = Object.entries(byCurrency ?? {})
    .filter(([currency, amount]) => currency !== 'USD' && amount > 0)
    .map(([currency, amount]) => `+ ${currency} ${amount.toLocaleString('en-US')}`)
  if (test) parts.push(`${test} test ${test === 1 ? 'subscription' : 'subscriptions'} not counted`)
  return parts.length > 0 ? parts.join(' · ') : undefined
}
