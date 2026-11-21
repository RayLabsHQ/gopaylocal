import { createFileRoute } from '@tanstack/react-router'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  useTable,
  tableFeatures,
  columnSizingFeature,
  columnVisibilityFeature,
  rowExpandingFeature,
  createExpandedRowModel,
  flexRender,
  createColumnHelper,
  type ExpandedState,
} from '@tanstack/react-table'
import { useState, Fragment } from 'react'
import { adminApi, type AdminUser } from '~/lib/api'

export const Route = createFileRoute('/admin/users')({
  component: UsersPage,
})

// Table v9 only includes the features registered here. columnSizingFeature
// provides the column `size` option and header.getSize(); columnVisibilityFeature
// provides row.getVisibleCells().
const features = tableFeatures({
  columnSizingFeature,
  columnVisibilityFeature,
  rowExpandingFeature,
  expandedRowModel: createExpandedRowModel(),
})

const columnHelper = createColumnHelper<typeof features, AdminUser>()

function UsersPage() {
  const queryClient = useQueryClient()
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const [expanded, setExpanded] = useState<ExpandedState>({})

  const { data, isPending } = useQuery({
    queryKey: ['admin', 'users', { page, search }],
    queryFn: () => adminApi.users.list({ page, search: search || undefined }),
  })

  const banMutation = useMutation({
    mutationFn: (userId: string) => adminApi.users.ban(userId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['admin', 'users'] }),
  })

  const unbanMutation = useMutation({
    mutationFn: (userId: string) => adminApi.users.unban(userId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['admin', 'users'] }),
  })

  const columns = columnHelper.columns([
    columnHelper.display({
      id: 'expand',
      header: '',
      size: 40,
      cell: ({ row }) => (
        <button
          type="button"
          onClick={(e) => {
            // The row itself also toggles on click; stop the bubble so the
            // button doesn't toggle twice (open then immediately close).
            e.stopPropagation()
            row.toggleExpanded()
          }}
          className="cursor-pointer p-1 text-text-muted transition-colors hover:text-accent"
        >
          <svg
            className={`h-4 w-4 transition-transform ${row.getIsExpanded() ? 'rotate-90' : ''}`}
            fill="none"
            viewBox="0 0 24 24"
            strokeWidth={2}
            stroke="currentColor"
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="m8.25 4.5 7.5 7.5-7.5 7.5" />
          </svg>
        </button>
      ),
    }),
    columnHelper.accessor('name', {
      header: 'Name',
      cell: (info) => {
        const image = info.row.original.image
        return (
          <div className="flex items-center gap-3">
            {image ? (
              <img src={image} alt="" className="h-8 w-8 shrink-0 object-cover" />
            ) : (
              <div className="flex h-8 w-8 shrink-0 items-center justify-center border border-border bg-surface-raised font-mono text-xs font-semibold text-text-secondary">
                {info.getValue()?.charAt(0)?.toUpperCase() || '?'}
              </div>
            )}
            <span className="font-medium text-text-primary">{info.getValue() || 'Unnamed'}</span>
          </div>
        )
      },
    }),
    columnHelper.accessor('email', {
      header: 'Email',
      cell: (info) => <span className="font-mono text-[13px] text-text-secondary">{info.getValue()}</span>,
    }),
    columnHelper.accessor('createdAt', {
      header: 'Created',
      cell: (info) => (
        <span className="font-mono text-[13px] text-text-muted">
          {new Date(info.getValue()).toLocaleDateString()}
        </span>
      ),
    }),
    columnHelper.accessor('banned', {
      header: 'Status',
      cell: (info) => {
        const banned = info.getValue()
        return (
          <span
            className={`inline-flex border px-2 py-0.5 font-mono text-[11px] font-semibold uppercase tracking-[0.08em] ${
              banned
                ? 'border-danger/40 bg-danger/10 text-danger'
                : 'border-accent/40 bg-accent/10 text-accent'
            }`}
          >
            {banned ? 'Banned' : 'Active'}
          </span>
        )
      },
    }),
    columnHelper.display({
      id: 'actions',
      header: 'Actions',
      cell: ({ row }) => {
        const user = row.original
        const isBanned = user.banned === true
        const isMutating = banMutation.isPending || unbanMutation.isPending
        return (
          <div className="flex items-center gap-2">
            {isBanned ? (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation()
                  if (window.confirm(`Unban ${user.name || user.email}?`)) {
                    unbanMutation.mutate(user.id)
                  }
                }}
                disabled={isMutating}
                className="cursor-pointer border border-border px-2.5 py-1 text-[13px] font-medium text-accent transition-colors hover:border-accent disabled:cursor-not-allowed disabled:opacity-50"
              >
                Unban
              </button>
            ) : (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation()
                  if (window.confirm(`Ban ${user.name || user.email}? They will lose access immediately.`)) {
                    banMutation.mutate(user.id)
                  }
                }}
                disabled={isMutating}
                className="cursor-pointer border border-border px-2.5 py-1 text-[13px] font-medium text-danger transition-colors hover:border-danger disabled:cursor-not-allowed disabled:opacity-50"
              >
                Ban
              </button>
            )}
          </div>
        )
      },
    }),
  ])

  const table = useTable({
    features,
    data: data?.data ?? [],
    columns,
    state: { expanded },
    onExpandedChange: setExpanded,
    getRowCanExpand: () => true,
  })

  const totalPages = data?.pagination?.totalPages ?? 1

  return (
    <div>
      <h1 className="font-display text-[42px] font-bold tracking-tight text-text-primary">Users</h1>
      <p className="mt-1 text-base text-text-secondary">
        <span className="font-mono text-accent">//</span> Every account on the platform
        {' '}({data?.pagination?.total ?? 0} total)
      </p>

      {/* Search */}
      <div className="mt-6 max-w-sm">
        <div className="relative">
          <svg
            className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-muted"
            fill="none"
            viewBox="0 0 24 24"
            strokeWidth={2}
            stroke="currentColor"
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="m21 21-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607Z" />
          </svg>
          <input
            type="text"
            placeholder="Search by name or email"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value)
              setPage(1)
            }}
            className="w-full border border-border bg-surface py-2.5 pl-10 pr-4 text-sm text-text-primary outline-none transition-colors placeholder:text-text-muted focus:border-accent"
          />
        </div>
      </div>

      {/* Table */}
      <div className="mt-6 border border-border bg-surface">
        {isPending ? (
          <div className="flex h-64 items-center justify-center">
            <div className="h-6 w-6 animate-spin rounded-full border-4 border-border-strong border-t-accent" />
          </div>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-border">
                <thead className="bg-surface-raised">
                  {table.getHeaderGroups().map((headerGroup) => (
                    <tr key={headerGroup.id}>
                      {headerGroup.headers.map((header) => (
                        <th
                          key={header.id}
                          className="eyebrow px-6 py-3 text-left"
                          style={{ width: header.getSize() !== 150 ? header.getSize() : undefined }}
                        >
                          {header.isPlaceholder
                            ? null
                            : flexRender(header.column.columnDef.header, header.getContext())}
                        </th>
                      ))}
                    </tr>
                  ))}
                </thead>
                <tbody className="divide-y divide-border">
                  {table.getRowModel().rows.length === 0 ? (
                    <tr>
                      <td colSpan={columns.length} className="px-6 py-16 text-center">
                        <p className="text-base font-medium text-text-primary">No users found</p>
                        <p className="mt-1.5 text-sm text-text-secondary">
                          {search
                            ? 'Nothing matches that search. Try a different name or email.'
                            : 'Users appear here as soon as the first person signs up.'}
                        </p>
                      </td>
                    </tr>
                  ) : (
                    table.getRowModel().rows.map((row) => (
                      <Fragment key={row.id}>
                        <tr
                          className="cursor-pointer transition-colors hover:bg-surface-raised"
                          onClick={() => row.toggleExpanded()}
                        >
                          {row.getVisibleCells().map((cell) => (
                            <td key={cell.id} className="whitespace-nowrap px-6 py-4 text-sm">
                              {flexRender(cell.column.columnDef.cell, cell.getContext())}
                            </td>
                          ))}
                        </tr>
                        {row.getIsExpanded() && (
                          <tr>
                            <td colSpan={columns.length} className="border-l-2 border-l-accent bg-bg px-6 py-5">
                              <UserDetails user={row.original} />
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    ))
                  )}
                </tbody>
              </table>
            </div>

            {/* Pagination */}
            {totalPages > 1 && (
              <div className="flex items-center justify-between border-t border-border px-6 py-3">
                <p className="font-mono text-[13px] text-text-secondary">
                  Page {page} of {totalPages}
                </p>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                    disabled={page <= 1}
                    className="cursor-pointer border border-border px-3 py-1.5 text-[13px] font-medium text-text-secondary transition-colors hover:border-accent hover:text-accent disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-border disabled:hover:text-text-secondary"
                  >
                    Previous
                  </button>
                  <button
                    type="button"
                    onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                    disabled={page >= totalPages}
                    className="cursor-pointer border border-border px-3 py-1.5 text-[13px] font-medium text-text-secondary transition-colors hover:border-accent hover:text-accent disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-border disabled:hover:text-text-secondary"
                  >
                    Next
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}

function UserDetails({ user }: { user: AdminUser }) {
  return (
    <div>
      <h3 className="text-base font-semibold text-text-primary">User details</h3>
      <div className="mt-3 grid grid-cols-2 gap-x-8 gap-y-4 md:grid-cols-4">
        <Field label="ID" value={user.id} mono />
        <Field label="Email" value={user.email} mono />
        <Field label="Role" value={user.role ?? 'user'} />
        <Field label="Created" value={new Date(user.createdAt).toLocaleString()} mono />
        <Field
          label="Status"
          value={user.banned ? 'Banned' : 'Active'}
          className={user.banned ? 'text-danger' : 'text-accent'}
        />
      </div>
    </div>
  )
}

/** L3: label above one value inside a panel — sentence case, not an eyebrow. */
function Field({ label, value, mono, className }: { label: string; value: string; mono?: boolean; className?: string }) {
  return (
    <div className="min-w-0">
      <p className="text-[13px] text-text-secondary">{label}</p>
      <p className={`mt-1 break-all text-sm ${mono ? 'font-mono' : ''} ${className ?? 'text-text-primary'}`}>
        {value}
      </p>
    </div>
  )
}
