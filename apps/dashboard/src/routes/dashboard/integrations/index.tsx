import { useState } from 'react'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  api,
  type Integration,
  type IntegrationEnvironment,
  type IntegrationHealthIssue,
  type ProviderProduct,
} from '~/lib/api'
import { getActiveTeamId, useSession } from '~/lib/auth'
import { useEnv } from '~/lib/env'
import { usePermissions } from '~/lib/permissions'
import type { IntegrationProvider } from '@gopaylocal/shared'
import { CURRENCY_SYMBOLS, PROVIDER_KEY_ACCESS, providerCanImportProducts, providerHasTestMode } from '@gopaylocal/shared'
import {
  Dialog,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '~/components/ui/dialog'

export const Route = createFileRoute('/dashboard/integrations/')({
  component: IntegrationsPage,
})

// Providers whose API needs an account identifier besides the key. Must match
// PROVIDERS_REQUIRING_ACCOUNT_ID in @gopaylocal/shared/validation, which also
// normalizes what is typed here (e.g. a pasted Chargebee URL).
type AccountIdField = { label: string; placeholder: string; help: string }

const PROVIDERS: {
  id: IntegrationProvider
  name: string
  description: string
  placeholder: { live: string; test: string }
  docsUrl: string
  accountId?: AccountIdField
}[] = [
  {
    id: 'stripe',
    name: 'Stripe',
    description: 'Creates PPP promotion codes in Stripe and records their redemptions.',
    placeholder: { live: 'rk_live_...', test: 'rk_test_...' },
    docsUrl: 'https://docs.stripe.com/keys/restricted-api-keys',
  },
  {
    id: 'paddle',
    name: 'Paddle',
    description: 'Creates PPP discount codes in Paddle and records their redemptions.',
    placeholder: { live: 'pdl_live_apikey_...', test: 'pdl_sdbx_apikey_...' },
    docsUrl: 'https://developer.paddle.com/api-reference/about/api-keys',
  },
  {
    id: 'gumroad',
    name: 'Gumroad',
    description: 'Creates PPP offer codes on your Gumroad products and records their redemptions.',
    placeholder: { live: 'xxxxxxxx-xxxx-xxxx-xxxx...', test: 'xxxxxxxx-xxxx-xxxx-xxxx...' },
    docsUrl: 'https://gumroad.com/api',
  },
  {
    id: 'dodopayments',
    name: 'Dodo Payments',
    description: 'Creates PPP discount codes in Dodo Payments and records their redemptions.',
    placeholder: { live: 'dodo_live_...', test: 'dodo_test_...' },
    docsUrl: 'https://docs.dodopayments.com/api-reference/introduction',
  },
  {
    id: 'chargebee',
    name: 'Chargebee',
    description: 'Creates PPP coupons in Chargebee and records their redemptions.',
    placeholder: { live: 'live_...', test: 'test_...' },
    docsUrl: 'https://www.chargebee.com/docs/billing/2.0/site-configuration/api_keys',
    accountId: {
      label: 'Site name',
      placeholder: 'acme',
      help: 'The name in {site}.chargebee.com. Use the same name for test mode; GoPayLocal adds -test itself.',
    },
  },
  {
    id: 'whop',
    name: 'Whop',
    description: 'Creates PPP promo codes in Whop and records their redemptions.',
    placeholder: { live: 'whop_...', test: 'whop_...' },
    docsUrl: 'https://docs.whop.com/api-reference/overview',
    accountId: {
      label: 'Whop account ID',
      placeholder: 'biz_...',
      help: 'The ID of your Whop account. It starts with biz_.',
    },
  },
  {
    id: 'polar',
    name: 'Polar',
    description: 'Creates PPP discount codes in Polar and records their redemptions.',
    placeholder: { live: 'polar_oat_...', test: 'polar_oat_...' },
    docsUrl: 'https://polar.sh/docs/integrate/oat',
  },
  {
    id: 'creem',
    name: 'Creem',
    description: 'Creates PPP discount codes on your Creem products and records their redemptions.',
    placeholder: { live: 'creem_...', test: 'creem_test_...' },
    docsUrl: 'https://docs.creem.io/api-reference/introduction',
  },
  {
    id: 'woocommerce',
    name: 'WooCommerce',
    description: 'Creates PPP coupons in your own WooCommerce store, entered by customers at cart or checkout, and records their redemptions.',
    // No test mode (PROVIDERS_WITHOUT_TEST_MODE): in Test the card shows "Live only".
    placeholder: { live: 'ck_...:cs_...', test: 'ck_...:cs_...' },
    docsUrl: 'https://developer.woocommerce.com/docs/apis/rest-api/#generate-keys',
    accountId: {
      label: 'Store URL',
      placeholder: 'https://shop.example.com',
      help: "Your store's https:// address. Paste the key as ck_...:cs_... (consumer key, a colon, consumer secret). WooCommerce has no test mode, so connect it in Live.",
    },
  },
]

const HEALTH_AREA_LABELS: Record<IntegrationHealthIssue['area'], string> = {
  coupon_sync: 'Discount codes',
  webhook_setup: 'Redemption tracking',
  webhook_delivery: 'Redemption tracking',
  credentials: 'API key',
}

/** "Redemption tracking" line on a connected card. */
function WebhookStatusLine({
  integration,
  environment,
  onSetup,
  pending,
}: {
  integration: Integration
  /** The environment selected in the dashboard; each one has its own webhook. */
  environment: IntegrationEnvironment
  /** Omitted for roles without integrations.manage: the status shows, the button doesn't. */
  onSetup?: () => void
  pending: boolean
}) {
  // Optional chaining: an API deployed before these fields existed omits them.
  const status = integration.webhooks?.[environment]?.status
  if (!status) return null
  const label =
    status === 'active'
      ? `Tracking ${environment} redemptions`
      : status === 'needs_attention'
        ? 'Redemption tracking needs attention'
        : 'Redemption tracking not set up'
  const tone = status === 'active' ? 'text-text-secondary' : 'text-amber-400'
  // Deliveries failing verification (or a provider that disabled the endpoint)
  // are fixed by re-creating it, so offer that even when it looks active.
  const deliveryTrouble = (integration.health ?? []).some(
    (h) => h.area === 'webhook_delivery' && (h.environment ?? environment) === environment,
  )
  return (
    <div className="mt-2 flex items-center justify-between gap-2">
      <span className={`text-xs font-medium ${tone}`}>{label}</span>
      {onSetup && (status !== 'active' || deliveryTrouble) && (
        <button
          type="button"
          onClick={onSetup}
          disabled={pending}
          className="border border-border px-2 py-0.5 text-xs font-medium text-text-primary transition-colors hover:bg-surface disabled:opacity-50"
        >
          {pending ? 'Setting up...' : status === 'missing' ? 'Set up' : 'Re-create'}
        </button>
      )}
    </div>
  )
}

function IntegrationsPage() {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const { data: session } = useSession()
  const teamId = getActiveTeamId(session)
  const { env } = useEnv()
  // Everyone sees what is connected; connecting, testing, importing and
  // disconnecting is integrations.manage (owner and admin).
  const canManage = usePermissions().can('integrations.manage')

  const [connectProvider, setConnectProvider] = useState<IntegrationProvider | null>(null)
  const [apiKey, setApiKey] = useState('')
  const [accountId, setAccountId] = useState('')
  const [testingId, setTestingId] = useState<string | null>(null)
  const [webhookSetupId, setWebhookSetupId] = useState<string | null>(null)
  const [confirmDisconnectId, setConfirmDisconnectId] = useState<string | null>(null)
  const [importIntegrationId, setImportIntegrationId] = useState<string | null>(null)
  const [selectedProducts, setSelectedProducts] = useState<Set<string>>(new Set())

  const { data: integrations = [], isPending } = useQuery({
    queryKey: ['integrations', teamId],
    queryFn: () => api.integrations.list(teamId),
    enabled: !!teamId,
  })

  const { data: usage } = useQuery({
    queryKey: ['billing-usage', teamId],
    queryFn: () => api.billing.usage(teamId),
    enabled: !!teamId,
  })

  const connectMutation = useMutation({
    mutationFn: ({
      provider,
      accessToken,
      providerAccountId,
    }: {
      provider: IntegrationProvider
      accessToken: string
      providerAccountId?: string
    }) =>
      api.integrations.connect(teamId, provider, {
        accessToken,
        providerAccountId,
        environment: env,
      }),
    onSuccess: (data) => {
      const label = PROVIDERS.find((p) => p.id === connectProvider)?.name ?? connectProvider
      queryClient.invalidateQueries({ queryKey: ['integrations', teamId] })
      closeDialog()
      if (data.webhookSetup?.status === 'failed') {
        // The key is saved, but without the webhook no redemption is counted.
        toast.warning(`${label} connected, but redemption tracking isn't set up`, {
          description: data.webhookSetup.error || 'Use "Set up" on the integration card to try again.',
        })
        return
      }
      toast.success(`${label} connected`, {
        description: `${env === 'live' ? 'Live' : 'Test'} API connection saved successfully.`,
      })
    },
    onError: (err) => {
      toast.error('Connection failed', {
        description: err.message || 'Check your credentials and try again.',
      })
    },
  })

  const disconnectMutation = useMutation({
    mutationFn: (integrationId: string) =>
      api.integrations.disconnect(teamId, integrationId),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['integrations', teamId] })
      queryClient.invalidateQueries({ queryKey: ['campaigns', teamId] })
      setConfirmDisconnectId(null)
      const notes: string[] = []
      if (data.pausedCampaigns > 0) {
        notes.push(
          `${data.pausedCampaigns} auto-apply campaign${data.pausedCampaigns === 1 ? ' was' : 's were'} paused.`,
        )
      }
      if (data.codesLeftAtProvider > 0) {
        notes.push(
          `${data.codesLeftAtProvider} discount code${data.codesLeftAtProvider === 1 ? ' is' : 's are'} still active at the provider; delete them there if you no longer want them honored.`,
        )
      }
      toast.success('Integration disconnected', notes.length ? { description: notes.join(' ') } : undefined)
    },
    onError: (err) => {
      toast.error('Failed to disconnect', {
        description: err.message || 'Please try again.',
      })
    },
  })

  const webhookMutation = useMutation({
    mutationFn: (integrationId: string) => api.integrations.setupWebhook(teamId, integrationId, env),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['integrations', teamId] })
      const label = PROVIDERS.find((p) => p.id === data.provider)?.name ?? data.provider
      if (data.webhookSetup.status === 'active') {
        toast.success(`${label} redemption tracking set up`)
      } else if (data.webhookSetup.status === 'unsupported') {
        toast.info(`Automatic redemption tracking isn't available for ${label}`)
      } else {
        toast.error(`${label} redemption tracking isn't set up`, {
          description: data.webhookSetup.error || 'Check the API key permissions and try again.',
        })
      }
    },
    onError: (err) => {
      toast.error("Couldn't set up redemption tracking", {
        description: err.message || 'Please try again.',
      })
    },
    onSettled: () => {
      setWebhookSetupId(null)
    },
  })

  const testMutation = useMutation({
    mutationFn: (integrationId: string) => api.integrations.test(teamId, integrationId, env),
    onSuccess: (data, integrationId) => {
      const integration = integrations.find((i) => i.id === integrationId)
      const label = integration ? PROVIDERS.find((p) => p.id === integration.provider)?.name ?? integration.provider : 'Integration'
      if (data.ok) {
        toast.success(`${label} verified`, {
          description: `${env === 'live' ? 'Live' : 'Test'} API connection verified successfully.`,
        })
      } else {
        toast.error(`${label} test failed`, {
          description: data.message || 'Authentication failed — check your API key.',
        })
      }
    },
    onError: (_err, integrationId) => {
      const integration = integrations.find((i) => i.id === integrationId)
      const label = integration ? PROVIDERS.find((p) => p.id === integration.provider)?.name ?? integration.provider : 'Integration'
      toast.error(`${label} test failed`, {
        description: 'Connection test failed.',
      })
    },
    onSettled: () => {
      setTestingId(null)
    },
  })

  const { data: providerProducts = [], isFetching: isFetchingProducts } = useQuery({
    queryKey: ['providerProducts', teamId, importIntegrationId, env],
    queryFn: () => api.integrations.listProducts(teamId, importIntegrationId!, env),
    enabled: !!teamId && !!importIntegrationId,
  })

  const importMutation = useMutation({
    mutationFn: (productIds: string[]) =>
      api.integrations.importProducts(teamId, importIntegrationId!, productIds, env),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['products', teamId] })
      queryClient.invalidateQueries({ queryKey: ['billing-usage', teamId] })
      const skipped = data.skipped?.length ?? 0
      const from = `From ${importingProviderLabel} into your ${env} environment.`
      toast.success(`${data.imported} product${data.imported === 1 ? '' : 's'} imported`, {
        description: skipped > 0 ? `${from} ${skipped} skipped: priced in an unsupported currency.` : from,
      })
      closeImportDialog()
    },
    onError: (err) => {
      if (err.message.includes('limit')) {
        toast.error('Product limit reached', {
          description: 'Upgrade to Pro for unlimited products.',
        })
      } else {
        toast.error('Import failed', {
          description: err.message || 'Failed to import products.',
        })
      }
    },
  })

  const getIntegration = (provider: IntegrationProvider): Integration | undefined =>
    integrations.find((i) => i.provider === provider)

  const closeDialog = () => {
    setConnectProvider(null)
    setApiKey('')
    setAccountId('')
    connectMutation.reset()
  }

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!connectProvider || !apiKey.trim()) return
    connectMutation.mutate({
      provider: connectProvider,
      accessToken: apiKey.trim(),
      providerAccountId: accountId.trim() || undefined,
    })
  }

  const handleTest = (integrationId: string) => {
    setTestingId(integrationId)
    testMutation.mutate(integrationId)
  }

  const handleWebhookSetup = (integrationId: string) => {
    setWebhookSetupId(integrationId)
    webhookMutation.mutate(integrationId)
  }

  // Test mode can use its own account (e.g. a sandbox company); without one
  // it uses the live account, so start from whichever applies.
  const openConnect = (provider: IntegrationProvider) => {
    const existing = getIntegration(provider)
    setAccountId(
      (env === 'test' ? existing?.testProviderAccountId : null) ?? existing?.providerAccountId ?? '',
    )
    setConnectProvider(provider)
  }

  const closeImportDialog = () => {
    setImportIntegrationId(null)
    setSelectedProducts(new Set())
    importMutation.reset()
  }

  // remaining is null when unlimited (Pro, self-hosted); Infinity keeps the
  // selection math below simple and is never serialized.
  const remaining = usage?.remaining ?? Infinity
  const isAtLimit = remaining <= 0
  const canUpgrade = usage?.billingEnabled !== false && usage?.selfHosted !== true
  const productsLabel = (n: number | null) => `${n} product${n === 1 ? '' : 's'}`

  const toggleProduct = (id: string) => {
    setSelectedProducts((prev) => {
      const next = new Set(prev)
      if (next.has(id)) {
        next.delete(id)
      } else if (next.size < remaining) {
        next.add(id)
      }
      return next
    })
  }

  const toggleAll = () => {
    if (selectedProducts.size === providerProducts.length || selectedProducts.size >= remaining) {
      setSelectedProducts(new Set())
    } else {
      const ids = providerProducts.map((p) => p.providerProductId).slice(0, remaining)
      setSelectedProducts(new Set(ids))
    }
  }

  const importingProvider = importIntegrationId
    ? integrations.find((i) => i.id === importIntegrationId)
    : null
  const importingProviderLabel = importingProvider
    ? PROVIDERS.find((p) => p.id === importingProvider.provider)?.name ?? importingProvider.provider
    : ''

  const connectProviderMeta = PROVIDERS.find((p) => p.id === connectProvider)
  const providerLabel = connectProviderMeta?.name ?? connectProvider
  const accountIdField = connectProviderMeta?.accountId
  const keyAccess = connectProvider ? PROVIDER_KEY_ACCESS[connectProvider] : undefined

  return (
    <div>
      <div>
        <h1 className="font-display text-4xl font-medium tracking-tight text-text-primary">
          Integrations
        </h1>
        <p className="mt-1 text-base text-text-secondary">
          Connect your payment platforms to enable PPP discounts
        </p>
      </div>

      {isPending ? (
        <div className="mt-8 flex items-center justify-center">
          <div className="h-6 w-6 animate-spin rounded-full border-4 border-border border-t-brand" />
        </div>
      ) : (
        <div className="mt-8 grid grid-cols-1 gap-5 md:grid-cols-2 lg:grid-cols-3">
          {PROVIDERS.map((provider) => {
            const integration = getIntegration(provider.id)
            const isConnected = integration?.status === 'active'
            const hasCurrentEnvCreds = isConnected && (env === 'test' ? integration.hasTestCredentials : integration.hasLiveCredentials)

            return (
              <div
                key={provider.id}
                className="flex flex-col border border-border p-6"
              >
                <div className="flex items-start justify-between">
                  <img
                    src={`/logos/${provider.id}.svg`}
                    alt={provider.name}
                    className="h-10 w-10 shrink-0 object-contain"
                  />
                  {!canManage ? null : hasCurrentEnvCreds ? (
                    <div className="flex gap-2">
                      {/* Chargebee, Whop and Polar can't list products (the API answers 400). */}
                      {providerCanImportProducts(provider.id) && (
                        <button
                          type="button"
                          onClick={() => integration && setImportIntegrationId(integration.id)}
                          className="border border-border px-3 py-1 text-[13px] font-medium text-text-primary transition-colors hover:bg-surface"
                        >
                          Import
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => integration && handleTest(integration.id)}
                        disabled={testingId === integration?.id}
                        className="border border-border px-3 py-1 text-[13px] font-medium text-text-primary transition-colors hover:bg-surface disabled:opacity-50"
                      >
                        {testingId === integration?.id ? 'Testing...' : 'Test'}
                      </button>
                      <button
                        type="button"
                        onClick={() => openConnect(provider.id)}
                        className="border border-success/40 bg-success/15 px-3 py-1 text-[13px] font-medium text-success transition-colors hover:bg-success/25"
                      >
                        Connected
                      </button>
                    </div>
                  ) : env === 'test' && !providerHasTestMode(provider.id) ? (
                    // No test environment at this provider; the API refuses test keys too.
                    <span
                      className="px-3 py-1 text-[13px] font-medium text-text-muted"
                      title={`${provider.name} has no test mode. Switch to Live to connect it.`}
                    >
                      Live only
                    </span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => openConnect(provider.id)}
                      className="border border-border px-3 py-1 text-[13px] font-medium text-text-primary transition-colors hover:bg-surface"
                    >
                      {isConnected ? `Add ${env} key` : 'Connect'}
                    </button>
                  )}
                </div>

                <h3 className="mt-4 font-display text-base font-semibold text-text-primary">
                  {provider.name}
                </h3>
                <p className="mt-1.5 text-sm leading-relaxed text-text-secondary">
                  {provider.description}
                </p>

                {hasCurrentEnvCreds && (
                  <div className="mt-3">
                    <span className={`inline-flex items-center gap-1.5 text-xs font-medium ${env === 'test' ? 'text-amber-400' : 'text-success'}`}>
                      <span className={`h-1.5 w-1.5 rounded-full ${env === 'test' ? 'bg-amber-400' : 'bg-success'}`} />
                      {env === 'test' ? 'Test' : 'Live'} connected
                    </span>
                  </div>
                )}

                {isConnected && integration && (
                  <WebhookStatusLine
                    integration={integration}
                    environment={env}
                    onSetup={canManage ? () => handleWebhookSetup(integration.id) : undefined}
                    pending={webhookSetupId === integration.id}
                  />
                )}

                {isConnected && integration && (integration.health?.length ?? 0) > 0 && (
                  <ul className="mt-3 space-y-1.5 border-l-2 border-amber-400 pl-3">
                    {integration.health.map((issue) => (
                      <li key={issue.area} className="text-xs leading-relaxed text-text-secondary">
                        <span className="font-medium text-amber-400">
                          {HEALTH_AREA_LABELS[issue.area]}
                          {issue.environment ? ` (${issue.environment})` : ''}:
                        </span>{' '}
                        {issue.message}{' '}
                        <span className="text-text-muted">{new Date(issue.at).toLocaleString()}</span>
                      </li>
                    ))}
                  </ul>
                )}

                {/* Disconnect (with inline confirm) — removes all credentials
                    for this provider. Only shown once connected. */}
                {canManage && isConnected && integration && (
                  <div className="mt-auto border-t border-border pt-3 text-right">
                    {confirmDisconnectId === integration.id ? (
                      <div className="flex items-center justify-end gap-2">
                        <span className="mr-auto text-[13px] text-text-secondary">
                          Disconnect {provider.name}? Removes test + live credentials and unlinks its campaigns.
                        </span>
                        <button
                          type="button"
                          onClick={() => disconnectMutation.mutate(integration.id)}
                          disabled={disconnectMutation.isPending}
                          className="bg-red-600 px-2.5 py-1 text-[13px] font-medium text-white transition-colors hover:bg-red-700 disabled:opacity-50"
                        >
                          {disconnectMutation.isPending ? 'Removing...' : 'Confirm'}
                        </button>
                        <button
                          type="button"
                          onClick={() => setConfirmDisconnectId(null)}
                          disabled={disconnectMutation.isPending}
                          className="border border-border px-2.5 py-1 text-[13px] font-medium text-text-primary transition-colors hover:bg-surface disabled:opacity-50"
                        >
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setConfirmDisconnectId(integration.id)}
                        className="text-[13px] font-medium text-red-400 transition-colors hover:text-red-300"
                      >
                        Disconnect
                      </button>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {/* Connect Dialog */}
      <Dialog open={connectProvider !== null} onOpenChange={(open) => !open && closeDialog()}>
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>Connect {providerLabel}</DialogTitle>
            <DialogDescription>
              Enter your API key to connect {providerLabel} with GoPayLocal.
              {connectProviderMeta?.docsUrl && (
                <>
                  {' '}
                  <a
                    href={connectProviderMeta.docsUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 font-medium text-brand-text underline underline-offset-2 hover:no-underline"
                  >
                    Learn how to get your API key
                    <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 6H5.25A2.25 2.25 0 0 0 3 8.25v10.5A2.25 2.25 0 0 0 5.25 21h10.5A2.25 2.25 0 0 0 18 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25" />
                    </svg>
                  </a>
                </>
              )}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            {keyAccess && (
              <section aria-labelledby="key-access-title" className="border border-border bg-surface px-3 py-2.5">
                <h3 id="key-access-title" className="text-xs font-semibold uppercase tracking-wide text-text-secondary">
                  What the key needs
                </h3>
                <p className="mt-1 text-[13px] text-text-primary">{keyAccess.key}</p>
                <ul className="mt-2 space-y-1.5">
                  {keyAccess.permissions.map((permission) => (
                    <li key={permission.name} className="text-[13px] leading-snug">
                      <code className="font-mono text-[12px] font-medium text-text-primary">{permission.name}</code>
                      <span className="block text-text-secondary">{permission.usedFor}</span>
                    </li>
                  ))}
                </ul>
                {keyAccess.note && (
                  <p className="mt-2 text-xs text-text-secondary">{keyAccess.note}</p>
                )}
              </section>
            )}

            <div>
              <label
                htmlFor="api-key"
                className="mb-1 block text-sm font-medium text-text-primary"
              >
                API Key <span className="text-brand-text">*</span>
              </label>
              <input
                id="api-key"
                type="password"
                required
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={connectProviderMeta?.placeholder[env] ?? 'Enter API key...'}
                className="w-full border border-border bg-bg px-3 py-2 text-sm text-text-primary placeholder:text-text-muted focus:border-brand focus:outline-none"
              />
            </div>

            {accountIdField && (
              <div>
                <label
                  htmlFor="account-id"
                  className="mb-1 block text-sm font-medium text-text-primary"
                >
                  {accountIdField.label} <span className="text-brand-text">*</span>
                </label>
                <input
                  id="account-id"
                  type="text"
                  required
                  value={accountId}
                  onChange={(e) => setAccountId(e.target.value)}
                  placeholder={accountIdField.placeholder}
                  aria-describedby="account-id-help"
                  className="w-full border border-border bg-bg px-3 py-2 text-sm text-text-primary placeholder:text-text-muted focus:border-brand focus:outline-none"
                />
                <p id="account-id-help" className="mt-1 text-xs text-text-secondary">
                  {accountIdField.help}
                </p>
              </div>
            )}

            <p className="text-[13px] text-text-secondary">
              Credentials will be saved for <span className={env === 'test' ? 'font-medium text-amber-400' : 'font-medium text-success'}>{env}</span> mode.
              {' '}GoPayLocal encrypts the key before storing it and never shows it again.
            </p>

            {connectMutation.error && (
              <p className="text-[13px] text-brand-text">
                {connectMutation.error.message || 'Failed to connect. Check your credentials and try again.'}
              </p>
            )}
          </div>

          <DialogFooter>
            <button
              type="button"
              onClick={closeDialog}
              className="border border-border px-4 py-2 text-sm font-medium text-text-primary transition-colors hover:bg-surface"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={connectMutation.isPending || !apiKey.trim()}
              className="bg-brand px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-brand/90 disabled:opacity-50"
            >
              {connectMutation.isPending ? 'Connecting...' : 'Connect'}
            </button>
          </DialogFooter>
        </form>
      </Dialog>

      {/* Import Products Dialog */}
      <Dialog open={importIntegrationId !== null} onOpenChange={(open) => !open && closeImportDialog()} size="lg">
        <div className="space-y-5">
          <DialogHeader>
            <DialogTitle>Import from {importingProviderLabel}</DialogTitle>
            <DialogDescription>
              Select products to import into GoPayLocal.
            </DialogDescription>
          </DialogHeader>

          {/* Limit warning/info banner */}
          {usage && isAtLimit && (
            <div className="flex items-center gap-3 rounded border border-amber-800 bg-amber-950/50 p-3">
              <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-amber-900">
                <svg className="h-4 w-4 text-amber-400" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z" />
                </svg>
              </div>
              <div>
                <p className="text-sm font-semibold text-amber-200">Product limit reached</p>
                <p className="mt-0.5 text-[13px] text-amber-300">
                  Your {usage.plan} plan allows {productsLabel(usage.maxProducts)}. You currently have {usage.currentCount}/{usage.maxProducts}.
                </p>
              </div>
            </div>
          )}
          {usage && !isAtLimit && remaining < Infinity && remaining <= 3 && (
            <div className="flex items-center gap-3 rounded border border-blue-800 bg-blue-950/50 p-3">
              <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-blue-900">
                <svg className="h-4 w-4 text-blue-400" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" d="m11.25 11.25.041-.02a.75.75 0 0 1 1.063.852l-.708 2.836a.75.75 0 0 0 1.063.853l.041-.021M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-9-3.75h.008v.008H12V8.25Z" />
                </svg>
              </div>
              <div>
                <p className="text-sm font-semibold text-blue-200">{remaining} product slot{remaining === 1 ? '' : 's'} remaining</p>
                <p className="mt-0.5 text-[13px] text-blue-300">
                  Your {usage.plan} plan allows {productsLabel(usage.maxProducts)}. You have {usage.currentCount}/{usage.maxProducts} used.
                </p>
              </div>
            </div>
          )}

          {/* Product list */}
          {isFetchingProducts ? (
            <div className="flex items-center justify-center py-12">
              <div className="h-6 w-6 animate-spin rounded-full border-4 border-border border-t-brand" />
            </div>
          ) : providerProducts.length === 0 ? (
            <div className="px-6 py-12 text-center">
              <p className="text-base font-medium text-text-primary">No products found</p>
              <p className="mx-auto mt-1.5 max-w-sm text-sm text-text-secondary">
                {importingProviderLabel} returned no products for your {env} environment. Create a
                product there first, or switch environments in the sidebar.
              </p>
            </div>
          ) : (
            <div className={isAtLimit ? 'pointer-events-none opacity-40' : ''}>
              <div className="mb-3 flex items-center justify-between">
                <label className="flex items-center gap-2 text-sm text-text-secondary">
                  <input
                    type="checkbox"
                    checked={selectedProducts.size > 0 && (selectedProducts.size === providerProducts.length || selectedProducts.size >= remaining)}
                    onChange={toggleAll}
                    className="accent-brand"
                  />
                  {remaining < providerProducts.length
                    ? `Select up to ${remaining} product${remaining === 1 ? '' : 's'}`
                    : `Select all (${providerProducts.length})`}
                </label>
                {selectedProducts.size > 0 && (
                  <span className="text-[13px] tabular-nums text-text-secondary">
                    {selectedProducts.size} selected
                  </span>
                )}
              </div>

              <div className="max-h-72 overflow-y-auto border border-border">
                {providerProducts.map((product) => {
                  const isSelected = selectedProducts.has(product.providerProductId)
                  const isDisabled = !isSelected && selectedProducts.size >= remaining

                  return (
                    <label
                      key={product.providerProductId}
                      className={`flex items-center gap-3 border-b border-border px-4 py-3 last:border-b-0 ${
                        isDisabled ? 'cursor-not-allowed opacity-35' : 'cursor-pointer hover:bg-surface'
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={isSelected}
                        disabled={isDisabled}
                        onChange={() => toggleProduct(product.providerProductId)}
                        className="shrink-0 accent-brand"
                      />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium text-text-primary">
                          {product.name}
                        </p>
                        {product.url && (
                          <p className="truncate text-[13px] text-text-secondary">{product.url}</p>
                        )}
                      </div>
                      {product.price != null && (
                        <span className="shrink-0 font-mono text-sm font-medium tabular-nums text-text-primary">
                          {CURRENCY_SYMBOLS[product.currency ?? 'USD'] ?? product.currency}
                          {product.price.toFixed(2)}
                        </span>
                      )}
                    </label>
                  )
                })}
              </div>
            </div>
          )}

          {/* Footer */}
          <div className="flex items-center justify-between border-t border-border pt-5">
            {usage && canUpgrade && remaining < Infinity ? (
              <button
                type="button"
                onClick={() => navigate({ to: '/dashboard/settings', search: { tab: 'billing' } })}
                className="flex items-center gap-1.5 text-[13px] font-medium text-amber-300 transition-colors hover:text-amber-100"
              >
                <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" d="m3.75 13.5 10.5-11.25L12 10.5h8.25L9.75 21.75 12 13.5H3.75Z" />
                </svg>
                {isAtLimit ? 'Upgrade to import' : 'Need more? Upgrade'}
              </button>
            ) : (
              <div />
            )}
            <div className="flex gap-3">
              <button
                type="button"
                onClick={closeImportDialog}
                className="border border-border px-4 py-2 text-sm font-medium text-text-primary transition-colors hover:bg-surface"
              >
                Cancel
              </button>
              {!isAtLimit && (
                <button
                  type="button"
                  onClick={() => importMutation.mutate([...selectedProducts])}
                  disabled={selectedProducts.size === 0 || importMutation.isPending}
                  className="bg-brand px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-brand/90 disabled:opacity-50"
                >
                  {importMutation.isPending
                    ? 'Importing...'
                    : `Import ${selectedProducts.size || ''} product${selectedProducts.size === 1 ? '' : 's'}`}
                </button>
              )}
              {isAtLimit && canUpgrade && (
                <button
                  type="button"
                  onClick={() => {
                    closeImportDialog()
                    navigate({ to: '/dashboard/settings', search: { tab: 'billing' } })
                  }}
                  className="bg-amber-500 px-4 py-2 text-sm font-medium text-inverted-text transition-colors hover:bg-amber-400"
                >
                  Upgrade Plan
                </button>
              )}
            </div>
          </div>
        </div>
      </Dialog>
    </div>
  )
}
