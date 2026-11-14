// Money is stored as integer fils (1 JD = 1000 fils). Dates are local "YYYY-MM-DD" strings.

export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

/** Parse a user-typed amount ("13.15", "13,150", "20") into integer fils. Returns NaN if invalid. */
export function toFils(input) {
  if (typeof input === 'number') return Math.round(input * 1000);
  let s = String(input ?? '').trim()
    .replace(/[٠-٩]/g, d => '٠١٢٣٤٥٦٧٨٩'.indexOf(d))
    .replace(/٫/g, '.').replace(/,/g, '.').replace(/[^\d.\-]/g, '');
  if (!s || !/^-?\d*(\.\d*)?$/.test(s) || s === '.' || s === '-') return NaN;
  const neg = s.startsWith('-');
  if (neg) s = s.slice(1);
  const [i, f = ''] = s.split('.');
  const fils = parseInt(i || '0', 10) * 1000 + parseInt((f + '000').slice(0, 3), 10);
  return neg ? -fils : fils;
}

/** Always 3 decimals: 13150 -> "13.150" */
export function jd(fils) {
  const n = Math.round(fils || 0);
  const neg = n < 0;
  const a = Math.abs(n);
  return (neg ? '-' : '') + Math.floor(a / 1000) + '.' + String(a % 1000).padStart(3, '0');
}

/** His note style: trims trailing zeros. 13150 -> "13.15", 20000 -> "20" */
export function jdShort(fils) {
  return jd(fils).replace(/\.?0+$/, '');
}

export const pad = n => String(n).padStart(2, '0');
export const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const today = () => ymd(new Date());
export const parseYmd = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
export const monthKey = s => s.slice(0, 7);
export const thisMonth = () => today().slice(0, 7);
export function addMonths(ym, n) {
  let [y, m] = ym.split('-').map(Number);
  m += n; while (m > 12) { m -= 12; y++; } while (m < 1) { m += 12; y--; }
  return `${y}-${pad(m)}`;
}
export function addMonthsDate(s, n) {
  const [y, m, d] = s.split('-').map(Number);
  const ym = addMonths(`${y}-${pad(m)}`, n);
  const [ny, nm] = ym.split('-').map(Number);
  const last = new Date(ny, nm, 0).getDate();
  return `${ym}-${pad(Math.min(d, last))}`;
}
export const daysBetween = (a, b) => Math.round((parseYmd(b) - parseYmd(a)) / 86400000);
export const daysInMonth = ym => { const [y, m] = ym.split('-').map(Number); return new Date(y, m, 0).getDate(); };

export const EN_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export const AR_MONTHS = ['كانون الثاني', 'شباط', 'آذار', 'نيسان', 'أيار', 'حزيران', 'تموز', 'آب', 'أيلول', 'تشرين الأول', 'تشرين الثاني', 'كانون الأول'];
export const AR_DAYS = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];

export function monthLabel(ym) { const [y, m] = ym.split('-').map(Number); return `${AR_MONTHS[m - 1]} ${y}`; }
/** One date style everywhere: "السبت 14 تشرين الثاني 2026" */
export function dayLabel(s) { const d = parseYmd(s); return `${AR_DAYS[d.getDay()]} ${d.getDate()} ${AR_MONTHS[d.getMonth()]} ${d.getFullYear()}`; }
/** Short form where space is tight: "14 تشرين الثاني" (+ year if not this year) */
export function dateShort(s) { if (!s) return ''; const d = parseYmd(s); return `${d.getDate()} ${AR_MONTHS[d.getMonth()]}${d.getFullYear() !== new Date().getFullYear() ? ' ' + d.getFullYear() : ''}`; }

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}
