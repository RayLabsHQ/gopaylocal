import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState, useMemo } from 'react'
import { toast } from 'sonner'
import {
  columnFilteringFeature,
  columnVisibilityFeature,
  createColumnHelper,
  createFilteredRowModel,
  createSortedRowModel,
  flexRender,
  globalFilteringFeature,
  rowSortingFeature,
  sortFn_alphanumeric,
  sortFn_datetime,
  sortFn_text,
  tableFeatures,
  useTable,
  type SortingState,
} from '@tanstack/react-table'
import { api, PROVIDER_LABELS } from '~/lib/api'
import { getActiveTeamId, useSession } from '~/lib/auth'
import { useEnv } from '~/lib/env'
import { EnvNotice } from '~/components/env-notice'
import { CharmHelp } from '~/components/charm-help'
import { DeliveryHelp } from '~/components/delivery-help'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '~/components/ui/select'
import {
  PPP_MULTIPLIERS,
  COUNTRY_NAMES,
  CURRENCY_SYMBOLS,
  countryDiscount,
  workspaceParityGroupsFromList,
} from '@gopaylocal/shared'
import type {
  PricingMode,
  DiscountDelivery,
  CharmPricingStrategy,
  CampaignStatus,
} from '@gopaylocal/shared'
import { ErrorText } from '~/components/ui/status'

export const Route = createFileRoute('/dashboard/campaigns/new')({
  component: NewCampaignPage,
})

// Sentinel for the "no integration" Select option (Radix can't use an empty value).
const NO_INTEGRATION = 'none'

function flag(code: string) {
  return code
    .toUpperCase()
    .split('')
    .map((c) => String.fromCodePoint(0x1f1e6 + c.charCodeAt(0) - 65))
    .join('')
}

type CountryRow = {
  code: string
  name: string
  multiplier: number
  discountPercent: number
  finalPrice: number
  symbol: string
}

// Table v9 only includes the features registered here. columnVisibilityFeature
// provides row.getVisibleCells(); the filtered row model belongs to
// columnFilteringFeature and also applies the global filter; the three sortFns
// are what the default 'auto' sort resolves to, matching v8's built-in behaviour.
const features = tableFeatures({
  columnVisibilityFeature,
  columnFilteringFeature,
  globalFilteringFeature,
  rowSortingFeature,
  filteredRowModel: createFilteredRowModel(),
  sortedRowModel: createSortedRowModel(),
  sortFns: { alphanumeric: sortFn_alphanumeric, text: sortFn_text, datetime: sortFn_datetime },
})

const columnHelper = createColumnHelper<typeof features, CountryRow>()

function NewCampaignPage() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { data: session } = useSession()
  const teamId = getActiveTeamId(session)
  const { env } = useEnv()

  const [name, setName] = useState('')
  const [productId, setProductId] = useState('')
  const [pricingMode, setPricingMode] = useState<PricingMode>('ppp_factor')
  const [discountDelivery, setDiscountDelivery] = useState<DiscountDelivery>('banner_coupon')
  const [integrationId, setIntegrationId] = useState<string>(NO_INTEGRATION)
  const [charmPricing, setCharmPricing] = useState<CharmPricingStrategy>('none')
  const [maxDiscount, setMaxDiscount] = useState(50)
  const [status, setStatus] = useState<CampaignStatus>('draft')
  const [sorting, setSorting] = useState<SortingState>([{ id: 'discountPercent', desc: true }])
  const [globalFilter, setGlobalFilter] = useState('')

  const { data: products = [] } = useQuery({
    queryKey: ['products', teamId, env],
    queryFn: () => api.products.list(teamId, env),
    enabled: !!teamId,
  })

  const { data: integrations = [] } = useQuery({
    queryKey: ['integrations', teamId],
    queryFn: () => api.integrations.list(teamId),
    enabled: !!teamId,
  })

  // Group and Custom mode are previewed with the same shared function the
  // banner is served with, over this workspace's parity groups (none: Group
  // mode uses the default tiers).
  const { data: parityGroups } = useQuery({
    queryKey: ['parity-groups', teamId],
    queryFn: () => api.parityGroups.list(teamId),
    enabled: !!teamId,
  })
  const workspaceGroups = useMemo(
    () => (parityGroups ? workspaceParityGroupsFromList(parityGroups) : null),
    [parityGroups],
  )

  const selectedProduct = products.find((p) => p.id === productId)

  // Auto-apply has nothing to apply the discount through without a provider.
  const autoApplyNeedsIntegration =
    discountDelivery === 'auto_apply' && integrationId === NO_INTEGRATION
  // The server rejects activating an auto-apply campaign with no integration, so
  // the Create button is disabled for that combination. Surface the reason.
  const blockedByAutoApply = autoApplyNeedsIntegration && status === 'active'

  const createCampaign = useMutation({
    mutationFn: () =>
      api.campaigns.create(teamId, {
        name,
        productId,
        integrationId: integrationId === NO_INTEGRATION ? null : integrationId,
        pricingMode,
        discountDelivery,
        charmPricingStrategy: charmPricing,
        maxDiscountPercent: maxDiscount,
        status,
        // Per-country percentages (Custom mode) are set through the API; this
        // form has no field for them, so it sends none.
        // The mode the sidebar switch is on; the product list above is filtered
        // by it, so the product is in the same environment.
        environment: env,
      }),
    onSuccess: (campaign) => {
      queryClient.invalidateQueries({ queryKey: ['campaigns', teamId] })
      toast.success('Campaign created', { description: 'Add the snippet to your site to go live.' })
      navigate({ to: '/dashboard/campaigns/$id', params: { id: campaign.id } })
    },
    onError: (err) => {
      toast.error('Failed to create campaign', { description: err.message })
    },
  })

  const countryRows = useMemo<CountryRow[]>(() => {
    const basePrice = selectedProduct?.basePrice ?? 0
    const currency = selectedProduct?.currency ?? 'USD'
    const symbol = CURRENCY_SYMBOLS[currency] ?? currency

    return Object.entries(PPP_MULTIPLIERS).map(([code, multiplier]) => {
      let discountPercent: number
      if (pricingMode === 'ppp_factor') {
        const raw = (1 - multiplier) * 100
        discountPercent = Math.min(Math.max(Math.round(raw), 0), maxDiscount)
      } else {
        // Nothing is shown until the parity groups have loaded.
        discountPercent = workspaceGroups
          ? countryDiscount(
              { pricingMode, maxDiscountPercent: maxDiscount, discountOverrides: null },
              code,
              workspaceGroups,
            ).discount
          : 0
      }
      const finalPrice = basePrice > 0 ? basePrice * (1 - discountPercent / 100) : 0
      return {
        code,
        name: COUNTRY_NAMES[code] ?? code,
        multiplier,
        discountPercent,
        finalPrice,
        symbol,
      }
    })
  }, [selectedProduct, pricingMode, maxDiscount, workspaceGroups])

  const columns = useMemo(
    () => columnHelper.columns([
      columnHelper.accessor('name', {
        header: 'Country',
        filterFn: (row, _columnId, filterValue: string) => {
          const q = filterValue.toLowerCase()
          return row.original.name.toLowerCase().includes(q) || row.original.code.toLowerCase().includes(q)
        },
        cell: (info) => (
          <span className="flex items-center gap-2">
            <span className="text-base leading-none">{flag(info.row.original.code)}</span>
            <span className="truncate text-[13px] text-text-primary">{info.getValue()}</span>
            <span className="font-mono text-[11px] text-text-secondary">{info.row.original.code}</span>
          </span>
        ),
      }),
      // The country's PPP factor, read-only: it comes from shared data and is
      // not part of what this form saves.
      columnHelper.accessor('multiplier', {
        header: 'PPP',
        cell: (info) => (
          <span className="font-mono text-[13px] tabular-nums text-text-secondary">{info.getValue().toFixed(2)}</span>
        ),
      }),
      columnHelper.accessor('discountPercent', {
        header: 'Discount',
        cell: (info) => {
          const row = info.row.original
          return (
            <span
              className={`font-mono text-[13px] font-medium tabular-nums ${
                row.discountPercent === 0 ? 'text-text-secondary' : 'text-success'
              }`}
            >
              {row.discountPercent > 0 ? `-${row.discountPercent}%` : '—'}
            </span>
          )
        },
      }),
      columnHelper.accessor('finalPrice', {
        header: 'Final Price',
        cell: (info) => {
          const row = info.row.original
          return (
            <span className="font-mono text-[13px] font-medium tabular-nums text-text-primary">
              {row.finalPrice > 0 ? `${row.symbol}${row.finalPrice.toFixed(2)}` : '—'}
            </span>
          )
        },
      }),
    ]),
    [],
  )

  const table = useTable({
    features,
    data: countryRows,
    columns,
    state: { sorting, globalFilter },
    onSortingChange: setSorting,
    onGlobalFilterChange: setGlobalFilter,
    globalFilterFn: (row, _columnId, filterValue: string) => {
      const q = filterValue.toLowerCase()
      return row.original.name.toLowerCase().includes(q) || row.original.code.toLowerCase().includes(q)
    },
  })

  const filteredRows = table.getRowModel().rows
  const avgDiscount = filteredRows.length > 0
    ? Math.round(filteredRows.reduce((sum, r) => sum + r.original.discountPercent, 0) / filteredRows.length)
    : 0

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    createCampaign.mutate()
  }

  return (
    <div>
      <div className="mb-8">
        <h1 className="font-display text-[32px] font-semibold tracking-tight text-text-primary">
          New campaign
        </h1>
        <p className="mt-1 text-base text-text-secondary">
          Set up PPP discount rules for a product.
        </p>
        <EnvNotice env={env}>
          {env === 'test'
            ? "This campaign will be saved in Test mode. Its coupons are created with your providers' test keys, and it is listed only while the Live/Test switch in the sidebar is on Test. Switch to Live to create a live campaign."
            : "This campaign will be saved in Live mode: once it is active and linked to an integration, its coupons are created in your providers' live accounts. Switch the Live/Test switch in the sidebar to Test to try a campaign out first."}
        </EnvNotice>
      </div>

      <div className="flex flex-col gap-8 lg:flex-row">
        {/* Left column — Settings */}
        <form onSubmit={handleSubmit} className="w-full space-y-5 lg:w-[400px] lg:shrink-0">
          <div>
            <label htmlFor="name" className="block text-sm font-medium text-text-primary">Campaign Name</label>
            <input id="name" type="text" required value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Pro Plan PPP" className="mt-1 block w-full border border-control px-3 py-2 text-sm text-text-primary focus:border-brand focus:outline-none" />
          </div>

          <div>
            <label className="block text-sm font-medium text-text-primary">Product</label>
            <Select value={productId} onValueChange={setProductId}>
              <SelectTrigger className="mt-1 w-full"><SelectValue placeholder="Select a product..." /></SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {products.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name} — {CURRENCY_SYMBOLS[p.currency] ?? p.currency}{p.basePrice.toFixed(2)}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
            {products.length === 0 && (
              <p className="mt-1.5 text-[13px] text-text-secondary">
                No {env} products yet. Create one in {env === 'test' ? 'Test' : 'Live'} mode before setting up a campaign.
              </p>
            )}
          </div>

          <div>
            <label className="block text-sm font-medium text-text-primary">Pricing Mode</label>
            <Select value={pricingMode} onValueChange={(v) => setPricingMode(v as PricingMode)}>
              <SelectTrigger className="mt-1 w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem value="ppp_factor">PPP Factor (automatic)</SelectItem>
                  <SelectItem value="group">Group-based tiers</SelectItem>
                  <SelectItem value="custom">Custom per-country</SelectItem>
                </SelectGroup>
              </SelectContent>
            </Select>
            <p className="mt-1.5 text-[13px] text-text-secondary">
              {pricingMode === 'ppp_factor' && 'Discount calculated from purchasing power parity data.'}
              {pricingMode === 'group' &&
                `Each country gets its parity group's discount.${
                  parityGroups === undefined
                    ? ''
                    : parityGroups.length > 0
                      ? " This workspace's own parity groups apply."
                      : ' This workspace has no parity groups, so the 5 default tiers apply.'
                }`}
              {pricingMode === 'custom' &&
                "Per-country percentages (discountOverrides) are set through the API today; this form saves the campaign without them. A country without its own percentage gets its parity group's discount, or none."}
            </p>
          </div>

          <div>
            <label htmlFor="maxDiscount" className="block text-sm font-medium text-text-primary">Max Discount (%)</label>
            <div className="mt-1 flex items-center gap-3">
              <input type="range" min={5} max={90} step={5} value={maxDiscount} onChange={(e) => setMaxDiscount(parseInt(e.target.value, 10))} className="h-1.5 flex-1 appearance-none rounded-full bg-border accent-brand" />
              <input id="maxDiscount" type="number" min={1} max={90} value={maxDiscount} onChange={(e) => setMaxDiscount(parseInt(e.target.value, 10) || 50)} className="w-16 border border-control px-2 py-1.5 text-center text-sm text-text-primary focus:border-brand focus:outline-none" />
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-text-primary">Discount Delivery</label>
            <Select value={discountDelivery} onValueChange={(v) => setDiscountDelivery(v as DiscountDelivery)}>
              <SelectTrigger className="mt-1 w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem value="banner_coupon">Banner + Coupon Code</SelectItem>
                  <SelectItem value="auto_apply">Auto-apply at checkout</SelectItem>
                </SelectGroup>
              </SelectContent>
            </Select>
            <DeliveryHelp delivery={discountDelivery} />
          </div>

          <div>
            <label className="block text-sm font-medium text-text-primary">
              Payment Integration
              {discountDelivery === 'auto_apply' && <span className="text-brand-text"> *</span>}
            </label>
            <Select value={integrationId} onValueChange={setIntegrationId}>
              <SelectTrigger className="mt-1 w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem value={NO_INTEGRATION}>None — banner only</SelectItem>
                  {integrations.map((i) => (
                    <SelectItem key={i.id} value={i.id}>
                      {PROVIDER_LABELS[i.provider] ?? i.provider}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
            {integrations.length === 0 ? (
              <p className="mt-1.5 text-[13px] text-text-secondary">
                No integrations connected.{' '}
                <button type="button" onClick={() => navigate({ to: '/dashboard/integrations' })} className="text-brand-text underline hover:no-underline">
                  Connect one
                </button>{' '}
                to auto-create coupons at your provider.
              </p>
            ) : autoApplyNeedsIntegration ? (
              <ErrorText className="mt-1.5">
                Auto-apply needs a payment integration before the campaign can be active.
              </ErrorText>
            ) : (
              <p className="mt-1.5 text-[13px] text-text-secondary">
                Links the campaign to a provider so coupons are created automatically.
              </p>
            )}
          </div>

          <div>
            <label className="block text-sm font-medium text-text-primary">Charm Pricing</label>
            <Select value={charmPricing} onValueChange={(v) => setCharmPricing(v as CharmPricingStrategy)}>
              <SelectTrigger className="mt-1 w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem value="none">None</SelectItem>
                  <SelectItem value="dot99">.99 ending</SelectItem>
                  <SelectItem value="round_x9">Round to X9 ($29, $39)</SelectItem>
                  <SelectItem value="nearest_5">Nearest $5</SelectItem>
                  <SelectItem value="region_aware">Region-aware</SelectItem>
                </SelectGroup>
              </SelectContent>
            </Select>
            <CharmHelp strategy={charmPricing} />
          </div>

          <div>
            <label className="block text-sm font-medium text-text-primary">Initial Status</label>
            <Select value={status} onValueChange={(v) => setStatus(v as CampaignStatus)}>
              <SelectTrigger className="mt-1 w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem value="draft">Draft</SelectItem>
                  <SelectItem value="active">Active</SelectItem>
                  <SelectItem value="paused">Paused</SelectItem>
                </SelectGroup>
              </SelectContent>
            </Select>
          </div>

          {/* Why the Create button is disabled (mirrors the edit page). */}
          {blockedByAutoApply && (
            <div className="border border-warning-border bg-warning-light p-3">
              <p className="text-[13px] text-text-primary">
                Auto-apply needs a payment integration — link one above or save as draft.
              </p>
            </div>
          )}

          {createCampaign.error && (
            <ErrorText>{createCampaign.error.message || 'Failed to create campaign.'}</ErrorText>
          )}

          <div className="flex items-center gap-3 pt-2">
            <button type="submit" disabled={createCampaign.isPending || !selectedProduct || !name || blockedByAutoApply} className="bg-brand px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-brand/90 disabled:opacity-50">
              {createCampaign.isPending ? 'Creating…' : 'Create campaign'}
            </button>
            <button type="button" onClick={() => navigate({ to: '/dashboard/campaigns' })} className="border border-border px-4 py-2 text-sm font-medium text-text-primary transition-colors hover:bg-surface">
              Cancel
            </button>
          </div>
        </form>

        {/* Right column — Country Pricing Data Table */}
        <div className="flex min-w-0 flex-1 flex-col border border-border">
          {/* Header. Below sm the search wraps onto its own line and may shrink:
              unwrapped, this row was wider than a phone and widened the whole page
              (the scroll area grows to fit), clipping every field's right edge. */}
          <div className="flex items-center justify-between border-b border-border px-5 py-4 max-sm:flex-wrap max-sm:gap-3">
            <div>
              <h2 className="font-display text-lg font-semibold text-text-primary">Country Pricing Preview</h2>
              {selectedProduct ? (
                <p className="mt-0.5 text-[13px] text-text-secondary">
                  {selectedProduct.name} · {CURRENCY_SYMBOLS[selectedProduct.currency] ?? selectedProduct.currency}
                  {selectedProduct.basePrice.toFixed(2)} {selectedProduct.currency}
                </p>
              ) : (
                <p className="mt-0.5 text-[13px] text-text-secondary">Select a product to preview pricing</p>
              )}
            </div>
            <div className="flex items-center gap-3 max-sm:min-w-0">
              <span className="text-[13px] tabular-nums text-text-secondary">
                {filteredRows.length} countries · avg {avgDiscount}%
              </span>
              <input
                type="text"
                placeholder="Search countries..."
                value={globalFilter ?? ''}
                onChange={(e) => setGlobalFilter(e.target.value)}
                className="w-44 max-sm:min-w-0 border border-control bg-bg px-2.5 py-1.5 text-[13px] text-text-primary placeholder:text-text-muted focus:border-brand focus:outline-none"
              />
            </div>
          </div>

          {/* Table. It scrolls sideways in its own box on a phone. The page's
              ScrollArea wraps content in a display:table div that grows to its
              content's minimum width, so without inline-size containment the
              4-column table (about 510px) widened the whole page and clipped
              every field's right edge once a product was picked. */}
          <div className="flex-1 overflow-auto [contain:inline-size]" style={{ maxHeight: 'calc(100vh - 320px)' }}>
            {!selectedProduct ? (
              <div className="flex flex-col items-center justify-center px-6 py-20 text-center">
                <p className="text-base font-medium text-text-primary">No product selected</p>
                <p className="mt-1.5 max-w-sm text-sm text-text-secondary">
                  Pick a product on the left to see the discount and final price for the 75
                  countries with PPP data.
                </p>
              </div>
            ) : (
              <table className="w-full">
                <thead className="sticky top-0 z-10 bg-surface">
                  {table.getHeaderGroups().map((headerGroup) => (
                    <tr key={headerGroup.id}>
                      {headerGroup.headers.map((header) => (
                        <th
                          key={header.id}
                          onClick={header.column.getToggleSortingHandler()}
                          className={`px-5 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-text-secondary ${
                            header.column.getCanSort() ? 'cursor-pointer select-none hover:text-text-primary' : ''
                          } ${header.id !== 'name' ? 'text-right' : ''}`}
                        >
                          <span className="inline-flex items-center gap-1">
                            {flexRender(header.column.columnDef.header, header.getContext())}
                            {{
                              asc: ' ↑',
                              desc: ' ↓',
                            }[header.column.getIsSorted() as string] ?? ''}
                          </span>
                        </th>
                      ))}
                    </tr>
                  ))}
                </thead>
                <tbody>
                  {filteredRows.map((row, i) => (
                    <tr key={row.id} className={i % 2 !== 0 ? 'bg-surface/50' : ''}>
                      {row.getVisibleCells().map((cell) => (
                        <td
                          key={cell.id}
                          className={`px-5 py-2 ${cell.column.id !== 'name' ? 'text-right' : ''}`}
                        >
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
      </div>
    </div>
  )
}
