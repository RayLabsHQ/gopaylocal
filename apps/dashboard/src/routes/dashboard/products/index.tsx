import { createFileRoute, Link } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { PLAN_PRICES_USD } from '@gopaylocal/shared'
import { api } from '~/lib/api'
import { getActiveTeamId, useSession } from '~/lib/auth'
import { useEnv } from '~/lib/env'
import { usePermissions } from '~/lib/permissions'
import { formatDate, formatPrice } from '~/lib/format'
import { btnPrimary, btnSecondary, EmptyState, PageHeader, Spinner } from '~/components/ui/page'
import { ErrorText, ToneIcon } from '~/components/ui/status'

export const Route = createFileRoute('/dashboard/products/')({
  component: ProductsPage,
})

function ProductsPage() {
  const { data: session } = useSession()
  const teamId = getActiveTeamId(session)
  const { env } = useEnv()
  // Adding products is products.create (owner and admin).
  const { can } = usePermissions()
  const canCreate = can('products.create')
  const canCreateCampaign = can('campaigns.create')

  const { data: products = [], isPending, error, refetch } = useQuery({
    queryKey: ['products', teamId, env],
    queryFn: () => api.products.list(teamId, env),
    enabled: !!teamId,
  })
  const { data: campaigns = [] } = useQuery({
    queryKey: ['campaigns', teamId, env],
    queryFn: () => api.campaigns.list(teamId, env),
    enabled: !!teamId,
  })
  const { data: usage } = useQuery({
    queryKey: ['billing-usage', teamId],
    queryFn: () => api.billing.usage(teamId),
    enabled: !!teamId && canCreate,
  })
  // remaining is null when unlimited (Pro, self-hosted): never at the limit.
  const atLimit = usage?.remaining != null && usage.remaining <= 0
  const canUpgrade = usage?.billingEnabled !== false && usage?.selfHosted !== true

  return (
    <div className="flex max-w-[1080px] flex-col gap-6">
      <PageHeader
        title="Products"
        description="What you sell and its full price. Campaigns work out each country's price from it."
        actions={
          canCreate && (
            <>
              <Link to="/dashboard/integrations" className={btnSecondary}>
                Import from a platform
              </Link>
              {atLimit ? (
                <button type="button" disabled className={btnPrimary}>
                  Add product
                </button>
              ) : (
                <Link to="/dashboard/products/new" className={btnPrimary}>
                  Add product
                </Link>
              )}
            </>
          )
        }
      />

      {canCreate && atLimit && usage && (
        <div className="flex flex-wrap items-center justify-between gap-3 border border-warning-border bg-warning-light px-4 py-3">
          <p className="flex items-start gap-2.5 text-[13px] text-text-primary">
            <ToneIcon tone="warn" className="mt-0.5 h-3.5 w-3.5" />
            <span>
              You're using {usage.currentCount} of {usage.maxProducts} {usage.maxProducts === 1 ? 'product' : 'products'} on the Free plan.
              {canUpgrade && ` Pro has unlimited products for $${PLAN_PRICES_USD.pro.month} a month.`}
            </span>
          </p>
          {canUpgrade && (
            <Link to="/dashboard/settings" search={{ tab: 'billing' }} className="text-[13px] font-semibold text-warning hover:underline">
              See plans
            </Link>
          )}
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
            <ErrorText>Couldn't load the products.</ErrorText>
            <button type="button" onClick={() => refetch()} className="text-[13px] font-medium text-brand-text hover:underline">
              Try again
            </button>
          </div>
        ) : products.length === 0 ? (
          <EmptyState
            title="No products yet"
            action={
              canCreate && (
                <div className="flex flex-wrap justify-center gap-2">
                  <Link to="/dashboard/products/new" className={btnPrimary}>
                    Add your first product
                  </Link>
                  <Link to="/dashboard/integrations" className={btnSecondary}>
                    Import from a platform
                  </Link>
                </div>
              )
            }
          >
            {canCreate
              ? 'A product is what you sell: its name, currency and full price. Add one, or import it from your payment platform, then build a campaign on it.'
              : "You don't have access to any products yet. The workspace owner chooses which products you can work on."}
          </EmptyState>
        ) : (
          <table className="w-full min-w-[720px] text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs text-text-muted">
                <th scope="col" className="px-6 py-3 font-semibold">Product</th>
                <th scope="col" className="px-4 py-3 text-right font-semibold">Full price</th>
                <th scope="col" className="px-4 py-3 font-semibold">Campaigns</th>
                <th scope="col" className="px-6 py-3 font-semibold">Added</th>
              </tr>
            </thead>
            <tbody>
              {products.map((p) => {
                const own = campaigns.filter((c) => c.productId === p.id)
                const active = own.filter((c) => c.status === 'active').length
                return (
                  <tr key={p.id} className="border-b border-border last:border-b-0">
                    <td className="px-6 py-3.5">
                      <p className="font-semibold text-text-primary">{p.name}</p>
                      {p.url && <p className="max-w-[360px] truncate text-[13px] text-text-muted">{p.url.replace(/^https?:\/\//, '')}</p>}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3.5 text-right tabular-nums text-text-primary">
                      {formatPrice(p.basePrice, p.currency)} <span className="text-xs text-text-muted">{p.currency}</span>
                    </td>
                    <td className="px-4 py-3.5">
                      {own.length > 0 ? (
                        <Link to="/dashboard/campaigns" className="hover:underline">
                          <span className="text-text-primary">{own.length}</span>{' '}
                          <span className="text-[13px] text-text-muted">
                            {active === own.length ? (own.length === 1 ? 'active' : 'all active') : active === 0 ? 'none active' : `${active} active`}
                          </span>
                        </Link>
                      ) : (
                        canCreateCampaign && (
                          <Link to="/dashboard/campaigns/new" className="text-[13px] font-medium text-brand-text hover:underline">
                            Create a campaign
                          </Link>
                        )
                      )}
                    </td>
                    <td className="whitespace-nowrap px-6 py-3.5 tabular-nums text-text-secondary">{formatDate(p.createdAt)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>

      <p className="text-[13px] text-text-muted">
        {env === 'live' ? 'Live mode' : 'Test mode'}. A product belongs to the mode it was added in; {env === 'live' ? 'test' : 'live'} products are
        listed when the sidebar is on {env === 'live' ? 'Test' : 'Live'}.
      </p>
    </div>
  )
}
