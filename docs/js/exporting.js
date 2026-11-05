// JSON backup / restore and CSV export.
import { APP_ID, FILE_FORMAT, MONTHS } from './constants.js';
import { compute } from './calc.js';

export function makeBackup(regs) {
  return JSON.stringify({ app: APP_ID, kind: 'backup', format: FILE_FORMAT, exportedAt: new Date().toISOString(), regs }, null, 1);
}

export function parseBackup(text) {
  let j;
  try { j = JSON.parse(text); } catch { throw new Error('That file is not a valid backup (not JSON).'); }
  if (!j || j.app !== APP_ID) throw new Error('That file is not a Monthly Budget backup.');
  if (j.encrypted) throw new Error('That is the encrypted Drive file, not a backup. Use "Save backup" to make a backup.');
  if (!j.regs || typeof j.regs !== 'object') throw new Error('The backup has no data.');
  for (const [k, r] of Object.entries(j.regs)) {
    if (typeof k !== 'string' || !r || typeof r.t !== 'number' || !('v' in r)) throw new Error('The backup is damaged.');
  }
  return j.regs;
}

function cell(x) {
  if (x === null || x === undefined) return '';
  if (typeof x === 'number') return String(x);
  let s = String(x);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // stop spreadsheet formula injection
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
const aed = (fils) => (fils === null || fils === undefined ? '' : Math.round(fils) / 100);

export function makeCsv(model) {
  const c = compute(model);
  const rows = [];
  rows.push(['Section', 'Group', 'Line', ...c.labels.map((l) => l.long), '12-month total', 'Share of income']);
  for (const g of model.groups) {
    const section = g.kind === 'in' ? 'Inflows' : 'Outflows';
    for (const l of g.lines) {
      const vals = [];
      for (let m = 0; m < MONTHS; m++) vals.push(aed(model.amount(l.id, m)));
      rows.push([section, g.name, l.name, ...vals, aed(c.totals.lines[l.id] || 0), '']);
    }
    rows.push([section, g.name, `${g.name} subtotal`, ...c.months.map((mo) => aed(mo.groups[g.id])), aed(c.totals.groups[g.id]),
      c.totals.share[g.id] === null ? '' : (Math.round(c.totals.share[g.id] * 1000) / 10) + '%']);
  }
  rows.push([]);
  const line = (name, key, total) => rows.push(['Summary', '', name, ...c.months.map((mo) => (key === 'savingsRate' ? (mo[key] === null ? '' : Math.round(mo[key] * 1000) / 10 + '%') : aed(mo[key]))), total]);
  line('Total inflows', 'inflow', aed(c.totals.inflow));
  line('Total outflows', 'outflow', aed(c.totals.outflow));
  line('Net cash flow', 'net', aed(c.totals.net));
  line('Savings rate', 'savingsRate', c.totals.savingsRate === null ? '' : Math.round(c.totals.savingsRate * 1000) / 10 + '%');
  line('Opening balance', 'opening', '');
  line('Closing balance', 'closing', '');
  line('Total funds', 'totalFunds', '');
  rows.push([]);
  rows.push(['Accounts', 'Account', 'Counts as day-to-day cash', 'Starting balance', ...c.labels.map((l) => `${l.long} actual`)]);
  for (const a of model.accounts) {
    const acts = [];
    for (let m = 0; m < MONTHS; m++) acts.push(aed(model.actual(a.id, m)));
    rows.push(['Accounts', a.name, a.daily ? 'Yes' : 'No', aed(a.start), ...acts]);
  }
  rows.push([]);
  rows.push(['Note', '', 'Amounts in AED']);
  return '﻿' + rows.map((r) => r.map(cell).join(',')).join('\r\n');
}
