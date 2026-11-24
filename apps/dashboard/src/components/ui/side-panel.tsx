import * as React from 'react'
import { useModalFocus } from '~/lib/use-modal-focus'

/**
 * A panel that slides over the right edge of the page, full height. `wide`
 * makes it 760px from the lg breakpoint, so a two-column body fits a laptop
 * screen without scrolling; below that it is one column, at most 520px.
 * The header and footer stay put and only the body scrolls.
 */
function SidePanel({
  open,
  onClose,
  labelledBy,
  wide = false,
  children,
}: {
  open: boolean
  onClose: () => void
  /** id of the panel's title. */
  labelledBy: string
  wide?: boolean
  children: React.ReactNode
}) {
  const panelRef = React.useRef<HTMLDivElement>(null)
  useModalFocus(panelRef, open, onClose)

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50">
      <div className="absolute inset-0 bg-black/70" onClick={onClose} />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        tabIndex={-1}
        className={`absolute inset-y-0 right-0 flex w-full flex-col border-l border-border bg-bg outline-none sm:max-w-[520px] ${wide ? 'lg:max-w-[760px]' : ''}`}
      >
        {children}
      </div>
    </div>
  )
}

function SidePanelBody({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <div className={`min-h-0 flex-1 overflow-y-auto px-5 py-6 sm:px-6 ${className}`}>{children}</div>
}

function SidePanelFooter({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap justify-end gap-2.5 border-t border-border px-5 py-4 sm:px-6">{children}</div>
  )
}

export { SidePanel, SidePanelBody, SidePanelFooter }
