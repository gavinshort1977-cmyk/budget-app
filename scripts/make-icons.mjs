// Renders the app icons (PNG) from an inline SVG using the pre-installed Playwright Chromium.
// Usage: node scripts/make-icons.mjs
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const svg = (size, pad) => `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 100 100">
  <rect width="100" height="100" rx="${pad ? 0 : 22}" fill="#1d5fa8"/>
  <g transform="translate(50 50) scale(${pad ? 0.62 : 0.8}) translate(-50 -50)">
    <rect x="18" y="52" width="14" height="28" rx="3" fill="#ffffff" opacity=".75"/>
    <rect x="43" y="38" width="14" height="42" rx="3" fill="#ffffff" opacity=".9"/>
    <rect x="68" y="22" width="14" height="58" rx="3" fill="#ffffff"/>
    <path d="M16 44 L44 30 L60 36 L84 16" fill="none" stroke="#ffb27a" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>
  </g></svg>`;

const out = [['docs/icons/icon-192.png', 192, false], ['docs/icons/icon-512.png', 512, false], ['docs/icons/maskable-512.png', 512, true], ['docs/icons/apple-touch-icon.png', 180, true]];
const browser = await chromium.launch();
const page = await browser.newPage();
for (const [file, size, pad] of out) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<html><body style="margin:0;background:transparent">${svg(size, pad)}</body></html>`);
  writeFileSync(file, await page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } }));
}
await browser.close();
console.log('icons written');
