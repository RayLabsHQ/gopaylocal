import { createFileRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { minorToMajor } from '@gopaylocal/shared/currency'
import { adminApi } from '~/lib/api'
import {
  EmptyState,
  ErrorBox,
  KPICard,
  Panel,
  PageHeader,
  Spinner,
  Table,
  Tag,
  flag,
  formatDate,
  formatMoney,
  formatMoneyMap,
  td,
  tdRight,
} from '~/components/ui'

export const Route = createFileRoute('/admin/revenue')({
  component: RevenuePage,
})

function RevenuePage() {
  const { data, isPending, error, refetch } = useQuery({
    queryKey: ['admin', 'revenue'],
    queryFn: () => adminApi.revenue.get(),
  })
  const s = data?.summary

  return (
    <div>
      <PageHeader title="Revenue" subtitle="Live Pro subscriptions, at what Dodo charges each one" />

      {error && (
        <div className="mt-6">
          <ErrorBox message="Couldn't load revenue." onRetry={() => refetch()} />
        </div>
      )}

      <div className="mt-8 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <KPICard
          title="MRR"
          qualifier="Live"
          value={isPending || !s ? '--' : formatMoneyMap(s.mrrByCurrency)}
          sub="Pre-tax. Currencies are never added together."
          highlight
        />
        <KPICard
          title="Pro subscriptions"
          value={isPending || !s ? '--' : String(s.active)}
          sub={s && s.pastDue > 0 ? `${s.pastDue} past due` : 'None past due'}
        />
        <KPICard
          title="This month"
          value={isPending || !s ? '--' : `+${s.newThisMonth} / −${s.cancelledThisMonth}`}
          sub="New and ended, UTC month"
        />
        <KPICard
          title="Churn"
          qualifier="This month"
          value={isPending || !s ? '--' : s.churn.rate === null ? '—' : `${(s.churn.rate * 100).toFixed(1)}%`}
          sub={s ? `${s.churn.ended} of ${s.churn.runningOnFirst} running on the 1st` : undefined}
        />
      </div>

      {s && (s.leftOut.test > 0 || s.leftOut.internal > 0) && (
        <p className="mt-3 text-[13px] text-text-muted">
          Not counted: {s.leftOut.test} paid in Dodo test mode, {s.leftOut.internal} in internal workspaces.
        </p>
      )}

      <div className="mt-8 grid grid-cols-1 gap-6 lg:grid-cols-5">
        <div className="lg:col-span-2">
          <Panel title="Buyers by country" chip="Billing address" flush>
            {isPending ? (
              <Spinner className="h-40" />
            ) : !s || s.byCountry.length === 0 ? (
              <EmptyState title="No live subscriptions yet" body="Each Pro buyer's billing country shows up here, with what they pay." />
            ) : (
              <Table headers={['Country', { label: 'Subs', right: true }, { label: 'Monthly', right: true }]}>
                {s.byCountry.map((c) => (
                  <tr key={c.country ?? 'unknown'}>
                    <td className={`${td} text-text-primary`}>
                      <span className="mr-2">{flag(c.country)}</span>
                      {c.countryName}
                    </td>
                    <td className={tdRight}>{c.subscriptions}</td>
                    <td className={`${tdRight} text-text-primary`}>{formatMoneyMap(c.mrrByCurrency)}</td>
                  </tr>
                ))}
              </Table>
            )}
          </Panel>
        </div>

        <div className="lg:col-span-3">
          <Panel title="Subscriptions" chip="Newest change first" flush>
            {isPending ? (
              <Spinner className="h-40" />
            ) : !data || data.subscriptions.length === 0 ? (
              <EmptyState title="No subscriptions yet" body="Every workspace that has ever paid shows up here." />
            ) : (
              <Table headers={['Workspace', 'Status', 'Country', { label: 'Pays', right: true }, 'Since']}>
                {data.subscriptions.map((sub) => {
                  const amount =
                    sub.recurringAmount !== null && sub.currency
                      ? formatMoney(minorToMajor(sub.recurringAmount, sub.currency), sub.currency)
                      : '—'
                  return (
                    <tr key={sub.organizationId} className={sub.environment === 'test' || sub.internal ? 'opacity-60' : ''}>
                      <td className={`${td} text-text-primary`}>
                        <span className="mr-2">{sub.organizationName ?? 'Deleted workspace'}</span>
                        {sub.environment === 'test' && <Tag>Test</Tag>}
                        {sub.internal && <Tag>Internal</Tag>}
                      </td>
                      <td className={td}>
                        <Tag tone={sub.status === 'active' ? 'accent' : sub.status === 'past_due' ? 'warning' : 'neutral'}>
                          {sub.status.replace('_', ' ')}
                        </Tag>
                      </td>
                      <td className={td}>
                        {sub.billingCountry ? `${flag(sub.billingCountry)} ${sub.billingCountry}` : '—'}
                      </td>
                      <td className={`${tdRight} text-text-primary`}>{amount}</td>
                      <td className={td}>{formatDate(sub.createdAt)}</td>
                    </tr>
                  )
                })}
              </Table>
            )}
          </Panel>
        </div>
      </div>
    </div>
  )
}
