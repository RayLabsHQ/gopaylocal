import * as React from 'react'

function Dialog({
  open,
  onOpenChange,
  children,
  size = 'md',
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  children: React.ReactNode
  size?: 'md' | 'lg'
}) {
  React.useEffect(() => {
    if (open) {
      document.body.style.overflow = 'hidden'
    } else {
      document.body.style.overflow = ''
    }
    return () => {
      document.body.style.overflow = ''
    }
  }, [open])

  React.useEffect(() => {
    if (!open) return
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onOpenChange(false)
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [open, onOpenChange])

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
    >
      <div
        className="fixed inset-0 bg-black/70"
        onClick={() => onOpenChange(false)}
      />
      <div className={`relative z-[51] max-h-[calc(100dvh-2rem)] w-full overflow-y-auto border border-border bg-bg p-6 shadow-lg ${size === 'lg' ? 'max-w-lg' : 'max-w-md'}`}>
        {children}
      </div>
    </div>
  )
}

function DialogHeader({ children }: { children: React.ReactNode }) {
  return <div className="mb-4">{children}</div>
}

function DialogTitle({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="font-display text-lg font-semibold text-text-primary">{children}</h2>
  )
}

function DialogDescription({ children }: { children: React.ReactNode }) {
  return <p className="mt-1.5 text-sm leading-relaxed text-text-secondary">{children}</p>
}

function DialogFooter({ children }: { children: React.ReactNode }) {
  return <div className="mt-6 flex flex-wrap justify-end gap-3">{children}</div>
}

export { Dialog, DialogHeader, DialogTitle, DialogDescription, DialogFooter }
