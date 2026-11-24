import { createFileRoute } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { minorToMajor } from '@gopaylocal/shared/currency'
import { adminApi, ApiError, type HouseSyncRecord } from '~/lib/api'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '~/components/select'
import {
  EmptyState,
  ErrorBox,
  KPICard,
  Panel,
  PageHeader,
  Spinner,
  Table,
  Tag,
  btn,
  btnAccent,
  flag,
  formatDate,
  formatDateTime,
  formatMoney,
  td,
  tdRight,
} from '~/components/ui'

export const Route = createFileRoute('/admin/pricing')({
  component: RegionalPricePage,
})

function RegionalPricePage() {
  const queryClient = useQueryClient()
  const { data, isPending, error, refetch } = useQuery({
    queryKey: ['admin', 'house-pricing'],
    queryFn: () => adminApi.housePricing.get(),
  })
  const [choice, setChoice] = useState('')
  const [progress, setProgress] = useState<{ running: boolean; batches: number; last?: HouseSyncRecord; message?: string } | null>(null)

  const setHouse = useMutation({
    mutationFn: (campaignId: string) => adminApi.housePricing.set(campaignId),
    onSuccess: () => {
      setChoice('')
      queryClient.invalidateQueries({ queryKey: ['admin', 'house-pricing'] })
    },
  })

  // One request sends at most a batch of changes; repeat until nothing is left.
  async function pushToDodo() {
    setProgress({ running: true, batches: 0 })
    let batches = 0
    try {
      for (;;) {
        const result = await adminApi.housePricing.sync()
        batches++
        if (result.outcome !== 'synced') {
          setProgress({ running: false, batches, message: result.outcome === 'skipped' ? result.reason : result.problem })
          break
        }
        setProgress({ running: true, batches, last: result.record })
        if (result.record.remaining === 0 || batches >= 20) {
          setProgress({ running: false, batches, last: result.record })
          break
        }
      }
    } catch (err) {
      setProgress({ running: false, batches, message: err instanceof ApiError ? err.message : 'The sync failed.' })
    }
    queryClient.invalidateQueries({ queryKey: ['admin', 'house-pricing'] })
    queryClient.invalidateQueries({ queryKey: ['admin', 'audit'] })
  }

  const table = data?.table
  // The dashboard's labels for the campaign's Charm Pricing setting.
  const CHARM_LABELS: Record<string, string> = {
    none: 'None',
    dot99: '.99 ending',
    round_x9: 'Round to X9',
    nearest_5: 'Nearest $5',
    region_aware: 'Region-aware',
  }
  const rows = table && table.ok ? table.rows : []
  const matching = rows.filter((r) => r.dodo?.status === 'match').length
  const lastSync = progress?.last ?? data?.settings?.lastSync ?? null
  const current = data?.settings?.campaign ?? null
  const others = (data?.candidates ?? []).filter((c) => c.campaignId !== current?.campaignId)

  return (
    <div>
      <PageHeader
        title="Regional price"
        subtitle="Pro's price in each country: shown by the house campaign, charged by Dodo"
        action={
          data && !data.unavailable && table?.ok ? (
            <button type="button" className={btnAccent} disabled={progress?.running} onClick={pushToDodo}>
              {progress?.running ? `Pushing… batch ${progress.batches + 1}` : 'Push to Dodo'}
            </button>
          ) : undefined
        }
      />

      {error && (
        <div className="mt-6">
          <ErrorBox message="Couldn't load the regional price." onRetry={() => refetch()} />
        </div>
      )}
      {data?.unavailable && (
        <div className="mt-6 border border-border bg-surface px-5 py-4 text-sm text-text-secondary">{data.unavailable}</div>
      )}
      {progress?.message && (
        <div className="mt-6">
          <ErrorBox message={progress.message} />
        </div>
      )}

      <div className="mt-8 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <KPICard
          title="Dodo mode"
          value={!data ? '--' : data.dodoEnvironment === 'test_mode' ? 'Test' : 'Live'}
          sub="DODO_ENVIRONMENT on the API"
        />
        <KPICard
          title="Countries at Dodo"
          value={isPending || !table?.ok ? '--' : `${matching} / ${rows.length}`}
          sub={data?.dodo && !data.dodo.ok ? data.dodo.message : data?.dodo?.ok && data.dodo.extraRules > 0 ? `${data.dodo.extraRules} rules to remove` : 'Charging the shown price'}
          highlight={!!table?.ok && matching === rows.length && rows.length > 0}
        />
        <KPICard
          title="Exchange rates"
          value={table?.ok ? (table.fxAsOf ? formatDate(table.fxAsOf) : 'None') : '--'}
          sub="Local prices follow them; Dodo is re-synced every 6 hours"
        />
        <KPICard
          title="Last sync"
          value={lastSync ? formatDateTime(lastSync.at).replace(' UTC', '') : 'Never'}
          sub={
            lastSync
              ? `${lastSync.created} new, ${lastSync.updated} changed, ${lastSync.archived} removed${lastSync.remaining ? `, ${lastSync.remaining} left` : ''}`
              : undefined
          }
        />
      </div>

      {lastSync && lastSync.failures.length > 0 && (
        <div className="mt-4 border border-danger/40 bg-danger/10 px-4 py-3 text-[13px] text-danger">
          <p className="font-semibold">Dodo refused {lastSync.failures.length} change{lastSync.failures.length === 1 ? '' : 's'}:</p>
          <ul className="mt-1 space-y-0.5">
            {lastSync.failures.slice(0, 5).map((f, i) => (
              <li key={i}>
                {f.country ?? 'A rule without a country'}: {f.message}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="mt-8 grid grid-cols-1 gap-6 lg:grid-cols-5">
        <div className="space-y-6 lg:col-span-2">
          <Panel title="House campaign">
            {isPending || !data ? (
              <Spinner className="h-24" />
            ) : (
              <div className="space-y-4">
                {current ? (
                  <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm">
                    <Fact label="Workspace" value={current.organizationName} />
                    <Fact label="Campaign" value={current.campaignName} />
                    <Fact label="Product" value={`${current.productName} · ${formatMoney(current.productPrice, current.productCurrency)}`} />
                    <Fact label="Largest discount" value={`${current.maxDiscountPercent}%`} />
                    <Fact label="Status" value={`${current.status}, ${current.environment}`} />
                    <Fact label="Payment platform" value={current.hasIntegration ? 'Connected (remove it)' : 'None, as required'} />
                  </dl>
                ) : data.settings ? (
                  <p className="text-sm text-warning">
                    The house campaign is gone, or its workspace is no longer internal. Pick another one.
                  </p>
                ) : (
                  <p className="text-sm text-text-secondary">No house campaign yet. Until there is one, everyone pays $19.</p>
                )}

                <div className="border-t border-border pt-4">
                  <label htmlFor="house-campaign" className="text-[13px] text-text-secondary">
                    {current ? 'Use another campaign' : 'Pick the campaign'}
                  </label>
                  <div className="mt-1.5 flex gap-2">
                    <Select value={choice || undefined} onValueChange={setChoice} disabled={others.length === 0}>
                      <SelectTrigger id="house-campaign" className="min-w-0 flex-1">
                        <SelectValue
                          placeholder={
                            data.candidates.length === 0
                              ? 'No campaigns in internal workspaces'
                              : others.length === 0
                                ? 'No other campaigns'
                                : 'Choose a campaign'
                          }
                        />
                      </SelectTrigger>
                      <SelectContent>
                        {others.map((c) => (
                          <SelectItem key={c.campaignId} value={c.campaignId}>
                            {c.organizationName} · {c.campaignName}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <button
                      type="button"
                      className={btn}
                      disabled={!choice || setHouse.isPending}
                      onClick={() => setHouse.mutate(choice)}
                    >
                      Use
                    </button>
                  </div>
                  {setHouse.error && <p className="mt-2 text-[13px] text-danger">{setHouse.error.message}</p>}
                  <p className="mt-3 text-[13px] leading-relaxed text-text-muted">
                    Only campaigns of internal workspaces are listed (Organizations → mark internal). The campaign must be
                    active and live, on a product that costs $19 USD, with no payment platform, so visitors see the price
                    and never a code.
                  </p>
                </div>
              </div>
            )}
          </Panel>

          <Panel title="In the Dodo dashboard">
            <ul className="list-disc space-y-2 pl-5 text-[13px] leading-relaxed text-text-secondary">
              <li>Turn on Adaptive Currency, so countries are charged in their own currency.</li>
              <li>Leave Purchasing Power Parity off. It would take its own discount off the price set here.</li>
              <li>
                Leave Charm Pricing off. Dodo never rounds a per-country price, but it would round the $19 it converts for
                countries without one, so they would no longer pay the $19 the website shows. The house campaign&apos;s own
                charm setting{table?.ok ? ` (${CHARM_LABELS[table.charm] ?? table.charm})` : ''} rounds
                every price here down to a charm price, so the discount shown is never more than the real one.
              </li>
              <li>Per-country prices are fees-inclusive: the buyer pays the amount shown (plus tax if the product is tax-exclusive), and the currency fee is ours.</li>
              <li>Countries without a discount pay $19, converted by Adaptive Currency.</li>
              <li>Holiday deals and A/B tests on the house campaign would change the price shown but not the price charged. Don't add them.</li>
            </ul>
          </Panel>
        </div>

        <div className="lg:col-span-3">
          <Panel title="Price per country" chip={table?.ok ? `${rows.length} with a discount` : undefined} flush>
            {isPending ? (
              <Spinner className="h-48" />
            ) : !table ? (
              <EmptyState title="Nothing to show yet" body="Pick the house campaign to see each country's price." />
            ) : !table.ok ? (
              <div className="px-5 pb-5">
                <ErrorBox message={table.problem} />
              </div>
            ) : (
              <Table headers={['Country', { label: 'Off', right: true }, { label: 'Shown and charged', right: true }, 'At Dodo']}>
                {rows.map((r) => (
                  <tr key={r.country}>
                    <td className={`${td} text-text-primary`}>
                      <span className="mr-2">{flag(r.country)}</span>
                      {r.countryName}
                    </td>
                    <td className={tdRight}>{r.discount}%</td>
                    <td className={`${tdRight} text-text-primary`}>
                      {formatMoney(r.amount, r.currency)}
                      {!r.local && r.currency === 'USD' && <span className="ml-2 text-[11px] text-text-muted">USD</span>}
                    </td>
                    <td className={td}>
                      {!r.dodo ? (
                        <span className="text-text-muted">—</span>
                      ) : r.dodo.status === 'match' ? (
                        <Tag tone="accent">Match</Tag>
                      ) : r.dodo.status === 'missing' ? (
                        <Tag tone="warning">Missing</Tag>
                      ) : (
                        <span className="flex items-center gap-2">
                          <Tag tone="warning">Differs</Tag>
                          <span className="text-[13px]">{formatMoney(minorToMajor(r.dodo.amount, r.dodo.currency), r.dodo.currency)}</span>
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </Table>
            )}
          </Panel>
        </div>
      </div>
    </div>
  )
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-[13px] text-text-muted">{label}</dt>
      <dd className="mt-0.5 truncate text-text-primary" title={value}>
        {value}
      </dd>
    </div>
  )
}
