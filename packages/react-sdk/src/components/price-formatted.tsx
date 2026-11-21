import { memo } from 'react';
import { usePrice } from '../hooks/use-price';
import { digitOptions } from '../../../js-sdk/src/price';

// ── Types ────────────────────────────────────────────────────────────────────

export interface PPPPriceFormattedProps {
  /** The base price in your default currency (e.g., 99.99). */
  price: number;
  /** Additional CSS class name. */
  className?: string;
  /** Convert to the visitor's currency when possible (see `usePrice`). Defaults to true. */
  localize?: boolean;
  /** Whether to show decimal digits. */
  showDecimal?: boolean;
  /** Minimum number of decimal digits. */
  minimumDecimalDigits?: number;
  /** Maximum number of decimal digits. */
  maximumDecimalDigits?: number;
  /**
   * If true, displays the original (non-discounted) price.
   * Useful for rendering a strikethrough price alongside the discounted one.
   */
  isOriginalDisplay?: boolean;
  /** How to display the currency: 'symbol' ($), 'code' (USD), or 'name' (US dollars). */
  currencyDisplay?: 'symbol' | 'code' | 'name';
}

// ── Component ────────────────────────────────────────────────────────────────

/**
 * Formatted PPP price with advanced display options.
 *
 * Supports showing the original (pre-discount) price for strikethrough
 * displays, custom decimal formatting, and currency display modes.
 *
 * @example
 * ```tsx
 * <div>
 *   <s><PPPPriceFormatted price={99.99} isOriginalDisplay /></s>
 *   <PPPPriceFormatted price={99.99} />
 * </div>
 * // Renders: <s>$99.99</s> $69.99 (with a 30% discount)
 * ```
 */
export const PPPPriceFormatted = memo(function PPPPriceFormatted({
  price,
  className,
  localize = true,
  showDecimal,
  minimumDecimalDigits,
  maximumDecimalDigits,
  isOriginalDisplay = false,
  currencyDisplay = 'symbol',
}: PPPPriceFormattedProps) {
  const priceData = usePrice({
    price,
    localize,
    showDecimal,
    minimumDecimalDigits,
    maximumDecimalDigits,
  });

  const displayValue = isOriginalDisplay
    ? priceData.formattedOriginal
    : priceData.formatted;

  // Re-format if currencyDisplay is not 'symbol'
  let displayText = displayValue;
  if (currencyDisplay !== 'symbol') {
    const numericValue = isOriginalDisplay ? priceData.localOriginalPrice : priceData.localPrice;

    try {
      displayText = new Intl.NumberFormat(undefined, {
        style: 'currency',
        currency: priceData.currencyCode,
        currencyDisplay,
        ...digitOptions(numericValue, priceData.currencyCode, showDecimal, minimumDecimalDigits, maximumDecimalDigits),
      }).format(numericValue);
    } catch {
      // Fall through to default
    }
  }

  return (
    <span className={className} data-gopaylocal-price-formatted>
      {displayText}
    </span>
  );
});
