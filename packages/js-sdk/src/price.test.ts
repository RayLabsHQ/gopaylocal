import { describe, expect, it } from 'vitest';
// The API's own computation and real rates (test-only imports, not bundled).
import { CHARM_STRATEGIES } from '../../shared/src/currency/charm';
import { FIXTURE_NOW, FIXTURE_RATES_2026_11_18, fixtureFxDoc } from '../../shared/src/currency/fx-test-fixture';
import { COUNTRY_CURRENCY } from '../../shared/src/currency/country-currency';
import { localPricing, type LocalPricing } from '../../shared/src/currency/local-price';
import {
  charmStrategyOf,
  digitOptions,
  localPrices,
  priceParts,
  withCurrencyDigits,
  type CharmStrategy,
  type Conversion,
} from './price';

const fx = fixtureFxDoc();

/** The response fields the SDK reads, from the API's own computation. */
function response(basePrice: number, discount: number, country: string, strategy: CharmStrategy, baseCurrency = 'USD') {
  const r = localPricing({ basePrice, baseCurrency, discountPercent: discount, country, strategy, fx, now: FIXTURE_NOW });
  if (!r) throw new Error('no pricing');
  return r;
}

function conversion(r: LocalPricing, strategy: CharmStrategy): Conversion {
  return {
    baseCurrencyCode: r.baseCurrencyCode,
    currencyCode: r.currencyCode,
    fxRate: r.fxRate,
    fxAsOf: r.fxAsOf ?? null,
    charmPricingStrategy: strategy,
  };
}

describe('localPrices matches the API', () => {
  it('reproduces the docs examples for a $19 product', () => {
    const cases: Array<[string, number, string, number, number]> = [
      ['IN', 60, 'INR', 719, 1769],
      ['BR', 50, 'BRL', 54.99, 109],
      ['NG', 65, 'NGN', 8999, 24999],
      ['ID', 55, 'IDR', 159999, 346999],
      ['DE', 20, 'EUR', 13.99, 17.3],
    ];
    for (const [country, discount, currency, price, original] of cases) {
      const c = conversion(response(19, discount, country, 'round_x9'), 'round_x9');
      expect(localPrices(19, discount, c)).toEqual({ price, original, currencyCode: currency, converted: true });
    }
  });

  it('shows the exact price, no charm, when the response is not a conversion', () => {
    const r = response(19, 60, 'US', 'round_x9');
    expect(r.fxAsOf).toBeUndefined();
    expect(localPrices(19, 60, conversion(r, 'round_x9'))).toEqual({
      price: 7.6,
      original: 19,
      currencyCode: 'USD',
      converted: false,
    });
    // Another price on the same page, same rule: 49 at 60% off is exactly 19.60.
    expect(localPrices(49, 60, conversion(r, 'round_x9')).price).toBe(19.6);
  });

  // Every fixture currency that a country maps to, every strategy, a spread of
  // prices and discounts, and two base currencies: the product's own price
  // through localPrices must equal what the API sends.
  it('gives the API answer for the product price across currencies, strategies, prices and discounts', () => {
    const countries = Object.entries(COUNTRY_CURRENCY)
      .filter(([, cur]) => cur in FIXTURE_RATES_2026_11_18)
      .map(([cc]) => cc);
    expect(countries.length).toBeGreaterThan(20);
    const prices = [0.99, 1, 4.5, 9, 19, 19.99, 29, 49.5, 99, 149, 299.99, 1000, 2499];
    const discounts = [1, 5, 10, 25, 33.3, 40, 50, 60, 75, 90, 99];
    let checked = 0;
    for (const base of ['USD', 'EUR']) {
      for (const country of countries) {
        for (const strategy of CHARM_STRATEGIES) {
          for (const p of prices) {
            for (const d of discounts) {
              const r = response(p, d, country, strategy, base);
              const got = localPrices(p, d, conversion(r, strategy));
              expect([got.price, got.original, got.currencyCode]).toEqual([r.localPrice, r.localOriginalPrice, r.currencyCode]);
              checked++;
            }
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(10000);
    // Over 10,000 pricePair searches on each side: allow for a busy CI machine.
  }, 60_000);

  it('never shows a discount bigger than the real one, and never a price below the estimate', () => {
    const c = conversion(response(19, 60, 'IN', 'round_x9'), 'round_x9');
    for (const p of [5, 12, 19, 29, 49, 99, 199, 499]) {
      for (const d of [1, 10, 30, 60, 85]) {
        const { price, original } = localPrices(p, d, c);
        expect(price).toBeGreaterThanOrEqual(p * (1 - d / 100) * c.fxRate - 1e-9);
        expect(1 - price / original).toBeLessThanOrEqual(d / 100 + 1e-9);
      }
    }
  });
});

describe('localPrices edge cases', () => {
  const inr: Conversion = {
    baseCurrencyCode: 'USD',
    currencyCode: 'INR',
    fxRate: 93.32614706,
    fxAsOf: '2026-11-18',
    charmPricingStrategy: 'round_x9',
  };

  it('keeps a free plan free, in the visitor currency', () => {
    expect(localPrices(0, 40, inr)).toEqual({ price: 0, original: 0, currencyCode: 'INR', converted: true });
  });

  it('treats a missing date or a bad rate as no conversion', () => {
    expect(localPrices(19, 60, { ...inr, fxAsOf: null }).currencyCode).toBe('USD');
    expect(localPrices(19, 60, { ...inr, fxRate: 0 }).currencyCode).toBe('USD');
    expect(localPrices(19, 60, { ...inr, fxRate: Number.NaN }).currencyCode).toBe('USD');
  });

  it('clamps the discount to 0-100', () => {
    expect(localPrices(19, -5, { ...inr, fxAsOf: null }).price).toBe(19);
    expect(localPrices(19, 150, { ...inr, fxAsOf: null }).price).toBe(0);
    expect(localPrices(19, Number.NaN, { ...inr, fxAsOf: null }).price).toBe(19);
  });

  it('reads an unknown strategy as none', () => {
    expect(charmStrategyOf('round_x9')).toBe('round_x9');
    expect(charmStrategyOf('fancy')).toBe('none');
    expect(charmStrategyOf(undefined)).toBe('none');
  });
});

describe('priceParts', () => {
  const whole = { minimumFractionDigits: 0, maximumFractionDigits: 0 };

  it('reads a whole price with group separators as integer digits only', () => {
    expect(priceParts(8999, 'NGN', whole, 'en-US')).toEqual({ integer: '8,999', decimal: '' });
    expect(priceParts(1699, 'INR', whole, 'en-IN')).toEqual({ integer: '1,699', decimal: '' });
    expect(priceParts(1699, 'INR', whole, 'de-DE')).toEqual({ integer: '1.699', decimal: '' });
  });

  it("keeps the currency's decimals, two or three", () => {
    expect(priceParts(7.6, 'USD', {}, 'en-US')).toEqual({ integer: '7', decimal: '60' });
    expect(priceParts(13.99, 'EUR', {}, 'de-DE')).toEqual({ integer: '13', decimal: '99' });
    expect(priceParts(2.334, 'KWD', {}, 'en-US')).toEqual({ integer: '2', decimal: '334' });
    expect(priceParts(1234.5, 'USD', {}, 'en-US')).toEqual({ integer: '1,234', decimal: '50' });
  });

  it('falls back to the plain number for an unknown currency code', () => {
    expect(priceParts(7.6, 'not a code')).toEqual({ integer: '7', decimal: '6' });
  });

  it('keeps the decimals of a currency whose Intl default is none (fx-review F5)', () => {
    // ICU defaults PKR to 0 fraction digits; the price was rounded to 2.
    expect(priceParts(1838.14, 'PKR', {}, 'en-US')).toEqual({ integer: '1,838', decimal: '14' });
    expect(priceParts(1838.14, 'PKR', undefined, 'en-US')).toEqual({ integer: '1,838', decimal: '14' });
    expect(priceParts(1838, 'PKR', whole, 'en-US')).toEqual({ integer: '1,838', decimal: '' });
  });
});

describe('digitOptions', () => {
  it('shows a whole amount without decimals and a fractional one with the currency digits', () => {
    expect(digitOptions(19, 'USD')).toEqual({ minimumFractionDigits: 0, maximumFractionDigits: 0 });
    expect(digitOptions(7.6, 'USD')).toEqual({ minimumFractionDigits: 2, maximumFractionDigits: 2 });
    expect(digitOptions(1838.14, 'PKR')).toEqual({ minimumFractionDigits: 2, maximumFractionDigits: 2 });
    expect(digitOptions(2.334, 'KWD')).toEqual({ minimumFractionDigits: 3, maximumFractionDigits: 3 });
  });

  it('follows showDecimal: true gives the currency digits, false gives none', () => {
    expect(digitOptions(19, 'USD', true)).toEqual({ minimumFractionDigits: 2, maximumFractionDigits: 2 });
    expect(digitOptions(719, 'JPY', true)).toEqual({ minimumFractionDigits: 0, maximumFractionDigits: 0 });
    expect(digitOptions(1838, 'PKR', true)).toEqual({ minimumFractionDigits: 0, maximumFractionDigits: 0 });
    expect(digitOptions(7.6, 'USD', false)).toEqual({ minimumFractionDigits: 0, maximumFractionDigits: 0 });
  });

  it('uses explicit digit counts and fills in the missing one without crossing', () => {
    expect(digitOptions(7.6, 'USD', undefined, 3)).toEqual({ minimumFractionDigits: 3, maximumFractionDigits: 3 });
    expect(digitOptions(7.6, 'USD', undefined, 1)).toEqual({ minimumFractionDigits: 1, maximumFractionDigits: 2 });
    expect(digitOptions(7.6, 'USD', undefined, undefined, 0)).toEqual({ minimumFractionDigits: 0, maximumFractionDigits: 0 });
    expect(digitOptions(7.6, 'USD', undefined, undefined, 4)).toEqual({ minimumFractionDigits: 2, maximumFractionDigits: 4 });
    expect(digitOptions(7.6, 'USD', undefined, 1, 3)).toEqual({ minimumFractionDigits: 1, maximumFractionDigits: 3 });
  });
});

describe('withCurrencyDigits', () => {
  it("fills in the currency's display digits only where the caller gave none", () => {
    expect(withCurrencyDigits(undefined, 'USD')).toEqual({ minimumFractionDigits: 2, maximumFractionDigits: 2 });
    // PKR is shown in whole rupees, unless the amount itself has paisa.
    expect(withCurrencyDigits(undefined, 'PKR', 1838)).toEqual({ minimumFractionDigits: 0, maximumFractionDigits: 0 });
    expect(withCurrencyDigits(undefined, 'PKR', 1838.14)).toEqual({ minimumFractionDigits: 2, maximumFractionDigits: 2 });
    expect(withCurrencyDigits(undefined, 'JPY', 1.5)).toEqual({ minimumFractionDigits: 0, maximumFractionDigits: 0 });
    expect(withCurrencyDigits({ maximumFractionDigits: 0 }, 'EUR')).toEqual({ minimumFractionDigits: 0, maximumFractionDigits: 0 });
    expect(withCurrencyDigits({ minimumFractionDigits: 3 }, 'USD')).toEqual({ minimumFractionDigits: 3, maximumFractionDigits: 3 });
    expect(withCurrencyDigits({ currencyDisplay: 'code' }, 'KWD')).toEqual({
      currencyDisplay: 'code',
      minimumFractionDigits: 3,
      maximumFractionDigits: 3,
    });
    // Significant digits are the caller's rounding; fraction digits are left out.
    expect(withCurrencyDigits({ maximumSignificantDigits: 3 }, 'USD')).toEqual({ maximumSignificantDigits: 3 });
  });
});
