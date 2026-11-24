import { createFileRoute, Link, useParams } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { toast } from 'sonner'
import {
  api,
  type ExperimentArmResult,
  type ExperimentWithResults,
} from '~/lib/api'
import { getActiveTeamId, useSession } from '~/lib/auth'
import { usePermissions } from '~/lib/permissions'
import { Dialog, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '~/components/ui/dialog'
import { ErrorText, LifecycleStatus, ToneIcon } from '~/components/ui/status'
import { btnPrimary, btnSecondary, SectionTitle, Spinner } from '~/components/ui/page'
import { formatDate } from '~/lib/format'

export const Route = createFileRoute('/dashboard/experiments/$id')({
  component: ExperimentDetailPage,
})

type Metric = {
  label: string
  value: (r: ExperimentArmResult) => string
  /** Rates per banner view can be compared at any split; counts can't. */
  rate?: (r: ExperimentArmResult) => number | null
  strong?: boolean
}

// Raw counts and the rates between them. No significance figure: impressions
// count banner views, not unique visitors, so a test on them would overstate
// certainty (see docs/guides/ab-testing).
const METRICS: Metric[] = [
  { label: 'Banner views', value: (r) => formatCount(r.impressions) },
  { label: 'Clicks', value: (r) => formatCount(r.clicks) },
  { label: 'Codes copied', value: (r) => formatCount(r.copies) },
  { label: 'Redemptions', value: (r) => formatCount(r.redemptions), strong: true },
  { label: 'Discount given', value: (r) => formatRevenue(r.revenueSavedByCurrency) },
  { label: 'Click rate', value: (r) => formatRate(r.clickRate), rate: (r) => r.clickRate },
  { label: 'Copy rate', value: (r) => formatRate(r.copyRate), rate: (r) => r.copyRate },
  { label: 'Conversion rate', value: (r) => formatRate(r.conversionRate), rate: (r) => r.conversionRate, strong: true },
  { label: 'Redemptions per copy', value: (r) => formatRate(r.redemptionsPerCopy), rate: (r) => r.redemptionsPerCopy },
]

/** "+2.4 points", "no change", or "—" when either side has no data. Never coloured: you decide what's better. */
function rateDiff(a: number | null, b: number | null): string {
  if (a === null || b === null) return '—'
  const points = Math.round((b - a) * 1000) / 10
  if (points === 0) return 'no change'
  return `${points > 0 ? '+' : ''}${points.toFixed(1)} points`
}

function ExperimentDetailPage() {
  const { id: experimentId } = useParams({ from: '/dashboard/experiments/$id' })
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

  const { data: products = [] } = useQuery({
    queryKey: ['products', teamId, experiment?.environment],
    queryFn: () => api.products.list(teamId, experiment?.environment),
    enabled: !!teamId && !!experiment,
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
    return <Spinner className="py-20" />
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

  const product = products.find((p) => p.id === experiment.productId)
  const days = Math.max(0, Math.floor((Date.now() - new Date(experiment.startedAt).getTime()) / 86_400_000))
  const splitA = 100 - experiment.trafficSplitB

  return (
    <div className="flex max-w-[1080px] flex-col gap-6">
      <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-2 text-[13px] text-text-muted">
        <Link to="/dashboard/experiments" className="text-text-secondary hover:text-text-primary">
          A/B Tests
        </Link>
        <span aria-hidden="true">/</span>
        <span className="truncate">{experiment.name}</span>
      </nav>

      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-2">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="font-display text-[30px] font-semibold tracking-tight text-text-primary">{experiment.name}</h1>
            <LifecycleStatus state={running ? 'on' : 'paused'}>{running ? 'Running' : 'Ended'}</LifecycleStatus>
          </div>
          <p className="text-[13px] text-text-secondary">
            {[
              product?.name,
              experiment.environment === 'test' ? 'test mode' : 'live',
              running
                ? `started ${formatDate(experiment.startedAt)}, ${days === 0 ? 'today' : days === 1 ? '1 day ago' : `${days} days ago`}`
                : `${formatDate(experiment.startedAt)} to ${experiment.endedAt ? formatDate(experiment.endedAt) : '—'}`,
            ]
              .filter(Boolean)
              .join(' · ')}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" onClick={() => downloadResultsCsv(experiment)} className={btnSecondary}>
            Export CSV
          </button>
          {running && canManage && (
            <button type="button" onClick={openEnd} className={btnPrimary}>
              End test…
            </button>
          )}
        </div>
      </header>

      {/* An arm that is not active is not served by the banner. */}
      {running && inactiveArms.length > 0 && (
        <div className="flex items-start gap-3 border border-warning-border bg-warning-light px-4 py-3">
          <ToneIcon tone="warn" className="mt-0.5 h-4 w-4" />
          <div>
            <p className="text-sm font-semibold text-warning">This test is not splitting traffic as configured</p>
            <p className="mt-1 text-[13px] text-text-primary">
              {inactiveArms.map((a) => `${a.label} (${a.name}) is ${a.campaign ? a.campaign.status : 'deleted'}`).join(' and ')}. The
              banner only serves active campaigns. Resume the campaign or end the test.
            </p>
          </div>
        </div>
      )}

      {/* The split: who gets which campaign. */}
      <section aria-label="Split" className="flex min-h-11 flex-col border border-border sm:flex-row">
        {[
          { arm: armA, share: splitA, tone: 'bg-tile' },
          { arm: armB, share: experiment.trafficSplitB, tone: 'bg-border' },
        ].map(({ arm, share, tone }, i) => (
          <div
            key={arm.label}
            style={{ flexGrow: Math.max(share, 18) }}
            className={`flex min-w-0 basis-0 flex-wrap items-center gap-x-2.5 gap-y-0.5 px-3.5 py-2.5 text-[13px] ${tone} ${
              i > 0 ? 'border-t border-border sm:border-l sm:border-t-0' : ''
            }`}
          >
            <span className="font-mono text-text-primary">{arm.label}</span>
            {arm.campaign ? (
              <Link to="/dashboard/campaigns/$id" params={{ id: arm.campaign.id }} className="truncate font-semibold text-text-primary hover:underline">
                {arm.name}
              </Link>
            ) : (
              <span className="truncate text-text-secondary">{arm.name} (deleted)</span>
            )}
            <span className="text-text-secondary">{share}% of visitors</span>
            {experiment.winnerCampaignId === arm.id && (
              <span className="inline-flex items-center gap-1 text-success">
                <ToneIcon tone="ok" />
                Winner
              </span>
            )}
          </div>
        ))}
      </section>

      <section aria-labelledby="results-title" className="flex flex-col gap-3">
        <SectionTitle
          id="results-title"
          aside={`${formatDay(results.from)} to ${results.to ? formatDay(results.to) : 'today'}, whole UTC days`}
        >
          {running ? 'Results so far' : 'Results'}
        </SectionTitle>
        <div className="overflow-x-auto border border-border bg-panel [contain:inline-size]">
          <table className="w-full min-w-[640px] text-sm tabular-nums">
            <thead>
              <tr className="border-b border-border text-right text-xs text-text-muted">
                <th scope="col" className="px-6 py-3 text-left font-semibold">Metric</th>
                <th scope="col" className="px-4 py-3 font-semibold">A</th>
                <th scope="col" className="px-4 py-3 font-semibold">B</th>
                <th scope="col" className="px-6 py-3 font-semibold">B compared with A</th>
              </tr>
            </thead>
            <tbody>
              {METRICS.map((m) => (
                <tr key={m.label} className={`border-b border-border last:border-b-0 ${m.strong ? 'bg-surface' : ''}`}>
                  <th scope="row" className={`whitespace-nowrap px-6 py-3 text-left ${m.strong ? 'font-semibold text-text-primary' : 'font-normal text-text-secondary'}`}>
                    {m.label}
                  </th>
                  <td className="whitespace-nowrap px-4 py-3 text-right text-text-primary">{m.value(results.a)}</td>
                  <td className="whitespace-nowrap px-4 py-3 text-right text-text-primary">{m.value(results.b)}</td>
                  <td className="whitespace-nowrap px-6 py-3 text-right text-text-primary">
                    {m.rate ? rateDiff(m.rate(results.a), m.rate(results.b)) : ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="flex max-w-[820px] flex-col gap-1 text-[13px] text-text-muted">
          <p>
            Rates are per banner view, except redemptions per copy, and only rates are compared: counts depend on the
            split. Discount given is shown per currency. GoPayLocal doesn't run a significance test; with few
            redemptions, a difference can be chance.
          </p>
          <p>
            Share of banner views that went to B:{' '}
            <span className="text-text-primary">{results.observedShareB === null ? '—' : formatRate(results.observedShareB)}</span>{' '}
            (set to {experiment.trafficSplitB}%).
          </p>
          {results.truncatedByRetention && (
            <p className="text-text-primary">
              Your plan keeps analytics for a limited time, so the earliest days of this test are not included.
            </p>
          )}
        </div>
      </section>

      {canManage && (
        <section aria-labelledby="test-settings" className="max-w-[720px] border border-border bg-panel">
          <div className="flex items-center justify-between gap-3 border-b border-border px-6 py-3.5">
            <h2 id="test-settings" className="text-xs font-semibold uppercase tracking-[0.08em] text-text-secondary">
              Settings
            </h2>
            {!isEditing && (
              <button type="button" onClick={startEditing} className={`${btnSecondary} h-9`}>
                {running ? 'Edit name or split' : 'Rename'}
              </button>
            )}
          </div>
          {!isEditing ? (
            <dl className="grid grid-cols-1 gap-4 px-6 py-5 text-sm sm:grid-cols-2">
              <div>
                <dt className="text-[13px] text-text-muted">Test name</dt>
                <dd className="mt-0.5 text-text-primary">{experiment.name}</dd>
              </div>
              <div>
                <dt className="text-[13px] text-text-muted">Visitors sent to B</dt>
                <dd className="mt-0.5 text-text-primary">{experiment.trafficSplitB}%</dd>
              </div>
            </dl>
          ) : (
            <div className="flex flex-col gap-4 px-6 py-5">
              <div>
                <label htmlFor="experiment-name" className="block text-sm font-medium text-text-primary">Test name</label>
                <input
                  id="experiment-name"
                  type="text"
                  maxLength={200}
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  className="mt-1 block w-full border border-control bg-bg px-3 py-2 text-sm text-text-primary focus:border-brand focus:outline-none"
                />
              </div>
              {running && (
                <div>
                  <label htmlFor="experiment-split" className="block text-sm font-medium text-text-primary">Visitors sent to B (%)</label>
                  <div className="mt-1 flex items-center gap-3">
                    <input
                      type="range"
                      min={1}
                      max={99}
                      step={1}
                      value={editSplitB}
                      onChange={(e) => setEditSplitB(parseInt(e.target.value, 10))}
                      aria-label="Visitors sent to B"
                      className="h-1.5 flex-1 appearance-none bg-border accent-brand"
                    />
                    <input
                      id="experiment-split"
                      type="number"
                      min={1}
                      max={99}
                      value={editSplitB}
                      onChange={(e) => setEditSplitB(Math.min(99, Math.max(1, parseInt(e.target.value, 10) || experiment.trafficSplitB)))}
                      className="w-16 border border-control bg-bg px-2 py-1.5 text-center font-mono text-sm tabular-nums text-text-primary focus:border-brand focus:outline-none"
                    />
                  </div>
                  <p className="mt-1.5 text-[13px] text-text-secondary">
                    Changing the split mid-test moves some visitors to the other campaign, which makes the results harder
                    to compare.
                  </p>
                </div>
              )}
              <div className="flex items-center gap-3">
                <button type="button" onClick={handleSave} disabled={updateExperiment.isPending || !editName.trim()} className={btnPrimary}>
                  {updateExperiment.isPending ? 'Saving…' : 'Save changes'}
                </button>
                <button type="button" onClick={() => setIsEditing(false)} className={btnSecondary}>
                  Cancel
                </button>
              </div>
            </div>
          )}
        </section>
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
                winnerId === arm.id ? 'border-brand bg-tile' : 'border-border hover:bg-surface'
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
          <ErrorText className="mt-3">{endExperiment.error.message}</ErrorText>
        )}
        <DialogFooter>
          <button type="button" onClick={() => setShowEnd(false)} className={btnSecondary}>
            Cancel
          </button>
          <button
            type="button"
            onClick={() => winnerId && endExperiment.mutate(winnerId)}
            disabled={!winnerId || endExperiment.isPending}
            className={btnPrimary}
          >
            {endExperiment.isPending ? 'Ending…' : 'End test'}
          </button>
        </DialogFooter>
      </Dialog>
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
        return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(amount)
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
