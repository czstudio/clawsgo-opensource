import { chromium } from 'playwright';
import fs from 'node:fs';

const TARGET = 'https://app.clawsgo.cn';
const PROXY = 'http://localhost:9999';
const OUTDIR = '/Users/cz/code/clawsgo-open/work/capture';

fs.mkdirSync(OUTDIR, { recursive: true });

const requests = [];
const wsMessages = [];

async function waitForEnter(prompt) {
  console.log(prompt);
  process.stdin.setRawMode(true);
  return new Promise(resolve => {
    process.stdin.once('data', () => {
      process.stdin.setRawMode(false);
      resolve();
    });
  });
}

function recordRequest(request, response, body) {
  const entry = {
    time: new Date().toISOString(),
    method: request.method(),
    url: request.url(),
    headers: request.headers(),
    postData: request.postData(),
    status: response?.status(),
    responseHeaders: response?.headers(),
    responseBody: body?.slice(0, 50000),
  };
  requests.push(entry);
  console.log(`[${entry.method}] ${entry.url.split('?')[0]} -> ${entry.status}`);
}

async function capturePage(page, name) {
  await page.screenshot({ path: `${OUTDIR}/${name}.png`, fullPage: true });
  const html = await page.content();
  fs.writeFileSync(`${OUTDIR}/${name}.html`, html);
}

async function clickAllButtons(page, context) {
  const buttons = await page.locator('button, [role="button"], a[href^="/"], nav a, .nav-item, [data-testid], .menu-item, .tab').all();
  console.log(`Found ${buttons.length} clickable elements on ${context}`);
  for (let i = 0; i < buttons.length; i++) {
    const btn = buttons[i];
    try {
      const text = await btn.textContent().catch(() => '');
      const visible = await btn.isVisible().catch(() => false);
      if (!visible || !text.trim()) continue;
      console.log(`  [${context}] Clicking: ${text.trim().slice(0, 40)}`);
      await btn.click({ timeout: 3000, force: true }).catch(() => {});
      await page.waitForTimeout(800);
      const dialogs = await page.locator('dialog, [role="dialog"], .modal, .overlay').count().catch(() => 0);
      if (dialogs > 0) {
        await capturePage(page, `${context}-dialog-${i}`);
        // Try to close dialog by clicking outside or pressing Escape
        await page.keyboard.press('Escape').catch(() => {});
        await page.waitForTimeout(300);
      }
    } catch (e) {
      // ignore
    }
  }
}

async function exploreSection(page, name, navSelector) {
  console.log(`\n=== Exploring section: ${name} ===`);
  try {
    const nav = page.locator(navSelector).first();
    if (await nav.isVisible().catch(() => false)) {
      await nav.click({ timeout: 5000 });
      await page.waitForTimeout(1500);
      await capturePage(page, `section-${name}`);
      await clickAllButtons(page, name);
    }
  } catch (e) {
    console.log(`  Section ${name} not found or error:`, e.message);
  }
}

// Main
(async () => {
  console.log('Starting Playwright capture...');

  const browser = await chromium.launch({
    headless: false,
    args: ['--disable-blink-features=AutomationControlled'],
  });

  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    recordHar: { path: `${OUTDIR}/capture.har` },
  });

  const page = await context.newPage();

  // Capture all requests
  page.on('request', async request => {
    const response = await request.response().catch(() => null);
    let body = null;
    if (response) {
      try { body = await response.text(); } catch {}
    }
    if (request.url().includes('clawsgo')) {
      recordRequest(request, response, body);
    }
  });

  // Capture WebSocket traffic
  page.on('websocket', ws => {
    console.log(`[WebSocket] ${ws.url()}`);
    ws.on('framesent', data => wsMessages.push({ dir: 'sent', url: ws.url(), data, time: new Date().toISOString() }));
    ws.on('framereceived', data => wsMessages.push({ dir: 'received', url: ws.url(), data, time: new Date().toISOString() }));
  });

  // Navigate to login
  console.log(`Navigating to ${TARGET}/login ...`);
  await page.goto(`${TARGET}/login`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await capturePage(page, 'login');

  // Wait for user to login manually
  await waitForEnter(
    '\n>>> PLEASE LOGIN MANUALLY in the browser window, then PRESS ANY KEY here to continue <<<\n'
  );

  // Give time for post-login redirect
  await page.waitForTimeout(3000);
  await capturePage(page, 'after-login');

  // Save auth state
  const storage = await context.storageState();
  fs.writeFileSync(`${OUTDIR}/storage-state.json`, JSON.stringify(storage, null, 2));
  console.log('Storage state saved.');

  // Try to find and click main navigation items
  const navSelectors = [
    'nav a[href*="/chat"]',
    'nav a[href*="/projects"]',
    'nav a[href*="/agents"]',
    'nav a[href*="/images"]',
    'nav a[href*="/hosts"]',
    'nav a[href*="/cards"]',
    'nav a[href*="/settings"]',
    'nav a[href*="/billing"]',
    'nav a[href*="/team"]',
    'nav a[href*="/help"]',
    'nav a[href*="/profile"]',
  ];

  for (const sel of navSelectors) {
    const text = sel.match(/href\*="\/([^"]*)"/)?.[1] || sel;
    await exploreSection(page, text, sel);
    // Go back to main page after each section
    await page.goto(`${TARGET}/chat`, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await page.waitForTimeout(1000);
  }

  // Explore chat-specific features
  console.log('\n=== Exploring chat features ===');
  await page.goto(`${TARGET}/chat`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);
  await clickAllButtons(page, 'chat');

  // Try to find message input and send a test message
  const input = page.locator('textarea, [contenteditable="true"], input[placeholder*="message" i]').first();
  if (await input.isVisible().catch(() => false)) {
    await input.fill('Hello test message');
    const sendBtn = page.locator('button[type="submit"], button:has-text("Send"), button[aria-label*="send" i]').first();
    if (await sendBtn.isVisible().catch(() => false)) {
      await sendBtn.click();
      await page.waitForTimeout(5000);
      await capturePage(page, 'chat-after-send');
    }
  }

  // Save all captured data
  fs.writeFileSync(`${OUTDIR}/requests.jsonl`, requests.map(r => JSON.stringify(r)).join('\n'));
  fs.writeFileSync(`${OUTDIR}/websocket.jsonl`, wsMessages.map(r => JSON.stringify(r)).join('\n'));

  console.log(`\n=== Capture complete ===`);
  console.log(`Requests: ${requests.length}`);
  console.log(`WS messages: ${wsMessages.length}`);
  console.log(`Output: ${OUTDIR}`);

  await context.close();
  await browser.close();
  process.exit(0);
})();
