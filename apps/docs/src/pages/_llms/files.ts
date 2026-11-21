/**
 * Builders for /llms.txt, /llms-full.txt and /llms-small.txt (https://llmstxt.org).
 * The endpoint files in src/pages are thin wrappers around these.
 */
import { sidebar } from '../../sidebar.mjs';
import {
  EXCLUDED_FROM_LLMS,
  getDocsInOrder,
  markdownUrl,
  renderPage,
  type DocEntry,
  type RenderContext,
} from './markdown';

const PRODUCT = 'GoPayLocal';

const SUMMARY =
  'GoPayLocal adds purchasing power parity (PPP) discounts to a website. A banner script, ' +
  'or the React or JavaScript SDK, asks the GoPayLocal API about the current visitor; the API ' +
  "reads the visitor's country at the Cloudflare edge and answers with a discount percentage and " +
  "a coupon code that GoPayLocal created in the merchant's payment provider.";

/**
 * Curated subset for /llms-small.txt: what a coding agent needs to add GoPayLocal
 * to a site. Order matters; the reference card comes first because it is checked
 * against the source code.
 */
const ESSENTIALS = [
  'ai/reference-card',
  'ai/integration-prompt',
  'getting-started/quickstart',
  'banner/installation',
  'banner/customization',
  'react/installation',
  'react/provider',
  'react/hooks',
  'react/components',
  'js/installation',
  'js/client',
  'js/data-attributes',
  'js/banner',
  'platforms/nextjs',
  'integrations/overview',
  'guides/ab-testing',
];

async function context(site: URL): Promise<{ docs: DocEntry[]; ctx: RenderContext }> {
  const all = await getDocsInOrder();
  const ctx: RenderContext = { site, ids: new Set(all.map((d) => d.id)) };
  return { docs: all.filter((d) => !EXCLUDED_FROM_LLMS.has(d.id)), ctx };
}

const abs = (path: string, site: URL) => new URL(path, site).href;

/** /llms.txt: short index with one line per page, linking to the Markdown twins. */
export async function buildLlmsIndex(site: URL): Promise<string> {
  const { docs } = await context(site);
  const byId = new Map(docs.map((d) => [d.id, d]));
  const md = (id: string) => markdownUrl(id, site);

  const lines: string[] = [
    `# ${PRODUCT}`,
    '',
    `> ${SUMMARY}`,
    '',
    `Every page on this site has a Markdown version at the page path plus \`.md\`, for example ${md('banner/installation')}. The links below point to those Markdown files.`,
    '',
    `- Adding ${PRODUCT} to a codebase: read the [reference card](${md('ai/reference-card')}) first, then follow the [integration prompt](${md('ai/integration-prompt')}). The reference card is checked against the source code; if another page disagrees with it, trust the reference card.`,
    `- What to ask the human for: a public API key from the ${PRODUCT} dashboard (it starts with \`gpl_pk_\`) and which payment provider they sell through. Products, campaigns, discount levels, coupon codes and A/B tests are configured in the dashboard, not in code.`,
    `- Everything in one file: [llms-full.txt](${abs('/llms-full.txt', site)}). Integration essentials only: [llms-small.txt](${abs('/llms-small.txt', site)}).`,
  ];

  const listed = new Set<string>();
  for (const group of sidebar) {
    const entries = group.items.map((item) => byId.get(item.slug)).filter((e): e is DocEntry => !!e);
    if (!entries.length) continue;
    lines.push('', `## ${group.label}`, '');
    for (const entry of entries) {
      listed.add(entry.id);
      const desc = entry.data.description ? `: ${entry.data.description}` : '';
      lines.push(`- [${entry.data.title}](${md(entry.id)})${desc}`);
    }
  }

  // Pages that exist but are not in the sidebar (the home page, for example).
  const others = docs.filter((d) => !listed.has(d.id));
  lines.push('', '## Optional', '');
  for (const entry of others) {
    const desc = entry.data.description ? `: ${entry.data.description}` : '';
    lines.push(`- [${entry.data.title}](${md(entry.id)})${desc}`);
  }
  lines.push(
    `- [Complete documentation](${abs('/llms-full.txt', site)}): every page above in a single Markdown file`,
    `- [Source code](https://github.com/RayLabsHQ/gopaylocal): the ${PRODUCT} monorepo (API, banner script, SDKs, dashboard)`,
  );
  return lines.join('\n') + '\n';
}

function bundle(title: string, intro: string, pages: string[]): string {
  return [`# ${title}`, `> ${intro}`, ...pages].join('\n\n---\n\n');
}

/** /llms-full.txt: every page, flattened to Markdown, in sidebar order. */
export async function buildLlmsFull(site: URL): Promise<string> {
  const { docs, ctx } = await context(site);
  return bundle(
    `${PRODUCT} documentation (complete)`,
    `${SUMMARY} This file contains every page of ${abs('/', site)} as Markdown, in sidebar order. Each page starts with its title and source URL.`,
    docs.map((d) => renderPage(d, ctx).trim()),
  ) + '\n';
}

/** /llms-small.txt: the curated integration essentials. */
export async function buildLlmsSmall(site: URL): Promise<string> {
  const { docs, ctx } = await context(site);
  const byId = new Map(docs.map((d) => [d.id, d]));
  const picked = ESSENTIALS.map((id) => byId.get(id)).filter((e): e is DocEntry => !!e);
  return bundle(
    `${PRODUCT} documentation (integration essentials)`,
    `${SUMMARY} This file holds only the pages needed to add ${PRODUCT} to a website: the agent reference card, the integration prompt, the banner script, the React and JavaScript SDKs, the integrations overview and the A/B testing guide. The full set is at ${abs('/llms-full.txt', site)}.`,
    picked.map((d) => renderPage(d, ctx).trim()),
  ) + '\n';
}
