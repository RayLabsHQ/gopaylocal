import { createFileRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { adminApi, type AuditEntry } from '~/lib/api'
import { EmptyState, ErrorBox, PageHeader, Panel, Spinner, Table, btn, formatDateTime, td } from '~/components/ui'

export const Route = createFileRoute('/admin/audit')({
  component: AuditLogPage,
})

const ACTIONS: Record<string, string> = {
  ban_user: 'Banned a user',
  unban_user: 'Unbanned a user',
  override_limits: 'Changed limits',
  mark_internal: 'Marked a workspace internal',
  unmark_internal: 'Unmarked a workspace internal',
  set_house_pricing: 'Set the house campaign',
  sync_house_pricing: 'Pushed regional prices to Dodo',
}

function AuditLogPage() {
  const [page, setPage] = useState(1)
  const { data, isPending, error, refetch } = useQuery({
    queryKey: ['admin', 'audit', page],
    queryFn: () => adminApi.audit.list(page),
  })
  const pages = data?.pagination.totalPages ?? 1

  return (
    <div>
      <PageHeader title="Audit log" subtitle="Every admin action, newest first" />

      {error && (
        <div className="mt-6">
          <ErrorBox message="Couldn't load the audit log." onRetry={() => refetch()} />
        </div>
      )}

      <div className="mt-8">
        <Panel title="Actions" chip={data ? `${data.pagination.total} in all` : undefined} flush>
          {isPending ? (
            <Spinner className="h-48" />
          ) : !data || data.data.length === 0 ? (
            <EmptyState title="Nothing yet" body="Bans, limit changes, internal workspaces and regional price syncs are recorded here." />
          ) : (
            <Table headers={['When', 'Admin', 'Action', 'Target', 'Details']}>
              {data.data.map((e) => (
                <tr key={e.id}>
                  <td className={td}>{formatDateTime(e.createdAt)}</td>
                  <td className={`${td} text-text-primary`}>{e.adminName ?? e.adminEmail ?? 'Deleted user'}</td>
                  <td className={`${td} text-text-primary`}>{ACTIONS[e.action] ?? e.action}</td>
                  <td className={`${td} font-mono text-[12px]`}>
                    <span className="text-text-muted">{e.targetType}</span> {e.targetId}
                  </td>
                  <td className="max-w-sm px-5 py-3 text-[13px] text-text-secondary">{describe(e)}</td>
                </tr>
              ))}
            </Table>
          )}
          {pages > 1 && (
            <div className="flex items-center justify-between border-t border-border px-5 py-3">
              <span className="text-[13px] text-text-muted">
                Page {page} of {pages}
              </span>
              <div className="flex gap-2">
                <button type="button" className={btn} disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                  Previous
                </button>
                <button type="button" className={btn} disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>
                  Next
                </button>
              </div>
            </div>
          )}
        </Panel>
      </div>
    </div>
  )
}

/** The details as short "key: value" pairs. */
function describe(e: AuditEntry): string {
  if (!e.details) return '—'
  return Object.entries(e.details)
    .filter(([, v]) => v !== null && v !== undefined && v !== '')
    .map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
    .join(' · ') || '—'
}
