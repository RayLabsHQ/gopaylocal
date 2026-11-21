import { describe, expect, it } from 'vitest';
import { readSetup, type ScriptTag } from './setup';

const PAGE = 'https://shop.example/pricing';

/** A stand-in for a <script> element: just its attributes. */
function tag(attrs: Record<string, string>): ScriptTag {
  return {
    getAttribute: (name) => (name in attrs ? attrs[name]! : null),
    hasAttribute: (name) => name in attrs,
  };
}

const LOADER_SRC = 'https://api.gopaylocal.com/v1/banner/script.js?key=gpl_pk_abc';
const BUNDLE_SRC = 'https://api.gopaylocal.com/v1/banner/bundle.js?key=gpl_pk_abc';

describe('readSetup', () => {
  it('reads the key and the hosted API base from the script src', () => {
    expect(readSetup(null, [tag({ src: LOADER_SRC })], PAGE)).toEqual({
      key: 'gpl_pk_abc',
      apiBase: 'https://api.gopaylocal.com',
      productId: null,
      visitorId: null,
      noStorage: false,
    });
  });

  it('derives a self-hosted API base from the script src', () => {
    const setup = readSetup(
      null,
      [tag({ src: 'https://ppp.example.org/v1/banner/script.js?key=gpl_pk_self' })],
      PAGE,
    );
    expect(setup?.apiBase).toBe('https://ppp.example.org');
    expect(setup?.key).toBe('gpl_pk_self');
  });

  it('keeps a path prefix in front of /v1/ and resolves relative srcs', () => {
    expect(
      readSetup(null, [tag({ src: 'https://example.org/ppp/v1/banner/script.js?key=k' })], PAGE)
        ?.apiBase,
    ).toBe('https://example.org/ppp');
    expect(readSetup(null, [tag({ src: '/v1/banner/script.js?key=k' })], PAGE)?.apiBase).toBe(
      'https://shop.example',
    );
  });

  it('reads data-* from the merchant tag while the injected bundle tag is running', () => {
    const merchant = tag({
      src: LOADER_SRC,
      'data-product': 'prod_1',
      'data-visitor-id': 'user_0000000000001',
      'data-no-storage': '',
    });
    const bundle = tag({ src: BUNDLE_SRC });
    // The loader appends the bundle to <head>, so it can come first in document order.
    expect(readSetup(bundle, [bundle, merchant], PAGE)).toEqual({
      key: 'gpl_pk_abc',
      apiBase: 'https://api.gopaylocal.com',
      productId: 'prod_1',
      visitorId: 'user_0000000000001',
      noStorage: true,
    });
  });

  it('prefers attributes on the running script', () => {
    const running = tag({ src: BUNDLE_SRC, 'data-product': 'prod_running' });
    const other = tag({ src: LOADER_SRC, 'data-product': 'prod_other' });
    expect(readSetup(running, [other, running], PAGE)?.productId).toBe('prod_running');
  });

  it('accepts a running script at any URL (self-hosted bundle file)', () => {
    const running = tag({ src: 'https://cdn.example/js/ppp.js?key=gpl_pk_cdn' });
    expect(readSetup(running, [running], PAGE)?.key).toBe('gpl_pk_cdn');
  });

  it('ignores unrelated scripts that merely say "banner" or carry a key', () => {
    const cookieBanner = tag({ src: 'https://cdn.cookies.example/banner.js?key=not_ours' });
    const ours = tag({ src: LOADER_SRC });
    expect(readSetup(null, [cookieBanner, ours], PAGE)?.key).toBe('gpl_pk_abc');
    expect(readSetup(null, [cookieBanner], PAGE)).toBeNull();
  });

  it('returns null without a key', () => {
    expect(readSetup(null, [tag({ src: 'https://api.gopaylocal.com/v1/banner/script.js' })], PAGE)).toBeNull();
    expect(readSetup(null, [], PAGE)).toBeNull();
  });

  it('decodes the key', () => {
    expect(
      readSetup(null, [tag({ src: 'https://api.gopaylocal.com/v1/banner/script.js?key=a%2Bb' })], PAGE)?.key,
    ).toBe('a+b');
  });

  it('trims data-product and treats an empty one as absent', () => {
    expect(readSetup(null, [tag({ src: LOADER_SRC, 'data-product': '  prod_2 ' })], PAGE)?.productId).toBe('prod_2');
    expect(readSetup(null, [tag({ src: LOADER_SRC, 'data-product': '   ' })], PAGE)?.productId).toBeNull();
  });

  it('reads data-no-storage as a boolean attribute, except the value "false"', () => {
    const read = (value: string) =>
      readSetup(null, [tag({ src: LOADER_SRC, 'data-no-storage': value })], PAGE)?.noStorage;
    expect(read('')).toBe(true);
    expect(read('true')).toBe(true);
    expect(read('no-storage')).toBe(true);
    expect(read('false')).toBe(false);
  });
});
