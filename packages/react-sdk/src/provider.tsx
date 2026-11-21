import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { PPPContext } from './context';
import type { PPPConfig, PPPContextValue, PPPResponse, PPPTrackableEvent } from './types';
import { countryToFlag, formatCurrency } from './utils';
// Bundled into this package at build time (see the file's header comment).
import {
  buildConfigUrl,
  isValidVisitorId,
  readExperiment,
  resolveVisitorId,
  sendEvent,
  type ExperimentInfo,
} from '../../js-sdk/src/core';
import { charmStrategyOf, localPrices, symbolOf, type Conversion } from '../../js-sdk/src/price';

const NO_EXPERIMENT: ExperimentInfo = { experimentId: null, variant: null };

// ── Constants ────────────────────────────────────────────────────────────────

const CACHE_PREFIX = 'gpl_react_';
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const REQUEST_TIMEOUT_MS = 8000;

// Runs before paint on the client, so a cached response shows without a flash
// of base prices; on the server neither effect runs, and React 18 warns about
// useLayoutEffect there, hence the switch.
const useIsomorphicLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect;

// ── Provider Props ───────────────────────────────────────────────────────────

export interface GoPayLocalProviderProps extends PPPConfig {
  /** Called when a discount applies to this visitor (not when there is none). */
  onLoad?: (data: PPPResponse) => void;
  /** Called when the request fails, including a timeout after 8 seconds. */
  onError?: (error: Error) => void;
  children: ReactNode;
}

// ── Response handling ────────────────────────────────────────────────────────

/**
 * Keep a config response only when it grants a discount (`show: true`) and
 * has the fields the components read. Exported for tests; not public API.
 */
export function toPPPResponse(json: unknown): PPPResponse | null {
  const r = json as Partial<PPPResponse> | null;
  if (!r || r.show !== true || typeof r.country !== 'string' || !r.banner) return null;
  return {
    ...r,
    show: true,
    country: r.country,
    countryName: typeof r.countryName === 'string' ? r.countryName : r.country,
    discount: typeof r.discount === 'number' ? r.discount : 0,
    code: typeof r.code === 'string' ? r.code : null,
    banner: r.banner,
  };
}

export interface FetchConfigOptions {
  apiBase?: string;
  apiKey: string;
  productId?: string;
  /** A valid override, or undefined. */
  visitorId?: string;
  persistVisitorId: boolean;
  signal?: AbortSignal;
}

export interface FetchConfigResult {
  /** The response when it grants a discount, else null. */
  data: PPPResponse | null;
  /** The experiment arm, also set when the assigned arm has no discount. */
  experiment: ExperimentInfo;
}

/**
 * Request the visitor's config. Throws on a non-2xx status or a network
 * error. Exported for tests; not public API.
 */
export async function fetchConfig(options: FetchConfigOptions): Promise<FetchConfigResult> {
  const url = buildConfigUrl({
    apiBase: options.apiBase,
    apiKey: options.apiKey,
    productId: options.productId,
    visitorId: resolveVisitorId({
      visitorId: options.visitorId,
      persist: options.persistVisitorId,
    }),
  });
  const res = await fetch(url, {
    signal: options.signal,
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) {
    throw new Error(`GoPayLocal API returned ${res.status}`);
  }
  const json: unknown = await res.json();
  return { data: toPPPResponse(json), experiment: readExperiment(json) };
}

/** The context's price fields for one response. Exported for tests; not public API. */
export type PriceContext = Pick<
  PPPContextValue,
  | 'baseCurrencyCode'
  | 'baseCurrencySymbol'
  | 'currencyCode'
  | 'currencySymbol'
  | 'fxRate'
  | 'fxAsOf'
  | 'charmPricingStrategy'
  | 'localPrice'
  | 'localOriginalPrice'
  | 'formatPrice'
> & {
  /** The product's currency when it differs from baseCurrencyCode on a converting response, else null. */
  mismatch: string | null;
};

/**
 * Decide the currency prices are shown in, and the price functions. Converts
 * only when the response is a conversion (a rate date and a positive rate)
 * and the prices passed in are in the product's currency (`baseCurrencyCode`
 * unset means they are). Exported for tests; not public API.
 */
export function priceContext(
  data: PPPResponse | null,
  baseCurrencyCodeProp?: string,
  baseCurrencySymbolProp?: string,
): PriceContext {
  const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
  const explicit = baseCurrencyCodeProp?.trim().toUpperCase() || null;
  const product = str(data?.baseCurrencyCode);
  const base = explicit ?? product ?? 'USD';
  const sameBase = product !== null && product === base;
  const baseSymbol =
    baseCurrencySymbolProp || (sameBase ? str(data?.baseCurrencySymbol) : null) || symbolOf(base);
  const rate = data?.fxRate;
  const fxAsOf = str(data?.fxAsOf);
  const isConversion = fxAsOf !== null && typeof rate === 'number' && Number.isFinite(rate) && rate > 0;
  const converted = isConversion && sameBase;
  const discount = data?.discount ?? 0;
  const conversion: Conversion = {
    baseCurrencyCode: base,
    currencyCode: converted ? (str(data?.currencyCode) ?? base) : base,
    fxRate: converted ? (rate as number) : 1,
    fxAsOf: converted ? fxAsOf : null,
    charmPricingStrategy: charmStrategyOf(data?.charmPricingStrategy),
  };
  return {
    ...conversion,
    baseCurrencySymbol: baseSymbol,
    currencySymbol: converted
      ? (str(data?.currencySymbol) ?? symbolOf(conversion.currencyCode))
      : baseSymbol,
    localPrice: (basePrice) => localPrices(basePrice, discount, conversion).price,
    localOriginalPrice: (basePrice) => localPrices(basePrice, discount, conversion).original,
    formatPrice: (price, options) => formatCurrency(price, conversion.currencyCode, options),
    mismatch: isConversion && product !== null && !sameBase ? product : null,
  };
}

// ── Session Storage Helpers ──────────────────────────────────────────────────

interface CacheEntry {
  data: PPPResponse;
  timestamp: number;
}

/** Exported for tests; not public API. */
export function cacheKey(apiKey: string, productId?: string): string {
  return `${CACHE_PREFIX}${apiKey}_${productId ?? ''}`;
}

/** Exported for tests; not public API. */
export function getCachedData(key: string): PPPResponse | null {
  try {
    const raw = sessionStorage.getItem(key);
    if (!raw) return null;
    const entry: CacheEntry = JSON.parse(raw);
    // A holiday deal is not shown from the cache past its end.
    const dealEnd = entry.data?.deal ? Date.parse(entry.data.deal.endsAt) : null;
    if (!(Date.now() - entry.timestamp < CACHE_TTL_MS) || (dealEnd !== null && !(Date.now() < dealEnd))) {
      sessionStorage.removeItem(key);
      return null;
    }
    return toPPPResponse(entry.data);
  } catch {
    return null;
  }
}

/** Exported for tests; not public API. */
export function setCachedData(key: string, data: PPPResponse): void {
  try {
    const entry: CacheEntry = { data, timestamp: Date.now() };
    sessionStorage.setItem(key, JSON.stringify(entry));
  } catch {
    // sessionStorage may be unavailable (blocked storage, private browsing quota)
  }
}

// ── Provider Component ───────────────────────────────────────────────────────

/**
 * Provides PPP (Purchasing Power Parity) data to all child components.
 *
 * Wrap your app (or the section that needs PPP pricing) with this provider.
 * All `usePPP()`, `usePrice()`, and PPP components must be descendants.
 * The request runs in the browser only; on the server, and on the first
 * client render, `isLoading` is true and prices show without a discount.
 *
 * @example
 * ```tsx
 * <GoPayLocalProvider apiKey="gpl_pk_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef">
 *   <App />
 * </GoPayLocalProvider>
 * ```
 */
export function GoPayLocalProvider({
  apiKey,
  apiBase,
  productId,
  visitorId,
  persistVisitorId = true,
  baseCurrencyCode: baseCurrencyCodeProp,
  baseCurrencySymbol: baseCurrencySymbolProp,
  onLoad,
  onError,
  children,
}: GoPayLocalProviderProps) {
  const [data, setData] = useState<PPPResponse | null>(null);
  // Kept apart from `data`: the API also assigns an arm when no discount applies.
  const [experiment, setExperiment] = useState<ExperimentInfo>(NO_EXPERIMENT);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [error, setError] = useState<Error | null>(null);

  // Keep stable refs for callbacks to avoid re-fetching
  const onLoadRef = useRef(onLoad);
  onLoadRef.current = onLoad;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  const validVisitorId = isValidVisitorId(visitorId) ? visitorId : undefined;

  useEffect(() => {
    if (visitorId !== undefined && !isValidVisitorId(visitorId)) {
      console.warn(
        '[GoPayLocal] visitorId ignored: use 16 to 64 characters of A-Z, a-z, 0-9, _ or -.',
      );
    }
  }, [visitorId]);

  useIsomorphicLayoutEffect(() => {
    const key = cacheKey(apiKey, productId);

    // A cached response with a discount: use it and skip the request.
    const cached = getCachedData(key);
    if (cached) {
      setData(cached);
      setExperiment(readExperiment(cached));
      setError(null);
      setIsLoading(false);
      onLoadRef.current?.(cached);
      return;
    }

    const controller = new AbortController();
    let cancelled = false;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, REQUEST_TIMEOUT_MS);

    setData(null);
    setExperiment(NO_EXPERIMENT);
    setIsLoading(true);
    setError(null);

    fetchConfig({
      apiBase,
      apiKey,
      productId,
      visitorId: validVisitorId,
      persistVisitorId,
      signal: controller.signal,
    })
      .then(({ data: response, experiment: arm }) => {
        if (cancelled) return;
        if (response) setCachedData(key, response);
        setData(response);
        setExperiment(arm);
        setIsLoading(false);
        if (response) onLoadRef.current?.(response);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const failure = timedOut
          ? new Error(`GoPayLocal API did not respond within ${REQUEST_TIMEOUT_MS / 1000} seconds`)
          : err instanceof Error
            ? err
            : new Error(String(err));
        setData(null);
        setError(failure);
        setIsLoading(false);
        onErrorRef.current?.(failure);
      })
      .finally(() => clearTimeout(timer));

    return () => {
      cancelled = true;
      clearTimeout(timer);
      controller.abort();
    };
  }, [apiKey, apiBase, productId, validVisitorId, persistVisitorId]);

  // ── Derived Values ─────────────────────────────────────────────────────────

  const discount = data?.discount ?? 0;
  const prices = useMemo(
    () => priceContext(data, baseCurrencyCodeProp, baseCurrencySymbolProp),
    [data, baseCurrencyCodeProp, baseCurrencySymbolProp],
  );
  const country = data?.country ?? null;
  const code = data?.code ?? null;
  const flag = country ? countryToFlag(country) : '';
  const campaignId = data?.campaignId ?? null;
  const { experimentId, variant } = experiment;

  // Warn once per provider when the response could convert prices but the
  // prices passed in are in another currency than the product's.
  const warnedCurrency = useRef(false);
  useEffect(() => {
    if (prices.mismatch && !warnedCurrency.current) {
      warnedCurrency.current = true;
      console.warn(
        `[GoPayLocal] Prices are not converted: baseCurrencyCode is ${prices.baseCurrencyCode} but the product's currency is ${prices.mismatch}.`,
      );
    }
  }, [prices.mismatch, prices.baseCurrencyCode]);

  const track = useCallback(
    (event: PPPTrackableEvent): void => {
      if (!data) return;
      sendEvent({
        apiBase,
        apiKey,
        event,
        campaignId: data.campaignId ?? null,
        country: data.country || null,
        code: event === 'copy' ? data.code : null,
      });
    },
    [data, apiBase, apiKey],
  );

  const contextValue = useMemo<PPPContextValue>(
    () => ({
      data,
      isLoading,
      error,
      country,
      discount,
      code,
      baseCurrencyCode: prices.baseCurrencyCode,
      baseCurrencySymbol: prices.baseCurrencySymbol,
      currencyCode: prices.currencyCode,
      currencySymbol: prices.currencySymbol,
      fxRate: prices.fxRate,
      fxAsOf: prices.fxAsOf,
      charmPricingStrategy: prices.charmPricingStrategy,
      localPrice: prices.localPrice,
      localOriginalPrice: prices.localOriginalPrice,
      formatPrice: prices.formatPrice,
      flag,
      campaignId,
      experimentId,
      variant,
      track,
    }),
    [
      data,
      isLoading,
      error,
      country,
      discount,
      code,
      prices,
      flag,
      campaignId,
      experimentId,
      variant,
      track,
    ],
  );

  return (
    <PPPContext.Provider value={contextValue}>{children}</PPPContext.Provider>
  );
}
