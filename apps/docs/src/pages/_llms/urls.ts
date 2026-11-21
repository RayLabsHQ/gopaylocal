/**
 * URL helpers for the Markdown twins of docs pages. Kept free of `astro:content`
 * imports so components (Head, PageActions) can use them cheaply.
 */

/** Path of a page's Markdown twin: `/banner/installation.md`; the home page (id '' or 'index') is `/index.md`. */
export function markdownPath(id: string): string {
  return `/${id || 'index'}.md`;
}

/** Absolute URL of a page's Markdown twin. */
export function markdownUrl(id: string, site: URL): string {
  return new URL(markdownPath(id), site).href;
}

/** Absolute URL of the HTML page, as Starlight routes it (trailing slash, `/` for the home page). */
export function htmlUrl(id: string, site: URL): string {
  return new URL(id === 'index' || id === '' ? '/' : `/${id}/`, site).href;
}
