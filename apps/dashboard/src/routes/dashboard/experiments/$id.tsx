import { createFileRoute, Link, useNavigate, useParams } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { toast } from 'sonner'
import {
  api,
  type ExperimentArm,
  type ExperimentArmResult,
  type ExperimentWithResults,
} from '~/lib/api'
import { getActiveTeamId, useSession } from '~/lib/auth'
import { usePermissions } from '~/lib/permissions'
import { Dialog, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '~/components/ui/dialog'

export const Route = createFileRoute('/dashboard/experiments/$id')({
  component: ExperimentDetailPage,
})

type Metric = {
  label: string
  value: (r: ExperimentArmResult) => string
}

// Raw counts and the rates between them. No significance figure: impressions
// count banner views, not unique visitors, so a test on them would overstate
// certainty (see docs/guides/ab-testing).
const METRICS: Metric[] = [
  { label: 'Impressions', value: (r) => formatCount(r.impressions) },
  { label: 'Clicks', value: (r) => formatCount(r.clicks) },
  { label: 'Copies', value: (r) => formatCount(r.copies) },
  { label: 'Redemptions', value: (r) => formatCount(r.redemptions) },
  { label: 'Revenue saved', value: (r) => formatRevenue(r.revenueSavedByCurrency) },
  { label: 'Click rate', value: (r) => formatRate(r.clickRate) },
  { label: 'Copy rate', value: (r) => formatRate(r.copyRate) },
  { label: 'Conversion rate', value: (r) => formatRate(r.conversionRate) },
  { label: 'Redemptions per copy', value: (r) => formatRate(r.redemptionsPerCopy) },
]

function ExperimentDetailPage() {
  const { id: experimentId } = useParams({ from: '/dashboard/experiments/$id' })
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { data: session, isPending: sessionPending } = useSession()
  const teamId = getActiveTeamId(session)
  const { can } = usePermissions()
  const canManage = can('experiments.update')

  const [isEditing, setIsEditing] = useState(false)
  const [editName, setEditName] = useState('')
  const [editSplitB, setEditSplitB] = useState(50)
  const [showEnd, setShowEnd] = useState(false)
  const [winnerId, setWinnerId] = useState<string | null>(null)

  const { data: experiment, isPending: experimentPending, error } = useQuery({
    queryKey: ['experiment', teamId, experimentId],
    queryFn: () => api.experiments.get(teamId, experimentId),
    enabled: !!teamId,
  })

  // Same loading rule as the campaign page: the query stays idle until the
  // session has produced a teamId.
  const isLoading = sessionPending || !teamId || experimentPending

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['experiment', teamId, experimentId] })
    queryClient.invalidateQueries({ queryKey: ['experiments', teamId] })
  }

  const updateExperiment = useMutation({
    mutationFn: (data: { name?: string; trafficSplitB?: number }) => api.experiments.update(teamId, experimentId, data),
    onSuccess: () => {
      invalidate()
      toast.success('A/B test updated')
      setIsEditing(false)
    },
    onError: (err) => toast.error('Update failed', { description: err.message }),
  })

  const endExperiment = useMutation({
    mutationFn: (winner: string) => api.experiments.end(teamId, experimentId, winner),
    onSuccess: () => {
      invalidate()
      // The loser was paused: refresh campaign views too.
      queryClient.invalidateQueries({ queryKey: ['campaigns', teamId] })
      queryClient.invalidateQueries({ queryKey: ['campaign', teamId] })
      toast.success('A/B test ended', { description: 'The other campaign was paused.' })
      setShowEnd(false)
    },
    onError: (err) => toast.error('Failed to end the test', { description: err.message }),
  })

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="h-6 w-6 animate-spin rounded-full border-4 border-border border-t-brand" />
      </div>
    )
  }

  if (error || !experiment) {
    return (
      <div className="py-20 text-center">
        <p className="text-text-secondary">A/B test not found.</p>
      </div>
    )
  }

  const running = experiment.status === 'running'
  const { results } = experiment
  // `name` is the arm's name when the test started, shown once the campaign is deleted.
  const armA = {
    label: 'A',
    role: 'Control',
    campaign: experiment.campaignA,
    name: experiment.campaignA?.name ?? experiment.campaignAName,
    id: experiment.campaignAId,
    result: results.a,
  }
  const armB = {
    label: 'B',
    role: 'Variant',
    campaign: experiment.campaignB,
    name: experiment.campaignB?.name ?? experiment.campaignBName,
    id: experiment.campaignBId,
    result: results.b,
  }
  const inactiveArms = [armA, armB].filter((a) => !a.campaign || a.campaign.status !== 'active')

  const startEditing = () => {
    setEditName(experiment.name)
    setEditSplitB(experiment.trafficSplitB)
    setIsEditing(true)
  }

  const handleSave = () => {
    const data: { name?: string; trafficSplitB?: number } = {}
    if (editName.trim() !== experiment.name) data.name = editName.trim()
    if (running && editSplitB !== experiment.trafficSplitB) data.trafficSplitB = editSplitB
    if (Object.keys(data).length === 0) {
      setIsEditing(false)
      return
    }
    updateExperiment.mutate(data)
  }

  const openEnd = () => {
    setWinnerId(null)
    setShowEnd(true)
  }

  return (
    <div>
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-sm text-text-secondary">
            <button
              type="button"
              onClick={() => navigate({ to: '/dashboard/experiments' })}
              className="hover:text-text-primary"
            >
              A/B Tests
            </button>
            <span aria-hidden="true">/</span>
            <span className="truncate text-text-primary">{experiment.name}</span>
          </div>
          <h1 className="mt-1 font-display text-4xl font-medium tracking-tight text-text-primary">
            {experiment.name}
          </h1>
        </div>
        <div className="flex items-center gap-3">
          {running && canManage && (
            <button
              type="button"
              onClick={openEnd}
              className="bg-brand px-3.5 py-1.5 text-[13px] font-medium text-white transition-colors hover:bg-brand/90"
            >
              End Test
            </button>
          )}
          <button
            type="button"
            onClick={() => downloadResultsCsv(experiment)}
            className="flex items-center gap-2 border border-border px-3.5 py-1.5 text-[13px] font-medium text-text-primary"
          >
            <svg className="h-3.5 w-3.5 text-text-secondary" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5M16.5 12 12 16.5m0 0L7.5 12m4.5 4.5V3" />
            </svg>
            Export
          </button>
          <span
            className={`px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wider ${
              running ? 'bg-success/15 text-success' : 'bg-surface text-text-secondary'
            }`}
          >
            {experiment.status}
          </span>
        </div>
      </div>

      {/* An arm that is not active is not served by the banner. */}
      {running && inactiveArms.length > 0 && (
        <div className="mt-6 max-w-3xl border border-amber-800 bg-amber-950/30 p-4">
          <p className="text-sm font-semibold text-amber-200">This test is not splitting traffic as configured</p>
          <p className="mt-1 text-[13px] text-amber-300">
            {inactiveArms.map((a) => `${a.label} (${a.name}) is ${a.campaign ? a.campaign.status : 'deleted'}`).join(' and ')}. The banner
            only serves active campaigns. Resume the campaign or end the test.
          </p>
        </div>
      )}

      {/* Summary */}
      <div className="mt-6 grid max-w-3xl grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <SummaryCard label="Split A/B" value={`${100 - experiment.trafficSplitB}/${experiment.trafficSplitB}`} numeric />
        <SummaryCard label="Environment" value={experiment.environment === 'test' ? 'Test' : 'Live'} />
        <SummaryCard label="Started" value={new Date(experiment.startedAt).toLocaleDateString()} numeric />
        <SummaryCard
          label={running ? 'Ended' : 'Winner'}
          value={
            running
              ? '—'
              : experiment.winnerCampaignId === experiment.campaignAId
                ? `A · ${armA.name}`
                : `B · ${armB.name}`
          }
        />
      </div>

      {/* Results: the two arms side by side */}
      <div className="mt-8 max-w-3xl">
        <h2 className="font-display text-lg font-semibold text-text-primary">Results</h2>
        <div className="mt-4 overflow-x-auto border border-border">
          <table className="min-w-full">
            <thead>
              <tr className="border-b border-border bg-surface">
                <th className="px-5 py-3 text-left text-[13px] font-semibold text-text-secondary">Metric</th>
                {[armA, armB].map((arm) => (
                  <th key={arm.label} className="px-5 py-3 text-right text-[13px] font-semibold text-text-secondary">
                    <ArmHeading
                      label={arm.label}
                      role={arm.role}
                      campaign={arm.campaign}
                      name={arm.name}
                      isWinner={experiment.winnerCampaignId === arm.id}
                    />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {METRICS.map((m) => (
                <tr key={m.label} className="border-b border-border last:border-b-0">
                  <td className="whitespace-nowrap px-5 py-3 text-sm text-text-secondary">{m.label}</td>
                  <td className="whitespace-nowrap px-5 py-3 text-right font-mono text-sm tabular-nums text-text-primary">
                    {m.value(results.a)}
                  </td>
                  <td className="whitespace-nowrap px-5 py-3 text-right font-mono text-sm tabular-nums text-text-primary">
                    {m.value(results.b)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="mt-3 space-y-1 text-[13px] text-text-secondary">
          <p>
            Daily totals (UTC days) from{' '}
            <span className="font-mono tabular-nums">{formatDay(results.from)}</span> to{' '}
            <span className="font-mono tabular-nums">{results.to ? formatDay(results.to) : 'today'}</span>. The start
            and end days are counted in full. Rates are relative to impressions (banner views), except
            redemptions per copy. Revenue saved is the discount given, shown per currency.
          </p>
          <p>
            Share of impressions that went to B:{' '}
            <span className="font-mono tabular-nums">
              {results.observedShareB === null ? '—' : formatRate(results.observedShareB)}
            </span>{' '}
            (configured <span className="font-mono tabular-nums">{experiment.trafficSplitB}%</span>).
          </p>
          {results.truncatedByRetention && (
            <p className="text-amber-300">
              Your plan keeps analytics for a limited time, so the earliest days of this test are not included.
            </p>
          )}
        </div>
      </div>

      {/* Settings */}
      {canManage && (
        <div className="mt-8 max-w-lg space-y-5">
          <h2 className="font-display text-lg font-semibold text-text-primary">Settings</h2>
          {!isEditing ? (
            <button
              type="button"
              onClick={startEditing}
              className="bg-brand px-4 py-2 text-[13px] font-medium text-white transition-colors hover:bg-brand/90"
            >
              {running ? 'Edit Name or Split' : 'Rename'}
            </button>
          ) : (
            <>
              <div className="space-y-4">
                <div>
                  <label htmlFor="experiment-name" className="block text-sm font-medium text-text-primary">Test Name</label>
                  <input
                    id="experiment-name"
                    type="text"
                    maxLength={200}
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                    className="mt-1 block w-full border border-border px-3 py-2 text-sm text-text-primary focus:border-brand focus:outline-none"
                  />
                </div>
                {running && (
                  <div>
                    <label htmlFor="experiment-split" className="block text-sm font-medium text-text-primary">Traffic to B (%)</label>
                    <div className="mt-1 flex items-center gap-3">
                      <input
                        type="range"
                        min={1}
                        max={99}
                        step={1}
                        value={editSplitB}
                        onChange={(e) => setEditSplitB(parseInt(e.target.value, 10))}
                        className="h-1.5 flex-1 appearance-none rounded-full bg-border accent-brand"
                      />
                      <input
                        id="experiment-split"
                        type="number"
                        min={1}
                        max={99}
                        value={editSplitB}
                        onChange={(e) => setEditSplitB(Math.min(99, Math.max(1, parseInt(e.target.value, 10) || experiment.trafficSplitB)))}
                        className="w-16 border border-border bg-bg px-2 py-1.5 text-center font-mono text-sm tabular-nums text-text-primary focus:border-brand focus:outline-none"
                      />
                    </div>
                    <p className="mt-1.5 text-[13px] text-text-secondary">
                      Changing the split mid-test moves some visitors to the other campaign, which makes the
                      results harder to compare.
                    </p>
                  </div>
                )}
              </div>
              <div className="flex items-center gap-3 pt-2">
                <button
                  type="button"
                  onClick={handleSave}
                  disabled={updateExperiment.isPending || !editName.trim()}
                  className="bg-brand px-4 py-2 text-[13px] font-medium text-white transition-colors hover:bg-brand/90 disabled:opacity-50"
                >
                  {updateExperiment.isPending ? 'Saving...' : 'Save Changes'}
                </button>
                <button
                  type="button"
                  onClick={() => setIsEditing(false)}
                  className="border border-border px-4 py-2 text-[13px] font-medium text-text-primary transition-colors hover:bg-surface"
                >
                  Cancel
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {/* End Test: pick the winner */}
      <Dialog open={showEnd} onOpenChange={(open) => !open && setShowEnd(false)}>
        <DialogHeader>
          <DialogTitle>End A/B test</DialogTitle>
          <DialogDescription>
            Choose the winning campaign. The winner stays active; the other campaign is paused.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2" role="radiogroup" aria-label="Winning campaign">
          {[armA, armB].map((arm) => (
            <button
              key={arm.label}
              type="button"
              role="radio"
              aria-checked={winnerId === arm.id}
              onClick={() => setWinnerId(arm.id)}
              className={`flex w-full items-center justify-between gap-3 border px-4 py-3 text-left transition-colors ${
                winnerId === arm.id ? 'border-brand bg-brand-light' : 'border-border hover:bg-surface'
              }`}
            >
              <span className="min-w-0">
                <span className="block text-[11px] font-semibold uppercase tracking-wider text-text-secondary">
                  {arm.label} · {arm.role}
                </span>
                <span className="block truncate text-sm font-medium text-text-primary">
                  {arm.name}
                </span>
              </span>
              <span className="shrink-0 text-right text-[13px] text-text-secondary">
                <span className="font-mono tabular-nums text-text-primary">{formatCount(arm.result.redemptions)}</span> redemptions
              </span>
            </button>
          ))}
        </div>
        {endExperiment.error && (
          <p className="mt-3 text-[13px] text-brand-text">{endExperiment.error.message}</p>
        )}
        <DialogFooter>
          <button
            type="button"
            onClick={() => setShowEnd(false)}
            className="border border-border px-4 py-2 text-sm font-medium text-text-primary transition-colors hover:bg-surface"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => winnerId && endExperiment.mutate(winnerId)}
            disabled={!winnerId || endExperiment.isPending}
            className="bg-brand px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-brand/90 disabled:opacity-50"
          >
            {endExperiment.isPending ? 'Ending...' : 'End Test'}
          </button>
        </DialogFooter>
      </Dialog>
    </div>
  )
}

function ArmHeading({
  label,
  role,
  campaign,
  name,
  isWinner,
}: {
  label: string
  role: string
  campaign: ExperimentArm | null
  name: string
  isWinner: boolean
}) {
  return (
    <span className="inline-flex flex-col items-end gap-0.5">
      <span className="text-[11px] font-semibold uppercase tracking-wider">
        {label} · {role}
        {isWinner && <span className="ml-2 bg-success-light px-1.5 py-0.5 text-success">Winner</span>}
      </span>
      {campaign ? (
        <Link
          to="/dashboard/campaigns/$id"
          params={{ id: campaign.id }}
          className="max-w-[16rem] truncate text-sm font-medium text-text-primary hover:text-brand-text"
        >
          {campaign.name}
        </Link>
      ) : (
        <span className="max-w-[16rem] truncate text-sm text-text-secondary">{name} (deleted)</span>
      )}
    </span>
  )
}

function SummaryCard({ label, value, numeric }: { label: string; value: string; numeric?: boolean }) {
  return (
    <div className="border border-border p-4">
      <p className="text-[11px] font-semibold uppercase tracking-wider text-text-secondary">{label}</p>
      <p className={`mt-1 truncate text-sm text-text-primary ${numeric ? 'font-mono font-medium tabular-nums' : ''}`}>
        {value}
      </p>
    </div>
  )
}

function formatCount(n: number): string {
  return n.toLocaleString()
}

function formatRate(r: number | null): string {
  return r === null ? '—' : `${(r * 100).toFixed(1)}%`
}

// Same order as the Overview page (by currency code); amounts in different
// currencies are never added together or compared.
function revenueEntries(byCurrency: Record<string, number>): [string, number][] {
  return Object.entries(byCurrency)
    .filter(([, amount]) => amount > 0)
    .sort(([a], [b]) => a.localeCompare(b))
}

function formatRevenue(byCurrency: Record<string, number>): string {
  const entries = revenueEntries(byCurrency)
  if (entries.length === 0) return '0'
  return entries
    .map(([currency, amount]) => {
      try {
        return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(amount)
      } catch {
        return `${currency} ${amount.toLocaleString()}`
      }
    })
    .join(' · ')
}

function formatDay(iso: string): string {
  return iso.slice(0, 10)
}

function downloadResultsCsv(experiment: ExperimentWithResults) {
  const { results } = experiment
  const csvField = (s: string) => `"${s.replace(/"/g, '""')}"`
  const rate = (r: number | null) => (r === null ? '' : String(r))
  // "USD 12.5; INR 400": one cell, no commas (same as the Overview export).
  const revenueCell = (byCurrency: Record<string, number>) =>
    revenueEntries(byCurrency)
      .map(([currency, amount]) => `${currency} ${amount}`)
      .join('; ')
  const header = [
    'Arm', 'Campaign', 'Impressions', 'Clicks', 'Copies', 'Redemptions', 'Revenue Saved',
    'Click Rate', 'Copy Rate', 'Conversion Rate', 'Redemptions Per Copy',
  ]
  const line = (label: string, name: string, r: ExperimentArmResult) => [
    label,
    csvField(name),
    r.impressions,
    r.clicks,
    r.copies,
    r.redemptions,
    csvField(revenueCell(r.revenueSavedByCurrency)),
    rate(r.clickRate),
    rate(r.copyRate),
    rate(r.conversionRate),
    rate(r.redemptionsPerCopy),
  ]
  const csv = [
    header,
    line('A', experiment.campaignA?.name ?? experiment.campaignAName, results.a),
    line('B', experiment.campaignB?.name ?? experiment.campaignBName, results.b),
  ]
    .map((cols) => cols.join(','))
    .join('\n')

  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
  const link = document.createElement('a')
  link.href = url
  link.download = `gopaylocal-ab-test-${experiment.id}.csv`
  link.click()
  URL.revokeObjectURL(url)
}
