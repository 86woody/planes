// Render every SVG in docs/presentation (and frames/) to PNG with Playwright's Chromium.
// Usage: node docs/presentation/src/render.mjs
import { chromium } from '@playwright/test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const files = [
  ...readdirSync(root).filter((f) => f.endsWith('.svg')).map((f) => join(root, f)),
  ...readdirSync(join(root, 'frames')).filter((f) => f.endsWith('.svg')).map((f) => join(root, 'frames', f)),
];
const browser = await chromium.launch();
const page = await browser.newPage({ deviceScaleFactor: 1 });
for (const svgPath of files) {
  const svg = readFileSync(svgPath, 'utf8');
  const [, w, h] = svg.match(/width="(\d+)" height="(\d+)"/);
  const scale = svgPath.includes('frames') ? 1 : 2;
  await page.setViewportSize({ width: Number(w), height: Number(h) });
  await page.setContent(`<html><body style="margin:0;zoom:1">${svg}</body></html>`);
  const out = svgPath.replace(/\.svg$/, '.png');
  if (scale === 2) {
    const p2 = await browser.newPage({ deviceScaleFactor: 2, viewport: { width: Number(w), height: Number(h) } });
    await p2.setContent(`<html><body style="margin:0">${svg}</body></html>`);
    await p2.screenshot({ path: out });
    await p2.close();
  } else {
    await page.screenshot({ path: out });
  }
  console.log('png', out);
}
await browser.close();
