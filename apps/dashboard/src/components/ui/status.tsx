import type { ReactNode } from 'react'

// Status marks. The words carry the meaning; the shape repeats it and the
// colour backs it up, so nothing depends on telling green from amber.

export type Tone = 'ok' | 'warn' | 'error' | 'off'

export function ToneIcon({ tone, className = 'h-3 w-3' }: { tone: Tone; className?: string }) {
  if (tone === 'ok') {
    return (
      <svg aria-hidden="true" className={`flex-none text-success ${className}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3.2}>
        <path d="m5 12 5 5 9-10" />
      </svg>
    )
  }
  if (tone === 'warn') {
    return (
      <svg aria-hidden="true" className={`flex-none text-warning ${className}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4}>
        <path d="M12 3 2 21h20z" />
        <path d="M12 10v5M12 18v.5" />
      </svg>
    )
  }
  if (tone === 'error') {
    return (
      <svg aria-hidden="true" className={`flex-none text-error ${className}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4}>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7v6M12 16.5v.5" />
      </svg>
    )
  }
  return <span aria-hidden="true" className="inline-block h-2 w-2 flex-none border border-text-muted" />
}

/** A health state: Working, Saved, Needs attention, Not added. */
export function Status({ tone, colorText = false, children }: { tone: Tone; colorText?: boolean; children: ReactNode }) {
  const text =
    tone === 'warn'
      ? 'text-warning'
      : tone === 'error'
        ? 'text-error'
        : tone === 'off'
          ? 'text-text-muted'
          : colorText
            ? 'text-success'
            : 'text-text-primary'
  return (
    <span className={`inline-flex items-center gap-1.5 ${text}`}>
      <ToneIcon tone={tone} />
      {children}
    </span>
  )
}

export type Lifecycle = 'on' | 'paused' | 'draft'

/** Where something is in its life: Active, Running, Paused, Ended, Draft. */
export function LifecycleStatus({ state, children }: { state: Lifecycle; children: ReactNode }) {
  const dot = state === 'on' ? 'bg-success' : state === 'paused' ? 'bg-text-muted' : 'border border-text-muted'
  return (
    <span className={`inline-flex items-center gap-1.5 text-[13px] font-medium ${state === 'on' ? 'text-success' : 'text-text-secondary'}`}>
      <span aria-hidden="true" className={`inline-block h-2 w-2 flex-none ${dot}`} />
      {children}
    </span>
  )
}

/** An error message: the lighter error red, always with its icon. */
export function ErrorText({ children, className = '', id }: { children: ReactNode; className?: string; id?: string }) {
  return (
    <p id={id} role="alert" className={`flex items-start gap-2 text-[13px] text-error ${className}`}>
      <ToneIcon tone="error" className="mt-[3px] h-3.5 w-3.5" />
      <span>{children}</span>
    </p>
  )
}
