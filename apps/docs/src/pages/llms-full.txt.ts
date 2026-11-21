/** /llms-full.txt, generated at build time. See ./_llms/files.ts. */
import type { APIRoute } from 'astro';
import { buildLlmsFull } from './_llms/files';

export const prerender = true;

export const GET: APIRoute = async ({ site }) =>
  new Response(await buildLlmsFull(site!), {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
