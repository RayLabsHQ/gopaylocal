import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GoPayLocal, toPPPData } from './client';
import { formatMoney } from './core';
import { symbolOf } from './price';
import type { ApiResponse } from './types';

/** Experiment ids are ULIDs (services/experiment.service.ts). */
const EXP = '01JD8Q0Z6N3V4C2X1B0A9S8D7F';

const BANNER = {
  position: 'top' as const,
  messageTemplate: 'Use {{code}} for {{discount}}% off',
  ctaText: 'Copy',
  backgroundColor: '#000000',
  textColor: '#ffffff',
  ctaColor: '#ff0000',
  ctaTextColor: '#ffffff',
  showFlag: true,
  showCloseBtn: true,
};

const SHOW: ApiResponse = {
  show: true,
  country: 'IN',
  countryName: 'India',
  discount: 40,
  code: 'PPP40',
  currencySymbol: '$',
  campaignId: 'camp_b',
  experimentId: EXP,
  variant: 'b',
  showBranding: true,
  banner: BANNER,
};

/**
 * A $19 product, 60% off for an Indian visitor, as the API answers it with the
 * 2026-11-18 rates (packages/shared/src/currency/docs-examples.test.ts).
 */
const SHOW_IN: ApiResponse = {
  ...SHOW,
  discount: 60,
  code: 'PPP60',
  baseCurrencyCode: 'USD',
  baseCurrencySymbol: '$',
  currencyCode: 'INR',
  currencySymbol: '₹',
  fxRate: 93.32614706,
  fxAsOf: '2026-11-18',
  localPrice: 719,
  localOriginalPrice: 1769,
  charmPricingStrategy: 'round_x9',
};

/** The same product for a US visitor: no conversion, the exact price. */
const SHOW_US: ApiResponse = {
  ...SHOW,
  country: 'US',
  countryName: 'United States',
  discount: 60,
  baseCurrencyCode: 'USD',
  baseCurrencySymbol: '$',
  currencyCode: 'USD',
  currencySymbol: '$',
  fxRate: 1,
  localPrice: 7.6,
  localOriginalPrice: 19,
  charmPricingStrategy: 'round_x9',
};

/**
 * A product priced in PKR (5,251.82), 65% off for a visitor in Pakistan: no
 * conversion, so the API sends the exact pair to the paisa (PKR's ISO minor
 * unit), 1838.137 half-up to 1838.14, although PKR prices are written in whole
 * rupees. Only converted estimates are whole rupees.
 */
const SHOW_PK: ApiResponse = {
  ...SHOW,
  country: 'PK',
  countryName: 'Pakistan',
  discount: 65,
  baseCurrencyCode: 'PKR',
  baseCurrencySymbol: 'Rs',
  currencyCode: 'PKR',
  currencySymbol: 'Rs',
  fxRate: 1,
  localPrice: 1838.14,
  localOriginalPrice: 5251.82,
  charmPricingStrategy: 'none',
};

/** A USD product ($19), 65% off for a visitor in Pakistan, converted: whole rupees. */
const SHOW_PK_CONVERTED: ApiResponse = {
  ...SHOW_IN,
  country: 'PK',
  countryName: 'Pakistan',
  discount: 65,
  code: 'PPP65',
  currencyCode: 'PKR',
  currencySymbol: 'Rs',
  fxRate: 276.4119032,
  localPrice: 1839,
  localOriginalPrice: 5251,
  charmPricingStrategy: 'none',
};

function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    key: (i: number) => [...map.keys()][i] ?? null,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

let fetchMock: ReturnType<typeof vi.fn>;
let local: Storage;
let session: Storage;

beforeEach(() => {
  fetchMock = vi.fn(async () => jsonResponse(SHOW));
  local = memoryStorage();
  session = memoryStorage();
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('localStorage', local);
  vi.stubGlobal('sessionStorage', session);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function requestedUrl(call = 0): URL {
  return new URL(fetchMock.mock.calls[call]![0] as string);
}

describe('toPPPData', () => {
  const base = { baseCurrencyCode: 'EUR', baseCurrencySymbol: '€' };

  it('returns null when no discount applies', () => {
    expect(toPPPData({ show: false, reason: 'no_discount' }, base)).toBeNull();
  });

  it('maps a discount response, including the experiment arm and local prices', () => {
    expect(toPPPData(SHOW_IN, base)).toEqual({
      show: true,
      country: 'IN',
      countryName: 'India',
      discount: 60,
      code: 'PPP60',
      baseCurrencyCode: 'USD',
      baseCurrencySymbol: '$',
      currencyCode: 'INR',
      currencySymbol: '₹',
      fxRate: 93.32614706,
      fxAsOf: '2026-11-18',
      localPrice: 719,
      localOriginalPrice: 1769,
      charmPricingStrategy: 'round_x9',
      flag: '🇮🇳',
      campaignId: 'camp_b',
      experimentId: EXP,
      variant: 'b',
      banner: BANNER,
      showBranding: true,
    });
  });

  it('uses nulls and base currency when optional fields are absent', () => {
    const data = toPPPData({ show: true, country: 'BR', discount: 30 }, base)!;
    expect(data).toMatchObject({
      code: null,
      campaignId: null,
      experimentId: null,
      variant: null,
      banner: null,
      showBranding: false,
      baseCurrencyCode: 'EUR',
      baseCurrencySymbol: '€',
      currencyCode: 'EUR',
      currencySymbol: '€',
      fxRate: 1,
      fxAsOf: null,
      localPrice: null,
      localOriginalPrice: null,
      charmPricingStrategy: 'none',
    });
  });

  it('reads a response without a rate date as not converted, whatever else it says', () => {
    const { fxAsOf: _date, ...noDate } = SHOW_IN;
    expect(toPPPData(noDate, base)).toMatchObject({ currencyCode: 'USD', currencySymbol: '$', fxRate: 1, fxAsOf: null });
    expect(toPPPData({ ...SHOW_IN, fxRate: 0 }, base)).toMatchObject({ currencyCode: 'USD', fxRate: 1, fxAsOf: null });
    expect(toPPPData({ ...SHOW_IN, charmPricingStrategy: 'fancy' }, base)!.charmPricingStrategy).toBe('none');
  });
});

describe('GoPayLocal.init request', () => {
  it('requests the hosted API with a persisted visitor id', async () => {
    const gpl = new GoPayLocal({ apiKey: 'gpl_pk_abc' });
    await gpl.init();
    const url = requestedUrl();
    expect(url.origin + url.pathname).toBe('https://api.gopaylocal.com/v1/banner/config/gpl_pk_abc');
    const vid = url.searchParams.get('vid');
    expect(vid).toMatch(/^[0-9a-f]{32}$/);
    expect(local.getItem('gpl_vid')).toBe(vid);
    expect(url.searchParams.has('product')).toBe(false);
  });

  it('sends productId as product and uses a self-hosted apiBase', async () => {
    const gpl = new GoPayLocal({
      apiKey: 'gpl_pk_abc',
      apiBase: 'https://ppp.example.com/',
      productId: 'prod_9',
    });
    await gpl.init();
    const url = requestedUrl();
    expect(url.origin + url.pathname).toBe('https://ppp.example.com/v1/banner/config/gpl_pk_abc');
    expect(url.searchParams.get('product')).toBe('prod_9');
  });

  it('with persistVisitorId false: sends no vid and stores nothing', async () => {
    const gpl = new GoPayLocal({ apiKey: 'k', persistVisitorId: false });
    await gpl.init();
    expect(requestedUrl().searchParams.has('vid')).toBe(false);
    expect(local.getItem('gpl_vid')).toBeNull();
  });

  it('sends a valid visitorId override without storing it', async () => {
    const gpl = new GoPayLocal({ apiKey: 'k', visitorId: 'user_000000000042' });
    await gpl.init();
    expect(requestedUrl().searchParams.get('vid')).toBe('user_000000000042');
    expect(local.getItem('gpl_vid')).toBeNull();
  });

  it('warns about and ignores an invalid visitorId', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const gpl = new GoPayLocal({ apiKey: 'k', visitorId: 'someone@example.com' });
    await gpl.init();
    expect(warn).toHaveBeenCalledOnce();
    const vid = requestedUrl().searchParams.get('vid');
    expect(vid).not.toContain('@');
    expect(vid).toMatch(/^[0-9a-f]{32}$/);
  });

  it('still loads when localStorage and sessionStorage are blocked', async () => {
    for (const name of ['localStorage', 'sessionStorage']) {
      Object.defineProperty(globalThis, name, {
        configurable: true,
        get() {
          throw new DOMException('blocked', 'SecurityError');
        },
      });
    }
    try {
      const gpl = new GoPayLocal({ apiKey: 'k' });
      const data = await gpl.init();
      expect(data?.discount).toBe(40);
      expect(requestedUrl().searchParams.has('vid')).toBe(false);
    } finally {
      delete (globalThis as Record<string, unknown>).localStorage;
      delete (globalThis as Record<string, unknown>).sessionStorage;
    }
  });

  it('shares one request between concurrent init() calls', async () => {
    const gpl = new GoPayLocal({ apiKey: 'k' });
    const [a, b] = await Promise.all([gpl.init(), gpl.init()]);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(a).toEqual(b);
    expect(a?.discount).toBe(40);
  });
});

describe('GoPayLocal.init responses', () => {
  it('exposes the experiment arm and calls onLoad', async () => {
    const onLoad = vi.fn();
    const gpl = new GoPayLocal({ apiKey: 'k', onLoad });
    const data = await gpl.init();
    expect(data?.experimentId).toBe(EXP);
    expect(data?.variant).toBe('b');
    expect(gpl.getExperiment()).toEqual({ experimentId: EXP, variant: 'b' });
    expect(onLoad).toHaveBeenCalledWith(data);
  });

  it('resolves null without calling onLoad when no discount applies', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ show: false, reason: 'vpn_detected' }));
    const onLoad = vi.fn();
    const listener = vi.fn();
    const gpl = new GoPayLocal({ apiKey: 'k', onLoad });
    gpl.subscribe(listener);
    expect(await gpl.init()).toBeNull();
    expect(onLoad).not.toHaveBeenCalled();
    expect(listener).toHaveBeenCalledWith(null);
    expect(gpl.getExperiment()).toBeNull();
  });

  it('keeps the experiment arm when the assigned arm has no discount', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ show: false, reason: 'no_discount', experimentId: EXP, variant: 'a' }),
    );
    const gpl = new GoPayLocal({ apiKey: 'k' });
    expect(await gpl.init()).toBeNull();
    expect(gpl.getExperiment()).toEqual({ experimentId: EXP, variant: 'a' });
  });

  it('reports a non-2xx status through onError', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: 'Invalid API key' }, 401));
    const onError = vi.fn();
    const gpl = new GoPayLocal({ apiKey: 'k', onError });
    expect(await gpl.init()).toBeNull();
    expect(onError).toHaveBeenCalledOnce();
    expect(gpl.getError()?.message).toBe('GoPayLocal API returned 401');
  });

  it('reports a timeout through onError instead of failing silently', async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal!.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          );
        }),
    );
    const onError = vi.fn();
    const gpl = new GoPayLocal({ apiKey: 'k', onError });
    const pending = gpl.init();
    await vi.advanceTimersByTimeAsync(8000);
    expect(await pending).toBeNull();
    expect(onError).toHaveBeenCalledOnce();
    expect(onError.mock.calls[0]![0].message).toMatch(/did not respond within 8 seconds/);
  });
});

describe('GoPayLocal cache', () => {
  it('reuses a cached discount response per key and product', async () => {
    await new GoPayLocal({ apiKey: 'k', productId: 'p1' }).init();
    await new GoPayLocal({ apiKey: 'k', productId: 'p1' }).init();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await new GoPayLocal({ apiKey: 'k', productId: 'p2' }).init();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(session.getItem('gpl_js2_k_p1')).not.toBeNull();
    expect(session.getItem('gpl_js2_k_p2')).not.toBeNull();
  });

  it('does not cache with cacheTtl 0', async () => {
    await new GoPayLocal({ apiKey: 'k', cacheTtl: 0 }).init();
    await new GoPayLocal({ apiKey: 'k', cacheTtl: 0 }).init();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(session.length).toBe(0);
  });

  it('does not cache a no-discount response', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ show: false }));
    await new GoPayLocal({ apiKey: 'k' }).init();
    expect(session.length).toBe(0);
  });
});

describe('GoPayLocal.track', () => {
  it('reports with the assigned campaign and country', async () => {
    const beacon = vi.fn((_url: string, _body: string) => true);
    vi.stubGlobal('navigator', { sendBeacon: beacon });
    const gpl = new GoPayLocal({ apiKey: 'gpl_pk_abc' });
    gpl.track('impression'); // before init: nothing to report
    expect(beacon).not.toHaveBeenCalled();

    await gpl.init();
    gpl.track('copy');
    const [url, body] = beacon.mock.calls[0]!;
    expect(url).toBe('https://api.gopaylocal.com/v1/events');
    expect(JSON.parse(body)).toMatchObject({
      key: 'gpl_pk_abc',
      event: 'copy',
      campaignId: 'camp_b',
      countryCode: 'IN',
      code: 'PPP40',
    });
  });
});

describe('GoPayLocal.getPrice', () => {
  it('applies the discount in the base currency', async () => {
    const gpl = new GoPayLocal({ apiKey: 'k', baseCurrencyCode: 'USD' });
    expect(gpl.getPrice(29).hasDiscount).toBe(false);
    await gpl.init();
    const price = gpl.getPrice(29);
    expect(price.discountedPrice).toBeCloseTo(17.4);
    expect(price.localPrice).toBe(17.4);
    expect(price.currencyCode).toBe('USD');
    expect(price.hasDiscount).toBe(true);
  });

  it("converts and charm-rounds like the API: the product's price matches the response", async () => {
    fetchMock.mockImplementation(async () => jsonResponse(SHOW_IN));
    const gpl = new GoPayLocal({ apiKey: 'k' });
    await gpl.init();
    const price = gpl.getPrice(19);
    expect(price).toMatchObject({
      localPrice: 719,
      localOriginalPrice: 1769,
      converted: true,
      currencyCode: 'INR',
      currencySymbol: '₹',
      formatted: formatMoney(719, 'INR'),
      formattedOriginal: formatMoney(1769, 'INR'),
      hasDiscount: true,
      discount: 60,
    });
    expect(price.discountedPrice).toBeCloseTo(7.6);
    // Another plan on the same page, same rule (round_x9, up and down).
    expect(gpl.getPrice(49)).toMatchObject({ localPrice: 1899, localOriginalPrice: 4569, currencyCode: 'INR' });
  });

  it('converts when baseCurrencyCode is set to the product currency', async () => {
    fetchMock.mockImplementation(async () => jsonResponse(SHOW_IN));
    const gpl = new GoPayLocal({ apiKey: 'k', baseCurrencyCode: 'usd' });
    await gpl.init();
    expect(gpl.getPrice(19)).toMatchObject({ localPrice: 719, currencyCode: 'INR' });
  });

  it('does not convert, and warns once, when baseCurrencyCode is not the product currency', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    fetchMock.mockImplementation(async () => jsonResponse(SHOW_IN));
    const gpl = new GoPayLocal({ apiKey: 'k', baseCurrencyCode: 'EUR' });
    await gpl.init();
    const price = gpl.getPrice(19);
    expect(price).toMatchObject({ localPrice: 7.6, localOriginalPrice: 19, converted: false, currencyCode: 'EUR' });
    expect(price.currencySymbol).toBe(symbolOf('EUR'));
    gpl.getPrice(29);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain('baseCurrencyCode is EUR');
  });

  it('keeps the base currency with localize: false', async () => {
    fetchMock.mockImplementation(async () => jsonResponse(SHOW_IN));
    const gpl = new GoPayLocal({ apiKey: 'k' });
    await gpl.init();
    expect(gpl.getPrice(19, { localize: false })).toMatchObject({
      localPrice: 7.6,
      localOriginalPrice: 19,
      converted: false,
      currencyCode: 'USD',
      currencySymbol: '$',
    });
  });

  it('shows the exact price, no charm, when the API did not convert', async () => {
    fetchMock.mockImplementation(async () => jsonResponse(SHOW_US));
    const gpl = new GoPayLocal({ apiKey: 'k' });
    await gpl.init();
    expect(gpl.getPrice(19)).toMatchObject({
      localPrice: 7.6,
      localOriginalPrice: 19,
      converted: false,
      currencyCode: 'USD',
      formatted: formatMoney(7.6, 'USD'),
      formattedOriginal: formatMoney(19, 'USD'),
    });
  });

  it('formats decimals by default, always or never', async () => {
    fetchMock.mockImplementation(async () => jsonResponse(SHOW_US));
    const gpl = new GoPayLocal({ apiKey: 'k' });
    await gpl.init();
    const fmt = (v: number, o: Intl.NumberFormatOptions = {}) =>
      new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', ...o }).format(v);
    expect(gpl.getPrice(19).formattedOriginal).toBe(fmt(19, { minimumFractionDigits: 0, maximumFractionDigits: 0 }));
    expect(gpl.getPrice(19, { showDecimal: true }).formattedOriginal).toBe(fmt(19));
    expect(gpl.getPrice(19, { showDecimal: false }).formatted).toBe(fmt(7.6, { minimumFractionDigits: 0, maximumFractionDigits: 0 }));
  });

  it('splits a three-decimal currency into its integer and decimal parts', async () => {
    fetchMock.mockImplementation(async () =>
      jsonResponse({ ...SHOW_IN, country: 'KW', countryName: 'Kuwait', currencyCode: 'KWD', currencySymbol: 'KWD', fxRate: 0.3071, charmPricingStrategy: 'none' }),
    );
    const gpl = new GoPayLocal({ apiKey: 'k' });
    await gpl.init();
    const price = gpl.getPrice(19);
    expect(price).toMatchObject({ currencyCode: 'KWD', converted: true, localPrice: 2.334 });
    expect(price.integer).toMatch(/^\d+$/);
    expect(price.decimal).toHaveLength(3);
  });

  it('shows exactly the digits a price has where Intl defaults to none (fx-review F5)', async () => {
    fetchMock.mockImplementation(async () => jsonResponse({ ...SHOW_PK }));
    const gpl = new GoPayLocal({ apiKey: 'k' });
    await gpl.init();
    const pkr = (v: number, d: number) =>
      new Intl.NumberFormat(undefined, { style: 'currency', currency: 'PKR', minimumFractionDigits: d, maximumFractionDigits: d }).format(v);
    // The exact prices the API sends, with their paisa, not "PKR 1,838".
    const price = gpl.getPrice(5251.82);
    expect(price).toMatchObject({
      localPrice: 1838.14,
      localOriginalPrice: 5251.82,
      converted: false,
      currencyCode: 'PKR',
      formatted: pkr(1838.14, 2),
      formattedOriginal: pkr(5251.82, 2),
      decimal: '14',
    });
    expect(price.formatted).not.toBe(pkr(1838, 0));
    expect(gpl.getPrice(5251.82, { showDecimal: true }).formatted).toBe(pkr(1838.14, 2));
    expect(gpl.getPrice(5251.82, { showDecimal: false }).formatted).toBe(pkr(1838, 0));
    // An amount with paisa is shown with them, not rounded to "PKR 1,838".
    expect(gpl.formatPrice(1838.14)).toBe(pkr(1838.14, 2));
    expect(gpl.formatPrice(1838.14)).not.toBe(pkr(1838, 0));
    expect(gpl.formatPrice(1838)).toBe(pkr(1838, 0));
  });

  it('a converted PKR estimate is whole rupees, the same pair as the API', async () => {
    fetchMock.mockImplementation(async () => jsonResponse({ ...SHOW_PK_CONVERTED }));
    const gpl = new GoPayLocal({ apiKey: 'k' });
    await gpl.init();
    const pkr = (v: number) =>
      new Intl.NumberFormat(undefined, { style: 'currency', currency: 'PKR', minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(v);
    expect(gpl.getPrice(19)).toMatchObject({
      localPrice: 1839,
      localOriginalPrice: 5251,
      converted: true,
      currencyCode: 'PKR',
      formatted: pkr(1839),
      formattedOriginal: pkr(5251),
      decimal: '',
    });
  });

  it("passes both digit options to Intl, never its per-currency or per-browser defaults", async () => {
    fetchMock.mockImplementation(async () => jsonResponse({ ...SHOW_PK }));
    const gpl = new GoPayLocal({ apiKey: 'k' });
    await gpl.init();
    const spy = vi.spyOn(Intl, 'NumberFormat');
    gpl.getPrice(5251.82);
    gpl.getPrice(5000);
    gpl.getPrice(5251.82, { showDecimal: true });
    gpl.getPrice(5251.82, { showDecimal: false });
    gpl.formatPrice(1838.14);
    gpl.formatPrice(1838.14, 'IDR');
    expect(spy.mock.calls.length).toBeGreaterThan(0);
    for (const [, options] of spy.mock.calls) {
      expect(options).toMatchObject({
        minimumFractionDigits: expect.any(Number),
        maximumFractionDigits: expect.any(Number),
      });
    }
  });

  it('gives a whole price no decimal part, whatever its group separator', async () => {
    fetchMock.mockImplementation(async () => jsonResponse(SHOW_US));
    const gpl = new GoPayLocal({ apiKey: 'k' });
    await gpl.init();
    const price = gpl.getPrice(2500);
    expect(price.localPrice).toBe(1000);
    expect(price.decimal).toBe('');
    expect(price.integer.replace(/\D/g, '')).toBe('1000');
    expect(gpl.getPrice(19, { showDecimal: true }).decimal).toHaveLength(2);
  });
});

describe('GoPayLocal.bindPriceElements', () => {
  /** Just enough of `document` for bindPriceElements. */
  function fakeDocument(elements: Record<string, Array<{ attr?: string }>>) {
    const made: Record<string, Array<{ textContent: string }>> = {};
    vi.stubGlobal('document', {
      querySelectorAll: (selector: string) => {
        const name = selector.slice(1, -1);
        made[name] ??= (elements[name] ?? []).map((e) => ({ textContent: '', getAttribute: () => e.attr ?? null }));
        return made[name];
      },
    });
    return (name: string) => (made[name] ?? []).map((e) => e.textContent);
  }

  it('writes converted prices and the currency they are in', async () => {
    fetchMock.mockImplementation(async () => jsonResponse(SHOW_IN));
    const gpl = new GoPayLocal({ apiKey: 'k' });
    await gpl.init();
    const text = fakeDocument({
      'data-gopaylocal-price': [{ attr: '19' }, { attr: 'x' }],
      'data-gopaylocal-price-original': [{ attr: '19' }],
      'data-gopaylocal-currency-symbol': [{}],
      'data-gopaylocal-currency-code': [{}],
      'data-gopaylocal-discount': [{}],
    });
    gpl.bindPriceElements();
    expect(text('data-gopaylocal-price')).toEqual([formatMoney(719, 'INR'), '']);
    expect(text('data-gopaylocal-price-original')).toEqual([formatMoney(1769, 'INR')]);
    expect(text('data-gopaylocal-currency-symbol')).toEqual(['₹']);
    expect(text('data-gopaylocal-currency-code')).toEqual(['INR']);
    expect(text('data-gopaylocal-discount')).toEqual(['60%']);
  });

  it('writes the base currency when prices are not converted', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    fetchMock.mockImplementation(async () => jsonResponse(SHOW_IN));
    const gpl = new GoPayLocal({ apiKey: 'k', baseCurrencyCode: 'EUR', baseCurrencySymbol: '€' });
    await gpl.init();
    const text = fakeDocument({
      'data-gopaylocal-currency-symbol': [{}],
      'data-gopaylocal-currency-code': [{}],
    });
    gpl.bindPriceElements();
    expect(text('data-gopaylocal-currency-symbol')).toEqual(['€']);
    expect(text('data-gopaylocal-currency-code')).toEqual(['EUR']);
  });
});
