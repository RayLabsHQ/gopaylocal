import { createFileRoute, Link } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import {
  columnVisibilityFeature,
  createColumnHelper,
  flexRender,
  tableFeatures,
  useTable,
} from '@tanstack/react-table'
import { api, type Product } from '~/lib/api'
import { getActiveTeamId, useSession } from '~/lib/auth'
import { useEnv } from '~/lib/env'
import { usePermissions } from '~/lib/permissions'
import { CURRENCY_SYMBOLS } from '@gopaylocal/shared'

export const Route = createFileRoute('/dashboard/products/')({
  component: ProductsPage,
})

// Table v9 only includes the features registered here. columnVisibilityFeature
// provides row.getVisibleCells().
const features = tableFeatures({ columnVisibilityFeature })

const columnHelper = createColumnHelper<typeof features, Product>()

const columns = columnHelper.columns([
  columnHelper.accessor('name', {
    header: 'Product Name',
    cell: (info) => (
      <div className="max-w-xs">
        <span className="font-medium text-text-primary">{info.getValue()}</span>
        {info.row.original.url && (
          <p className="mt-0.5 truncate text-[13px] text-text-secondary">{info.row.original.url}</p>
        )}
      </div>
    ),
  }),
  columnHelper.accessor('currency', {
    header: 'Currency',
    cell: (info) => (
      <span className="font-mono text-sm text-text-primary">{info.getValue()}</span>
    ),
  }),
  columnHelper.accessor('basePrice', {
    header: 'Base Price',
    cell: (info) => {
      const currency = info.row.original.currency
      const symbol = CURRENCY_SYMBOLS[currency] ?? currency
      return (
        <span className="font-mono text-sm font-medium tabular-nums text-text-primary">
          {symbol}{info.getValue().toFixed(2)}
        </span>
      )
    },
  }),
  columnHelper.accessor('createdAt', {
    header: 'Created',
    cell: (info) => (
      <span className="font-mono text-sm tabular-nums text-text-secondary">
        {new Date(info.getValue()).toLocaleDateString()}
      </span>
    ),
  }),
])

function ProductsPage() {
  const { data: session } = useSession()
  const teamId = getActiveTeamId(session)
  const { env } = useEnv()
  // Adding products is products.create (owner and admin).
  const canCreate = usePermissions().can('products.create')

  const { data: products = [], isPending, error } = useQuery({
    queryKey: ['products', teamId, env],
    queryFn: () => api.products.list(teamId, env),
    enabled: !!teamId,
  })

  const table = useTable({
    features,
    data: products,
    columns,
  })

  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="font-display text-4xl font-medium tracking-tight text-text-primary">
            Products
          </h1>
          <p className="mt-1 text-base text-text-secondary">
            Manage your products and PPP discount rules
          </p>
        </div>
        {canCreate && (
          <Link
            to="/dashboard/products/new"
            className="flex items-center gap-2 bg-brand px-4 py-2 text-[13px] font-medium text-white transition-colors hover:bg-brand/90"
          >
            <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
            </svg>
            Add Product
          </Link>
        )}
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
            Failed to load products. Please try again.
          </div>
        ) : products.length === 0 ? (
          <div className="flex h-64 flex-col items-center justify-center px-6 text-center">
            <svg className="h-7 w-7 text-text-secondary" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="m21 7.5-9-5.25L3 7.5m18 0-9 5.25m9-5.25v9l-9 5.25M3 7.5l9 5.25M3 7.5v9l9 5.25m0-9v9" />
            </svg>
            <p className="mt-3 text-base font-medium text-text-primary">No products yet</p>
            <p className="mt-1.5 max-w-sm text-sm text-text-secondary">
              {canCreate
                ? 'A product is the thing you sell — its name, currency, and full price. Add one, then build a campaign on top of it to set PPP discounts.'
                : "You don't have access to any products yet. The workspace owner chooses which products you can work on."}
            </p>
            {canCreate && (
              <Link
                to="/dashboard/products/new"
                className="mt-3 text-sm font-medium text-brand-text hover:underline"
              >
                Create your first product
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
                <tr key={row.id} className="border-b border-border last:border-b-0 transition-colors hover:bg-surface">
                  {row.getVisibleCells().map((cell) => (
                    <td key={cell.id} className="whitespace-nowrap px-5 py-4 text-sm text-text-secondary">
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
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
