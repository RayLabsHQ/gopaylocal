import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_API_BASE,
  VISITOR_ID_STORAGE_KEY,
  adoptStyles,
  buildConfigUrl,
  cssColor,
  fillTemplate,
  flagOf,
  formatMoney,
  generateVisitorId,
  PLACEHOLDERS,
  templateValues,
  isValidVisitorId,
  readExperiment,
  resolveVisitorId,
  sendEvent,
} from './core';
import { THREE_DECIMAL_CURRENCIES } from '../../shared/src/currency/exponents';

/** In-memory Storage with optional failure modes. */
function fakeStorage(opts: { failGet?: boolean; failSet?: boolean } = {}): Storage & {
  map: Map<string, string>;
} {
  const map = new Map<string, string>();
  return {
    map,
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    key: (i: number) => [...map.keys()][i] ?? null,
    getItem: (k: string) => {
      if (opts.failGet) throw new DOMException('blocked', 'SecurityError');
      return map.get(k) ?? null;
    },
    setItem: (k: string, v: string) => {
      if (opts.failSet) throw new DOMException('full', 'QuotaExceededError');
      map.set(k, v);
    },
    removeItem: (k: string) => {
      map.delete(k);
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('isValidVisitorId', () => {
  it('accepts 16 to 64 characters of A-Z a-z 0-9 _ -', () => {
    expect(isValidVisitorId('a'.repeat(16))).toBe(true);
    expect(isValidVisitorId('a'.repeat(64))).toBe(true);
    expect(isValidVisitorId('Ab3_-Ab3_-Ab3_-Ab3_')).toBe(true);
  });

  it('rejects other lengths, characters and types', () => {
    expect(isValidVisitorId('a'.repeat(15))).toBe(false);
    expect(isValidVisitorId('a'.repeat(65))).toBe(false);
    expect(isValidVisitorId('someone@example.com.au')).toBe(false);
    expect(isValidVisitorId('has space in it here')).toBe(false);
    expect(isValidVisitorId(undefined)).toBe(false);
    expect(isValidVisitorId(null)).toBe(false);
    expect(isValidVisitorId(12345678901234567890)).toBe(false);
  });
});

describe('generateVisitorId', () => {
  it('returns 32 lowercase hex characters from Web Crypto', () => {
    const spy = vi.spyOn(globalThis.crypto, 'getRandomValues');
    const id = generateVisitorId();
    expect(id).toMatch(/^[0-9a-f]{32}$/);
    expect(isValidVisitorId(id)).toBe(true);
    expect(spy).toHaveBeenCalledOnce();
  });

  it('keeps leading zero nibbles (each byte is two characters)', () => {
    vi.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation((arr) => {
      (arr as Uint8Array).fill(0x0a);
      return arr;
    });
    expect(generateVisitorId()).toBe('0a'.repeat(16));
  });

  it('returns null without Web Crypto (no Math.random fallback)', () => {
    vi.stubGlobal('crypto', undefined);
    const random = vi.spyOn(Math, 'random');
    expect(generateVisitorId()).toBeNull();
    expect(random).not.toHaveBeenCalled();
  });
});

describe('resolveVisitorId', () => {
  const valid = 'site_user_0123456789';

  it('uses a valid override and never stores it', () => {
    const storage = fakeStorage();
    expect(resolveVisitorId({ visitorId: valid, storage })).toBe(valid);
    expect(storage.map.size).toBe(0);
  });

  it('uses a valid override even with persist false', () => {
    expect(resolveVisitorId({ visitorId: valid, persist: false, storage: fakeStorage() })).toBe(valid);
  });

  it('ignores an invalid override and falls back to the stored id', () => {
    const storage = fakeStorage();
    storage.map.set(VISITOR_ID_STORAGE_KEY, 'f'.repeat(32));
    expect(resolveVisitorId({ visitorId: 'bad id', storage })).toBe('f'.repeat(32));
  });

  it('with persist false: sends none and does not touch storage', () => {
    const storage = fakeStorage();
    const get = vi.spyOn(storage, 'getItem');
    expect(resolveVisitorId({ persist: false, storage })).toBeNull();
    expect(get).not.toHaveBeenCalled();
    expect(storage.map.size).toBe(0);
  });

  it('reuses the stored id', () => {
    const storage = fakeStorage();
    storage.map.set(VISITOR_ID_STORAGE_KEY, 'stored_id_1234567890');
    expect(resolveVisitorId({ storage })).toBe('stored_id_1234567890');
  });

  it('generates, stores under gpl_vid and then reuses a new id', () => {
    const storage = fakeStorage();
    const first = resolveVisitorId({ storage });
    expect(first).toMatch(/^[0-9a-f]{32}$/);
    expect(storage.map.get('gpl_vid')).toBe(first);
    expect(resolveVisitorId({ storage })).toBe(first);
  });

  it('replaces a stored value that is not a valid id', () => {
    const storage = fakeStorage();
    storage.map.set(VISITOR_ID_STORAGE_KEY, '<script>');
    const id = resolveVisitorId({ storage });
    expect(id).toMatch(/^[0-9a-f]{32}$/);
    expect(storage.map.get(VISITOR_ID_STORAGE_KEY)).toBe(id);
  });

  it('returns null when there is no storage', () => {
    expect(resolveVisitorId({ storage: null })).toBeNull();
  });

  it('returns null when reading storage throws', () => {
    expect(resolveVisitorId({ storage: fakeStorage({ failGet: true }) })).toBeNull();
  });

  it('returns null, not an unstored id, when writing storage throws', () => {
    expect(resolveVisitorId({ storage: fakeStorage({ failSet: true }) })).toBeNull();
  });

  it('returns null when Web Crypto is missing', () => {
    vi.stubGlobal('crypto', undefined);
    const storage = fakeStorage();
    expect(resolveVisitorId({ storage })).toBeNull();
    expect(storage.map.size).toBe(0);
  });

  it('defaults to globalThis.localStorage', () => {
    const storage = fakeStorage();
    vi.stubGlobal('localStorage', storage);
    const id = resolveVisitorId();
    expect(storage.map.get(VISITOR_ID_STORAGE_KEY)).toBe(id);
  });

  it('survives a localStorage getter that throws (storage blocked)', () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() {
        throw new DOMException('The operation is insecure.', 'SecurityError');
      },
    });
    try {
      expect(resolveVisitorId()).toBeNull();
    } finally {
      if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor);
      else delete (globalThis as { localStorage?: unknown }).localStorage;
    }
  });
});

describe('buildConfigUrl', () => {
  it('defaults to the hosted API with no query string', () => {
    expect(buildConfigUrl({ apiKey: 'gpl_pk_abc' })).toBe(
      `${DEFAULT_API_BASE}/v1/banner/config/gpl_pk_abc`,
    );
    expect(buildConfigUrl({ apiBase: '', apiKey: 'gpl_pk_abc' })).toBe(
      'https://api.gopaylocal.com/v1/banner/config/gpl_pk_abc',
    );
  });

  it('adds product and vid only when set', () => {
    expect(buildConfigUrl({ apiKey: 'k', productId: 'prod_1' })).toBe(
      'https://api.gopaylocal.com/v1/banner/config/k?product=prod_1',
    );
    expect(buildConfigUrl({ apiKey: 'k', visitorId: 'v'.repeat(16) })).toBe(
      `https://api.gopaylocal.com/v1/banner/config/k?vid=${'v'.repeat(16)}`,
    );
    expect(buildConfigUrl({ apiKey: 'k', productId: 'p', visitorId: 'v'.repeat(16) })).toBe(
      `https://api.gopaylocal.com/v1/banner/config/k?product=p&vid=${'v'.repeat(16)}`,
    );
    expect(buildConfigUrl({ apiKey: 'k', productId: null, visitorId: '' })).toBe(
      'https://api.gopaylocal.com/v1/banner/config/k',
    );
  });

  it('encodes the key and the parameters', () => {
    const url = new URL(buildConfigUrl({ apiKey: 'a/b?c#d', productId: 'p&x=1 #' }));
    expect(url.pathname).toBe('/v1/banner/config/a%2Fb%3Fc%23d');
    expect([...url.searchParams]).toEqual([['product', 'p&x=1 #']]);
  });

  it('uses a self-hosted base and drops trailing slashes', () => {
    expect(buildConfigUrl({ apiBase: 'https://ppp.example.com//', apiKey: 'k' })).toBe(
      'https://ppp.example.com/v1/banner/config/k',
    );
  });
});

describe('readExperiment', () => {
  it('reads both fields', () => {
    expect(readExperiment({ show: true, experimentId: '01JD8Q0Z6N3V4C2X1B0A9S8D7F', variant: 'b' })).toEqual({
      experimentId: '01JD8Q0Z6N3V4C2X1B0A9S8D7F',
      variant: 'b',
    });
  });

  it('returns nulls when no experiment applied or the fields are malformed', () => {
    const none = { experimentId: null, variant: null };
    expect(readExperiment({ show: true })).toEqual(none);
    expect(readExperiment({ experimentId: '01JD8Q0Z6N3V4C2X1B0A9S8D7F' })).toEqual(none);
    expect(readExperiment({ experimentId: '01JD8Q0Z6N3V4C2X1B0A9S8D7F', variant: 'c' })).toEqual(none);
    expect(readExperiment({ experimentId: '', variant: 'a' })).toEqual(none);
    expect(readExperiment({ experimentId: 7, variant: 'a' })).toEqual(none);
    expect(readExperiment(null)).toEqual(none);
    expect(readExperiment(undefined)).toEqual(none);
  });
});

describe('cssColor', () => {
  it('keeps ordinary colors', () => {
    expect(cssColor('#1a1a2e')).toBe('#1a1a2e');
    expect(cssColor('rgba(0, 0, 0, 0.5)')).toBe('rgba(0, 0, 0, 0.5)');
    expect(cssColor('hsl(10, 50%, 40%)')).toBe('hsl(10, 50%, 40%)');
    expect(cssColor('rebeccapurple')).toBe('rebeccapurple');
  });

  it('cannot end the declaration or load a URL', () => {
    expect(cssColor('red;}.x{display:none')).toBe('red.xdisplaynone');
    expect(cssColor('url(//evil.example/x.png)')).toBe('url(evil.examplex.png)');
    expect(cssColor('red"</style>')).toBe('redstyle');
    expect(cssColor(undefined)).toBe('');
  });
});

describe('adoptStyles', () => {
  afterEach(() => vi.unstubAllGlobals());

  /** A shadow root stand-in that records how styles were added. */
  function fakeRoot(withAdopted = true) {
    const appended: { textContent: string }[] = [];
    const root = {
      appended,
      ownerDocument: { createElement: () => ({ textContent: '' }) },
      appendChild: (el: { textContent: string }) => void appended.push(el),
    } as unknown as ShadowRoot & { appended: typeof appended };
    if (withAdopted) (root as { adoptedStyleSheets: unknown[] }).adoptedStyleSheets = [];
    return root;
  }

  class FakeSheet {
    css = '';
    replaceSync(css: string) {
      this.css = css;
    }
  }

  // A <style> element is blocked by a CSP style-src without 'unsafe-inline';
  // a constructed stylesheet is not.
  it('uses a constructed stylesheet, not a <style> element, when the browser has one', () => {
    vi.stubGlobal('CSSStyleSheet', FakeSheet);
    const root = fakeRoot();
    adoptStyles(root, '.B{color:red}');
    expect(root.appended).toHaveLength(0);
    expect(root.adoptedStyleSheets).toHaveLength(1);
    expect((root.adoptedStyleSheets[0] as unknown as FakeSheet).css).toBe('.B{color:red}');
  });

  it('falls back to a <style> element without constructable stylesheets', () => {
    vi.stubGlobal('CSSStyleSheet', undefined);
    const root = fakeRoot();
    adoptStyles(root, '.B{color:red}');
    expect(root.appended.map((el) => el.textContent)).toEqual(['.B{color:red}']);

    vi.stubGlobal('CSSStyleSheet', FakeSheet);
    const old = fakeRoot(false); // constructor exists, adoptedStyleSheets does not
    adoptStyles(old, '.B{color:blue}');
    expect(old.appended.map((el) => el.textContent)).toEqual(['.B{color:blue}']);
  });
});

describe('sendEvent', () => {
  const base = {
    apiBase: 'https://ppp.example.com/',
    apiKey: 'gpl_pk_abc',
    campaignId: 'camp_b',
    country: 'IN',
  };

  it('sends nothing without a campaign', () => {
    const beacon = vi.fn(() => true);
    const fetchMock = vi.fn();
    vi.stubGlobal('navigator', { sendBeacon: beacon });
    vi.stubGlobal('fetch', fetchMock);
    sendEvent({ ...base, campaignId: null, event: 'impression' });
    expect(beacon).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('uses sendBeacon with a JSON string body', () => {
    const beacon = vi.fn((_url: string, _body: string) => true);
    const fetchMock = vi.fn();
    vi.stubGlobal('navigator', { sendBeacon: beacon });
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('location', { href: 'https://shop.example/pricing' });
    sendEvent({ ...base, event: 'copy', code: 'PPP40' });
    expect(fetchMock).not.toHaveBeenCalled();
    const [url, body] = beacon.mock.calls[0]!;
    expect(url).toBe('https://ppp.example.com/v1/events');
    expect(typeof body).toBe('string');
    expect(JSON.parse(body)).toEqual({
      key: 'gpl_pk_abc',
      event: 'copy',
      url: 'https://shop.example/pricing',
      campaignId: 'camp_b',
      countryCode: 'IN',
      code: 'PPP40',
    });
  });

  it('falls back to a no-cors keepalive fetch when sendBeacon refuses or is missing', () => {
    const fetchMock = vi.fn((_url: string, _init: RequestInit) => Promise.resolve(new Response()));
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('navigator', { sendBeacon: () => false });
    sendEvent({ ...base, event: 'impression' });
    vi.stubGlobal('navigator', {});
    sendEvent({ ...base, event: 'dismiss' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://ppp.example.com/v1/events');
    expect(init).toMatchObject({ method: 'POST', mode: 'no-cors', keepalive: true });
    expect(JSON.parse(init.body as string)).not.toHaveProperty('code');
  });

  it('never throws', () => {
    vi.stubGlobal('navigator', undefined);
    vi.stubGlobal('fetch', () => {
      throw new Error('no network');
    });
    expect(() => sendEvent({ ...base, event: 'impression' })).not.toThrow();
  });
});

describe('formatMoney', () => {
  it('drops decimals on whole numbers and keeps the currency digits otherwise', () => {
    expect(formatMoney(1599, 'INR', 'en-US')).toBe('₹1,599');
    expect(formatMoney(19, 'USD', 'en-US')).toBe('$19');
    expect(formatMoney(7.6, 'USD', 'en-US')).toBe('$7.60');
    expect(formatMoney(13.99, 'EUR', 'de-DE')).toBe('13,99\u00a0€');
    expect(formatMoney(1299, 'JPY', 'en-US')).toBe('¥1,299');
    // Three-decimal currency: a charm N.990 keeps its three digits.
    expect(formatMoney(5.99, 'KWD', 'en-US')).toBe('KWD\u00a05.990');
  });

  it('shows every decimal it is given where Intl defaults to none (fx-review F5)', () => {
    // ICU's default for PKR, IDR, IQD, COP, HUF and ten others is 0 fraction
    // digits, which turned the API's "PKR 1838.14" into "PKR 1,838".
    expect(formatMoney(1838.14, 'PKR', 'en-US')).toBe('PKR 1,838.14');
    expect(formatMoney(156156.99, 'IDR', 'en-US')).toBe('IDR 156,156.99');
    expect(formatMoney(4118.247, 'IQD', 'en-US')).toBe('IQD 4,118.247');
    expect(formatMoney(1838.1, 'pkr', 'en-US')).toBe('PKR 1,838.10');
    expect(formatMoney(1838, 'PKR', 'en-US')).toBe('PKR 1,838');
  });

  it("knows the same three-decimal currencies as the shared table, and gives every other 2", () => {
    for (const code of THREE_DECIMAL_CURRENCIES) {
      expect(formatMoney(1.5, code, 'en-US')).toMatch(/1\.500$/);
    }
    for (const code of ['USD', 'EUR', 'INR', 'PKR', 'IDR', 'COP', 'HUF', 'NGN', 'BRL']) {
      expect(formatMoney(1.5, code, 'en-US')).toMatch(/1\.50$/);
    }
  });

  it("passes both digit options, never Intl's per-currency or per-browser defaults", () => {
    const spy = vi.spyOn(Intl, 'NumberFormat');
    for (const [v, c] of [[1838.14, 'PKR'], [19, 'USD'], [7.6, 'USD'], [5.99, 'KWD'], [1299, 'JPY']] as const) {
      formatMoney(v, c, 'en-US');
    }
    expect(spy).toHaveBeenCalledTimes(5);
    for (const [, options] of spy.mock.calls) {
      expect(options).toMatchObject({
        minimumFractionDigits: expect.any(Number),
        maximumFractionDigits: expect.any(Number),
      });
    }
  });

  it('falls back to the code and the number for an unknown currency', () => {
    expect(formatMoney(5, 'NOT-A-CODE', 'en-US')).toBe('NOT-A-CODE 5');
    expect(formatMoney(5, '', 'en-US')).toBe('5');
  });
});

describe('flagOf', () => {
  it('turns a two-letter country code into a flag and anything else into ""', () => {
    expect(flagOf('in')).toBe('🇮🇳');
    expect(flagOf('US')).toBe('🇺🇸');
    expect(flagOf('')).toBe('');
    expect(flagOf(null)).toBe('');
    expect(flagOf('USA')).toBe('');
    expect(flagOf('1A')).toBe('');
  });
});

describe('templateValues', () => {
  const data = {
    country: 'IN',
    countryName: 'India',
    discount: 60,
    code: 'PPP60',
    currencyCode: 'INR',
    currencySymbol: '₹',
    localPrice: 719,
    localOriginalPrice: 1769,
  };

  it('has exactly the documented placeholders', () => {
    expect(Object.keys(templateValues(data)).sort()).toEqual([...PLACEHOLDERS].sort());
  });

  it('fills each from the response, prices in the visitor currency', () => {
    expect(templateValues(data)).toEqual({
      countryName: 'India',
      country: 'IN',
      flag: '🇮🇳',
      discount: '60',
      code: 'PPP60',
      localPrice: formatMoney(719, 'INR'),
      localOriginalPrice: formatMoney(1769, 'INR'),
      currencySymbol: '₹',
      currencyCode: 'INR',
    });
  });

  it('leaves missing values empty instead of printing undefined', () => {
    const v = templateValues({ country: '', countryName: '', discount: 0, code: null });
    expect(v).toMatchObject({ code: '', localPrice: '', localOriginalPrice: '', currencyCode: '', flag: '', discount: '0' });
    expect(templateValues({ ...data, localPrice: Number.NaN }).localPrice).toBe('');
  });
});

describe('fillTemplate', () => {
  const values = { discount: '40', code: 'PPP40', empty: '' };

  it('replaces known placeholders and drops unknown, inherited and empty ones', () => {
    expect(fillTemplate('{{discount}}% off with {{code}}{{nope}}{{constructor}}{{toString}}{{empty}}', values)).toBe(
      '40% off with PPP40',
    );
  });

  it('passes each non-empty value and its name through `each`', () => {
    const seen: string[] = [];
    const out = fillTemplate('{{discount}}|{{empty}}|{{code}}', values, (text, name) => {
      seen.push(name);
      return `<${text}>`;
    });
    expect(out).toBe('<40>||<PPP40>');
    expect(seen).toEqual(['discount', 'code']);
  });

  it('leaves text that is not a placeholder alone', () => {
    expect(fillTemplate('{ {discount} } {{ discount }} {{dis-count}}', values)).toBe('{ {discount} } {{ discount }} {{dis-count}}');
  });
});
