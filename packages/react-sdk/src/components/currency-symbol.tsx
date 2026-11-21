import { memo } from 'react';
import { usePPP } from '../hooks/use-ppp';

// ── Types ────────────────────────────────────────────────────────────────────

export interface PPPCurrencySymbolProps {
  /** Additional CSS class name. */
  className?: string;
}

// ── Component ────────────────────────────────────────────────────────────────

/**
 * Renders the currency symbol prices are shown in: your product's symbol from
 * the API, else the provider's `baseCurrencySymbol`. The API sends no visitor
 * currency, so this does not change with the visitor's country.
 *
 * @example
 * ```tsx
 * <PPPCurrencySymbol />
 * // Renders: "$"
 * ```
 */
export const PPPCurrencySymbol = memo(function PPPCurrencySymbol({
  className,
}: PPPCurrencySymbolProps) {
  const { currencySymbol } = usePPP();

  return (
    <span className={className} data-gopaylocal-currency-symbol>
      {currencySymbol}
    </span>
  );
});
