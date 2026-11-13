export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[ch]));
}

export function safeColor(value) {
  return /^#[0-9a-fA-F]{6}$/.test(value || '') ? value : '#ea580c';
}

/** Black or white text that stays readable on a profile colour. */
export function inkFor(hex) {
  const h = safeColor(hex).slice(1);
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return (r * 299 + g * 587 + b * 114) / 1000 > 160 ? '#1c1917' : '#ffffff';
}

export function money(amount) {
  const value = Number(amount);
  const n = Number.isFinite(value) ? value : 0;
  return new Intl.NumberFormat('en-NZ', { style: 'currency', currency: 'NZD' }).format(n);
}

export function addDays(ymd, days) {
  const [y, m, d] = String(ymd).split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

export function formatDate(ymd, today) {
  if (!ymd) return '';
  if (today && ymd === today) return 'Today';
  if (today && ymd === addDays(today, 1)) return 'Tomorrow';
  if (today && ymd === addDays(today, -1)) return 'Yesterday';
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d, 12));
  return new Intl.DateTimeFormat('en-NZ', {
    timeZone: 'Pacific/Auckland',
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  }).format(dt);
}

export function formatStamp(iso) {
  if (!iso) return '';
  const dt = new Date(iso);
  if (Number.isNaN(dt.getTime())) return '';
  return new Intl.DateTimeFormat('en-NZ', {
    timeZone: 'Pacific/Auckland',
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
  }).format(dt);
}

export function lockClock(until) {
  if (!until) return '';
  const ms = new Date(until).getTime() - Date.now();
  if (ms <= 0) return '';
  const total = Math.ceil(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function safeUrl(value) {
  if (!value) return '';
  try {
    const url = new URL(value);
    if (url.protocol === 'http:' || url.protocol === 'https:') return url.href;
  } catch {
    /* not a url */
  }
  return '';
}

export const WEEKDAYS = [
  { n: 1, short: 'Mon', tiny: 'M' },
  { n: 2, short: 'Tue', tiny: 'T' },
  { n: 3, short: 'Wed', tiny: 'W' },
  { n: 4, short: 'Thu', tiny: 'T' },
  { n: 5, short: 'Fri', tiny: 'F' },
  { n: 6, short: 'Sat', tiny: 'S' },
  { n: 7, short: 'Sun', tiny: 'S' },
];

export function repeatLabel(chore, today) {
  if (chore.repeat === 'daily') return 'Every day';
  if (chore.repeat === 'weekly') {
    const names = (chore.weekdays || []).map((n) => WEEKDAYS.find((d) => d.n === Number(n))?.short).filter(Boolean);
    return names.length ? `Weekly · ${names.join(', ')}` : 'Weekly';
  }
  if (chore.due_date) return `Once · due ${formatDate(chore.due_date, today)}`;
  return 'Once · anytime';
}

export function pointsWord(n, simple) {
  const v = Number(n) || 0;
  if (simple) return `${v} ⭐`;
  const abs = Math.abs(v);
  return `${v} point${abs === 1 ? '' : 's'}`;
}
