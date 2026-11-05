// All figures below are invented test data.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildModel, defaultRegs } from '../../docs/js/doc.js';
import { compute, monthLabels } from '../../docs/js/calc.js';
import { parseAmount, money, pct } from '../../docs/js/format.js';
import { makeCsv, makeBackup, parseBackup } from '../../docs/js/exporting.js';

function regsWith(values, start) {
  const r = defaultRegs(start);
  let t = 10;
  for (const [k, v] of Object.entries(values)) r[k] = { v, t: t++, d: 'test' };
  return r;
}
const AED = (x) => Math.round(x * 100);

test('month labels follow the start month, default October 2026', () => {
  const l = monthLabels('2026-10');
  assert.equal(l[0].long, 'Oct 2026');
  assert.equal(l[2].long, 'Dec 2026');
  assert.equal(l[3].long, 'Jan 2027');
  assert.equal(l[11].long, 'Sep 2027');
  const l2 = monthLabels('2027-01');
  assert.equal(l2[0].long, 'Jan 2027');
  assert.equal(l2[11].long, 'Dec 2027');
  assert.equal(buildModel(defaultRegs()).start, '2026-10');
});

test('changing the start month relabels months but keeps amounts by month index', () => {
  const r = regsWith({ 'v:l-salary:0': AED(1000) }, '2026-10');
  const a = compute(buildModel(r));
  assert.equal(a.months[0].long, 'Oct 2026');
  assert.equal(a.months[0].inflow, AED(1000));
  r['s:start'] = { v: '2027-03', t: 99, d: 'test' };
  const b = compute(buildModel(r));
  assert.equal(b.months[0].long, 'Mar 2027');
  assert.equal(b.months[0].inflow, AED(1000));
  assert.equal(b.months[11].long, 'Feb 2028');
});

test('subtotals, net cash flow, savings rate, share of income', () => {
  const r = regsWith({
    'v:l-salary:0': AED(20000), 'v:l-bonus:0': AED(5000),
    'v:l-rent:0': AED(6000), 'v:l-dewa:0': AED(800.5), 'v:l-salik:0': AED(200),
    'v:l-groceries:0': AED(2500), 'v:l-sv-ret:0': AED(3000), 'v:l-sv-kids:0': AED(1000),
  });
  const c = compute(buildModel(r));
  const m = c.months[0];
  assert.equal(m.inflow, AED(25000));
  assert.equal(m.groups['g-housing'], AED(6800.5));
  assert.equal(m.groups['g-transport'], AED(200));
  assert.equal(m.groups['g-savings'], AED(4000));
  assert.equal(m.outflow, AED(6800.5 + 200 + 2500 + 4000));
  assert.equal(m.net, AED(25000 - 13500.5));
  // savings rate = (savings + net) / income
  assert.ok(Math.abs(m.savingsRate - (4000 + 11499.5) / 25000) < 1e-9);
  assert.ok(Math.abs(c.totals.share['g-housing'] - 6800.5 / 25000) < 1e-9);
  assert.equal(c.totals.inflow, AED(25000));
  assert.equal(c.months[1].savingsRate, null); // no income in month 2
});

test('opening and closing balances carry forward; only day-to-day accounts feed opening', () => {
  const r = regsWith({
    'a:a-hsbc:start': AED(10000), 'a:a-enbd:start': AED(5000),
    'a:a-sarwa-ret:start': AED(50000), // not day-to-day
    'v:l-salary:0': AED(20000), 'v:l-rent:0': AED(8000),
    'v:l-salary:1': AED(20000), 'v:l-rent:1': AED(25000),
  });
  const c = compute(buildModel(r));
  assert.equal(c.months[0].opening, AED(15000));
  assert.equal(c.months[0].closing, AED(27000));
  assert.equal(c.months[1].opening, AED(27000));
  assert.equal(c.months[1].closing, AED(22000));
  assert.equal(c.months[2].opening, AED(22000));
  assert.equal(c.months[11].closing, AED(22000));
  // total funds includes all accounts
  assert.equal(c.months[0].totalFunds, AED(27000 + 50000));
});

test('month-end actuals replace the carried balance only when all day-to-day accounts are entered', () => {
  const base = {
    'a:a-hsbc:start': AED(10000), 'a:a-enbd:start': AED(0),
    'v:l-salary:0': AED(10000), 'v:l-rent:0': AED(4000),
  };
  let c = compute(buildModel(regsWith({ ...base, 'b:a-hsbc:0': AED(15000) })));
  assert.equal(c.months[0].actualComplete, false);
  assert.equal(c.months[0].closing, AED(16000));
  c = compute(buildModel(regsWith({ ...base, 'b:a-hsbc:0': AED(15000), 'b:a-enbd:0': AED(500) })));
  assert.equal(c.months[0].actualComplete, true);
  assert.equal(c.months[0].closing, AED(15500));
  assert.equal(c.months[0].variance, AED(-500));
  assert.equal(c.months[1].opening, AED(15500));
});

test('linked savings lines grow the Sarwa accounts; actuals override projections', () => {
  const r = regsWith({
    'a:a-sarwa-ret:start': AED(1000),
    'v:l-sv-ret:0': AED(500), 'v:l-sv-ret:1': AED(500), 'v:l-sv-ret:2': AED(500),
    'b:a-sarwa-ret:1': AED(2200),
  });
  const c = compute(buildModel(r));
  const s = c.accountSeries['a-sarwa-ret'];
  assert.equal(s[0].value, AED(1500));
  assert.equal(s[1].value, AED(2200));
  assert.equal(s[1].actual, true);
  assert.equal(s[2].value, AED(2700));
});

test('deleted groups and lines drop out of totals', () => {
  const r = regsWith({ 'v:l-salary:0': AED(100), 'v:l-rent:0': AED(40), 'v:l-fuel:0': AED(10), 'g:g-housing:del': true, 'l:l-fuel:del': true });
  const c = compute(buildModel(r));
  assert.equal(c.months[0].outflow, 0);
  assert.equal(c.months[0].net, AED(100));
});

test('parseAmount handles commas, AED, sums and rejects junk', () => {
  assert.equal(parseAmount('1,250.50'), 125050);
  assert.equal(parseAmount('AED 300'), 30000);
  assert.equal(parseAmount('1200+350-50'), 150000);
  assert.equal(parseAmount(''), null);
  assert.equal(parseAmount('  '), null);
  assert.ok(Number.isNaN(parseAmount('abc')));
  assert.ok(Number.isNaN(parseAmount('1..2')));
  assert.equal(parseAmount('-20'), -2000);
  assert.equal(money(-123456), '−AED 1,235');
  assert.equal(pct(0.1234), '12.3%');
});

test('defaults contain the required groups, lines and accounts — and no amounts', () => {
  const r = defaultRegs();
  const m = buildModel(r);
  assert.deepEqual(m.outflowGroups.map((g) => g.name), ['Housing', 'Transport', 'Daily living', 'Family', 'Health and insurance', 'Lifestyle', 'Debt', 'Savings and investing', 'Other']);
  assert.deepEqual(m.inflowGroups[0].lines.map((l) => l.name), ["Salary or owner's draw", 'Bonus', 'Freelance income', 'Rental income', 'Investment income', 'Other income']);
  const names = m.groups.flatMap((g) => g.lines.map((l) => l.name)).join('|');
  assert.match(names, /DEWA/); assert.match(names, /Chiller/); assert.match(names, /Salik/);
  const sav = m.outflowGroups.find((g) => g.savings).lines;
  for (const n of ['Sarwa Invest - Retirement', 'Sarwa Invest - Kids Fund', 'Sarwa Savings']) assert.ok(sav.find((l) => l.name === n && l.acct));
  assert.deepEqual(m.accounts.map((a) => [a.name, a.daily]), [['HSBC', true], ['ENBD', true], ['Sarwa Invest - Retirement', false], ['Sarwa Invest - Kids Fund', false], ['Sarwa Savings', false]]);
  assert.equal(Object.keys(r).filter((k) => k.startsWith('v:') || k.startsWith('b:')).length, 0);
  assert.ok(m.accounts.every((a) => a.start === 0));
});

test('CSV export uses 12-month total and guards against formula injection', () => {
  const r = regsWith({ 'v:l-salary:0': AED(1000), 'l:l-bonus:name': '=HYPERLINK("x")' });
  const csv = makeCsv(buildModel(r));
  assert.match(csv, /12-month total/);
  assert.match(csv, /Oct 2026/);
  assert.match(csv, /'=HYPERLINK/);
  assert.match(csv, /Salary or owner's draw,1000,/);
});

test('backup round-trip and validation', () => {
  const r = regsWith({ 'v:l-salary:0': AED(1) });
  assert.deepEqual(parseBackup(makeBackup(r)), r);
  assert.throws(() => parseBackup('{"app":"other-app","regs":{}}'), /not a Monthly Budget backup/);
  assert.throws(() => parseBackup('nope'), /not JSON/);
});
