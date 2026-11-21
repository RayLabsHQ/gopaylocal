import { describe, expect, it, vi } from 'vitest';
import { renderToString } from 'react-dom/server';
import { PPPContext } from '../context';
import { PPPBanner } from './banner';
import { priceContext } from '../provider';
import { formatMoney } from '../../../js-sdk/src/core';
import type { PPPContextValue, PPPResponse } from '../types';

const DATA: PPPResponse = {
  show: true,
  country: 'IN',
  countryName: 'India',
  discount: 40,
  code: 'PPP40',
  campaignId: 'camp_b',
  showBranding: false,
  banner: {
    position: 'bottom-right',
    messageTemplate: 'Use {{code}} for {{discount}}% off',
    ctaText: 'Copy',
    backgroundColor: '#123456',
    textColor: '#ffffff',
    ctaColor: '#ff0000',
    ctaTextColor: '#ffffff',
    showFlag: true,
    showCloseBtn: true,
  },
};

function context(data: PPPResponse | null, baseCurrencyCode?: string): PPPContextValue {
  const { mismatch: _mismatch, ...prices } = priceContext(data, baseCurrencyCode);
  return {
    data,
    isLoading: false,
    error: null,
    country: data?.country ?? null,
    discount: data?.discount ?? 0,
    code: data?.code ?? null,
    ...prices,
    flag: '',
    campaignId: data?.campaignId ?? null,
    experimentId: null,
    variant: null,
    track: vi.fn(),
  };
}

function render(data: PPPResponse | null, props: Parameters<typeof PPPBanner>[0] = {}, baseCurrencyCode?: string) {
  return renderToString(
    <PPPContext.Provider value={context(data, baseCurrencyCode)}>
      <PPPBanner {...props} />
    </PPPContext.Provider>,
  );
}

describe('PPPBanner', () => {
  it('renders nothing without a discount', () => {
    expect(render(null)).toBe('');
  });

  it('renders the dashboard message and design', () => {
    const html = render(DATA);
    expect(html).toContain('Use PPP40 for 40% off');
    expect(html).toContain('background:#123456');
    expect(html).toContain('aria-label="Dismiss"');
  });

  it('shows "Powered by GoPayLocal" only when the API asks for it', () => {
    expect(render(DATA)).not.toContain('Powered by GoPayLocal');
    for (const noStyles of [false, true]) {
      const html = render({ ...DATA, showBranding: true }, { noStyles });
      expect(html).toContain('Powered by GoPayLocal');
      expect(html).toContain('href="https://gopaylocal.com/?utm_source=banner&amp;utm_medium=referral"');
      expect(html).toContain('rel="noopener"');
    }
  });

  it('respects the dashboard close-button setting unless the prop overrides it', () => {
    const hidden = { ...DATA, banner: { ...DATA.banner, showCloseBtn: false } };
    expect(render(hidden)).not.toContain('aria-label="Dismiss"');
    expect(render(hidden, { showCloseIcon: true })).toContain('aria-label="Dismiss"');
    expect(render(DATA, { showCloseIcon: false })).not.toContain('aria-label="Dismiss"');
  });

  it("fills the price placeholders with the product's price in the visitor currency", () => {
    const priced: PPPResponse = {
      ...DATA,
      discount: 60,
      baseCurrencyCode: 'USD',
      baseCurrencySymbol: '$',
      currencyCode: 'INR',
      currencySymbol: '₹',
      fxRate: 93.32614706,
      fxAsOf: '2026-11-18',
      localPrice: 719,
      localOriginalPrice: 1769,
      charmPricingStrategy: 'round_x9',
      banner: { ...DATA.banner, messageTemplate: '{{flag}} {{localPrice}} instead of {{localOriginalPrice}} ({{currencyCode}})' },
    };
    const expected = `🇮🇳 ${formatMoney(719, 'INR')} instead of ${formatMoney(1769, 'INR')} (INR)`;
    expect(render(priced)).toContain(expected);
    // The banner shows the product's price even when the page's own prices
    // are in another currency and are not converted.
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(render(priced, {}, 'EUR')).toContain(expected);
  });

  it('keeps colors inside their CSS declaration', () => {
    const html = render(DATA, { backgroundColor: 'url(//evil.example/x.png)' });
    expect(html).not.toContain('//evil.example');
  });
});
