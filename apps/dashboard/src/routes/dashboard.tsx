import { createFileRoute, Outlet, Link, useNavigate } from '@tanstack/react-router'
import { useState, useRef, useEffect } from 'react'
import { signOut, useSession, getActiveTeamId, organization } from '~/lib/auth'
import { BrandMark } from '~/components/brand-mark'
import { EnvProvider, useEnv, type Env } from '~/lib/env'
import { ScrollArea } from '~/components/ui/scroll-area'
import { ToneIcon } from '~/components/ui/status'

export const Route = createFileRoute('/dashboard')({
  component: DashboardLayout,
})

const navigation = [
  { name: 'Overview', to: '/dashboard', icon: HomeIcon },
  { name: 'Products', to: '/dashboard/products', icon: CubeIcon },
  { name: 'Campaigns', to: '/dashboard/campaigns', icon: MegaphoneIcon },
  { name: 'A/B Tests', to: '/dashboard/experiments', icon: ChartIcon },
  { name: 'Integrations', to: '/dashboard/integrations', icon: PlugIcon },
  { name: 'Settings', to: '/dashboard/settings', icon: GearIcon },
] as const

function DashboardLayout() {
  const navigate = useNavigate()
  const { data: session, isPending } = useSession()

  if (isPending) {
    return (
      <div className="flex h-dvh items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-border border-t-brand" />
      </div>
    )
  }

  if (!session) {
    navigate({ to: '/login' })
    return null
  }

  const teamId = getActiveTeamId(session)
  if (!teamId) {
    navigate({ to: '/onboarding' })
    return null
  }

  const handleSignOut = async () => {
    await signOut()
    navigate({ to: '/login' })
  }

  return (
    <EnvProvider>
      <DashboardShell teamId={teamId} session={session} onSignOut={handleSignOut} />
    </EnvProvider>
  )
}

function DashboardShell({ teamId, session, onSignOut }: { teamId: string; session: any; onSignOut: () => void }) {
  const { env, setEnv } = useEnv()
  // Off-canvas sidebar state (mobile only — the sidebar is always visible at md+).
  const [mobileNavOpen, setMobileNavOpen] = useState(false)

  return (
    <div className="flex h-dvh font-body">
      {/* Mobile overlay — dims content and closes the drawer on tap. md:hidden. */}
      {mobileNavOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/50 md:hidden"
          onClick={() => setMobileNavOpen(false)}
          aria-hidden="true"
        />
      )}

      {/* Sidebar — static at md+, off-canvas slide-in below md. */}
      <aside
        className={`fixed inset-y-0 left-0 z-50 flex w-60 shrink-0 flex-col border-r border-border bg-bg transition-transform duration-200 md:static md:z-auto md:translate-x-0 ${
          mobileNavOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        {/* Logo */}
        <div className="flex items-center gap-2.5 px-6 py-6">
          <BrandMark className="h-7 w-7" />
          <span className="font-display text-lg font-semibold text-text-primary">
            GoPayLocal
          </span>
        </div>

        {/* Org Switcher */}
        <OrgSwitcher activeOrgId={teamId} />

        {/* Environment Toggle */}
        <EnvToggle env={env} setEnv={setEnv} />

        {/* Navigation */}
        <ScrollArea className="flex-1">
          <nav className="space-y-1 px-3">
            {navigation.map((item) => (
              <Link
                key={item.name}
                to={item.to}
                activeOptions={{ exact: item.to === '/dashboard' }}
                onClick={() => setMobileNavOpen(false)}
                className="flex items-center gap-3 px-3 py-2.5 text-sm text-text-secondary transition-colors hover:text-text-primary [&.active]:bg-tile [&.active]:font-semibold [&.active]:text-text-primary [&.active]:shadow-[inset_2px_0_0_var(--brand)]"
              >
                <item.icon className="h-[18px] w-[18px] shrink-0" />
                {item.name}
              </Link>
            ))}
          </nav>
        </ScrollArea>

        {/* User */}
        <div className="border-t border-border p-4">
          <div className="flex items-center gap-2.5">
            {session.user?.image ? (
              <img src={session.user.image as string} alt="" className="h-8 w-8 rounded-full object-cover" />
            ) : (
              <div className="flex h-8 w-8 items-center justify-center rounded-full bg-inverted text-xs font-medium text-inverted-text">
                {session.user?.name?.charAt(0)?.toUpperCase() || 'U'}
              </div>
            )}
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-text-primary">
                {session.user?.name || 'User'}
              </p>
              <p className="truncate text-xs text-text-secondary">
                {session.user?.email}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onSignOut}
            className="mt-3 w-full px-3 py-1.5 text-left text-sm text-text-secondary transition-colors hover:text-text-primary"
          >
            Sign out
          </button>
        </div>
      </aside>

      {/* Main column */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Mobile top bar with hamburger — md:hidden. Desktop is unchanged. */}
        <div className="flex items-center gap-3 border-b border-border bg-bg px-4 py-3 md:hidden">
          <button
            type="button"
            onClick={() => setMobileNavOpen(true)}
            aria-label="Open navigation"
            className="flex h-9 w-9 items-center justify-center border border-border text-text-secondary transition-colors hover:text-text-primary"
          >
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25h16.5" />
            </svg>
          </button>
          <div className="flex items-center gap-2">
            <BrandMark className="h-6 w-6" />
            <span className="font-display text-base font-semibold text-text-primary">GoPayLocal</span>
          </div>
        </div>

        {env === 'test' && <TestModeStrip />}

        {/* Main Content */}
        <ScrollArea className="flex-1 bg-bg">
          <div className="px-4 py-6 md:px-12 md:py-10">
            <Outlet />
          </div>
        </ScrollArea>
      </div>
    </div>
  )
}

// ── Org Switcher ────────────────────────────────────────────────────────────

function OrgSwitcher({ activeOrgId }: { activeOrgId: string }) {
  const [open, setOpen] = useState(false)
  const [orgs, setOrgs] = useState<Array<{ id: string; name: string; slug: string | null }>>([])
  const [loaded, setLoaded] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  // Close on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    if (open) document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  // Fetch orgs on mount so the active name is visible immediately
  useEffect(() => {
    if (!loaded) {
      organization.list().then((res) => {
        const data = res.data as any
        const list = Array.isArray(data) ? data : data?.organizations ?? data ?? []
        setOrgs(list)
        setLoaded(true)
      }).catch(() => setLoaded(true))
    }
  }, [loaded])

  const activeOrg = orgs.find((o) => o.id === activeOrgId)
  const activeOrgName = activeOrg?.name

  const handleSwitch = async (orgId: string) => {
    if (orgId === activeOrgId) {
      setOpen(false)
      return
    }
    await organization.setActive({ organizationId: orgId })
    setOpen(false)
    window.location.href = '/dashboard'
  }

  return (
    <div ref={ref} className="relative mx-3 mb-2">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex w-full items-center justify-between gap-2 border border-border px-3 py-2 text-left transition-colors hover:bg-surface"
      >
        <div className="flex items-center gap-2 truncate">
          <div className="flex h-5 w-5 shrink-0 items-center justify-center bg-tile text-[11px] font-bold text-text-primary">
            {(activeOrgName ?? 'W').charAt(0).toUpperCase()}
          </div>
          <span className="truncate text-[13px] font-medium text-text-primary">
            {activeOrgName ?? 'Workspace'}
          </span>
        </div>
        <svg className={`h-3.5 w-3.5 shrink-0 text-text-muted transition-transform ${open ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" d="m19.5 8.25-7.5 7.5-7.5-7.5" />
        </svg>
      </button>

      {open && (
        <div className="absolute left-0 right-0 z-50 mt-1 border border-border bg-bg shadow-lg">
          <div className="px-3 py-2">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-text-secondary">Workspaces</p>
          </div>
          {orgs.length === 0 && loaded && (
            <div className="px-3 py-2 text-[13px] text-text-secondary">No workspaces found</div>
          )}
          {!loaded && (
            <div className="flex items-center justify-center py-3">
              <div className="h-4 w-4 animate-spin rounded-full border-2 border-border border-t-brand" />
            </div>
          )}
          {orgs.map((org) => (
            <button
              key={org.id}
              type="button"
              onClick={() => handleSwitch(org.id)}
              className="flex w-full items-center justify-between px-3 py-2 text-left text-[13px] transition-colors hover:bg-surface"
            >
              <div className="flex items-center gap-2 truncate">
                <div className="flex h-5 w-5 shrink-0 items-center justify-center bg-tile text-[11px] font-bold text-text-primary">
                  {org.name.charAt(0).toUpperCase()}
                </div>
                <span className="truncate text-text-primary">{org.name}</span>
              </div>
              {org.id === activeOrgId && (
                <svg className="h-4 w-4 shrink-0 text-text-primary" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" d="m4.5 12.75 6 6 9-13.5" />
                </svg>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Environment Toggle ──────────────────────────────────────────────────────

function EnvToggle({ env, setEnv }: { env: Env; setEnv: (e: Env) => void }) {
  // Both modes look the same when selected: green would say "safe", and Live is
  // the mode that touches real customers. The strip above the page says Test.
  const option = (value: Env, label: string, extra = '') => (
    <button
      type="button"
      aria-pressed={env === value}
      onClick={() => setEnv(value)}
      className={`flex-1 px-3 py-1.5 text-center text-[12px] transition-colors ${extra} ${
        env === value
          ? 'bg-border font-semibold text-text-primary shadow-[inset_0_-2px_0_var(--text-1)]'
          : 'font-medium text-text-secondary hover:text-text-primary'
      }`}
    >
      {label}
    </button>
  )
  return (
    <div role="group" aria-label="Environment" className="mx-3 mb-3 flex overflow-hidden border border-border">
      {option('live', 'Live')}
      {option('test', 'Test', 'border-l border-border')}
    </div>
  )
}

function TestModeStrip() {
  return (
    <div role="status" className="flex items-center gap-2.5 border-b border-warning-border bg-warning-light px-4 py-2 text-[13px] text-text-primary md:px-12">
      <ToneIcon tone="warn" className="h-3.5 w-3.5" />
      <p>
        <span className="font-semibold text-warning">Test mode.</span> You're looking at test keys, products and
        campaigns. Nothing here reaches a real customer.
      </p>
    </div>
  )
}

// ── Icon Components ──────────────────────────────────────────────────────────

function HomeIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" d="m2.25 12 8.954-8.955a1.126 1.126 0 0 1 1.591 0L21.75 12M4.5 9.75v10.125c0 .621.504 1.125 1.125 1.125H9.75v-4.875c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125V21h4.125c.621 0 1.125-.504 1.125-1.125V9.75M8.25 21h8.25" />
    </svg>
  )
}

function CubeIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" d="m21 7.5-9-5.25L3 7.5m18 0-9 5.25m9-5.25v9l-9 5.25M3 7.5l9 5.25M3 7.5v9l9 5.25m0-9v9" />
    </svg>
  )
}

function MegaphoneIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" d="M10.34 15.84c-.688-.06-1.386-.09-2.09-.09H7.5a4.5 4.5 0 1 1 0-9h.75c.704 0 1.402-.03 2.09-.09m0 9.18c.253.962.584 1.892.985 2.783.247.55.06 1.21-.463 1.511l-.657.38a.954.954 0 0 1-1.14-.164 23.992 23.992 0 0 1-4.175-6.636A23.97 23.97 0 0 1 3.8 8.627c-.1-.56.236-1.1.773-1.28l.658-.215a.96.96 0 0 1 1.11.39 17.006 17.006 0 0 0 4 4.317m0 4.001a20.006 20.006 0 0 0 3.225-3.38 12.07 12.07 0 0 0 2.344-5.822A12.049 12.049 0 0 0 17.47 3.38 19.933 19.933 0 0 0 13.714.14a.955.955 0 0 0-1.058.208l-.505.479a.956.956 0 0 0-.11 1.254A17.04 17.04 0 0 1 14.6 6.844c.28 1.063.42 2.177.42 3.327s-.14 2.264-.42 3.327a17.019 17.019 0 0 1-2.557 4.763.956.956 0 0 0 .109 1.254l.505.479c.314.298.77.338 1.059.208a19.93 19.93 0 0 0 3.756-3.24" />
    </svg>
  )
}

function PlugIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" d="M13.19 8.688a4.5 4.5 0 0 1 1.242 7.244l-4.5 4.5a4.5 4.5 0 0 1-6.364-6.364l1.757-1.757m13.35-.622 1.757-1.757a4.5 4.5 0 0 0-6.364-6.364l-4.5 4.5a4.5 4.5 0 0 0 1.242 7.244" />
    </svg>
  )
}

function FlagIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" d="M3 3v1.5M3 21v-6m0 0 2.77-.693a9 9 0 0 1 6.208.682l.108.054a9 9 0 0 0 6.086.71l3.114-.732a48.524 48.524 0 0 1-.005-10.499l-3.11.732a9 9 0 0 1-6.085-.711l-.108-.054a9 9 0 0 0-6.208-.682L3 4.5M3 15V4.5" />
    </svg>
  )
}

function ChartIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" d="M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v6.75C7.5 20.496 6.996 21 6.375 21h-2.25A1.125 1.125 0 0 1 3 19.875v-6.75ZM9.75 8.625c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125v11.25c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 0 1-1.125-1.125V8.625ZM16.5 4.125c0-.621.504-1.125 1.125-1.125h2.25C20.496 3 21 3.504 21 4.125v15.75c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 0 1-1.125-1.125V4.125Z" />
    </svg>
  )
}

function GlobeIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 21a9.004 9.004 0 0 0 8.716-6.747M12 21a9.004 9.004 0 0 1-8.716-6.747M12 21c2.485 0 4.5-4.03 4.5-9S14.485 3 12 3m0 18c-2.485 0-4.5-4.03-4.5-9S9.515 3 12 3m0 0a8.997 8.997 0 0 1 7.843 4.582M12 3a8.997 8.997 0 0 0-7.843 4.582m15.686 0A11.953 11.953 0 0 1 12 10.5c-2.998 0-5.74-1.1-7.843-2.918m15.686 0A8.959 8.959 0 0 1 21 12c0 .778-.099 1.533-.284 2.253m0 0A17.919 17.919 0 0 1 12 16.5a17.92 17.92 0 0 1-8.716-2.247m0 0A8.966 8.966 0 0 1 3 12c0-1.264.26-2.466.732-3.558" />
    </svg>
  )
}

function GearIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.325.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 0 1 1.37.49l1.296 2.247a1.125 1.125 0 0 1-.26 1.431l-1.003.827c-.293.241-.438.613-.43.992a7.723 7.723 0 0 1 0 .255c-.008.378.137.75.43.991l1.004.827c.424.35.534.955.26 1.43l-1.298 2.247a1.125 1.125 0 0 1-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.47 6.47 0 0 1-.22.128c-.331.183-.581.495-.644.869l-.213 1.281c-.09.543-.56.94-1.11.94h-2.594c-.55 0-1.019-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 0 1-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 0 1-1.369-.49l-1.297-2.247a1.125 1.125 0 0 1 .26-1.431l1.004-.827c.292-.24.437-.613.43-.991a6.932 6.932 0 0 1 0-.255c.007-.38-.138-.751-.43-.992l-1.004-.827a1.125 1.125 0 0 1-.26-1.43l1.297-2.247a1.125 1.125 0 0 1 1.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.086.22-.128.332-.183.582-.495.644-.869l.214-1.28Z" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" />
    </svg>
  )
}

