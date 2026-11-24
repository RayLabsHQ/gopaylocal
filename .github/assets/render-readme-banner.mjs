// Renders readme-banner.html to the two README header images, at 2x:
//   node .github/assets/render-readme-banner.mjs
// Needs Playwright's Chromium (`pnpm exec playwright install chromium`) or
// Google Chrome, and network access for the Google Fonts it uses.
import { chromium } from '@playwright/test';
import { fileURLToPath } from 'node:url';

const here = (name) => fileURLToPath(new URL(name, import.meta.url));
const browser = await chromium.launch().catch(() => chromium.launch({ channel: 'chrome' }));
try {
  for (const theme of ['light', 'dark']) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 400 }, deviceScaleFactor: 2 });
    await page.goto(`file://${here('readme-banner.html')}?theme=${theme}`);
    await page.evaluate(() => document.fonts.ready);
    const missing = await page.evaluate(() =>
      ['700 10px "Space Grotesk"', '400 10px Inter', '500 10px "JetBrains Mono"'].filter((f) => !document.fonts.check(f)),
    );
    if (missing.length) throw new Error(`fonts did not load: ${missing.join(', ')}`);
    await page.screenshot({ path: here(`readme-banner-${theme}.png`) });
    await page.close();
    console.log(`readme-banner-${theme}.png`);
  }
} finally {
  await browser.close();
}
