/**
 * Build-time MDX -> plain Markdown conversion for the agent-readable outputs
 * (per-page `.md` files, llms.txt, llms-full.txt, llms-small.txt).
 *
 * Works on the raw MDX source (`entry.body`) instead of re-parsing rendered HTML,
 * so it needs no extra dependencies and keeps code fences byte-for-byte. It knows
 * the Starlight components these docs use (Steps, Tabs/TabItem, Aside, CardGrid,
 * LinkCard, Card) and flattens them into ordinary Markdown. Any other JSX
 * component is unwrapped (children kept) and reported with a build warning so new
 * components don't silently leak into the output.
 *
 * Files in `src/pages` that start with `_` are not routes (Astro convention).
 */
import { getCollection, type CollectionEntry } from 'astro:content';
import { sidebar } from '../../sidebar.mjs';
import { htmlUrl, markdownUrl } from './urls';

export { htmlUrl, markdownPath, markdownUrl } from './urls';

export type DocEntry = CollectionEntry<'docs'>;

// ── Collection helpers ──────────────────────────────────────────────────────

/** All published docs pages (drafts excluded), in sidebar order; pages not in the sidebar go first (home) or last. */
export async function getDocsInOrder(): Promise<DocEntry[]> {
  const docs = await getCollection('docs', (entry) => !entry.data.draft);
  const order = new Map<string, number>();
  let n = 0;
  for (const group of sidebar) for (const item of group.items) order.set(item.slug, n++);
  const rank = (id: string) => (id === 'index' ? -1 : (order.get(id) ?? Number.MAX_SAFE_INTEGER));
  return docs.sort((a, b) => rank(a.id) - rank(b.id) || a.id.localeCompare(b.id));
}

/**
 * Pages left out of llms.txt / llms-full.txt / llms-small.txt because they
 * describe behaviour the product does not have yet. Their `.md` twin is still
 * generated (every page has one). Remove an entry once the page is accurate.
 */
export const EXCLUDED_FROM_LLMS = new Set<string>([
  // Empty: every page describes what the code does today. (guides/multi-currency
  // and guides/charm-pricing were here until local prices shipped; their
  // numbers come from packages/shared/src/currency/docs-examples.test.ts.)
]);

// ── Page rendering ──────────────────────────────────────────────────────────

export interface RenderContext {
  site: URL;
  /** Every docs page id, used to rewrite internal links to their `.md` twins. */
  ids: Set<string>;
}

/** Full Markdown document for one page: title, summary, source URL, flattened body. */
export function renderPage(entry: DocEntry, ctx: RenderContext): string {
  const title = entry.data.title;
  const summary = entry.data.description ?? entry.data.hero?.tagline;
  const parts = [`# ${title}`];
  if (summary) parts.push(`> ${summary}`);
  parts.push(`Source: ${htmlUrl(entry.id, ctx.site)}`);
  const body = mdxToMarkdown(entry.body ?? '', ctx, entry.id);
  if (body) parts.push(body);
  return parts.join('\n\n') + '\n';
}

// ── MDX -> Markdown ─────────────────────────────────────────────────────────

const FENCE_RE = /^(\s*)(`{3,}|~{3,})(.*)$/;
const ASIDE_LABELS: Record<string, string> = {
  note: 'Note',
  tip: 'Tip',
  caution: 'Caution',
  danger: 'Danger',
};
/** Components that only group children; the wrapper itself carries no content. */
const TRANSPARENT = new Set(['Steps', 'Tabs', 'CardGrid', 'Fragment']);

const indentOf = (line: string) => line.match(/^ */)![0].length;

function minIndent(lines: string[]): number {
  let min = Infinity;
  for (const l of lines) if (l.trim()) min = Math.min(min, indentOf(l));
  return min === Infinity ? 0 : min;
}

function dedent(lines: string[], n: number): string[] {
  if (n <= 0) return lines;
  return lines.map((l) => l.slice(Math.min(n, indentOf(l))));
}

function indent(lines: string[], n: number): string[] {
  if (n <= 0) return lines;
  const pad = ' '.repeat(n);
  return lines.map((l) => (l.trim() ? pad + l : ''));
}

interface ParsedTag {
  name: string;
  attrs: Record<string, string>;
  selfClosing: boolean;
  /** Index just past the closing `>` of the opening tag. */
  end: number;
}

/**
 * Parse a JSX opening tag at the start of `text` (`<Name a="b" c={...}>` or `.../>`).
 * Returns null if the tag is not closed within `text`.
 */
function parseOpeningTag(text: string): ParsedTag | null {
  const m = text.match(/^<([A-Za-z][\w.]*)/);
  if (!m) return null;
  const name = m[1]!;
  const attrs: Record<string, string> = {};
  let i = m[0].length;
  while (i < text.length) {
    const ch = text[i]!;
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === '/' && text[i + 1] === '>') return { name, attrs, selfClosing: true, end: i + 2 };
    if (ch === '>') return { name, attrs, selfClosing: false, end: i + 1 };
    const an = text.slice(i).match(/^[\w:-]+/);
    if (!an) return null;
    const key = an[0];
    i += key.length;
    if (text[i] !== '=') {
      attrs[key] = 'true';
      continue;
    }
    i++;
    const q = text[i];
    if (q === '"' || q === "'") {
      const close = text.indexOf(q, i + 1);
      if (close === -1) return null;
      attrs[key] = text.slice(i + 1, close);
      i = close + 1;
    } else if (q === '{') {
      // JSX expression: skip to the matching brace. Its value can't be evaluated here.
      let depth = 0;
      let j = i;
      for (; j < text.length; j++) {
        if (text[j] === '{') depth++;
        else if (text[j] === '}' && --depth === 0) break;
      }
      if (j >= text.length) return null;
      const expr = text.slice(i + 1, j).trim();
      // Keep plain string-literal expressions like {'foo'} or {"foo"}.
      const lit = expr.match(/^(['"`])(.*)\1$/s);
      attrs[key] = lit ? lit[2]! : '';
      i = j + 1;
    } else {
      return null;
    }
  }
  return null;
}

/** Rewrite root-relative Markdown links to absolute URLs (docs pages -> their `.md` twin). */
function rewriteLinks(line: string, ctx: RenderContext): string {
  // Leave inline code spans alone: only touch even-numbered backtick segments.
  return line
    .split('`')
    .map((seg, idx) =>
      idx % 2 === 1
        ? seg
        : seg.replace(/\]\((\/[^)\s]*)\)/g, (_all, target: string) => {
            const hashAt = target.indexOf('#');
            const path = hashAt === -1 ? target : target.slice(0, hashAt);
            const hash = hashAt === -1 ? '' : target.slice(hashAt);
            const id = path.replace(/^\/+|\/+$/g, '') || 'index';
            if (ctx.ids.has(id)) return `](${markdownUrl(id, ctx.site)}${hash})`;
            return `](${new URL(path, ctx.site).href}${hash})`;
          }),
    )
    .join('`');
}

const warned = new Set<string>();
function warnOnce(key: string, message: string) {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(`[llms markdown] ${message}`);
}

/** Convert an MDX body to plain Markdown. `pageId` is only used in warnings. */
export function mdxToMarkdown(body: string, ctx: RenderContext, pageId = '?'): string {
  const out = convertLines(body.replace(/\r\n?/g, '\n').split('\n'), ctx, pageId);
  return out
    .join('\n')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function convertLines(lines: string[], ctx: RenderContext, pageId: string): string[] {
  const out: string[] = [];
  let fence: string | null = null;
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;
    const trimmed = line.trim();

    // Inside a fenced code block: copy verbatim until the matching closing fence.
    if (fence) {
      out.push(line);
      const fm = line.match(FENCE_RE);
      if (fm && fm[2]![0] === fence[0] && fm[2]!.length >= fence.length && !fm[3]!.trim()) fence = null;
      i++;
      continue;
    }
    const fm = line.match(FENCE_RE);
    if (fm) {
      fence = fm[2]!;
      out.push(line);
      i++;
      continue;
    }

    // MDX ESM: imports/exports must start at column 0. Drop them (multi-line imports too).
    if (/^import\s/.test(line)) {
      let j = i;
      while (j < lines.length && !/(from\s+['"][^'"]+['"]|^import\s+['"][^'"]+['"]);?\s*$/.test(lines[j]!)) j++;
      i = j + 1;
      continue;
    }
    if (/^export\s/.test(line)) {
      warnOnce(`export:${pageId}`, `${pageId}: dropped an MDX export statement`);
      i++;
      continue;
    }

    // MDX comments on their own line.
    if (/^\{\/\*[\s\S]*\*\/\}$/.test(trimmed)) {
      i++;
      continue;
    }

    // Raw HTML layout wrappers (<div ...>, </div>) on their own line: drop the tag, keep content.
    if (/^<\/?(div|section)(\s[^>]*)?>$/.test(trimmed)) {
      i++;
      continue;
    }

    // JSX components start with an uppercase letter.
    if (/^<[A-Z]/.test(trimmed)) {
      const consumed = convertComponent(lines, i, ctx, pageId, out);
      if (consumed > 0) {
        i += consumed;
        continue;
      }
    }
    // Stray closing tag of a component we unwrapped (shouldn't happen, but never leak it).
    if (/^<\/[A-Z][\w.]*>$/.test(trimmed)) {
      i++;
      continue;
    }

    out.push(rewriteLinks(line, ctx));
    i++;
  }
  return out;
}

/**
 * Handle a component whose opening tag starts on `lines[start]`. Appends converted
 * output to `out` and returns the number of source lines consumed (0 = not handled).
 */
function convertComponent(
  lines: string[],
  start: number,
  ctx: RenderContext,
  pageId: string,
  out: string[],
): number {
  const baseIndent = indentOf(lines[start]!);

  // Gather the opening tag, which may span several lines (e.g. LinkCard attributes).
  let text = lines[start]!.trim();
  let last = start;
  let tag = parseOpeningTag(text);
  while (!tag && last + 1 < lines.length && last - start < 40) {
    last++;
    text += ' ' + lines[last]!.trim();
    tag = parseOpeningTag(text);
  }
  if (!tag) return 0;

  const { name, attrs } = tag;
  const closeTag = `</${name}>`;
  let children: string[] = [];
  let consumed: number;

  if (tag.selfClosing) {
    consumed = last - start + 1;
  } else {
    const rest = text.slice(tag.end);
    const inlineClose = rest.indexOf(closeTag);
    if (inlineClose !== -1) {
      // <Aside type="tip">One-line content</Aside>
      children = [rest.slice(0, inlineClose).trim()];
      consumed = last - start + 1;
    } else {
      // Block form: find the matching closing tag, respecting nesting and code fences.
      if (rest.trim()) children.push(' '.repeat(baseIndent) + rest.trim());
      let depth = 1;
      let fence: string | null = null;
      let j = last + 1;
      for (; j < lines.length; j++) {
        const l = lines[j]!;
        const fm = l.match(FENCE_RE);
        if (fence) {
          if (fm && fm[2]![0] === fence[0] && fm[2]!.length >= fence.length && !fm[3]!.trim()) fence = null;
          children.push(l);
          continue;
        }
        if (fm) {
          fence = fm[2]!;
          children.push(l);
          continue;
        }
        const t = l.trim();
        if (new RegExp(`^<${name}(\\s|>|$)`).test(t) && !/\/>\s*$/.test(t)) depth++;
        if (t.endsWith(closeTag)) {
          depth--;
          if (depth === 0) {
            const before = t.slice(0, -closeTag.length).trim();
            if (before) children.push(' '.repeat(indentOf(l)) + before);
            break;
          }
        }
        children.push(l);
      }
      if (j >= lines.length) {
        warnOnce(`unclosed:${pageId}:${name}`, `${pageId}: <${name}> is never closed; output may be incomplete`);
      }
      consumed = j - start + 1;
    }
  }

  // Normalise children so the shallowest child line sits at the component's own indentation.
  children = dedent(children, minIndent(children) - baseIndent);
  const convertChildren = () => convertLines(children, ctx, pageId);
  const pad = ' '.repeat(baseIndent);

  switch (name) {
    case 'TabItem': {
      const label = attrs.label ?? '';
      out.push('', `${pad}**${label}**`, '', ...convertChildren(), '');
      break;
    }
    case 'Aside': {
      const label = attrs.title || ASIDE_LABELS[attrs.type ?? 'note'] || 'Note';
      const inner = dedent(convertChildren(), baseIndent);
      while (inner.length && !inner[0]!.trim()) inner.shift();
      while (inner.length && !inner[inner.length - 1]!.trim()) inner.pop();
      out.push('', `${pad}> **${label}:**`);
      for (const l of inner) out.push(l.trim() ? `${pad}> ${l}` : `${pad}>`);
      out.push('');
      break;
    }
    case 'LinkCard': {
      const href = attrs.href ? rewriteLinks(`](${attrs.href})`, ctx).slice(2, -1) : '';
      const desc = attrs.description ? `: ${attrs.description}` : '';
      out.push(`${pad}- [${attrs.title ?? href}](${href})${desc}`);
      break;
    }
    case 'Card': {
      out.push('', `${pad}**${attrs.title ?? ''}**`, '', ...convertChildren(), '');
      break;
    }
    default: {
      if (!TRANSPARENT.has(name)) {
        warnOnce(
          `unknown:${pageId}:${name}`,
          `${pageId}: <${name}> has no Markdown mapping; ${tag.selfClosing ? 'dropped it' : 'kept its children'}`,
        );
      }
      if (!tag.selfClosing) out.push('', ...convertChildren(), '');
    }
  }
  return consumed;
}
