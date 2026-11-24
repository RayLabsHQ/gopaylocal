import * as React from 'react'
import { useModalFocus } from '~/lib/use-modal-focus'

// DialogTitle takes its id from here, so every dialog is named by its title
// (aria-labelledby) without each caller wiring ids.
const DialogTitleId = React.createContext<string | undefined>(undefined)

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
  const titleId = React.useId()
  const panelRef = React.useRef<HTMLDivElement>(null)
  useModalFocus(panelRef, open, () => onOpenChange(false))

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div
        className="fixed inset-0 bg-black/70"
        onClick={() => onOpenChange(false)}
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={`relative z-[51] max-h-[calc(100dvh-2rem)] w-full overflow-y-auto border border-border bg-bg p-6 shadow-lg outline-none ${size === 'lg' ? 'max-w-lg' : 'max-w-md'}`}
      >
        <DialogTitleId.Provider value={titleId}>{children}</DialogTitleId.Provider>
      </div>
    </div>
  )
}

function DialogHeader({ children }: { children: React.ReactNode }) {
  return <div className="mb-4">{children}</div>
}

function DialogTitle({ children }: { children: React.ReactNode }) {
  const id = React.useContext(DialogTitleId)
  return (
    <h2 id={id} className="font-display text-lg font-semibold text-text-primary">{children}</h2>
  )
}

function DialogDescription({ children }: { children: React.ReactNode }) {
  return <p className="mt-1.5 text-sm leading-relaxed text-text-secondary">{children}</p>
}

function DialogFooter({ children }: { children: React.ReactNode }) {
  return <div className="mt-6 flex flex-wrap justify-end gap-3">{children}</div>
}

export { Dialog, DialogHeader, DialogTitle, DialogDescription, DialogFooter }
