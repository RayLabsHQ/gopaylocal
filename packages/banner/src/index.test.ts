/**
 * Runs the banner entry point (an IIFE) against stubbed browser globals to
 * check what it requests, stores and announces. Rendering needs a real DOM
 * and is not covered here (the fake document has no createElement, so the
 * render step fails inside its own try/catch, as it would on any error).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface FakeTag {
  getAttribute(name: string): string | null;
  hasAttribute(name: string): boolean;
}

function tag(attrs: Record<string, string>): FakeTag {
  return {
    getAttribute: (name) => (name in attrs ? attrs[name]! : null),
    hasAttribute: (name) => name in attrs,
  };
}

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

function blockStorage(name: 'localStorage' | 'sessionStorage') {
  Object.defineProperty(globalThis, name, {
    configurable: true,
    get() {
      throw new DOMException('The operation is insecure.', 'SecurityError');
    },
  });
}

const SRC = 'https://api.gopaylocal.com/v1/banner/script.js?key=gpl_pk_abc';
const SHOW = {
  show: true,
  country: 'IN',
  countryName: 'India',
  discount: 40,
  code: 'PPP40',
  campaignId: 'camp_b',
  experimentId: '01JD8Q0Z6N3V4C2X1B0A9S8D7F',
  variant: 'b',
  showBranding: false,
  banner: {
    position: 'bottom',
    messageTemplate: '{{discount}}% off',
    ctaText: 'Copy',
    backgroundColor: '#000',
    textColor: '#fff',
    ctaColor: '#f00',
    ctaTextColor: '#fff',
    showFlag: true,
    showCloseBtn: true,
  },
};

let fetchMock: ReturnType<typeof vi.fn>;
let local: ReturnType<typeof memoryStorage>;
let session: ReturnType<typeof memoryStorage>;
let events: CustomEvent[];

function setPage(scripts: FakeTag[], current: FakeTag | null = null) {
  vi.stubGlobal('document', {
    currentScript: current,
    querySelectorAll: () => scripts,
    dispatchEvent: (e: CustomEvent) => {
      events.push(e);
      return true;
    },
  });
}

/** Run the IIFE once and let its fetch chain settle. */
async function runBanner() {
  vi.resetModules();
  await import('./index');
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}

function requestedUrl(): URL {
  return new URL(fetchMock.mock.calls[0]![0] as string);
}

beforeEach(() => {
  events = [];
  local = memoryStorage();
  session = memoryStorage();
  fetchMock = vi.fn(async () => new Response(JSON.stringify(SHOW), { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('localStorage', local);
  vi.stubGlobal('sessionStorage', session);
  vi.stubGlobal('location', { href: 'https://shop.example/pricing' });
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete (globalThis as Record<string, unknown>).localStorage;
  delete (globalThis as Record<string, unknown>).sessionStorage;
});

describe('banner request', () => {
  it('sends product and a persisted visitor id', async () => {
    setPage([tag({ src: SRC, 'data-product': 'prod_1' })]);
    await runBanner();
    const url = requestedUrl();
    expect(url.origin + url.pathname).toBe('https://api.gopaylocal.com/v1/banner/config/gpl_pk_abc');
    expect(url.searchParams.get('product')).toBe('prod_1');
    const vid = url.searchParams.get('vid');
    expect(vid).toMatch(/^[0-9a-f]{32}$/);
    expect(local.map.get('gpl_vid')).toBe(vid);
  });

  it('reuses the visitor id another GoPayLocal client stored', async () => {
    local.map.set('gpl_vid', 'shared_id_123456789');
    setPage([tag({ src: SRC })]);
    await runBanner();
    expect(requestedUrl().searchParams.get('vid')).toBe('shared_id_123456789');
  });

  it('sends a valid data-visitor-id and drops an invalid one', async () => {
    setPage([tag({ src: SRC, 'data-visitor-id': 'user_0000000000042' })]);
    await runBanner();
    expect(requestedUrl().searchParams.get('vid')).toBe('user_0000000000042');
    expect(local.map.has('gpl_vid')).toBe(false);

    fetchMock.mockClear();
    session.map.clear(); // drop the cached response
    setPage([tag({ src: SRC, 'data-visitor-id': 'a@b.c' })]);
    await runBanner();
    expect(requestedUrl().searchParams.get('vid')).toMatch(/^[0-9a-f]{32}$/);
  });

  it('with data-no-storage: no vid, and nothing read from or written to storage', async () => {
    const localGet = vi.spyOn(local, 'getItem');
    const sessionGet = vi.spyOn(session, 'getItem');
    setPage([tag({ src: SRC, 'data-no-storage': '' })]);
    await runBanner();
    expect(requestedUrl().searchParams.has('vid')).toBe(false);
    expect(localGet).not.toHaveBeenCalled();
    expect(sessionGet).not.toHaveBeenCalled();
    expect(local.map.size).toBe(0);
    expect(session.map.size).toBe(0);
    expect(events).toHaveLength(1);
  });

  it('still requests and announces the config when all storage is blocked', async () => {
    blockStorage('localStorage');
    blockStorage('sessionStorage');
    setPage([tag({ src: SRC })]);
    await runBanner();
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(requestedUrl().searchParams.has('vid')).toBe(false);
    expect(events).toHaveLength(1);
  });

  it('does nothing without a key', async () => {
    setPage([tag({ src: 'https://api.gopaylocal.com/v1/banner/script.js' })]);
    await runBanner();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // script.js is a static file, so the server cannot refuse the key: the
  // banner does, before it sends the key anywhere.
  it('refuses a secret key: says so in the console and sends nothing', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    setPage([tag({ src: 'https://api.gopaylocal.com/v1/banner/script.js?key=gpl_sk_live_0123456789' })]);
    await runBanner();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(events).toHaveLength(0);
    expect(session.map.size).toBe(0);
    expect(error).toHaveBeenCalledOnce();
    const message = String(error.mock.calls[0]![0]);
    expect(message).toContain('This key is now exposed');
    expect(message).not.toContain('gpl_sk_live_0123456789');
    error.mockRestore();
  });

  it('runs as the script tag itself (script.js is the banner, not a loader)', async () => {
    const own = tag({ src: SRC, 'data-product': 'prod_9' });
    setPage([own], own);
    await runBanner();
    expect(requestedUrl().pathname).toBe('/v1/banner/config/gpl_pk_abc');
    expect(requestedUrl().searchParams.get('product')).toBe('prod_9');
  });
});

describe('banner cache and dismissal', () => {
  it('caches the response per key and product', async () => {
    setPage([tag({ src: SRC, 'data-product': 'prod_1' })]);
    await runBanner();
    expect(session.map.has('gpl_c_gpl_pk_abc_prod_1')).toBe(true);

    fetchMock.mockClear();
    await runBanner();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(events).toHaveLength(2); // announced again from the cache

    setPage([tag({ src: SRC, 'data-product': 'prod_2' })]);
    await runBanner();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('stays hidden after a dismissal for that key and product', async () => {
    session.map.set('gpl_d_gpl_pk_abc_', '1');
    setPage([tag({ src: SRC })]);
    await runBanner();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('gopaylocal:config event', () => {
  it('announces the experiment arm on document', async () => {
    setPage([tag({ src: SRC })]);
    await runBanner();
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('gopaylocal:config');
    expect(events[0]!.detail).toEqual({
      show: true,
      country: 'IN',
      discount: 40,
      code: 'PPP40',
      campaignId: 'camp_b',
      experimentId: '01JD8Q0Z6N3V4C2X1B0A9S8D7F',
      variant: 'b',
    });
  });

  it('announces responses without a discount too', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ show: false, reason: 'no_discount' })));
    setPage([tag({ src: SRC })]);
    await runBanner();
    expect(events[0]!.detail).toEqual({
      show: false,
      country: null,
      discount: 0,
      code: null,
      campaignId: null,
      experimentId: null,
      variant: null,
    });
  });

  it('announces the arm when the assigned arm has no discount', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({ show: false, reason: 'no_discount', experimentId: '01JD8Q0Z6N3V4C2X1B0A9S8D7F', variant: 'a' }),
      ),
    );
    setPage([tag({ src: SRC })]);
    await runBanner();
    expect(events[0]!.detail).toMatchObject({
      show: false,
      experimentId: '01JD8Q0Z6N3V4C2X1B0A9S8D7F',
      variant: 'a',
    });
  });
});
