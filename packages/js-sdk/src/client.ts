import type {
  GoPayLocalConfig,
  PPPData,
  PricingResult,
  BannerOptions,
  ApiResponse,
  DealInfo,
} from './types';
import { countryToFlag, formatCurrency } from './utils';
import { createBanner } from './banner';
import { charmStrategyOf, digitOptions, localPrices, priceParts, symbolOf, type Conversion } from './price';
import {
  buildConfigUrl,
  isValidVisitorId,
  normalizeApiBase,
  readExperiment,
  resolveVisitorId,
  sendEvent,
  type ExperimentInfo,
  type TrackableEvent,
} from './core';

const DEFAULT_CACHE_TTL = 5 * 60 * 1000; // 5 minutes
const REQUEST_TIMEOUT_MS = 8000;
// v2: PPPData gained the multi-currency fields; older entries are ignored.
const STORAGE_PREFIX = 'gpl_js2_';

/** Resolved configuration with all defaults applied. */
interface ResolvedConfig {
  apiKey: string;
  apiBase: string;
  productId: string | null;
  visitorId: string | null;
  persistVisitorId: boolean;
  /** As configured; null means "the product's currency". */
  baseCurrencyCode: string | null;
  baseCurrencySymbol: string | null;
  onLoad?: (data: PPPData) => void;
  onError?: (error: Error) => void;
  cacheTtl: number;
}

/** The `deal` of a config response, or null when there is none or it is malformed. */
function readDeal(value: unknown): DealInfo | null {
  const d = (value ?? {}) as { id?: unknown; name?: unknown; endsAt?: unknown };
  return typeof d.id === 'string' &&
    typeof d.name === 'string' &&
    typeof d.endsAt === 'string' &&
    Number.isFinite(Date.parse(d.endsAt))
    ? { id: d.id, name: d.name, endsAt: d.endsAt }
    : null;
}

/**
 * Turn a raw API response into PPPData, or null when no discount applies.
 * Exported for tests; not part of the public API.
 */
export function toPPPData(
  json: ApiResponse,
  base: { baseCurrencyCode: string; baseCurrencySymbol: string },
): PPPData | null {
  if (!json || json.show !== true) return null;
  const { experimentId, variant } = readExperiment(json);
  const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
  const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const baseCurrencyCode = str(json.baseCurrencyCode) ?? base.baseCurrencyCode;
  const baseCurrencySymbol = str(json.baseCurrencySymbol) ?? base.baseCurrencySymbol;
  // A conversion needs its date and a positive rate; anything less is read as
  // "not converted", which is always correct (prices stay in the base currency).
  const fxAsOf = str(json.fxAsOf);
  const fxRate = num(json.fxRate);
  const converted = fxAsOf !== null && fxRate !== null && fxRate > 0;
  return {
    show: true,
    country: json.country ?? '',
    countryName: json.countryName ?? '',
    discount: json.discount ?? 0,
    code: json.code ?? null,
    baseCurrencyCode,
    baseCurrencySymbol,
    currencyCode: converted ? (str(json.currencyCode) ?? baseCurrencyCode) : baseCurrencyCode,
    currencySymbol: converted ? (str(json.currencySymbol) ?? baseCurrencySymbol) : baseCurrencySymbol,
    fxRate: converted ? fxRate : 1,
    fxAsOf: converted ? fxAsOf : null,
    localPrice: num(json.localPrice),
    localOriginalPrice: num(json.localOriginalPrice),
    charmPricingStrategy: charmStrategyOf(json.charmPricingStrategy),
    flag: countryToFlag(json.country ?? ''),
    campaignId: json.campaignId ?? null,
    experimentId,
    variant,
    banner: json.banner ?? null,
    deal: readDeal(json.deal),
    showBranding: json.showBranding === true,
  };
}

/**
 * GoPayLocal — imperative JS SDK for Purchasing Power Parity.
 *
 * Works in any JavaScript environment with DOM access (vanilla JS, Vue, Svelte,
 * static sites, WordPress, etc.).
 *
 * @example
 * ```js
 * const gpl = new GoPayLocal({ apiKey: 'gpl_pk_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef' });
 * const data = await gpl.init();
 *
 * if (data) {
 *   const pricing = gpl.getPrice(29);
 *   console.log(pricing.formatted); // "$17.40" for a 40% discount
 * }
 * ```
 */
export class GoPayLocal {
  private config: ResolvedConfig;
  private data: PPPData | null = null;
  // Kept apart from `data`: the API also assigns an arm when no discount applies.
  private experiment: ExperimentInfo = { experimentId: null, variant: null };
  private loading = false;
  private pending: Promise<PPPData | null> | null = null;
  private error: Error | null = null;
  private listeners: Set<(data: PPPData | null) => void> = new Set();
  private warnedCurrency = false;

  constructor(config: GoPayLocalConfig) {
    if (config.visitorId !== undefined && !isValidVisitorId(config.visitorId)) {
      console.warn(
        '[GoPayLocal] visitorId ignored: use 16 to 64 characters of A-Z, a-z, 0-9, _ or -.',
      );
    }
    this.config = {
      apiKey: config.apiKey,
      apiBase: normalizeApiBase(config.apiBase),
      productId: config.productId || null,
      visitorId: isValidVisitorId(config.visitorId) ? config.visitorId : null,
      persistVisitorId: config.persistVisitorId ?? true,
      baseCurrencyCode: config.baseCurrencyCode?.trim().toUpperCase() || null,
      baseCurrencySymbol: config.baseCurrencySymbol || null,
      onLoad: config.onLoad,
      onError: config.onError,
      cacheTtl: config.cacheTtl ?? DEFAULT_CACHE_TTL,
    };
  }

  // ── Initialization ──────────────────────────────────────────────────────

  /**
   * Fetch PPP data for the current visitor. Call once on page load.
   * Resolves to the data, or null when no discount applies or the request
   * failed (see `getError()` and `onError`). Calls made while a request is in
   * flight share it.
   */
  init(): Promise<PPPData | null> {
    if (this.pending) return this.pending;
    this.pending = this.load().finally(() => {
      this.pending = null;
    });
    return this.pending;
  }

  private async load(): Promise<PPPData | null> {
    this.loading = true;
    this.error = null;

    // 1. A cached response with a discount (sessionStorage)
    const cached = this.getCached();
    if (cached) {
      this.data = cached;
      this.experiment = readExperiment(cached);
      this.loading = false;
      this.config.onLoad?.(cached);
      this.notifyListeners();
      return cached;
    }

    // 2. Ask the API
    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, REQUEST_TIMEOUT_MS);

    try {
      const url = buildConfigUrl({
        apiBase: this.config.apiBase,
        apiKey: this.config.apiKey,
        productId: this.config.productId,
        visitorId: resolveVisitorId({
          visitorId: this.config.visitorId,
          persist: this.config.persistVisitorId,
        }),
      });
      const response = await fetch(url, {
        signal: controller.signal,
        headers: { Accept: 'application/json' },
      });

      if (!response.ok) {
        throw new Error(`GoPayLocal API returned ${response.status}`);
      }

      const json = (await response.json()) as ApiResponse;
      const pppData = toPPPData(json, this.fallbackBase());
      this.data = pppData;
      this.experiment = readExperiment(json);
      this.loading = false;

      if (pppData) {
        this.setCache(pppData);
        this.config.onLoad?.(pppData);
      }
      this.notifyListeners();
      return pppData;
    } catch (err) {
      const error = timedOut
        ? new Error(`GoPayLocal API did not respond within ${REQUEST_TIMEOUT_MS / 1000} seconds`)
        : err instanceof Error
          ? err
          : new Error(String(err));
      this.error = error;
      this.data = null;
      this.experiment = { experimentId: null, variant: null };
      this.loading = false;
      this.config.onError?.(error);
      this.notifyListeners();
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }

  // ── Accessors ───────────────────────────────────────────────────────────

  /** Get current PPP data (null if not loaded yet or no discount). */
  getData(): PPPData | null {
    return this.data;
  }

  /** Whether data is currently loading. */
  isLoading(): boolean {
    return this.loading;
  }

  /** Get the last error, if any. */
  getError(): Error | null {
    return this.error;
  }

  /** Get the coupon code. */
  getCode(): string | null {
    return this.data?.code ?? null;
  }

  /**
   * Which experiment arm this visitor is in, if an A/B experiment applied.
   * Also set when the visitor's arm has no discount for them (then
   * `getData()` is null), so you can attribute both arms in your analytics.
   */
  getExperiment(): { experimentId: string; variant: 'a' | 'b' } | null {
    const { experimentId, variant } = this.experiment;
    return experimentId && variant ? { experimentId, variant } : null;
  }

  /** Get country info for the current visitor. */
  getCountry(): { code: string; name: string; flag: string } | null {
    if (!this.data) return null;
    return {
      code: this.data.country,
      name: this.data.countryName,
      flag: this.data.flag,
    };
  }

  // ── Price Calculation ───────────────────────────────────────────────────

  /**
   * Apply the visitor's discount to a base price and format it.
   *
   * When the API converted your product's price (`getData().fxAsOf` is set)
   * and `baseCurrencyCode` is your product's currency, the price is converted
   * to the visitor's currency with the response's rate and rounded with the
   * campaign's charm strategy, exactly as the API rounds your product's price:
   * the discounted price up, the original down. Otherwise it stays in your
   * base currency, exact. Converted prices are estimates; your payment
   * provider charges the exact discounted price in your currency.
   *
   * @param basePrice - The price in your base currency (e.g., 29 for $29).
   * @param options.localize - Convert to the visitor's currency when possible. Defaults to true.
   * @param options.showDecimal - `true` always shows the currency's decimals, `false` never
   *   does; by default whole amounts show none ("₹719", "$19") and others keep them ("$7.60").
   */
  getPrice(
    basePrice: number,
    options?: { localize?: boolean; showDecimal?: boolean },
  ): PricingResult {
    const { localize = true, showDecimal } = options ?? {};
    const data = this.data;
    const discount = data?.discount ?? 0;
    const hasDiscount = discount > 0 && data?.show === true;
    const view = this.priceView(localize);
    const prices = localPrices(basePrice, hasDiscount ? discount : 0, view.conversion);
    const currencyCode = prices.currencyCode;
    const currencySymbol = prices.converted ? view.symbol : view.baseSymbol;

    // Explicit digits (never Intl's defaults): see digitOptions.
    const digits = (v: number) => digitOptions(v, currencyCode, showDecimal);
    const format = (v: number) => formatCurrency(v, currencyCode, digits(v));
    const formatted = format(prices.price);
    // The same digit options as `format`, read from Intl so a whole "₦8,999"
    // or a three-decimal "KWD 2.280" splits correctly.
    const parts = priceParts(prices.price, currencyCode, digits(prices.price));

    return {
      originalPrice: basePrice,
      discountedPrice: hasDiscount ? basePrice * (1 - discount / 100) : basePrice,
      localPrice: prices.price,
      localOriginalPrice: prices.original,
      converted: prices.converted,
      formatted,
      formattedOriginal: format(prices.original),
      integer: parts.integer,
      decimal: parts.decimal,
      currencySymbol,
      currencyCode,
      hasDiscount,
      discount,
    };
  }

  /**
   * Format a number as currency in the visitor's locale, by default in the
   * currency `getPrice()` shows prices in, with that currency's decimal digits
   * (USD 2, KWD 3, JPY and PKR 0, or more if the amount has them: PKR 1838.14
   * keeps its 2). Uses Intl.NumberFormat.
   */
  formatPrice(amount: number, currencyCode?: string): string {
    return formatCurrency(amount, currencyCode ?? this.priceView(true).conversion.currencyCode);
  }

  // ── Subscription ────────────────────────────────────────────────────────

  /**
   * Subscribe to data changes. The listener is called whenever PPP data
   * is loaded or cleared. Returns an unsubscribe function.
   */
  subscribe(listener: (data: PPPData | null) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  // ── DOM Binding ─────────────────────────────────────────────────────────

  /**
   * Auto-update all elements with GoPayLocal data attributes.
   *
   * Supported attributes:
   * - `data-gopaylocal-price="99.99"` — replaced with the localized discounted price
   * - `data-gopaylocal-price-original="99.99"` — replaced with the original price (for strikethrough)
   * - `data-gopaylocal-currency-symbol` — replaced with the visitor's currency symbol
   * - `data-gopaylocal-currency-code` — replaced with the visitor's currency code
   * - `data-gopaylocal-country` — replaced with the country name
   * - `data-gopaylocal-country-flag` — replaced with the flag emoji
   * - `data-gopaylocal-discount` — replaced with the discount percentage
   * - `data-gopaylocal-coupon` — replaced with the coupon code
   */
  bindPriceElements(): void {
    const data = this.data;
    if (!data) return;

    // Localized discounted prices
    const priceEls = document.querySelectorAll<HTMLElement>('[data-gopaylocal-price]');
    priceEls.forEach((el) => {
      const basePrice = parseFloat(el.getAttribute('data-gopaylocal-price') ?? '');
      if (isNaN(basePrice)) return;
      const result = this.getPrice(basePrice);
      el.textContent = result.formatted;
    });

    // Original prices (for strikethrough display)
    const originalEls = document.querySelectorAll<HTMLElement>(
      '[data-gopaylocal-price-original]',
    );
    originalEls.forEach((el) => {
      const basePrice = parseFloat(
        el.getAttribute('data-gopaylocal-price-original') ?? '',
      );
      if (isNaN(basePrice)) return;
      const result = this.getPrice(basePrice);
      el.textContent = result.formattedOriginal;
    });

    // Currency symbol and code: the currency the prices above are shown in
    const view = this.priceView(true);
    const shown = view.conversion.fxAsOf ? view.conversion.currencyCode : view.conversion.baseCurrencyCode;
    const symbolEls = document.querySelectorAll<HTMLElement>(
      '[data-gopaylocal-currency-symbol]',
    );
    symbolEls.forEach((el) => {
      el.textContent = view.conversion.fxAsOf ? view.symbol : view.baseSymbol;
    });

    const codeEls = document.querySelectorAll<HTMLElement>(
      '[data-gopaylocal-currency-code]',
    );
    codeEls.forEach((el) => {
      el.textContent = shown;
    });

    // Country name
    const countryEls = document.querySelectorAll<HTMLElement>(
      '[data-gopaylocal-country]',
    );
    countryEls.forEach((el) => {
      el.textContent = data.countryName;
    });

    // Country flag
    const flagEls = document.querySelectorAll<HTMLElement>(
      '[data-gopaylocal-country-flag]',
    );
    flagEls.forEach((el) => {
      el.textContent = data.flag;
    });

    // Discount percentage
    const discountEls = document.querySelectorAll<HTMLElement>(
      '[data-gopaylocal-discount]',
    );
    discountEls.forEach((el) => {
      el.textContent = `${data.discount}%`;
    });

    // Coupon code
    const couponEls = document.querySelectorAll<HTMLElement>(
      '[data-gopaylocal-coupon]',
    );
    couponEls.forEach((el) => {
      el.textContent = data.code ?? '';
    });
  }

  // ── Banner ──────────────────────────────────────────────────────────────

  /**
   * Show a PPP discount banner. Uses the campaign's banner design from the API,
   * with `options` overriding it. Reports a copied code to your GoPayLocal
   * analytics, like the script-tag banner. (The impression was counted by the
   * API when `init()` fetched the offer.)
   * Returns a handle with a `remove()` method. Does nothing before `init()`
   * has resolved with data.
   */
  showBanner(options?: BannerOptions): { remove: () => void } {
    const data = this.data;

    if (!data || !data.show) {
      return { remove: () => {} };
    }

    const bannerEl = createBanner(data, options, {
      copy: () => this.track('copy'),
    });
    document.body.appendChild(bannerEl);

    return {
      remove: () => {
        bannerEl.remove();
      },
    };
  }

  // ── Analytics ───────────────────────────────────────────────────────────

  /**
   * Report a banner interaction to your GoPayLocal analytics, for when you
   * build your own banner instead of calling `showBanner()` (which reports
   * these itself). Sent with the current campaign (the assigned arm during
   * an experiment) and country. Does nothing when no discount applies.
   *
   * Only `'click'` and `'copy'` are sent. `'impression'` and `'dismiss'` are
   * accepted and do nothing: the API counts an impression when it serves the
   * offer, and stores no dismissals.
   */
  track(event: TrackableEvent): void {
    const data = this.data;
    if (!data) return;
    sendEvent({
      apiBase: this.config.apiBase,
      apiKey: this.config.apiKey,
      event,
      campaignId: data.campaignId,
      country: data.country || null,
      code: event === 'copy' ? data.code : null,
    });
  }

  // ── Private Helpers ─────────────────────────────────────────────────────

  /** Base currency and symbol to assume when the response does not say. */
  private fallbackBase(): { baseCurrencyCode: string; baseCurrencySymbol: string } {
    const code = this.config.baseCurrencyCode ?? 'USD';
    return { baseCurrencyCode: code, baseCurrencySymbol: this.config.baseCurrencySymbol ?? symbolOf(code) };
  }

  /**
   * How `getPrice()` treats prices right now. Converts only when asked to,
   * when the response is a conversion, and when the prices passed in are in
   * the product's currency (`baseCurrencyCode` unset means they are). On a
   * mismatch it warns once and keeps prices in `baseCurrencyCode`.
   */
  private priceView(localize: boolean): { conversion: Conversion; symbol: string; baseSymbol: string } {
    const data = this.data;
    const fallback = this.fallbackBase();
    const base = this.config.baseCurrencyCode ?? data?.baseCurrencyCode ?? fallback.baseCurrencyCode;
    const sameBase = !!data && data.baseCurrencyCode === base;
    const baseSymbol = this.config.baseCurrencySymbol ?? (sameBase ? data.baseCurrencySymbol : symbolOf(base));
    if (data?.fxAsOf && localize && !sameBase && !this.warnedCurrency) {
      this.warnedCurrency = true;
      console.warn(
        `[GoPayLocal] Prices are not converted: baseCurrencyCode is ${base} but the product's currency is ${data.baseCurrencyCode}.`,
      );
    }
    const conversion: Conversion =
      data && localize && sameBase
        ? {
            baseCurrencyCode: base,
            currencyCode: data.currencyCode,
            fxRate: data.fxRate,
            fxAsOf: data.fxAsOf,
            charmPricingStrategy: data.charmPricingStrategy,
          }
        : { baseCurrencyCode: base, currencyCode: base, fxRate: 1, fxAsOf: null, charmPricingStrategy: 'none' };
    return { conversion, symbol: data?.currencySymbol ?? baseSymbol, baseSymbol };
  }

  private notifyListeners(): void {
    this.listeners.forEach((fn) => {
      try {
        fn(this.data);
      } catch {
        // Swallow errors in listeners to prevent cascading failures
      }
    });
  }

  private getCacheKey(): string {
    return `${STORAGE_PREFIX}${this.config.apiKey}_${this.config.productId ?? ''}`;
  }

  private getCached(): PPPData | null {
    try {
      const raw = sessionStorage.getItem(this.getCacheKey());
      if (!raw) return null;

      const parsed = JSON.parse(raw) as { data: PPPData; timestamp: number };
      if (
        !(Date.now() - parsed.timestamp < this.config.cacheTtl) ||
        !parsed.data ||
        parsed.data.show !== true ||
        // A holiday deal is not shown from the cache past its end.
        (parsed.data.deal != null && !(Date.now() < Date.parse(parsed.data.deal.endsAt)))
      ) {
        sessionStorage.removeItem(this.getCacheKey());
        return null;
      }

      return parsed.data;
    } catch {
      return null;
    }
  }

  private setCache(data: PPPData): void {
    if (this.config.cacheTtl <= 0) return;
    try {
      sessionStorage.setItem(
        this.getCacheKey(),
        JSON.stringify({ data, timestamp: Date.now() }),
      );
    } catch {
      // sessionStorage may be unavailable (e.g., private browsing, SSR)
    }
  }
}
