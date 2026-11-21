import { createFileRoute, Link } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import {
  columnVisibilityFeature,
  createColumnHelper,
  flexRender,
  tableFeatures,
  useTable,
} from '@tanstack/react-table'
import { api, type Experiment } from '~/lib/api'
import { getActiveTeamId, useSession } from '~/lib/auth'
import { useEnv } from '~/lib/env'
import { usePermissions } from '~/lib/permissions'

export const Route = createFileRoute('/dashboard/experiments/')({
  component: ExperimentsPage,
})

// Table v9 only includes the features registered here. columnVisibilityFeature
// provides row.getVisibleCells().
const features = tableFeatures({ columnVisibilityFeature })

const columnHelper = createColumnHelper<typeof features, Experiment>()

const columns = columnHelper.columns([
  columnHelper.accessor('name', {
    header: 'Name',
    cell: (info) => (
      <span className="font-medium text-text-primary transition-colors group-hover:text-brand-text">
        {info.getValue()}
      </span>
    ),
  }),
  columnHelper.accessor('campaignA', {
    header: 'A (control)',
    // Once a campaign is deleted, its name from when the test started.
    cell: (info) => info.getValue()?.name ?? `${info.row.original.campaignAName} (deleted)`,
  }),
  columnHelper.accessor('campaignB', {
    header: 'B (variant)',
    cell: (info) => info.getValue()?.name ?? `${info.row.original.campaignBName} (deleted)`,
  }),
  columnHelper.accessor('trafficSplitB', {
    header: 'Split A/B',
    cell: (info) => (
      <span className="font-mono font-medium tabular-nums text-text-primary">
        {100 - info.getValue()}/{info.getValue()}
      </span>
    ),
  }),
  columnHelper.accessor('status', {
    header: 'Status',
    cell: (info) => {
      const status = info.getValue()
      const styles: Record<string, string> = {
        running: 'bg-success-light text-success',
        ended: 'bg-surface text-text-secondary',
      }
      return (
        <span className={`px-2 py-0.5 text-xs font-medium capitalize ${styles[status] ?? ''}`}>
          {status}
        </span>
      )
    },
  }),
  columnHelper.accessor('startedAt', {
    header: 'Started',
    cell: (info) => (
      <span className="font-mono tabular-nums">
        {new Date(info.getValue()).toLocaleDateString()}
      </span>
    ),
  }),
])

function ExperimentsPage() {
  const { data: session } = useSession()
  const teamId = getActiveTeamId(session)
  const { env } = useEnv()
  const { can } = usePermissions()

  const { data: experiments = [], isPending, error } = useQuery({
    queryKey: ['experiments', teamId, env],
    queryFn: () => api.experiments.list(teamId, { environment: env }),
    enabled: !!teamId,
  })

  const table = useTable({
    features,
    data: experiments,
    columns,
  })

  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="font-display text-4xl font-medium tracking-tight text-text-primary">
            A/B Tests
          </h1>
          <p className="mt-1 text-base text-text-secondary">
            Split visitors between two campaigns of one product and compare the results
          </p>
        </div>
        {can('experiments.create') && (
          <Link
            to="/dashboard/experiments/new"
            className="flex items-center gap-2 bg-brand px-4 py-2 text-[13px] font-medium text-white transition-colors hover:bg-brand/90"
          >
            <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
            </svg>
            New A/B Test
          </Link>
        )}
      </div>

      <div className="mt-6 overflow-x-auto border border-border">
        {isPending ? (
          <div className="flex h-64 items-center justify-center">
            <div className="h-6 w-6 animate-spin rounded-full border-4 border-border border-t-brand" />
          </div>
        ) : error ? (
          <div className="flex h-64 items-center justify-center px-6 text-center text-sm text-brand-text">
            Failed to load A/B tests. Please try again.
          </div>
        ) : experiments.length === 0 ? (
          <div className="flex h-64 flex-col items-center justify-center px-6 text-center">
            <p className="text-base font-medium text-text-primary">No A/B tests yet</p>
            <p className="mt-1.5 max-w-sm text-sm text-text-secondary">
              An A/B test sends part of a product's visitors to one campaign and the rest to
              another, so you can compare discount levels. You'll need two active campaigns for
              the same product.
            </p>
            {can('experiments.create') && (
              <Link
                to="/dashboard/experiments/new"
                className="mt-3 text-sm font-medium text-brand-text hover:underline"
              >
                Start your first A/B test
              </Link>
            )}
          </div>
        ) : (
          <table className="min-w-full">
            <thead>
              <tr className="border-b border-border bg-surface">
                {table.getHeaderGroups().map((headerGroup) =>
                  headerGroup.headers.map((header) => (
                    <th
                      key={header.id}
                      className="px-5 py-3 text-left text-[13px] font-semibold text-text-secondary"
                    >
                      {header.isPlaceholder
                        ? null
                        : flexRender(header.column.columnDef.header, header.getContext())}
                    </th>
                  ))
                )}
              </tr>
            </thead>
            <tbody>
              {table.getRowModel().rows.map((row) => (
                <tr key={row.id} className="group cursor-pointer border-b border-border last:border-b-0 transition-colors hover:bg-surface">
                  {row.getVisibleCells().map((cell) => (
                    <td key={cell.id} className="whitespace-nowrap px-5 py-4 text-sm text-text-secondary">
                      <Link
                        to="/dashboard/experiments/$id"
                        params={{ id: row.original.id }}
                        className="block"
                      >
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </Link>
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
