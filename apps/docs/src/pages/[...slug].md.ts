/**
 * Markdown twin of every docs page: /banner/installation/ -> /banner/installation.md
 * (the home page is /index.md). Prerendered to static files at build time.
 */
import type { APIRoute, GetStaticPaths, InferGetStaticPropsType } from 'astro';
import { getDocsInOrder, renderPage } from './_llms/markdown';

export const prerender = true;

export const getStaticPaths = (async () => {
  const docs = await getDocsInOrder();
  const ids = new Set(docs.map((d) => d.id));
  return docs.map((entry) => ({ params: { slug: entry.id }, props: { entry, ids } }));
}) satisfies GetStaticPaths;

type Props = InferGetStaticPropsType<typeof getStaticPaths>;

export const GET: APIRoute<Props> = ({ props, site }) => {
  const body = renderPage(props.entry, { site: site!, ids: props.ids });
  return new Response(body, {
    headers: { 'Content-Type': 'text/markdown; charset=utf-8' },
  });
};
