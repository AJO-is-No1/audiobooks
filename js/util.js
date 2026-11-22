// Small shared helpers: formatting, escaping, settings and icons.

export const uid = () =>
  (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ESC[c]);

const pad2 = n => String(n).padStart(2, '0');

// 75 -> "1:15", 3725 -> "1:02:05"
export function fmtTime(sec) {
  const s = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  return h ? `${h}:${pad2(m)}:${pad2(x)}` : `${m}:${pad2(x)}`;
}

// 45 -> "45 s", 2220 -> "37 min", 4500 -> "1 h 15 min"
export function fmtLong(sec) {
  const s = Math.round(sec || 0);
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60), r = m % 60;
  return r ? `${h} h ${r} min` : `${h} h`;
}

export function fmtBytes(b) {
  if (b < 1e6) return `${Math.max(0, Math.round(b / 1e3))} KB`;
  if (b < 1e9) return `${Math.round(b / 1e6)} MB`;
  return `${(b / 1e9).toFixed(1)} GB`;
}

export function ago(ts) {
  if (!ts) return 'never';
  const days = Math.floor((startOfDay(Date.now()) - startOfDay(ts)) / 864e5);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 14) return `${days} days ago`;
  return new Date(ts).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}
const startOfDay = t => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };

export const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// "3 · Night camp", or "Chapter 3" when the chapter has no name.
export const chapterTitle = c => (c.name ? `${c.number} · ${c.name}` : `Chapter ${c.number}`);

// Per-device preferences. Storage can be unavailable (private mode), so never let it throw.
export const settings = {
  get(key, fallback) {
    try { const v = localStorage.getItem('ab:' + key); return v == null ? fallback : JSON.parse(v); } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem('ab:' + key, JSON.stringify(value)); } catch { /* ignore */ }
  },
};

export const icon = (name, cls = '') => `<svg class="ic ${cls}" aria-hidden="true"><use href="#i-${name}"/></svg>`;

// Stable colour for a book cover, picked from its title.
export function coverClass(title) {
  let h = 0;
  for (const ch of String(title)) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return 'cv' + (h % 6);
}
