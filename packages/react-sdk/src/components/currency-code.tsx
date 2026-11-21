import { memo } from 'react';
import { usePPP } from '../hooks/use-ppp';

// ── Types ────────────────────────────────────────────────────────────────────

export interface PPPCurrencyCodeProps {
  /** Additional CSS class name. */
  className?: string;
}

// ── Component ────────────────────────────────────────────────────────────────

/**
 * Renders the currency code (ISO 4217) prices are formatted in: the provider's
 * `baseCurrencyCode`. The API sends no visitor currency.
 *
 * @example
 * ```tsx
 * <PPPCurrencyCode />
 * // Renders: "USD"
 * ```
 */
export const PPPCurrencyCode = memo(function PPPCurrencyCode({
  className,
}: PPPCurrencyCodeProps) {
  const { currencyCode } = usePPP();

  return (
    <span className={className} data-gopaylocal-currency-code>
      {currencyCode}
    </span>
  );
});
