import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';
import react from '@astrojs/react';
import sitemap from '@astrojs/sitemap';

export default defineConfig({
  site: 'https://gopaylocal.com',
  // Astro 7 defaults to JSX whitespace rules ('jsx'), which drop the line-break space
  // between text and a following inline element ("contact us at<a>"). `true` is
  // Astro 6's lossless compression, so pages render as they did before the upgrade.
  compressHTML: true,
  integrations: [react(), sitemap()],
  vite: {
    plugins: [tailwindcss()],
  },
});
