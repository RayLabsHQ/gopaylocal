import { describe, expect, it } from 'vitest';
import {
  MAX_ALLOWED_DOMAINS,
  MAX_BANNER_COLOR_LENGTH,
  MAX_BANNER_CTA_LENGTH,
  MAX_BANNER_MESSAGE_LENGTH,
  MAX_DISCOUNT_OVERRIDES,
  MAX_DOMAIN_LENGTH,
  UNSUPPORTED_CURRENCY_MESSAGE,
  basePriceProblem,
  createCampaignSchema,
  createProductSchema,
  updateBannerConfigSchema,
  updateCampaignSchema,
  updateProductSchema,
} from './index';
import { COUNTRY_CURRENCY } from '../currency/country-currency';
import { SUPPORTED_CURRENCIES, SUPPORTED_CURRENCY_CODES, supportedCurrency } from '../currency/supported-currencies';

// Security review L4: every free-text field a merchant types that ends up in the
// banner's KV document has a maximum. One test per field: the limit itself is
// accepted, one more is refused.

const campaign = { productId: 'prod_123', name: 'My Campaign' };

describe('banner config free-text limits', () => {
  it('limits are generous for real use', () => {
    expect(MAX_BANNER_MESSAGE_LENGTH).toBeGreaterThanOrEqual(300);
    expect(MAX_BANNER_CTA_LENGTH).toBe(50);
    expect(MAX_BANNER_COLOR_LENGTH).toBeGreaterThanOrEqual('rgba(255, 255, 255, 0.95)'.length);
  });

  it('messageTemplate: a few hundred characters with tokens pass, over the limit is refused', () => {
    const realistic =
      'Hi there! We noticed you are visiting from {country}. To make our product fair for everyone, ' +
      'we offer purchasing power parity pricing: use code {code} at checkout to get {discount}% off. ' +
      'That brings the price to {price}. This offer is for customers in {country} only.';
    expect(realistic.length).toBeGreaterThan(200);
    expect(updateBannerConfigSchema.safeParse({ messageTemplate: realistic }).success).toBe(true);
    expect(updateBannerConfigSchema.safeParse({ messageTemplate: 'm'.repeat(MAX_BANNER_MESSAGE_LENGTH) }).success).toBe(true);
    expect(updateBannerConfigSchema.safeParse({ messageTemplate: 'm'.repeat(MAX_BANNER_MESSAGE_LENGTH + 1) }).success).toBe(false);
  });

  it('ctaText', () => {
    expect(updateBannerConfigSchema.safeParse({ ctaText: 'c'.repeat(MAX_BANNER_CTA_LENGTH) }).success).toBe(true);
    expect(updateBannerConfigSchema.safeParse({ ctaText: 'c'.repeat(MAX_BANNER_CTA_LENGTH + 1) }).success).toBe(false);
  });

  it.each(['backgroundColor', 'textColor', 'ctaColor', 'ctaTextColor'] as const)('%s', (field) => {
    expect(updateBannerConfigSchema.safeParse({ [field]: 'rgba(255, 255, 255, 0.95)' }).success).toBe(true);
    expect(updateBannerConfigSchema.safeParse({ [field]: '#'.padEnd(MAX_BANNER_COLOR_LENGTH, 'a') }).success).toBe(true);
    expect(updateBannerConfigSchema.safeParse({ [field]: '#'.padEnd(MAX_BANNER_COLOR_LENGTH + 1, 'a') }).success).toBe(false);
  });
});

describe('campaign free-text limits', () => {
  const domains = (n: number) => Array.from({ length: n }, (_, i) => `shop${i}.example.com`);
  const overrides = (n: number) => {
    const out: Record<string, number> = {};
    for (let i = 0; i < n; i++) out[String.fromCharCode(65 + Math.floor(i / 26) % 26) + String.fromCharCode(65 + (i % 26))] = 10;
    return out;
  };

  it('allowedDomains: each host name up to the DNS maximum', () => {
    const longest = `${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(61)}`;
    expect(longest.length).toBe(MAX_DOMAIN_LENGTH);
    expect(createCampaignSchema.safeParse({ ...campaign, allowedDomains: [longest] }).success).toBe(true);
    expect(createCampaignSchema.safeParse({ ...campaign, allowedDomains: [`${longest}x`] }).success).toBe(false);
    expect(updateCampaignSchema.safeParse({ allowedDomains: [`${longest}x`] }).success).toBe(false);
  });

  it('allowedDomains: number of entries', () => {
    expect(createCampaignSchema.safeParse({ ...campaign, allowedDomains: domains(MAX_ALLOWED_DOMAINS) }).success).toBe(true);
    expect(createCampaignSchema.safeParse({ ...campaign, allowedDomains: domains(MAX_ALLOWED_DOMAINS + 1) }).success).toBe(false);
    expect(updateCampaignSchema.safeParse({ allowedDomains: domains(MAX_ALLOWED_DOMAINS + 1) }).success).toBe(false);
  });

  it('discountOverrides: keys are two-letter country codes', () => {
    expect(createCampaignSchema.safeParse({ ...campaign, discountOverrides: { IN: 40 } }).success).toBe(true);
    expect(createCampaignSchema.safeParse({ ...campaign, discountOverrides: { ['X'.repeat(500)]: 40 } }).success).toBe(false);
    expect(updateCampaignSchema.safeParse({ discountOverrides: { IND: 40 } }).success).toBe(false);
  });

  it('discountOverrides: number of entries (more than there are countries is refused)', () => {
    expect(createCampaignSchema.safeParse({ ...campaign, discountOverrides: overrides(250) }).success).toBe(true);
    expect(MAX_DISCOUNT_OVERRIDES).toBeGreaterThanOrEqual(250);
    expect(createCampaignSchema.safeParse({ ...campaign, discountOverrides: overrides(MAX_DISCOUNT_OVERRIDES) }).success).toBe(true);
    expect(createCampaignSchema.safeParse({ ...campaign, discountOverrides: overrides(MAX_DISCOUNT_OVERRIDES + 1) }).success).toBe(false);
    expect(updateCampaignSchema.safeParse({ discountOverrides: overrides(MAX_DISCOUNT_OVERRIDES + 1) }).success).toBe(false);
  });

  it('null still clears both fields', () => {
    expect(updateCampaignSchema.safeParse({ discountOverrides: null, allowedDomains: null }).success).toBe(true);
  });
});

// Price-maths review F7a: a product price is a whole number of its currency's
// ISO minor units, and at least one.
describe('product basePrice in its currency', () => {
  const product = { name: 'P', url: 'https://example.com' };

  it.each<[number, string]>([
    [19.99, 'USD'],
    [0.01, 'USD'],
    [1999, 'JPY'],
    [1, 'JPY'],
    [2.5, 'KWD'],
    [0.001, 'KWD'],
    [1999.5, 'PKR'], // ISO allows paisa, even though prices are shown in whole rupees
    [18000000, 'IDR'],
    [1234567.89, 'EUR'],
    [0.1 + 0.2, 'USD'], // binary noise is not a fraction of a cent
  ])('accepts %d %s', (basePrice, currency) => {
    expect(basePriceProblem(basePrice, currency)).toBeNull();
    expect(createProductSchema.safeParse({ ...product, basePrice, currency }).success).toBe(true);
  });

  it.each<[number, string, string]>([
    [1999.5, 'JPY', 'JPY prices are whole numbers of at least 1'],
    [0.5, 'JPY', 'JPY prices are whole numbers of at least 1'],
    [0.001, 'USD', 'USD prices have at most 2 decimals and are at least 0.01'],
    [19.999, 'USD', 'USD prices have at most 2 decimals and are at least 0.01'],
    [2.5005, 'KWD', 'KWD prices have at most 3 decimals and are at least 0.001'],
  ])('refuses %d %s', (basePrice, currency, message) => {
    expect(basePriceProblem(basePrice, currency)).toBe(message);
    const r = createProductSchema.safeParse({ ...product, basePrice, currency });
    expect(r.success).toBe(false);
    expect(r.error!.issues[0]).toMatchObject({ path: ['basePrice'], message });
  });

  it('checks the default currency (USD) on create', () => {
    expect(createProductSchema.safeParse({ ...product, basePrice: 0.001 }).success).toBe(false);
    expect(createProductSchema.safeParse({ ...product, basePrice: 0.01 }).success).toBe(true);
  });

  it('checks an update that sends both; one alone is left to the route', () => {
    expect(updateProductSchema.safeParse({ basePrice: 1999.5, currency: 'JPY' }).success).toBe(false);
    expect(updateProductSchema.safeParse({ basePrice: 1999.5 }).success).toBe(true);
    expect(updateProductSchema.safeParse({ currency: 'JPY' }).success).toBe(true);
  });
});

describe('product currency: USD or a country currency (151 codes), upper case', () => {
  const product = { name: 'P', url: 'https://example.com', basePrice: 19 };

  it('the allowlist is USD plus every country currency', () => {
    expect(SUPPORTED_CURRENCIES.size).toBe(151);
    expect(SUPPORTED_CURRENCIES).toEqual(new Set(['USD', ...Object.values(COUNTRY_CURRENCY)]));
    expect(SUPPORTED_CURRENCY_CODES).toHaveLength(151);
    expect(SUPPORTED_CURRENCY_CODES[0]).toBe('AED');
  });

  it.each([
    ['usd', 'USD'],
    ['USD', 'USD'],
    [' eur ', 'EUR'],
    ['Inr', 'INR'],
    ['kwd', 'KWD'],
  ])('accepts %j and stores it as %s (create and update)', (currency, stored) => {
    const created = createProductSchema.safeParse({ ...product, currency });
    expect(created.success).toBe(true);
    expect(created.data!.currency).toBe(stored);
    const updated = updateProductSchema.safeParse({ currency });
    expect(updated.data!.currency).toBe(stored);
    expect(supportedCurrency(currency)).toBe(stored);
  });

  it.each(['XXX', 'CLF', 'UYW', 'abc', 'BGN', 'PAB', 'US', 'USDT', '', '12A'])('refuses %j (create and update)', (currency) => {
    for (const r of [
      createProductSchema.safeParse({ ...product, currency }),
      updateProductSchema.safeParse({ currency }),
    ]) {
      expect(r.success).toBe(false);
      expect(r.error!.issues).toContainEqual(
        expect.objectContaining({ path: ['currency'], message: UNSUPPORTED_CURRENCY_MESSAGE }),
      );
    }
    expect(supportedCurrency(currency)).toBeNull();
  });

  it('the basePrice check sees the normalized code ("jpy" is checked as JPY)', () => {
    const r = createProductSchema.safeParse({ ...product, basePrice: 1999.5, currency: 'jpy' });
    expect(r.success).toBe(false);
    expect(r.error!.issues).toContainEqual(
      expect.objectContaining({ path: ['basePrice'], message: 'JPY prices are whole numbers of at least 1' }),
    );
  });

  it('create still defaults to USD', () => {
    expect(createProductSchema.parse(product).currency).toBe('USD');
  });
});
