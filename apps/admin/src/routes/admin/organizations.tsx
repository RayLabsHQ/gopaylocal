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
import { useState, useEffect, useId, Fragment } from 'react'
import { minorToMajor } from '@gopaylocal/shared/currency'
import { adminApi, type AdminOrganization } from '~/lib/api'
import { Tag, btn, flag, formatMoney } from '~/components/ui'

export const Route = createFileRoute('/admin/organizations')({
  component: OrganizationsPage,
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

const columnHelper = createColumnHelper<typeof features, AdminOrganization>()

// `limit: null` = unlimited (Pro, self-hosted): neutral color, never a ratio.
function usageColor(current: number, limit: number | null): string {
  if (limit === null || limit === 0) return 'text-text-secondary'
  const pct = (current / limit) * 100
  if (pct >= 80) return 'text-danger'
  if (pct >= 50) return 'text-warning'
  return 'text-accent'
}

function usageBgColor(current: number, limit: number | null): string {
  if (limit === null || limit === 0) return 'bg-border-strong'
  const pct = (current / limit) * 100
  if (pct >= 80) return 'bg-danger'
  if (pct >= 50) return 'bg-warning'
  return 'bg-accent'
}

function OrganizationsPage() {
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const [expanded, setExpanded] = useState<ExpandedState>({})

  const { data, isPending } = useQuery({
    queryKey: ['admin', 'organizations', { page, search }],
    queryFn: () => adminApi.organizations.list({ page, search: search || undefined }),
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
      cell: (info) => (
        <span className="flex items-center gap-2">
          <span className="font-medium text-text-primary">{info.getValue()}</span>
          {info.row.original.internal && <Tag>Internal</Tag>}
        </span>
      ),
    }),
    columnHelper.accessor('slug', {
      header: 'Slug',
      cell: (info) => <span className="font-mono text-[13px] text-text-secondary">{info.getValue()}</span>,
    }),
    columnHelper.accessor('plan', {
      header: 'Plan',
      cell: (info) => {
        const plan = info.getValue() ?? 'free'
        const isPaid = plan !== 'free'
        return (
          <span
            className={`inline-flex border px-2 py-0.5 font-mono text-[11px] font-semibold uppercase tracking-[0.08em] ${
              isPaid ? 'border-accent/40 bg-accent/10 text-accent' : 'border-border bg-surface-raised text-text-secondary'
            }`}
          >
            {plan}
            {info.row.original.subscriptionEnvironment === 'test' && plan !== 'free' ? ' · test' : ''}
          </span>
        )
      },
    }),
    columnHelper.accessor('subscriptionStatus', {
      header: 'Status',
      cell: (info) => {
        const status = info.getValue()
        // Only a genuinely broken subscription earns danger red. An org with no
        // subscription at all is just on Free, which is not a problem state.
        const broken = status === 'past_due' || status === 'canceled' || status === 'unpaid'
        const tone = status === 'active'
          ? 'border-accent/40 bg-accent/10 text-accent'
          : broken
            ? 'border-danger/40 bg-danger/10 text-danger'
            : 'border-border bg-surface-raised text-text-secondary'
        return (
          <span className={`inline-flex border px-2 py-0.5 font-mono text-[11px] font-semibold uppercase tracking-[0.08em] ${tone}`}>
            {status ?? 'None'}
          </span>
        )
      },
    }),
    columnHelper.accessor('createdAt', {
      header: 'Created',
      cell: (info) => (
        <span className="font-mono text-[13px] text-text-muted">
          {new Date(info.getValue()).toLocaleDateString()}
        </span>
      ),
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
      <h1 className="font-display text-[42px] font-bold tracking-tight text-text-primary">Organizations</h1>
      <p className="mt-1 text-base text-text-secondary">
        <span className="font-mono text-accent">//</span> Inspect accounts and override plan limits
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
            placeholder="Search by organization name"
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
                        <p className="text-base font-medium text-text-primary">No organizations found</p>
                        <p className="mt-1.5 text-sm text-text-secondary">
                          {search
                            ? 'Nothing matches that search. Try a different organization name.'
                            : 'Organizations appear here once someone creates a workspace.'}
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
                              <OrgDetails org={row.original} />
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

// ── Expanded Organization Details ────────────────────────────────────────────

function OrgDetails({ org }: { org: AdminOrganization }) {
  const queryClient = useQueryClient()
  const [showOverrideForm, setShowOverrideForm] = useState(false)
  const noteId = useId()

  // Fetch full detail data (usage, limits, subscription) from the detail endpoint
  const { data: detail, isPending: detailLoading } = useQuery({
    queryKey: ['admin', 'organizations', org.id],
    queryFn: () => adminApi.organizations.get(org.id),
  })

  // The form edits the OVERRIDE itself, not the effective limits: an empty
  // field (null) means "no override, use the plan default". Pre-filling with
  // effective limits would freeze Free-sized caps as overrides that keep
  // capping the org after it upgrades to (unlimited) Pro.
  const [overrideForm, setOverrideForm] = useState<{
    maxProducts: number | null
    maxApiHitsPerMonth: number | null
    maxTeamMembers: number | null
    note: string
  }>({
    maxProducts: null,
    maxApiHitsPerMonth: null,
    maxTeamMembers: null,
    note: '',
  })

  // Sync the form with the saved override when detail loads
  useEffect(() => {
    if (detail) {
      const o = detail.override
      const num = (v: unknown) => (typeof v === 'number' ? v : null)
      setOverrideForm({
        maxProducts: num(o?.maxProducts),
        maxApiHitsPerMonth: num(o?.maxApiHitsPerMonth),
        maxTeamMembers: num(o?.maxTeamMembers),
        note: '',
      })
    }
  }, [detail])

  const overrideMutation = useMutation({
    mutationFn: () =>
      adminApi.organizations.overrideLimits(org.id, {
        maxProducts: overrideForm.maxProducts,
        maxApiHitsPerMonth: overrideForm.maxApiHitsPerMonth,
        maxTeamMembers: overrideForm.maxTeamMembers,
        note: overrideForm.note || undefined,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'organizations'] })
      setShowOverrideForm(false)
    },
  })

  if (detailLoading) {
    return (
      <div className="flex h-32 items-center justify-center">
        <div className="h-5 w-5 animate-spin rounded-full border-4 border-border-strong border-t-accent" />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* Current Limits vs Usage */}
      {detail && (
        <div>
          <h3 className="text-base font-semibold text-text-primary">Current limits vs usage</h3>
          <div className="mt-3 grid grid-cols-1 divide-y divide-border border border-border sm:grid-cols-3 sm:divide-x sm:divide-y-0">
            <LimitCell
              label="Products"
              current={detail.usage.products}
              limit={detail.effectiveLimits.maxProducts}
            />
            <LimitCell
              label="API calls"
              qualifier="Monthly"
              current={detail.usage.apiHitsThisMonth}
              limit={detail.effectiveLimits.maxApiHitsPerMonth}
            />
            <LimitCell
              label="Team members"
              current={detail.usage.teamMembers}
              limit={detail.effectiveLimits.maxTeamMembers}
            />
          </div>
        </div>
      )}

      {/* Subscription Details */}
      {detail?.subscription && (
        <div>
          <h3 className="text-base font-semibold text-text-primary">Subscription</h3>
          <div className="mt-3 grid grid-cols-2 gap-x-8 gap-y-4 md:grid-cols-4">
            <Field label="Plan" value={String(detail.subscription.plan ?? 'free')} />
            <Field label="Status" value={String(detail.subscription.status ?? 'active')} />
            {detail.effectivePlan && (
              <Field label="Effective plan" value={detail.effectivePlan} />
            )}
            {detail.selfHosted && <Field label="Deployment" value="Self-hosted (unlimited)" />}
            {typeof detail.subscription.environment === 'string' && (
              <Field label="Paid in" value={detail.subscription.environment === 'test' ? 'Dodo test mode (not revenue)' : 'Dodo live mode'} />
            )}
            {typeof detail.subscription.recurringAmount === 'number' && typeof detail.subscription.currency === 'string' && (
              <Field
                label="Pays monthly"
                value={formatMoney(minorToMajor(detail.subscription.recurringAmount, detail.subscription.currency), detail.subscription.currency)}
              />
            )}
            {typeof detail.subscription.billingCountry === 'string' && (
              <Field label="Billing country" value={`${flag(detail.subscription.billingCountry)} ${detail.subscription.billingCountry}`} />
            )}
          </div>
        </div>
      )}

      {detail && <InternalToggle orgId={org.id} internal={detail.internal ?? null} />}

      {/* Members */}
      {detail?.members && detail.members.length > 0 && (
        <div>
          <h3 className="flex items-baseline gap-2.5 text-base font-semibold text-text-primary">
            Members
            <span className="eyebrow text-text-muted">{detail.members.length}</span>
          </h3>
          <div className="mt-3 divide-y divide-border border border-border">
            {detail.members.map((member) => (
              <div key={member.id} className="flex items-center justify-between gap-3 px-4 py-3">
                <div className="flex min-w-0 items-center gap-3">
                  {member.image ? (
                    <img src={member.image} alt="" className="h-8 w-8 shrink-0 object-cover" />
                  ) : (
                    <div className="flex h-8 w-8 shrink-0 items-center justify-center border border-border bg-surface font-mono text-xs font-semibold text-text-secondary">
                      {member.name?.charAt(0)?.toUpperCase() || member.email?.charAt(0)?.toUpperCase() || '?'}
                    </div>
                  )}
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-text-primary">{member.name || 'Unnamed'}</p>
                    <p className="truncate font-mono text-xs text-text-muted">{member.email}</p>
                  </div>
                </div>
                <span className="shrink-0 font-mono text-[11px] font-semibold uppercase tracking-[0.08em] text-text-secondary">
                  {member.role}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Override Limits */}
      <div>
        {!showOverrideForm ? (
          <button
            type="button"
            onClick={() => setShowOverrideForm(true)}
            className="cursor-pointer border border-border px-4 py-2 text-sm font-medium text-text-secondary transition-colors hover:border-accent hover:text-accent"
          >
            Override limits
          </button>
        ) : (
          <div className="border border-border bg-surface p-4">
            <h4 className="text-base font-semibold text-text-primary">Override limits</h4>
            <p className="mt-1 text-[13px] text-text-secondary">
              Custom limits replace the plan defaults for this organization only. Leave a
              field empty to use the plan default (Free: 1 product, 10K calls, 1 member;
              Pro: unlimited). Overrides also apply after an upgrade, so clear them when
              they're no longer needed. Ignored on self-hosted deployments.
            </p>
            <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-3">
              <NumberField
                label="Max products"
                value={overrideForm.maxProducts}
                onChange={(v) => setOverrideForm((f) => ({ ...f, maxProducts: v }))}
              />
              <NumberField
                label="Max API calls"
                qualifier="Monthly"
                value={overrideForm.maxApiHitsPerMonth}
                onChange={(v) => setOverrideForm((f) => ({ ...f, maxApiHitsPerMonth: v }))}
              />
              <NumberField
                label="Max team members"
                value={overrideForm.maxTeamMembers}
                onChange={(v) => setOverrideForm((f) => ({ ...f, maxTeamMembers: v }))}
              />
            </div>
            <div className="mt-4">
              <label className="block text-[13px] text-text-secondary" htmlFor={noteId}>
                Note <span className="text-text-muted">(optional)</span>
              </label>
              <input
                id={noteId}
                type="text"
                placeholder="Reason for the override"
                value={overrideForm.note}
                onChange={(e) => setOverrideForm((f) => ({ ...f, note: e.target.value }))}
                className="mt-1.5 w-full border border-border bg-bg px-3 py-2 text-sm text-text-primary outline-none transition-colors placeholder:text-text-muted focus:border-accent"
              />
            </div>
            <div className="mt-4 flex gap-3">
              <button
                type="button"
                onClick={() => overrideMutation.mutate()}
                disabled={overrideMutation.isPending}
                className="cursor-pointer bg-accent px-4 py-2 text-sm font-semibold text-bg transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {overrideMutation.isPending ? 'Saving…' : 'Save overrides'}
              </button>
              <button
                type="button"
                onClick={() => setShowOverrideForm(false)}
                className="cursor-pointer border border-border px-4 py-2 text-sm font-medium text-text-secondary transition-colors hover:border-accent hover:text-accent"
              >
                Cancel
              </button>
            </div>
            {overrideMutation.isError && (
              <p className="mt-3 text-[13px] text-danger">
                Saving failed. Check the values and try again.
              </p>
            )}
          </div>
        )}
      </div>

      {/* Org metadata */}
      <div className="grid grid-cols-2 gap-x-8 gap-y-4 md:grid-cols-4">
        <Field label="ID" value={org.id} mono />
        <Field label="Slug" value={org.slug} mono />
        <Field label="Created" value={new Date(org.createdAt).toLocaleString()} mono />
      </div>
    </div>
  )
}

// ── Shared Sub-Components ────────────────────────────────────────────────────

/** L3: label above one value inside a panel — sentence case, not an eyebrow. */
/** Internal workspaces (the team's own) are left out of every admin metric. */
function InternalToggle({ orgId, internal }: { orgId: string; internal: { note: string | null } | null }) {
  const queryClient = useQueryClient()
  const [note, setNote] = useState('')
  const toggle = useMutation({
    mutationFn: (next: boolean) => adminApi.organizations.setInternal(orgId, next, note || undefined),
    onSuccess: () => {
      setNote('')
      queryClient.invalidateQueries({ queryKey: ['admin'] })
    },
  })
  return (
    <div>
      <h3 className="text-base font-semibold text-text-primary">Internal workspace</h3>
      <p className="mt-1 text-sm text-text-secondary">
        {internal
          ? `Left out of every metric${internal.note ? `: ${internal.note}` : ''}.`
          : 'Counted in every metric. Mark your own and test workspaces internal so they stay out of the numbers.'}
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        {!internal && (
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Note (optional), e.g. founder testing"
            aria-label="Note"
            className="min-w-0 flex-1 border border-border bg-bg px-3 py-2 text-sm text-text-primary outline-none transition-colors placeholder:text-text-muted focus:border-accent sm:max-w-xs"
          />
        )}
        <button type="button" className={btn} disabled={toggle.isPending} onClick={() => toggle.mutate(!internal)}>
          {internal ? 'Count it again' : 'Mark internal'}
        </button>
      </div>
      {toggle.error && <p className="mt-2 text-[13px] text-danger">{toggle.error.message}</p>}
    </div>
  )
}

function Field({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <p className="text-[13px] text-text-secondary">{label}</p>
      <p className={`mt-1 break-all text-sm capitalize text-text-primary ${mono ? 'font-mono normal-case' : ''}`}>
        {value}
      </p>
    </div>
  )
}

function NumberField({ label, qualifier, value, onChange }: { label: string; qualifier?: string; value: number | null; onChange: (v: number | null) => void }) {
  // useId keeps the label/input pair unique when several org rows are expanded.
  const id = useId()
  return (
    <div>
      <label className="block text-[13px] text-text-secondary" htmlFor={id}>
        {label}
        {qualifier && <span className="ml-1.5 text-text-muted">({qualifier})</span>}
      </label>
      <input
        id={id}
        type="number"
        min={0}
        step={1}
        placeholder="Plan default"
        value={value ?? ''}
        // Empty = null = no override (plan default).
        onChange={(e) => onChange(e.target.value === '' ? null : Math.max(0, Math.floor(Number(e.target.value))))}
        className="mt-1.5 w-full border border-border bg-bg px-3 py-2 font-mono text-sm text-text-primary outline-none transition-colors focus:border-accent"
      />
    </div>
  )
}

/** One cell in the limits row. The row owns the single border; cells are
 *  separated by hairlines rather than being boxes of their own. */
function LimitCell({
  label,
  qualifier,
  current,
  limit,
}: {
  label: string
  qualifier?: string
  current: number
  limit: number | null
}) {
  if (limit === null) {
    return (
      <div className="p-4">
        <p className="text-[13px] text-text-secondary">
          {label}
          {qualifier && <span className="ml-1.5 text-text-muted">({qualifier})</span>}
        </p>
        <div className="mt-2 flex items-baseline gap-1.5">
          <span className="font-display text-xl font-bold tabular-nums text-text-primary">
            {formatNumber(current)}
          </span>
          <span className="font-mono text-[13px] text-text-secondary">/ Unlimited</span>
        </div>
      </div>
    )
  }
  const pct = limit > 0 ? Math.min(100, Math.round((current / limit) * 100)) : 0
  return (
    <div className="p-4">
      <p className="text-[13px] text-text-secondary">
        {label}
        {qualifier && <span className="ml-1.5 text-text-muted">({qualifier})</span>}
      </p>
      <div className="mt-2 flex items-baseline gap-1.5">
        <span className={`font-display text-xl font-bold tabular-nums ${usageColor(current, limit)}`}>
          {formatNumber(current)}
        </span>
        <span className="font-mono text-[13px] text-text-secondary">/ {formatNumber(limit)}</span>
      </div>
      <div className="mt-2.5 h-2 w-full bg-bg">
        <div
          className={`h-full transition-all ${usageBgColor(current, limit)}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <p className="mt-1.5 text-right font-mono text-xs text-text-secondary">{pct}%</p>
    </div>
  )
}

function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}
