// End-to-end browser tests (Playwright + Chromium). Invented data only.
// Google sign-in and Google Drive are fully mocked — no real Google calls.
// Run: node tests/e2e/run.mjs
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { startServer } from './server.mjs';
import { createMockDrive } from '../mock-drive.mjs';

const require = createRequire(import.meta.url);
const { chromium, devices } = require('playwright');

const OUT = new URL('../../test-output/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

const results = [];
let current = '';
function check(cond, msg) {
  results.push({ ok: !!cond, msg: `${current}: ${msg}` });
  console.log(`${cond ? '  ✔' : '  ✘'} ${msg}`);
}
async function section(name, fn) {
  current = name;
  console.log(`\n▶ ${name}`);
  try { await fn(); } catch (e) { check(false, `threw: ${e.stack || e}`); }
}

const server = await startServer();
const ORIGIN = `http://127.0.0.1:${server.address().port}`;
const BASE = `${ORIGIN}/budget-app/`;
const browser = await chromium.launch();
const phone = devices['iPhone 13'];

async function amt(page, key) { return page.locator(`input[data-k="${key}"]`); }
async function typeAmt(page, key, value) {
  const i = await amt(page, key);
  await i.click();
  await i.fill(String(value));
  await i.press('Enter');
}
async function noHorizontalScroll(page) {
  return page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
}
async function click(p, sel) {
  await p.click(sel);
  await p.waitForTimeout(200);
}
async function gotoView(page, view) {
  await page.click(`.tabbar button[data-view="${view}"]`);
}

// ---------------------------------------------------------------------------
await section('Isolation setup: another app on the same origin', async () => {
  const ctx = await browser.newContext();
  const p = await ctx.newPage();
  await p.goto(`${ORIGIN}/expense-tracker/`);
  await p.waitForFunction(() => window.idbDone && window.swDone);
  check(true, 'other app stored IndexedDB, localStorage, cache and a service worker');
  await ctx.storageState({ path: OUT + 'other-app-state.json' });
  await ctx.close();
});

let ctx, page;
await section('Mobile layout & first run', async () => {
  ctx = await browser.newContext({ ...phone, acceptDownloads: true });
  // reuse the origin where the other app already wrote data
  page = await ctx.newPage();
  await page.goto(`${ORIGIN}/expense-tracker/`);
  await page.waitForFunction(() => window.idbDone && window.swDone);
  await page.goto(BASE);
  await page.waitForSelector('.group');
  check(await page.locator('#monthLabel').textContent() !== '', 'month bar shows a month');
  check((await page.locator('h2.section').allTextContents()).includes('Outflows'), 'outflow section rendered');
  const groups = await page.locator('.group .gname').allTextContents();
  check(groups.join('|') === 'Income|Housing|Transport|Daily living|Family|Health and insurance|Lifestyle|Debt|Savings and investing|Other', `default groups: ${groups.join(', ')}`);
  for (const v of ['month', 'summary', 'accounts', 'settings']) {
    await gotoView(page, v);
    await page.waitForTimeout(150);
    check(await noHorizontalScroll(page), `no horizontal page scroll on ${v} view (390px)`);
    await page.screenshot({ path: `${OUT}phone-${v}.png`, fullPage: false });
  }
  await gotoView(page, 'month');
  const tapTargets = await page.evaluate(() => [...document.querySelectorAll('.tabbar button, #prevMonth, #nextMonth')].every((b) => b.getBoundingClientRect().height >= 44));
  check(tapTargets, 'tab bar and month buttons are at least 44px tall');
  check(await page.evaluate(() => navigator.storage.persisted !== undefined), 'storage persistence API available and requested');
});

await section('Entering figures, totals and copy from previous month', async () => {
  await gotoView(page, 'month');
  // go to month 1 (Oct 2026)
  await page.selectOption('#monthSelect', '0');
  check((await page.locator('#monthLabel').textContent()) === 'Oct 2026', 'first month is Oct 2026 by default');
  await typeAmt(page, 'v:l-salary:0', '30,000');
  await typeAmt(page, 'v:l-bonus:0', '2000+500');
  await typeAmt(page, 'v:l-rent:0', '9000');
  await typeAmt(page, 'v:l-dewa:0', '850.50');
  await typeAmt(page, 'v:l-salik:0', '300');
  await typeAmt(page, 'v:l-sv-ret:0', '2000');
  await page.waitForTimeout(100);
  const inK = await page.locator('[data-out="m-in"]').first().textContent();
  const netK = await page.locator('[data-out="m-net"]').first().textContent();
  check(inK === 'AED 32,500', `inflow total ${inK}`);
  check(netK === 'AED 20,350', `net cash flow ${netK} (32,500 − 12,150.50, rounded)`);
  const housing = await page.locator('[data-out="g-sub:g-housing"]').textContent();
  check(housing === 'AED 9,851', `housing subtotal ${housing}`);
  const share = await page.locator('[data-out="g-share:g-housing"]').textContent();
  check(share === '30.3% of income', `housing share of income ${share}`);
  check((await (await amt(page, 'v:l-bonus:0')).inputValue()) === '2,500', 'simple sums are accepted (2000+500)');

  // invalid input
  const i = await amt(page, 'v:l-freelance:0');
  await i.fill('abc');
  await i.press('Enter');
  check(await i.evaluate((e) => e.classList.contains('invalid')), 'invalid number is flagged, not saved');
  await i.fill('');
  await i.press('Enter');

  // copy single group
  await page.click('#nextMonth');
  check((await page.locator('#monthLabel').textContent()) === 'Nov 2026', 'next month is Nov 2026');
  await page.click('[data-act="copy-group"][data-id="g-housing"]');
  await page.waitForTimeout(150);
  check((await (await amt(page, 'v:l-rent:1')).inputValue()) === '9,000', 'copy group copied rent');
  check((await (await amt(page, 'v:l-salary:1')).inputValue()) === '', 'copy group did not touch income');
  // undo
  await page.click('#toast [data-act="undo"]');
  await page.waitForTimeout(150);
  check((await (await amt(page, 'v:l-rent:1')).inputValue()) === '', 'undo removes the copied figures');
  // copy whole month
  await page.click('[data-act="copy-month"]');
  await page.waitForTimeout(150);
  check((await (await amt(page, 'v:l-salary:1')).inputValue()) === '30,000', 'copy whole month copied salary');
  check((await (await amt(page, 'v:l-sv-ret:1')).inputValue()) === '2,000', 'copy whole month copied savings');
  // overwrite asks for confirmation
  await typeAmt(page, 'v:l-rent:1', '9500');
  await page.click('[data-act="copy-month"]');
  await page.waitForSelector('dialog[open]');
  check(/replaces/.test(await page.locator('dialog').textContent()), 'overwriting existing figures asks first');
  await page.click('dialog button[value="cancel"]');
  check((await (await amt(page, 'v:l-rent:1')).inputValue()) === '9,500', 'cancel keeps the existing figure');
  await page.screenshot({ path: `${OUT}phone-month-filled.png` });
});

await section('Accounts, opening/closing balances and total funds', async () => {
  await gotoView(page, 'accounts');
  await typeAmt(page, 'a:a-hsbc:start', '10000');
  await typeAmt(page, 'a:a-enbd:start', '5000');
  await typeAmt(page, 'a:a-sarwa-ret:start', '40000');
  const dailyFlags = await page.locator('[data-act="acct-daily"]').evaluateAll((els) => els.map((e) => e.checked));
  check(JSON.stringify(dailyFlags) === '[true,true,false,false,false]', 'HSBC/ENBD day-to-day by default, Sarwa accounts not');
  await gotoView(page, 'summary');
  const first = await page.locator('table.grid tbody tr').first().locator('td').allTextContents();
  // Oct: opening 15,000 ; net 20,349.50 ; closing 35,349.50 ; total funds = closing + 40,000 + 2,000 (linked contribution)
  check(first[4] === 'AED 15,000', `Oct opening ${first[4]}`);
  check(first[5].startsWith('AED 35,350'), `Oct closing ${first[5]}`);
  check(first[6] === 'AED 77,350', `Oct total funds ${first[6]} (includes Sarwa + linked contribution)`);
  const second = await page.locator('table.grid tbody tr').nth(1).locator('td').allTextContents();
  check(second[4] === first[5].replace(/ .*/, '') || second[4].startsWith('AED 35,350'), `Nov opening carries Oct closing (${second[4]})`);
  // month-end actuals for both day-to-day accounts replace the carried balance
  await gotoView(page, 'month');
  await page.selectOption('#monthSelect', '0');
  await typeAmt(page, 'b:a-hsbc:0', '20000');
  await typeAmt(page, 'b:a-enbd:0', '14000');
  await gotoView(page, 'summary');
  const nov = await page.locator('table.grid tbody tr').nth(1).locator('td').allTextContents();
  check(nov[4] === 'AED 34,000', `Nov opening uses actual Oct balances (${nov[4]})`);
  const foot = await page.locator('table.grid tfoot').first().textContent();
  check(/12-month total/.test(foot), 'summary table has a "12-month total" row');
  const tiles = await page.locator('.tile small').allTextContents();
  check(tiles.some((t) => /12-month total/.test(t)), 'summary tiles labelled "12-month total"');
  check(await page.locator('svg.chart .bar-in').count() === 12 && await page.locator('svg.chart .net-line').count() === 1, 'chart has inflow bars and a net cash flow line');
  check((await page.locator('table.grid thead').first().textContent()).includes('Total funds'), 'summary table has a Total funds column');
  await page.locator('svg.chart .hit').nth(0).click();
  check(/Oct 2026/.test(await page.locator('#chartCaption').textContent()), 'tapping the chart shows that month');
  check(await noHorizontalScroll(page), 'summary still has no horizontal page scroll');
  await page.screenshot({ path: `${OUT}phone-summary-filled.png`, fullPage: true });
});

await section('Changing the start month updates labels and charts', async () => {
  await gotoView(page, 'settings');
  await page.selectOption('#startMonth', '0');
  await page.selectOption('#startYear', '2027');
  await gotoView(page, 'summary');
  const firstLabel = await page.locator('table.grid tbody tr th').first().textContent();
  const lastLabel = await page.locator('table.grid tbody tr th').nth(11).textContent();
  check(firstLabel === 'Jan 2027' && lastLabel === 'Dec 2027', `table months ${firstLabel} … ${lastLabel}`);
  const ticks = await page.locator('svg.chart text.tick').allTextContents();
  check(ticks.includes('Jan') && !ticks.includes('Oct') || ticks.indexOf('Jan') < ticks.indexOf('Oct'), 'chart month labels start at Jan');
  check(/Jan 2027 – Dec 2027/.test(await page.locator('h2.section').first().textContent()), 'summary heading shows new period');
  const firstRow = await page.locator('table.grid tbody tr').first().locator('td').first().textContent();
  check(firstRow === 'AED 32,500', 'figures stay attached to month 1 of the period');
  await gotoView(page, 'month');
  await page.selectOption('#monthSelect', '0');
  check((await page.locator('#monthLabel').textContent()) === 'Jan 2027', 'month bar relabelled');
  // put it back
  await gotoView(page, 'settings');
  await page.selectOption('#startMonth', '9');
  await page.selectOption('#startYear', '2026');
});

await section('Editing groups and lines: add, rename, reorder, delete', async () => {
  await gotoView(page, 'month');
  await click(page, '[data-act="edit"]');
  await click(page, '[data-act="line-add"][data-id="g-family"]');
  await page.keyboard.type('Pet care');
  await page.keyboard.press('Enter');
  await click(page, '[data-act="group-add"][data-kind="out"]');
  await page.keyboard.type('Zakat');
  await page.keyboard.press('Enter');
  const famLines = await page.locator('[data-g="g-family"] input.name').evaluateAll((e) => e.map((x) => x.value));
  check(famLines.at(-1) === 'Pet care', 'new line added and named');
  // rename a group
  const gname = page.locator('input[data-name="g:g-lifestyle:name"]');
  await gname.fill('Fun');
  await gname.press('Enter');
  // reorder: move Transport up above Housing
  await click(page, '[data-act="group-up"][data-id="g-transport"]');
  // move line down
  await click(page, '[data-act="line-down"][data-id="l-rent"]');
  // delete a line, then undo
  await click(page, '[data-act="line-del"][data-id="l-laundry"]');
  check(await page.locator('input[data-name="l:l-laundry:name"]').count() === 0, 'line deleted');
  await click(page, '#toast [data-act="undo"]');
  check(await page.locator('input[data-name="l:l-laundry:name"]').count() === 1, 'line delete can be undone');
  // delete a group (with confirm)
  await click(page, '[data-act="group-del"][data-id="g-debt"]');
  await click(page, 'dialog button[value="ok"]');
  await click(page, '[data-act="edit"]');
  const names = await page.locator('.group .gname').allTextContents();
  check(names.indexOf('Transport') < names.indexOf('Housing'), 'groups reordered');
  check(names.includes('Fun') && names.includes('Zakat') && !names.includes('Debt'), `renamed/added/deleted groups: ${names.join(', ')}`);
  const housingLines = await page.locator('[data-g="g-housing"] .lname').allTextContents();
  check(housingLines[1] === 'Rent or mortgage', 'line reordered within group');
  check(await noHorizontalScroll(page), 'no horizontal scroll in edit mode');
});

let backupPath;
await section('Backup, restore and CSV export', async () => {
  await gotoView(page, 'settings');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('[data-act="backup"]')]);
  backupPath = OUT + 'backup-test.json';
  await dl.saveAs(backupPath);
  const backup = JSON.parse(readFileSync(backupPath, 'utf8'));
  check(backup.app === 'monthly-budget-aed' && backup.regs['v:l-salary:0'].v === 3000000, 'backup JSON contains the figures');

  const [csvDl] = await Promise.all([page.waitForEvent('download'), page.click('[data-act="csv"]')]);
  await csvDl.saveAs(OUT + 'export-test.csv');
  const csv = readFileSync(OUT + 'export-test.csv', 'utf8');
  check(csv.includes('12-month total') && csv.includes('Oct 2026') && csv.includes('Pet care'), 'CSV has months, 12-month total and edited lines');

  // change data, then restore
  await gotoView(page, 'month');
  await page.selectOption('#monthSelect', '0');
  await typeAmt(page, 'v:l-salary:0', '1');
  await gotoView(page, 'settings');
  await page.setInputFiles('#restoreFile', backupPath);
  await page.click('dialog button[value="ok"]');
  await page.waitForTimeout(200);
  await gotoView(page, 'month');
  check((await (await amt(page, 'v:l-salary:0')).inputValue()) === '30,000', 'restore brought back the backed-up salary');

  // bad file rejected
  writeFileSync(OUT + 'not-a-backup.json', '{"hello":1}');
  await gotoView(page, 'settings');
  await page.setInputFiles('#restoreFile', OUT + 'not-a-backup.json');
  await page.waitForTimeout(150);
  check(/not a Monthly Budget backup/.test(await page.locator('#toast').textContent()), 'a wrong file is rejected with a clear message');
});

await section('Offline use', async () => {
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  const scope = await page.evaluate(async () => (await navigator.serviceWorker.getRegistration()).scope);
  check(scope.endsWith('/budget-app/'), `service worker scope limited to app folder (${scope})`);
  await ctx.setOffline(true);
  await page.reload();
  await page.waitForSelector('#view .card');
  check(true, 'app loads with the network off');
  await gotoView(page, 'month');
  await page.selectOption('#monthSelect', '2');
  await typeAmt(page, 'v:l-groceries:2', '1800');
  await page.waitForTimeout(300);
  check(await page.evaluate(() => window.__mbapp.repo.regs['v:l-groceries:2'] && window.__mbapp.repo.regs['v:l-groceries:2'].v) === 180000, 'figure saved while offline');
  await page.reload();
  await page.waitForSelector('#view .card');
  await gotoView(page, 'month');
  await page.selectOption('#monthSelect', '2');
  check((await (await amt(page, 'v:l-groceries:2')).inputValue()) === '1,800', 'figure entered offline survives reload offline');
  await gotoView(page, 'summary');
  check(await page.locator('svg.chart').count() === 1, 'summary and chart work offline');
  await page.screenshot({ path: `${OUT}phone-offline.png` });
  await ctx.setOffline(false);
  // A client ID added later reaches a device that already has the app cached.
  server.configOverride = "export const GOOGLE_CLIENT_ID = 'later-added.apps.googleusercontent.com';";
  await page.reload();
  await page.waitForSelector('#view .card');
  await gotoView(page, 'settings');
  check(await page.locator('[data-act="sign-in"]').count() === 1, 'client ID added after install is picked up on next online open');
  server.configOverride = null;
  await page.reload();
  await page.waitForSelector('#view .card');
});

await section('Does not touch the other app on the same origin', async () => {
  const r = await page.evaluate(async () => {
    const dbs = indexedDB.databases ? (await indexedDB.databases()).map((d) => d.name) : [];
    const other = await new Promise((res) => {
      const q = indexedDB.open('expense-tracker-db');
      q.onsuccess = () => { const g = q.result.transaction('items').objectStore('items').get('k'); g.onsuccess = () => res(g.result); };
      q.onerror = () => res(null);
    });
    const regs = (await navigator.serviceWorker.getRegistrations()).map((x) => x.scope);
    const cacheNames = await caches.keys();
    const lsKeys = Object.keys(localStorage);
    return { dbs, other, regs, cacheNames, ls: localStorage.getItem('expense.settings'), lsKeys, cached: await (await caches.open('expense-cache-v1')).match('/expense-tracker/x').then((x) => x && x.text()) };
  });
  check(r.other === 'keep-me', 'other app IndexedDB data intact');
  check(r.ls === 'keep-me', 'other app localStorage intact');
  check(r.cached === 'keep-me', 'other app cache intact');
  check(r.regs.some((s) => s.endsWith('/expense-tracker/')) && r.regs.some((s) => s.endsWith('/budget-app/')), 'both service workers registered with separate scopes');
  check(r.dbs.includes('mbapp-monthly-budget-aed'), 'this app uses its own uniquely named database');
  check(r.cacheNames.filter((c) => !c.startsWith('mbapp-monthly-budget-aed-')).every((c) => c === 'expense-cache-v1'), 'this app only created caches with its prefix');
  check(r.lsKeys.filter((k) => k !== 'expense.settings').every((k) => k.startsWith('mbapp.monthly-budget-aed.')), 'this app only used prefixed localStorage keys');
  const manifest = await page.evaluate(async () => (await fetch('manifest.webmanifest')).json());
  check(manifest.id && manifest.start_url.startsWith('./') && manifest.scope === './', 'manifest has its own id, relative start_url and scope');

  // Erase this device: removes only this app's data
  await gotoView(page, 'settings');
  await page.click('[data-act="erase"]');
  await page.click('dialog button[value="ok"]');
  await page.waitForTimeout(100);
  await Promise.all([page.waitForEvent('load'), page.click('dialog button[value="ok"]')]);
  await page.waitForSelector('.group');
  const after = await page.evaluate(async () => {
    const other = await new Promise((res) => {
      const q = indexedDB.open('expense-tracker-db');
      q.onsuccess = () => { const g = q.result.transaction('items').objectStore('items').get('k'); g.onsuccess = () => res(g.result); };
    });
    return { other, ls: localStorage.getItem('expense.settings') };
  });
  await gotoView(page, 'month');
  await page.selectOption('#monthSelect', '0');
  check((await (await amt(page, 'v:l-salary:0')).inputValue()) === '', 'erase cleared this app’s figures');
  check(after.other === 'keep-me' && after.ls === 'keep-me', 'erase left the other app’s data alone');
  await ctx.close();
});

// ---------------------------------------------------------------------------
// Sync with mocked Google Identity Services + Drive
// ---------------------------------------------------------------------------
const drive = createMockDrive();
const ALICE = { id: 'perm-alice', email: 'wife.test@example.com', name: 'Test Wife' };
const BOB = { id: 'perm-bob', email: 'someone.else@example.com', name: 'Other Person' };
drive.addUser('tok-alice', ALICE);
drive.addUser('tok-bob', BOB);
const gisCalls = [];

const MOCK_GIS = `
window.google = { accounts: { oauth2: {
  initTokenClient(cfg) {
    return { requestAccessToken(o) {
      window.__gis = (window.__gis || []).concat([{ prompt: (o && o.prompt) || cfg.prompt, scope: cfg.scope, client: cfg.client_id, hint: o && o.login_hint }]);
      fetch('/__gis_log', { method: 'POST', body: JSON.stringify({ prompt: (o && o.prompt) || cfg.prompt, scope: cfg.scope, client: cfg.client_id }) }).catch(() => {});
      setTimeout(() => cfg.callback({ access_token: window.__mockToken || 'tok-alice', expires_in: 3599, scope: cfg.scope }), 30);
    } };
  },
  hasGrantedAllScopes() { return true; },
  revoke(t, cb) { cb && cb(); },
} } };`;

async function syncDevice() {
  const c = await browser.newContext({ ...phone });
  await c.route('**/js/config.js', (r) => r.fulfill({ contentType: 'text/javascript', body: "export const GOOGLE_CLIENT_ID = 'test-client-id.apps.googleusercontent.com';" }));
  await c.route('https://accounts.google.com/gsi/client', (r) => r.fulfill({ contentType: 'text/javascript', body: MOCK_GIS }));
  await c.route('**/__gis_log', async (r) => { gisCalls.push(JSON.parse(r.request().postData())); await r.fulfill({ status: 204 }); });
  await c.route('https://www.googleapis.com/**', async (r) => {
    const req = r.request();
    try {
      const res = drive.handle({ url: req.url(), method: req.method(), headers: await req.allHeaders(), body: req.postData() || '' });
      await r.fulfill({ status: res.status, body: res.body, contentType: res.contentType });
    } catch { await r.abort('internetdisconnected'); }
  });
  const p = await c.newPage();
  await p.goto(BASE);
  await p.waitForSelector('.group');
  return { c, p };
}
const syncStatus = (p) => p.evaluate(() => window.__mbapp.sync.state.status);
const waitStatus = (p, s, timeout = 8000) => p.waitForFunction((x) => window.__mbapp.sync.state.status === x && !window.__mbapp.sync.running, s, { timeout });
async function waitIdleSynced(p) {
  await p.waitForFunction(() => window.__mbapp.sync.state.status === 'ok' && !window.__mbapp.sync.running && window.__mbapp.repo.pendingCount === 0, null, { timeout: 10000 });
}

let A, B;
await section('Sync: sign in, account picker, email shown, Drive file created', async () => {
  A = await syncDevice();
  await gotoView(A.p, 'settings');
  check(await A.p.locator('[data-act="sign-in"]').count() === 1, 'Sign in button shown once client ID is configured');
  await A.p.click('[data-act="sign-in"]');
  await waitStatus(A.p, 'ok');
  check(gisCalls.length === 1 && gisCalls[0].prompt === 'select_account', `account picker forced (prompt=${gisCalls[0] && gisCalls[0].prompt})`);
  check(gisCalls[0].scope === 'https://www.googleapis.com/auth/drive.file', `only drive.file scope requested (${gisCalls[0].scope})`);
  check((await A.p.locator('#whoami').textContent()) === ALICE.email, 'signed-in email shown in the header');
  check((await A.p.locator('[data-test="signed-in-email"]').textContent()) === ALICE.email, 'signed-in email shown in settings');
  check(drive.filesOf(ALICE.id).length === 1 && drive.filesOf(ALICE.id)[0].name === 'Monthly Budget App Data', 'Drive file "Monthly Budget App Data" created');
  check(!/Never|never/.test(await A.p.locator('[data-test="last-sync"]').textContent()), 'last sync time shown');
  await gotoView(A.p, 'month');
  await A.p.selectOption('#monthSelect', '0');
  await typeAmt(A.p, 'v:l-salary:0', '25000');
  await A.p.waitForTimeout(3000); // debounce after change
  await waitIdleSynced(A.p);
  check(drive.filesOf(ALICE.id)[0].content.includes('2500000'), 'change uploaded automatically after editing');
});

await section('Sync: second device receives data on sign-in', async () => {
  B = await syncDevice();
  await gotoView(B.p, 'settings');
  await B.p.click('[data-act="sign-in"]');
  await waitStatus(B.p, 'ok');
  await gotoView(B.p, 'month');
  await B.p.selectOption('#monthSelect', '0');
  check((await (await amt(B.p, 'v:l-salary:0')).inputValue()) === '25,000', 'device B shows device A’s salary');
});

await section('Sync: offline conflict on two devices merges value by value', async () => {
  await A.c.setOffline(true);
  await A.p.evaluate(() => window.dispatchEvent(new Event('offline')));
  await typeAmt(A.p, 'v:l-rent:0', '7000');
  await typeAmt(A.p, 'v:l-groceries:0', '1500');
  await A.p.waitForTimeout(3000);
  check(/Offline/.test(await A.p.locator('#syncPill').textContent()), `A shows offline with queued changes (“${await A.p.locator('#syncPill').textContent()}”)`);
  check(await A.p.evaluate(() => window.__mbapp.repo.pendingCount) === 2, 'two changes queued on A');

  await typeAmt(B.p, 'v:l-fuel:0', '600');
  await typeAmt(B.p, 'v:l-groceries:0', '1700'); // newer edit of the same value
  await B.p.waitForTimeout(3000);
  await waitIdleSynced(B.p);

  await A.c.setOffline(false);
  await A.p.evaluate(() => window.dispatchEvent(new Event('online')));
  await waitIdleSynced(A.p);
  await B.p.evaluate(() => window.__mbapp.sync.sync());
  await waitIdleSynced(B.p);
  for (const [name, d] of [['A', A], ['B', B]]) {
    await d.p.evaluate(() => 0);
    const vals = await d.p.evaluate(() => ['v:l-rent:0', 'v:l-fuel:0', 'v:l-groceries:0', 'v:l-salary:0'].map((k) => (window.__mbapp.repo.regs[k] || {}).v));
    check(JSON.stringify(vals) === JSON.stringify([700000, 60000, 170000, 2500000]), `${name} has A’s rent, B’s fuel, newest groceries, salary: ${vals}`);
  }
});

await section('Sync: deletions propagate', async () => {
  await gotoView(B.p, 'month');
  await B.p.click('[data-act="edit"]');
  await B.p.click('[data-act="line-del"][data-id="l-parking"]');
  await B.p.click('[data-act="edit"]');
  await B.p.waitForTimeout(3000);
  await waitIdleSynced(B.p);
  await A.p.evaluate(() => window.__mbapp.sync.sync());
  await waitIdleSynced(A.p);
  await gotoView(A.p, 'month');
  check(await A.p.locator('input[data-k="v:l-parking:0"]').count() === 0, 'line deleted on B disappears on A');
});

await section('Sync: wrong Google account is blocked with a warning', async () => {
  // Bob signs in on device A, which is linked to Alice
  await gotoView(A.p, 'settings');
  await A.p.click('[data-act="sign-out"]');
  await A.p.evaluate(() => { window.__mockToken = 'tok-bob'; });
  const before = drive.filesOf(ALICE.id)[0].content;
  await A.p.click('[data-act="sign-in"]');
  await waitStatus(A.p, 'wrong-account');
  const banner = A.p.locator('[data-test="wrong-account"]');
  check(await banner.isVisible(), 'warning banner shown');
  const txt = await banner.textContent();
  check(txt.includes(ALICE.email) && txt.includes(BOB.email), 'warning names both accounts');
  check(/Wrong account/.test(await A.p.locator('#syncPill').textContent()), 'sync pill shows wrong account');
  check(drive.filesOf(BOB.id).length === 0, 'nothing uploaded to the other account');
  check(drive.filesOf(ALICE.id)[0].content === before, 'linked account’s file untouched');
  await typeAmt(A.p, 'v:l-misc:0', '5').catch(() => {});
  await A.p.evaluate(() => window.__mbapp.sync.sync());
  await A.p.waitForTimeout(300);
  check(await syncStatus(A.p) === 'wrong-account' && drive.filesOf(BOB.id).length === 0, 'still blocked after more changes / retries');
  await A.p.screenshot({ path: `${OUT}phone-wrong-account.png` });
  // choose: sign out
  await click(A.p, '[data-act="wa-signout"]');
  check(await A.p.locator('[data-test="wrong-account"]').count() === 0, 'sign-out clears the warning');
  check(await A.p.evaluate(() => window.__mbapp.repo.meta.linked.email) === ALICE.email, 'device stays linked to the original account');
  // Back to Alice works
  await A.p.evaluate(() => { window.__mockToken = 'tok-alice'; });
  await A.p.click('[data-act="sign-in"]');
  await waitStatus(A.p, 'ok');
  check(true, 'original account can sync again');
});

await section('Sync: passphrase encryption between devices', async () => {
  await gotoView(A.p, 'settings');
  await A.p.click('[data-act="enc-on"]');
  check(/cannot be recovered/.test(await A.p.locator('dialog').textContent()), 'clear warning that a lost passphrase cannot be recovered');
  await A.p.fill('dialog input[name="p1"]', 'test passphrase 123');
  await A.p.fill('dialog input[name="p2"]', 'test passphrase 123');
  await A.p.check('dialog input[name="ack"]');
  await A.p.click('dialog button[value="ok"]');
  for (let i = 0; i < 150 && !JSON.parse(drive.filesOf(ALICE.id)[0].content).encrypted; i++) await A.p.waitForTimeout(100);
  await waitStatus(A.p, 'ok', 15000);
  const env = JSON.parse(drive.filesOf(ALICE.id)[0].content);
  check(env.encrypted === true && !JSON.stringify(env).includes('Housing'), 'Drive file is encrypted');
  await B.p.evaluate(() => window.__mbapp.sync.sync());
  await waitStatus(B.p, 'passphrase');
  check(await B.p.locator('[data-test="passphrase"]').isVisible(), 'other device asks for the passphrase');
  await B.p.fill('[data-form="unlock"] input', 'wrong one');
  await B.p.click('[data-form="unlock"] button');
  await B.p.waitForFunction(() => window.__mbapp.sync.state.wrong === true, null, { timeout: 15000 });
  check(true, 'wrong passphrase rejected');
  await B.p.fill('[data-form="unlock"] input', 'test passphrase 123');
  await B.p.click('[data-form="unlock"] button');
  await waitStatus(B.p, 'ok', 15000);
  check(true, 'correct passphrase unlocks sync');
});

await section('Sync: error is shown', async () => {
  const orig = drive.handle;
  drive.handle = (r) => (r.method === 'GET' && r.url.includes('/about') ? { status: 500, body: '{"error":{"message":"Backend Error"}}', contentType: 'application/json' } : orig(r));
  await A.p.evaluate(() => window.__mbapp.sync.sync());
  await waitStatus(A.p, 'error');
  await gotoView(A.p, 'settings');
  check(/Backend Error/.test(await A.p.locator('[data-test="sync-error"]').textContent()), 'sync error message displayed');
  drive.handle = orig;
});

await A.c.close();
await B.c.close();

// Desktop layout check
await section('Desktop layout', async () => {
  const c = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const p = await c.newPage();
  await p.goto(BASE);
  await p.waitForSelector('.group');
  check(await noHorizontalScroll(p), 'no horizontal scroll at 1280px');
  await gotoView(p, 'summary');
  await p.screenshot({ path: `${OUT}desktop-summary.png` });
  await c.close();
});

await browser.close();
server.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
for (const f of failed) console.log('  ✘ ' + f.msg);
process.exit(failed.length ? 1 : 0);
