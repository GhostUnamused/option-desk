// Small shared helpers: formatting, DOM building, API calls, toasts.
import { now } from './bs.js';

export const inr0 = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });
export const inr2 = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const cfmt = (v, d) => (Math.round(v * 10 ** d) / 10 ** d).toString();
// Indian short form: 950, 25.8K, 4.8L (lakh), 1.2Cr (crore).
export const compact = { format: (v) => { const a = Math.abs(v), s = v < 0 ? '−' : ''; return a >= 1e7 ? s + cfmt(a / 1e7, 2) + 'Cr' : a >= 1e5 ? s + cfmt(a / 1e5, 1) + 'L' : a >= 1e3 ? s + cfmt(a / 1e3, 1) + 'K' : s + Math.round(a); } };

export const rs = (v) => (v < 0 ? '−₹' : '₹') + inr0.format(Math.abs(v));
export const rs2 = (v) => (v < 0 ? '−₹' : '₹') + inr2.format(Math.abs(v));
export const srs = (v) => (v > 0 ? '+' : v < 0 ? '−' : '') + '₹' + inr0.format(Math.abs(v));
export const sgn = (v, f = inr2.format) => (v > 0 ? '+' : v < 0 ? '−' : '') + f(Math.abs(v));
export const pct = (v, d = 2) => (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toFixed(d) + '%';
export const tone = (v) => (v > 0 ? 'up' : v < 0 ? 'down' : '');
export const pts = (v) => inr0.format(v);
// India VIX bands, used by the header and the market read.
export const vixMood = (v) => v < 13 ? { key: 'calm', label: 'Calm', hint: 'Traders expect small moves. Options are cheap.' }
  : v < 18 ? { key: 'normal', label: 'Normal', hint: 'Usual amount of expected movement.' }
  : v < 24 ? { key: 'nervous', label: 'Nervous', hint: 'Traders expect bigger swings. Options are pricier.' }
  : { key: 'fearful', label: 'Fearful', hint: 'Traders expect large swings. Options are expensive and prices jump around.' };

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const fmtExpiry = (iso) => { const [y, m, d] = iso.split('-'); return `${+d} ${MONTHS[+m - 1]}${y !== String(new Date(now()).getFullYear()) ? ' ' + y : ''}`; };
export const fmtExpiryLong = (iso) => new Date(iso + 'T00:00:00Z').toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
export const daysTo = (iso) => (Date.parse(iso + 'T15:30:00+05:30') - now()) / 864e5;
export const fmtDay = (iso, opts = {}) => new Date(iso + 'T00:00:00Z').toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC', ...opts });
export const fmtLeft = (iso) => { const d = daysTo(iso); return d <= 0 ? 'expired' : d < 1 ? `${Math.max(0, d * 24).toFixed(1)} h left` : `${d.toFixed(1)} days left`; };
export const fmtTime = (ms) => new Date(ms).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
// Replay orders all happen "at the close", so show their day instead of a clock time.
export const fmtWhen = (ms, replay) => (replay ? new Date(ms).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' }) : fmtTime(ms));

export function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(e.style, v);
    else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) e.append(c);
  return e;
}
export const $ = (s, root = document) => root.querySelector(s);
export const $$ = (s, root = document) => [...root.querySelectorAll(s)];

export async function api(path, body) {
  const res = await fetch(path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
  const j = await res.json().catch(() => ({ error: `Server answered ${res.status}` }));
  if (!res.ok || j.error) throw new Error(j.error || `Server answered ${res.status}`);
  return j;
}

export function toast(msg, kind = 'info') {
  const box = $('#toasts');
  const t = el('div', { class: `toast ${kind}`, role: 'status', text: msg });
  box.append(t);
  setTimeout(() => t.classList.add('out'), 3800);
  setTimeout(() => t.remove(), 4300);
}

export const store = {
  get(k, d) { try { const v = localStorage.getItem('desk:' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('desk:' + k, JSON.stringify(v)); } catch {} },
};

export const instrument = (l) => `${l.symbol} ${fmtExpiry(l.expiry)} ${inr0.format(l.strike)} ${l.type}`;

// Theme colors read from CSS tokens, for canvas charts.
export function themeColors() {
  const cs = getComputedStyle(document.documentElement);
  const g = (n) => cs.getPropertyValue(n).trim();
  return { bg: g('--panel'), fg: g('--fg'), muted: g('--muted'), line: g('--line'), grid: g('--grid'), accent: g('--accent'), up: g('--up'), down: g('--down'), band: g('--band'), warn: g('--warn') };
}

export function stdev(arr) { const m = arr.reduce((a, b) => a + b, 0) / arr.length; return Math.sqrt(arr.reduce((a, b) => a + (b - m) ** 2, 0) / (arr.length - 1)); }
export const sma = (arr, n) => arr.map((_, i) => (i + 1 < n ? null : arr.slice(i + 1 - n, i + 1).reduce((a, b) => a + b, 0) / n));
