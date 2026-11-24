import { createFileRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { adminApi, type ActivationStep } from '~/lib/api'
import {
  EmptyState,
  ErrorBox,
  KPICard,
  MiniStat,
  Panel,
  PageHeader,
  Spinner,
  Table,
  formatDate,
  td,
  tdRight,
} from '~/components/ui'

export const Route = createFileRoute('/admin/activation')({
  component: ActivationPage,
})

const MODE_LABELS: Record<string, string> = { group: 'Parity groups', ppp_factor: 'PPP factor', custom: 'Custom per country' }
const DELIVERY_LABELS: Record<string, string> = { banner_coupon: 'Banner with code', auto_apply: 'Applied at checkout' }

function ActivationPage() {
  const { data, isPending, error, refetch } = useQuery({
    queryKey: ['admin', 'activation'],
    queryFn: () => adminApi.activation.get(),
  })
  const [openStep, setOpenStep] = useState<string>('hasProduct')
  const step = data?.funnel.find((s) => s.key === openStep)

  return (
    <div>
      <PageHeader title="Activation" subtitle="How far each workspace gets, and who is stuck where" />

      {error && (
        <div className="mt-6">
          <ErrorBox message="Couldn't load activation." onRetry={() => refetch()} />
        </div>
      )}

      <div className="mt-8 grid grid-cols-1 gap-4 sm:grid-cols-3">
        <KPICard title="Workspaces" value={isPending || !data ? '--' : String(data.totalOrganizations)} sub="Internal ones left out" />
        <KPICard title="Sign-ups" qualifier="7 days" value={isPending || !data ? '--' : String(data.signupsLast7Days)} highlight />
        <KPICard title="Sign-ups" qualifier="30 days" value={isPending || !data ? '--' : String(data.signupsLast30Days)} />
      </div>

      <div className="mt-8">
        <Panel title="Funnel" chip="Each step needs the ones before it">
          {isPending || !data ? (
            <Spinner className="h-32" />
          ) : (
            <Funnel steps={data.funnel} open={openStep} onOpen={setOpenStep} />
          )}
        </Panel>
      </div>

      {step && step.key !== 'signedUp' && (
        <div className="mt-6">
          <Panel
            title={`Stuck before “${step.label}”`}
            chip={`${step.stuckCount} workspace${step.stuckCount === 1 ? '' : 's'}`}
            flush
          >
            {step.stuck.length === 0 ? (
              <EmptyState className="h-32" title="Nobody is stuck here" body="Every workspace that reached the step before has done this one too." />
            ) : (
              <Table headers={['Workspace', 'Owner', 'Signed up', { label: 'Days', right: true }]}>
                {step.stuck.map((o) => (
                  <tr key={o.id}>
                    <td className={`${td} text-text-primary`}>{o.name}</td>
                    <td className={`${td} font-mono text-[13px]`}>{o.ownerEmail ?? '—'}</td>
                    <td className={td}>{formatDate(o.createdAt)}</td>
                    <td className={tdRight}>{o.daysSinceSignup}</td>
                  </tr>
                ))}
              </Table>
            )}
            {step.stuckCount > step.stuck.length && (
              <p className="border-t border-border px-5 py-3 text-[13px] text-text-muted">
                Showing the newest {step.stuck.length} of {step.stuckCount}.
              </p>
            )}
          </Panel>
        </div>
      )}

      <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-5">
        <div className="lg:col-span-3">
          <Panel title="Features in use" chip="Live, active campaigns">
            {isPending || !data ? (
              <Spinner className="h-32" />
            ) : (
              <div className="space-y-5">
                <div className="grid grid-cols-1 divide-y divide-border sm:grid-cols-4 sm:divide-x sm:divide-y-0">
                  <MiniStat label="Active campaigns" value={data.adoption.activeCampaigns} />
                  <MiniStat label="Charm pricing" value={data.adoption.charmPricing} />
                  <MiniStat
                    label="A/B tests running"
                    value={data.adoption.runningAbTests.tests}
                    sub={`${data.adoption.runningAbTests.organizations} workspaces`}
                  />
                  <MiniStat
                    label="Holiday deals"
                    value={data.adoption.dealsNotEnded.deals}
                    sub="Not ended yet"
                  />
                </div>
                <Breakdown title="Pricing mode" counts={data.adoption.pricingModes} labels={MODE_LABELS} />
                <Breakdown title="Discount delivery" counts={data.adoption.discountDelivery} labels={DELIVERY_LABELS} />
                <Breakdown title="Payment platforms connected" counts={data.adoption.integrations} labels={{}} capitalize />
                <div className="grid grid-cols-1 divide-y divide-border border-t border-border pt-4 sm:grid-cols-2 sm:divide-x sm:divide-y-0">
                  <MiniStat label="Teams of two or more" value={data.adoption.teamsOfTwoOrMore} />
                  <MiniStat label="Server API in the last 30 days" value={data.adoption.serverApiLast30Days} sub="Workspaces using a secret key" />
                </div>
              </div>
            )}
          </Panel>
        </div>
        <div className="lg:col-span-2">
          <Panel title="Sign-ups by week" chip="UTC, Monday start">
            {isPending || !data ? <Spinner className="h-32" /> : <WeekBars weeks={data.signupsByWeek} />}
          </Panel>
        </div>
      </div>
    </div>
  )
}

function Funnel({ steps, open, onOpen }: { steps: ActivationStep[]; open: string; onOpen: (key: string) => void }) {
  const top = steps[0]?.reached ?? 0
  if (top === 0) return <EmptyState className="h-32" title="No workspaces yet" body="The funnel fills in as people sign up." />
  return (
    <div className="space-y-2">
      {steps.map((s, i) => {
        const pct = top > 0 ? (s.reached / top) * 100 : 0
        const prev = i > 0 ? steps[i - 1]!.reached : null
        const stepRate = prev ? (s.reached / prev) * 100 : null
        const selectable = s.key !== 'signedUp'
        return (
          <button
            key={s.key}
            type="button"
            disabled={!selectable}
            onClick={() => onOpen(s.key)}
            className={`grid w-full grid-cols-[minmax(0,11rem)_1fr_auto] items-center gap-4 border px-3 py-2 text-left transition-colors ${
              open === s.key ? 'border-accent bg-accent/10' : 'border-transparent'
            } ${selectable ? 'cursor-pointer hover:border-border-strong' : 'cursor-default'}`}
          >
            <span className="truncate text-sm text-text-primary">{s.label}</span>
            <span className="h-3 bg-bg">
              <span className="block h-3 bg-accent" style={{ width: `${Math.max(pct, s.reached > 0 ? 1 : 0)}%` }} />
            </span>
            <span className="w-36 text-right font-mono text-xs tabular-nums text-text-secondary">
              <span className="font-display text-sm font-bold text-text-primary">{s.reached}</span>
              {stepRate !== null && <span className="ml-2">{stepRate.toFixed(0)}% of prev</span>}
            </span>
          </button>
        )
      })}
    </div>
  )
}

function Breakdown({
  title,
  counts,
  labels,
  capitalize,
}: {
  title: string
  counts: Record<string, number>
  labels: Record<string, string>
  capitalize?: boolean
}) {
  const entries = Object.entries(counts).sort(([, a], [, b]) => b - a)
  return (
    <div className="border-t border-border pt-4">
      <p className="text-[13px] text-text-secondary">{title}</p>
      {entries.length === 0 ? (
        <p className="mt-1.5 text-sm text-text-muted">None yet</p>
      ) : (
        <div className="mt-2 flex flex-wrap gap-x-6 gap-y-2">
          {entries.map(([key, n]) => (
            <span key={key} className="flex items-baseline gap-2">
              <span className={`text-sm text-text-secondary ${capitalize ? 'capitalize' : ''}`}>{labels[key] ?? key}</span>
              <span className="font-display text-sm font-bold tabular-nums text-text-primary">{n}</span>
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

function WeekBars({ weeks }: { weeks: Array<{ weekStart: string; signups: number }> }) {
  const max = Math.max(1, ...weeks.map((w) => w.signups))
  return (
    <div className="space-y-1.5">
      {weeks.map((w) => (
        <div key={w.weekStart} className="grid grid-cols-[4.5rem_1fr_2rem] items-center gap-3">
          <span className="font-mono text-xs text-text-muted">{formatDate(w.weekStart).replace(/ \d{4}$/, '')}</span>
          <span className="h-2.5 bg-bg">
            <span className="block h-2.5 bg-accent" style={{ width: `${(w.signups / max) * 100}%` }} />
          </span>
          <span className="text-right font-mono text-xs tabular-nums text-text-primary">{w.signups}</span>
        </div>
      ))}
    </div>
  )
}
