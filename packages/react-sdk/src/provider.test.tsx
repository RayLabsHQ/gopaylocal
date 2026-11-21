import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToString } from 'react-dom/server';
import {
  GoPayLocalProvider,
  cacheKey,
  fetchConfig,
  getCachedData,
  setCachedData,
  toPPPResponse,
} from './provider';
import { usePPP } from './hooks/use-ppp';
import { PPPPrice } from './components/price';
import type { PPPResponse } from './types';
import tsupConfig from '../tsup.config';

/** Experiment ids are ULIDs (services/experiment.service.ts). */
const EXP = '01JD8Q0Z6N3V4C2X1B0A9S8D7F';

const BANNER = {
  position: 'bottom-right' as const,
  messageTemplate: 'Use {{code}} for {{discount}}% off',
  ctaText: 'Copy',
  backgroundColor: '#000000',
  textColor: '#ffffff',
  ctaColor: '#ff0000',
  ctaTextColor: '#ffffff',
  showFlag: true,
  showCloseBtn: true,
};

const SHOW: PPPResponse = {
  show: true,
  country: 'IN',
  countryName: 'India',
  discount: 40,
  code: 'PPP40',
  banner: BANNER,
  currencySymbol: '$',
  campaignId: 'camp_b',
  experimentId: EXP,
  variant: 'b',
  showBranding: true,
};

function memoryStorage(): Storage & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
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

let fetchMock: ReturnType<typeof vi.fn>;
let local: ReturnType<typeof memoryStorage>;
let session: ReturnType<typeof memoryStorage>;

beforeEach(() => {
  fetchMock = vi.fn(async () => new Response(JSON.stringify(SHOW), { status: 200 }));
  local = memoryStorage();
  session = memoryStorage();
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('localStorage', local);
  vi.stubGlobal('sessionStorage', session);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete (globalThis as Record<string, unknown>).localStorage;
  delete (globalThis as Record<string, unknown>).sessionStorage;
});

describe('package build', () => {
  it('marks the built files as a client module ("use client")', () => {
    const config = Array.isArray(tsupConfig) ? tsupConfig[0] : tsupConfig;
    expect((config as { banner?: { js?: string } }).banner?.js).toMatch(/^['"]use client['"];?$/);
  });
});

describe('toPPPResponse', () => {
  it('keeps a discount response as is', () => {
    expect(toPPPResponse(SHOW)).toEqual(SHOW);
  });

  it('returns null for no-discount and malformed responses', () => {
    expect(toPPPResponse({ show: false, reason: 'vpn_detected' })).toBeNull();
    expect(toPPPResponse({ show: true, country: 'IN' })).toBeNull(); // no banner
    expect(toPPPResponse(null)).toBeNull();
    expect(toPPPResponse('nope')).toBeNull();
  });

  it('fills defaults for missing optional fields', () => {
    expect(toPPPResponse({ show: true, country: 'BR', banner: BANNER })).toMatchObject({
      countryName: 'BR',
      discount: 0,
      code: null,
    });
  });
});

describe('fetchConfig', () => {
  it('requests product and a persisted visitor id from the hosted API', async () => {
    const { data } = await fetchConfig({ apiKey: 'gpl_pk_abc', productId: 'prod_1', persistVisitorId: true });
    const url = new URL(fetchMock.mock.calls[0]![0] as string);
    expect(url.origin + url.pathname).toBe('https://api.gopaylocal.com/v1/banner/config/gpl_pk_abc');
    expect(url.searchParams.get('product')).toBe('prod_1');
    expect(url.searchParams.get('vid')).toBe(local.map.get('gpl_vid'));
    expect(data?.variant).toBe('b');
  });

  it('encodes the API key in the path', async () => {
    await fetchConfig({ apiKey: 'a/b?c', persistVisitorId: false });
    expect(fetchMock.mock.calls[0]![0]).toBe('https://api.gopaylocal.com/v1/banner/config/a%2Fb%3Fc');
  });

  it('uses a self-hosted apiBase, a visitor override, and no storage when not persisting', async () => {
    await fetchConfig({
      apiBase: 'https://ppp.example.com/',
      apiKey: 'k',
      visitorId: 'user_0000000000042',
      persistVisitorId: false,
    });
    expect(fetchMock.mock.calls[0]![0]).toBe(
      'https://ppp.example.com/v1/banner/config/k?vid=user_0000000000042',
    );
    expect(local.map.size).toBe(0);
  });

  it('sends no vid with persistVisitorId false and no override', async () => {
    await fetchConfig({ apiKey: 'k', persistVisitorId: false });
    expect(fetchMock.mock.calls[0]![0]).toBe('https://api.gopaylocal.com/v1/banner/config/k');
  });

  it('throws on a non-2xx status and returns null without a discount', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 401 }));
    await expect(fetchConfig({ apiKey: 'k', persistVisitorId: true })).rejects.toThrow(
      'GoPayLocal API returned 401',
    );
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ show: false })));
    expect(await fetchConfig({ apiKey: 'k', persistVisitorId: true })).toEqual({
      data: null,
      experiment: { experimentId: null, variant: null },
    });
  });

  it('keeps the experiment arm when the assigned arm has no discount', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ show: false, reason: 'no_discount', experimentId: EXP, variant: 'a' })),
    );
    expect(await fetchConfig({ apiKey: 'k', persistVisitorId: true })).toEqual({
      data: null,
      experiment: { experimentId: EXP, variant: 'a' },
    });
  });
});

describe('session cache', () => {
  it('keys entries by API key and product', () => {
    expect(cacheKey('k')).toBe('gpl_react_k_');
    expect(cacheKey('k', 'p1')).toBe('gpl_react_k_p1');
  });

  it('round-trips a response and expires it after 5 minutes', () => {
    setCachedData(cacheKey('k'), SHOW);
    expect(getCachedData(cacheKey('k'))).toEqual(SHOW);
    const entry = JSON.parse(session.map.get('gpl_react_k_')!);
    entry.timestamp -= 5 * 60 * 1000 + 1;
    session.map.set('gpl_react_k_', JSON.stringify(entry));
    expect(getCachedData(cacheKey('k'))).toBeNull();
    expect(session.map.has('gpl_react_k_')).toBe(false);
  });

  it('works without sessionStorage', () => {
    Object.defineProperty(globalThis, 'sessionStorage', {
      configurable: true,
      get() {
        throw new DOMException('blocked', 'SecurityError');
      },
    });
    expect(() => setCachedData('x', SHOW)).not.toThrow();
    expect(getCachedData('x')).toBeNull();
  });
});

describe('server rendering', () => {
  function Probe() {
    const { isLoading, discount, experimentId, variant } = usePPP();
    return (
      <p>
        {`loading=${isLoading} discount=${discount} exp=${experimentId} variant=${variant} `}
        <PPPPrice price={29} />
      </p>
    );
  }

  it('renders base prices, makes no request and reads no storage', () => {
    // A cached discount must not leak into the server/hydration render, or
    // the client's first render would not match the server HTML.
    setCachedData(cacheKey('k'), SHOW);
    const sessionGet = vi.spyOn(session, 'getItem');
    const html = renderToString(
      <GoPayLocalProvider apiKey="k" baseCurrencyCode="USD">
        <Probe />
      </GoPayLocalProvider>,
    );
    expect(html).toContain('loading=true discount=0 exp=null variant=null');
    // A whole amount shows no decimals, as in the banner.
    expect(html).toContain('$29<');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(sessionGet).not.toHaveBeenCalled();
    expect(local.map.size).toBe(0);
  });
});
