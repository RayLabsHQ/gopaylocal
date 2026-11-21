import { createFileRoute, useParams, useNavigate, Link } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { toast } from 'sonner'
import { api, PROVIDER_LABELS, PRICING_MODE_LABELS, DISCOUNT_DELIVERY_LABELS, type Campaign } from '~/lib/api'
import { getActiveTeamId, useSession } from '~/lib/auth'
import { usePermissions } from '~/lib/permissions'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '~/components/ui/select'
import { BannerEditor } from '~/components/banner-editor'
import { CharmHelp } from '~/components/charm-help'
import { DeliveryHelp } from '~/components/delivery-help'
import type { PricingMode, DiscountDelivery, CharmPricingStrategy, CampaignStatus } from '@gopaylocal/shared'

export const Route = createFileRoute('/dashboard/campaigns/$id')({
  component: CampaignDetailPage,
})

// Sentinel for the "no integration" Select option (Radix can't use an empty value).
const NO_INTEGRATION = 'none'

type Tab = 'setup' | 'settings'

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
    if (campaign.status === 'draft') return { label: 'Activate', status: 'active', style: 'bg-success text-inverted-text hover:bg-success/90' }
    if (campaign.status === 'active') return { label: 'Pause', status: 'paused', style: 'bg-amber-500 text-inverted-text hover:bg-amber-400' }
    if (campaign.status === 'paused') return { label: 'Resume', status: 'active', style: 'bg-success text-inverted-text hover:bg-success/90' }
    return null
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="h-6 w-6 animate-spin rounded-full border-4 border-border border-t-brand" />
      </div>
    )
  }

  if (!campaign) {
    return (
      <div className="py-20 text-center">
        <p className="text-text-secondary">Campaign not found.</p>
      </div>
    )
  }

  const nextStatus = getNextStatus()

  // Activating an auto-apply campaign with no integration is rejected by the
  // server (it can't apply a discount at checkout). Disable the Activate/Resume
  // toggle so the user gets a co-located reason instead of a 400 dead-end.
  const cannotActivate =
    campaign.discountDelivery === 'auto_apply' && !campaign.integrationId
  const toggleBlocked = nextStatus?.status === 'active' && cannotActivate
  // An arm of a running A/B test must stay active until the test ends.
  const pauseBlockedByTest = nextStatus?.status === 'paused' && runningExperiment !== null
  const AB_TEST_LOCK_REASON = 'This campaign is in a running A/B test. End the test first.'

  return (
    <div>
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-sm text-text-secondary">
            <button
              type="button"
              onClick={() => navigate({ to: '/dashboard/campaigns' })}
              className="hover:text-text-primary"
            >
              Campaigns
            </button>
            <span aria-hidden="true">/</span>
            <span className="truncate text-text-primary">{campaign.name}</span>
          </div>
          <h1 className="mt-1 font-display text-4xl font-medium tracking-tight text-text-primary">
            {campaign.name}
          </h1>
        </div>
        <div className="flex items-center gap-3">
          {nextStatus && (
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
              className={`px-3.5 py-1.5 text-[13px] font-medium transition-colors disabled:opacity-50 ${nextStatus.style}`}
            >
              {toggleStatus.isPending ? '...' : nextStatus.label}
            </button>
          )}
          <span
            className={`px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wider ${
              campaign.status === 'active'
                ? 'bg-success/15 text-success'
                : campaign.status === 'paused'
                  ? 'bg-amber-500/15 text-amber-400'
                  : 'bg-surface text-text-secondary'
            }`}
          >
            {campaign.status}
          </span>
        </div>
      </div>

      {/* Tabs */}
      <div className="mt-6 flex gap-0 border-b border-border">
        <button
          type="button"
          onClick={() => setActiveTab('setup')}
          className={`border-b-2 px-4 py-2.5 text-sm font-medium transition-colors ${
            activeTab === 'setup'
              ? 'border-brand text-text-primary'
              : 'border-transparent text-text-secondary hover:text-text-primary'
          }`}
        >
          Setup
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('settings')}
          className={`border-b-2 px-4 py-2.5 text-sm font-medium transition-colors ${
            activeTab === 'settings'
              ? 'border-brand text-text-primary'
              : 'border-transparent text-text-secondary hover:text-text-primary'
          }`}
        >
          Settings
        </button>
      </div>

      {/* Setup Tab */}
      {activeTab === 'setup' && (
        <div className="mt-6 max-w-3xl space-y-6">
          {/* API Key check */}
          {!apiKeys.some((k) => k.keyType === 'public') && (
            <div className="flex items-center gap-3 rounded border border-amber-800 bg-amber-950/50 p-4">
              <svg className="h-5 w-5 shrink-0 text-amber-400" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z" />
              </svg>
              <div>
                <p className="text-sm font-semibold text-amber-200">Create an API key first</p>
                <p className="mt-0.5 text-[13px] text-amber-300">
                  Go to{' '}
                  <button
                    type="button"
                    onClick={() => navigate({ to: '/dashboard/settings' })}
                    className="font-medium underline hover:text-amber-100"
                  >
                    Settings → API Keys
                  </button>{' '}
                  to generate a public key for your integration.
                </p>
              </div>
            </div>
          )}

          {/* Legacy public key (created before full-key storage) — can't be
              embedded because the full value was never stored. Prompt for a new one. */}
          {apiKeys.some((k) => k.keyType === 'public') && !hasUsablePublicKey && (
            <div className="flex items-center gap-3 rounded border border-amber-800 bg-amber-950/50 p-4">
              <svg className="h-5 w-5 shrink-0 text-amber-400" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z" />
              </svg>
              <div>
                <p className="text-sm font-semibold text-amber-200">Your public key can't be embedded</p>
                <p className="mt-0.5 text-[13px] text-amber-300">
                  This public key was created before we stored full keys, so the snippet shows a
                  placeholder. Create a new public key in{' '}
                  <button
                    type="button"
                    onClick={() => navigate({ to: '/dashboard/settings', search: { tab: 'api-keys' } })}
                    className="font-medium underline hover:text-amber-100"
                  >
                    Settings → API Keys
                  </button>{' '}
                  to get a ready-to-paste snippet.
                </p>
              </div>
            </div>
          )}

          {/* Campaign ID + quick copy */}
          <div className="flex items-center gap-4 border border-border p-4">
            <div className="min-w-0 flex-1">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-text-secondary">Campaign ID</p>
              <code className="mt-0.5 block truncate font-mono text-sm text-text-primary">{campaignId}</code>
            </div>
            <button
              type="button"
              onClick={() => copyToClipboard(campaignId)}
              className="flex shrink-0 items-center gap-1.5 text-[13px] font-medium text-text-secondary transition-colors hover:text-text-primary"
            >
              <ClipboardIcon />
              Copy ID
            </button>
          </div>

          {/* Code tabs. On phones the tabs wrap (Copy moves to its own row) and
              the <pre> scrolls on its own: contain:inline-size keeps its long
              lines from widening the whole tab, which the dashboard's
              ScrollArea (a display:table wrapper) would otherwise allow. */}
          <div className="border border-border">
            <div className="flex flex-wrap border-b border-border">
              {CODE_TABS.map((tab) => (
                <button
                  key={tab}
                  type="button"
                  onClick={() => setCodeTab(tab)}
                  className={`px-4 py-2.5 text-[13px] font-medium transition-colors ${
                    codeTab === tab
                      ? 'bg-surface text-text-primary'
                      : 'text-text-secondary hover:text-text-primary'
                  }`}
                >
                  {tab}
                </button>
              ))}
              <div className="flex-1" />
              <button
                type="button"
                onClick={() => copyToClipboard(snippets[codeTab].code)}
                className="ml-auto flex items-center gap-1.5 px-4 py-2.5 text-[13px] font-medium text-text-secondary transition-colors hover:text-text-primary"
              >
                <ClipboardIcon />
                Copy
              </button>
            </div>
            <pre className="overflow-x-auto p-5 font-mono [contain:inline-size] text-[13px] leading-relaxed text-text-primary">
              <code>{snippets[codeTab].code}</code>
            </pre>
          </div>

          {/* Install instructions */}
          {(codeTab === 'React' || codeTab === 'Next.js') && (
            <div className="border border-border">
              <div className="border-b border-border px-4 py-2.5">
                <span className="text-[13px] font-medium text-text-primary">Install the SDK</span>
              </div>
              <div className="flex items-center justify-between gap-4 p-5">
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
            </div>
          )}

          {/* Banner design: what the script tag and the SDKs' banners show (components/banner-editor.tsx) */}
          <BannerEditor teamId={teamId} campaignId={campaignId} />

          {/* Help links */}
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-[13px] text-text-secondary">
            <a href="https://docs.gopaylocal.com/" target="_blank" rel="noopener noreferrer" className="flex items-center gap-1 hover:text-text-primary">
              <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 6.042A8.967 8.967 0 0 0 6 3.75c-1.052 0-2.062.18-3 .512v14.25A8.987 8.987 0 0 1 6 18c2.305 0 4.408.867 6 2.292m0-14.25a8.966 8.966 0 0 1 6-2.292c1.052 0 2.062.18 3 .512v14.25A8.987 8.987 0 0 0 18 18a8.967 8.967 0 0 0-6 2.292m0-14.25v14.25" />
              </svg>
              Full documentation
            </a>
            <a href="https://docs.gopaylocal.com/integrations/overview/" target="_blank" rel="noopener noreferrer" className="flex items-center gap-1 hover:text-text-primary">
              <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M13.19 8.688a4.5 4.5 0 0 1 1.242 7.244l-4.5 4.5a4.5 4.5 0 0 1-6.364-6.364l1.757-1.757m13.35-.622 1.757-1.757a4.5 4.5 0 0 0-6.364-6.364l-4.5 4.5a4.5 4.5 0 0 0 1.242 7.244" />
              </svg>
              Provider integrations (Stripe, Paddle, etc.)
            </a>
          </div>
        </div>
      )}

      {/* Settings Tab */}
      {activeTab === 'settings' && (
        <div className="mt-6 max-w-lg space-y-5">
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
                <div className="border border-amber-800 bg-amber-950/30 p-4">
                  <p className="text-sm font-semibold text-amber-200">Auto-apply isn't wired up</p>
                  <p className="mt-1 text-[13px] text-amber-300">
                    This campaign is set to auto-apply but has no payment integration, so no code is created at
                    your payment platform for your checkout to apply. Edit settings to link one
                    {campaign.status === 'active' ? '' : ' before activating'}.
                  </p>
                </div>
              )}

              {/* A/B Testing: entry point to link this campaign with another one */}
              <div className="border border-border p-4">
                <p className="text-[11px] font-semibold uppercase tracking-wider text-text-secondary">A/B Testing</p>
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
                        className="mt-3 inline-block bg-brand px-4 py-2 text-[13px] font-medium text-white transition-colors hover:bg-brand/90"
                      >
                        Create A/B Test
                      </Link>
                    )}
                  </>
                )}
              </div>

              <div className="flex items-center gap-3 pt-2">
                <button
                  type="button"
                  onClick={startEditing}
                  className="bg-brand px-4 py-2 text-[13px] font-medium text-white transition-colors hover:bg-brand/90"
                >
                  Edit Settings
                </button>
                <button
                  type="button"
                  onClick={() => setShowDeleteConfirm(true)}
                  disabled={runningExperiment !== null}
                  title={runningExperiment ? AB_TEST_LOCK_REASON : undefined}
                  className="border border-red-800 px-4 py-2 text-[13px] font-medium text-red-400 transition-colors hover:bg-red-950/50 disabled:opacity-50"
                >
                  Delete Campaign
                </button>
              </div>

              {/* Delete confirmation */}
              {showDeleteConfirm && (
                <div className="border border-red-800 bg-red-950/30 p-4">
                  <p className="text-sm font-semibold text-red-200">Are you sure?</p>
                  <p className="mt-1 text-[13px] text-red-300">
                    This will permanently delete "{campaign.name}" and all associated data. This cannot be undone.
                  </p>
                  <div className="mt-3 flex gap-3">
                    <button
                      type="button"
                      onClick={() => deleteCampaign.mutate()}
                      disabled={deleteCampaign.isPending}
                      className="bg-red-600 px-3 py-1.5 text-[13px] font-medium text-white hover:bg-red-700 disabled:opacity-50"
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
                    className="mt-1 block w-full border border-border px-3 py-2 text-sm text-text-primary focus:border-brand focus:outline-none"
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
                    <p className="mt-1.5 text-[13px] text-brand-text">
                      This campaign is active — auto-apply needs an integration. Pick one or switch delivery to Banner + Coupon.
                    </p>
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
                      className="w-16 border border-border bg-bg px-2 py-1.5 text-center font-mono text-sm tabular-nums text-text-primary focus:border-brand focus:outline-none"
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
                  <CharmHelp strategy={editCharm} />
                </div>
              </div>

              <div className="flex items-center gap-3 pt-2">
                <button
                  type="button"
                  onClick={handleSave}
                  disabled={updateCampaign.isPending || !editName.trim() || editBlockedByIntegration}
                  className="bg-brand px-4 py-2 text-[13px] font-medium text-white transition-colors hover:bg-brand/90 disabled:opacity-50"
                >
                  {updateCampaign.isPending ? 'Saving...' : 'Save Changes'}
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
    </div>
  )
}

function SettingsCard({ label, value, numeric }: { label: string; value: string; numeric?: boolean }) {
  return (
    <div className="border border-border p-4">
      <p className="text-[11px] font-semibold uppercase tracking-wider text-text-secondary">{label}</p>
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
