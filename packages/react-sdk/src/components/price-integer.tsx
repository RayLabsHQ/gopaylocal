import { memo } from 'react';
import { usePrice } from '../hooks/use-price';

// ── Types ────────────────────────────────────────────────────────────────────

export interface PPPPriceIntegerProps {
  /** The base price in your default currency (e.g., 99.99). */
  price: number;
  /** Additional CSS class name. */
  className?: string;
  /** Convert to the visitor's currency when possible (see `usePrice`). Defaults to true. */
  localize?: boolean;
}

// ── Component ────────────────────────────────────────────────────────────────

/**
 * Renders only the integer part of the PPP-adjusted price.
 *
 * Useful for building custom price displays where you need independent
 * control over integer and decimal styling.
 *
 * @example
 * ```tsx
 * <span style={{ fontSize: '2rem' }}>
 *   <PPPCurrencySymbol />
 *   <PPPPriceInteger price={99.99} />
 *   <sup><PPPPriceDecimal price={99.99} /></sup>
 * </span>
 * // Renders: $69.99 with "99" superscripted (with a 30% discount)
 * ```
 */
export const PPPPriceInteger = memo(function PPPPriceInteger({
  price,
  className,
  localize = true,
}: PPPPriceIntegerProps) {
  const priceData = usePrice({ price, localize });

  return (
    <span className={className} data-gopaylocal-price-integer>
      {priceData.integer}
    </span>
  );
});
