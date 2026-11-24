import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { api } from '~/lib/api'
import { getActiveTeamId, useSession } from '~/lib/auth'
import { useEnv } from '~/lib/env'
import { usePermissions } from '~/lib/permissions'
import { formatDate } from '~/lib/format'
import { btnPrimary, EmptyState, PageHeader, Spinner } from '~/components/ui/page'
import { ErrorText, LifecycleStatus } from '~/components/ui/status'

export const Route = createFileRoute('/dashboard/experiments/')({
  component: ExperimentsPage,
})

function ExperimentsPage() {
  const { data: session } = useSession()
  const teamId = getActiveTeamId(session)
  const { env } = useEnv()
  const navigate = useNavigate()
  const canCreate = usePermissions().can('experiments.create')

  const { data: experiments = [], isPending, error, refetch } = useQuery({
    queryKey: ['experiments', teamId, env],
    queryFn: () => api.experiments.list(teamId, { environment: env }),
    enabled: !!teamId,
  })

  return (
    <div className="flex max-w-[1080px] flex-col gap-7">
      <PageHeader
        title="A/B Tests"
        description="Split a product's visitors between two campaigns and compare the results."
        actions={
          canCreate && (
            <Link to="/dashboard/experiments/new" className={btnPrimary}>
              New A/B test
            </Link>
          )
        }
      />

      <div className="overflow-x-auto border border-border bg-panel [contain:inline-size]">
        {isPending ? (
          <Spinner className="h-64" />
        ) : error ? (
          <div className="flex flex-col items-center gap-3 px-6 py-14">
            <ErrorText>Couldn't load the A/B tests.</ErrorText>
            <button type="button" onClick={() => refetch()} className="text-[13px] font-medium text-brand-text hover:underline">
              Try again
            </button>
          </div>
        ) : experiments.length === 0 ? (
          <EmptyState
            title="No A/B tests yet"
            action={
              canCreate && (
                <Link to="/dashboard/experiments/new" className={btnPrimary}>
                  Start your first A/B test
                </Link>
              )
            }
          >
            An A/B test sends part of a product's visitors to one campaign and the rest to another, so you can compare
            discount levels. You need two active campaigns for the same product.
          </EmptyState>
        ) : (
          <table className="w-full min-w-[760px] text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs text-text-muted">
                <th scope="col" className="px-6 py-3 font-semibold">Test</th>
                <th scope="col" className="px-4 py-3 font-semibold">A</th>
                <th scope="col" className="px-4 py-3 font-semibold">B</th>
                <th scope="col" className="px-4 py-3 text-right font-semibold">Split A/B</th>
                <th scope="col" className="px-4 py-3 font-semibold">Status</th>
                <th scope="col" className="px-6 py-3 font-semibold">Started</th>
              </tr>
            </thead>
            <tbody>
              {experiments.map((e) => (
                // The row opens the test on click; the name is the link for keyboards and screen readers.
                <tr
                  key={e.id}
                  onClick={() => navigate({ to: '/dashboard/experiments/$id', params: { id: e.id } })}
                  className="cursor-pointer border-b border-border transition-colors last:border-b-0 hover:bg-surface"
                >
                  <td className="px-6 py-3.5">
                    <Link
                      to="/dashboard/experiments/$id"
                      params={{ id: e.id }}
                      onClick={(ev) => ev.stopPropagation()}
                      className="font-semibold text-text-primary hover:underline"
                    >
                      {e.name}
                    </Link>
                  </td>
                  {/* Once a campaign is deleted, its name from when the test started. */}
                  <td className="px-4 py-3.5 text-text-secondary">{e.campaignA?.name ?? `${e.campaignAName} (deleted)`}</td>
                  <td className="px-4 py-3.5 text-text-secondary">{e.campaignB?.name ?? `${e.campaignBName} (deleted)`}</td>
                  <td className="px-4 py-3.5 text-right tabular-nums text-text-primary">
                    {100 - e.trafficSplitB}/{e.trafficSplitB}
                  </td>
                  <td className="px-4 py-3.5">
                    <LifecycleStatus state={e.status === 'running' ? 'on' : 'paused'}>{e.status === 'running' ? 'Running' : 'Ended'}</LifecycleStatus>
                  </td>
                  <td className="whitespace-nowrap px-6 py-3.5 tabular-nums text-text-secondary">{formatDate(e.startedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
