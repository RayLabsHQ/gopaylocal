import { toast } from 'sonner'

/**
 * The hosted service's support address. Only pages of the hosted service show
 * it (billing is hidden on a self-hosted deployment).
 */
export const SUPPORT_EMAIL = 'support@gopaylocal.com'

/**
 * The support address as an email link, with a button that copies it for
 * people whose browser has no mail app set up.
 */
export function ContactEmail({ subject }: { subject?: string }) {
  const href = `mailto:${SUPPORT_EMAIL}${subject ? `?subject=${encodeURIComponent(subject)}` : ''}`
  const copy = () => {
    navigator.clipboard.writeText(SUPPORT_EMAIL).then(
      () => toast.success('Email address copied'),
      () => toast.error(`Couldn't copy it. The address is ${SUPPORT_EMAIL}`),
    )
  }
  return (
    <span className="inline-flex flex-wrap items-baseline gap-x-2">
      <a href={href} className="font-medium text-text-primary underline underline-offset-2 hover:text-brand-text">
        {SUPPORT_EMAIL}
      </a>
      <button
        type="button"
        onClick={copy}
        aria-label={`Copy ${SUPPORT_EMAIL}`}
        className="text-text-muted underline-offset-2 hover:text-text-primary hover:underline"
      >
        Copy
      </button>
    </span>
  )
}
