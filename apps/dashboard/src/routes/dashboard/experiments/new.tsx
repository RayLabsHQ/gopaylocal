import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { DEFAULT_EXPERIMENT_TRAFFIC_SPLIT_B } from '@gopaylocal/shared'
import { api } from '~/lib/api'
import { getActiveTeamId, useSession } from '~/lib/auth'
import { useEnv } from '~/lib/env'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '~/components/ui/select'
import { EnvNotice } from '~/components/env-notice'
import { ErrorText } from '~/components/ui/status'

// ?campaignA=<id> preselects the control (the "Create A/B Test" link on a
// campaign's Settings tab) and its product.
export const Route = createFileRoute('/dashboard/experiments/new')({
  validateSearch: (search: Record<string, unknown>): { campaignA?: string } =>
    typeof search.campaignA === 'string' && search.campaignA !== '' ? { campaignA: search.campaignA } : {},
  component: NewExperimentPage,
})

function NewExperimentPage() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const search = Route.useSearch()
  const { data: session } = useSession()
  const teamId = getActiveTeamId(session)
  const { env } = useEnv()

  const [name, setName] = useState('')
  const [productId, setProductId] = useState('')
  const [campaignAId, setCampaignAId] = useState('')
  const [campaignBId, setCampaignBId] = useState('')
  const [splitB, setSplitB] = useState(DEFAULT_EXPERIMENT_TRAFFIC_SPLIT_B)

  const { data: products = [] } = useQuery({
    queryKey: ['products', teamId, env],
    queryFn: () => api.products.list(teamId, env),
    enabled: !!teamId,
  })

  const { data: campaigns = [], isPending: campaignsPending } = useQuery({
    queryKey: ['campaigns', teamId, env],
    queryFn: () => api.campaigns.list(teamId, env),
    enabled: !!teamId,
  })

  // The sidebar's Live/Test switch changes which products and campaigns are
  // listed. Drop selections made in the other environment, so the test is
  // started where the user now is (the API takes the arms' environment).
  const selectionEnv = useRef(env)
  useEffect(() => {
    if (selectionEnv.current === env) return
    selectionEnv.current = env
    setProductId('')
    setCampaignAId('')
    setCampaignBId('')
  }, [env])

  // Preselect the control and its product once campaigns load.
  useEffect(() => {
    if (!search.campaignA || campaignAId) return
    const preselected = campaigns.find((c) => c.id === search.campaignA)
    if (preselected) {
      setProductId(preselected.productId)
      setCampaignAId(preselected.id)
    }
  }, [search.campaignA, campaigns, campaignAId])

  // Only active campaigns can be arms: the banner serves nothing else.
  const productCampaigns = campaigns.filter((c) => c.productId === productId)
  const activeCampaigns = productCampaigns.filter((c) => c.status === 'active')
  const inactiveCount = productCampaigns.length - activeCampaigns.length

  const createExperiment = useMutation({
    mutationFn: () =>
      api.experiments.create(teamId, {
        name: name.trim(),
        productId,
        campaignAId,
        campaignBId,
        trafficSplitB: splitB,
      }),
    onSuccess: (experiment) => {
      queryClient.invalidateQueries({ queryKey: ['experiments', teamId] })
      toast.success('A/B test started', { description: 'Visitors are now split between the two campaigns.' })
      navigate({ to: '/dashboard/experiments/$id', params: { id: experiment.id } })
    },
    onError: (err) => toast.error('Failed to start A/B test', { description: err.message }),
  })

  const handleProductChange = (id: string) => {
    setProductId(id)
    setCampaignAId('')
    setCampaignBId('')
  }

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    createExperiment.mutate()
  }

  const canSubmit =
    !!name.trim() && !!productId && !!campaignAId && !!campaignBId && campaignAId !== campaignBId &&
    splitB >= 1 && splitB <= 99

  return (
    <div>
      <h1 className="font-display text-[32px] font-semibold tracking-tight text-text-primary">New A/B test</h1>
      <p className="mt-1 text-base text-text-secondary">
        Split a product's visitors between two active campaigns.
      </p>
      <EnvNotice env={env}>
        {env === 'test'
          ? 'This test will run in Test mode, between test campaigns, and is listed only while the Live/Test switch in the sidebar is on Test. Switch to Live to test live campaigns.'
          : 'This test will run in Live mode and split real visitors between two live campaigns. Switch the Live/Test switch in the sidebar to Test to try it with test campaigns first.'}
      </EnvNotice>

      <form onSubmit={handleSubmit} className="mt-8 max-w-lg space-y-6">
        <div>
          <label htmlFor="name" className="block text-sm font-medium text-text-primary">Test name</label>
          <input
            id="name"
            type="text"
            required
            maxLength={200}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. India 30% vs 45%"
            className="mt-1 block w-full border border-control px-3 py-2 text-sm text-text-primary focus:border-brand focus:outline-none"
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-text-primary">Product</label>
          <Select value={productId} onValueChange={handleProductChange}>
            <SelectTrigger className="mt-1 w-full"><SelectValue placeholder="Select a product..." /></SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {products.map((p) => (
                  <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
          {products.length === 0 && (
            <p className="mt-1.5 text-[13px] text-text-secondary">
              No products in {env} mode yet.
            </p>
          )}
        </div>

        <div>
          <label className="block text-sm font-medium text-text-primary">Campaign A (control)</label>
          <Select value={campaignAId} onValueChange={setCampaignAId} disabled={!productId}>
            <SelectTrigger className="mt-1 w-full"><SelectValue placeholder="Select the control campaign..." /></SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {activeCampaigns.map((c) => (
                  <SelectItem key={c.id} value={c.id} disabled={c.id === campaignBId}>{c.name}</SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </div>

        <div>
          <label className="block text-sm font-medium text-text-primary">Campaign B (variant)</label>
          <Select value={campaignBId} onValueChange={setCampaignBId} disabled={!productId}>
            <SelectTrigger className="mt-1 w-full"><SelectValue placeholder="Select the variant campaign..." /></SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {activeCampaigns.map((c) => (
                  <SelectItem key={c.id} value={c.id} disabled={c.id === campaignAId}>{c.name}</SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
          {productId && !campaignsPending && activeCampaigns.length < 2 && (
            <ErrorText className="mt-1.5">
              An A/B test needs two active campaigns for this product
              {inactiveCount > 0 ? ` (${inactiveCount} more ${inactiveCount === 1 ? 'is' : 'are'} paused or draft — activate ${inactiveCount === 1 ? 'it' : 'them'} first)` : ''}.{' '}
              <button
                type="button"
                onClick={() => navigate({ to: '/dashboard/campaigns/new' })}
                className="underline hover:no-underline"
              >
                Create a campaign
              </button>
            </ErrorText>
          )}
        </div>

        <div>
          <label htmlFor="splitB" className="block text-sm font-medium text-text-primary">Traffic to B (%)</label>
          <div className="mt-1 flex items-center gap-3">
            <input
              type="range"
              min={1}
              max={99}
              step={1}
              value={splitB}
              onChange={(e) => setSplitB(parseInt(e.target.value, 10))}
              className="h-1.5 flex-1 appearance-none rounded-full bg-border accent-brand"
            />
            <input
              id="splitB"
              type="number"
              min={1}
              max={99}
              value={splitB}
              onChange={(e) => setSplitB(Math.min(99, Math.max(1, parseInt(e.target.value, 10) || DEFAULT_EXPERIMENT_TRAFFIC_SPLIT_B)))}
              className="w-16 border border-control bg-bg px-2 py-1.5 text-center font-mono text-sm tabular-nums text-text-primary focus:border-brand focus:outline-none"
            />
          </div>
          <p className="mt-1.5 text-[13px] text-text-secondary">
            <span className="font-mono tabular-nums">{100 - splitB}%</span> of visitors see A,{' '}
            <span className="font-mono tabular-nums">{splitB}%</span> see B. A visitor stays in the same arm on
            every visit.
          </p>
        </div>

        {createExperiment.error && (
          <ErrorText>{createExperiment.error.message || 'Failed to start A/B test.'}</ErrorText>
        )}

        <div className="flex items-center gap-3">
          <button
            type="submit"
            disabled={createExperiment.isPending || !canSubmit}
            className="bg-brand px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-brand/90 disabled:opacity-50"
          >
            {createExperiment.isPending ? 'Starting…' : 'Start test'}
          </button>
          <button
            type="button"
            onClick={() => navigate({ to: '/dashboard/experiments' })}
            className="border border-border px-4 py-2 text-sm font-medium text-text-primary transition-colors hover:bg-surface"
          >
            Cancel
          </button>
        </div>
      </form>
    </div>
  )
}
