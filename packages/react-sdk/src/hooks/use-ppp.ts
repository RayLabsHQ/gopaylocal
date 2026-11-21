import { useContext } from 'react';
import { PPPContext } from '../context';
import type { PPPContextValue } from '../types';

/** Re-export for consumer convenience. */
export type PPPData = PPPContextValue;

/**
 * Access PPP (Purchasing Power Parity) data from the nearest `GoPayLocalProvider`.
 *
 * Must be called inside a `<GoPayLocalProvider>`. Throws if the provider is missing.
 *
 * @returns The full PPP context including discount info, currency data, and helper functions.
 *
 * @example
 * ```tsx
 * function PricingCard() {
 *   const { discount, localPrice, formatPrice, flag, country } = usePPP();
 *
 *   if (discount > 0) {
 *     return (
 *       <div>
 *         {flag} {discount}% off for {country}!
 *         <span>{formatPrice(localPrice(99.99))}</span>
 *       </div>
 *     );
 *   }
 *
 *   return <div>$99.99</div>;
 * }
 * ```
 */
export function usePPP(): PPPContextValue {
  const context = useContext(PPPContext);

  if (context === null) {
    throw new Error(
      'usePPP() must be used inside a <GoPayLocalProvider>. ' +
        'Wrap your component tree with <GoPayLocalProvider apiKey="...">.',
    );
  }

  return context;
}
