import { useEffect, useRef } from 'react'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { toast } from 'sonner'
import { getActiveTeamId, organization, useSession } from '~/lib/auth'
import { api } from '~/lib/api'

// /upgrade: where the website's "Start Pro" button goes. It takes the visitor
// straight to Dodo's checkout for Pro, through whatever is missing first:
//   no session      -> /login, which comes back here after sign-in or sign-up
//   no workspace    -> /onboarding, which comes back here once one exists
//   a workspace     -> POST /billing/checkout, then Dodo's checkout page
// It lands on the Billing tab instead when there is nothing to buy: already
// Pro (a cancelled Pro may subscribe again), a self-hosted server, or a member
// who isn't the owner (the API refuses them, and the Billing tab explains who
// can upgrade).
export const Route = createFileRoute('/upgrade')({
  component: UpgradePage,
})

const BILLING = { to: '/dashboard/settings', search: { tab: 'billing' } } as const

function UpgradePage() {
  const navigate = useNavigate()
  const { data: session, isPending } = useSession()
  const started = useRef(false)

  useEffect(() => {
    if (isPending || started.current) return
    if (!session) {
      navigate({ to: '/login', search: { redirect: '/upgrade' } })
      return
    }
    started.current = true

    const go = async () => {
      const teamId = getActiveTeamId(session)
      if (!teamId) {
        const { data: orgs } = await organization.list()
        const first = orgs?.[0]
        if (!first) {
          navigate({ to: '/onboarding', search: { next: 'upgrade' } })
          return
        }
        await organization.setActive({ organizationId: first.id })
        // A fresh page load, so the session carries the workspace just made active.
        window.location.href = '/upgrade'
        return
      }

      const billing = await api.billing.get(teamId)
      if (billing.selfHosted || billing.billingEnabled === false) {
        navigate(BILLING)
        return
      }
      // A cancelled subscription still has Pro until its paid month ends, and
      // may subscribe again (routes/billing.ts checkoutRefusal).
      const cancelled = billing.status === 'canceled' || billing.status === 'cancelled'
      if (billing.effectivePlan === 'pro' && !cancelled) {
        toast.success('This workspace is already on Pro')
        navigate(BILLING)
        return
      }
      const { checkoutUrl } = await api.billing.createCheckout(teamId)
      window.location.href = checkoutUrl
    }

    go().catch((err) => {
      toast.error("Couldn't open checkout", {
        description: err instanceof Error && err.message ? err.message : 'Try the Upgrade button on this page.',
      })
      navigate(BILLING)
    })
  }, [isPending, session, navigate])

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-bg px-4 font-body">
      <div className="h-8 w-8 animate-spin rounded-full border-4 border-border border-t-brand" />
      <p className="text-sm text-text-secondary">Taking you to checkout for Pro…</p>
    </div>
  )
}
