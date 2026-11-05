// Inflows vs outflows (bars) with net cash flow (line), as inline SVG.
import { esc } from './format.js';

function niceStep(range) {
  const raw = range / 4;
  const p = Math.pow(10, Math.floor(Math.log10(raw || 1)));
  const n = raw / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p;
}

function compact(v) {
  const a = Math.abs(v);
  const s = a >= 1e6 ? (a / 1e6).toFixed(a >= 1e7 ? 0 : 1) + 'M' : a >= 1e3 ? (a / 1e3).toFixed(a >= 1e4 ? 0 : 1) + 'k' : String(Math.round(a));
  return (v < 0 ? '−' : '') + s.replace('.0', '');
}

/** Rounded-top bar anchored to the baseline (rounds the end away from zero). */
function bar(x, w, y0, y1) {
  const h = Math.abs(y1 - y0);
  if (h < 0.5) return '';
  const r = Math.min(4, w / 2, h);
  const top = Math.min(y0, y1);
  if (y1 <= y0) {
    return `M${x},${y0}V${top + r}Q${x},${top} ${x + r},${top}H${x + w - r}Q${x + w},${top} ${x + w},${top + r}V${y0}Z`;
  }
  return `M${x},${y0}V${y1 - r}Q${x},${y1} ${x + r},${y1}H${x + w - r}Q${x + w},${y1} ${x + w},${y1 - r}V${y0}Z`;
}

export function chartSvg(c, { width = 680, height = 300 } = {}) {
  const months = c.months;
  const vals = months.flatMap((m) => [m.inflow / 100, m.outflow / 100, m.net / 100]);
  let max = Math.max(0, ...vals);
  let min = Math.min(0, ...vals);
  if (max === min) max = 1000;
  const step = niceStep(max - min);
  max = Math.ceil(max / step) * step;
  min = Math.floor(min / step) * step;

  const L = 44, R = 8, T = 12, B = 28;
  const pw = width - L - R, ph = height - T - B;
  const y = (v) => T + ((max - v) / (max - min)) * ph;
  const col = pw / months.length;
  const bw = Math.max(3, Math.min(16, (col - 8) / 2));
  const parts = [];

  for (let v = min; v <= max + 1e-9; v += step) {
    parts.push(`<line class="grid${Math.abs(v) < 1e-9 ? ' zero' : ''}" x1="${L}" x2="${width - R}" y1="${y(v)}" y2="${y(v)}"/>`);
    parts.push(`<text class="tick" x="${L - 6}" y="${y(v) + 4}" text-anchor="end">${compact(v)}</text>`);
  }
  const y0 = y(0);
  months.forEach((m, i) => {
    const cx = L + col * i + col / 2;
    parts.push(`<path class="bar-in" d="${bar(cx - bw - 1, bw, y0, y(m.inflow / 100))}"/>`);
    parts.push(`<path class="bar-out" d="${bar(cx + 1, bw, y0, y(m.outflow / 100))}"/>`);
    if (i % (months.length > 6 && pw < 500 ? 2 : 1) === 0 || pw >= 500) {
      parts.push(`<text class="tick" x="${cx}" y="${height - 8}" text-anchor="middle">${esc(m.short.split(' ')[0])}</text>`);
    }
  });
  const pts = months.map((m, i) => [L + col * i + col / 2, y(m.net / 100)]);
  parts.push(`<polyline class="net-line" points="${pts.map((p) => p.join(',')).join(' ')}"/>`);
  pts.forEach(([px, py]) => parts.push(`<circle class="net-dot" cx="${px}" cy="${py}" r="4"/>`));
  months.forEach((m, i) => parts.push(`<rect class="hit" data-m="${i}" x="${L + col * i}" y="${T}" width="${col}" height="${ph}"><title>${esc(m.long)}</title></rect>`));

  return `<svg class="chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="Monthly inflows and outflows with net cash flow line">${parts.join('')}</svg>`;
}
