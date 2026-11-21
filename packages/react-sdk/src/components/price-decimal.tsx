import { memo } from 'react';
import { usePrice } from '../hooks/use-price';

// ── Types ────────────────────────────────────────────────────────────────────

export interface PPPPriceDecimalProps {
  /** The base price in your default currency (e.g., 99.99). */
  price: number;
  /** Additional CSS class name. */
  className?: string;
  /** Convert to the visitor's currency when possible (see `usePrice`). Defaults to true. */
  localize?: boolean;
  /** Minimum number of decimal digits. Defaults to the currency's usual digits. */
  minimumDecimalDigits?: number;
  /** Maximum number of decimal digits. Defaults to the currency's usual digits. */
  maximumDecimalDigits?: number;
}

// ── Component ────────────────────────────────────────────────────────────────

/**
 * Renders only the decimal part of the PPP-adjusted price.
 *
 * Renders nothing if the formatted price has no decimal portion.
 *
 * @example
 * ```tsx
 * <PPPPriceDecimal price={99.99} />
 * // Renders: "99"
 * ```
 */
export const PPPPriceDecimal = memo(function PPPPriceDecimal({
  price,
  className,
  localize = true,
  minimumDecimalDigits,
  maximumDecimalDigits,
}: PPPPriceDecimalProps) {
  const priceData = usePrice({
    price,
    localize,
    minimumDecimalDigits,
    maximumDecimalDigits,
  });

  if (!priceData.decimal) return null;

  return (
    <span className={className} data-gopaylocal-price-decimal>
      {priceData.decimal}
    </span>
  );
});
