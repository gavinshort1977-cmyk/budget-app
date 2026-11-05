// Budget maths. All money is integer fils (1 AED = 100 fils) to avoid rounding drift.
import { MONTHS } from './constants.js';

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function parseStart(start) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(start || ''));
  if (!m) return { year: 2026, month: 9 };
  const month = Math.min(11, Math.max(0, Number(m[2]) - 1));
  return { year: Number(m[1]), month };
}

/** Labels for the 12 months starting at `start` ("YYYY-MM"). */
export function monthLabels(start) {
  const { year, month } = parseStart(start);
  const out = [];
  for (let i = 0; i < MONTHS; i++) {
    const mm = (month + i) % 12;
    const yy = year + Math.floor((month + i) / 12);
    out.push({ index: i, short: `${MONTH_NAMES[mm]} ${String(yy).slice(2)}`, long: `${MONTH_NAMES[mm]} ${yy}`, iso: `${yy}-${String(mm + 1).padStart(2, '0')}` });
  }
  return out;
}

/**
 * Compute everything the summary needs.
 *
 * Rules:
 * - Net cash flow = inflows − outflows (savings transfers count as outflows).
 * - Savings rate = (savings-group outflows + net cash flow) ÷ inflows.
 * - Opening balance of month 1 = sum of starting balances of day-to-day accounts.
 * - Planned closing = opening + net cash flow.
 * - If a month-end actual is entered for EVERY day-to-day account in a month,
 *   their sum becomes that month's closing balance (and the next opening).
 *   Otherwise the planned closing is carried forward.
 * - Other (non-day-to-day) accounts: actual balance if entered, else last value
 *   plus any amounts from budget lines linked to that account.
 * - Total funds = day-to-day closing + all other accounts.
 */
export function compute(model) {
  const labels = monthLabels(model.start);
  const daily = model.accounts.filter((a) => a.daily);
  const others = model.accounts.filter((a) => !a.daily);
  const groupIds = model.groups.map((g) => g.id);

  const totals = { inflow: 0, outflow: 0, net: 0, savings: 0, groups: Object.fromEntries(groupIds.map((id) => [id, 0])), lines: {} };
  const months = [];
  let opening = daily.reduce((s, a) => s + a.start, 0);
  const otherValue = Object.fromEntries(others.map((a) => [a.id, a.start]));
  const accountSeries = Object.fromEntries(model.accounts.map((a) => [a.id, []]));

  for (let m = 0; m < MONTHS; m++) {
    const groups = {};
    const linked = {};
    let inflow = 0, outflow = 0, savings = 0;
    for (const g of model.groups) {
      let sub = 0;
      for (const l of g.lines) {
        const a = model.amount(l.id, m) || 0;
        sub += a;
        totals.lines[l.id] = (totals.lines[l.id] || 0) + a;
        if (l.acct && g.kind === 'out') linked[l.acct] = (linked[l.acct] || 0) + a;
      }
      groups[g.id] = sub;
      totals.groups[g.id] += sub;
      if (g.kind === 'in') inflow += sub;
      else {
        outflow += sub;
        if (g.savings) savings += sub;
      }
    }
    const net = inflow - outflow;
    const closingPlanned = opening + net;
    const dailyActuals = daily.map((a) => model.actual(a.id, m));
    const actualComplete = daily.length > 0 && dailyActuals.every((x) => x !== null);
    const actualCount = dailyActuals.filter((x) => x !== null).length;
    const actualDaily = actualComplete ? dailyActuals.reduce((s, x) => s + x, 0) : null;
    const closing = actualComplete ? actualDaily : closingPlanned;

    let othersTotal = 0;
    for (const a of others) {
      const act = model.actual(a.id, m);
      otherValue[a.id] = act !== null ? act : otherValue[a.id] + (linked[a.id] || 0);
      othersTotal += otherValue[a.id];
      accountSeries[a.id].push({ value: otherValue[a.id], actual: act !== null });
    }
    daily.forEach((a, i) => accountSeries[a.id].push({ value: dailyActuals[i], actual: dailyActuals[i] !== null }));

    months.push({
      ...labels[m], inflow, outflow, net, savings,
      savingsRate: inflow > 0 ? (savings + net) / inflow : null,
      opening, closingPlanned, closing, actualComplete, actualCount, actualDaily,
      variance: actualComplete ? actualDaily - closingPlanned : null,
      othersTotal, totalFunds: closing + othersTotal, groups,
    });
    totals.inflow += inflow;
    totals.outflow += outflow;
    totals.savings += savings;
    opening = closing;
  }
  totals.net = totals.inflow - totals.outflow;
  totals.savingsRate = totals.inflow > 0 ? (totals.savings + totals.net) / totals.inflow : null;
  totals.share = Object.fromEntries(groupIds.map((id) => [id, totals.inflow > 0 ? totals.groups[id] / totals.inflow : null]));
  totals.openingStart = months[0].opening;
  totals.closingEnd = months[MONTHS - 1].closing;
  totals.totalFundsEnd = months[MONTHS - 1].totalFunds;
  return { labels, months, totals, accountSeries };
}

export function share(part, whole) {
  return whole > 0 ? part / whole : null;
}
