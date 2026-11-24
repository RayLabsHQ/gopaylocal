import * as React from 'react'
import * as SelectPrimitive from '@radix-ui/react-select'

// The dashboard's Select (shadcn/ui on Radix), in the admin's colours: square
// corners, 1px borders, the accent on focus and on the chosen item.

const Select = SelectPrimitive.Root
const SelectValue = SelectPrimitive.Value

const SelectTrigger = React.forwardRef<
  React.ComponentRef<typeof SelectPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Trigger>
>(({ className, children, ...props }, ref) => (
  <SelectPrimitive.Trigger
    ref={ref}
    className={`flex h-10 w-full cursor-pointer items-center justify-between gap-2 border border-border bg-bg px-3 text-left text-sm text-text-primary outline-none transition-colors hover:border-border-strong focus-visible:border-accent data-[state=open]:border-accent data-[placeholder]:text-text-muted disabled:cursor-not-allowed disabled:opacity-50 [&>span]:truncate ${className ?? ''}`}
    {...props}
  >
    {children}
    <SelectPrimitive.Icon asChild>
      <svg className="h-4 w-4 shrink-0 text-text-muted" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" aria-hidden="true">
        <path strokeLinecap="round" strokeLinejoin="round" d="m19.5 8.25-7.5 7.5-7.5-7.5" />
      </svg>
    </SelectPrimitive.Icon>
  </SelectPrimitive.Trigger>
))
SelectTrigger.displayName = SelectPrimitive.Trigger.displayName

const SelectContent = React.forwardRef<
  React.ComponentRef<typeof SelectPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Content>
>(({ className, children, position = 'popper', ...props }, ref) => (
  <SelectPrimitive.Portal>
    <SelectPrimitive.Content
      ref={ref}
      position={position}
      sideOffset={4}
      className={`relative z-50 max-h-80 min-w-[8rem] overflow-hidden border border-border-strong bg-surface shadow-[0_8px_24px_rgba(0,0,0,0.45)] ${className ?? ''}`}
      {...props}
    >
      <SelectPrimitive.Viewport
        className={`p-1 ${position === 'popper' ? 'w-full min-w-[var(--radix-select-trigger-width)]' : ''}`}
      >
        {children}
      </SelectPrimitive.Viewport>
    </SelectPrimitive.Content>
  </SelectPrimitive.Portal>
))
SelectContent.displayName = SelectPrimitive.Content.displayName

const SelectItem = React.forwardRef<
  React.ComponentRef<typeof SelectPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Item>
>(({ className, children, ...props }, ref) => (
  <SelectPrimitive.Item
    ref={ref}
    className={`relative flex w-full cursor-pointer select-none items-center py-2 pl-8 pr-3 text-sm text-text-secondary outline-none data-[highlighted]:bg-surface-raised data-[highlighted]:text-text-primary data-[state=checked]:text-accent data-[disabled]:pointer-events-none data-[disabled]:opacity-50 ${className ?? ''}`}
    {...props}
  >
    <span className="absolute left-2.5 flex h-3.5 w-3.5 items-center justify-center">
      <SelectPrimitive.ItemIndicator>
        <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={2.5} stroke="currentColor" aria-hidden="true">
          <path strokeLinecap="round" strokeLinejoin="round" d="m4.5 12.75 6 6 9-13.5" />
        </svg>
      </SelectPrimitive.ItemIndicator>
    </span>
    <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
  </SelectPrimitive.Item>
))
SelectItem.displayName = SelectPrimitive.Item.displayName

export { Select, SelectValue, SelectTrigger, SelectContent, SelectItem }
