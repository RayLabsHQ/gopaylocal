import type { ReactNode } from 'react'
import type { Env } from '~/lib/env'

/**
 * Says which environment a create form saves into. The sidebar's Live/Test
 * switch decides it, and on phones that switch is tucked away in the menu, so
 * the form states it next to its title. Live is neutral, like the switch; Test
 * is amber, like the strip above every page in test mode.
 */
export function EnvNotice({ env, children }: { env: Env; children: ReactNode }) {
  const test = env === 'test'
  return (
    <div
      data-env={env}
      className={`mt-4 flex max-w-lg items-start gap-3 border px-4 py-3 ${
        test ? 'border-warning-border bg-warning-light' : 'border-border bg-panel'
      }`}
    >
      <span
        className={`shrink-0 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wider ${
          test ? 'border border-warning-border text-warning' : 'border border-control text-text-primary'
        }`}
      >
        {test ? 'Test' : 'Live'}
      </span>
      <p className="text-[13px] text-text-primary">{children}</p>
    </div>
  )
}
