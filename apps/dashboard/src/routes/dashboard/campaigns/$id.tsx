import { createFileRoute, useParams, useNavigate, Link } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { toast } from 'sonner'
import { api, PROVIDER_LABELS, PRICING_MODE_LABELS, DISCOUNT_DELIVERY_LABELS, type Campaign } from '~/lib/api'
import { formatPrice } from '~/lib/format'
import { getActiveTeamId, useSession } from '~/lib/auth'
import { usePermissions } from '~/lib/permissions'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '~/components/ui/select'
import { BannerEditor } from '~/components/banner-editor'
import { HolidayDeals } from '~/components/holiday-deals'
import { CharmHelp } from '~/components/charm-help'
import { DeliveryHelp } from '~/components/delivery-help'
import type { PricingMode, DiscountDelivery, CharmPricingStrategy, CampaignStatus } from '@gopaylocal/shared'
import { providerLogo } from '~/components/integrations/providers'
import { btnPrimary, btnSecondary, Spinner } from '~/components/ui/page'
import { ErrorText, LifecycleStatus, ToneIcon } from '~/components/ui/status'

export const Route = createFileRoute('/dashboard/campaigns/$id')({
  component: CampaignDetailPage,
})

// Sentinel for the "no integration" Select option (Radix can't use an empty value).
const NO_INTEGRATION = 'none'

type Tab = 'setup' | 'deals' | 'settings'

const CODE_TABS = ['Script Tag', 'React', 'Next.js', 'API'] as const
type CodeTab = (typeof CODE_TABS)[number]

function CampaignDetailPage() {
  const { id: campaignId } = useParams({ from: '/dashboard/campaigns/$id' })
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { data: session, isPending: sessionPending } = useSession()
  const teamId = getActiveTeamId(session)

  const [activeTab, setActiveTab] = useState<Tab>('setup')
  const [codeTab, setCodeTab] = useState<CodeTab>('Script Tag')
  const [isEditing, setIsEditing] = useState(false)
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)

  const { data: campaign, isPending: campaignPending } = useQuery({
    queryKey: ['campaign', teamId, campaignId],
    queryFn: () => api.campaigns.get(teamId, campaignId),
    enabled: !!teamId,
  })

  // On a hard reload the session resolves asynchronously, so teamId is empty
  // for the first render(s). With `enabled: !!teamId` the campaign query sits in
  // the `pending` state with fetchStatus 'idle' (it never fetches), which made
  // the old `isPending` gate spin forever. Treat "session still loading" or
  // "query disabled because teamId isn't ready yet" as the real loading state,
  // and only render the campaign query's pending state once it can actually run.
  const isLoading = sessionPending || !teamId || campaignPending

  const { data: apiKeys = [] } = useQuery({
    queryKey: ['api-keys', teamId],
    queryFn: () => api.team.apiKeys(teamId),
    enabled: !!teamId,
  })

  const { data: integrations = [] } = useQuery({
    queryKey: ['integrations', teamId],
    queryFn: () => api.integrations.list(teamId),
    enabled: !!teamId,
  })

  // A/B test this campaign is an arm of, if one is running. While it runs the
  // API refuses to pause or delete the campaign (409), so the controls say why.
  const { data: runningExperiments = [] } = useQuery({
    queryKey: ['experiments', teamId, 'campaign', campaignId],
    queryFn: () => api.experiments.list(teamId, { campaignId, status: 'running' }),
    enabled: !!teamId,
  })
  const runningExperiment = runningExperiments[0] ?? null

  const { data: products = [] } = useQuery({
    queryKey: ['products', teamId, campaign?.environment],
    queryFn: () => api.products.list(teamId, campaign?.environment),
    enabled: !!teamId && !!campaign,
  })
  const { can } = usePermissions()

  // Edit form state
  const [editName, setEditName] = useState('')
  const [editPricingMode, setEditPricingMode] = useState<PricingMode>('ppp_factor')
  const [editDelivery, setEditDelivery] = useState<DiscountDelivery>('banner_coupon')
  const [editIntegrationId, setEditIntegrationId] = useState<string>(NO_INTEGRATION)
  const [editCharm, setEditCharm] = useState<CharmPricingStrategy>('none')
  const [editMaxDiscount, setEditMaxDiscount] = useState(50)

  const startEditing = () => {
    if (!campaign) return
    setEditName(campaign.name)
    setEditPricingMode(campaign.pricingMode)
    setEditDelivery(campaign.discountDelivery)
    setEditIntegrationId(campaign.integrationId ?? NO_INTEGRATION)
    setEditCharm(campaign.charmPricingStrategy)
    setEditMaxDiscount(campaign.maxDiscountPercent)
    setIsEditing(true)
  }

  const updateCampaign = useMutation({
    mutationFn: (data: Partial<Campaign>) => api.campaigns.update(teamId, campaignId, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['campaign', teamId, campaignId] })
      queryClient.invalidateQueries({ queryKey: ['campaigns', teamId] })
      toast.success('Campaign updated')
      setIsEditing(false)
    },
    onError: (err) => toast.error('Update failed', { description: err.message }),
  })

  const toggleStatus = useMutation({
    mutationFn: (newStatus: CampaignStatus) => api.campaigns.update(teamId, campaignId, { status: newStatus }),
    onSuccess: (updated) => {
      queryClient.invalidateQueries({ queryKey: ['campaign', teamId, campaignId] })
      queryClient.invalidateQueries({ queryKey: ['campaigns', teamId] })
      toast.success(`Campaign ${updated.status}`)
    },
    onError: (err) => toast.error('Failed to update status', { description: err.message }),
  })

  const deleteCampaign = useMutation({
    mutationFn: () => api.campaigns.delete(teamId, campaignId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['campaigns', teamId] })
      toast.success('Campaign deleted')
      navigate({ to: '/dashboard/campaigns' })
    },
    onError: (err) => toast.error('Delete failed', { description: err.message }),
  })

  // The banner runtime reads the key EXCLUSIVELY from the script src query
  // string (?key=...), so the snippet needs the FULL public key — not the
  // masked prefix. The API returns fullKey only for public keys created after
  // the full-key migration; older public keys have no stored full key.
  const publicKeyWithFull = apiKeys.find((k) => k.keyType === 'public' && k.fullKey)
  const publicFullKey = publicKeyWithFull?.fullKey ?? null
  const PUBLIC_KEY_PLACEHOLDER = 'YOUR_PUBLIC_KEY'
  const publicKey = publicFullKey ?? PUBLIC_KEY_PLACEHOLDER
  const hasUsablePublicKey = publicFullKey !== null

  // Snippets point at this dashboard's own API (self-hosted deployments set
  // VITE_API_URL), else the hosted service. data-product / productId pin the
  // banner to this campaign's product, so another product's campaign is never
  // shown on the site.
  const HOSTED_API = 'https://api.gopaylocal.com'
  const snippetApiBase = (import.meta.env.VITE_API_URL || HOSTED_API).replace(/\/+$/, '')
  const snippetProductId = campaign?.productId
  const productAttr = snippetProductId ? ` data-product="${snippetProductId}"` : ''
  const productQuery = snippetProductId ? `?product=${encodeURIComponent(snippetProductId)}` : ''
  const providerProps =
    (snippetProductId ? ` productId="${snippetProductId}"` : '') +
    (snippetApiBase !== HOSTED_API ? ` apiBase="${snippetApiBase}"` : '')

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text)
    toast.success('Copied to clipboard')
  }

  const snippets: Record<CodeTab, { code: string; language: string }> = {
    'Script Tag': {
      language: 'html',
      // The runtime reads the key from the src query string and the product
      // from data-product (packages/banner/src/setup.ts).
      code: `<!-- Add to your website's <head> or before </body> -->
<script src="${snippetApiBase}/v1/banner/script.js?key=${publicKey}"${productAttr} async></script>`,
    },
    React: {
      language: 'jsx',
      code: `import { GoPayLocalProvider, PPPBanner } from '@gopaylocal/react'

function App() {
  return (
    <GoPayLocalProvider apiKey="${publicKey}"${providerProps}>
      <PPPBanner />
      {/* Your pricing page */}
    </GoPayLocalProvider>
  )
}`,
    },
    'Next.js': {
      language: 'jsx',
      code: `// app/layout.tsx (a server component can render the provider)
import { GoPayLocalProvider } from '@gopaylocal/react'

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>
        <GoPayLocalProvider apiKey="${publicKey}"${providerProps}>
          {children}
        </GoPayLocalProvider>
      </body>
    </html>
  )
}

// app/pricing/pricing-card.tsx (hooks need a client component)
'use client'
import { PPPBanner, usePrice } from '@gopaylocal/react'

export function PricingCard() {
  const { formatted, formattedOriginal, hasDiscount, discount } = usePrice({ price: 49 })

  return (
    <div>
      <PPPBanner />
      <p>Price: {hasDiscount && <s>{formattedOriginal}</s>} {formatted}</p>
      {hasDiscount && <p>{discount}% off with PPP</p>}
    </div>
  )
}`,
    },
    API: {
      language: 'bash',
      code: `# The public endpoint the banner and SDKs call. The discount depends on the
# country of the device making the request: call it from the browser, since
# from a server you get the server's country.
curl "${snippetApiBase}/v1/banner/config/${publicKey}${productQuery}"

# Response when a discount applies (abridged):
# {
#   "show": true,
#   "country": "IN",
#   "countryName": "India",
#   "discount": 40,
#   "code": "PPP-IN40-K7QX",
#   "campaignId": "...",
#   "banner": { "position": "bottom", "messageTemplate": "...", ... }
# }
# Otherwise: { "show": false, "reason": "no_discount" }`,
    },
  }

  // Auto-apply has nothing to apply the discount through without a provider.
  // The server blocks this only for ACTIVE campaigns; mirror that here so a
  // draft can still be saved while the integration is set up.
  const editAutoApplyNeedsIntegration =
    editDelivery === 'auto_apply' && editIntegrationId === NO_INTEGRATION
  const editBlockedByIntegration =
    editAutoApplyNeedsIntegration && campaign?.status === 'active'

  const handleSave = () => {
    updateCampaign.mutate({
      name: editName,
      pricingMode: editPricingMode,
      discountDelivery: editDelivery,
      integrationId: editIntegrationId === NO_INTEGRATION ? null : editIntegrationId,
      charmPricingStrategy: editCharm,
      maxDiscountPercent: editMaxDiscount,
    })
  }

  const getNextStatus = (): { label: string; status: CampaignStatus; style: string } | null => {
    if (!campaign) return null
    if (campaign.status === 'draft') return { label: 'Activate', status: 'active', style: btnPrimary }
    if (campaign.status === 'active') return { label: 'Pause', status: 'paused', style: btnSecondary }
    if (campaign.status === 'paused') return { label: 'Resume', status: 'active', style: btnPrimary }
    return null
  }

  if (isLoading) {
    return <Spinner className="py-20" />
  }

  if (!campaign) {
    return (
      <div className="py-20 text-center">
        <p className="text-text-secondary">Campaign not found.</p>
      </div>
    )
  }

  const nextStatus = getNextStatus()

  // The campaign's payment platform, by name; null when it has no integration.
  const linkedIntegration = integrations.find((i) => i.id === campaign.integrationId)
  const linkedProviderLabel = campaign.integrationId
    ? linkedIntegration
      ? (PROVIDER_LABELS[linkedIntegration.provider] ?? linkedIntegration.provider)
      : 'your payment platform'
    : null

  // Activating an auto-apply campaign with no integration is rejected by the
  // server (it can't apply a discount at checkout). Disable the Activate/Resume
  // toggle so the user gets a co-located reason instead of a 400 dead-end.
  const cannotActivate =
    campaign.discountDelivery === 'auto_apply' && !campaign.integrationId
  const toggleBlocked = nextStatus?.status === 'active' && cannotActivate
  // An arm of a running A/B test must stay active until the test ends.
  const pauseBlockedByTest = nextStatus?.status === 'paused' && runningExperiment !== null
  const AB_TEST_LOCK_REASON = 'This campaign is in a running A/B test. End the test first.'

  const product = products.find((p) => p.id === campaign.productId)
  const TABS: { id: Tab; label: string }[] = [
    { id: 'setup', label: 'Setup' },
    { id: 'deals', label: 'Holiday deals' },
    { id: 'settings', label: 'Settings' },
  ]

  return (
    <div className="flex max-w-[1080px] flex-col gap-6">
      <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-2 text-[13px] text-text-muted">
        <Link to="/dashboard/campaigns" className="text-text-secondary hover:text-text-primary">
          Campaigns
        </Link>
        <span aria-hidden="true">/</span>
        <span className="truncate">{campaign.name}</span>
      </nav>

      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-2">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="font-display text-[30px] font-semibold tracking-tight text-text-primary">{campaign.name}</h1>
            <LifecycleStatus state={campaign.status === 'active' ? 'on' : campaign.status === 'paused' ? 'paused' : 'draft'}>
              {campaign.status === 'active' ? 'Active' : campaign.status === 'paused' ? 'Paused' : 'Draft'}
            </LifecycleStatus>
          </div>
          <p className="flex flex-wrap gap-x-4 gap-y-1.5 text-[13px] text-text-secondary">
            {product && <span>{`${product.name} · ${formatPrice(product.basePrice, product.currency)}`}</span>}
            {linkedIntegration ? (
              <span className="inline-flex items-center gap-1.5">
                <img src={providerLogo(linkedIntegration.provider)} alt="" className="h-3.5 w-3.5 object-contain" />
                Codes in {linkedProviderLabel}
              </span>
            ) : (
              !campaign.integrationId && <span>No payment platform</span>
            )}
            <span>{DISCOUNT_DELIVERY_LABELS[campaign.discountDelivery] ?? formatLabel(campaign.discountDelivery)}</span>
            <span>
              {PRICING_MODE_LABELS[campaign.pricingMode] ?? formatLabel(campaign.pricingMode)}, up to {campaign.maxDiscountPercent}% off
            </span>
          </p>
        </div>
        {nextStatus && can('campaigns.update') && (
          <button
            type="button"
            onClick={() => toggleStatus.mutate(nextStatus.status)}
            disabled={toggleStatus.isPending || toggleBlocked || pauseBlockedByTest}
            title={
              toggleBlocked
                ? 'Auto-apply needs a payment integration — link one in Settings first.'
                : pauseBlockedByTest
                  ? AB_TEST_LOCK_REASON
                  : undefined
            }
            className={nextStatus.style}
          >
            {toggleStatus.isPending ? '…' : nextStatus.label}
          </button>
        )}
      </header>

      {runningExperiment && (
        <div className="flex flex-wrap items-center justify-between gap-3 border border-border bg-panel px-4 py-3">
          <p className="text-[13px] text-text-secondary">
            <span className="font-medium text-text-primary">
              Side {runningExperiment.campaignAId === campaignId ? 'A' : 'B'} of the A/B test "{runningExperiment.name}".
            </span>{' '}
            It can't be paused or deleted until the test ends.
          </p>
          <Link
            to="/dashboard/experiments/$id"
            params={{ id: runningExperiment.id }}
            className="text-[13px] font-medium text-brand-text hover:underline"
          >
            View A/B test
          </Link>
        </div>
      )}

      <div role="tablist" aria-label="Campaign" className="flex gap-6 border-b border-border">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={activeTab === tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`-mb-px h-11 border-b-2 text-sm transition-colors ${
              activeTab === tab.id
                ? 'border-brand font-semibold text-text-primary'
                : 'border-transparent text-text-secondary hover:text-text-primary'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Setup Tab */}
      {activeTab === 'setup' && (
        <div className="flex flex-col gap-6">
          {/* API Key check */}
          {!apiKeys.some((k) => k.keyType === 'public') && (
            <KeyNotice title="Create an API key first">
              Go to{' '}
              <Link to="/dashboard/settings" search={{ tab: 'api-keys' }} className="font-medium underline hover:no-underline">
                Settings → API keys
              </Link>{' '}
              to make a public key for the snippet.
            </KeyNotice>
          )}

          {/* Legacy public key (created before full-key storage) — can't be
              embedded because the full value was never stored. Prompt for a new one. */}
          {apiKeys.some((k) => k.keyType === 'public') && !hasUsablePublicKey && (
            <KeyNotice title="Your public key can't be embedded">
              This public key was created before we stored full keys, so the snippet shows a placeholder. Create a new
              public key in{' '}
              <Link to="/dashboard/settings" search={{ tab: 'api-keys' }} className="font-medium underline hover:no-underline">
                Settings → API keys
              </Link>{' '}
              to get a ready-to-paste snippet.
            </KeyNotice>
          )}

          {/* Banner design: what the script tag and the SDKs' banners show (components/banner-editor.tsx) */}
          <BannerEditor teamId={teamId} campaignId={campaignId} step="01" />

          <section aria-labelledby="embed-title" className="border border-border bg-panel">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-border px-6 py-4">
              <span className="font-mono text-xs text-brand-text">02</span>
              <h2 id="embed-title" className="font-display text-lg font-semibold text-text-primary">
                Add it to your site
              </h2>
              <span className="text-[13px] text-text-muted">Once, on the page with your prices.</span>
            </div>
            {/* On phones the tabs wrap and the <pre> scrolls on its own:
                contain:inline-size keeps its long lines from widening the page,
                which the dashboard's ScrollArea (a display:table wrapper) would
                otherwise allow. */}
            <div className="flex flex-col gap-3.5 px-6 py-5">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div role="tablist" aria-label="Snippet" className="flex flex-wrap border border-border-strong">
                  {CODE_TABS.map((tab, i) => (
                    <button
                      key={tab}
                      type="button"
                      role="tab"
                      aria-selected={codeTab === tab}
                      onClick={() => setCodeTab(tab)}
                      className={`h-9 px-3.5 text-[13px] font-medium transition-colors ${i > 0 ? 'border-l border-border-strong' : ''} ${
                        codeTab === tab ? 'bg-tile text-text-primary' : 'text-text-secondary hover:text-text-primary'
                      }`}
                    >
                      {tab}
                    </button>
                  ))}
                </div>
                <button type="button" onClick={() => copyToClipboard(snippets[codeTab].code)} className={`${btnSecondary} h-9`}>
                  <ClipboardIcon />
                  Copy
                </button>
              </div>
              <pre className="overflow-x-auto border border-border bg-bg p-4 font-mono text-[13px] leading-relaxed text-text-primary [contain:inline-size]">
                <code>{snippets[codeTab].code}</code>
              </pre>
              {(codeTab === 'React' || codeTab === 'Next.js') && (
                <div className="flex flex-wrap items-center justify-between gap-3 border border-border bg-bg px-4 py-3">
                  <code className="min-w-0 truncate font-mono text-[13px] text-text-primary">npm install @gopaylocal/react</code>
                  <button
                    type="button"
                    onClick={() => copyToClipboard('npm install @gopaylocal/react')}
                    className="flex shrink-0 items-center gap-1.5 text-[13px] font-medium text-text-secondary transition-colors hover:text-text-primary"
                  >
                    <ClipboardIcon />
                    Copy
                  </button>
                </div>
              )}
              <p className="text-[13px] text-text-muted">
                The key in the snippet is your public key (gpl_pk_…). It is safe in a web page; a secret key never is.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-x-6 gap-y-2 border-t border-border px-6 py-3.5 text-[13px]">
              <span className="flex min-w-0 items-center gap-2 text-text-muted">
                Campaign ID
                <code className="truncate font-mono text-text-primary">{campaignId}</code>
                <button
                  type="button"
                  onClick={() => copyToClipboard(campaignId)}
                  aria-label="Copy campaign ID"
                  className="shrink-0 text-text-secondary transition-colors hover:text-text-primary"
                >
                  <ClipboardIcon />
                </button>
              </span>
              <a href="https://docs.gopaylocal.com/" target="_blank" rel="noopener noreferrer" className="text-text-secondary hover:text-text-primary">
                Full documentation
              </a>
              <a href="https://docs.gopaylocal.com/integrations/overview/" target="_blank" rel="noopener noreferrer" className="text-text-secondary hover:text-text-primary">
                Payment platform guides
              </a>
            </div>
          </section>
        </div>
      )}

      {/* Holiday deals Tab (components/holiday-deals.tsx) */}
      {activeTab === 'deals' && (
        <div className="max-w-3xl">
          <HolidayDeals
            teamId={teamId}
            campaignId={campaignId}
            providerLabel={linkedProviderLabel}
            canEdit={can('campaigns.update')}
            inRunningTest={runningExperiment !== null}
          />
        </div>
      )}

      {/* Settings Tab */}
      {activeTab === 'settings' && (
        <div className="max-w-lg space-y-5">
          {!isEditing ? (
            <>
              {/* Read-only view */}
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <SettingsCard label="Campaign Name" value={campaign.name} />
                <SettingsCard label="Pricing Mode" value={PRICING_MODE_LABELS[campaign.pricingMode] ?? formatLabel(campaign.pricingMode)} />
                <SettingsCard label="Delivery" value={DISCOUNT_DELIVERY_LABELS[campaign.discountDelivery] ?? formatLabel(campaign.discountDelivery)} />
                <SettingsCard
                  label="Integration"
                  value={
                    campaign.integrationId
                      ? (() => {
                          const linked = integrations.find((i) => i.id === campaign.integrationId)
                          return linked ? PROVIDER_LABELS[linked.provider] ?? linked.provider : 'Linked'
                        })()
                      : 'None'
                  }
                />
                <SettingsCard
                  label="Max Discount"
                  value={`${campaign.maxDiscountPercent}%`}
                  numeric
                />
                <SettingsCard
                  label="Charm Pricing"
                  value={campaign.charmPricingStrategy === 'none' ? 'Off' : formatLabel(campaign.charmPricingStrategy)}
                />
                <SettingsCard label="Created" value={new Date(campaign.createdAt).toLocaleDateString()} numeric />
              </div>

              {/* Auto-apply needs an integration: without one no code exists at the provider. */}
              {campaign.discountDelivery === 'auto_apply' && !campaign.integrationId && (
                <div className="border border-warning-border bg-warning-light p-4">
                  <p className="text-sm font-semibold text-warning">Auto-apply isn't wired up</p>
                  <p className="mt-1 text-[13px] text-text-primary">
                    This campaign is set to auto-apply but has no payment integration, so no code is created at
                    your payment platform for your checkout to apply. Edit settings to link one
                    {campaign.status === 'active' ? '' : ' before activating'}.
                  </p>
                </div>
              )}

              {/* A/B Testing: entry point to link this campaign with another one */}
              <div className="border border-border bg-panel p-4">
                <p className="text-[11px] font-semibold uppercase tracking-wider text-text-muted">A/B testing</p>
                {runningExperiment ? (
                  <>
                    <p className="mt-1 text-sm text-text-primary">
                      Campaign {runningExperiment.campaignAId === campaignId ? 'A (control)' : 'B (variant)'} in the
                      running test "{runningExperiment.name}".
                    </p>
                    <p className="mt-1 text-[13px] text-text-secondary">
                      It can't be paused or deleted until the test ends.
                    </p>
                    <Link
                      to="/dashboard/experiments/$id"
                      params={{ id: runningExperiment.id }}
                      className="mt-3 inline-block text-[13px] font-medium text-brand-text hover:underline"
                    >
                      View A/B test
                    </Link>
                  </>
                ) : (
                  <>
                    <p className="mt-1 text-[13px] text-text-secondary">
                      Split this product's visitors between this campaign and another active campaign to compare
                      discount levels.
                      {campaign.status !== 'active' && ' Activate this campaign first.'}
                    </p>
                    {campaign.status === 'active' && can('experiments.create') && (
                      <Link
                        to="/dashboard/experiments/new"
                        search={{ campaignA: campaignId }}
                        className={`mt-3 ${btnPrimary}`}
                      >
                        Create A/B test
                      </Link>
                    )}
                  </>
                )}
              </div>

              <div className="flex items-center gap-3 pt-2">
                <button
                  type="button"
                  onClick={startEditing}
                  className={btnPrimary}
                >
                  Edit settings
                </button>
                <button
                  type="button"
                  onClick={() => setShowDeleteConfirm(true)}
                  disabled={runningExperiment !== null}
                  title={runningExperiment ? AB_TEST_LOCK_REASON : undefined}
                  className={btnSecondary}
                >
                  Delete campaign
                </button>
              </div>

              {/* Delete confirmation */}
              {showDeleteConfirm && (
                <div className="border border-error-border bg-error-light p-4">
                  <p className="text-sm font-semibold text-text-primary">Are you sure?</p>
                  <p className="mt-1 text-[13px] text-text-secondary">
                    This will permanently delete "{campaign.name}" and all associated data. This cannot be undone.
                  </p>
                  <div className="mt-3 flex gap-3">
                    <button
                      type="button"
                      onClick={() => deleteCampaign.mutate()}
                      disabled={deleteCampaign.isPending}
                      className="bg-brand px-3 py-1.5 text-[13px] font-medium text-white hover:bg-brand/90 disabled:opacity-50"
                    >
                      {deleteCampaign.isPending ? 'Deleting...' : 'Yes, delete'}
                    </button>
                    <button
                      type="button"
                      onClick={() => setShowDeleteConfirm(false)}
                      className="border border-border px-3 py-1.5 text-[13px] font-medium text-text-primary hover:bg-surface"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </>
          ) : (
            <>
              {/* Edit mode */}
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-text-primary">Campaign Name</label>
                  <input
                    type="text"
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                    className="mt-1 block w-full border border-control px-3 py-2 text-sm text-text-primary focus:border-brand focus:outline-none"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-text-primary">Pricing Mode</label>
                  <Select value={editPricingMode} onValueChange={(v) => setEditPricingMode(v as PricingMode)}>
                    <SelectTrigger className="mt-1 w-full"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        <SelectItem value="ppp_factor">PPP Factor (automatic)</SelectItem>
                        <SelectItem value="group">Group-based tiers</SelectItem>
                        <SelectItem value="custom">Custom per-country</SelectItem>
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </div>

                <div>
                  <label className="block text-sm font-medium text-text-primary">Discount Delivery</label>
                  <Select value={editDelivery} onValueChange={(v) => setEditDelivery(v as DiscountDelivery)}>
                    <SelectTrigger className="mt-1 w-full"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        <SelectItem value="banner_coupon">Banner + Coupon Code</SelectItem>
                        <SelectItem value="auto_apply">Auto-apply at checkout</SelectItem>
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                  <DeliveryHelp delivery={editDelivery} />
                </div>

                <div>
                  <label className="block text-sm font-medium text-text-primary">
                    Payment Integration
                    {editDelivery === 'auto_apply' && <span className="text-brand-text"> *</span>}
                  </label>
                  <Select value={editIntegrationId} onValueChange={setEditIntegrationId}>
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
                  ) : editBlockedByIntegration ? (
                    <ErrorText className="mt-1.5">
                      This campaign is active — auto-apply needs an integration. Pick one or switch delivery to Banner + Coupon.
                    </ErrorText>
                  ) : editAutoApplyNeedsIntegration ? (
                    <p className="mt-1.5 text-[13px] text-text-secondary">
                      Link an integration before activating: an auto-apply campaign needs one to be active.
                    </p>
                  ) : (
                    <p className="mt-1.5 text-[13px] text-text-secondary">
                      Links the campaign to a provider so coupons are created automatically.
                    </p>
                  )}
                </div>

                <div>
                  <label className="block text-sm font-medium text-text-primary">Max Discount (%)</label>
                  <div className="mt-1 flex items-center gap-3">
                    <input
                      type="range"
                      min={5}
                      max={90}
                      step={5}
                      value={editMaxDiscount}
                      onChange={(e) => setEditMaxDiscount(parseInt(e.target.value, 10))}
                      className="h-1.5 flex-1 appearance-none rounded-full bg-border accent-brand"
                    />
                    <input
                      type="number"
                      min={1}
                      max={90}
                      value={editMaxDiscount}
                      onChange={(e) => setEditMaxDiscount(parseInt(e.target.value, 10) || 50)}
                      className="w-16 border border-control bg-bg px-2 py-1.5 text-center font-mono text-sm tabular-nums text-text-primary focus:border-brand focus:outline-none"
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-sm font-medium text-text-primary">Charm Pricing</label>
                  <Select value={editCharm} onValueChange={(v) => setEditCharm(v as CharmPricingStrategy)}>
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
                  <CharmHelp strategy={editCharm} provider={integrations.find((i) => i.id === editIntegrationId)?.provider} />
                </div>
              </div>

              <div className="flex items-center gap-3 pt-2">
                <button
                  type="button"
                  onClick={handleSave}
                  disabled={updateCampaign.isPending || !editName.trim() || editBlockedByIntegration}
                  className={btnPrimary}
                >
                  {updateCampaign.isPending ? 'Saving…' : 'Save changes'}
                </button>
                <button
                  type="button"
                  onClick={() => setIsEditing(false)}
                  className={btnSecondary}
                >
                  Cancel
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}

function KeyNotice({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-3 border border-warning-border bg-warning-light px-4 py-3">
      <ToneIcon tone="warn" className="mt-0.5 h-4 w-4" />
      <div>
        <p className="text-sm font-semibold text-warning">{title}</p>
        <p className="mt-0.5 text-[13px] text-text-primary">{children}</p>
      </div>
    </div>
  )
}

function SettingsCard({ label, value, numeric }: { label: string; value: string; numeric?: boolean }) {
  return (
    <div className="border border-border bg-panel p-4">
      <p className="text-[11px] font-semibold uppercase tracking-wider text-text-muted">{label}</p>
      <p className={`mt-1 text-sm text-text-primary ${numeric ? 'font-mono font-medium tabular-nums' : ''}`}>
        {value}
      </p>
    </div>
  )
}

function formatLabel(s: string) {
  return s
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
}

function ClipboardIcon() {
  return (
    <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" d="M15.666 3.888A2.25 2.25 0 0 0 13.5 2.25h-3c-1.03 0-1.9.693-2.166 1.638m7.332 0c.055.194.084.4.084.612v0a.75.75 0 0 1-.75.75H9.75a.75.75 0 0 1-.75-.75v0c0-.212.03-.418.084-.612m7.332 0c.646.049 1.288.11 1.927.184 1.1.128 1.907 1.077 1.907 2.185V19.5a2.25 2.25 0 0 1-2.25 2.25H6.75A2.25 2.25 0 0 1 4.5 19.5V6.257c0-1.108.806-2.057 1.907-2.185a48.208 48.208 0 0 1 1.927-.184" />
    </svg>
  )
}
