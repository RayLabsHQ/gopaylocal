import type { DiscountDelivery } from '@gopaylocal/shared'

const AUTO_APPLY_GUIDE = 'https://docs.gopaylocal.com/guides/auto-apply/'

const COUNTRY_PRICES_GUIDE = 'https://docs.gopaylocal.com/integrations/dodo-payments/#dodo-charges-the-country-price'

/**
 * Help text under a campaign's Discount Delivery select. The first two options
 * serve the same code, and the banner shows it either way. "Auto-apply at
 * checkout" only makes a payment integration required before the campaign can
 * be active; putting the code on the order is the merchant's own checkout's
 * job. "Dodo charges the country price" has no code at all.
 */
export function DeliveryHelp({ delivery }: { delivery: DiscountDelivery }) {
  return (
    <p className="mt-1.5 text-[13px] text-text-secondary">
      {delivery === 'provider_price' ? (
        <>
          No code: GoPayLocal sets each country's price on your Dodo product, Dodo charges it by the buyer's billing
          country, and the banner shows that exact price. Needs a Dodo Payments integration. Holiday deals and A/B tests
          aren't available with it.{' '}
          <a
            href={COUNTRY_PRICES_GUIDE}
            target="_blank"
            rel="noopener noreferrer"
            className="text-brand-text underline hover:no-underline"
          >
            How it works
          </a>
        </>
      ) : delivery === 'auto_apply' ? (
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
