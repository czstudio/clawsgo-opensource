import { chromium } from 'playwright';
import fs from 'node:fs';
import { spawn } from 'node:child_process';

const TARGET = 'http://localhost:5181';
const API = 'http://localhost:5181';
const OUTDIR = '/Users/cz/code/clawsgo-open/work/capture-local';

fs.mkdirSync(OUTDIR, { recursive: true });

const requests = [];
const wsMessages = [];

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
}

async function capturePage(page, name) {
  await page.screenshot({ path: `${OUTDIR}/${name}.png`, fullPage: true });
}

async function startServer() {
  console.log('Starting local server...');
  return new Promise((resolve, reject) => {
    const proc = spawn('node', ['server/serve.mjs'], {
      cwd: '/Users/cz/code/clawsgo-open',
      env: { ...process.env, NODE_OPTIONS: '' },
      stdio: 'pipe',
    });
    proc.stdout.on('data', d => {
      const line = d.toString();
      if (line.includes('localhost:5181')) {
        console.log('Server ready');
        resolve(proc);
      }
    });
    proc.stderr.on('data', d => {
      // ignore
    });
    setTimeout(() => reject(new Error('Server start timeout')), 15000);
  });
}

async function apiLogin() {
  console.log('API login...');
  const sendRes = await fetch(`${API}/api/auth/phone-number/send-otp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phoneNumber: '+8613800000000' }),
  });
  const sendData = await sendRes.json();
  console.log('send-otp:', sendData);

  const verifyRes = await fetch(`${API}/api/auth/phone-number/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phoneNumber: '+8613800000000', code: '123456' }),
  });
  const verifyData = await verifyRes.json();
  const token = verifyRes.headers.get('set-auth-token');
  console.log('verify:', verifyData.user?.name, 'token:', token?.slice(0, 20));
  return token;
}

async function clickAllInPage(page, context) {
  const clickable = await page.locator('button, [role="button"], a[href^="/"], nav a, .nav-item, [data-testid], .menu-item, .tab, .sidebar a, .item').all();
  console.log(`[${context}] Found ${clickable.length} clickable elements`);
  for (let i = 0; i < Math.min(clickable.length, 40); i++) {
    const el = clickable[i];
    try {
      const text = await el.textContent().catch(() => '');
      if (!text.trim()) continue;
      const visible = await el.isVisible().catch(() => false);
      if (!visible) continue;
      console.log(`  [${context}] Clicking: ${text.trim().slice(0, 40)}`);
      await el.click({ timeout: 2000, force: true }).catch(() => {});
      await page.waitForTimeout(600);
    } catch {}
  }
}

async function exploreNav(page, name, urlPath) {
  console.log(`\n=== Exploring: ${name} ===`);
  try {
    await page.goto(`${TARGET}${urlPath}`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2000);
    await capturePage(page, `nav-${name}`);
    await clickAllInPage(page, name);
  } catch (e) {
    console.log(`  Error in ${name}:`, e.message);
  }
}

(async () => {
  console.log('Starting local capture...');

  const server = await startServer();
  await new Promise(r => setTimeout(r, 2000));

  const token = await apiLogin();
  if (!token) {
    console.error('Login failed, no token');
    server.kill();
    process.exit(1);
  }

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    recordHar: { path: `${OUTDIR}/capture.har` },
  });
  const page = await context.newPage();

  page.on('request', async request => {
    const response = await request.response().catch(() => null);
    let body = null;
    if (response) try { body = await response.text(); } catch {}
    recordRequest(request, response, body);
  });

  page.on('websocket', ws => {
    ws.on('framesent', data => wsMessages.push({ dir: 'sent', url: ws.url(), data, time: new Date().toISOString() }));
    ws.on('framereceived', data => wsMessages.push({ dir: 'received', url: ws.url(), data, time: new Date().toISOString() }));
  });

  // Intercept API calls to inject auth token
  await page.route(`${TARGET}/api/**`, async route => {
    const request = route.request();
    const headers = { ...request.headers(), 'Authorization': `Bearer ${token}` };
    await route.continue({ headers });
  });

  // Inject token into localStorage/sessionStorage and navigate
  await page.goto(`${TARGET}/login`, { waitUntil: 'domcontentloaded' });
  
  const keys = await page.evaluate(() => Object.keys(localStorage));
  console.log('Current localStorage keys:', keys);
  
  await page.evaluate((t) => {
    localStorage.setItem('auth-token', t);
    sessionStorage.setItem('auth-token', t);
    localStorage.setItem('token', t);
    localStorage.setItem('clawsgo_token', t);
    localStorage.setItem('clawsgo-auth-token', t);
  }, token);
  
  await page.goto(`${TARGET}/chat`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);
  await capturePage(page, 'after-login');
  console.log('After login URL:', page.url());
  
  const keysAfter = await page.evaluate(() => Object.keys(localStorage));
  console.log('After navigation localStorage keys:', keysAfter);

  const sections = [
    ['chat', '/chat'],
    ['projects', '/projects'],
    ['agents', '/agents'],
    ['images', '/images'],
    ['hosts', '/hosts'],
    ['cards', '/cards'],
    ['settings', '/settings'],
    ['billing', '/billing'],
    ['team', '/team'],
    ['help', '/help'],
    ['profile', '/profile'],
  ];

  for (const [name, path] of sections) {
    await exploreNav(page, name, path);
  }

  // Try admin
  console.log('\n=== Trying admin ===');
  await page.goto(`${TARGET}/admin`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);
  await capturePage(page, 'admin');
  await clickAllInPage(page, 'admin');

  fs.writeFileSync(`${OUTDIR}/requests.jsonl`, requests.map(r => JSON.stringify(r)).join('\n'));
  fs.writeFileSync(`${OUTDIR}/websocket.jsonl`, wsMessages.map(r => JSON.stringify(r)).join('\n'));

  console.log(`\n=== Capture complete ===`);
  console.log(`Requests: ${requests.length}`);
  console.log(`WS messages: ${wsMessages.length}`);
  console.log(`Output: ${OUTDIR}`);

  await context.close();
  await browser.close();
  server.kill();
})();
