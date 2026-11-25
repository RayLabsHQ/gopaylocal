import { toast } from 'sonner'
import { ClipboardIcon } from '~/components/ui/clipboard-icon'

/**
 * The hosted service's support address. Only pages of the hosted service show
 * it (billing is hidden on a self-hosted deployment).
 */
export const SUPPORT_EMAIL = 'support@gopaylocal.com'

/**
 * The support address as an email link, with the dashboard's copy button for
 * people whose browser has no mail app set up. The address stays on screen so
 * it can be read and typed even when neither works. The link and the button
 * never wrap apart.
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
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
      <a href={href} className="font-medium text-text-primary underline underline-offset-2 hover:text-brand-text">
        {SUPPORT_EMAIL}
      </a>
      <button
        type="button"
        onClick={copy}
        aria-label={`Copy ${SUPPORT_EMAIL}`}
        title="Copy email address"
        className="-m-1 p-1 text-text-secondary transition-colors hover:text-text-primary"
      >
        <ClipboardIcon />
      </button>
    </span>
  )
}
