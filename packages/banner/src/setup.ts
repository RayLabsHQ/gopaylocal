/**
 * Reads the banner's settings from the page's <script> tags.
 *
 *   <script src="https://api.gopaylocal.com/v1/banner/script.js?key=gpl_pk_..."
 *           data-product="prod_..."      (optional) only this product's campaign
 *           data-visitor-id="..."        (optional) your own experiment visitor id
 *           data-no-storage              (optional) store nothing in the browser
 *           async></script>
 *
 * script.js is the banner itself. It used to be a loader that injected
 * bundle.js, and a page can still hold that loader in its cache, so the
 * attributes may sit on a different tag from the one running this code.
 * Candidates are the running script first, then every script whose src
 * contains `/v1/banner/` or `gopaylocal`, in document order. The key comes
 * from the first candidate with a `key` query parameter, the API base from
 * that tag's src (everything before `/v1/`, so a self-hosted API works by
 * loading the script from it), and each data attribute from the first
 * candidate that has it.
 */

import { DEFAULT_API_BASE } from '../../js-sdk/src/core';

/** The parts of a <script> element this file reads (an Element satisfies it). */
export interface ScriptTag {
  getAttribute(name: string): string | null;
  hasAttribute(name: string): boolean;
}

export interface BannerSetup {
  /** Public API key from `?key=`. */
  key: string;
  /** API base URL, without a trailing slash. */
  apiBase: string;
  /** `data-product`, trimmed, or null. */
  productId: string | null;
  /** `data-visitor-id` as written, or null (validated when the id is resolved). */
  visitorId: string | null;
  /** `data-no-storage` is present (and not "false"). */
  noStorage: boolean;
}

const SRC_PATTERN = /\/v1\/banner\/|gopaylocal/i;

export function readSetup(
  current: ScriptTag | null,
  scripts: ArrayLike<ScriptTag>,
  pageUrl: string,
): BannerSetup | null {
  const candidates: ScriptTag[] = current ? [current] : [];
  for (let i = 0; i < scripts.length; i++) {
    const s = scripts[i]!;
    if (s !== current && SRC_PATTERN.test(s.getAttribute('src') || '')) candidates.push(s);
  }

  let key: string | null = null;
  let apiBase = DEFAULT_API_BASE;
  for (const s of candidates) {
    const src = s.getAttribute('src') || '';
    let url: URL;
    try {
      url = new URL(src, pageUrl);
    } catch {
      continue;
    }
    key = url.searchParams.get('key');
    if (key) {
      const href = url.origin + url.pathname;
      const v1 = href.indexOf('/v1/');
      if (v1 > -1) apiBase = href.slice(0, v1);
      break;
    }
  }
  if (!key) return null;

  const attr = (name: string): string | null => {
    for (const s of candidates) if (s.hasAttribute(name)) return s.getAttribute(name);
    return null;
  };

  const product = (attr('data-product') || '').trim();
  const noStorage = attr('data-no-storage');
  return {
    key,
    apiBase,
    productId: product || null,
    visitorId: attr('data-visitor-id'),
    noStorage: noStorage !== null && noStorage !== 'false',
  };
}
