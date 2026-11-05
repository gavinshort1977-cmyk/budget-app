import { GOOGLE_CLIENT_ID } from './config.js';
import { LS_PREFIX, MONTHS, APP_ID } from './constants.js';
import { IdbStore, requestPersistence } from './store.js';
import { Repo } from './repo.js';
import { compute, monthLabels, parseStart } from './calc.js';
import { money, num, pct, parseAmount, esc, timeAgo } from './format.js';
import { chartSvg } from './chart.js';
import { makeBackup, parseBackup, makeCsv } from './exporting.js';
import { newId, val } from './doc.js';
import { DriveClient } from './drive.js';
import { GoogleAuth } from './auth.js';
import { SyncEngine } from './sync.js';

export const VERSION = '1.0.0';
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const configured = typeof GOOGLE_CLIENT_ID === 'string' && GOOGLE_CLIENT_ID.trim().length > 0;

// ---- per-device UI preferences (localStorage, prefixed) ---------------------
function lsGet(k, d) {
  try { const v = localStorage.getItem(LS_PREFIX + k); return v === null ? d : JSON.parse(v); } catch { return d; }
}
function lsSet(k, v) {
  try { localStorage.setItem(LS_PREFIX + k, JSON.stringify(v)); } catch { /* ignore */ }
}

const ui = {
  view: lsGet('view', 'month'),
  month: 0,
  edit: false,
  collapsed: new Set(lsGet('collapsed', [])),
  chartMonth: null,
  needsRender: false,
  installPrompt: null,
  updateReady: null,
  persist: 'unknown',
};

let repo, sync;

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
async function boot() {
  repo = await new Repo(new IdbStore()).load();
  const labels = monthLabels(repo.model().start);
  const nowIso = new Date().toISOString().slice(0, 7);
  const idx = labels.findIndex((l) => l.iso === nowIso);
  ui.month = idx >= 0 ? idx : 0;

  const auth = new GoogleAuth({ clientId: GOOGLE_CLIENT_ID, repo });
  sync = new SyncEngine({
    repo, auth, configured,
    drive: new DriveClient(() => auth.token({ interactive: false }).then((t) => t || Promise.reject(Object.assign(new Error('Signed out'), { status: 401 })))),
    isOnline: () => navigator.onLine,
    onState: () => { renderChrome(); if (ui.view === 'settings' && !focusedInput()) render(); },
  });

  repo.on((kind) => {
    if (kind === 'local') scheduleSync();
    if (kind === 'remote' && focusedInput()) { ui.needsRender = true; patch(); } else if (kind === 'remote') render();
    else patch();
    renderChrome();
  });

  bindGlobalEvents();
  render();
  renderChrome();

  ui.persist = await requestPersistence();
  if (configured) sync.sync();
  setInterval(() => { if (document.visibilityState === 'visible' && configured) sync.sync(); }, 120_000);
  registerSw();
}

let syncTimer = null;
function scheduleSync() {
  if (!configured) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => sync.sync(), 2500);
}

function focusedInput() {
  const a = document.activeElement;
  return a && (a.tagName === 'INPUT' || a.tagName === 'SELECT' || a.tagName === 'TEXTAREA') && $('#view').contains(a) ? a : null;
}

// ---------------------------------------------------------------------------
// Rendering helpers
// ---------------------------------------------------------------------------
function outputs() {
  const model = repo.model();
  const c = compute(model);
  const m = c.months[ui.month];
  const o = {
    'm-in': money(m.inflow), 'm-out': money(m.outflow), 'm-net': money(m.net),
    'm-rate': pct(m.savingsRate), 'm-open': money(m.opening), 'm-closeplan': money(m.closingPlanned),
    'm-close': money(m.closing), 'm-funds': money(m.totalFunds),
    'm-actual': m.actualComplete ? money(m.actualDaily) : `${m.actualCount} of ${model.accounts.filter((a) => a.daily).length} entered`,
    'm-var': m.variance === null ? '—' : money(m.variance),
  };
  for (const g of model.groups) {
    o[`g-sub:${g.id}`] = money(m.groups[g.id]);
    o[`g-share:${g.id}`] = g.kind === 'out' ? (m.inflow > 0 ? pct(m.groups[g.id] / m.inflow) + ' of income' : '') : '';
  }
  for (const a of model.accounts) {
    const s = c.accountSeries[a.id][ui.month];
    o[`a-proj:${a.id}`] = a.daily ? '' : (s && !s.actual ? `Projected ${money(s.value)}` : '');
  }
  return { model, c, o };
}

function out(o, key) {
  return `<span data-out="${esc(key)}">${esc(o[key] ?? '')}</span>`;
}

/** Update numbers in place without rebuilding inputs (keeps the keyboard open). */
function patch() {
  if (ui.view !== 'month' && ui.view !== 'accounts') { if (!focusedInput()) render(); return; }
  const { o } = outputs();
  for (const el of $$('[data-out]')) {
    const k = el.dataset.out;
    if (k in o && el.textContent !== o[k]) el.textContent = o[k];
  }
  const active = document.activeElement;
  for (const el of $$('input[data-k]')) {
    if (el === active) continue;
    const v = val(repo.regs, el.dataset.k, null);
    const txt = typeof v === 'number' ? num(v) : '';
    if (el.value !== txt && !el.classList.contains('invalid')) el.value = txt;
  }
  for (const el of $$('input[data-name]')) {
    if (el === active) continue;
    const v = val(repo.regs, el.dataset.name, '');
    if (el.value !== v) el.value = v;
  }
}

function render() {
  ui.needsRender = false;
  const view = $('#view');
  const y = window.scrollY;
  const keep = ui.view === view.dataset.view;
  for (const b of $$('.tabbar button')) b.setAttribute('aria-current', b.dataset.view === ui.view ? 'page' : 'false');
  view.dataset.view = ui.view;
  document.body.dataset.view = ui.view;
  if (ui.view === 'month') view.innerHTML = renderMonth();
  else if (ui.view === 'summary') view.innerHTML = renderSummary();
  else if (ui.view === 'accounts') view.innerHTML = renderAccounts();
  else view.innerHTML = renderSettings();
  $('#monthbar').hidden = ui.view !== 'month' && ui.view !== 'accounts';
  renderMonthBar();
  if (keep) window.scrollTo(0, y);
}

function renderMonthBar() {
  const labels = monthLabels(repo.model().start);
  $('#monthSelect').innerHTML = labels.map((l) => `<option value="${l.index}"${l.index === ui.month ? ' selected' : ''}>${esc(l.long)} · month ${l.index + 1}</option>`).join('');
  $('#monthLabel').textContent = labels[ui.month].long;
  $('#prevMonth').disabled = ui.month === 0;
  $('#nextMonth').disabled = ui.month === MONTHS - 1;
}

// ---------------------------------------------------------------------------
// Month view
// ---------------------------------------------------------------------------
function amountInput(key, label) {
  const v = val(repo.regs, key, null);
  return `<input class="amt" data-k="${esc(key)}" inputmode="decimal" enterkeyhint="next" autocomplete="off" aria-label="${esc(label)}" placeholder="0" value="${typeof v === 'number' ? esc(num(v)) : ''}">`;
}

function renderGroup(g, model, o) {
  const m = ui.month;
  const collapsed = ui.collapsed.has(g.id) && !ui.edit;
  const savingsAccounts = model.accounts.filter((a) => !a.daily);
  let lines = '';
  if (!collapsed) {
    lines = g.lines.map((l, i) => {
      if (!ui.edit) {
        return `<label class="line"><span class="lname">${esc(l.name)}</span>${amountInput(`v:${l.id}:${m}`, `${l.name}, ${g.name}`)}</label>`;
      }
      const acct = g.kind === 'out' && (g.savings || l.acct)
        ? `<select class="acct" data-act="line-acct" data-id="${l.id}" aria-label="Adds to account"><option value="">Not linked to an account</option>${savingsAccounts.map((a) => `<option value="${a.id}"${l.acct === a.id ? ' selected' : ''}>Adds to: ${esc(a.name)}</option>`).join('')}</select>` : '';
      return `<div class="line editing">
        <input class="name" data-name="l:${l.id}:name" value="${esc(l.name)}" aria-label="Line name" enterkeyhint="done">
        <div class="edit-tools">
          <button class="icon" data-act="line-up" data-id="${l.id}" ${i === 0 ? 'disabled' : ''} aria-label="Move up">▲</button>
          <button class="icon" data-act="line-down" data-id="${l.id}" ${i === g.lines.length - 1 ? 'disabled' : ''} aria-label="Move down">▼</button>
          <button class="icon" data-act="line-move" data-id="${l.id}" aria-label="Move to another group">⇄</button>
          <button class="icon danger" data-act="line-del" data-id="${l.id}" aria-label="Delete line">✕</button>
        </div>${acct}</div>`;
    }).join('');
    if (ui.edit) lines += `<button class="add" data-act="line-add" data-id="${g.id}">+ Add line to ${esc(g.name)}</button>`;
  }
  const groups = g.kind === 'in' ? model.inflowGroups : model.outflowGroups;
  const gi = groups.indexOf(g);
  const head = ui.edit
    ? `<div class="g-edit">
        <input class="name gname" data-name="g:${g.id}:name" value="${esc(g.name)}" aria-label="Group name" enterkeyhint="done">
        <div class="edit-tools">
          <button class="icon" data-act="group-up" data-id="${g.id}" ${gi === 0 ? 'disabled' : ''} aria-label="Move group up">▲</button>
          <button class="icon" data-act="group-down" data-id="${g.id}" ${gi === groups.length - 1 ? 'disabled' : ''} aria-label="Move group down">▼</button>
          <button class="icon danger" data-act="group-del" data-id="${g.id}" aria-label="Delete group">✕</button>
        </div>
        ${g.kind === 'out' ? `<label class="check"><input type="checkbox" data-act="group-savings" data-id="${g.id}" ${g.savings ? 'checked' : ''}> Counts as savings (for savings rate)</label>` : ''}
      </div>`
    : `<div class="g-head">
        <button class="g-toggle" data-act="toggle" data-id="${g.id}" aria-expanded="${!collapsed}"><span class="chev">${collapsed ? '▸' : '▾'}</span><span class="gname">${esc(g.name)}</span></button>
        <div class="g-sum"><strong>${out(o, `g-sub:${g.id}`)}</strong><small>${out(o, `g-share:${g.id}`)}</small></div>
        <button class="icon ghost" data-act="copy-group" data-id="${g.id}" ${m === 0 ? 'disabled' : ''} aria-label="Copy ${esc(g.name)} from previous month" title="Copy from previous month">⧉</button>
      </div>`;
  return `<section class="card group${g.savings ? ' savings' : ''}" data-g="${g.id}">${head}<div class="lines">${lines}</div></section>`;
}

function renderMonth() {
  const { model, o } = outputs();
  const m = ui.month;
  const sect = (title, groups, kind) => `<h2 class="section">${title}</h2>${groups.map((g) => renderGroup(g, model, o)).join('')}${ui.edit ? `<button class="add big" data-act="group-add" data-kind="${kind}">+ Add ${kind === 'in' ? 'inflow' : 'outflow'} group</button>` : ''}`;
  return `
  <div class="kpis sticky">
    <div><small>In</small><b class="pos">${out(o, 'm-in')}</b></div>
    <div><small>Out</small><b>${out(o, 'm-out')}</b></div>
    <div><small>Net</small><b>${out(o, 'm-net')}</b></div>
  </div>
  <div class="toolbar">
    <button data-act="copy-month" ${m === 0 ? 'disabled' : ''}>⧉ Copy previous month</button>
    <button data-act="edit" class="${ui.edit ? 'on' : ''}" aria-pressed="${ui.edit}">${ui.edit ? '✓ Done editing' : '✎ Edit groups & lines'}</button>
  </div>
  ${ui.edit ? '<p class="hint">Rename by typing. Use ▲▼ to reorder, ⇄ to move a line to another group, ✕ to delete. Changes save automatically.</p>' : ''}
  ${sect('Inflows', model.inflowGroups, 'in')}
  ${sect('Outflows', model.outflowGroups, 'out')}
  <h2 class="section">Month-end balances</h2>
  <section class="card">
    <p class="hint">Enter what each account actually held at the end of the month. When every day-to-day account has a figure, their total becomes the next month's opening balance.</p>
    ${model.accounts.map((a) => `<label class="line"><span class="lname">${esc(a.name)}<small>${a.daily ? 'Day-to-day' : out(o, `a-proj:${a.id}`)}</small></span>${amountInput(`b:${a.id}:${m}`, `${a.name} month-end balance`)}</label>`).join('') || '<p class="hint">No accounts yet — add them under Accounts.</p>'}
  </section>
  <section class="card totals">
    <div class="row"><span>Opening balance</span>${out(o, 'm-open')}</div>
    <div class="row"><span>Net cash flow</span>${out(o, 'm-net')}</div>
    <div class="row"><span>Planned closing</span>${out(o, 'm-closeplan')}</div>
    <div class="row"><span>Actual day-to-day</span>${out(o, 'm-actual')}</div>
    <div class="row"><span>Difference vs plan</span>${out(o, 'm-var')}</div>
    <div class="row strong"><span>Closing balance</span>${out(o, 'm-close')}</div>
    <div class="row"><span>Savings rate</span>${out(o, 'm-rate')}</div>
    <div class="row strong"><span>Total funds (all accounts)</span>${out(o, 'm-funds')}</div>
  </section>`;
}

// ---------------------------------------------------------------------------
// Summary view
// ---------------------------------------------------------------------------
function renderSummary() {
  const { model, c } = outputs();
  const t = c.totals;
  const cm = ui.chartMonth;
  const cap = cm === null
    ? 'Tap a month in the chart for its figures.'
    : `<b>${esc(c.months[cm].long)}</b> · In ${money(c.months[cm].inflow)} · Out ${money(c.months[cm].outflow)} · Net ${money(c.months[cm].net)}`;
  const rows = c.months.map((m) => `<tr><th scope="row">${esc(m.long)}</th><td>${money(m.inflow)}</td><td>${money(m.outflow)}</td><td class="${m.net < 0 ? 'neg' : ''}">${money(m.net)}</td><td>${pct(m.savingsRate)}</td><td>${money(m.opening)}</td><td>${money(m.closing)}${m.actualComplete ? ' <abbr title="From actual balances">✓</abbr>' : ''}</td><td>${money(m.totalFunds)}</td></tr>`).join('');
  const groupRows = (groups) => groups.map((g) => `<tr><th scope="row">${esc(g.name)}</th><td>${money(t.groups[g.id])}</td><td>${money(Math.round(t.groups[g.id] / 12))}</td><td>${g.kind === 'out' ? pct(t.share[g.id]) : '—'}</td></tr>`).join('');
  return `
  <h2 class="section">12-month overview · ${esc(c.labels[0].long)} – ${esc(c.labels[11].long)}</h2>
  <div class="tiles">
    <div class="tile"><small>Inflows · 12-month total</small><b>${money(t.inflow)}</b></div>
    <div class="tile"><small>Outflows · 12-month total</small><b>${money(t.outflow)}</b></div>
    <div class="tile"><small>Net cash flow · 12-month total</small><b class="${t.net < 0 ? 'neg' : ''}">${money(t.net)}</b></div>
    <div class="tile"><small>Savings rate</small><b>${pct(t.savingsRate)}</b></div>
    <div class="tile"><small>Closing balance, ${esc(c.labels[11].short)}</small><b>${money(t.closingEnd)}</b></div>
    <div class="tile"><small>Total funds, ${esc(c.labels[11].short)}</small><b>${money(t.totalFundsEnd)}</b></div>
  </div>
  <section class="card">
    <h3>Inflows vs outflows</h3>
    <div class="legend"><span><i class="sw in"></i>Inflows</span><span><i class="sw out"></i>Outflows</span><span><i class="sw net"></i>Net cash flow</span><small>AED</small></div>
    <div class="chart-wrap">${chartSvg(c, { width: Math.round(Math.max(320, Math.min(680, window.innerWidth - 62))), height: window.innerWidth < 500 ? 240 : 300 })}</div>
    <p class="caption" id="chartCaption">${cap}</p>
  </section>
  <section class="card">
    <h3>Month by month</h3>
    <div class="table-wrap"><table class="grid">
      <thead><tr><th>Month</th><th>Inflows</th><th>Outflows</th><th>Net cash flow</th><th>Savings rate</th><th>Opening</th><th>Closing</th><th>Total funds</th></tr></thead>
      <tbody>${rows}</tbody>
      <tfoot><tr><th scope="row">12-month total</th><td>${money(t.inflow)}</td><td>${money(t.outflow)}</td><td class="${t.net < 0 ? 'neg' : ''}">${money(t.net)}</td><td>${pct(t.savingsRate)}</td><td>${money(t.openingStart)}</td><td>${money(t.closingEnd)}</td><td>${money(t.totalFundsEnd)}</td></tr></tfoot>
    </table></div>
    <p class="hint">Opening/closing show day-to-day cash only. Total funds adds every account. Opening and closing in the total row are the start and end of the period. ✓ = closing taken from actual balances.</p>
  </section>
  <section class="card">
    <h3>By group</h3>
    <div class="table-wrap"><table class="grid">
      <thead><tr><th>Group</th><th>12-month total</th><th>Monthly average</th><th>Share of income</th></tr></thead>
      <tbody>${groupRows(model.inflowGroups)}${groupRows(model.outflowGroups)}</tbody>
    </table></div>
  </section>
  <div class="toolbar"><button data-act="csv">⬇ Export CSV</button></div>`;
}

// ---------------------------------------------------------------------------
// Accounts view
// ---------------------------------------------------------------------------
function renderAccounts() {
  const { model, c } = outputs();
  const cards = model.accounts.map((a, i) => `
    <section class="card account">
      <input class="name" data-name="a:${a.id}:name" value="${esc(a.name)}" aria-label="Account name" enterkeyhint="done">
      <label class="line"><span class="lname">Starting balance<small>At the start of ${esc(c.labels[0].long)}</small></span>${amountInput(`a:${a.id}:start`, `${a.name} starting balance`)}</label>
      <label class="check"><input type="checkbox" data-act="acct-daily" data-id="${a.id}" ${a.daily ? 'checked' : ''}> Counts as day-to-day budget cash</label>
      <div class="edit-tools">
        <button class="icon" data-act="acct-up" data-id="${a.id}" ${i === 0 ? 'disabled' : ''} aria-label="Move up">▲</button>
        <button class="icon" data-act="acct-down" data-id="${a.id}" ${i === model.accounts.length - 1 ? 'disabled' : ''} aria-label="Move down">▼</button>
        <button class="icon danger" data-act="acct-del" data-id="${a.id}" aria-label="Delete account">✕</button>
      </div>
    </section>`).join('');
  const head = model.accounts.map((a) => `<th>${esc(a.name)}${a.daily ? '<br><small>day-to-day</small>' : ''}</th>`).join('');
  const rows = c.months.map((m, mi) => `<tr><th scope="row">${esc(m.long)}</th>${model.accounts.map((a) => {
    const s = c.accountSeries[a.id][mi];
    if (!s || s.value === null) return '<td class="muted">—</td>';
    return `<td class="${s.actual ? '' : 'muted'}">${money(s.value)}${s.actual ? '' : '*'}</td>`;
  }).join('')}<td>${money(m.totalFunds)}</td></tr>`).join('');
  return `
  <h2 class="section">Accounts</h2>
  <p class="hint">Only day-to-day accounts feed the opening balance. Total funds includes every account. Enter month-end actual balances at the bottom of the Month screen.</p>
  ${cards}
  <button class="add big" data-act="acct-add">+ Add account</button>
  <section class="card">
    <h3>Balances by month</h3>
    <div class="table-wrap"><table class="grid">
      <thead><tr><th>Month</th>${head}<th>Total funds</th></tr></thead><tbody>${rows}</tbody>
    </table></div>
    <p class="hint">* projected: last balance plus any budget lines linked to that account (set links in Edit groups & lines). Blank day-to-day cells have no actual entered.</p>
  </section>`;
}

// ---------------------------------------------------------------------------
// Settings view
// ---------------------------------------------------------------------------
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function syncSection() {
  if (!configured) {
    return `<section class="card"><h3>Google Drive sync</h3>
      <p>Sync is <b>off</b>. Everything is saved on this device only.</p>
      <p class="hint">To turn it on, the person who publishes the app adds a Google client ID in <code>js/config.js</code> (see the setup guide).</p></section>`;
  }
  const s = sync.state;
  const m = repo.meta;
  const signedIn = !!(repo.meta.token && repo.meta.token.expiresAt > Date.now() && m.currentUser);
  const enc = !!val(repo.regs, 's:encrypt', false);
  return `<section class="card" id="syncCard"><h3>Google Drive sync</h3>
    <div class="row"><span>Signed in as</span><b data-test="signed-in-email">${signedIn ? esc(m.currentUser.email || m.currentUser.name || 'Google account') : 'Not signed in'}</b></div>
    <div class="row"><span>Data linked to</span><b>${m.linked ? esc(m.linked.email || m.linked.name) : 'No account yet'}</b></div>
    <div class="row"><span>Last sync</span><b data-test="last-sync">${timeAgo(m.lastSync)}</b></div>
    <div class="row"><span>Changes waiting</span><b>${repo.pendingCount}</b></div>
    <div class="row"><span>Status</span><b data-test="sync-status">${esc(statusText(s))}</b></div>
    ${m.lastError ? `<p class="error" data-test="sync-error">Last error (${timeAgo(m.lastError.at)}): ${esc(m.lastError.message)}</p>` : ''}
    <div class="toolbar">
      ${signedIn ? '<button data-act="sync-now">↻ Sync now</button><button data-act="sign-out">Sign out</button>' : '<button class="primary" data-act="sign-in">Sign in with Google</button>'}
    </div>
    <p class="hint">Data is saved to a file called <b>“Monthly Budget App Data”</b> in the signed-in person's own Google Drive. The app can only see files it created.</p>
    <h3>Encryption of the Drive file</h3>
    ${enc
      ? `<p>On — the Drive file is encrypted with your passphrase.</p><div class="toolbar"><button data-act="enc-off">Turn encryption off</button></div>`
      : `<p>Off. You can protect the Drive file with a passphrase.</p><div class="toolbar"><button data-act="enc-on">Set a passphrase…</button></div>`}
  </section>`;
}

function renderSettings() {
  const { year, month } = parseStart(repo.model().start);
  const years = [];
  for (let y = 2020; y <= 2045; y++) years.push(y);
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  return `
  <h2 class="section">Settings</h2>
  <section class="card"><h3>Budget period</h3>
    <p class="hint">12 months starting from:</p>
    <div class="pair">
      <select id="startMonth" aria-label="Start month">${MONTH_NAMES.map((n, i) => `<option value="${i}"${i === month ? ' selected' : ''}>${n}</option>`).join('')}</select>
      <select id="startYear" aria-label="Start year">${years.map((y) => `<option${y === year ? ' selected' : ''}>${y}</option>`).join('')}</select>
    </div>
    <p class="hint">Amounts stay attached to month 1–12 of the period; changing the start month relabels them.</p>
  </section>
  ${syncSection()}
  <section class="card"><h3>Backup &amp; export</h3>
    <p class="hint">A backup is a JSON file with all your figures (not encrypted). Keep it somewhere safe.</p>
    <div class="toolbar wrap">
      <button data-act="backup">⬇ Save backup</button>
      ${navigator.canShare ? '<button data-act="share-backup">Share backup…</button>' : ''}
      <label class="button">⬆ Restore backup<input type="file" id="restoreFile" accept="application/json,.json" hidden></label>
      <button data-act="csv">⬇ Export CSV</button>
    </div>
  </section>
  <section class="card"><h3>This device</h3>
    <div class="row"><span>Persistent storage</span><b data-test="persist">${esc(ui.persist)}</b></div>
    ${ui.persist !== 'granted' ? '<div class="toolbar"><button data-act="persist">Ask again</button></div>' : ''}
    ${ui.installPrompt ? '<div class="toolbar"><button class="primary" data-act="install">Install app</button></div>' : ''}
    ${ios && !standalone ? '<p class="hint">To install on iPhone/iPad: open in Safari, tap the Share button, then “Add to Home Screen”.</p>' : ''}
    <div class="toolbar"><button class="danger" data-act="erase">Erase data on this device…</button></div>
    <p class="hint">Version ${VERSION}. Works offline. Saved data: this app's own storage only.</p>
  </section>`;
}

function statusText(s) {
  switch (s.status) {
    case 'not-configured': return 'Saved on device';
    case 'idle': return 'Ready';
    case 'syncing': return 'Syncing…';
    case 'ok': return 'Synced';
    case 'offline': return 'Offline — changes will sync later';
    case 'signin': return repo.meta.linked ? 'Sign in again to sync' : 'Not signed in';
    case 'error': return 'Sync error: ' + (s.message || '');
    case 'wrong-account': return 'Different Google account — sync blocked';
    case 'passphrase': return s.wrong ? 'Wrong passphrase' : 'Passphrase needed';
    case 'first-link': return 'Choose how to combine data';
    default: return s.status;
  }
}

// ---------------------------------------------------------------------------
// Top bar, sync pill & banners
// ---------------------------------------------------------------------------
function renderChrome() {
  const s = sync ? sync.state : { status: 'not-configured' };
  const pill = $('#syncPill');
  const p = repo ? repo.pendingCount : 0;
  let text, cls = '';
  switch (s.status) {
    case 'not-configured': text = 'On this device'; break;
    case 'syncing': text = 'Syncing…'; cls = 'busy'; break;
    case 'ok': text = `Synced ${timeAgo(repo.meta.lastSync)}`; cls = 'ok'; break;
    case 'offline': text = p ? `Offline · ${p} waiting` : 'Offline'; cls = 'warn'; break;
    case 'error': text = 'Sync error'; cls = 'bad'; break;
    case 'wrong-account': text = 'Wrong account'; cls = 'bad'; break;
    case 'passphrase': text = 'Passphrase needed'; cls = 'warn'; break;
    case 'first-link': text = 'Action needed'; cls = 'warn'; break;
    case 'signin': text = repo.meta.linked ? 'Tap to sync' : 'Sync off'; cls = repo.meta.linked ? 'warn' : ''; break;
    default: text = p ? `${p} unsynced` : 'Ready';
  }
  pill.textContent = text;
  pill.className = 'pill ' + cls;
  const user = repo && repo.meta.currentUser && repo.meta.token && repo.meta.token.expiresAt > Date.now() ? repo.meta.currentUser : null;
  $('#whoami').textContent = user ? user.email || user.name : '';

  const b = [];
  if (s.status === 'wrong-account') {
    b.push(`<div class="banner bad" role="alert" data-test="wrong-account">
      <b>Different Google account.</b> This device's budget is linked to <b>${esc(s.linked.email || s.linked.name)}</b>, but <b>${esc(s.current.email || s.current.name)}</b> just signed in. Sync is paused so the two accounts' data never mix.
      ${s.message ? `<p>${esc(s.message)}</p>` : ''}
      <div class="toolbar wrap">
        <button data-act="wa-signout" class="primary">Sign out (keep everything as is)</button>
        <button data-act="wa-use-new">Use ${esc(s.current.email || 'that account')}'s data on this device…</button>
        <button data-act="wa-link-local">Move this device's data to ${esc(s.current.email || 'that account')}…</button>
      </div></div>`);
  } else if (s.status === 'first-link') {
    b.push(`<div class="banner warn" role="alert" data-test="first-link">
      <b>${esc(s.current.email)}</b> already has budget data in Google Drive, and this device has its own figures.
      <div class="toolbar wrap">
        <button data-act="fl-merge" class="primary">Combine both (value by value)</button>
        <button data-act="fl-drive">Use the Drive data only</button>
        <button data-act="wa-signout">Cancel</button>
      </div></div>`);
  } else if (s.status === 'passphrase') {
    b.push(`<div class="banner warn" role="alert" data-test="passphrase">
      ${s.wrong ? '<b>That passphrase did not work.</b> ' : ''}The Drive file is encrypted. Enter the passphrase to sync this device.
      <form class="pair" data-form="unlock"><input type="password" name="pass" autocomplete="current-password" placeholder="Passphrase" aria-label="Passphrase" required><button class="primary">Unlock</button></form></div>`);
  } else if (s.status === 'signin' && repo.meta.linked) {
    b.push(`<div class="banner" data-test="signin">Google sign-in has expired. <button data-act="sign-in" class="primary">Sign in to sync</button></div>`);
  } else if (s.status === 'error') {
    b.push(`<div class="banner bad" role="alert" data-test="sync-error-banner">Sync problem: ${esc(s.message)} <button data-act="sync-now">Try again</button></div>`);
  }
  if (ui.updateReady) b.push('<div class="banner">A new version is ready. <button class="primary" data-act="update">Reload</button></div>');
  $('#banners').innerHTML = b.join('');
}

// ---------------------------------------------------------------------------
// Toast with undo
// ---------------------------------------------------------------------------
let toastTimer = null;
function toast(msg, undo = null) {
  const t = $('#toast');
  t.innerHTML = `<span>${esc(msg)}</span>${undo && undo.length ? '<button data-act="undo">Undo</button>' : ''}`;
  t.hidden = false;
  t._undo = undo;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; t._undo = null; }, undo ? 7000 : 3500);
}

// ---------------------------------------------------------------------------
// Dialogs
// ---------------------------------------------------------------------------
function dialog(html, buttons) {
  return new Promise((resolve) => {
    const d = $('#dlg');
    d.innerHTML = `<form method="dialog"><div class="dlg-body">${html}</div><div class="toolbar wrap end">${buttons.map((b) => `<button value="${esc(b.value)}" class="${b.cls || ''}">${esc(b.label)}</button>`).join('')}</div></form>`;
    const form = d.querySelector('form');
    d.onclose = () => {
      const data = Object.fromEntries(new FormData(form).entries());
      resolve({ value: d.returnValue, data });
    };
    d.returnValue = '';
    d.showModal();
    const first = d.querySelector('input, select');
    if (first) first.focus();
  });
}
async function confirmDlg(html, ok = 'OK', cls = 'primary') {
  const r = await dialog(html, [{ label: 'Cancel', value: 'cancel' }, { label: ok, value: 'ok', cls }]);
  return r.value === 'ok';
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------
function download(name, text, type) {
  const blob = new Blob([text], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}
const stamp = () => new Date().toISOString().slice(0, 16).replace('T', '_').replace(':', '-');

function saveBackup() {
  download(`monthly-budget-backup_${stamp()}.json`, makeBackup(repo.regs), 'application/json');
  toast('Backup saved to your downloads.');
}

function reorder(list, id, dir, prefix) {
  const i = list.findIndex((x) => x.id === id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= list.length) return null;
  // Renumber the whole list so orders stay distinct, then swap the two.
  const ids = list.map((x) => x.id);
  [ids[i], ids[j]] = [ids[j], ids[i]];
  return ids.map((x, k) => [`${prefix}:${x}:order`, (k + 1) * 10]);
}

function copyEntries(lines, m) {
  const entries = [];
  let overwrites = 0;
  for (const l of lines) {
    const prev = repo.model().amount(l.id, m - 1);
    if (prev === null) continue;
    const cur = repo.model().amount(l.id, m);
    if (cur !== null && cur !== prev) overwrites++;
    if (cur !== prev) entries.push([`v:${l.id}:${m}`, prev]);
  }
  return { entries, overwrites };
}

async function doCopy(lines, what) {
  const m = ui.month;
  if (m === 0) return;
  const { entries, overwrites } = copyEntries(lines, m);
  const labels = monthLabels(repo.model().start);
  if (!entries.length) return toast(`Nothing to copy from ${labels[m - 1].long}.`);
  if (overwrites && !(await confirmDlg(`<p>This replaces <b>${overwrites}</b> figure${overwrites > 1 ? 's' : ''} already entered for ${esc(labels[m].long)} with ${esc(labels[m - 1].long)}'s.</p>`, 'Copy'))) return;
  const undo = await repo.setMany(entries);
  render();
  toast(`Copied ${entries.length} figure${entries.length > 1 ? 's' : ''} from ${labels[m - 1].long} (${what}).`, undo);
}

async function handleAction(btn) {
  const act = btn.dataset.act;
  const id = btn.dataset.id;
  const model = repo.model();
  const findGroup = (gid) => model.groups.find((g) => g.id === gid);
  const findLine = (lid) => model.groups.flatMap((g) => g.lines).find((l) => l.id === lid);
  switch (act) {
    case 'toggle':
      ui.collapsed.has(id) ? ui.collapsed.delete(id) : ui.collapsed.add(id);
      lsSet('collapsed', [...ui.collapsed]);
      return render();
    case 'edit': ui.edit = !ui.edit; return render();
    case 'copy-month': return doCopy(model.groups.flatMap((g) => g.lines), 'whole month');
    case 'copy-group': { const g = findGroup(id); return doCopy(g.lines, g.name); }
    case 'line-add': {
      const g = findGroup(id);
      const lid = newId('l');
      await repo.setMany([[`l:${lid}:group`, id], [`l:${lid}:name`, 'New line'], [`l:${lid}:order`, (g.lines.length + 1) * 10 + 1000]]);
      render();
      const inp = $(`input[data-name="l:${lid}:name"]`);
      if (inp) { inp.focus(); inp.select(); }
      return;
    }
    case 'line-up': case 'line-down': {
      const l = findLine(id);
      const e = reorder(findGroup(l.groupId).lines, id, act === 'line-up' ? -1 : 1, 'l');
      if (e) { await repo.setMany(e); render(); }
      return;
    }
    case 'line-del': {
      const l = findLine(id);
      const undo = await repo.set(`l:${id}:del`, true);
      render();
      return toast(`Deleted “${l.name}”.`, undo);
    }
    case 'line-move': {
      const l = findLine(id);
      const r = await dialog(`<p>Move <b>${esc(l.name)}</b> to:</p><select name="g">${model.groups.map((g) => `<option value="${g.id}"${g.id === l.groupId ? ' selected' : ''}>${esc(g.name)}${g.kind === 'in' ? ' (inflow)' : ''}</option>`).join('')}</select>`,
        [{ label: 'Cancel', value: 'cancel' }, { label: 'Move', value: 'ok', cls: 'primary' }]);
      if (r.value !== 'ok' || r.data.g === l.groupId) return;
      const target = findGroup(r.data.g);
      await repo.setMany([[`l:${id}:group`, r.data.g], [`l:${id}:order`, (target.lines.length + 1) * 10 + 1000]]);
      return render();
    }
    case 'line-acct': return; // handled on change
    case 'group-add': {
      const kind = btn.dataset.kind;
      const gid = newId('g');
      const max = Math.max(0, ...model.groups.map((g) => g.order));
      await repo.setMany([[`g:${gid}:name`, 'New group'], [`g:${gid}:kind`, kind], [`g:${gid}:order`, max + 10], [`g:${gid}:savings`, false]]);
      render();
      const inp = $(`input[data-name="g:${gid}:name"]`);
      if (inp) { inp.focus(); inp.select(); }
      return;
    }
    case 'group-up': case 'group-down': {
      const g = findGroup(id);
      const list = g.kind === 'in' ? model.inflowGroups : model.outflowGroups;
      const e = reorder(list, id, act === 'group-up' ? -1 : 1, 'g');
      if (e) { await repo.setMany(e); render(); }
      return;
    }
    case 'group-del': {
      const g = findGroup(id);
      if (!(await confirmDlg(`<p>Delete the group <b>${esc(g.name)}</b> and its ${g.lines.length} line${g.lines.length === 1 ? '' : 's'}?</p>`, 'Delete', 'danger'))) return;
      const undo = await repo.set(`g:${id}:del`, true);
      render();
      return toast(`Deleted group “${g.name}”.`, undo);
    }
    case 'acct-add': {
      const aid = newId('a');
      const max = Math.max(0, ...model.accounts.map((a) => a.order));
      await repo.setMany([[`a:${aid}:name`, 'New account'], [`a:${aid}:start`, 0], [`a:${aid}:daily`, false], [`a:${aid}:order`, max + 10]]);
      render();
      const inp = $(`input[data-name="a:${aid}:name"]`);
      if (inp) { inp.focus(); inp.select(); }
      return;
    }
    case 'acct-up': case 'acct-down': {
      const e = reorder(model.accounts, id, act === 'acct-up' ? -1 : 1, 'a');
      if (e) { await repo.setMany(e); render(); }
      return;
    }
    case 'acct-del': {
      const a = model.accounts.find((x) => x.id === id);
      if (!(await confirmDlg(`<p>Delete the account <b>${esc(a.name)}</b>? Its balances will no longer count.</p>`, 'Delete', 'danger'))) return;
      const undo = await repo.set(`a:${id}:del`, true);
      render();
      return toast(`Deleted account “${a.name}”.`, undo);
    }
    case 'undo': {
      const t = $('#toast');
      if (t._undo) { await repo.setMany(t._undo); t.hidden = true; t._undo = null; render(); }
      return;
    }
    case 'csv':
      download(`monthly-budget_${model.start}_${stamp()}.csv`, makeCsv(model), 'text/csv;charset=utf-8');
      return toast('CSV exported.');
    case 'backup': return saveBackup();
    case 'share-backup': {
      const file = new File([makeBackup(repo.regs)], `monthly-budget-backup_${stamp()}.json`, { type: 'application/json' });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        try { await navigator.share({ files: [file], title: 'Monthly Budget backup' }); } catch { /* cancelled */ }
      } else saveBackup();
      return;
    }
    case 'persist': ui.persist = await requestPersistence(); return render();
    case 'install':
      if (ui.installPrompt) { ui.installPrompt.prompt(); await ui.installPrompt.userChoice; ui.installPrompt = null; render(); }
      return;
    case 'erase': return eraseDevice();
    case 'sign-in': return sync.sync({ interactive: true });
    case 'sync-now': return sync.sync({ interactive: false });
    case 'sign-out': await sync.signOut(); return render();
    case 'enc-on': return enableEncryption();
    case 'enc-off':
      if (!(await confirmDlg('<p>Turn off encryption? The Drive file will be stored as plain JSON from now on (on all devices).</p>', 'Turn off'))) return;
      await sync.disableEncryption();
      return render();
    case 'wa-signout': await sync.signOut(); return renderChrome();
    case 'wa-use-new': {
      const s = sync.state;
      if (!(await confirmDlg(`<p>This device's figures will be <b>replaced</b> with the data in <b>${esc(s.current.email)}</b>'s Drive, and the device will be linked to that account.</p><p>A backup of the current figures will be downloaded first.</p>`, 'Back up & switch', 'danger'))) return;
      saveBackup();
      await sync.useNewAccount();
      return render();
    }
    case 'wa-link-local': {
      const s = sync.state;
      if (!(await confirmDlg(`<p>Link this device's figures to <b>${esc(s.current.email)}</b> instead of <b>${esc(s.linked.email)}</b>? This only works if ${esc(s.current.email)} has no budget data in Drive yet. Nothing is merged.</p>`, 'Link to new account', 'danger'))) return;
      await sync.linkLocalToNewAccount();
      return render();
    }
    case 'fl-merge': return sync.sync({ firstLink: 'merge' });
    case 'fl-drive':
      if (!(await confirmDlg('<p>Replace this device\'s figures with the Drive data? A backup of this device is downloaded first.</p>', 'Back up & use Drive', 'danger'))) return;
      saveBackup();
      return sync.sync({ firstLink: 'use-drive' });
    case 'update':
      if (ui.updateReady) ui.updateReady.postMessage('skipWaiting');
      return;
  }
}

async function enableEncryption() {
  const r = await dialog(`
    <h3>Encrypt the Drive file</h3>
    <p class="warning"><b>Warning:</b> if this passphrase is lost, the encrypted Drive file <b>cannot be recovered by anyone</b>. There is no reset. Write it down somewhere safe, and keep a backup file.</p>
    <p class="hint">Every device that syncs will ask for the passphrase once.</p>
    <input type="password" name="p1" placeholder="Passphrase (at least 8 characters)" autocomplete="new-password" minlength="8">
    <input type="password" name="p2" placeholder="Repeat passphrase" autocomplete="new-password">
    <label class="check"><input type="checkbox" name="ack" value="1"> I understand a lost passphrase can't be recovered</label>`,
  [{ label: 'Cancel', value: 'cancel' }, { label: 'Encrypt', value: 'ok', cls: 'primary' }]);
  if (r.value !== 'ok') return;
  const { p1 = '', p2 = '', ack } = r.data;
  if (p1.length < 8) return toast('Passphrase must be at least 8 characters.');
  if (p1 !== p2) return toast('The two passphrases do not match.');
  if (!ack) return toast('Please tick the box to confirm you understand.');
  await sync.enableEncryption(p1);
  render();
  toast('Encryption turned on.');
}

async function eraseDevice() {
  if (!(await confirmDlg('<p><b>Erase all budget data on this device?</b></p><p>This deletes this app\'s data only (nothing from other apps). Data already in Google Drive is not deleted. Consider saving a backup first.</p>', 'Erase', 'danger'))) return;
  if (!(await confirmDlg('<p>Are you sure? This cannot be undone.</p>', 'Yes, erase', 'danger'))) return;
  await repo.store.destroy();
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (k && k.startsWith(LS_PREFIX)) localStorage.removeItem(k);
    }
  } catch { /* ignore */ }
  location.reload();
}

async function commitAmount(input) {
  const key = input.dataset.k;
  const v = parseAmount(input.value);
  if (Number.isNaN(v)) {
    input.classList.add('invalid');
    toast('Please enter a number, e.g. 1250 or 1,250.50');
    return;
  }
  input.classList.remove('invalid');
  if (key.startsWith('a:') && key.endsWith(':start')) await repo.set(key, v ?? 0);
  else await repo.set(key, v);
  input.value = v === null ? '' : num(v);
}

function bindGlobalEvents() {
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-act]');
    if (btn && btn.tagName !== 'INPUT' && btn.tagName !== 'SELECT' && !btn.disabled) {
      if (btn.closest('dialog')) return;
      e.preventDefault();
      handleAction(btn);
      return;
    }
    const hit = e.target.closest('.hit');
    if (hit) {
      ui.chartMonth = Number(hit.dataset.m);
      $$('.hit').forEach((h) => h.classList.toggle('sel', h === hit));
      const c = compute(repo.model());
      const m = c.months[ui.chartMonth];
      $('#chartCaption').innerHTML = `<b>${esc(m.long)}</b> · In ${money(m.inflow)} · Out ${money(m.outflow)} · Net ${money(m.net)} · Total funds ${money(m.totalFunds)}`;
    }
  });
  document.addEventListener('change', async (e) => {
    const t = e.target;
    if (t.matches('input.amt[data-k]')) return commitAmount(t);
    if (t.matches('input[data-name]')) {
      const name = t.value.trim() || 'Untitled';
      await repo.set(t.dataset.name, name);
      return;
    }
    if (t.matches('[data-act="group-savings"]')) { await repo.set(`g:${t.dataset.id}:savings`, t.checked); return render(); }
    if (t.matches('[data-act="acct-daily"]')) { await repo.set(`a:${t.dataset.id}:daily`, t.checked); return render(); }
    if (t.matches('[data-act="line-acct"]')) { await repo.set(`l:${t.dataset.id}:acct`, t.value || null); return render(); }
    if (t.id === 'startMonth' || t.id === 'startYear') {
      const v = `${$('#startYear').value}-${String(Number($('#startMonth').value) + 1).padStart(2, '0')}`;
      await repo.set('s:start', v);
      render();
      return toast(`Budget period now starts ${monthLabels(v)[0].long}.`);
    }
    if (t.id === 'restoreFile' && t.files && t.files[0]) {
      const file = t.files[0];
      t.value = '';
      try {
        const regs = parseBackup(await file.text());
        if (!(await confirmDlg(`<p>Restore <b>${esc(file.name)}</b>?</p><p>All figures on this device will be replaced by the backup${configured ? ' (and synced to Drive)' : ''}.</p>`, 'Restore', 'danger'))) return;
        await repo.restore(regs);
        render();
        toast('Backup restored.');
      } catch (err) {
        toast(err.message);
      }
    }
  });
  document.addEventListener('submit', async (e) => {
    const f = e.target;
    if (f.dataset.form === 'unlock') {
      e.preventDefault();
      const pass = new FormData(f).get('pass');
      await sync.unlock(String(pass || ''));
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const t = e.target;
    if (!t.matches || !t.matches('#view input.amt, #view input.name')) return;
    e.preventDefault();
    const all = $$('#view input.amt, #view input.name');
    const next = all[all.indexOf(t) + 1];
    t.dispatchEvent(new Event('change', { bubbles: true }));
    if (next) next.focus(); else t.blur();
  });
  document.addEventListener('focusin', (e) => {
    if (e.target.matches && e.target.matches('input.amt')) setTimeout(() => e.target.select(), 0);
  });
  document.addEventListener('focusout', () => {
    setTimeout(() => { if (ui.needsRender && !focusedInput()) render(); }, 50);
  });

  for (const b of $$('.tabbar button')) {
    b.addEventListener('click', () => {
      ui.view = b.dataset.view;
      lsSet('view', ui.view);
      render();
      window.scrollTo(0, 0);
    });
  }
  $('#prevMonth').addEventListener('click', () => { if (ui.month > 0) { ui.month--; render(); } });
  $('#nextMonth').addEventListener('click', () => { if (ui.month < MONTHS - 1) { ui.month++; render(); } });
  $('#monthSelect').addEventListener('change', (e) => { ui.month = Number(e.target.value); render(); });
  $('#syncPill').addEventListener('click', () => { ui.view = 'settings'; render(); window.scrollTo(0, 0); });

  let rz = null;
  window.addEventListener('resize', () => {
    clearTimeout(rz);
    rz = setTimeout(() => { if (ui.view === 'summary' && !focusedInput()) render(); }, 200);
  });
  window.addEventListener('online', () => sync.sync());
  window.addEventListener('offline', () => { if (configured) sync.set({ status: 'offline' }); });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && configured) sync.sync();
  });
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); ui.installPrompt = e; if (ui.view === 'settings') render(); });
}

// ---------------------------------------------------------------------------
// Service worker (scope limited to this app's folder)
// ---------------------------------------------------------------------------
function registerSw() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('./sw.js', { scope: './' }).then((reg) => {
    const offer = (w) => { ui.updateReady = w; renderChrome(); };
    if (reg.waiting && navigator.serviceWorker.controller) offer(reg.waiting);
    reg.addEventListener('updatefound', () => {
      const w = reg.installing;
      w && w.addEventListener('statechange', () => {
        if (w.state === 'installed' && navigator.serviceWorker.controller) offer(w);
      });
    });
  }).catch(() => { /* offline support unavailable */ });
  let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (ui.updateReady && !reloaded) { reloaded = true; location.reload(); }
  });
}

window.__mbapp = { get repo() { return repo; }, get sync() { return sync; }, APP_ID };
boot().catch((e) => {
  document.body.insertAdjacentHTML('afterbegin', `<p class="banner bad">The app could not start: ${esc(e.message)}</p>`);
});
