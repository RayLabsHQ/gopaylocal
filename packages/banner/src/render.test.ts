/**
 * render() against a small fake DOM (the sdk project has no DOM library).
 * The fake implements only what render() touches: createElement, className,
 * textContent/innerHTML (with HTML escaping), appendChild, attachShadow,
 * querySelector by class, click listeners and remove(). There is no
 * CSSStyleSheet, so adoptStyles falls back to a <style> element, which is
 * where these tests read the CSS from.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { formatMoney } from '../../js-sdk/src/core';
import { PLACEHOLDERS, render, type BannerData } from './render';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

class El {
  className = '';
  children: El[] = [];
  parent: El | null = null;
  style: Record<string, string> = {};
  listeners: Record<string, () => void> = {};
  type = '';
  title = '';
  href = '';
  target = '';
  rel = '';
  value = '';
  shadow: El | null = null;
  private text = '';
  private html: string | null = null;
  constructor(readonly tag: string, readonly ownerDocument: FakeDoc) {}
  get textContent(): string {
    return this.html ?? this.text + this.children.map((c) => c.textContent).join('');
  }
  set textContent(v: string) {
    this.text = String(v);
    this.html = null;
    this.children = [];
  }
  get innerHTML(): string {
    return this.html ?? esc(this.text);
  }
  set innerHTML(v: string) {
    this.html = v;
    this.children = [];
  }
  appendChild(c: El) {
    c.parent = this;
    this.children.push(c);
    return c;
  }
  removeChild(c: El) {
    this.children = this.children.filter((x) => x !== c);
  }
  remove() {
    this.parent?.removeChild(this);
    this.parent = null;
  }
  attachShadow() {
    this.shadow = new El('#shadow-root', this.ownerDocument);
    return this.shadow;
  }
  addEventListener(type: string, fn: () => void) {
    this.listeners[type] = fn;
  }
  querySelector(sel: string): El | null {
    const cls = sel.replace(/^\./, '');
    for (const c of this.children) {
      if (c.className === cls) return c;
      const found = c.querySelector(sel);
      if (found) return found;
    }
    return null;
  }
  focus() {}
  select() {}
}

class FakeDoc {
  body = new El('body', this);
  createElement(tag: string) {
    return new El(tag, this);
  }
}

const RESPONSE: BannerData = {
  show: true,
  country: 'IN',
  countryName: 'India',
  discount: 40,
  code: 'PPP40',
  currencyCode: 'INR',
  currencySymbol: '₹',
  // As the API sends them: the product's price after and before the discount.
  localPrice: 1069,
  localOriginalPrice: 1769,
  campaignId: 'camp_1',
  showBranding: false,
  banner: {
    position: 'bottom',
    messageTemplate: '{{discount}}% off with {{code}}',
    ctaText: 'Copy Code',
    backgroundColor: '#1a1a2e',
    textColor: '#ffffff',
    ctaColor: '#e94560',
    ctaTextColor: '#ffffff',
    showFlag: true,
    showCloseBtn: true,
  },
};

function withBanner(patch: Partial<BannerData['banner']>, top: Partial<BannerData> = {}): BannerData {
  return { ...RESPONSE, ...top, banner: { ...RESPONSE.banner, ...patch } };
}

let doc: FakeDoc;
let parent: El;
let on: Mock<(event: string, code?: string) => void>;

function draw(z: BannerData, still?: boolean) {
  const host = render(z, parent as unknown as HTMLElement, on, still) as unknown as El;
  const root = host.shadow!;
  const css = root.children.find((c) => c.tag === 'style')!.textContent;
  const bar = root.children.find((c) => c.className === 'B')!;
  return { host, root, css, bar };
}

beforeEach(() => {
  doc = new FakeDoc();
  parent = new El('div', doc);
  on = vi.fn<(event: string, code?: string) => void>();
  vi.stubGlobal('document', doc);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('render', () => {
  it('draws into the given parent, returns the host and reports one impression', () => {
    const { host } = draw(RESPONSE);
    expect(parent.children).toEqual([host]);
    expect(doc.body.children).toHaveLength(0);
    expect(host.style.cssText).toContain('position:fixed');
    expect(on.mock.calls).toEqual([['impression']]);
  });

  it('fills every documented placeholder, escapes the template and drops unknown ones', () => {
    const template = '<b>' + PLACEHOLDERS.map((p) => `{{${p}}}`).join('|') + '</b>{{nope}}{{constructor}}{{toString}}';
    const { bar } = draw(withBanner({ messageTemplate: template }));
    const message = bar.querySelector('.M')!.innerHTML;
    expect(message).toBe(
      '&lt;b&gt;India|IN|🇮🇳|<strong>40</strong>|<strong>PPP40</strong>|' +
        `${formatMoney(1069, 'INR')}|${formatMoney(1769, 'INR')}|₹|INR&lt;/b&gt;`,
    );
  });

  it('formats prices in the visitor currency, whole numbers without decimals', () => {
    const { bar } = draw(
      withBanner(
        { messageTemplate: 'Now {{localPrice}}, was {{localOriginalPrice}}' },
        { currencyCode: 'USD', currencySymbol: '$', localPrice: 7.6, localOriginalPrice: 19 },
      ),
    );
    const expected = `Now ${formatMoney(7.6, 'USD')}, was ${formatMoney(19, 'USD')}`;
    expect(bar.querySelector('.M')!.innerHTML).toBe(expected);
    expect(formatMoney(19, 'USD', 'en-US')).toBe('$19');
    expect(formatMoney(7.6, 'USD', 'en-US')).toBe('$7.60');
  });

  it('leaves price placeholders empty when the response has no prices', () => {
    const { localPrice: _p, localOriginalPrice: _o, currencyCode: _c, ...older } = RESPONSE;
    const { bar } = draw({ ...older, banner: { ...RESPONSE.banner, messageTemplate: '[{{localPrice}}|{{localOriginalPrice}}|{{currencyCode}}]' } });
    expect(bar.querySelector('.M')!.innerHTML).toBe('[||]');
  });

  it('escapes the values it substitutes', () => {
    const { bar } = draw(withBanner({ messageTemplate: '{{countryName}} {{code}}' }, { countryName: '<i>x</i>', code: 'A&B' }));
    expect(bar.querySelector('.M')!.innerHTML).toBe('&lt;i&gt;x&lt;/i&gt; <strong>A&amp;B</strong>');
  });

  it('puts the colours in the stylesheet, stripped of characters that could escape the declaration', () => {
    const { css } = draw(withBanner({ backgroundColor: 'red;}body{display:none', ctaTextColor: 'rgb(1, 2, 3)' }));
    expect(css).toContain('background:redbodydisplaynone;');
    expect(css).toContain('color:rgb(1, 2, 3)');
    expect(css).not.toContain('body{');
  });

  it('animates in by default and stays still when asked (the editor preview)', () => {
    expect(draw(RESPONSE).css).toContain('animation:I');
    expect(draw(RESPONSE, true).css).not.toContain('animation:I');
  });

  it('lays out a full-width bar for top and bottom, and a card in the chosen corner', () => {
    expect(draw(withBanner({ position: 'top' })).css).toContain('.B{position:fixed;top:0;left:0;right:0');
    expect(draw(withBanner({ position: 'bottom' })).css).toContain('.B{position:fixed;bottom:0;left:0;right:0');
    expect(draw(withBanner({ position: 'bottom-left' })).css).toContain('.B{position:fixed;bottom:16px;left:16px;width:300px');
    expect(draw(withBanner({ position: 'bottom-right' })).css).toContain('.B{position:fixed;bottom:16px;right:16px;width:300px');
  });

  it('shows the flag, the call to action and the close button only when enabled', () => {
    const full = draw(RESPONSE).bar;
    expect(full.querySelector('.F')!.textContent).toBe('🇮🇳');
    expect(full.querySelector('.A')!.textContent).toBe('Copy Code');
    expect(full.querySelector('.D')).not.toBeNull();

    const bare = draw(withBanner({ showFlag: false, showCloseBtn: false })).bar;
    expect(bare.querySelector('.F')).toBeNull();
    expect(bare.querySelector('.D')).toBeNull();

    // No code, no button to copy it.
    expect(draw(withBanner({}, { code: null })).bar.querySelector('.A')).toBeNull();
  });

  it('adds the "Powered by GoPayLocal" link only when the response asks for branding', () => {
    expect(draw(RESPONSE).bar.querySelector('.P')).toBeNull();
    expect(draw(withBanner({}, { showBranding: true })).bar.querySelector('.P')!.textContent).toBe('Powered by GoPayLocal');
  });

  it('reports the copy with the code, and a dismissal before removing itself', () => {
    const { host, bar } = draw(RESPONSE);
    bar.querySelector('.A')!.listeners.click!();
    expect(on).toHaveBeenLastCalledWith('copy', 'PPP40');

    bar.querySelector('.D')!.listeners.click!();
    expect(on).toHaveBeenLastCalledWith('dismiss');
    expect(parent.children).not.toContain(host);
  });
});
