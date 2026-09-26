// server/scripts/ui-e2e.js
// Drives the real React UI: types a prompt in the Studio, waits for the verified state,
// and checks the playable game iframe. Requires server + client running.
//   UI_URL=http://localhost:5188 node scripts/ui-e2e.js "a snake game"

import { chromium } from 'playwright';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UI = process.env.UI_URL || 'http://localhost:5188';
const prompt = process.argv.slice(2).join(' ') || 'a snake game where you eat apples to grow and die if you hit yourself';
const OUT = path.join(__dirname, '..', 'screenshots', 'ui-e2e');
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const pageErrors = [];
page.on('pageerror', e => pageErrors.push(e.message));

await page.goto(UI, { waitUntil: 'networkidle' });
await page.screenshot({ path: path.join(OUT, '1-studio.png') });

await page.fill('.prompt-textarea', prompt);
await page.locator('form.prompt-form button[type="submit"]').first().click();
console.log(`submitted: "${prompt}"`);

await page.waitForSelector('.pipeline-ui', { timeout: 20000 });
await page.waitForTimeout(15000);
await page.screenshot({ path: path.join(OUT, '2-running.png') });

const outcome = await Promise.race([
  page.waitForSelector('.verified-wrap', { timeout: 900000 }).then(() => 'verified'),
  page.waitForSelector('.pipeline-error', { timeout: 900000 }).then(() => 'failed'),
]);
await page.waitForTimeout(2500);
await page.screenshot({ path: path.join(OUT, '3-result.png'), fullPage: true });
console.log('outcome:', outcome);

let gameOk = false;
const frame = page.frames().find(f => /\/games\/.+\.html/.test(f.url()));
if (frame) {
  const st = await frame.evaluate(() => ({
    hasCanvas: !!document.querySelector('canvas'),
    status: window.__gameState?.status,
    player: window.__gameState?.player,
  })).catch(e => ({ error: e.message }));
  console.log('game iframe:', frame.url(), JSON.stringify(st));
  gameOk = st.hasCanvas && !!st.player;
}
if (pageErrors.length) console.log('UI page errors:', pageErrors);

await browser.close();
const ok = outcome === 'verified' && gameOk && pageErrors.length === 0;
console.log(ok ? '✔ UI end-to-end OK' : '✘ UI end-to-end FAILED', `(screenshots in ${OUT})`);
process.exit(ok ? 0 : 1);
