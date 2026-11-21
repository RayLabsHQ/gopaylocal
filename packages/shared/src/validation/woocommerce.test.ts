import { describe, it, expect } from 'vitest';
import { normalizeWooCommerceStoreUrl, parseWooCommerceCredentials } from './woocommerce';

const ok = (raw: string) => {
  const r = normalizeWooCommerceStoreUrl(raw);
  if (!r.ok) throw new Error(`expected ${raw} to be accepted, got: ${r.message}`);
  return r.value;
};
const rejected = (raw: string | null | undefined) => {
  const r = normalizeWooCommerceStoreUrl(raw);
  return r.ok ? null : r.message;
};

describe('normalizeWooCommerceStoreUrl: accepted shapes', () => {
  it('normalizes to https://<host> with no trailing slash', () => {
    expect(ok('https://shop.example.com')).toBe('https://shop.example.com');
    expect(ok('https://shop.example.com/')).toBe('https://shop.example.com');
    expect(ok('  https://Shop.Example.COM/  ')).toBe('https://shop.example.com');
  });

  it('adds https:// to a bare host name', () => {
    expect(ok('shop.example.com')).toBe('https://shop.example.com');
    expect(ok('shop.example.com/')).toBe('https://shop.example.com');
  });

  it('keeps the WordPress install path (subdirectory installs)', () => {
    expect(ok('https://example.com/store/')).toBe('https://example.com/store');
    expect(ok('https://example.com/en/shop')).toBe('https://example.com/en/shop');
  });

  it('cuts a pasted REST or admin path back to the install directory', () => {
    expect(ok('https://shop.example.com/wp-json/wc/v3')).toBe('https://shop.example.com');
    expect(ok('https://example.com/store/wp-json/wc/v3/coupons')).toBe('https://example.com/store');
    expect(ok('https://shop.example.com/wp-admin/admin.php')).toBe('https://shop.example.com');
  });

  it('accepts the explicit default port (the parser drops it) and a trailing dot', () => {
    expect(ok('https://shop.example.com:443/')).toBe('https://shop.example.com');
    expect(ok('https://shop.example.com./')).toBe('https://shop.example.com');
  });

  it('accepts internationalized domains in their punycode form', () => {
    expect(ok('https://bücher.example.de')).toBe('https://xn--bcher-kva.example.de');
  });
});

describe('normalizeWooCommerceStoreUrl: rejected shapes', () => {
  it('requires a value', () => {
    expect(rejected('')).toMatch(/required/);
    expect(rejected('   ')).toMatch(/required/);
    expect(rejected(null)).toMatch(/required/);
    expect(rejected(undefined)).toMatch(/required/);
  });

  it('rejects plain http with an explanation', () => {
    expect(rejected('http://shop.example.com')).toMatch(/https/);
    expect(rejected('HTTP://shop.example.com')).toMatch(/https/);
  });

  it('rejects other schemes', () => {
    expect(rejected('ftp://shop.example.com')).not.toBeNull();
    expect(rejected('file:///etc/passwd')).not.toBeNull();
    expect(rejected('javascript:alert(1)')).not.toBeNull();
    expect(rejected('ws://shop.example.com')).not.toBeNull();
  });

  it('rejects IPv4 literals in every spelling the URL parser accepts', () => {
    for (const raw of [
      'https://127.0.0.1',
      'https://10.0.0.5/',
      'https://169.254.169.254/latest/meta-data',
      'https://192.168.1.1',
      'https://8.8.8.8', // public, but still not a store's name
      'https://2130706433', // decimal 127.0.0.1
      'https://0x7f.0.0.1', // hex
      'https://0177.0.0.1', // octal
      'https://127.1', // shorthand
    ]) {
      expect(rejected(raw), raw).toMatch(/IP address/);
    }
  });

  it('rejects IPv6 literals', () => {
    for (const raw of ['https://[::1]/', 'https://[fd00::1]', 'https://[::ffff:127.0.0.1]']) {
      expect(rejected(raw), raw).toMatch(/IP address/);
    }
  });

  it('rejects names that embed an IPv4 address (wildcard DNS services)', () => {
    expect(rejected('https://127.0.0.1.nip.io')).toMatch(/IP address/);
    expect(rejected('https://10-0-0-1.sslip.io')).toMatch(/IP address/);
    expect(rejected('https://shop.192.168.0.1.example.com')).toMatch(/IP address/);
  });

  it('rejects localhost, single-label and internal names', () => {
    for (const raw of [
      'https://localhost',
      'https://shop.localhost',
      'https://intranet', // single label
      'https://shop', // single label
      'https://shop.local',
      'https://metadata.google.internal',
      'https://wp.lan',
      'https://store.corp',
      'https://store.home',
      'https://router.home.arpa',
      'https://1.0.0.127.in-addr.arpa',
      'https://shop.test',
      'https://shop.example',
      'https://shop.invalid',
      'https://shop.localdomain',
      'https://abcdefghijklmnop.onion',
    ]) {
      expect(rejected(raw), raw).not.toBeNull();
    }
  });

  it("rejects GoPayLocal's own zone (a same-zone fetch would bypass Cloudflare and hit the origin)", () => {
    expect(rejected('https://gopaylocal.com')).toMatch(/public/);
    expect(rejected('https://api.gopaylocal.com')).toMatch(/public/);
    expect(rejected('https://API.GoPayLocal.com./v1')).toMatch(/public/);
    // a different registrable domain that merely contains the name is fine
    expect(ok('https://gopaylocal.com.example.org')).toBe('https://gopaylocal.com.example.org');
  });

  it('rejects credentials in the URL', () => {
    expect(rejected('https://user:pass@shop.example.com')).toMatch(/user name or password/);
    expect(rejected('https://user@shop.example.com')).toMatch(/user name or password/);
    expect(rejected('https://@shop.example.com')).toMatch(/user name or password/);
    expect(rejected('shop.example.com@evil.example.org')).toMatch(/user name or password/);
  });

  it('rejects non-default ports', () => {
    expect(rejected('https://shop.example.com:8443')).toMatch(/port/);
    expect(rejected('shop.example.com:8080')).toMatch(/port/);
    expect(rejected('https://shop.example.com:80')).toMatch(/port/);
  });

  it('rejects a query or fragment', () => {
    expect(rejected('https://shop.example.com/?a=1')).toMatch(/query/);
    expect(rejected('https://shop.example.com?')).toMatch(/query/);
    expect(rejected('https://shop.example.com/#x')).toMatch(/query/);
  });

  it('rejects encoded, dot and odd path segments', () => {
    expect(rejected('https://shop.example.com/%2e%2e/admin')).not.toBeNull();
    expect(rejected('https://shop.example.com/a%2Fb')).not.toBeNull();
    expect(rejected('https://shop.example.com/store/../admin')).not.toBeNull();
    expect(rejected('https://shop.example.com/./store')).not.toBeNull();
    expect(rejected('https://shop.example.com/sh(o)p')).not.toBeNull();
    expect(rejected(`https://shop.example.com/${'a/'.repeat(120)}`)).not.toBeNull();
  });

  it('rejects backslashes, whitespace and control characters', () => {
    expect(rejected('https://shop.example.com\\@evil.example.org')).not.toBeNull();
    expect(rejected('https://shop.example.com/a b')).not.toBeNull();
    expect(rejected('https://shop.exa\tmple.com')).not.toBeNull();
    expect(rejected('https://shop.example.com/\u0000')).not.toBeNull();
  });

  it('rejects malformed host names', () => {
    expect(rejected('https://-shop.example.com')).not.toBeNull();
    expect(rejected('https://shop_example.com')).not.toBeNull();
    expect(rejected('https://shop..example.com')).not.toBeNull();
    expect(rejected('https://shop.example.c0m')).not.toBeNull();
    expect(rejected(`https://${'a'.repeat(64)}.example.com`)).not.toBeNull();
    expect(rejected(`https://${'a'.repeat(600)}.com`)).not.toBeNull();
  });
});

describe('parseWooCommerceCredentials', () => {
  const ck = `ck_${'a1'.repeat(20)}`; // ck_ + 40 hex, as WooCommerce generates
  const cs = `cs_${'b2'.repeat(20)}`;

  it('splits "<consumer key>:<consumer secret>"', () => {
    expect(parseWooCommerceCredentials(`${ck}:${cs}`)).toEqual({ consumerKey: ck, consumerSecret: cs });
    expect(parseWooCommerceCredentials(` ${ck} : ${cs} `)).toEqual({ consumerKey: ck, consumerSecret: cs });
  });

  it('rejects anything that is not a key pair', () => {
    expect(parseWooCommerceCredentials(null)).toBeNull();
    expect(parseWooCommerceCredentials('')).toBeNull();
    expect(parseWooCommerceCredentials(ck)).toBeNull(); // secret missing
    expect(parseWooCommerceCredentials(`${cs}:${ck}`)).toBeNull(); // swapped
    expect(parseWooCommerceCredentials(`${ck}:`)).toBeNull();
    expect(parseWooCommerceCredentials(`${ck}:cs_short`)).toBeNull();
    expect(parseWooCommerceCredentials(`${ck}:${cs}\r\nX-Injected: 1`)).toBeNull();
    expect(parseWooCommerceCredentials(`${ck}:${cs}:extra`)).toBeNull();
    expect(parseWooCommerceCredentials(`${ck}:cs_${'é'.repeat(30)}`)).toBeNull(); // btoa would throw
  });
});
