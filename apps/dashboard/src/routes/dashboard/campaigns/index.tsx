import { useMemo, useState } from 'react'
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import type { CampaignStatus } from '@gopaylocal/shared'
import { api, PRICING_MODE_LABELS, DISCOUNT_DELIVERY_LABELS } from '~/lib/api'
import { getActiveTeamId, useSession } from '~/lib/auth'
import { useEnv } from '~/lib/env'
import { usePermissions } from '~/lib/permissions'
import { formatPrice } from '~/lib/format'
import { providerLogo, providerName } from '~/components/integrations/providers'
import { btnPrimary, EmptyState, PageHeader, Spinner } from '~/components/ui/page'
import { ErrorText, LifecycleStatus } from '~/components/ui/status'

export const Route = createFileRoute('/dashboard/campaigns/')({
  component: CampaignsPage,
})

type Filter = 'all' | CampaignStatus

const STATUS_LABELS: Record<CampaignStatus, string> = { active: 'Active', paused: 'Paused', draft: 'Draft' }
const FILTERS: Filter[] = ['all', 'active', 'paused', 'draft']

function CampaignsPage() {
  const { data: session } = useSession()
  const teamId = getActiveTeamId(session)
  const { env } = useEnv()
  const navigate = useNavigate()
  const canCreate = usePermissions().can('campaigns.create')
  const [filter, setFilter] = useState<Filter>('all')

  const { data: campaigns = [], isPending, error, refetch } = useQuery({
    queryKey: ['campaigns', teamId, env],
    queryFn: () => api.campaigns.list(teamId, env),
    enabled: !!teamId,
  })
  const { data: products = [] } = useQuery({
    queryKey: ['products', teamId, env],
    queryFn: () => api.products.list(teamId, env),
    enabled: !!teamId,
  })
  const { data: integrations = [] } = useQuery({
    queryKey: ['integrations', teamId],
    queryFn: () => api.integrations.list(teamId),
    enabled: !!teamId,
  })
  const { data: experiments = [] } = useQuery({
    queryKey: ['experiments', teamId, env, 'running'],
    queryFn: () => api.experiments.list(teamId, { environment: env, status: 'running' }),
    enabled: !!teamId,
  })

  // Which side of a running A/B test each campaign is on.
  const arms = useMemo(() => {
    const map = new Map<string, 'A' | 'B'>()
    for (const e of experiments) {
      map.set(e.campaignAId, 'A')
      map.set(e.campaignBId, 'B')
    }
    return map
  }, [experiments])

  const shown = filter === 'all' ? campaigns : campaigns.filter((c) => c.status === filter)
  const count = (f: Filter) => (f === 'all' ? campaigns.length : campaigns.filter((c) => c.status === f).length)

  return (
    <div className="flex max-w-[1080px] flex-col gap-7">
      <PageHeader
        title="Campaigns"
        description="A campaign decides how much each country gets off, and how the discount reaches the buyer."
        actions={
          canCreate && (
            <Link to="/dashboard/campaigns/new" className={btnPrimary}>
              New campaign
            </Link>
          )
        }
      />

      {campaigns.length > 0 && (
        <div role="group" aria-label="Show" className="flex self-start border border-border">
          {FILTERS.map((f, i) => (
            <button
              key={f}
              type="button"
              aria-pressed={filter === f}
              onClick={() => setFilter(f)}
              className={`h-9 px-3.5 text-[13px] font-medium transition-colors ${i > 0 ? 'border-l border-border' : ''} ${
                filter === f ? 'bg-tile text-text-primary' : 'text-text-secondary hover:text-text-primary'
              }`}
            >
              {f === 'all' ? 'All' : STATUS_LABELS[f]} <span className="font-normal text-text-muted">{count(f)}</span>
            </button>
          ))}
        </div>
      )}

      {/* inline-size containment keeps the table's width inside this box: the
          page's ScrollArea wraps content in a display:table div that otherwise
          grows to the table's minimum width and clips the page on a phone. */}
      <div className="overflow-x-auto border border-border bg-panel [contain:inline-size]">
        {isPending ? (
          <Spinner className="h-64" />
        ) : error ? (
          <div className="flex flex-col items-center gap-3 px-6 py-14">
            <ErrorText>Couldn't load the campaigns.</ErrorText>
            <button type="button" onClick={() => refetch()} className="text-[13px] font-medium text-brand-text hover:underline">
              Try again
            </button>
          </div>
        ) : campaigns.length === 0 ? (
          <EmptyState
            title="No campaigns yet"
            action={
              canCreate && (
                <Link to="/dashboard/campaigns/new" className={btnPrimary}>
                  Create your first campaign
                </Link>
              )
            }
          >
            A campaign sets each country's discount and shows it in a banner with a code, or applies it at checkout. You
            need a product first.
          </EmptyState>
        ) : shown.length === 0 ? (
          <EmptyState title={`No ${STATUS_LABELS[filter as CampaignStatus].toLowerCase()} campaigns`} />
        ) : (
          <table className="w-full min-w-[880px] text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs text-text-muted">
                <th scope="col" className="px-6 py-3 font-semibold">Campaign</th>
                <th scope="col" className="px-4 py-3 font-semibold">Codes in</th>
                <th scope="col" className="px-4 py-3 font-semibold">Delivery</th>
                <th scope="col" className="px-4 py-3 font-semibold">Pricing</th>
                <th scope="col" className="px-4 py-3 text-right font-semibold">Max off</th>
                <th scope="col" className="px-6 py-3 font-semibold">Status</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((c) => {
                const product = products.find((p) => p.id === c.productId)
                const integration = c.integrationId ? integrations.find((i) => i.id === c.integrationId) : undefined
                const arm = arms.get(c.id)
                return (
                  // The row opens the campaign on click; the name is the link for keyboards and screen readers.
                  <tr
                    key={c.id}
                    onClick={() => navigate({ to: '/dashboard/campaigns/$id', params: { id: c.id } })}
                    className="cursor-pointer border-b border-border transition-colors last:border-b-0 hover:bg-surface"
                  >
                    <td className="px-6 py-3.5">
                      <Link
                        to="/dashboard/campaigns/$id"
                        params={{ id: c.id }}
                        onClick={(e) => e.stopPropagation()}
                        className="font-semibold text-text-primary hover:underline"
                      >
                        {c.name}
                      </Link>
                      <div className="text-[13px] text-text-muted">
                        {product ? `${product.name} · ${formatPrice(product.basePrice, product.currency)}` : 'Product not found'}
                      </div>
                    </td>
                    <td className="px-4 py-3.5">
                      {integration ? (
                        <span className="inline-flex items-center gap-2 text-text-primary">
                          <img src={providerLogo(integration.provider)} alt="" className="h-[18px] w-[18px] object-contain" />
                          {providerName(integration.provider)}
                        </span>
                      ) : (
                        <span className="text-text-muted">No platform</span>
                      )}
                    </td>
                    <td className="px-4 py-3.5 text-text-secondary">{DISCOUNT_DELIVERY_LABELS[c.discountDelivery] ?? c.discountDelivery}</td>
                    <td className="px-4 py-3.5 text-text-secondary">{PRICING_MODE_LABELS[c.pricingMode] ?? c.pricingMode}</td>
                    <td className="px-4 py-3.5 text-right tabular-nums text-text-primary">{c.maxDiscountPercent}%</td>
                    <td className="px-6 py-3.5">
                      <span className="flex flex-wrap items-center gap-2">
                        <LifecycleStatus state={c.status === 'active' ? 'on' : c.status === 'paused' ? 'paused' : 'draft'}>
                          {STATUS_LABELS[c.status]}
                        </LifecycleStatus>
                        {arm && (
                          <span className="border border-border-strong px-1.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-text-secondary">
                            A/B {arm}
                          </span>
                        )}
                      </span>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>

      <p className="text-[13px] text-text-muted">
        {env === 'live' ? 'Live mode. Test campaigns are listed when the sidebar is on Test.' : 'Test mode. Live campaigns are listed when the sidebar is on Live.'}
      </p>
    </div>
  )
}
