import { memo } from 'react';
import { usePrice } from '../hooks/use-price';
import { digitOptions } from '../../../js-sdk/src/price';

// ── Types ────────────────────────────────────────────────────────────────────

export interface PPPPriceProps {
  /** The base price in your default currency (e.g., 99.99). */
  price: number;
  /** Additional CSS class name. */
  className?: string;
  /** Convert to the visitor's currency when possible (see `usePrice`). Defaults to true. */
  localize?: boolean;
  /** Whether to show decimal digits. */
  showDecimal?: boolean;
  /** How to display the currency: 'symbol' ($), 'code' (USD), or 'name' (US dollars). */
  currencyDisplay?: 'symbol' | 'code' | 'name';
}

// ── Component ────────────────────────────────────────────────────────────────

/**
 * The simplest PPP price component. Renders the discounted price.
 *
 * Falls back to the base price formatted in the base currency if no PPP
 * context is available or no discount applies.
 *
 * @example
 * ```tsx
 * <PPPPrice price={99.99} />
 * // Renders: "$69.99" (for a visitor with a 30% discount)
 * // Or: "$99.99" (if no PPP discount)
 * ```
 */
export const PPPPrice = memo(function PPPPrice({
  price,
  className,
  localize = true,
  showDecimal,
  currencyDisplay = 'symbol',
}: PPPPriceProps) {
  const priceData = usePrice({ price, localize, showDecimal });

  // If currencyDisplay is not 'symbol', re-format with the requested display
  let displayText = priceData.formatted;
  if (currencyDisplay !== 'symbol') {
    try {
      displayText = new Intl.NumberFormat(undefined, {
        style: 'currency',
        currency: priceData.currencyCode,
        currencyDisplay,
        ...digitOptions(priceData.localPrice, priceData.currencyCode, showDecimal),
      }).format(priceData.localPrice);
    } catch {
      // Fall through to default formatted value
    }
  }

  return (
    <span className={className} data-gopaylocal-price>
      {displayText}
    </span>
  );
});
