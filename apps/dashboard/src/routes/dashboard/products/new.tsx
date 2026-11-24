import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { toast } from 'sonner'
import { api, ApiError } from '~/lib/api'
import { getActiveTeamId, useSession } from '~/lib/auth'
import { usePermissions } from '~/lib/permissions'
import { useEnv } from '~/lib/env'
import { EnvNotice } from '~/components/env-notice'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '~/components/ui/select'
import { basePriceProblem, CURRENCY_SYMBOLS } from '@gopaylocal/shared'
import { minorUnitExponent, SUPPORTED_CURRENCY_CODES } from '@gopaylocal/shared/currency'
import { ErrorText } from '~/components/ui/status'

/** The basePrice message from a 400 { details: { fieldErrors: { basePrice } } }, if any. */
function serverPriceError(err: Error | null): string | null {
  if (!(err instanceof ApiError) || err.status !== 400) return null
  const fieldErrors = (err.data?.details as { fieldErrors?: Record<string, string[]> } | undefined)?.fieldErrors
  return fieldErrors?.basePrice?.[0] ?? null
}

export const Route = createFileRoute('/dashboard/products/new')({
  component: NewProductPage,
})

function NewProductPage() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { data: session } = useSession()
  const teamId = getActiveTeamId(session)
  // The product is saved in the mode the sidebar switch is on.
  const { env } = useEnv()

  const { data: usage } = useQuery({
    queryKey: ['billing-usage', teamId],
    queryFn: () => api.billing.usage(teamId),
    enabled: !!teamId,
  })
  // remaining is null when unlimited (Pro, self-hosted): never at the limit.
  const isAtLimit = usage?.remaining != null && usage.remaining <= 0
  const canUpgrade = usage?.billingEnabled !== false && usage?.selfHosted !== true
  // products.create is owner and admin; a member who lands here sees why.
  const { role, can } = usePermissions()
  const cannotCreate = role !== null && !can('products.create')

  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const [currency, setCurrency] = useState('USD')
  const [basePrice, setBasePrice] = useState('')

  const createProduct = useMutation({
    mutationFn: () =>
      api.products.create(teamId, {
        name,
        url,
        currency,
        basePrice: parseFloat(basePrice),
        environment: env,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['products', teamId] })
      queryClient.invalidateQueries({ queryKey: ['billing-usage', teamId] })
      toast.success('Product created')
      navigate({ to: '/dashboard/products' })
    },
    onError: (err) => {
      if (err.message.includes('limit')) {
        toast.error('Product limit reached', {
          description: 'Upgrade to Pro for unlimited products.',
        })
      } else {
        toast.error('Failed to create product', {
          description: serverPriceError(err) ?? (err.message || 'Please try again.'),
        })
      }
    },
  })

  // The currencies the API accepts for a product (USD and every country's
  // currency); CURRENCY_SYMBOLS only supplies the symbol where it has one.
  const currencies = SUPPORTED_CURRENCY_CODES

  // A price is a whole number of the currency's minor units, at least one
  // (createProductSchema; the same check and message as the API).
  const exponent = minorUnitExponent(currency)
  const minorUnit = (1 / 10 ** exponent).toFixed(exponent)
  const priceProblem = basePrice === '' ? null : basePriceProblem(Number(basePrice), currency)
  const priceError = priceProblem ?? serverPriceError(createProduct.error)

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (priceProblem) return
    createProduct.mutate()
  }

  return (
    <div>
      <h1 className="font-display text-[32px] font-semibold tracking-tight text-text-primary">New product</h1>
      <p className="mt-1 text-base text-text-secondary">
        Add a product to configure PPP pricing for.
      </p>
      <EnvNotice env={env}>
        {env === 'test'
          ? 'This product will be saved in Test mode. It is listed only while the Live/Test switch in the sidebar is on Test, where you can create test campaigns for it. Switch to Live to add a live product.'
          : 'This product will be saved in Live mode. Switch the Live/Test switch in the sidebar to Test to add a test product instead.'}
      </EnvNotice>

      {isAtLimit && usage && (
        <div className="mt-6 flex max-w-lg items-center gap-3 border border-warning-border bg-warning-light px-4 py-3">
          <div className="flex h-7 w-7 shrink-0 items-center justify-center bg-warning-border">
            <svg className="h-4 w-4 text-warning" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z" />
            </svg>
          </div>
          <div className="flex-1">
            <p className="text-sm font-semibold text-warning">Product limit reached</p>
            <p className="mt-0.5 text-[13px] text-text-primary">
              Your {usage.plan} plan allows {usage.maxProducts} product{usage.maxProducts === 1 ? '' : 's'} ({usage.currentCount}/{usage.maxProducts} used).{' '}
              {canUpgrade && (
                <button
                  type="button"
                  onClick={() => navigate({ to: '/dashboard/settings', search: { tab: 'billing' } })}
                  className="font-medium underline hover:no-underline"
                >
                  Upgrade to Pro for unlimited products
                </button>
              )}
            </p>
          </div>
        </div>
      )}

      {cannotCreate && (
        <p className="mt-6 max-w-lg text-sm text-text-secondary">
          Only the workspace owner or an admin can add products.
        </p>
      )}

      <form onSubmit={handleSubmit} className={`mt-8 max-w-lg space-y-6 ${isAtLimit || cannotCreate ? 'pointer-events-none opacity-40' : ''}`}>
        {/* Name */}
        <div>
          <label htmlFor="name" className="block text-sm font-medium text-text-primary">
            Product Name
          </label>
          <input
            id="name"
            type="text"
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Pro Plan"
            className="mt-1 block w-full border border-control px-3 py-2 text-sm text-text-primary focus:border-brand focus:outline-none"
          />
        </div>

        {/* URL */}
        <div>
          <label htmlFor="url" className="block text-sm font-medium text-text-primary">
            Product URL
          </label>
          <input
            id="url"
            type="url"
            required
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://example.com/pricing"
            className="mt-1 block w-full border border-control px-3 py-2 text-sm text-text-primary focus:border-brand focus:outline-none"
          />
        </div>

        {/* Currency */}
        <div>
          <label className="block text-sm font-medium text-text-primary">
            Currency
          </label>
          <Select
            value={currency}
            onValueChange={(c) => {
              setCurrency(c)
              if (serverPriceError(createProduct.error)) createProduct.reset()
            }}
          >
            <SelectTrigger className="mt-1 w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {currencies.map((c) => (
                  <SelectItem key={c} value={c}>
                    {CURRENCY_SYMBOLS[c] ? `${c} (${CURRENCY_SYMBOLS[c]})` : c}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </div>

        {/* Base Price */}
        <div>
          <label htmlFor="basePrice" className="block text-sm font-medium text-text-primary">
            Base Price
          </label>
          <div className="relative mt-1">
            <span className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3 text-text-secondary">
              {CURRENCY_SYMBOLS[currency] ?? currency}
            </span>
            <input
              id="basePrice"
              type="number"
              required
              min={minorUnit}
              step={minorUnit}
              value={basePrice}
              onChange={(e) => {
                setBasePrice(e.target.value)
                // A server error about the old price no longer applies.
                if (serverPriceError(createProduct.error)) createProduct.reset()
              }}
              aria-invalid={priceError ? true : undefined}
              aria-describedby={priceError ? 'basePrice-error' : undefined}
              placeholder={(49).toFixed(exponent)}
              className="block w-full border border-control bg-bg py-2 pl-10 pr-3 font-mono text-sm tabular-nums text-text-primary placeholder:text-text-muted focus:border-brand focus:outline-none"
            />
          </div>
          {priceError && (
            <ErrorText id="basePrice-error" className="mt-1.5">
              {priceError}
            </ErrorText>
          )}
        </div>

        {/* Error */}
        {createProduct.error && !serverPriceError(createProduct.error) && (
          <ErrorText>
            {createProduct.error.message || 'Failed to create product.'}
          </ErrorText>
        )}

        {/* Actions */}
        <div className="flex items-center gap-3">
          <button
            type="submit"
            disabled={createProduct.isPending || cannotCreate}
            className="bg-brand px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-brand/90 disabled:opacity-50"
          >
            {createProduct.isPending ? 'Creating…' : 'Create product'}
          </button>
          <button
            type="button"
            onClick={() => navigate({ to: '/dashboard/products' })}
            className="border border-border px-4 py-2 text-sm font-medium text-text-primary transition-colors hover:bg-surface"
          >
            Cancel
          </button>
        </div>
      </form>
    </div>
  )
}
