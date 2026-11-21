import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import starlightThemeBlack from 'starlight-theme-black';
import { sidebar } from './src/sidebar.mjs';

const site = 'https://docs.gopaylocal.com';

/**
 * Adds the page-actions control (copy / view as Markdown / open in Claude or
 * ChatGPT) under each page title. starlight-theme-black already overrides
 * <PageTitle>, so this runs as a plugin listed after the theme and wraps the
 * theme's component instead of replacing it (a user-level override would make
 * the theme skip its own PageTitle and log a warning). Plugins run in order, so
 * `config.components.PageTitle` is the theme's by the time this hook runs:
 * https://starlight.astro.build/reference/plugins/#updateconfig
 * @returns {import('@astrojs/starlight/types').StarlightPlugin}
 */
function pageActions() {
  return {
    name: 'gopaylocal-page-actions',
    hooks: {
      'config:setup'({ config, updateConfig }) {
        updateConfig({
          components: { ...config.components, PageTitle: './src/components/PageTitle.astro' },
        });
      },
    },
  };
}

export default defineConfig({
  site,
  // starlight-theme-black 0.6 CSS fails Vite 8's lightningcss minifier; remove together with the 0.6.0 pin.
  vite: { build: { cssMinify: 'esbuild' } },
  // Removed pages: keep old links working.
  redirects: {
    '/integrations/lemon-squeezy': '/guides/moving-from-lemon-squeezy/',
  },
  integrations: [
    starlight({
      plugins: [
        starlightThemeBlack({
          navLinks: [
            { label: 'Docs', link: '/getting-started/introduction' },
          ],
          // Read by theme 0.6 only; 0.7 removed `footerText` (and its footer) and ignores it.
          footerText:
            'Built by [GoPayLocal](https://gopaylocal.com). PPP discounts that just work. For AI agents: [llms.txt](/llms.txt).',
          // Theme 0.7 adds its own Markdown actions to PageTitle; they copy the raw MDX and
          // prompt with the HTML URL, so they are off in favour of pageActions() below.
          // Theme 0.6 does not know this option and drops it.
          docs: { showMarkdownActions: false },
        }),
        pageActions(),
      ],
      title: 'GoPayLocal',
      description: 'PPP discounts that just work. Documentation for integrating GoPayLocal into your app.',
      logo: {
        light: './src/assets/logo-light.svg',
        dark: './src/assets/logo-dark.svg',
        replacesTitle: false,
      },
      social: [
        { icon: 'github', label: 'GitHub', href: 'https://github.com/RayLabsHQ/gopaylocal' },
        { icon: 'x.com', label: 'Twitter', href: 'https://twitter.com/gopaylocal' },
      ],
      editLink: {
        baseUrl: 'https://github.com/RayLabsHQ/gopaylocal/edit/main/apps/docs/',
      },
      lastUpdated: true,
      favicon: '/favicon.svg',
      customCss: ['./src/styles/custom.css'],
      head: [
        // Agent entry point (llms.txt convention, https://llmstxt.org).
        {
          tag: 'link',
          attrs: { rel: 'describedby', type: 'text/plain', href: `${site}/llms.txt`, title: 'llms.txt' },
        },
      ],
      components: {
        // Dark-only: pin the theme and hide the picker until a light palette ships.
        ThemeProvider: './src/components/ThemeProviderDark.astro',
        ThemeSelect: './src/components/ThemeSelectNone.astro',
      },
      // Adds <link rel="alternate" type="text/markdown"> pointing at each page's .md twin.
      // Route middleware rather than a <Head> override, which theme 0.7 needs for itself.
      routeMiddleware: './src/pages/_llms/route-middleware.ts',
      sidebar,
    }),
  ],
});
