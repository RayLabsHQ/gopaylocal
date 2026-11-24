import { createFileRoute } from '@tanstack/react-router'
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

type Tab = 'team' | 'billing' | 'api-keys'

const VALID_TABS: Tab[] = ['team', 'billing', 'api-keys']

function isValidTab(value: unknown): value is Tab {
  return typeof value === 'string' && VALID_TABS.includes(value as Tab)
}

export const Route = createFileRoute('/dashboard/settings/')({
  validateSearch: (search: Record<string, unknown>) =>
    isValidTab(search.tab) ? { tab: search.tab } : {},
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
    ...(selfHosted ? [] : [{ id: 'billing' as const, label: 'Billing' }]),
    { id: 'api-keys', label: 'API Keys' },
  ]

  return (
    <div>
      <h1 className="font-display text-4xl font-medium tracking-tight text-text-primary">
        Settings
      </h1>
      <p className="mt-1 text-base text-text-secondary">
        Manage your account, API keys and team
      </p>

      {/* Tabs */}
      <div className="mt-6 border-b border-border">
        <nav className="-mb-px flex gap-6">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActiveTab(tab.id)}
              className={`whitespace-nowrap border-b-2 pb-3 text-sm font-medium transition-colors ${
                activeTab === tab.id
                  ? 'border-brand font-display text-brand-text'
                  : 'border-transparent text-text-secondary hover:text-text-primary'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </nav>
      </div>

      {/* Tab Content */}
      <div className="mt-6">
        {activeTab === 'team' && <TeamTab onGoToBilling={() => setActiveTab('billing')} />}
        {activeTab === 'billing' && !selfHosted && <BillingTab />}
        {activeTab === 'api-keys' && <ApiKeysTab />}
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
      <div className="border border-border">
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
              className="bg-brand px-4 py-1.5 text-[13px] font-medium text-white transition-colors hover:bg-brand/90 disabled:opacity-50"
            >
              Invite Member
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
                  className="mt-1 block w-full border border-border px-3 py-1.5 text-sm text-text-primary focus:border-brand focus:outline-none"
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
                className="bg-brand px-4 py-1.5 text-sm font-medium text-white transition-colors hover:bg-brand/90 disabled:opacity-50"
              >
                {inviteStatus === 'sending' ? 'Sending...' : inviteStatus === 'sent' ? 'Sent!' : 'Send Invite'}
              </button>
              <button
                type="button"
                onClick={() => { setShowInvite(false); setInviteEmail(''); setInviteStatus('idle') }}
                className="border border-border px-4 py-1.5 text-sm font-medium text-text-primary hover:bg-surface"
              >
                Cancel
              </button>
            </div>
            {inviteStatus === 'error' && (
              <p className="mt-2 text-[13px] text-brand-text">{inviteError}</p>
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
                      {copiedId === lastInviteId ? 'Copied!' : 'Copy Link'}
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
        <div className="border border-border">
          <div className="border-b border-border px-6 py-5">
            <h2 className="font-display text-lg font-semibold text-text-primary">Pending Invitations</h2>
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
                  {copiedId === inv.id ? 'Copied!' : 'Copy Link'}
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
    <div className="border border-red-500/40">
      <div className="border-b border-red-500/40 px-6 py-5">
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
            className="border border-red-500 px-4 py-2 text-[13px] font-medium text-red-500 transition-colors hover:bg-red-500/10"
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
                className="border border-border bg-bg px-3 py-2 font-mono text-sm text-text-primary placeholder:text-text-muted focus:border-red-500 focus:outline-none"
              />
              <button
                type="button"
                disabled={confirmText !== 'DELETE' || deleteOrg.isPending}
                onClick={() => deleteOrg.mutate()}
                className="bg-red-600 px-4 py-2 text-[13px] font-medium text-white disabled:opacity-50"
              >
                {deleteOrg.isPending ? 'Deleting…' : 'Permanently delete'}
              </button>
              <button
                type="button"
                onClick={() => {
                  setOpen(false)
                  setConfirmText('')
                }}
                className="border border-border px-4 py-2 text-[13px] font-medium text-text-primary"
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
              className="bg-brand px-4 py-1.5 text-sm font-medium text-white transition-colors hover:bg-brand/90 disabled:opacity-50"
            >
              {save.isPending ? 'Saving...' : 'Save access'}
            </button>
            <button
              type="button"
              onClick={onClose}
              className="border border-border px-4 py-1.5 text-sm font-medium text-text-primary hover:bg-bg"
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

function BillingTab() {
  const { data: session } = useSession()
  const teamId = getActiveTeamId(session)
  // Everyone sees the plan and usage; only billing.manage (the owner) changes it.
  const canManageBilling = usePermissions().can('billing.manage')

  const { data: billing, isPending, error } = useQuery({
    queryKey: ['billing', teamId],
    queryFn: () => api.billing.get(teamId),
    enabled: !!teamId,
  })

  const { data: usage } = useQuery({
    queryKey: ['billing-usage', teamId],
    queryFn: () => api.billing.usage(teamId),
    enabled: !!teamId,
  })

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

  // While usage loads, fall back to the plan's published caps. Checked with a
  // ternary, not `??`, because an unlimited cap is null and must stay null.
  const fallback = PLAN_LIMITS[plan]
  const meters = usage?.meters ?? {
    products: { current: 0, max: fallback.products },
    apiHits: { current: 0, max: fallback.apiHitsPerMonth },
    teamMembers: { current: 0, max: fallback.teamMembers },
  }

  return (
    <div className="border border-border">
      <div className="border-b border-border px-6 py-5">
        <h2 className="font-display text-lg font-semibold text-text-primary">Billing & Plan</h2>
        <p className="mt-1 text-[13px] text-text-secondary">
          Manage your subscription and payment method.
        </p>
      </div>

      <div className="border-b border-border bg-surface px-6 py-5">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <p className="text-sm font-medium text-text-primary">Current Plan</p>
            <p className="mt-1 font-display text-2xl font-semibold text-text-primary">{planData.name}</p>
            <p className="mt-1.5 text-[13px] text-text-secondary">
              {planData.description}
            </p>
            {!isPending && billing?.status && (
              <p className="mt-2 text-[13px] capitalize text-text-secondary">
                Status: {billing.status}
              </p>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {canManageBilling && !isPro && (
              <button
                type="button"
                onClick={() => createCheckout.mutate()}
                disabled={createCheckout.isPending || !teamId}
                className="bg-brand px-4 py-2 text-[13px] font-medium text-white transition-colors hover:bg-brand/90 disabled:opacity-50"
              >
                Upgrade to Pro · ${PRO_MONTHLY}/mo
              </button>
            )}
            {canManageBilling && (isPro || hasBillingAccount) && (
              <button
                type="button"
                onClick={() => openPortal.mutate()}
                disabled={openPortal.isPending || !teamId}
                className={
                  isPro
                    ? 'bg-brand px-4 py-2 text-[13px] font-medium text-white transition-colors hover:bg-brand/90 disabled:opacity-50'
                    : 'border border-border px-4 py-2 text-[13px] font-medium text-text-primary transition-colors hover:bg-bg disabled:opacity-50'
                }
              >
                Manage Billing
              </button>
            )}
          </div>
        </div>
        {error && (
          <p className="mt-3 text-sm text-brand-text">
            Failed to load billing info. Please refresh and try again.
          </p>
        )}
      </div>

      <div className="px-6 py-5">
        <h3 className="font-display text-base font-semibold text-text-primary">Usage this month</h3>
        <div className="mt-4 space-y-4">
          <UsageMeter label="Products" current={meters.products.current} max={meters.products.max} />
          <UsageMeter
            label="API calls"
            current={meters.apiHits.current}
            max={meters.apiHits.max}
            included={isPro ? PRO_FAIR_USE_API_HITS_PER_MONTH : undefined}
          />
          <UsageMeter
            label="Team members"
            current={meters.teamMembers.current}
            max={meters.teamMembers.max}
          />
        </div>

        {/* Upgrade nudge — a Free org that has maxed out a consumption cap
            (products or monthly API hits) is the moment to convert. Team seats
            are excluded: a solo user sits at 1/1 by default, which isn't a
            meaningful "hit a limit" signal (the Team tab nudges on that). */}
        {usage && !isPro && atConsumptionLimit(usage) && (
          <div className="mt-5 flex flex-wrap items-center justify-between gap-4 border border-brand/30 bg-brand-light px-4 py-3">
            <p className="text-sm text-text-primary">
              You've hit a Free plan limit. Pro lifts it: unlimited products and team
              members and {PRO_FAIR_USE_API_HITS_PER_MONTH / 1_000_000} million API calls a
              month, for ${PRO_MONTHLY}/month.
            </p>
            {canManageBilling && (
              <button
                type="button"
                onClick={() => createCheckout.mutate()}
                disabled={createCheckout.isPending || !teamId}
                className="shrink-0 bg-brand px-3 py-1.5 text-[13px] font-medium text-white transition-colors hover:bg-brand/90 disabled:opacity-50"
              >
                Upgrade to Pro
              </button>
            )}
          </div>
        )}
      </div>
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
}: {
  label: string
  current: number
  max: Limit
  /**
   * A published allowance for a meter the server does not cap (hosted Pro's
   * API calls). Shown like a cap; reaching it blocks nothing.
   */
  included?: number
}) {
  const max = cap ?? included ?? null
  // Unlimited: show the count and "Unlimited", no bar (there is no ratio).
  if (max === null) {
    return (
      <div>
        <div className="flex justify-between text-[13px] text-text-secondary">
          <span>{label}</span>
          <span className="font-mono tabular-nums text-text-primary">
            {current.toLocaleString()} <span className="text-text-secondary">/ Unlimited</span>
          </span>
        </div>
      </div>
    )
  }

  const percentage = max > 0 ? Math.min((current / max) * 100, 100) : 100

  return (
    <div>
      <div className="flex justify-between text-[13px] text-text-secondary">
        <span>{label}</span>
        <span className="font-mono tabular-nums text-text-primary">
          {current.toLocaleString()} / {formatLimit(max)}
        </span>
      </div>
      <div className="mt-1 h-1.5 overflow-hidden bg-border">
        <div
          className={`h-1.5 transition-all ${
            percentage > 80 ? 'bg-brand' : 'bg-text-primary'
          }`}
          style={{ width: `${percentage}%` }}
        />
      </div>
    </div>
  )
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

      <div className="border border-border">
        <div className="flex items-center justify-between border-b border-border px-6 py-5">
          <div>
            <h2 className="font-display text-lg font-semibold text-text-primary">API Keys</h2>
            <p className="mt-1 text-[13px] text-text-secondary">
              Use these keys to authenticate API requests.
            </p>
          </div>
          {canManageKeys && (
            <button
              type="button"
              onClick={() => setShowCreate(true)}
              className="bg-brand px-4 py-1.5 text-[13px] font-medium text-white transition-colors hover:bg-brand/90"
            >
              Create Key
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
                  className="mt-1 block w-full border border-border px-3 py-1.5 text-sm text-text-primary focus:border-brand focus:outline-none"
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
                className="bg-brand px-4 py-1.5 text-sm font-medium text-white transition-colors hover:bg-brand/90 disabled:opacity-50"
              >
                {createKey.isPending ? 'Creating...' : 'Create'}
              </button>
              <button
                type="button"
                onClick={() => {
                  setShowCreate(false)
                  setKeyName('')
                }}
                className="border border-border px-4 py-1.5 text-sm font-medium text-text-primary hover:bg-surface"
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
                ? 'Create one with "Create Key" above — the secret is shown only once.'
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
                <th className="px-6 py-3 text-left text-[13px] font-semibold text-text-secondary">Created By</th>
                <th className="px-6 py-3 text-left text-[13px] font-semibold text-text-secondary">Last Used</th>
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
                          ? 'bg-brand-light text-brand-text'
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
    <div className="border border-border">
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
              className="shrink-0 border border-border px-3 py-1.5 text-[13px] font-medium text-text-primary hover:bg-surface"
            >
              {copied === 'id' ? 'Copied!' : 'Copy'}
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
              className="shrink-0 border border-border px-3 py-1.5 text-[13px] font-medium text-text-primary hover:bg-surface"
            >
              {copied === 'curl' ? 'Copied!' : 'Copy'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
