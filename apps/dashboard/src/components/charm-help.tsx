import type { CharmPricingStrategy, DiscountDelivery } from '@gopaylocal/shared'

/**
 * Help text under a campaign's Charm Pricing select: what visitors in another
 * currency are shown, and that it is an estimate. The rule is
 * packages/shared/src/currency/charm.ts (rounded up, at most 8% above the
 * converted amount, never below it); visitors who pay in the product's own
 * currency always see the exact price.
 */
export function CharmHelp({
  strategy,
  provider,
  delivery,
}: {
  strategy: CharmPricingStrategy
  provider?: string | null
  delivery?: DiscountDelivery
}) {
  // Dodo charges the country price: the price is written to Dodo, rounded
  // down (services/dodo-country-prices.ts countryCharge), and charged exactly.
  if (delivery === 'provider_price') {
    return (
      <p className="mt-1.5 text-[13px] text-text-secondary">
        Each country's price is your price with its discount, converted at the day's mid-market rate
        {strategy === 'none'
          ? ', with no rounding.'
          : ' and rounded down to a charm price within 8% of it (when none fits, the price stays exact), so the discount the banner states is never more than the real one.'}{' '}
        Dodo charges exactly that price and doesn't apply its own Charm Pricing to it. Leave Dodo's Charm Pricing off
        anyway: it would still round the converted price in countries without a discount.
      </p>
    )
  }
  const rounding =
    strategy === 'none'
      ? "round up to the currency's smallest unit, never below the converted amount"
      : 'round up to a charm price, at most 8% above the converted amount and never below it'
  return (
    <p className="mt-1.5 text-[13px] text-text-secondary">
      Local prices are estimates. They convert your price at the day's mid-market rate and {rounding}. Your
      payment provider charges the exact discounted price in your currency; the amount on the customer's
      statement depends on their bank's exchange rate. The two prices are chosen together, so the discount they
      imply stays close to your coupon and is never above it. Visitors who pay in your currency see the exact price.
      {provider === 'dodopayments' && (
        <>
          {' '}
          <strong className="font-medium text-text-primary">Leave Dodo&apos;s own Charm Pricing off</strong> (Dodo
          dashboard, Settings, Pricing Settings): it rounds the converted price again at checkout, before the code
          comes off, so checkout would no longer match the banner.
        </>
      )}
    </p>
  )
}
