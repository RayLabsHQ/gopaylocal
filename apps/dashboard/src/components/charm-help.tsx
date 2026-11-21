import type { CharmPricingStrategy } from '@gopaylocal/shared'

/**
 * Help text under a campaign's Charm Pricing select: what visitors in another
 * currency are shown, and that it is an estimate. The rule is
 * packages/shared/src/currency/charm.ts (rounded up, at most 8% above the
 * converted amount, never below it); visitors who pay in the product's own
 * currency always see the exact price.
 */
export function CharmHelp({ strategy }: { strategy: CharmPricingStrategy }) {
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
    </p>
  )
}
