import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { api, type ApiKey, type Product, type TeamMember, type UsageInfo } from '~/lib/api'
import { getActiveTeamId, useSession, organization } from '~/lib/auth'
import { usePermissions } from '~/lib/permissions'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '~/components/ui/select'
import {
  PLAN_LIMITS,
  PLAN_PRICES_USD,
  PRO_FAIR_USE_API_HITS_PER_MONTH,
  formatLimit,
  hasReachedLimit,
  resolveRole,
  type Limit,
} from '@gopaylocal/shared'
import { ErrorText, ToneIcon } from '~/components/ui/status'
import { btnPrimary, btnSecondary, PageHeader } from '~/components/ui/page'
import { minorToMajor } from '@gopaylocal/shared/currency'
import { formatCharge, useRegionalProPrice } from '~/lib/regional-price'

type Tab = 'team' | 'billing' | 'api-keys'

const VALID_TABS: Tab[] = ['team', 'billing', 'api-keys']

function isValidTab(value: unknown): value is Tab {
  return typeof value === 'string' && VALID_TABS.includes(value as Tab)
}

export const Route = createFileRoute('/dashboard/settings/')({
  // success=true is where Dodo Payments sends the buyer back after checkout.
  validateSearch: (search: Record<string, unknown>): { tab?: Tab; success?: true } => ({
    ...(isValidTab(search.tab) ? { tab: search.tab } : {}),
    ...(search.success === true || search.success === 'true' ? { success: true as const } : {}),
  }),
  component: SettingsPage,
})

function SettingsPage() {
  const search = Route.useSearch()
  const [activeTab, setActiveTab] = useState<Tab>('team')
  const { data: session } = useSession()
  const teamId = getActiveTeamId(session)

  // Self-hosted deployments have no billing; the usage response says so
  // (same query the Team and Billing tabs use, so no extra round trip).
  const { data: usage } = useQuery({
    queryKey: ['billing-usage', teamId],
    queryFn: () => api.billing.usage(teamId),
    enabled: !!teamId,
  })
  const selfHosted = usage?.selfHosted === true

  useEffect(() => {
    if (search.tab) {
      setActiveTab(search.tab)
    }
  }, [search.tab])

  useEffect(() => {
    if (selfHosted && activeTab === 'billing') setActiveTab('team')
  }, [selfHosted, activeTab])

  const tabs: { id: Tab; label: string }[] = [
    { id: 'team', label: 'Team' },
    { id: 'api-keys', label: 'API keys' },
    ...(selfHosted ? [] : [{ id: 'billing' as const, label: 'Billing' }]),
  ]

  return (
    <div className="flex max-w-[1080px] flex-col gap-7">
      <PageHeader title="Settings" description="Your team, your API keys and your plan." />

      <div className="flex flex-col gap-6 lg:flex-row lg:items-start lg:gap-8">
        {/* A row of tabs on a phone, a side menu from lg up; the selected one
            has the same red bar as the sidebar. */}
        <nav aria-label="Settings" className="flex shrink-0 overflow-x-auto border-b border-border lg:w-[200px] lg:flex-col lg:border-b-0">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              aria-current={activeTab === tab.id ? 'page' : undefined}
              onClick={() => setActiveTab(tab.id)}
              className={`-mb-px whitespace-nowrap border-b-2 px-3 py-2.5 text-left text-sm transition-colors lg:mb-0 lg:border-b-0 lg:border-l-2 ${
                activeTab === tab.id
                  ? 'border-brand bg-tile font-semibold text-text-primary'
                  : 'border-transparent text-text-secondary hover:text-text-primary'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </nav>

        <div className="min-w-0 flex-1">
          {activeTab === 'team' && <TeamTab onGoToBilling={() => setActiveTab('billing')} />}
          {activeTab === 'billing' && !selfHosted && <BillingTab returnedFromCheckout={search.success === true} />}
          {activeTab === 'api-keys' && <ApiKeysTab />}
        </div>
      </div>
    </div>
  )
}

// ── Team Tab ─────────────────────────────────────────────────────────────────

function TeamTab({ onGoToBilling }: { onGoToBilling: () => void }) {
  const { data: session } = useSession()
  const teamId = getActiveTeamId(session)

  const { data: members = [], isPending: orgPending } = useQuery({
    queryKey: ['org-members', teamId],
    queryFn: () => api.team.members(teamId),
    enabled: !!teamId,
  })

  const queryClient = useQueryClient()

  // What this role may do, from the shared permission table (the API enforces
  // the same rows): invite, see invitations, set product access, delete.
  const { can } = usePermissions()
  const canInvite = can('team.invite')
  const canSeeInvitations = can('team.viewInvitations')
  const canManageAccess = can('team.manageProductAccess')
  const canDeleteWorkspace = can('workspace.delete')

  const { data: invitations = [] } = useQuery({
    queryKey: ['org-invitations', teamId],
    queryFn: () => api.team.invitations(teamId),
    enabled: !!teamId && canSeeInvitations,
  })

  const pendingInvites = invitations.filter((inv) => inv.status === 'pending')

  // Seat usage hint. Pending invites count against the cap, same as the server.
  // The cap comes from the server's usage meters (null = unlimited); the server
  // also rejects over-cap invites, so this only drives the hint.
  const { data: usage } = useQuery({
    queryKey: ['billing-usage', teamId],
    queryFn: () => api.billing.usage(teamId),
    enabled: !!teamId,
  })
  const plan = usage?.plan ?? 'free'
  const seatCap: Limit | undefined = usage?.meters?.teamMembers.max
  // The server's count includes pending invitations, which only the owner can list.
  const seatsUsed = usage?.meters?.teamMembers.current ?? members.length + pendingInvites.length
  const atSeatCap = seatCap !== undefined && hasReachedLimit(seatsUsed, seatCap)
  const canUpgrade = usage?.billingEnabled !== false && usage?.selfHosted !== true

  // Products power the per-member access editor.
  const { data: products = [] } = useQuery({
    queryKey: ['products', teamId],
    queryFn: () => api.products.list(teamId),
    enabled: !!teamId && canManageAccess,
  })

  const [showInvite, setShowInvite] = useState(false)
  const [inviteEmail, setInviteEmail] = useState('')
  const [inviteRole, setInviteRole] = useState<'member' | 'admin'>('member')
  const [inviteStatus, setInviteStatus] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle')
  const [inviteError, setInviteError] = useState('')
  const [lastInviteId, setLastInviteId] = useState<string | null>(null)
  const [copiedId, setCopiedId] = useState<string | null>(null)

  const getInviteLink = (inviteId: string) =>
    `${window.location.origin}/invite/${inviteId}`

  const copyLink = (inviteId: string) => {
    navigator.clipboard.writeText(getInviteLink(inviteId))
    setCopiedId(inviteId)
    setTimeout(() => setCopiedId(null), 2000)
  }

  const handleInvite = async () => {
    if (!inviteEmail.trim()) return
    setInviteStatus('sending')
    setInviteError('')
    setLastInviteId(null)
    try {
      const res = await organization.inviteMember({
        email: inviteEmail.trim(),
        role: inviteRole,
        organizationId: teamId,
      })
      if (res.error) {
        setInviteError(res.error.message || 'Failed to send invite.')
        setInviteStatus('error')
        return
      }
      const inviteId = (res.data as any)?.id
      setLastInviteId(inviteId ?? null)
      setInviteStatus('sent')
      setInviteEmail('')
      queryClient.invalidateQueries({ queryKey: ['org-invitations', teamId] })
    } catch (err: any) {
      setInviteError(err?.message || 'Failed to send invite.')
      setInviteStatus('error')
    }
  }

  return (
    <div className="space-y-6">
      {/* Team Members */}
      <div className="border border-border bg-panel">
        <div className="flex items-center justify-between border-b border-border px-6 py-5">
          <div>
            <h2 className="font-display text-lg font-semibold text-text-primary">Team</h2>
            <p className="mt-1 text-[13px] text-text-secondary">
              Manage members of your workspace.{' '}
              <span className="tabular-nums">
                {seatCap === undefined || seatCap === null
                  ? `· ${seatsUsed} seat${seatsUsed !== 1 ? 's' : ''} used`
                  : `· ${seatsUsed} of ${seatCap} seat${seatCap !== 1 ? 's' : ''} used`}
              </span>
            </p>
          </div>
          {canInvite && (
            <button
              type="button"
              onClick={() => setShowInvite(!showInvite)}
              disabled={atSeatCap && !showInvite}
              title={atSeatCap ? `Seat limit reached on the ${plan} plan` : undefined}
              className={btnPrimary}
            >
              Invite member
            </button>
          )}
        </div>

        {/* Seat cap hint */}
        {canInvite && atSeatCap && (
          <div className="border-b border-border bg-surface px-6 py-2.5 text-[13px] text-text-secondary">
            You've used all {seatCap} seat{seatCap !== 1 ? 's' : ''} on the{' '}
            <span className="capitalize">{plan}</span> plan.{' '}
            {canUpgrade && (
              <>
                <button
                  type="button"
                  onClick={onGoToBilling}
                  className="font-medium text-brand-text underline hover:no-underline"
                >
                  Go to Billing
                </button>{' '}
                to upgrade to Pro for unlimited team members.
              </>
            )}
          </div>
        )}

        {/* Invite Form */}
        {canInvite && showInvite && (
          <div className="border-b border-border bg-surface px-6 py-4">
            <div className="flex items-end gap-3">
              <div className="flex-1">
                <label htmlFor="inviteEmail" className="block text-sm font-medium text-text-primary">
                  Email address
                </label>
                <input
                  id="inviteEmail"
                  type="email"
                  value={inviteEmail}
                  onChange={(e) => setInviteEmail(e.target.value)}
                  placeholder="teammate@company.com"
                  className="mt-1 block w-full border border-control px-3 py-1.5 text-sm text-text-primary focus:border-brand focus:outline-none"
                  onKeyDown={(e) => e.key === 'Enter' && handleInvite()}
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-text-primary">
                  Role
                </label>
                <Select value={inviteRole} onValueChange={(v) => setInviteRole(v as 'member' | 'admin')}>
                  <SelectTrigger className="mt-1 w-[120px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      <SelectItem value="member">Member</SelectItem>
                      <SelectItem value="admin">Admin</SelectItem>
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </div>
              <button
                type="button"
                onClick={handleInvite}
                disabled={inviteStatus === 'sending' || !inviteEmail.trim()}
                className={btnPrimary}
              >
                {inviteStatus === 'sending' ? 'Sending…' : inviteStatus === 'sent' ? 'Sent' : 'Send invite'}
              </button>
              <button
                type="button"
                onClick={() => { setShowInvite(false); setInviteEmail(''); setInviteStatus('idle') }}
                className={btnSecondary}
              >
                Cancel
              </button>
            </div>
            {inviteStatus === 'error' && (
              <ErrorText className="mt-2">{inviteError}</ErrorText>
            )}
            {inviteStatus === 'sent' && (
              <div className="mt-2">
                <p className="text-[13px] text-success">Invitation sent successfully!</p>
                {lastInviteId && (
                  <div className="mt-2 flex items-center gap-2">
                    <code className="min-w-0 flex-1 truncate border border-border bg-bg px-2 py-1 font-mono text-[13px] text-text-secondary">
                      {getInviteLink(lastInviteId)}
                    </code>
                    <button
                      type="button"
                      onClick={() => copyLink(lastInviteId)}
                      className="shrink-0 border border-border px-2 py-1 text-[13px] font-medium text-text-primary hover:bg-surface"
                    >
                      {copiedId === lastInviteId ? 'Copied' : 'Copy link'}
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* Members List */}
        {orgPending ? (
          <div className="flex h-32 items-center justify-center">
            <div className="h-6 w-6 animate-spin rounded-full border-4 border-border border-t-brand" />
          </div>
        ) : members.length > 0 ? (
          <ul>
            {members.map((member) => (
              <MemberRow
                key={member.id}
                member={member}
                teamId={teamId}
                products={products}
                canManage={canManageAccess && resolveRole(member.role) === 'member'}
              />
            ))}
          </ul>
        ) : (
          <div className="flex h-32 flex-col items-center justify-center px-6 text-center">
            <p className="text-base font-medium text-text-primary">No team members yet</p>
            <p className="mt-1.5 max-w-sm text-sm text-text-secondary">
              Invite a teammate by email and they'll appear here once they accept.
            </p>
          </div>
        )}
      </div>

      {/* Pending Invitations */}
      {canSeeInvitations && pendingInvites.length > 0 && (
        <div className="border border-border bg-panel">
          <div className="border-b border-border px-6 py-5">
            <h2 className="font-display text-lg font-semibold text-text-primary">Pending invitations</h2>
            <p className="mt-1 text-[13px] text-text-secondary">
              {pendingInvites.length} pending invite{pendingInvites.length !== 1 ? 's' : ''}
            </p>
          </div>
          <ul>
            {pendingInvites.map((inv: any) => (
              <li key={inv.id} className="flex items-center justify-between border-b border-border px-6 py-3 last:border-b-0">
                <div className="flex items-center gap-3">
                  <div className="flex h-9 w-9 items-center justify-center rounded-full bg-surface text-sm text-text-secondary">
                    {inv.email?.charAt(0)?.toUpperCase() || '?'}
                  </div>
                  <div>
                    <p className="text-sm text-text-primary">{inv.email}</p>
                    <p className="text-[13px] capitalize text-text-secondary">{inv.role ?? 'member'} — pending</p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => copyLink(inv.id)}
                  className="border border-border px-2.5 py-1 text-[13px] font-medium text-text-primary transition-colors hover:bg-surface"
                >
                  {copiedId === inv.id ? 'Copied' : 'Copy link'}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {teamId && canDeleteWorkspace && (
        <DangerZone
          teamId={teamId}
          onPro={usage?.billingEnabled === true && usage?.selfHosted !== true && usage?.plan === 'pro'}
        />
      )}
    </div>
  )
}

function DangerZone({ teamId, onPro }: { teamId: string; onPro: boolean }) {
  const [open, setOpen] = useState(false)
  const [confirmText, setConfirmText] = useState('')

  const deleteOrg = useMutation({
    mutationFn: () => api.team.deleteOrganization(teamId),
    onSuccess: () => {
      toast.success('Workspace deleted')
      // Full reload so the root route re-resolves the active workspace
      window.location.href = '/dashboard'
    },
    onError: (err) =>
      toast.error(err instanceof Error ? err.message : 'Failed to delete workspace'),
  })

  return (
    <div className="border border-error-border">
      <div className="border-b border-error-border px-6 py-5">
        <h2 className="font-display text-lg font-semibold text-text-primary">Danger zone</h2>
        <p className="mt-1 max-w-2xl text-sm text-text-secondary">
          Permanently delete this workspace and everything in it — products, campaigns,
          coupons, API keys, integrations, and analytics. Owner only. This cannot be undone.
          {onPro && ' Cancel the Pro subscription under Billing first: deleting is refused while it is set to renew.'}
        </p>
      </div>
      <div className="px-6 py-4">
        {!open ? (
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="border border-error-border px-4 py-2 text-[13px] font-medium text-error transition-colors hover:bg-error-light"
          >
            Delete workspace
          </button>
        ) : (
          <div>
            <p className="text-sm text-text-secondary">
              Type <span className="font-mono font-semibold text-text-primary">DELETE</span> to confirm.
            </p>
            <div className="mt-2 flex flex-wrap gap-2">
              <input
                value={confirmText}
                onChange={(e) => setConfirmText(e.target.value)}
                placeholder="DELETE"
                className="border border-control bg-bg px-3 py-2 font-mono text-sm text-text-primary placeholder:text-text-muted focus:border-error focus:outline-none"
              />
              <button
                type="button"
                disabled={confirmText !== 'DELETE' || deleteOrg.isPending}
                onClick={() => deleteOrg.mutate()}
                className={btnPrimary}
              >
                {deleteOrg.isPending ? 'Deleting…' : 'Permanently delete'}
              </button>
              <button
                type="button"
                onClick={() => {
                  setOpen(false)
                  setConfirmText('')
                }}
                className={btnSecondary}
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// ── Member row + product-access editor ──────────────────────────────────────

function MemberRow({
  member,
  teamId,
  products,
  canManage,
}: {
  member: TeamMember
  teamId: string
  products: Product[]
  canManage: boolean
}) {
  const [editing, setEditing] = useState(false)

  return (
    <li className="border-b border-border last:border-b-0">
      <div className="flex items-center justify-between px-6 py-4">
        <div className="flex items-center gap-3">
          {member.image ? (
            <img src={member.image} alt="" className="h-9 w-9 rounded-full object-cover" />
          ) : (
            <div className="flex h-9 w-9 items-center justify-center rounded-full bg-text-primary text-sm font-medium text-inverted-text">
              {member.name?.charAt(0)?.toUpperCase() || member.email?.charAt(0)?.toUpperCase() || '?'}
            </div>
          )}
          <div>
            <p className="text-sm font-medium text-text-primary">{member.name || 'User'}</p>
            <p className="text-[13px] text-text-secondary">{member.email}</p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          {canManage && (
            <button
              type="button"
              onClick={() => setEditing((v) => !v)}
              className="border border-border px-2.5 py-1 text-[13px] font-medium text-text-primary transition-colors hover:bg-surface"
            >
              {editing ? 'Close' : 'Manage access'}
            </button>
          )}
          <span className="bg-surface px-2.5 py-0.5 text-xs font-medium capitalize text-text-secondary">
            {member.role}
          </span>
        </div>
      </div>
      {canManage && editing && (
        <MemberAccessEditor
          teamId={teamId}
          userId={member.userId}
          products={products}
          onClose={() => setEditing(false)}
        />
      )}
    </li>
  )
}

function MemberAccessEditor({
  teamId,
  userId,
  products,
  onClose,
}: {
  teamId: string
  userId: string
  products: Product[]
  onClose: () => void
}) {
  const queryClient = useQueryClient()

  const { data: access, isPending } = useQuery({
    queryKey: ['member-product-access', teamId, userId],
    queryFn: () => api.team.memberProductAccess(teamId, userId),
    enabled: !!teamId && !!userId,
  })

  const [allProducts, setAllProducts] = useState(true)
  const [selected, setSelected] = useState<Set<string>>(new Set())

  // Seed the form once the saved scope loads.
  useEffect(() => {
    if (access) {
      setAllProducts(access.allProducts)
      setSelected(new Set(access.productIds))
    }
  }, [access])

  const save = useMutation({
    mutationFn: () =>
      api.team.setMemberProductAccess(
        teamId,
        userId,
        allProducts ? { allProducts: true } : { productIds: Array.from(selected) },
      ),
    onSuccess: (res) => {
      queryClient.invalidateQueries({ queryKey: ['member-product-access', teamId, userId] })
      queryClient.invalidateQueries({ queryKey: ['org-members', teamId] })
      toast.success(
        res.allProducts
          ? 'Granted access to all products'
          : `Scoped to ${res.productIds.length} product${res.productIds.length !== 1 ? 's' : ''}`,
      )
      onClose()
    },
    onError: (err: any) => {
      toast.error(err?.message || 'Failed to update access')
    },
  })

  const toggleProduct = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  // An empty list is saved as it is: this member then has no products.
  const nothingSelected = !allProducts && selected.size === 0

  return (
    <div className="border-t border-border bg-surface px-6 py-4">
      {isPending ? (
        <div className="flex h-16 items-center justify-center">
          <div className="h-5 w-5 animate-spin rounded-full border-4 border-border border-t-brand" />
        </div>
      ) : (
        <>
          <label className="flex items-center gap-2 text-sm text-text-primary">
            <input
              type="checkbox"
              checked={allProducts}
              onChange={(e) => setAllProducts(e.target.checked)}
              className="accent-brand"
            />
            Access to all products
          </label>

          {!allProducts && (
            <div className="mt-3">
              <p className="mb-1.5 text-[13px] font-medium text-text-secondary">
                Limit to specific products
              </p>
              {products.length === 0 ? (
                <p className="text-[13px] text-text-secondary">
                  No products yet — create products to scope access.
                </p>
              ) : (
                <div className="max-h-56 overflow-y-auto border border-border">
                  {products.map((p) => (
                    <label
                      key={p.id}
                      className="flex cursor-pointer items-center gap-3 border-b border-border px-4 py-2.5 last:border-b-0 hover:bg-bg"
                    >
                      <input
                        type="checkbox"
                        checked={selected.has(p.id)}
                        onChange={() => toggleProduct(p.id)}
                        className="accent-brand"
                      />
                      <span className="text-sm text-text-primary">{p.name}</span>
                    </label>
                  ))}
                </div>
              )}
            </div>
          )}

          <div className="mt-4 flex items-center gap-3">
            <button
              type="button"
              onClick={() => save.mutate()}
              disabled={save.isPending}
              className={btnPrimary}
            >
              {save.isPending ? 'Saving…' : 'Save access'}
            </button>
            <button
              type="button"
              onClick={onClose}
              className={btnSecondary}
            >
              Cancel
            </button>
            {nothingSelected && (
              <span className="text-[13px] text-text-secondary">
                With no products selected, this member can't see any products.
              </span>
            )}
          </div>
        </>
      )}
    </div>
  )
}

// ── Billing Tab ──────────────────────────────────────────────────────────────

const FREE = PLAN_LIMITS.free
const PRO_MONTHLY = PLAN_PRICES_USD.pro.month

const PLAN_METADATA = {
  free: {
    name: 'Free',
    description: `${formatLimit(FREE.products)} product, ${formatLimit(FREE.apiHitsPerMonth)} API calls/month, ${formatLimit(FREE.teamMembers)} team member, ${FREE.analyticsRetentionDays}-day analytics. The banner shows "Powered by GoPayLocal".`,
  },
  pro: {
    name: 'Pro',
    description: `Unlimited products and team members, ${PRO_FAIR_USE_API_HITS_PER_MONTH / 1_000_000} million API calls a month, ${PLAN_LIMITS.pro.analyticsRetentionDays}-day analytics with export, no GoPayLocal branding.`,
  },
} as const

/** How long the page keeps checking for Pro after the buyer comes back from checkout. */
const CONFIRM_WINDOW_MS = 120_000

function BillingTab({ returnedFromCheckout }: { returnedFromCheckout: boolean }) {
  const { data: session } = useSession()
  const teamId = getActiveTeamId(session)
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  // Everyone sees the plan and usage; only billing.manage (the owner) changes it.
  const canManageBilling = usePermissions().can('billing.manage')

  // Pro is granted by Dodo's webhook, not by the redirect, so the buyer can be
  // back before it lands. Until then, check again every 3 seconds for 2 minutes.
  const [confirmStartedAt] = useState(() => Date.now())
  const [confirmTimedOut, setConfirmTimedOut] = useState(false)
  const confirming = returnedFromCheckout && !confirmTimedOut

  const { data: billing, isPending, error } = useQuery({
    queryKey: ['billing', teamId],
    queryFn: () => api.billing.get(teamId),
    enabled: !!teamId,
    refetchInterval: (query) => (confirming && query.state.data?.effectivePlan !== 'pro' ? 3000 : false),
  })

  const { data: usage } = useQuery({
    queryKey: ['billing-usage', teamId],
    queryFn: () => api.billing.usage(teamId),
    enabled: !!teamId,
  })

  const confirmedPro = billing?.effectivePlan === 'pro'
  useEffect(() => {
    if (!returnedFromCheckout) return
    if (confirmedPro) {
      toast.success("You're on Pro", { description: 'Thanks for subscribing. Your limits are lifted.' })
      // Every limit and the banner branding change with the plan.
      queryClient.invalidateQueries({ queryKey: ['billing-usage', teamId] })
      navigate({ to: '/dashboard/settings', search: { tab: 'billing' }, replace: true })
      return
    }
    const left = CONFIRM_WINDOW_MS - (Date.now() - confirmStartedAt)
    if (left <= 0) {
      setConfirmTimedOut(true)
      return
    }
    const timer = setTimeout(() => setConfirmTimedOut(true), left)
    return () => clearTimeout(timer)
  }, [returnedFromCheckout, confirmedPro, confirmStartedAt, navigate, queryClient, teamId])

  const createCheckout = useMutation({
    mutationFn: () => api.billing.createCheckout(teamId),
    onSuccess: ({ checkoutUrl }) => {
      window.location.href = checkoutUrl
    },
    onError: (err) => {
      // e.g. "This organization already has Pro. Use Manage Billing to change it."
      toast.error(err instanceof Error && err.message ? err.message : 'Could not open checkout — try again')
    },
  })

  const openPortal = useMutation({
    mutationFn: () => api.billing.createPortal(teamId),
    onSuccess: ({ portalUrl }) => {
      window.location.href = portalUrl
    },
    onError: () => {
      toast.error('Could not open billing portal — try again')
    },
  })

  // The effective plan decides what's shown: a lapsed Pro subscription is Free
  // again (and can resubscribe), while a canceled-but-still-paid one is Pro.
  const plan = billing?.effectivePlan ?? usage?.plan ?? billing?.plan ?? 'free'
  const planData = PLAN_METADATA[plan]
  const isPro = plan === 'pro'
  const hasBillingAccount = !!billing?.dodoCustId
  // The visitor's Pro price where it is lower than the list price (useRegionalProPrice).
  const regional = useRegionalProPrice(!isPending && !isPro)
  const proLabel = regional ? formatCharge(regional.amount, regional.currency) : `$${PRO_MONTHLY}`
  // What a Pro workspace pays, as Dodo reported it.
  const paying =
    isPro && typeof billing?.recurringAmount === 'number' && billing.currency
      ? formatCharge(minorToMajor(billing.recurringAmount, billing.currency), billing.currency)
      : null

  // While usage loads, fall back to the plan's published caps. Checked with a
  // ternary, not `??`, because an unlimited cap is null and must stay null.
  const fallback = PLAN_LIMITS[plan]
  const meters = usage?.meters ?? {
    products: { current: 0, max: fallback.products },
    apiHits: { current: 0, max: fallback.apiHitsPerMonth },
    teamMembers: { current: 0, max: fallback.teamMembers },
  }

  const now = new Date()
  const monthLabel = `1 to ${now.getUTCDate()} ${now.toLocaleDateString('en-GB', { month: 'long', timeZone: 'UTC' })}`

  return (
    <div className="flex flex-col gap-6">
      {returnedFromCheckout && !confirmedPro && (
        <div role="status" className="flex items-start gap-3 border border-border bg-panel px-4 py-3">
          {confirming ? (
            <span aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-border border-t-text-primary" />
          ) : (
            <ToneIcon tone="warn" className="mt-0.5 h-4 w-4" />
          )}
          <p className="text-[13px] text-text-primary">
            {confirming
              ? 'Payment received. Waiting for Dodo Payments to confirm it; this page updates on its own, usually within a minute.'
              : "Dodo Payments hasn't confirmed the payment yet. Refresh this page in a few minutes. If you still see Free, contact us and include the email you paid with."}
          </p>
        </div>
      )}

      <section aria-labelledby="plan-title" className="border border-border bg-panel">
        <div className="flex flex-wrap items-start justify-between gap-4 px-6 py-5">
          <div className="flex max-w-[600px] flex-col gap-1.5">
            <span className="text-xs font-semibold uppercase tracking-[0.08em] text-text-muted">Current plan</span>
            <div className="flex flex-wrap items-baseline gap-3">
              <h2 id="plan-title" className="font-display text-[28px] font-semibold text-text-primary">
                {planData.name}
              </h2>
              <span className="text-sm text-text-secondary">{isPro ? `${paying ?? `$${PRO_MONTHLY}`} a month` : '$0'}</span>
              {!isPending && billing?.status && isPro && (
                <span className="inline-flex items-center gap-1.5 text-[13px] capitalize text-text-secondary">
                  <ToneIcon tone={billing.status === 'active' ? 'ok' : 'warn'} />
                  {billing.status}
                </span>
              )}
            </div>
            <p className="text-[13px] text-text-secondary">{planData.description}</p>
          </div>
          {canManageBilling && (isPro || hasBillingAccount) && (
            <button type="button" onClick={() => openPortal.mutate()} disabled={openPortal.isPending || !teamId} className={btnSecondary}>
              Manage billing
            </button>
          )}
        </div>
        {isPro && (
          <p className="border-t border-border px-6 py-3 text-[13px] text-text-muted">
            Billed monthly through Dodo Payments. Manage billing opens their billing portal, where you change or cancel
            the subscription.
          </p>
        )}
        {error && (
          <div className="border-t border-border px-6 py-3">
            <ErrorText>Couldn't load the billing details. Refresh the page to try again.</ErrorText>
          </div>
        )}
      </section>

      <section aria-labelledby="usage-title" className="border border-border bg-panel">
        <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-border px-6 py-3.5">
          <h2 id="usage-title" className="text-xs font-semibold uppercase tracking-[0.08em] text-text-secondary">
            Usage this month
          </h2>
          <span className="text-[13px] text-text-muted">{monthLabel}</span>
        </div>
        <div className="grid grid-cols-1 gap-px bg-border md:grid-cols-3">
          <UsageMeter
            label="Products"
            current={meters.products.current}
            max={meters.products.max}
            note={meters.products.max === null ? 'No limit on Pro.' : 'Pro has unlimited products.'}
          />
          <UsageMeter
            label="API calls"
            current={meters.apiHits.current}
            max={meters.apiHits.max}
            included={isPro ? PRO_FAIR_USE_API_HITS_PER_MONTH : undefined}
            note={
              isPro
                ? `Need more than ${PRO_FAIR_USE_API_HITS_PER_MONTH / 1_000_000} million a month? Contact us.`
                : meters.apiHits.max !== null
                  ? `Live calls only. At ${formatLimit(meters.apiHits.max)} the banner shows nothing until the 1st (UTC).`
                  : undefined
            }
          />
          <UsageMeter
            label="Team members"
            current={meters.teamMembers.current}
            max={meters.teamMembers.max}
            note={meters.teamMembers.max === null ? 'No limit on Pro.' : 'Pro has unlimited members.'}
            // A solo workspace sits at 1 of 1 from the start: not a warning.
            warnAtLimit={false}
          />
        </div>
      </section>

      {!isPro && (
        <section aria-labelledby="compare-title" className="border border-border bg-panel">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-6 py-3.5">
            <h2 id="compare-title" className="text-xs font-semibold uppercase tracking-[0.08em] text-text-secondary">
              Free and Pro
            </h2>
            {canManageBilling && (
              <button type="button" onClick={() => createCheckout.mutate()} disabled={createCheckout.isPending || !teamId} className={btnPrimary}>
                Upgrade to Pro · {proLabel}/mo
              </button>
            )}
          </div>
          {regional && (
            <p className="flex items-start gap-2.5 border-b border-border px-6 py-3 text-[13px] text-text-primary">
              <ToneIcon tone="ok" className="mt-0.5 h-3.5 w-3.5" />
              <span>
                Pro is {proLabel} a month in {regional.countryName}
                {regional.discount !== null ? `, ${regional.discount}% off the $${PRO_MONTHLY} list price` : ''}.
                Checkout charges this price when your billing address is in {regional.countryName}.
              </span>
            </p>
          )}
          {/* A Free workspace that used up products or this month's API calls
              hears it here first. Team seats are left out: a solo user sits at
              1 of 1, which isn't a limit worth calling out. */}
          {usage && atConsumptionLimit(usage) && (
            <p className="flex items-start gap-2.5 border-b border-border bg-warning-light px-6 py-3 text-[13px] text-text-primary">
              <ToneIcon tone="warn" className="mt-0.5 h-3.5 w-3.5" />
              You've reached a Free plan limit. Pro lifts it.
            </p>
          )}
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs text-text-muted">
                <th scope="col" className="px-6 py-2.5 font-semibold">
                  <span className="sr-only">Limit</span>
                </th>
                <th scope="col" className="px-4 py-2.5 font-semibold">Free</th>
                <th scope="col" className="px-6 py-2.5 font-semibold text-text-primary">Pro</th>
              </tr>
            </thead>
            <tbody>
              {[
                ['Products', formatLimit(FREE.products), 'Unlimited'],
                ['API calls a month', formatLimit(FREE.apiHitsPerMonth), `${PRO_FAIR_USE_API_HITS_PER_MONTH / 1_000_000} million, contact us for more`],
                ['Team members', formatLimit(FREE.teamMembers), 'Unlimited'],
                ['Analytics history', `${FREE.analyticsRetentionDays} days`, `${PLAN_LIMITS.pro.analyticsRetentionDays} days`],
                ['GoPayLocal link on the banner', 'Shown', 'Removed'],
              ].map(([label, free, pro]) => (
                <tr key={label} className="border-b border-border">
                  <th scope="row" className="px-6 py-2.5 text-left font-normal text-text-secondary">{label}</th>
                  <td className="px-4 py-2.5 text-text-primary">{free}</td>
                  <td className="px-6 py-2.5 text-text-primary">{pro}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="px-6 py-3 text-[13px] text-text-muted">Every feature is on both plans. Pro is billed monthly; cancel any time.</p>
        </section>
      )}
    </div>
  )
}

// True when a consumption meter (products or monthly API hits) is at/over a
// finite cap — the upgrade trigger. Unlimited meters (null) never trip it.
// Excludes team seats (see nudge comment above). Guards against an old-shape
// response missing `meters` during a deploy window.
function atConsumptionLimit(usage: UsageInfo): boolean {
  const m = usage.meters
  if (!m) return false
  return (['products', 'apiHits'] as const).some((k) => hasReachedLimit(m[k].current, m[k].max))
}

function UsageMeter({
  label,
  current,
  max: cap,
  included,
  note,
  warnAtLimit = true,
}: {
  label: string
  current: number
  max: Limit
  /**
   * A published allowance for a meter the server does not cap (hosted Pro's
   * API calls). Shown like a cap; reaching it blocks nothing.
   */
  included?: number
  note?: string
  warnAtLimit?: boolean
}) {
  const max = cap ?? included ?? null
  const percentage = max === null ? 0 : max > 0 ? Math.min((current / max) * 100, 100) : 100
  // Amber once a real cap is nearly used up; an allowance that blocks nothing stays green.
  const bar = warnAtLimit && cap !== null && percentage >= 80 ? 'bg-warning' : 'bg-success'
  const of = max === null ? 'unlimited' : included !== undefined && cap === null ? `of ${formatAllowance(max)} included` : `of ${formatLimit(max)}`

  return (
    <div className="flex flex-col gap-2 bg-panel px-6 py-4">
      <span className="text-[13px] text-text-secondary">{label}</span>
      <span className="font-display text-2xl font-semibold tabular-nums text-text-primary">
        {current.toLocaleString()} <span className="font-body text-[13px] font-normal text-text-muted">{of}</span>
      </span>
      <span aria-hidden="true" className="block h-1.5 bg-tile">
        {max !== null && <span className={`block h-1.5 ${bar}`} style={{ width: `${Math.max(percentage, current > 0 ? 1 : 0)}%` }} />}
      </span>
      {note && <span className="text-xs text-text-muted">{note}</span>}
    </div>
  )
}

/** "20 million" rather than "20,000,000". */
function formatAllowance(n: number): string {
  return n >= 1_000_000 && n % 1_000_000 === 0 ? `${n / 1_000_000} million` : n.toLocaleString()
}

// ── API Keys Tab ─────────────────────────────────────────────────────────────

function ApiKeysTab() {
  const queryClient = useQueryClient()
  const { data: session } = useSession()
  const teamId = getActiveTeamId(session)

  const [showCreate, setShowCreate] = useState(false)
  const [keyName, setKeyName] = useState('')
  const [keyType, setKeyType] = useState<'public' | 'secret'>('public')
  const [newKey, setNewKey] = useState<string | null>(null)
  // Everyone sees the keys (members need the public key for the snippet);
  // creating and revoking is apiKeys.manage (owner and admin).
  const canManageKeys = usePermissions().can('apiKeys.manage')

  const { data: apiKeys = [], isPending } = useQuery({
    queryKey: ['api-keys', teamId],
    queryFn: () => api.team.apiKeys(teamId),
    enabled: !!teamId,
  })

  const createKey = useMutation({
    mutationFn: () => api.team.createApiKey(teamId, { name: keyName, keyType }),
    onSuccess: (data) => {
      setNewKey(data.key)
      setShowCreate(false)
      setKeyName('')
      queryClient.invalidateQueries({ queryKey: ['api-keys', teamId] })
    },
    onError: (err) => {
      toast.error('Failed to create API key', {
        description: err.message || 'Please try again.',
      })
    },
  })

  const deleteKey = useMutation({
    mutationFn: (keyId: string) => api.team.deleteApiKey(teamId, keyId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['api-keys', teamId] })
    },
    onError: (err) => {
      toast.error('Failed to revoke API key', {
        description: err.message || 'Please try again.',
      })
    },
  })

  return (
    <div className="space-y-6">
      {/* Newly created key notice */}
      {newKey && (
        <div className="border border-success/40 bg-success-light p-4">
          <p className="text-sm font-semibold text-success">
            API key created — copy it now. This is the only time it will be shown.
          </p>
          <div className="mt-2.5 flex items-center gap-2">
            <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap border border-border bg-bg px-3 py-1.5 font-mono text-sm text-text-primary">
              {newKey}
            </code>
            <button
              type="button"
              onClick={() => navigator.clipboard.writeText(newKey)}
              className="shrink-0 bg-success px-3 py-1.5 text-[13px] font-medium text-inverted-text hover:bg-success/90"
            >
              Copy
            </button>
          </div>
          <button
            type="button"
            onClick={() => setNewKey(null)}
            className="mt-2.5 text-[13px] text-text-secondary underline hover:text-text-primary"
          >
            Dismiss
          </button>
        </div>
      )}

      <div className="border border-border bg-panel">
        <div className="flex items-center justify-between border-b border-border px-6 py-5">
          <div>
            <h2 className="font-display text-lg font-semibold text-text-primary">API keys</h2>
            <p className="mt-1 text-[13px] text-text-secondary">
              Use these keys to authenticate API requests.
            </p>
          </div>
          {canManageKeys && (
            <button
              type="button"
              onClick={() => setShowCreate(true)}
              className={btnPrimary}
            >
              Create key
            </button>
          )}
        </div>

        {/* Create Key Form */}
        {canManageKeys && showCreate && (
          <div className="border-b border-border bg-surface px-6 py-4">
            <div className="flex items-end gap-3">
              <div className="flex-1">
                <label htmlFor="keyName" className="block text-sm font-medium text-text-primary">
                  Key Name
                </label>
                <input
                  id="keyName"
                  type="text"
                  value={keyName}
                  onChange={(e) => setKeyName(e.target.value)}
                  placeholder="e.g. Production"
                  className="mt-1 block w-full border border-control px-3 py-1.5 text-sm text-text-primary focus:border-brand focus:outline-none"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-text-primary">
                  Type
                </label>
                <Select value={keyType} onValueChange={(v) => setKeyType(v as 'public' | 'secret')}>
                  <SelectTrigger className="mt-1 w-[120px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      <SelectItem value="public">Public</SelectItem>
                      <SelectItem value="secret">Secret</SelectItem>
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </div>
              <button
                type="button"
                onClick={() => createKey.mutate()}
                disabled={!keyName || createKey.isPending}
                className={btnPrimary}
              >
                {createKey.isPending ? 'Creating…' : 'Create'}
              </button>
              <button
                type="button"
                onClick={() => {
                  setShowCreate(false)
                  setKeyName('')
                }}
                className={btnSecondary}
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {/* Keys List */}
        {isPending ? (
          <div className="flex h-48 items-center justify-center">
            <div className="h-6 w-6 animate-spin rounded-full border-4 border-border border-t-brand" />
          </div>
        ) : apiKeys.length === 0 ? (
          <div className="flex h-48 flex-col items-center justify-center px-6 text-center">
            <p className="text-base font-medium text-text-primary">No API keys yet</p>
            <p className="mt-1.5 max-w-md text-sm text-text-secondary">
              You need a public key for the browser embed snippet, and a secret key for
              server-to-server calls.{' '}
              {canManageKeys
                ? 'Create one with "Create key" above — the secret is shown only once.'
                : 'Ask the workspace owner or an admin to create one.'}
            </p>
          </div>
        ) : (
          <table className="min-w-full">
            <thead>
              <tr className="border-b border-border bg-surface">
                <th className="px-6 py-3 text-left text-[13px] font-semibold text-text-secondary">Name</th>
                <th className="px-6 py-3 text-left text-[13px] font-semibold text-text-secondary">Key</th>
                <th className="px-6 py-3 text-left text-[13px] font-semibold text-text-secondary">Type</th>
                <th className="px-6 py-3 text-left text-[13px] font-semibold text-text-secondary">Created</th>
                <th className="px-6 py-3 text-left text-[13px] font-semibold text-text-secondary">Created by</th>
                <th className="px-6 py-3 text-left text-[13px] font-semibold text-text-secondary">Last used</th>
                <th className="px-6 py-3" />
              </tr>
            </thead>
            <tbody>
              {apiKeys.map((key: ApiKey) => (
                <tr key={key.id} className="border-b border-border last:border-b-0 hover:bg-surface">
                  <td className="whitespace-nowrap px-6 py-4 text-sm font-medium text-text-primary">
                    {key.name}
                  </td>
                  <td className="whitespace-nowrap px-6 py-4 font-mono text-sm text-text-primary">
                    {/* The API's keyPrefix already ends in "..." (routes/api-keys.ts). */}
                    {key.keyPrefix}
                  </td>
                  <td className="whitespace-nowrap px-6 py-4">
                    <span
                      className={`px-2 py-0.5 text-xs font-medium ${
                        key.keyType === 'secret'
                          ? 'border border-control text-text-primary'
                          : 'bg-surface text-text-secondary'
                      }`}
                    >
                      {key.keyType}
                    </span>
                  </td>
                  <td className="whitespace-nowrap px-6 py-4 font-mono text-sm tabular-nums text-text-secondary">
                    {new Date(key.createdAt).toLocaleDateString()}
                  </td>
                  <td className="whitespace-nowrap px-6 py-4 text-sm text-text-secondary">
                    {/* Null for keys created before this was recorded, or whose creator's account was deleted. */}
                    {key.createdBy ? (key.createdBy.name ?? 'Unnamed user') : 'Unknown'}
                  </td>
                  <td className="whitespace-nowrap px-6 py-4 font-mono text-sm tabular-nums text-text-secondary">
                    {key.lastUsedAt
                      ? new Date(key.lastUsedAt).toLocaleDateString()
                      : 'Never'}
                  </td>
                  <td className="whitespace-nowrap px-6 py-4 text-right">
                    {canManageKeys && (
                      <button
                        type="button"
                        onClick={() => deleteKey.mutate(key.id)}
                        disabled={deleteKey.isPending}
                        className="text-[13px] font-medium text-brand-text hover:underline disabled:opacity-50"
                      >
                        Revoke
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {teamId && <SecretKeyUsage teamId={teamId} />}
    </div>
  )
}

// What a secret key is for, the workspace id it needs, and one request to copy.
// The example names an environment variable, never a real key.
function SecretKeyUsage({ teamId }: { teamId: string }) {
  const [copied, setCopied] = useState<'id' | 'curl' | null>(null)
  // Same base as the banner snippet (campaigns/$id.tsx): this dashboard's own
  // API when VITE_API_URL is set (self-hosted), else the hosted service.
  const HOSTED_API = 'https://api.gopaylocal.com'
  const apiBase = (import.meta.env.VITE_API_URL || HOSTED_API).replace(/\/+$/, '')
  const curlExample = [
    `curl ${apiBase}/v1/teams/${teamId}/products \\`,
    `  -H "Authorization: Bearer $GOPAYLOCAL_SECRET_KEY"`,
  ].join('\n')

  const copy = (what: 'id' | 'curl', text: string) => {
    navigator.clipboard.writeText(text)
    setCopied(what)
    setTimeout(() => setCopied(null), 2000)
  }

  return (
    <div className="border border-border bg-panel">
      <div className="border-b border-border px-6 py-5">
        <h2 className="font-display text-lg font-semibold text-text-primary">Calling the API from your server</h2>
        <p className="mt-1 text-[13px] text-text-secondary">
          Send a secret key as a Bearer token. It can work on this workspace's products, campaigns, A/B
          tests, banners, parity groups and analytics. It can't manage the team, billing, API keys or
          integration connections. Keep it on your server and never put it in a web page.
        </p>
      </div>
      <div className="space-y-4 px-6 py-5">
        <div>
          <p className="text-sm font-medium text-text-primary">Workspace ID</p>
          <div className="mt-1.5 flex items-center gap-2">
            <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap border border-border bg-bg px-3 py-1.5 font-mono text-sm text-text-primary">
              {teamId}
            </code>
            <button
              type="button"
              onClick={() => copy('id', teamId)}
              className={`${btnSecondary} h-9 shrink-0`}
            >
              {copied === 'id' ? 'Copied' : 'Copy'}
            </button>
          </div>
        </div>
        <div>
          <p className="text-sm font-medium text-text-primary">Example: list products</p>
          <div className="mt-1.5 flex items-start gap-2">
            <pre className="min-w-0 flex-1 overflow-x-auto border border-border bg-bg px-3 py-2 font-mono text-[13px] text-text-primary">
              {curlExample}
            </pre>
            <button
              type="button"
              onClick={() => copy('curl', curlExample)}
              className={`${btnSecondary} h-9 shrink-0`}
            >
              {copied === 'curl' ? 'Copied' : 'Copy'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
