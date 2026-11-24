import type { IntegrationEnvironment } from '~/lib/api'

export { Status, type Tone } from '~/components/ui/status'

// Small pieces shared by the Integrations page and its Connect panel.

export { btnPrimary, btnSecondary } from '~/components/ui/page'

export function LogoTile({ src, size = 'md' }: { src: string; size?: 'sm' | 'md' | 'lg' }) {
  const box = size === 'lg' ? 'h-11 w-11' : size === 'md' ? 'h-10 w-10' : 'h-9 w-9'
  const img = size === 'lg' ? 'h-7 w-7' : size === 'md' ? 'h-6 w-6' : 'h-[22px] w-[22px]'
  return (
    <div className={`flex flex-none items-center justify-center border border-border bg-tile ${box}`}>
      <img src={src} alt="" className={`object-contain ${img}`} />
    </div>
  )
}

export function EnvBadge({ env }: { env: IntegrationEnvironment }) {
  return (
    <span
      className={`px-2 py-1 text-[11px] font-semibold uppercase tracking-[0.08em] ${env === 'live' ? 'border border-control text-text-primary' : 'border border-warning-border bg-warning-light text-warning'}`}
    >
      {env === 'live' ? 'Live' : 'Test'}
    </span>
  )
}

export function ResultMark({ tone }: { tone: 'ok' | 'warn' | 'info' }) {
  if (tone === 'ok') {
    return (
      <span aria-hidden="true" className="flex h-[22px] w-[22px] flex-none items-center justify-center bg-success-light text-success">
        <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4}>
          <path d="m5 12 5 5 9-10" />
        </svg>
      </span>
    )
  }
  return (
    <span
      aria-hidden="true"
      className={`flex h-[22px] w-[22px] flex-none items-center justify-center text-[13px] font-bold ${tone === 'warn' ? 'bg-warning-border text-warning' : 'bg-surface text-text-secondary'}`}
    >
      {tone === 'warn' ? '!' : 'i'}
    </span>
  )
}

export function ExternalIcon() {
  return (
    <svg aria-hidden="true" className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
      <path d="M14 4h6v6M20 4l-9 9M18 14v6H4V6h6" />
    </svg>
  )
}

export function LockIcon({ className = 'h-4 w-4' }: { className?: string }) {
  return (
    <svg aria-hidden="true" className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}>
      <rect x="4" y="11" width="16" height="10" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </svg>
  )
}
