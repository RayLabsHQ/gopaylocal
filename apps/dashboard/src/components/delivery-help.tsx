import type { DiscountDelivery } from '@gopaylocal/shared'

const AUTO_APPLY_GUIDE = 'https://docs.gopaylocal.com/guides/auto-apply/'

/**
 * Help text under a campaign's Discount Delivery select. Both options serve the
 * same code, and the banner shows it either way. "Auto-apply at checkout" only
 * makes a payment integration required before the campaign can be active;
 * putting the code on the order is the merchant's own checkout's job.
 */
export function DeliveryHelp({ delivery }: { delivery: DiscountDelivery }) {
  return (
    <p className="mt-1.5 text-[13px] text-text-secondary">
      {delivery === 'auto_apply' ? (
        <>
          Your own checkout must pass the visitor's code to your payment platform; GoPayLocal does not apply it for
          you. The banner still shows the code. Needs a payment integration before the campaign can be active.{' '}
          <a
            href={AUTO_APPLY_GUIDE}
            target="_blank"
            rel="noopener noreferrer"
            className="text-brand-text underline hover:no-underline"
          >
            How to pass the code
          </a>
        </>
      ) : (
        'The visitor copies the code from the banner and enters it at checkout.'
      )}
    </p>
  )
}
