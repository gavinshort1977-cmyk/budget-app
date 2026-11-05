import { CURRENCY } from './constants.js';

const nf0 = new Intl.NumberFormat('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 });

/** fils -> "1,234.5" (no currency) */
export function num(fils) {
  if (fils === null || fils === undefined) return '';
  return nf0.format(fils / 100);
}

/** fils -> "AED 1,234" ; negatives as "−AED 1,234" */
export function money(fils, { round = true } = {}) {
  if (fils === null || fils === undefined) return '—';
  const v = round ? Math.round(fils / 100) : fils / 100;
  const s = new Intl.NumberFormat('en-US', { maximumFractionDigits: round ? 0 : 2 }).format(Math.abs(v));
  return (v < 0 ? '−' : '') + CURRENCY + ' ' + s;
}

export function pct(x) {
  if (x === null || x === undefined || !isFinite(x)) return '—';
  return (Math.round(x * 1000) / 10).toFixed(1) + '%';
}

/**
 * Parse what the user typed into fils. Accepts "1,250", "1250.5", "AED 300",
 * and simple sums like "1200+350-50". Returns null for empty, NaN for invalid.
 */
export function parseAmount(input) {
  let s = String(input ?? '').replace(/aed/gi, '').replace(/[,\s ]/g, '').replace(/[−–]/g, '-');
  if (s === '') return null;
  const n = '(\\d+\\.?\\d*|\\.\\d+)';
  if (!new RegExp(`^[-+]?${n}([-+]${n})*$`).test(s)) return NaN;
  const terms = s.match(/[-+]?[^-+]+/g) || [];
  let total = 0;
  for (const t of terms) {
    const n = Number(t);
    if (!isFinite(n)) return NaN;
    total += Math.round(n * 100);
  }
  return total;
}

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function timeAgo(ts) {
  if (!ts) return 'never';
  const d = new Date(ts);
  const sameDay = new Date().toDateString() === d.toDateString();
  return sameDay
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}
