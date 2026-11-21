import { createContext } from 'react';
import type { PPPContextValue } from './types';

/**
 * React context for PPP (Purchasing Power Parity) data.
 *
 * This context is provided by `GoPayLocalProvider` and consumed
 * by hooks like `usePPP()` and `usePrice()`.
 */
export const PPPContext = createContext<PPPContextValue | null>(null);

PPPContext.displayName = 'GoPayLocalPPPContext';
