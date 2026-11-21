/**
 * Helpers shared by the three GoPayLocal clients: this SDK,
 * `@gopaylocal/react` and the script-tag banner. The other two bundle this
 * file at build time, so all three build the config request, keep the visitor
 * id, read experiment fields and fill the banner message the same way.
 *
 * Keep it small and dependency-free: the banner ships it to every visitor.
 */

/** The hosted API. Self-hosted deployments pass their own Worker URL instead. */
export const DEFAULT_API_BASE = 'https://api.gopaylocal.com';

/**
 * The one localStorage key that holds the visitor id. Shared by every
 * GoPayLocal client on an origin, so a visitor stays in the same experiment
 * arm whichever integration a page uses.
 */
export const VISITOR_ID_STORAGE_KEY = 'gpl_vid';

/** Same rule the API applies to `vid`; anything else is ignored there. */
const VISITOR_ID_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;

/** Whether `value` is a visitor id the API accepts (16 to 64 of `A-Z a-z 0-9 _ -`). */
export function isValidVisitorId(value: unknown): value is string {
  return typeof value === 'string' && VISITOR_ID_PATTERN.test(value);
}

/**
 * A new random visitor id: 16 bytes from Web Crypto as 32 lowercase hex
 * characters. Returns null when Web Crypto is unavailable; there is no
 * `Math.random` fallback. (`crypto.randomUUID` is not used because it only
 * exists in secure contexts.)
 */
export function generateVisitorId(): string | null {
  try {
    const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
    let id = '';
    for (let i = 0; i < bytes.length; i++) {
      id += (bytes[i]! | 256).toString(16).slice(1);
    }
    return id;
  } catch {
    return null;
  }
}

/**
 * `localStorage`, or null when it is missing (server rendering) or blocked.
 * Reading the property itself throws when the browser blocks site storage.
 */
export function getLocalStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export interface VisitorIdOptions {
  /** An id chosen by the site. Used as is when valid, never stored. */
  visitorId?: string | null;
  /** Keep a generated id in localStorage. Defaults to true. */
  persist?: boolean;
  /** Storage to use. Defaults to `localStorage`; tests pass a fake. */
  storage?: Storage | null;
}

/**
 * The visitor id to send as `vid`, or null to send none.
 *
 * 1. A valid `visitorId` override wins. An invalid one is ignored.
 * 2. With `persist: false`, no id is generated and null is returned: the
 *    server then keys experiment assignment on a hash of IP and user agent,
 *    which stays stable across page loads, unlike a fresh random id.
 * 3. Otherwise the stored id is returned, or a new one is generated and
 *    stored. A new id that cannot be stored is not returned, for the same
 *    reason as in 2.
 */
export function resolveVisitorId(options: VisitorIdOptions = {}): string | null {
  const { visitorId, persist = true } = options;
  if (isValidVisitorId(visitorId)) return visitorId;
  if (!persist) return null;

  const storage = options.storage === undefined ? getLocalStorage() : options.storage;
  if (!storage) return null;

  try {
    const stored = storage.getItem(VISITOR_ID_STORAGE_KEY);
    if (isValidVisitorId(stored)) return stored;
    const fresh = generateVisitorId();
    if (!fresh) return null;
    storage.setItem(VISITOR_ID_STORAGE_KEY, fresh);
    return fresh;
  } catch {
    return null;
  }
}

/**
 * Whether `key` looks like a secret API key (`gpl_sk_`). The same prefix rule
 * as the API's (apps/api/src/lib/public-key.ts): case-insensitive, leading
 * whitespace ignored.
 */
export function isSecretKey(key: unknown): boolean {
  return typeof key === 'string' && /^\s*gpl_sk_/i.test(key);
}

/**
 * What a client logs when it is given a secret key, before it sends anything.
 * The wording after the prefix is the API's refusal text for the same mistake.
 */
export const SECRET_KEY_MESSAGE =
  'GoPayLocal: Secret keys (gpl_sk_) must never be used in a browser. This key is now exposed: revoke it in the dashboard, replace it with a new secret key on your server, and use your public key (gpl_pk_) here.';

/** Strip trailing slashes; fall back to the hosted API when empty. */
export function normalizeApiBase(apiBase?: string | null): string {
  return (apiBase || DEFAULT_API_BASE).replace(/\/+$/, '');
}

export interface ConfigRequest {
  /** API base URL. Defaults to the hosted API. */
  apiBase?: string | null;
  /** Public API key (`gpl_pk_...`). */
  apiKey: string;
  /** Only consider this product's campaign. */
  productId?: string | null;
  /** Visitor id for experiment assignment (already resolved). */
  visitorId?: string | null;
}

/**
 * `GET {apiBase}/v1/banner/config/{apiKey}?product=..&vid=..`, with each
 * query parameter present only when it has a value.
 */
export function buildConfigUrl(request: ConfigRequest): string {
  const params = new URLSearchParams();
  if (request.productId) params.set('product', request.productId);
  if (request.visitorId) params.set('vid', request.visitorId);
  const query = params.toString();
  return (
    normalizeApiBase(request.apiBase) +
    '/v1/banner/config/' +
    encodeURIComponent(request.apiKey) +
    (query ? '?' + query : '')
  );
}

/** Which experiment arm served this response, if an experiment applied. */
export interface ExperimentInfo {
  /** The running experiment's id, or null when no experiment applied. */
  experimentId: string | null;
  /** `'a'` (control) or `'b'` (variant), or null when no experiment applied. */
  variant: 'a' | 'b' | null;
}

/** Read `experimentId` and `variant` from a config response: both or neither. */
export function readExperiment(response: unknown): ExperimentInfo {
  const r = (response ?? {}) as { experimentId?: unknown; variant?: unknown };
  if (
    typeof r.experimentId === 'string' &&
    r.experimentId !== '' &&
    (r.variant === 'a' || r.variant === 'b')
  ) {
    return { experimentId: r.experimentId, variant: r.variant };
  }
  return { experimentId: null, variant: null };
}

/**
 * Keep a banner color inside its CSS declaration. Allows hex, named colors
 * and rgb()/hsl() with commas; drops characters such as `; { } : / ' "` that
 * could end the declaration or load a URL.
 */
export function cssColor(value: string | null | undefined): string {
  return (value ?? '').replace(/[^#\w(),.%\s-]/g, '');
}

/**
 * Add a stylesheet to a banner's shadow root. A constructed stylesheet is
 * CSSOM, which a Content-Security-Policy `style-src` without 'unsafe-inline'
 * does not block; a <style> element it does, which left the banner unstyled
 * on such sites. Browsers without constructable stylesheets get the <style>.
 */
export function adoptStyles(root: ShadowRoot, css: string): void {
  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(css);
    root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet];
    return;
  } catch {
    // No constructable stylesheets: fall back to a <style> element.
  }
  const style = root.ownerDocument.createElement('style');
  style.textContent = css;
  root.appendChild(style);
}

/**
 * Format a price in the visitor's locale, showing exactly the number given:
 * a whole number with no decimals ("₹1,599", "$19"), anything else with 3
 * decimals in the three-decimal currencies ("KWD 5.990") and 2 in every other
 * ("$7.60", "PKR 1,838.14"). The digits are always passed explicitly: Intl's
 * own defaults differ between browsers, and current ICU gives PKR, IDR, IQD
 * and a dozen more 0, which rounded the API's "PKR 1838.14" to "PKR 1,838".
 *
 * This small rule, not the SDKs' full digits table (`currencyDigits` in
 * ./price.ts), keeps the script-tag banner small. It is enough because the
 * banner only formats prices the API already rounded to those digits; the
 * three-decimal list is THREE_DECIMAL_CURRENCIES in packages/shared (a test
 * keeps them equal).
 */
export function formatMoney(value: number, currency: string, locale?: string): string {
  const digits = value % 1 ? (/^(BHD|IQD|JOD|KWD|LYD|OMR|TND)$/i.test(currency) ? 3 : 2) : 0;
  try {
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency,
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    }).format(value);
  } catch {
    return (currency ? currency + ' ' : '') + value;
  }
}

/** Flag emoji for an ISO 3166-1 alpha-2 country code, or "" if it is not one. */
export function flagOf(country: string | null | undefined): string {
  const u = (country ?? '').toUpperCase();
  return /^[A-Z]{2}$/.test(u)
    ? String.fromCodePoint(0x1f1e6 + u.charCodeAt(0) - 65, 0x1f1e6 + u.charCodeAt(1) - 65)
    : '';
}

/** What a banner message is filled from: a config response with a discount. */
export interface TemplateData {
  country: string;
  countryName: string;
  discount: number;
  code: string | null;
  /** The currency of `localPrice` (the visitor's when converted, else the product's). */
  currencyCode?: string;
  currencySymbol?: string;
  /** The product's price after the discount, in `currencyCode`. */
  localPrice?: number | null;
  /** The product's price before the discount, in `currencyCode`. */
  localOriginalPrice?: number | null;
}

/**
 * The placeholders a banner message supports, `{{name}}`. Every renderer (the
 * script tag, `showBanner()`, `<PPPBanner>`, the dashboard preview) fills them
 * from `templateValues()`, so they cannot drift apart.
 */
export const PLACEHOLDERS = [
  'countryName',
  'country',
  'flag',
  'discount',
  'code',
  'localPrice',
  'localOriginalPrice',
  'currencySymbol',
  'currencyCode',
] as const;

export type Placeholder = (typeof PLACEHOLDERS)[number];

/**
 * Each placeholder's text for one visitor, unescaped. Prices are formatted in
 * the visitor's locale (`formatMoney`); a value the response lacks is "".
 */
export function templateValues(z: TemplateData): Record<Placeholder, string> {
  const cur = z.currencyCode || '';
  const money = (v: number | null | undefined) => (typeof v == 'number' && isFinite(v) ? formatMoney(v, cur) : '');
  return {
    countryName: z.countryName || '',
    country: z.country || '',
    flag: flagOf(z.country),
    discount: '' + (z.discount || 0),
    code: z.code || '',
    localPrice: money(z.localPrice),
    localOriginalPrice: money(z.localOriginalPrice),
    currencySymbol: z.currencySymbol || '',
    currencyCode: cur,
  };
}

/**
 * Replace each `{{name}}` in a message template with its value. Unknown names
 * (including inherited ones such as `{{constructor}}`) and empty values become
 * "". `each` sees every non-empty value before it is inserted, for renderers
 * that escape or wrap it.
 */
export function fillTemplate(
  template: string,
  values: Readonly<Record<string, string>>,
  each?: (text: string, name: string) => string,
): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, name: string) => {
    const v = Object.prototype.hasOwnProperty.call(values, name) ? values[name] : '';
    return v ? (each ? each(v, name) : v) : '';
  });
}

/**
 * Banner events. Only `click` and `copy` are sent to the API (`sendEvent`):
 * an impression is counted by the API itself when it serves the offer, and a
 * dismissal is not stored. The other two remain in the type so that code
 * written for earlier versions still compiles.
 */
export type TrackableEvent = 'impression' | 'click' | 'copy' | 'dismiss';

export interface TrackRequest {
  apiBase?: string | null;
  apiKey: string;
  event: TrackableEvent;
  campaignId: string | null;
  country: string | null;
  code?: string | null;
}

/**
 * Report a banner event to `POST {apiBase}/v1/events`, fire and forget.
 *
 * Only `click` and `copy` are sent. The API counts an impression when it
 * answers the config request with an offer, and stores no dismissals, so
 * sending either would be a request for nothing.
 *
 * The body is a JSON string sent as text/plain, which is CORS-safelisted, so
 * it goes out without a preflight from any origin. Uses `sendBeacon` when it
 * accepts the payload, otherwise a keepalive `fetch` in no-cors mode. Events
 * without a campaign are dropped by the API, so they are not sent.
 */
export function sendEvent(request: TrackRequest): void {
  if (!request.campaignId || (request.event !== 'click' && request.event !== 'copy')) return;
  try {
    const url = normalizeApiBase(request.apiBase) + '/v1/events';
    const body = JSON.stringify({
      key: request.apiKey,
      event: request.event,
      url: globalThis.location?.href,
      campaignId: request.campaignId,
      countryCode: request.country ?? undefined,
      code: request.code ?? undefined,
    });
    const nav = globalThis.navigator;
    if (nav?.sendBeacon && nav.sendBeacon(url, body)) return;
    void fetch(url, { method: 'POST', body, mode: 'no-cors', keepalive: true }).catch(() => {});
  } catch {
    // Analytics must never break the page.
  }
}
