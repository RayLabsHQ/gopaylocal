// ── WooCommerce store URL + credentials ─────────────────────────────────────
// WooCommerce has no central API host: each merchant's REST API lives on their
// own store (https://<store>/wp-json/wc/v3). The GoPayLocal API therefore sends
// requests carrying the merchant's consumer key and secret to a URL the
// merchant typed in. Everything that decides where those requests may go is in
// this file, so the connect route (via normalizeProviderAccountId) and the API
// adapter (services/providers/woocommerce.ts, defence in depth) apply the same
// rule. Pure functions, no I/O.
//
// What is accepted: an https URL with a public DNS hostname, the default port,
// and optionally the path WordPress is installed under. It is normalized to
// "https://<host>[/<path>]" with no trailing slash, query or fragment.
//
// What is rejected, and why:
//  - anything but https: WooCommerce only accepts HTTP Basic credentials over
//    HTTPS (class-wc-rest-authentication.php authenticate(): `if ( is_ssl() )`),
//    and the docs require OAuth 1.0a over plain HTTP, which we don't implement;
//  - IP literals (the WHATWG URL parser canonicalizes every IPv4 spelling, such
//    as 2130706433 or 0x7f.1, to dotted decimal, which is then refused) and
//    names that embed one (127.0.0.1.nip.io);
//  - local or internal names (localhost, *.local, *.internal, single labels...);
//  - GoPayLocal's own zone: without the `global_fetch_strictly_public`
//    compatibility flag a Worker's fetch to its own zone "is routed to the
//    zone's origin server ... bypassing Cloudflare security settings"
//    (https://developers.cloudflare.com/workers/configuration/compatibility-flags/#global-fetch-strictly-public);
//  - credentials in the URL, a non-default port, a query or fragment, encoded
//    or dot path segments, backslashes, whitespace and control characters.
//
// A public name whose DNS points at a private address cannot be detected
// without resolving it; see the provider report for what Cloudflare does and
// does not document there.

export type WooCommerceStoreUrlResult =
  | { ok: true; value: string }
  | { ok: false; message: string };

const MAX_INPUT_LENGTH = 512;
const MAX_PATH_LENGTH = 200;

/** Hostname suffixes that never name a public store. */
const BLOCKED_SUFFIXES = [
  'localhost',
  'localdomain',
  'local',
  'internal',
  'intranet',
  'lan',
  'home',
  'corp',
  'private',
  'test',
  'invalid',
  'example',
  'onion',
  'arpa',
  // GoPayLocal's own zone (see the header).
  'gopaylocal.com',
] as const;

// RFC 1035 labels, at least two of them; the last one is alphabetic or an IDN
// (xn--) label. new URL() has already lowercased and punycoded the host.
const HOSTNAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;
const DOTTED_QUAD = /^\d{1,3}(?:\.\d{1,3}){3}$/;
const EMBEDDED_DOTTED_QUAD = /(?:^|\.)\d{1,3}(?:\.\d{1,3}){3}(?:\.|$)/;
const EMBEDDED_DASHED_QUAD = /(?:^|[.-])\d{1,3}(?:-\d{1,3}){3}(?:[.-]|$)/;
const PATH_SEGMENT = /^[A-Za-z0-9._~-]+$/;
// eslint-disable-next-line no-control-regex
const WHITESPACE_OR_CONTROL = /[\s\u0000-\u001f\u007f]/;

const INVALID = 'Enter your store address, for example https://shop.example.com';

function fail(message: string): WooCommerceStoreUrlResult {
  return { ok: false, message };
}

function hasBlockedSuffix(host: string): boolean {
  return BLOCKED_SUFFIXES.some((s) => host === s || host.endsWith(`.${s}`));
}

/**
 * Validate and normalize a WooCommerce store URL. Accepts what merchants paste
 * ("shop.example.com", "https://shop.example.com/", ".../wp-json/wc/v3",
 * ".../wp-admin/") and returns "https://shop.example.com" (or with the
 * WordPress install path, "https://example.com/store").
 */
export function normalizeWooCommerceStoreUrl(raw: string | null | undefined): WooCommerceStoreUrlResult {
  const input = typeof raw === 'string' ? raw.trim() : '';
  if (!input) return fail('Store URL is required for WooCommerce');
  if (input.length > MAX_INPUT_LENGTH) return fail(INVALID);
  if (WHITESPACE_OR_CONTROL.test(input) || input.includes('\\')) return fail(INVALID);

  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(input)?.[1]?.toLowerCase();
  if (scheme === 'http') {
    return fail('Use the https:// address of your store. WooCommerce only accepts API keys over HTTPS.');
  }
  if (scheme && scheme !== 'https' && input.slice(scheme.length + 1, scheme.length + 3) === '//') {
    return fail(INVALID);
  }
  const withScheme = scheme === 'https' ? input : `https://${input.replace(/^\/\//, '')}`;

  // Checked on the raw text: the parser would accept and silently drop some of
  // these (an empty user name, a bare "?").
  const authorityEnd = withScheme.slice('https://'.length).search(/[/?#]/);
  const authority =
    authorityEnd === -1 ? withScheme.slice('https://'.length) : withScheme.slice('https://'.length, 'https://'.length + authorityEnd);
  if (authority.includes('@')) return fail('The store URL must not contain a user name or password.');
  if (withScheme.includes('?') || withScheme.includes('#')) {
    return fail('Enter only the store address, without ?query or #fragment.');
  }

  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return fail(INVALID);
  }
  if (url.protocol !== 'https:') return fail(INVALID);
  if (url.username || url.password) return fail('The store URL must not contain a user name or password.');
  // new URL() drops the default :443, so any port left is a non-default one.
  if (url.port) return fail("Use your store's standard https:// address, without a port number.");

  let host = url.hostname;
  if (host.endsWith('.')) host = host.slice(0, -1);
  if (host.startsWith('[') || DOTTED_QUAD.test(host)) {
    return fail('Use your store’s domain name, not an IP address.');
  }
  if (!HOSTNAME.test(host)) return fail(INVALID);
  if (EMBEDDED_DOTTED_QUAD.test(host) || EMBEDDED_DASHED_QUAD.test(host)) {
    return fail('Use your store’s domain name, not an IP address.');
  }
  if (hasBlockedSuffix(host)) return fail('The store URL must be a public website address.');

  // Path: the WordPress install directory, if any. Cut a pasted REST or admin
  // path ("/wp-json/wc/v3", "/wp-admin/...") back to the install directory.
  // Read from the raw text, not url.pathname: the parser silently resolves
  // "/a/../b" and "/%2e%2e/" dot segments.
  const rawPath = authorityEnd === -1 ? '' : withScheme.slice('https://'.length + authorityEnd);
  if (rawPath.includes('%')) return fail(INVALID);
  const segments: string[] = [];
  for (const segment of rawPath.split('/')) {
    if (segment === '') continue;
    const lower = segment.toLowerCase();
    if (lower === 'wp-json' || lower === 'wp-admin') break;
    if (segment === '.' || segment === '..' || !PATH_SEGMENT.test(segment)) return fail(INVALID);
    segments.push(segment);
  }
  const path = segments.length ? `/${segments.join('/')}` : '';
  if (path.length > MAX_PATH_LENGTH) return fail(INVALID);

  return { ok: true, value: `https://${host}${path}` };
}

export interface WooCommerceCredentials {
  consumerKey: string;
  consumerSecret: string;
}

// WooCommerce generates 'ck_' / 'cs_' + wc_rand_hash() (40 hex characters;
// includes/class-wc-auth.php, includes/class-wc-ajax.php). The bounds are
// looser than that so a future length change doesn't lock merchants out, but
// tight enough that nothing but a key reaches the Authorization header.
const CONSUMER_KEY = /^ck_[A-Za-z0-9]{20,128}$/;
const CONSUMER_SECRET = /^cs_[A-Za-z0-9]{20,128}$/;

/**
 * The integration's stored access token for WooCommerce is
 * "<consumer key>:<consumer secret>", pasted as one value in the dashboard.
 * Returns null unless both parts look like WooCommerce REST API keys.
 */
export function parseWooCommerceCredentials(token: string | null | undefined): WooCommerceCredentials | null {
  if (typeof token !== 'string') return null;
  const sep = token.indexOf(':');
  if (sep === -1) return null;
  const consumerKey = token.slice(0, sep).trim();
  const consumerSecret = token.slice(sep + 1).trim();
  if (!CONSUMER_KEY.test(consumerKey) || !CONSUMER_SECRET.test(consumerSecret)) return null;
  return { consumerKey, consumerSecret };
}
