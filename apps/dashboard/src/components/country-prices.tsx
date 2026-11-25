import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { api, type CountryPriceStatus } from '~/lib/api'
import { minorUnitExponent } from '@gopaylocal/shared/currency'
import { formatPrice } from '~/lib/format'
import { countryName, flagEmoji } from '~/lib/countries'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '~/components/ui/select'
import { btnSecondary, Spinner } from '~/components/ui/page'
import { ErrorText } from '~/components/ui/status'

const GUIDE = 'https://docs.gopaylocal.com/integrations/dodo-payments/#dodo-charges-the-country-price'

/**
 * Major units of a Dodo minor amount, with the ISO 4217 exponent the API uses
 * (not Intl's display digits: IDR has exponent 2 but is shown without decimals).
 */
function majorAmount(minorAmount: number, currency: string): number {
  return minorAmount / 10 ** minorUnitExponent(currency)
}

/**
 * The Dodo product a campaign sets country prices on, picked from the Dodo
 * account the integration is connected to. It must cost what the GoPayLocal
 * product costs; the API checks that again before it writes anything. When the
 * list can't be read (the member can't import products, or Dodo refused), the
 * product id can be typed.
 */
export function DodoProductSelect({
  teamId,
  integrationId,
  env,
  value,
  onChange,
  product,
}: {
  teamId: string
  integrationId: string
  env: 'live' | 'test'
  value: string
  onChange: (providerProductId: string) => void
  product: { basePrice: number; currency: string } | undefined
}) {
  const { data: dodoProducts, isLoading, isError } = useQuery({
    queryKey: ['integration-products', teamId, integrationId, env],
    queryFn: () => api.integrations.listProducts(teamId, integrationId, env),
    enabled: !!teamId && !!integrationId,
    retry: false,
  })
  const chosen = dodoProducts?.find((p) => p.providerProductId === value)
  const priceDiffers =
    !!chosen &&
    !!product &&
    (chosen.price === null ||
      (chosen.currency ?? '').toUpperCase() !== product.currency.toUpperCase() ||
      Math.abs(chosen.price - product.basePrice) > 1e-9)

  return (
    <div>
      <label className="block text-sm font-medium text-text-primary">
        Dodo product <span className="text-brand-text">*</span>
      </label>
      {isLoading ? (
        <p className="mt-1.5 text-[13px] text-text-secondary">Loading your Dodo products…</p>
      ) : isError || !dodoProducts ? (
        <>
          <input
            type="text"
            value={value}
            onChange={(e) => onChange(e.target.value.trim())}
            placeholder="pdt_…"
            className="mt-1 block w-full border border-control px-3 py-2 font-mono text-sm text-text-primary focus:border-brand focus:outline-none"
          />
          <p className="mt-1.5 text-[13px] text-text-secondary">
            Your Dodo products couldn't be listed here. Paste the product id from the Dodo dashboard.
          </p>
        </>
      ) : (
        <Select value={value || undefined} onValueChange={onChange}>
          <SelectTrigger className="mt-1 w-full">
            <SelectValue placeholder="Pick the Dodo product" />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {dodoProducts.map((p) => (
                <SelectItem key={p.providerProductId} value={p.providerProductId}>
                  {p.name}
                  {p.price !== null && p.currency ? ` · ${formatPrice(p.price, p.currency)}` : ''}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      )}
      {priceDiffers && product ? (
        <ErrorText className="mt-1.5">
          This Dodo product costs {chosen.price !== null && chosen.currency ? formatPrice(chosen.price, chosen.currency) : 'something else'},
          but the GoPayLocal product costs {formatPrice(product.basePrice, product.currency)}. Make them the same, or
          GoPayLocal won't set its prices.
        </ErrorText>
      ) : (
        <p className="mt-1.5 text-[13px] text-text-secondary">
          GoPayLocal writes one price per country on this product. It must have no country prices of its own, and
          Dodo's Purchasing Power Parity must be off on it.
        </p>
      )}
    </div>
  )
}

function syncSummary(status: CountryPriceStatus['current']): string {
  if (!status?.syncedAt) return 'Not synced yet.'
  const when = new Date(status.syncedAt).toLocaleString()
  const left = status.remaining > 0 ? ` ${status.remaining} ${status.remaining === 1 ? 'change' : 'changes'} left; the next batch runs within 10 minutes.` : ''
  return `Last synced ${when}.${left}`
}

/**
 * The campaign's country prices at Dodo: what Dodo charges in each country
 * (the prices GoPayLocal wrote, as the last sync recorded them), how that sync
 * went, and Sync now. The banner offers exactly these prices.
 */
export function CountryPricesPanel({
  teamId,
  campaignId,
  canSync,
  active,
}: {
  teamId: string
  campaignId: string
  canSync: boolean
  active: boolean
}) {
  const queryClient = useQueryClient()
  const key = ['country-prices', teamId, campaignId]
  const { data, isLoading } = useQuery({
    queryKey: key,
    queryFn: () => api.campaigns.countryPrices(teamId, campaignId),
    enabled: !!teamId,
    refetchInterval: (q) => ((q.state.data?.current?.remaining ?? 0) > 0 || (q.state.data?.removing ?? 0) > 0 ? 30_000 : false),
  })
  const sync = useMutation({
    mutationFn: () => api.campaigns.syncCountryPrices(teamId, campaignId),
    onSuccess: (status) => {
      queryClient.setQueryData(key, status)
      const problem = status.current?.lastSync?.problem
      if (problem) toast.error("Dodo's prices weren't changed", { description: problem })
      else toast.success('Synced with Dodo')
    },
    onError: (err) => toast.error('Sync failed', { description: err.message }),
  })

  if (isLoading) return <Spinner className="py-10" />
  const current = data?.current ?? null
  const lastSync = current?.lastSync ?? null

  return (
    <div className="space-y-4">
      <div className="border border-border bg-panel p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-wider text-text-muted">Prices at Dodo</p>
            <p className="mt-1 text-sm text-text-primary">
              {current
                ? current.prices.length > 0
                  ? `Dodo charges your price in ${current.prices.length} ${current.prices.length === 1 ? 'country' : 'countries'}. Buyers enter no code.`
                  : 'Dodo charges no country price yet.'
                : active
                  ? 'Pick the Dodo product in Settings to set country prices.'
                  : 'The campaign is not active, so Dodo charges no country price for it.'}
            </p>
            {current && <p className="mt-1 text-[13px] text-text-secondary">{syncSummary(current)}</p>}
            {(data?.removing ?? 0) > 0 && (
              <p className="mt-1 text-[13px] text-text-secondary">
                Removing the prices GoPayLocal set on {data!.removing === 1 ? 'a previous product' : `${data!.removing} previous products`}.
              </p>
            )}
          </div>
          {canSync && current && (
            <button type="button" onClick={() => sync.mutate()} disabled={sync.isPending} className={btnSecondary}>
              {sync.isPending ? 'Syncing…' : 'Sync now'}
            </button>
          )}
        </div>
        {lastSync?.problem && <ErrorText className="mt-3">{lastSync.problem}</ErrorText>}
        {lastSync && lastSync.failures.length > 0 && (
          <ErrorText className="mt-3">
            Dodo refused {lastSync.failures.length} {lastSync.failures.length === 1 ? 'price' : 'prices'}:{' '}
            {lastSync.failures
              .slice(0, 3)
              .map((f) => `${f.country ? countryName(f.country) : 'a rule'} (${f.message})`)
              .join('; ')}
            {lastSync.failures.length > 3 ? '…' : ''}
          </ErrorText>
        )}
        <p className="mt-3 text-[13px] text-text-secondary">
          The banner shows only these prices. A country whose discount changed is offered again after the next sync.{' '}
          <a href={GUIDE} target="_blank" rel="noopener noreferrer" className="text-brand-text underline hover:no-underline">
            How it works
          </a>
        </p>
      </div>

      {current && current.prices.length > 0 && (
        <div className="border border-border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-panel text-left text-[11px] font-semibold uppercase tracking-wider text-text-muted">
                <th className="px-4 py-2">Country</th>
                <th className="px-4 py-2 text-right">Dodo charges</th>
                <th className="px-4 py-2 text-right">Discount</th>
              </tr>
            </thead>
            <tbody>
              {[...current.prices]
                .sort((a, b) => countryName(a.country).localeCompare(countryName(b.country)))
                .map((p) => (
                <tr key={p.country} className="border-b border-border last:border-0">
                  <td className="px-4 py-2 text-text-primary">
                    <span aria-hidden="true">{flagEmoji(p.country)}</span> {countryName(p.country)}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums text-text-primary">
                    {formatPrice(majorAmount(p.minorAmount, p.currency), p.currency)}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums text-text-secondary">{p.discount}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
