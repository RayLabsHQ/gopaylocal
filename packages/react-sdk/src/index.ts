// ── Provider ─────────────────────────────────────────────────────────────────

export { GoPayLocalProvider, type GoPayLocalProviderProps } from './provider';

// ── Hooks ────────────────────────────────────────────────────────────────────

export { usePPP, type PPPData } from './hooks/use-ppp';
export { usePrice, type UsePriceOptions, type UsePriceResult } from './hooks/use-price';

// ── Components ───────────────────────────────────────────────────────────────

export { PPPBanner, type PPPBannerProps } from './components/banner';
export { PPPPrice, type PPPPriceProps } from './components/price';
export { PPPPriceFormatted, type PPPPriceFormattedProps } from './components/price-formatted';
export { PPPPriceInteger, type PPPPriceIntegerProps } from './components/price-integer';
export { PPPPriceDecimal, type PPPPriceDecimalProps } from './components/price-decimal';
export { PPPCurrencySymbol, type PPPCurrencySymbolProps } from './components/currency-symbol';
export { PPPCurrencyCode, type PPPCurrencyCodeProps } from './components/currency-code';
export {
  PPPPricingTable,
  type PPPPricingTableProps,
  type PPPPricingPlan,
  type PPPSelectedPlan,
} from './components/pricing-table';

// ── Types ────────────────────────────────────────────────────────────────────

export type {
  PPPConfig,
  PPPResponse,
  PPPBannerDesign,
  PPPDeal,
  PPPContextValue,
  PPPTrackableEvent,
  CharmStrategy,
} from './types';

// ── Utilities ────────────────────────────────────────────────────────────────

export { countryToFlag, formatCurrency, splitPrice } from './utils';
export { DEFAULT_API_BASE, VISITOR_ID_STORAGE_KEY } from '../../js-sdk/src/core';
