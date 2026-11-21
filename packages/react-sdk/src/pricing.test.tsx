import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToString } from 'react-dom/server';
import type { ReactNode } from 'react';
import { PPPContext } from './context';
import { priceContext } from './provider';
import { usePrice, type UsePriceOptions } from './hooks/use-price';
import { PPPPrice } from './components/price';
import { PPPPriceFormatted } from './components/price-formatted';
import { PPPPriceInteger } from './components/price-integer';
import { PPPPriceDecimal } from './components/price-decimal';
import { PPPPricingTable, planPrices } from './components/pricing-table';
import { formatMoney } from '../../js-sdk/src/core';
import { formatCurrency } from './utils';
import { symbolOf } from '../../js-sdk/src/price';
import type { PPPContextValue, PPPResponse } from './types';

const BANNER = {
  position: 'bottom-right' as const,
  messageTemplate: '{{discount}}% off',
  ctaText: 'Copy',
  backgroundColor: '#000000',
  textColor: '#ffffff',
  ctaColor: '#ff0000',
  ctaTextColor: '#ffffff',
  showFlag: true,
  showCloseBtn: true,
};

/** A $19 product, 60% off for an Indian visitor (docs example, 2026-11-18 rates). */
const IN: PPPResponse = {
  show: true,
  country: 'IN',
  countryName: 'India',
  discount: 60,
  code: 'PPP60',
  banner: BANNER,
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

/** The same product for a US visitor: exact price, no conversion. */
const US: PPPResponse = {
  ...IN,
  country: 'US',
  countryName: 'United States',
  currencyCode: 'USD',
  currencySymbol: '$',
  fxRate: 1,
  fxAsOf: undefined,
  localPrice: 7.6,
  localOriginalPrice: 19,
};

/**
 * A product priced in PKR (5,251.82), 65% off for a visitor in Pakistan: no
 * conversion, so the API sends the exact pair to the paisa (PKR's ISO minor
 * unit), 1838.137 half-up to 1838.14, although PKR prices are written in whole
 * rupees. Only converted estimates are whole rupees.
 */
const PK: PPPResponse = {
  ...US,
  country: 'PK',
  countryName: 'Pakistan',
  discount: 65,
  baseCurrencyCode: 'PKR',
  baseCurrencySymbol: 'Rs',
  currencyCode: 'PKR',
  currencySymbol: 'Rs',
  localPrice: 1838.14,
  localOriginalPrice: 5251.82,
  charmPricingStrategy: 'none',
};

/** A PKR amount with exactly `d` decimals, in the test's default locale. */
function pkr(v: number, d: number, extra: Intl.NumberFormatOptions = {}): string {
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency: 'PKR',
    minimumFractionDigits: d,
    maximumFractionDigits: d,
    ...extra,
  }).format(v);
}

afterEach(() => {
  vi.restoreAllMocks();
});

function context(data: PPPResponse | null, base?: string, symbol?: string): PPPContextValue {
  const { mismatch: _m, ...prices } = priceContext(data, base, symbol);
  return {
    data,
    isLoading: false,
    error: null,
    country: data?.country ?? null,
    discount: data?.discount ?? 0,
    code: data?.code ?? null,
    ...prices,
    flag: '',
    campaignId: null,
    experimentId: null,
    variant: null,
    track: () => {},
  };
}

function inContext(value: PPPContextValue, node: ReactNode): string {
  return renderToString(<PPPContext.Provider value={value}>{node}</PPPContext.Provider>);
}

/** usePrice's result, rendered as JSON. */
function priceOf(value: PPPContextValue, options: UsePriceOptions) {
  function Probe() {
    return <pre>{JSON.stringify(usePrice(options))}</pre>;
  }
  const html = inContext(value, <Probe />);
  const json = html.replace(/^<pre>|<\/pre>$/g, '').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
  return JSON.parse(json) as ReturnType<typeof usePrice>;
}

describe('priceContext', () => {
  it("adopts the product's currency and converts when baseCurrencyCode is unset", () => {
    expect(priceContext(IN)).toMatchObject({
      baseCurrencyCode: 'USD',
      baseCurrencySymbol: '$',
      currencyCode: 'INR',
      currencySymbol: '₹',
      fxRate: 93.32614706,
      fxAsOf: '2026-11-18',
      charmPricingStrategy: 'round_x9',
      mismatch: null,
    });
  });

  it("matches the API for the product's own price", () => {
    const p = priceContext(IN);
    expect([p.localPrice(19), p.localOriginalPrice(19)]).toEqual([719, 1769]);
  });

  it('does not convert, and reports the mismatch, when baseCurrencyCode is another currency', () => {
    const p = priceContext(IN, 'eur');
    expect(p).toMatchObject({ baseCurrencyCode: 'EUR', currencyCode: 'EUR', fxRate: 1, fxAsOf: null, mismatch: 'USD' });
    expect(p.currencySymbol).toBe(symbolOf('EUR'));
    expect([p.localPrice(19), p.localOriginalPrice(19)]).toEqual([7.6, 19]);
  });

  it('keeps the base currency, exact, when the response is not a conversion', () => {
    const p = priceContext(US);
    expect(p).toMatchObject({ currencyCode: 'USD', currencySymbol: '$', fxRate: 1, fxAsOf: null, mismatch: null });
    expect([p.localPrice(19), p.localPrice(49)]).toEqual([7.6, 19.6]);
  });

  it('uses USD and no conversion before a response, with the configured symbol', () => {
    expect(priceContext(null)).toMatchObject({ baseCurrencyCode: 'USD', currencyCode: 'USD', fxAsOf: null });
    expect(priceContext(null, 'EUR', 'EUR ').currencySymbol).toBe('EUR ');
    expect(priceContext(null).localPrice(29)).toBe(29);
  });
});

describe('usePrice', () => {
  it('converts and charm-rounds like the API and the banner', () => {
    const r = priceOf(context(IN), { price: 19 });
    expect(r).toMatchObject({
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
    expect(r.decimal).toBe('');
  });

  it('gives the same numbers as @gopaylocal/js for another price', () => {
    expect(priceOf(context(IN), { price: 49 })).toMatchObject({ localPrice: 1899, localOriginalPrice: 4569 });
  });

  it('stays in the base currency with localize false', () => {
    expect(priceOf(context(IN), { price: 19, localize: false })).toMatchObject({
      localPrice: 7.6,
      localOriginalPrice: 19,
      converted: false,
      currencyCode: 'USD',
      currencySymbol: '$',
    });
  });

  it('honours showDecimal and explicit digits', () => {
    const v = context(US);
    const fmt = (n: number, o: Intl.NumberFormatOptions = {}) =>
      new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', ...o }).format(n);
    expect(priceOf(v, { price: 19 }).formattedOriginal).toBe(fmt(19, { minimumFractionDigits: 0, maximumFractionDigits: 0 }));
    expect(priceOf(v, { price: 19, showDecimal: true }).formattedOriginal).toBe(fmt(19));
    expect(priceOf(v, { price: 19, showDecimal: false }).formatted).toBe(fmt(7.6, { minimumFractionDigits: 0, maximumFractionDigits: 0 }));
    expect(priceOf(v, { price: 19, minimumDecimalDigits: 3 }).formatted).toBe(fmt(7.6, { minimumFractionDigits: 3 }));
  });

  it('gives a whole price with a group separator no decimal part', () => {
    // $2,500 at 60% off is exactly $1,000, shown without decimals.
    const r = priceOf(context(US), { price: 2500 });
    expect(r.localPrice).toBe(1000);
    expect(r.decimal).toBe('');
    expect(r.integer.replace(/\D/g, '')).toBe('1000');
  });

  it('shows exactly the digits a price has where Intl defaults to none (fx-review F5)', () => {
    // The exact prices the API sends, with their paisa, not "PKR 1,838".
    const r = priceOf(context(PK), { price: 5251.82 });
    expect(r).toMatchObject({
      localPrice: 1838.14,
      localOriginalPrice: 5251.82,
      converted: false,
      currencyCode: 'PKR',
      formatted: pkr(1838.14, 2),
      formattedOriginal: pkr(5251.82, 2),
      decimal: '14',
    });
    expect(r.formatted).not.toBe(pkr(1838, 0));
    // An amount with paisa is shown with them, not rounded to "PKR 1,838".
    expect(context(PK).formatPrice(1838.14)).toBe(pkr(1838.14, 2));
    expect(formatCurrency(1838.14, 'PKR')).toBe(pkr(1838.14, 2));
    expect(formatCurrency(1838, 'PKR')).toBe(pkr(1838, 0));
  });

  it('keeps the three decimals of a three-decimal currency', () => {
    const kw = context({ ...IN, country: 'KW', currencyCode: 'KWD', currencySymbol: 'KWD', fxRate: 0.3071, charmPricingStrategy: 'none' });
    const r = priceOf(kw, { price: 19 });
    expect(r).toMatchObject({ currencyCode: 'KWD', localPrice: 2.334 });
    expect(r.integer).toMatch(/^\d+$/);
    expect(r.decimal).toHaveLength(3);
  });
});

describe('price components', () => {
  it('PPPPrice and PPPPriceFormatted show the converted price and original', () => {
    const v = context(IN);
    expect(inContext(v, <PPPPrice price={19} />)).toContain(formatMoney(719, 'INR'));
    expect(inContext(v, <PPPPriceFormatted price={19} isOriginalDisplay />)).toContain(formatMoney(1769, 'INR'));
    const byCode = new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: 'INR',
      currencyDisplay: 'code',
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }).format(1769);
    expect(inContext(v, <PPPPriceFormatted price={19} isOriginalDisplay currencyDisplay="code" />)).toContain(byCode);
  });

  it('PPPPriceInteger and PPPPriceDecimal split a whole price with a group separator', () => {
    const v = context(US);
    const integer = inContext(v, <PPPPriceInteger price={2500} />).replace(/<[^>]+>/g, '');
    expect(integer.replace(/\D/g, '')).toBe('1000');
    expect(inContext(v, <PPPPriceDecimal price={2500} />)).toBe('');
    expect(inContext(v, <PPPPriceDecimal price={19} />)).toContain('>60<');
  });

  it('PPPPricingTable shows converted plan prices and keeps free plans free', () => {
    const html = inContext(
      context(IN),
      <PPPPricingTable
        plans={[
          { name: 'Free', price: 0, features: [] },
          { name: 'Pro', price: 19, features: [] },
        ]}
      />,
    );
    expect(html).toContain('Free');
    expect(html).toContain(formatMoney(719, 'INR'));
  });

  it('the price components show the exact PKR prices the API sends, with their paisa', () => {
    const v = context(PK);
    expect(inContext(v, <PPPPrice price={5251.82} />)).toContain(pkr(1838.14, 2));
    expect(inContext(v, <PPPPrice price={5251.82} currencyDisplay="name" />)).toContain(
      pkr(1838.14, 2, { currencyDisplay: 'name' }),
    );
    expect(inContext(v, <PPPPriceFormatted price={5251.82} isOriginalDisplay currencyDisplay="code" />)).toContain(
      pkr(5251.82, 2, { currencyDisplay: 'code' }),
    );
    expect(inContext(v, <PPPPriceDecimal price={5251.82} />)).toContain('>14<');
    expect(
      inContext(v, <PPPPricingTable plans={[{ name: 'Pro', price: 5251.82, features: [] }]} />),
    ).toContain(pkr(1838.14, 2));
  });

  it("every price formatter passes both digit options, never Intl's defaults", () => {
    const v = context(PK);
    const spy = vi.spyOn(Intl, 'NumberFormat');
    priceOf(v, { price: 5251.82 });
    priceOf(v, { price: 5000, showDecimal: true });
    priceOf(v, { price: 5251.82, minimumDecimalDigits: 1 });
    priceOf(v, { price: 5251.82, maximumDecimalDigits: 4 });
    v.formatPrice(1838.14);
    v.formatPrice(1838.14, { currencyDisplay: 'code' });
    inContext(v, <PPPPrice price={5251.82} currencyDisplay="code" />);
    inContext(v, <PPPPriceFormatted price={5251.82} isOriginalDisplay currencyDisplay="name" maximumDecimalDigits={3} />);
    inContext(v, <PPPPricingTable plans={[{ name: 'Pro', price: 5251.82, features: [] }]} />);
    expect(spy.mock.calls.length).toBeGreaterThan(0);
    for (const [, options] of spy.mock.calls) {
      expect(options).toMatchObject({
        minimumFractionDigits: expect.any(Number),
        maximumFractionDigits: expect.any(Number),
      });
    }
  });

  it("PPPPricingTable's onPlanSelect prices: finalPrice stays in the base currency, exact", () => {
    expect(planPrices(19, context(IN), 'monthly', 0)).toEqual({ finalPrice: 7.6, localPrice: 719 });
    expect(planPrices(19, context(US), 'monthly', 0)).toEqual({ finalPrice: 7.6, localPrice: 7.6 });
    expect(planPrices(0, context(IN), 'annual', 20)).toEqual({ finalPrice: 0, localPrice: 0 });
    // Annual: $19 × 0.8 = $15.20 a month, then 60% off: $6.08.
    expect(planPrices(19, context(US), 'annual', 20)).toEqual({ finalPrice: 6.08, localPrice: 6.08 });
    // finalPrice is what the provider charges, to the paisa (PKR's ISO minor
    // unit): 5,251.82 × 0.35 = 1,838.137. Unconverted, the table shows the same.
    expect(planPrices(5251.82, context(PK), 'monthly', 0)).toEqual({ finalPrice: 1838.14, localPrice: 1838.14 });
  });
});
