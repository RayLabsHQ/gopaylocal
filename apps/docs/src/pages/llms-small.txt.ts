/** /llms-small.txt, generated at build time. See ./_llms/files.ts. */
import type { APIRoute } from 'astro';
import { buildLlmsSmall } from './_llms/files';

export const prerender = true;

export const GET: APIRoute = async ({ site }) =>
  new Response(await buildLlmsSmall(site!), {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
