import { createFileRoute, Link } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import {
  columnVisibilityFeature,
  createColumnHelper,
  flexRender,
  tableFeatures,
  useTable,
} from '@tanstack/react-table'
import { api, PRICING_MODE_LABELS, DISCOUNT_DELIVERY_LABELS, type Campaign } from '~/lib/api'
import { getActiveTeamId, useSession } from '~/lib/auth'
import { useEnv } from '~/lib/env'

export const Route = createFileRoute('/dashboard/campaigns/')({
  component: CampaignsPage,
})

// Table v9 only includes the features registered here. columnVisibilityFeature
// provides row.getVisibleCells().
const features = tableFeatures({ columnVisibilityFeature })

const columnHelper = createColumnHelper<typeof features, Campaign>()

const columns = columnHelper.columns([
  columnHelper.accessor('name', {
    header: 'Name',
    cell: (info) => (
      <span className="font-medium text-text-primary transition-colors group-hover:text-brand-text">
        {info.getValue()}
      </span>
    ),
  }),
  columnHelper.accessor('pricingMode', {
    header: 'Pricing Mode',
    cell: (info) => (
      <span className="bg-surface px-2 py-0.5 text-xs font-medium text-text-secondary">
        {PRICING_MODE_LABELS[info.getValue()] ?? info.getValue()}
      </span>
    ),
  }),
  columnHelper.accessor('discountDelivery', {
    header: 'Delivery',
    cell: (info) => DISCOUNT_DELIVERY_LABELS[info.getValue()] ?? info.getValue(),
  }),
  columnHelper.accessor('maxDiscountPercent', {
    header: 'Max Discount',
    cell: (info) => (
      <span className="font-mono font-medium tabular-nums text-text-primary">{info.getValue()}%</span>
    ),
  }),
  columnHelper.accessor('status', {
    header: 'Status',
    cell: (info) => {
      const status = info.getValue()
      const styles: Record<string, string> = {
        active: 'bg-success-light text-success',
        paused: 'bg-brand-light text-brand-text',
        draft: 'bg-surface text-text-secondary',
      }
      return (
        <span className={`px-2 py-0.5 text-xs font-medium capitalize ${styles[status] ?? ''}`}>
          {status}
        </span>
      )
    },
  }),
  columnHelper.accessor('createdAt', {
    header: 'Created',
    cell: (info) => (
      <span className="font-mono tabular-nums">
        {new Date(info.getValue()).toLocaleDateString()}
      </span>
    ),
  }),
])

function CampaignsPage() {
  const { data: session } = useSession()
  const teamId = getActiveTeamId(session)
  const { env } = useEnv()

  const { data: campaigns = [], isPending, error } = useQuery({
    queryKey: ['campaigns', teamId, env],
    queryFn: () => api.campaigns.list(teamId, env),
    enabled: !!teamId,
  })

  const table = useTable({
    features,
    data: campaigns,
    columns,
  })

  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="font-display text-4xl font-medium tracking-tight text-text-primary">
            Campaigns
          </h1>
          <p className="mt-1 text-base text-text-secondary">
            Configure how PPP discounts are calculated and delivered
          </p>
        </div>
        <Link
          to="/dashboard/campaigns/new"
          className="flex items-center gap-2 bg-brand px-4 py-2 text-[13px] font-medium text-white transition-colors hover:bg-brand/90"
        >
          <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
          </svg>
          New Campaign
        </Link>
      </div>

      {/* inline-size containment keeps the table's width inside this box: the
          page's ScrollArea wraps content in a display:table div that otherwise
          grows to the table's minimum width and clips the page on a phone. */}
      <div className="mt-6 overflow-x-auto border border-border [contain:inline-size]">
        {isPending ? (
          <div className="flex h-64 items-center justify-center">
            <div className="h-6 w-6 animate-spin rounded-full border-4 border-border border-t-brand" />
          </div>
        ) : error ? (
          <div className="flex h-64 items-center justify-center px-6 text-center text-sm text-brand-text">
            Failed to load campaigns. Please try again.
          </div>
        ) : campaigns.length === 0 ? (
          <div className="flex h-64 flex-col items-center justify-center px-6 text-center">
            <p className="text-base font-medium text-text-primary">No campaigns yet</p>
            <p className="mt-1.5 max-w-sm text-sm text-text-secondary">
              A campaign decides how much each country gets off and how the discount reaches the
              buyer — a banner with a coupon code, or applied automatically at checkout. You'll need
              a product first.
            </p>
            <Link
              to="/dashboard/campaigns/new"
              className="mt-3 text-sm font-medium text-brand-text hover:underline"
            >
              Create your first campaign
            </Link>
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
                        to="/dashboard/campaigns/$id"
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
