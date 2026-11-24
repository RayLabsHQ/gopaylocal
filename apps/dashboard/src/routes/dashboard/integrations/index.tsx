import { useMemo, useState } from 'react'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { api, type Integration, type IntegrationEnvironment } from '~/lib/api'
import { getActiveTeamId, useSession } from '~/lib/auth'
import { useEnv } from '~/lib/env'
import { usePermissions } from '~/lib/permissions'
import type { IntegrationProvider } from '@gopaylocal/shared'
import { CURRENCY_SYMBOLS, providerHasTestMode } from '@gopaylocal/shared'
import { Dialog, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '~/components/ui/dialog'
import { PROVIDERS, providerLogo, providerName, type ProviderMeta } from '~/components/integrations/providers'
import { ConnectPanel, type ConnectTarget } from '~/components/integrations/connect-panel'
import { IntegrationCard, hasKey } from '~/components/integrations/integration-card'
import { btnPrimary, btnSecondary, LockIcon, LogoTile } from '~/components/integrations/parts'
import { ErrorText } from '~/components/ui/status'

export const Route = createFileRoute('/dashboard/integrations/')({
  component: IntegrationsPage,
})

type ImportTarget = { integrationId: string; environment: IntegrationEnvironment }

function SectionTitle({ id, children, count }: { id: string; children: React.ReactNode; count?: number }) {
  return (
    <div className="flex items-baseline gap-2.5">
      <h2 id={id} className="text-xs font-semibold uppercase tracking-[0.08em] text-text-secondary">
        {children}
      </h2>
      {count !== undefined && <span className="text-xs text-text-muted">{count}</span>}
    </div>
  )
}

function ProviderTile({
  provider,
  env,
  canManage,
  onConnect,
}: {
  provider: ProviderMeta
  env: IntegrationEnvironment
  canManage: boolean
  onConnect: () => void
}) {
  const liveOnly = env === 'test' && !providerHasTestMode(provider.id)
  return (
    <div className="flex items-center gap-3.5 border border-border bg-panel px-4 py-3.5">
      <LogoTile src={providerLogo(provider.id)} />
      <div className="min-w-0 flex-1">
        <p className="font-display text-[15px] font-semibold text-text-primary">{provider.name}</p>
        <p className="text-[13px] text-text-muted">{provider.summary}</p>
      </div>
      {canManage &&
        (liveOnly ? (
          <span className="text-[13px] text-text-muted" title={`${provider.name} has no test mode. Switch to Live to connect it.`}>
            Live only
          </span>
        ) : (
          <button type="button" onClick={onConnect} aria-label={`Connect ${provider.name}`} className={btnSecondary}>
            Connect
          </button>
        ))}
    </div>
  )
}

function IntegrationsPage() {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const { data: session } = useSession()
  const teamId = getActiveTeamId(session)
  const { env } = useEnv()
  const permissions = usePermissions()
  // Everyone sees what is connected; connecting, testing and disconnecting is
  // integrations.manage, importing is integrations.import (owner and admin).
  const canManage = permissions.can('integrations.manage')
  const canImport = permissions.can('integrations.import')

  const [connectTarget, setConnectTarget] = useState<ConnectTarget | null>(null)
  const [importTarget, setImportTarget] = useState<ImportTarget | null>(null)
  const [disconnectTarget, setDisconnectTarget] = useState<Integration | null>(null)
  const [testingId, setTestingId] = useState<string | null>(null)
  const [webhookPending, setWebhookPending] = useState<{ id: string; env: IntegrationEnvironment } | null>(null)
  const [selectedProducts, setSelectedProducts] = useState<Set<string>>(new Set())

  const integrationsQuery = useQuery({
    queryKey: ['integrations', teamId],
    queryFn: () => api.integrations.list(teamId),
    enabled: !!teamId,
  })
  const connected = useMemo(
    () => (integrationsQuery.data ?? []).filter((i) => i.status === 'active'),
    [integrationsQuery.data],
  )

  const { data: usage } = useQuery({
    queryKey: ['billing-usage', teamId],
    queryFn: () => api.billing.usage(teamId),
    enabled: !!teamId,
  })

  // "Used by N campaigns" and the "Next" step. Members see only some campaigns,
  // so the counts are shown to the roles that see them all.
  const { data: campaigns } = useQuery({
    queryKey: ['campaigns', teamId, 'all'],
    queryFn: () => api.campaigns.list(teamId),
    enabled: !!teamId && canManage && connected.length > 0,
  })
  const { data: products } = useQuery({
    queryKey: ['products', teamId, env],
    queryFn: () => api.products.list(teamId, env),
    enabled: !!teamId && canImport && connected.length > 0,
  })

  const disconnectMutation = useMutation({
    mutationFn: (integrationId: string) => api.integrations.disconnect(teamId, integrationId),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['integrations', teamId] })
      queryClient.invalidateQueries({ queryKey: ['campaigns', teamId] })
      const name = disconnectTarget ? providerName(disconnectTarget.provider) : 'Integration'
      setDisconnectTarget(null)
      const notes: string[] = []
      if (data.pausedCampaigns > 0) {
        notes.push(
          `${data.pausedCampaigns} auto-apply campaign${data.pausedCampaigns === 1 ? ' was' : 's were'} paused.`,
        )
      }
      if (data.codesLeftAtProvider > 0) {
        notes.push(
          `${data.codesLeftAtProvider} discount code${data.codesLeftAtProvider === 1 ? ' is' : 's are'} still active in ${name}; delete them there if you no longer want them honored.`,
        )
      }
      toast.success(`${name} disconnected`, notes.length ? { description: notes.join(' ') } : undefined)
    },
  })

  const webhookMutation = useMutation({
    mutationFn: ({ id, env: e }: { id: string; env: IntegrationEnvironment }) => api.integrations.setupWebhook(teamId, id, e),
    onMutate: (vars) => setWebhookPending(vars),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['integrations', teamId] })
      const name = providerName(data.provider)
      if (data.webhookSetup.status === 'active') {
        toast.success(`${name} redemption tracking set up`)
      } else if (data.webhookSetup.status === 'unsupported') {
        toast.info(`Automatic redemption tracking isn't available for ${name}`)
      } else {
        toast.error(`${name} redemption tracking isn't set up`, {
          description: data.webhookSetup.error || 'Check the key permissions and try again.',
        })
      }
    },
    onError: (err) => {
      toast.error("Couldn't set up redemption tracking", { description: err.message || 'Please try again.' })
    },
    onSettled: () => setWebhookPending(null),
  })

  // Tests every saved key: the card shows both environments.
  const testMutation = useMutation({
    mutationFn: async (integration: Integration) => {
      const envs = (['live', 'test'] as const).filter((e) => hasKey(integration, e))
      const results = await Promise.all(
        envs.map((e) =>
          api.integrations
            .test(teamId, integration.id, e)
            .catch((err: Error) => ({ ok: false, message: err.message || 'Connection test failed.' })),
        ),
      )
      return envs.map((e, i) => ({ env: e, ...results[i]! }))
    },
    onMutate: (integration) => setTestingId(integration.id),
    onSuccess: (results, integration) => {
      const name = providerName(integration.provider)
      for (const r of results) {
        if (r.ok) toast.success(`${name} ${r.env} key works`)
        else toast.error(`${name} ${r.env} key failed`, { description: r.message || 'Check the key and try again.' })
      }
      // A failure is recorded on the integration; a success clears it.
      queryClient.invalidateQueries({ queryKey: ['integrations', teamId] })
    },
    onSettled: () => setTestingId(null),
  })

  const importEnv = importTarget?.environment ?? env
  const { data: providerProducts = [], isFetching: isFetchingProducts } = useQuery({
    queryKey: ['providerProducts', teamId, importTarget?.integrationId, importEnv],
    queryFn: () => api.integrations.listProducts(teamId, importTarget!.integrationId, importEnv),
    enabled: !!teamId && !!importTarget,
  })

  const importMutation = useMutation({
    mutationFn: (productIds: string[]) =>
      api.integrations.importProducts(teamId, importTarget!.integrationId, productIds, importEnv),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['products', teamId] })
      queryClient.invalidateQueries({ queryKey: ['billing-usage', teamId] })
      const skipped = data.skipped?.length ?? 0
      const from = `From ${importingName} into your ${importEnv} environment.`
      toast.success(`${data.imported} product${data.imported === 1 ? '' : 's'} imported`, {
        description: skipped > 0 ? `${from} ${skipped} skipped: priced in an unsupported currency.` : from,
      })
      closeImportDialog()
    },
    onError: (err) => {
      if (err.message.includes('limit')) {
        toast.error('Product limit reached', { description: 'Upgrade to Pro for unlimited products.' })
      } else {
        toast.error('Import failed', { description: err.message || 'Failed to import products.' })
      }
    },
  })

  const openConnect = (provider: IntegrationProvider) =>
    setConnectTarget({ provider, environment: env, mode: 'connect', fromList: true, accountId: '' })

  // Test mode can use its own account (e.g. a sandbox company); without one it
  // uses the live account, so start from whichever applies.
  const openKey = (integration: Integration, e: IntegrationEnvironment) =>
    setConnectTarget({
      provider: integration.provider,
      environment: e,
      mode: hasKey(integration, e) ? 'replace' : 'add',
      fromList: false,
      accountId: (e === 'test' ? integration.testProviderAccountId : null) ?? integration.providerAccountId ?? '',
    })

  const closeImportDialog = () => {
    setImportTarget(null)
    setSelectedProducts(new Set())
    importMutation.reset()
  }

  const createCampaign = () => navigate({ to: '/dashboard/campaigns/new' })

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

  const importing = importTarget ? connected.find((i) => i.id === importTarget.integrationId) : undefined
  const importingName = importing ? providerName(importing.provider) : ''
  const unconnected = PROVIDERS.filter((p) => !connected.some((i) => i.provider === p.id))
  const disconnectName = disconnectTarget ? providerName(disconnectTarget.provider) : ''

  return (
    <div className="flex max-w-[1080px] flex-col gap-10">
      <header className="flex flex-col gap-1.5">
        <h1 className="font-display text-[32px] font-semibold tracking-tight text-text-primary">Integrations</h1>
        <p className="max-w-[640px] text-[15px] text-text-secondary">
          GoPayLocal creates each campaign's discount codes in the platform you sell with, and records when a customer
          uses one.
        </p>
      </header>

      {integrationsQuery.isPending ? (
        <div className="flex items-center justify-center py-12" role="status" aria-label="Loading integrations">
          <div className="h-6 w-6 animate-spin rounded-full border-4 border-border border-t-brand" />
        </div>
      ) : integrationsQuery.isError ? (
        // Without this, a failed load looked like nothing was connected.
        <div role="alert" className="flex flex-col gap-3 border border-border bg-panel px-6 py-5">
          <p className="font-display text-lg font-semibold text-text-primary">Couldn't load your integrations</p>
          <p className="text-sm text-text-secondary">
            {integrationsQuery.error.message || 'Something went wrong.'} Nothing has changed; try again.
          </p>
          <div>
            <button type="button" onClick={() => integrationsQuery.refetch()} className={btnSecondary}>
              {integrationsQuery.isFetching ? 'Loading…' : 'Try again'}
            </button>
          </div>
        </div>
      ) : connected.length === 0 ? (
        <>
          <section aria-labelledby="start-title" className="border border-border bg-panel">
            <div className="flex flex-col gap-1.5 border-b border-border px-6 py-5">
              <h2 id="start-title" className="font-display text-xl font-semibold text-text-primary">
                Connect the platform you sell with
              </h2>
              <p className="text-sm text-text-secondary">
                {canManage
                  ? 'Nothing is connected yet. You can add another platform or change keys later.'
                  : 'Nothing is connected yet. An owner or admin of this workspace can connect one.'}
              </p>
            </div>
            <ol className="grid gap-px bg-border md:grid-cols-3">
              {[
                ['Create a key', 'Each platform shows the exact permissions it needs, and nothing more.'],
                ['Paste it here', "It's encrypted before it's stored, and redemption tracking is set up for you."],
                ['Import your products', 'Then create a campaign, and its codes appear in your platform.'],
              ].map(([title, text], i) => (
                <li key={title} className="flex flex-col gap-1.5 bg-panel px-6 py-5">
                  <span className="font-mono text-xs text-brand-text">0{i + 1}</span>
                  <p className="font-semibold text-text-primary">{title}</p>
                  <p className="text-[13px] text-text-secondary">{text}</p>
                </li>
              ))}
            </ol>
          </section>

          <section aria-labelledby="choose-title" className="flex flex-col gap-4">
            <SectionTitle id="choose-title">Choose a platform</SectionTitle>
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {PROVIDERS.map((p) => (
                <ProviderTile key={p.id} provider={p} env={env} canManage={canManage} onConnect={() => openConnect(p.id)} />
              ))}
            </div>
          </section>
        </>
      ) : (
        <>
          <section aria-labelledby="connected-title" className="flex flex-col gap-4">
            <SectionTitle id="connected-title" count={connected.length}>
              Connected
            </SectionTitle>
            {connected.map((integration) => (
              <IntegrationCard
                key={integration.id}
                integration={integration}
                env={env}
                usedBy={campaigns ? campaigns.filter((c) => c.integrationId === integration.id).length : null}
                productsInEnv={products ? products.length : null}
                canManage={canManage}
                canImport={canImport}
                testing={testingId === integration.id}
                webhookPendingEnv={webhookPending?.id === integration.id ? webhookPending.env : null}
                actions={{
                  onTest: () => testMutation.mutate(integration),
                  onKey: (e) => openKey(integration, e),
                  onWebhook: (e) => webhookMutation.mutate({ id: integration.id, env: e }),
                  onImport: () => setImportTarget({ integrationId: integration.id, environment: env }),
                  onDisconnect: () => {
                    disconnectMutation.reset()
                    setDisconnectTarget(integration)
                  },
                  onCreateCampaign: createCampaign,
                }}
              />
            ))}
          </section>

          {unconnected.length > 0 && (
            <section aria-labelledby="add-title" className="flex flex-col gap-4">
              <div className="flex flex-col gap-1">
                <SectionTitle id="add-title">Add a platform</SectionTitle>
                <p className="text-[13px] text-text-muted">
                  You can connect more than one; each campaign uses one.
                </p>
              </div>
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {unconnected.map((p) => (
                  <ProviderTile key={p.id} provider={p} env={env} canManage={canManage} onConnect={() => openConnect(p.id)} />
                ))}
              </div>
            </section>
          )}
        </>
      )}

      <p className="flex items-start gap-2.5 text-[13px] text-text-muted">
        <LockIcon className="mt-0.5 h-4 w-4 flex-none" />
        <span>
          Keys are encrypted before they're stored and are never shown again, to you or anyone else.
          {canManage && connected.length > 0 && ' To change one, paste a new key from Manage.'}
        </span>
      </p>

      {connectTarget && (
        <ConnectPanel
          key={`${connectTarget.provider}-${connectTarget.environment}-${connectTarget.mode}`}
          teamId={teamId}
          target={connectTarget}
          canImport={canImport}
          onClose={() => setConnectTarget(null)}
          onImport={(integrationId, environment) => {
            setConnectTarget(null)
            setImportTarget({ integrationId, environment })
          }}
          onCreateCampaign={() => {
            setConnectTarget(null)
            createCampaign()
          }}
        />
      )}

      {/* Disconnect */}
      <Dialog open={disconnectTarget !== null} onOpenChange={(open) => !open && !disconnectMutation.isPending && setDisconnectTarget(null)}>
        <DialogHeader>
          <DialogTitle>Disconnect {disconnectName}?</DialogTitle>
          <DialogDescription>
            GoPayLocal deletes the saved keys and removes its redemption webhooks from {disconnectName}. Campaigns that use {disconnectName} are unlinked, and the active auto-apply ones are paused. Codes already
            created stay usable in {disconnectName} until you delete them there.
          </DialogDescription>
        </DialogHeader>
        {disconnectMutation.error && (
          <ErrorText>
            {disconnectMutation.error.message || "Couldn't disconnect. Try again."}
          </ErrorText>
        )}
        <DialogFooter>
          <button
            type="button"
            onClick={() => setDisconnectTarget(null)}
            disabled={disconnectMutation.isPending}
            className={btnSecondary}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => disconnectTarget && disconnectMutation.mutate(disconnectTarget.id)}
            disabled={disconnectMutation.isPending}
            className="inline-flex h-10 items-center justify-center bg-brand px-4 text-[13px] font-semibold text-white transition-colors hover:bg-brand/90 disabled:opacity-50"
          >
            {disconnectMutation.isPending ? 'Disconnecting…' : `Disconnect ${disconnectName}`}
          </button>
        </DialogFooter>
      </Dialog>

      {/* Import Products */}
      <Dialog open={importTarget !== null} onOpenChange={(open) => !open && closeImportDialog()} size="lg">
        <div className="space-y-5">
          <DialogHeader>
            <DialogTitle>Import from {importingName}</DialogTitle>
            <DialogDescription>
              Select the {importEnv} products to import into GoPayLocal.
            </DialogDescription>
          </DialogHeader>

          {usage && isAtLimit && (
            <div className="border border-warning-border bg-warning-light p-3">
              <p className="text-sm font-semibold text-warning">Product limit reached</p>
              <p className="mt-0.5 text-[13px] text-text-secondary">
                Your {usage.plan} plan allows {productsLabel(usage.maxProducts)}. You currently have {usage.currentCount}/{usage.maxProducts}.
              </p>
            </div>
          )}
          {usage && !isAtLimit && remaining < Infinity && remaining <= 3 && (
            <div className="border border-border bg-surface p-3">
              <p className="text-sm font-semibold text-text-primary">{remaining} product slot{remaining === 1 ? '' : 's'} remaining</p>
              <p className="mt-0.5 text-[13px] text-text-secondary">
                Your {usage.plan} plan allows {productsLabel(usage.maxProducts)}. You have {usage.currentCount}/{usage.maxProducts} used.
              </p>
            </div>
          )}

          {isFetchingProducts ? (
            <div className="flex items-center justify-center py-12" role="status" aria-label="Loading products">
              <div className="h-6 w-6 animate-spin rounded-full border-4 border-border border-t-brand" />
            </div>
          ) : providerProducts.length === 0 ? (
            <div className="px-6 py-12 text-center">
              <p className="text-base font-medium text-text-primary">No products found</p>
              <p className="mx-auto mt-1.5 max-w-sm text-sm text-text-secondary">
                {importingName} returned no products for your {importEnv} environment. Create a product there first, or
                switch environments in the sidebar.
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
                  <span className="text-[13px] tabular-nums text-text-secondary">{selectedProducts.size} selected</span>
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
                        <p className="truncate text-sm font-medium text-text-primary">{product.name}</p>
                        {product.url && <p className="truncate text-[13px] text-text-secondary">{product.url}</p>}
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

          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-5">
            {usage && canUpgrade && remaining < Infinity ? (
              <button
                type="button"
                onClick={() => {
                  closeImportDialog()
                  navigate({ to: '/dashboard/settings', search: { tab: 'billing' } })
                }}
                className="text-[13px] font-medium text-warning underline-offset-2 hover:underline"
              >
                {isAtLimit ? 'Upgrade to import' : 'Need more? Upgrade'}
              </button>
            ) : (
              <div />
            )}
            <div className="flex gap-2.5">
              <button type="button" onClick={closeImportDialog} className={btnSecondary}>
                Cancel
              </button>
              {!isAtLimit && (
                <button
                  type="button"
                  onClick={() => importMutation.mutate([...selectedProducts])}
                  disabled={selectedProducts.size === 0 || importMutation.isPending}
                  className={btnPrimary}
                >
                  {importMutation.isPending
                    ? 'Importing…'
                    : `Import ${selectedProducts.size || ''} product${selectedProducts.size === 1 ? '' : 's'}`}
                </button>
              )}
            </div>
          </div>
        </div>
      </Dialog>
    </div>
  )
}
