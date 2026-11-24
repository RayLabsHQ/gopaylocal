import { createFileRoute, Link } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
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
  formatDate,
  formatDateTime,
  td,
  tdRight,
} from '~/components/ui'

export const Route = createFileRoute('/admin/health')({
  component: HealthPage,
})

function HealthPage() {
  const { data, isPending, error, refetch } = useQuery({
    queryKey: ['admin', 'health'],
    queryFn: () => adminApi.health.get(),
  })

  const failedTotal = data?.failedWebhooks.reduce((a, w) => a + w.count, 0) ?? 0
  const fx = data?.fxRates
  const lastSync = data?.housePricing?.lastSync ?? null

  return (
    <div>
      <PageHeader title="Health" subtitle="What is failing for customers, and what is falling behind" />

      {error && (
        <div className="mt-6">
          <ErrorBox message="Couldn't load health." onRetry={() => refetch()} />
        </div>
      )}

      <div className="mt-8 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <KPICard title="Failed webhooks" qualifier="7 days" value={isPending ? '--' : String(failedTotal)} highlight={failedTotal > 0} />
        <KPICard
          title="Webhook backlog"
          value={isPending || !data ? '--' : String(data.webhookBacklog.unprocessed)}
          sub={data?.webhookBacklog.oldest ? `Oldest ${formatDateTime(data.webhookBacklog.oldest)}` : 'Nothing waiting'}
        />
        <KPICard
          title="Integrations with a problem"
          value={isPending || !data ? '--' : String(data.integrations.length)}
          highlight={(data?.integrations.length ?? 0) > 0}
        />
        <KPICard
          title="Exchange rates"
          value={!fx ? '--' : fx.state === 'off' ? 'Off' : fx.state === 'fresh' ? 'Fresh' : fx.state === 'stale' ? 'Stale' : 'Missing'}
          sub={fx && fx.state !== 'off' ? (fx.asOf ? `As of ${formatDate(fx.asOf)}` : 'Local prices show in the product currency') : undefined}
          highlight={fx?.state === 'stale' || fx?.state === 'missing'}
        />
      </div>

      <div className="mt-8 space-y-6">
        <Panel title="Failed webhooks" chip="Last 7 days, by event" flush>
          {isPending ? (
            <Spinner className="h-32" />
          ) : !data || data.failedWebhooks.length === 0 ? (
            <EmptyState className="h-32" title="No failures" body="Payment-platform and billing webhooks that fail to process show up here." />
          ) : (
            <Table headers={['Provider', 'Event', { label: 'Count', right: true }, 'Last', 'Last error']}>
              {data.failedWebhooks.map((w) => (
                <tr key={`${w.provider}:${w.eventType}`}>
                  <td className={`${td} capitalize text-text-primary`}>{w.provider}</td>
                  <td className={`${td} font-mono text-[13px]`}>{w.eventType}</td>
                  <td className={tdRight}>{w.count}</td>
                  <td className={td}>{formatDateTime(w.lastAt)}</td>
                  <td className="max-w-md px-5 py-3 text-[13px] text-text-secondary">{w.lastError ?? '—'}</td>
                </tr>
              ))}
            </Table>
          )}
        </Panel>

        <Panel title="Integrations with a problem" chip="What the merchant sees" flush>
          {isPending ? (
            <Spinner className="h-32" />
          ) : !data || data.integrations.length === 0 ? (
            <EmptyState className="h-32" title="All integrations healthy" body="Rejected keys, codes that couldn't be created and webhook trouble show up here." />
          ) : (
            <Table headers={['Workspace', 'Provider', 'Problem', 'Seen']}>
              {data.integrations.flatMap((i) =>
                (i.issues.length > 0 ? i.issues : [{ area: i.status, message: `Status: ${i.status}`, at: '' }]).map((issue) => (
                  <tr key={`${i.id}:${issue.area}`}>
                    <td className={`${td} text-text-primary`}>
                      <span className="mr-2">{i.organizationName}</span>
                      {i.internal && <Tag>Internal</Tag>}
                    </td>
                    <td className={`${td} capitalize`}>{i.provider}</td>
                    <td className="max-w-md px-5 py-3 text-[13px] text-text-secondary">
                      <span className="mr-2 font-mono text-[11px] uppercase tracking-[0.08em] text-text-muted">{issue.area.replace('_', ' ')}</span>
                      {issue.message}
                    </td>
                    <td className={td}>{issue.at ? formatDateTime(issue.at) : '—'}</td>
                  </tr>
                )),
              )}
            </Table>
          )}
        </Panel>

        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <Panel title="Regional Pro price at Dodo">
            {isPending ? (
              <Spinner className="h-20" />
            ) : !data?.housePricing ? (
              <p className="text-sm text-text-secondary">
                No house campaign is set. <Link to="/admin/pricing" className="text-accent hover:text-text-primary">Set it up →</Link>
              </p>
            ) : !lastSync ? (
              <p className="text-sm text-text-secondary">Never pushed to Dodo yet.</p>
            ) : (
              <div className="space-y-1 text-sm text-text-secondary">
                <p>
                  Last sync {formatDateTime(lastSync.at)} ({lastSync.trigger === 'admin' ? 'by an admin' : 'scheduled'}):{' '}
                  {lastSync.created} created, {lastSync.updated} updated, {lastSync.archived} removed.
                </p>
                {lastSync.remaining > 0 && <p className="text-warning">{lastSync.remaining} changes still to send.</p>}
                {lastSync.failures.length > 0 && <p className="text-danger">{lastSync.failures.length} refused by Dodo.</p>}
                <Link to="/admin/pricing" className="inline-block pt-1 text-[13px] text-accent hover:text-text-primary">
                  Open regional price →
                </Link>
              </div>
            )}
          </Panel>
          <Panel title="Usage">
            <p className="text-sm text-text-secondary">
              Workspaces near or past their API-call and product limits are on{' '}
              <Link to="/admin/alerts" className="text-accent hover:text-text-primary">Alerts →</Link>
            </p>
          </Panel>
        </div>
      </div>
    </div>
  )
}
