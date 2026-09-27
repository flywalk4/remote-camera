'use strict';

// Regenerates the README screenshots of the web remote (docs/images/*.png)
// using the mock iPhone:  npm run screenshots

const { spawn } = require('child_process');
const path = require('path');
const { chromium } = require('@playwright/test');

const PORT = 8091;
const BASE = `http://localhost:${PORT}`;
const OUT = path.join(__dirname, '..', '..', 'docs', 'images');

async function post(p, body) {
  await fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

async function waitForServer() {
  for (let i = 0; i < 50; i++) {
    try {
      await fetch(`${BASE}/api/state`);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error('mock server did not start');
}

(async () => {
  const server = spawn(process.execPath, [path.join(__dirname, 'mock-server.js')], { env: { ...process.env, PORT: String(PORT) } });
  try {
    await waitForServer();
    // A realistic Moon session: telephoto, manual exposure and focus, a finished series.
    await post('/__reset', {
      lens: 'tele', exposureMode: 'manual', iso: 50, shutter: 1 / 500,
      focusMode: 'manual', lensPosition: 0.874, wbMode: 'manual', temperature: 4800, tint: 0,
      exposureOffset: -0.7, battery: 0.76, zoom: 1.6,
    });
    await post('/api/capture', { format: 'raw', count: 6, interval: 0.1, delay: 0 });
    await new Promise((r) => setTimeout(r, 1500));

    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.addInitScript(() => localStorage.setItem('format', 'raw'));
    await page.goto(BASE);
    await page.waitForFunction(() => document.getElementById('preview').naturalWidth > 0);
    await page.fill('#count', '50');
    await page.fill('#interval', '0.5');
    await page.locator('#grid').check();
    await page.waitForTimeout(1200);
    await page.locator('.panel').evaluate((el) => (el.scrollTop = 0));
    await page.screenshot({ path: path.join(OUT, 'remote.png') });

    await page.locator('#grid').uncheck();
    await page.locator('#night').check();
    await page.locator('.panel').evaluate((el) => (el.scrollTop = 0));
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(OUT, 'remote-night.png') });

    await browser.close();
    console.log(`Screenshots saved to ${OUT}`);
  } finally {
    server.kill();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
