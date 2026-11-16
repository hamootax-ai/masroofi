// Pure business logic: balances, month stats, card cycle, projection, advice, note parsing.
import { jd, jdShort, toFils, today, monthKey, addMonths, addMonthsDate, daysBetween, daysInMonth, parseYmd, ymd, pad, EN_MONTHS, AR_MONTHS, AR_MONTHS_LEVANT, uid, dateShort, nDays } from './util.js';

export const ACCOUNTS = { cash: 'كاش', card: 'بطاقة', savings: 'توفير', none: 'ما تخصم من الحسابات' };
// 'none' = opening entry: counts in day/month/category/rafah totals but never touches an account.

// kind drives the built-in rules (necessary / judged / never judged)
export const DEFAULT_CATEGORIES = [
  { id: 'groceries', name: 'بقالة', icon: '🛒', kind: 'need' },
  { id: 'gas', name: 'بنزين', icon: '⛽', kind: 'need' },
  { id: 'bills', name: 'فواتير', icon: '🧾', kind: 'need', subs: ['ماء', 'كهرباء', 'فايبر', 'خط', 'ضمان'] },
  { id: 'farm', name: 'المزرعة', icon: '🌱', kind: 'need', subs: ['راتب عامل', 'مواد'] },
  { id: 'health', name: 'صحة وصيدلية', icon: '💊', kind: 'need' },
  { id: 'clothes', name: 'ملابس', icon: '👕', kind: 'judge' },
  { id: 'home', name: 'البيت', icon: '🏠', kind: 'judge' },
  { id: 'cats', name: 'القطط والبيطري', icon: '🐈', kind: 'need' },
  { id: 'car', name: 'السيارة', icon: '🚗', kind: 'need' },
  { id: 'sadaqa', name: 'صدقة', icon: '🤲', kind: 'sadaqa' },
  { id: 'debt', name: 'سداد ديون', icon: '💳', kind: 'need' },
  { id: 'papers', name: 'أوراق ومعاملات', icon: '📄', kind: 'need' },
  { id: 'work', name: 'أدوات شغل واشتراكات', icon: '🛠️', kind: 'need' },
  { id: 'rafah', name: 'رفاهية', icon: '🎉', kind: 'judge', rafah: true },
  { id: 'other', name: 'أخرى', icon: '📦', kind: 'judge' },
].map((c, i) => ({ rafah: false, subs: [], ...c, order: i }));

const KEYWORDS = {
  gas: ['gas', 'gasoline', 'petrol', 'fuel', 'benzine', 'benzin', 'diesel', 'بنزين', 'ديزل', 'سولار', 'محروقات'],
  groceries: ['groceries', 'grocery', 'market', 'supermarket', 'bread', 'vegetables', 'veggies', 'fruit', 'meat', 'chicken', 'eggs', 'milk', 'بقالة', 'سوبرماركت', 'سوق', 'خضار', 'خبز', 'فواكه', 'لحمة', 'جاج', 'دجاج', 'بيض', 'حليب', 'مول'],
  bills: ['bill', 'bills', 'water', 'electricity', 'electric', 'fiber', 'fibre', 'internet', 'line', 'mobile', 'recharge', 'zain', 'orange', 'umniah', 'social security', 'daman', 'فاتورة', 'فواتير', 'مي', 'ميه', 'ماء', 'كهربا', 'كهرباء', 'فايبر', 'انترنت', 'خط', 'شحن', 'زين', 'امنية', 'أمنية', 'اورنج', 'ضمان'],
  farm: ['farm', 'worker', 'fertilizer', 'seeds', 'irrigation', 'مزرعة', 'المزرعة', 'عامل', 'سماد', 'بذور', 'ري', 'مواد'],
  health: ['pharmacy', 'medicine', 'meds', 'doctor', 'clinic', 'hospital', 'lab', 'dentist', 'gym', 'vitamins', 'صيدلية', 'دوا', 'دواء', 'دكتور', 'طبيب', 'عيادة', 'مستشفى', 'مختبر', 'اسنان', 'جيم', 'نادي'],
  clothes: ['clothes', 'shirt', 'shoes', 'pants', 'jacket', 'ملابس', 'اواعي', 'أواعي', 'بوط', 'قميص', 'بنطلون', 'جاكيت'],
  home: ['home', 'house', 'cleaning', 'detergent', 'furniture', 'البيت', 'بيت', 'منظفات', 'تنظيف', 'اثاث'],
  cats: ['cat', 'cats', 'vet', 'litter', 'cat food', 'قطط', 'قطة', 'بيطري', 'رمل'], // (v1.7) not 'بس': in everyday Arabic it means "but/only", so ordinary sentences went to the cats
  car: ['car', 'oil change', 'tire', 'tyre', 'mechanic', 'car wash', 'service', 'parking', 'سيارة', 'السيارة', 'ميكانيكي', 'زيت', 'كوشوك', 'غسيل', 'صيانة', 'بنشر'],
  sadaqa: ['sadaqa', 'sadaka', 'charity', 'zakat', 'donation', 'صدقة', 'زكاة', 'تبرع'],
  debt: ['debt', 'loan', 'repay', 'installment', 'دين', 'ديون', 'سداد', 'قسط', 'سلفة'],
  papers: ['papers', 'license', 'licence', 'fees', 'government', 'passport', 'stamp', 'أوراق', 'معاملة', 'معاملات', 'رخصة', 'ترخيص', 'رسوم', 'جواز'],
  work: ['subscription', 'tools', 'tool', 'claude', 'chatgpt', 'openai', 'adobe', 'software', 'hosting', 'domain', 'اشتراك', 'اشتراكات', 'أدوات', 'ادوات', 'برنامج'],
  rafah: ['coffee', 'cafe', 'restaurant', 'shawarma', 'burger', 'pizza', 'takeaway', 'delivery', 'cinema', 'game', 'games', 'snack', 'snacks', 'sweets', 'dessert', 'argeeleh', 'hookah', 'outing', 'rafah', 'rafaheyah', 'قهوة', 'كافيه', 'مطعم', 'شاورما', 'برغر', 'بيتزا', 'توصيل', 'سينما', 'لعبة', 'سناك', 'حلو', 'حلويات', 'ارجيلة', 'أرجيلة', 'طلعة', 'رفاهية'],
};

const BILL_SUBS = { 'ماء': ['water', 'مي', 'ميه', 'ماء'], 'كهرباء': ['electricity', 'electric', 'كهربا', 'كهرباء'], 'فايبر': ['fiber', 'fibre', 'internet', 'فايبر', 'انترنت'], 'خط': ['line', 'mobile', 'recharge', 'zain', 'orange', 'umniah', 'خط', 'شحن', 'زين', 'امنية', 'أمنية', 'اورنج'], 'ضمان': ['social security', 'daman', 'ضمان'] };
const FARM_SUBS = { 'راتب عامل': ['worker', 'عامل'], 'مواد': ['fertilizer', 'seeds', 'سماد', 'بذور', 'مواد'] };

function kwMatch(text, kw) {
  if (/[a-z]/i.test(kw)) return new RegExp(`(^|[^a-z])${kw.replace(/ /g, '\\s+')}(e?s)?($|[^a-z])`, 'i').test(text);
  if (kw.length <= 2) return text.split(/\s+/).some(w => w === kw || w === 'ال' + kw);
  return text.includes(kw);
}

/** Guess {cat, sub} from free text using the keyword map plus the user's own category names. */
export function guessCategory(text, categories) {
  const t = String(text || '').toLowerCase().trim();
  const ids = new Set(categories.map(c => c.id));
  for (const c of categories) if (c.name && t.includes(c.name.toLowerCase())) return { cat: c.id, sub: guessSub(c.id, t) };
  const order = ['gas', 'sadaqa', 'cats', 'bills', 'farm', 'health', 'work', 'debt', 'papers', 'car', 'clothes', 'home', 'groceries', 'rafah'];
  for (const k of order) if (ids.has(k) && KEYWORDS[k].some(kw => kwMatch(t, kw))) return { cat: k, sub: guessSub(k, t) };
  return { cat: ids.has('other') ? 'other' : categories[categories.length - 1]?.id, sub: '' };
}
function guessSub(cat, t) {
  const map = cat === 'bills' ? BILL_SUBS : cat === 'farm' ? FARM_SUBS : null;
  if (!map) return '';
  for (const [sub, kws] of Object.entries(map)) if (kws.some(kw => kwMatch(t, kw))) return sub;
  return '';
}

// ---------- Note parsing ----------
const AR_MONTH_ALIASES = [...AR_MONTHS.map((m, i) => [m, i]), ...AR_MONTHS_LEVANT.map((m, i) => [m, i]), ['اذار', 2], ['ايار', 4], ['ابريل', 3], ['اكتوبر', 9], ['اغسطس', 7]];
AR_MONTH_ALIASES.sort((a, b) => b[0].length - a[0].length);
const NUM = '(\\d+(?:[.,]\\d+)?)';
const CUR = '(?:jd|jod|دينار|د\\.?أ|دنانير)';

function normDigits(s) { return s.replace(/[٠-٩]/g, d => '٠١٢٣٤٥٦٧٨٩'.indexOf(d)).replace(/٫/g, '.'); }

/** pastOnly (v1.7, multi-day paste): a note is history, so a month after the current month is last year's, and an impossible date (Feb 31) is no date. */
export function parseDateLine(line, refDate = today(), pastOnly = false) {
  const l = normDigits(line).trim().replace(/,/g, ' ').replace(/\s+/g, ' ');
  let month = -1, day = NaN, year = NaN;
  const words = l.toLowerCase().replace(/(\d)(st|nd|rd|th)\b/g, '$1').split(' ').filter(w => !/^(sun|mon|tue|wed|thu|fri|sat)[a-z]*\.?$/.test(w));
  const isMonth = w => { const k = EN_MONTHS.findIndex(m => { const x = w.replace(/\.$/, ''); return x.length >= 3 && m.toLowerCase().startsWith(x); }); return k >= 0 || !pastOnly ? k : fuzzyMonth(w); };
  const mIdx = words.map(isMonth);
  if (mIdx.some(i => i >= 0)) {
    // English: only a month word plus numbers (day, optional year)
    if (words.some((w, k) => mIdx[k] < 0 && !/^\d+$/.test(w))) return null;
    month = mIdx.find(i => i >= 0);
    for (const w of words.filter(w => /^\d+$/.test(w))) { const v = +w; if (v > 31) year = v; else if (isNaN(day)) day = v; }
  } else {
    const hit = AR_MONTH_ALIASES.find(([name]) => l.includes(name));
    if (!hit) return null;
    const rest = l.replace(hit[0], ' ').replace(/(الأحد|الاحد|الاثنين|الإثنين|الثلاثاء|الأربعاء|الاربعاء|الخميس|الجمعة|السبت|يوم|،)/g, ' ').trim();
    if (!/^[\d\s/]*$/.test(rest)) return null;
    month = hit[1];
    for (const n of rest.match(/\d+/g) || []) { const v = +n; if (v > 31) year = v; else if (isNaN(day)) day = v; }
  }
  if (isNaN(day) || day < 1 || day > 31) return null;
  const ref = parseYmd(refDate);
  if (isNaN(year)) {
    year = ref.getFullYear();
    if (pastOnly ? month > ref.getMonth() : new Date(year, month, day) - ref > 31 * 86400000) year--; // a "December 30" note read in January
  }
  if (pastOnly && new Date(year, month, day).getMonth() !== month) return null;
  return ymd(new Date(year, month, day));
}

// (v1.7) a typo'd English month in a long note ("Ocotber 5", "Novmber 9", "Marhc 4"): edit distance (a swap = 1) of 1 for short names, 2 for long, and only one month that close
function editDist(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1); // swapped letters = 1
  }
  return d[a.length][b.length];
}
export function fuzzyMonth(word) {
  const w = String(word || '').toLowerCase().replace(/[^a-z]/g, '');
  if (w.length < 4) return -1;
  const hits = EN_MONTHS.map((m, i) => [i, editDist(w, m.toLowerCase()), m.length]).filter(([, dd, len]) => dd <= (len <= 5 ? 1 : 2));
  if (!hits.length) return -1;
  const best = Math.min(...hits.map(h => h[1]));
  const top = hits.filter(h => h[1] === best);
  return top.length === 1 ? top[0][0] : -1;
}

// (v1.7) "13/11", "13-11", "13/11/2025": day first, as dates are written here
const NUM_DATE = /^(\d{1,2})\s*[/\-]\s*(\d{1,2})(?:\s*[/\-]\s*(\d{4}|\d{2}))?$/;
export function parseNumDate(line, refDate = today(), pastOnly = false) {
  const m = normDigits(String(line || '')).trim().match(NUM_DATE);
  if (!m) return null;
  const day = +m[1], month = +m[2] - 1;
  let year = m[3] ? +m[3] : NaN;
  if (year < 100) year += 2000;
  if (month < 0 || month > 11 || day < 1 || day > 31) return null;
  const ref = parseYmd(refDate);
  if (isNaN(year)) {
    year = ref.getFullYear();
    if (pastOnly ? month > ref.getMonth() : new Date(year, month, day) - ref > 31 * 86400000) year--;
  }
  const d = new Date(year, month, day);
  return d.getMonth() === month ? ymd(d) : null;
}

/** Parse his daily note. Returns {date, items:[{amount, text, cat, sub, rafah}], total, rafahTotal, warnings[]} */
// opts.tolerant (v1.7 multi-day only): the date is already known, "+ income" lines are set aside, an amount in the middle
// ("lunch 3 jd with friends") is read, a description in brackets loses them, and the Total/Rafaheyah checks are left to the caller.
const INCOME_LINE = /^(plus\b|\+|i\s+receiv|receiv|got\s+\d|وصلني|وصلتني|استلمت|قبضت|اجاني|إجاني)|\+\s*$/i;
export function parseNote(text, categories, refDate = today(), opts = {}) {
  const T = !!opts.tolerant;
  const lines = String(text || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  let date = null, total = null, rafahTotal = null;
  const items = [], warnings = [], skipped = [], income = [];
  for (const raw of lines) {
    const line = normDigits(raw);
    if (/^(total|المجموع|مجموع|الاجمالي|الإجمالي)\b/i.test(line) || /total/i.test(line) || /\/\/\s*rafah/i.test(line)) {
      const tm = line.match(new RegExp(`(?:total|مجموع|المجموع|اجمالي|إجمالي)[^\\d]*${NUM}`, 'i'));
      if (tm) total = toFils(tm[1]);
      else if (T) { const bm = line.match(new RegExp(`^[^\\d/]*${NUM}[^/]*//`)); if (bm) total = toFils(bm[1]); } // "40 JD // Rafaheyah 5 JD" (no "Total")
      const rm = line.match(new RegExp(`(?:rafah\\w*|رفاهي?ة)[^\\d]*${NUM}`, 'i'));
      if (rm) rafahTotal = toFils(rm[1]);
      continue;
    }
    if (!T && !date && !/\d+(?:[.,]\d+)?\s*(jd|jod)/i.test(line)) {
      const d = parseDateLine(line, refDate) || parseNumDate(line, refDate); // (v1.7) "13/11" used to come out as a "13/" item of 11
      if (d) { date = d; continue; }
    }
    if (T && INCOME_LINE.test(line)) { income.push(raw); continue; }
    let m = line.match(new RegExp(`^${CUR}?\\s*${NUM}\\s*${CUR}?\\s+(.+)$`, 'i'));
    let amount, desc;
    if (m) { amount = toFils(m[1]); desc = m[2]; }
    else if ((m = line.match(new RegExp(`^(.+?)\\s*[:\\-–]?\\s*${CUR}?\\s*${NUM}\\s*${CUR}?$`, 'i')))) { amount = toFils(m[2]); desc = m[1]; }
    if (T && !desc) {
      const mid = [...line.matchAll(new RegExp(`(^|\\s)${NUM}\\s*(?:jd|jod|دينار)(?=\\s|$)`, 'gi'))];
      if (mid.length === 1) { amount = toFils(mid[0][2]); desc = (line.slice(0, mid[0].index) + ' ' + line.slice(mid[0].index + mid[0][0].length)).replace(/\s+/g, ' ').trim(); }
    }
    if (!desc || !(amount > 0)) { skipped.push(raw); continue; }
    desc = desc.replace(/^[-–:•*]+\s*/, '').trim();
    if (T) desc = desc.replace(/^\(\s*([^()]*?)\s*\)?$/, '$1') || desc; // "(coffee with friends)" and an unclosed "(bread and milk"
    const g = guessCategory(desc, categories);
    const cat = categories.find(c => c.id === g.cat);
    const rafah = /rafah|رفاهية/i.test(desc) ? true : !!cat?.rafah;
    items.push({ amount, text: desc, cat: g.cat, sub: g.sub, rafah: cat?.kind === 'sadaqa' ? false : rafah });
  }
  const sum = items.reduce((a, i) => a + i.amount, 0);
  if (!T && total != null && total !== sum) warnings.push(`المجموع بالملاحظة ${jd(total)} بس مجموع البنود ${jd(sum)}`);
  const rSum = items.filter(i => i.rafah).reduce((a, i) => a + i.amount, 0);
  if (!T && rafahTotal != null && rafahTotal !== rSum) warnings.push(`الرفاهية بالملاحظة ${jd(rafahTotal)} بس المحسوب ${jd(rSum)}`);
  if (income.length) warnings.push(`سطور دخل (مش مصروف) ما سجلتها: ${income.join(' / ')}`);
  if (skipped.length) warnings.push(`ما فهمت هالسطور: ${skipped.join(' / ')}`);
  return { date: date || refDate, dateFound: !!date, items, total, rafahTotal, sum, warnings, skipped, income };
}

// ---------- Multi-day note (v1.7: months of days kept in ONE Apple Note) ----------
/** The date a line opens, or null. Same rules as the single-day parser, plus "📅 Friday - March 3" style punctuation. */
function dayHeader(raw, refDate) {
  const line = normDigits(String(raw || '')).trim();
  if (!line || /\d+(?:[.,]\d+)?\s*(jd|jod)/i.test(line) || /total|مجموع|اجمالي|إجمالي/i.test(line)) return null;
  const numeric = parseNumDate(line, refDate, true);
  if (numeric) return { date: numeric };
  const clean = line.replace(/[^\p{L}\p{N}\s/]/gu, ' ').replace(/\s+/g, ' ').trim();
  const d = clean ? parseDateLine(clean, refDate, true) : null;
  if (d) return { date: d };
  // a month heading with no day ("March 2026 Expenses", "ملخص مارس"): its block is a summary, not a day
  const words = clean.toLowerCase().split(' ');
  const mi = words.map(w => { const k = EN_MONTHS.findIndex(m => w.length >= 3 && m.toLowerCase().startsWith(w)); return k >= 0 ? k : fuzzyMonth(w); });
  let month = mi.find(k => k >= 0);
  if (month == null) { const hit = AR_MONTH_ALIASES.find(([name]) => clean.includes(name)); if (hit) month = hit[1]; }
  if (month == null) return null;
  const rest = words.filter((w, k) => mi[k] < 0 && !AR_MONTH_ALIASES.some(([name]) => name.includes(w)));
  if (!rest.every(w => /^\d{4}$/.test(w) || /^(expenses?|spending|summary|month|monthly|مصاريف|مصروف|مصروفات|ملخص|شهر)$/.test(w))) return null;
  const y = rest.find(w => /^\d{4}$/.test(w));
  return { summary: { month, year: y ? +y : null } };
}

/** Split a note into days at every date line: {days: [{date, header, lines[]}], pre: [lines before the first date]} */
export function splitNoteDays(text, refDate = today()) {
  const days = [], pre = [], summaries = [];
  let cur = null;
  for (const raw of String(text || '').split(/\r?\n/)) {
    const h = raw.trim() ? dayHeader(raw, refDate) : null;
    if (h?.date) { cur = { date: h.date, header: raw.trim(), lines: [] }; days.push(cur); continue; }
    if (h?.summary) { cur = { ...h.summary, summary: true, header: raw.trim(), lines: [] }; summaries.push(cur); continue; }
    if (cur) cur.lines.push(raw); else if (raw.trim()) pre.push(raw.trim());
  }
  return { days, pre, summaries };
}

// his footers have 2 decimals while bills have 3 (12.345): a gap under half a piaster is rounding, not a mistake
const ROUND_TOL = 5;
const near = (a, b) => Math.abs(a - b) <= ROUND_TOL;
/** The smallest set of item indexes whose amounts add up to target (exact first, then within rounding); null if none or a tie. */
function subsetFor(items, target) {
  const n = items.length;
  if (!n || n > 14) return null;
  for (const ok of [(t) => t === target, (t) => near(t, target)]) {
    let best = null, bestSize = Infinity, tie = false;
    for (let mask = 1; mask < 1 << n; mask++) {
      let tot = 0, size = 0;
      for (let k = 0; k < n; k++) if (mask & (1 << k)) { tot += items[k].amount; size++; }
      if (!ok(tot)) continue;
      if (size < bestSize) { best = mask; bestSize = size; tie = false; } else if (size === bestSize) tie = true;
    }
    if (best != null) return tie ? null : new Set([...Array(n).keys()].filter(k => best & (1 << k)));
  }
  return null;
}

/** Use a day's footer: "100jd fees+20" inside a line adds the 20 when that makes the Total match, and the per-DAY Rafaheyah picks its item(s). */
function applyFooter(p, categories) {
  if (p.total != null && !near(p.total, p.sum)) {
    for (const it of p.items) {
      const extra = [...it.text.matchAll(/\+\s*(\d+(?:[.,]\d+)?)/g)].reduce((a, m) => a + toFils(m[1]), 0);
      if (extra > 0 && near(p.sum + extra, p.total)) { it.amount += extra; p.sum += extra; it.plusFixed = true; break; }
    }
  }
  // (v1.7.1, Ahmad: "25jd (debt to abood)" = money he LENT, not spent; his Total already left it out) when the day's Total only
  // matches without the debt / loan lines, those are set aside (not expenses), like the "Plus" income lines
  if (p.total != null && !near(p.total, p.sum)) {
    const isLoan = it => /(?:^|[^a-z])(debt|loan|lent|borrow[a-z]*)(?![a-z])|دين|سلف|قرض|ديّن|تديّن/i.test(it.text);
    const loans = p.items.filter(isLoan);
    const loanSum = loans.reduce((a, it) => a + it.amount, 0);
    if (loans.length && near(p.sum - loanSum, p.total)) {
      p.items = p.items.filter(it => !isLoan(it));
      p.sum -= loanSum;
      p.warnings = [`سطور دين/سلفة (مش مصروف) ما سجلتها: ${loans.map(it => `${jd(it.amount)} ${it.text}`).join(' / ')}`, ...p.warnings];
    }
  }
  const isSadaqa = it => categories.find(c => c.id === it.cat)?.kind === 'sadaqa';
  p.rafahMatched = null;
  if (p.rafahTotal != null && p.items.length) {
    if (p.rafahTotal === 0) { p.items.forEach(it => { it.rafah = false; }); p.rafahMatched = true; }
    else {
      const pool = p.items.map((it, k) => [it, k]).filter(([it]) => !isSadaqa(it));
      const pick = subsetFor(pool.map(([it]) => it), p.rafahTotal);
      const chosen = pick ? new Set([...pick].map(j => pool[j][1])) : new Set();
      p.items.forEach((it, k) => { it.rafah = chosen.has(k); });
      p.rafahMatched = !!pick;
    }
  }
  p.totalOff = p.total != null && !near(p.total, p.sum);
  const w = [];
  if (p.totalOff) w.push(`المجموع بالملاحظة ${jd(p.total)} بس مجموع البنود ${jd(p.sum)}`);
  if (p.rafahMatched === false) w.push(`الرفاهية بالملاحظة ${jd(p.rafahTotal)} لليوم، ما لقيت بنود مجموعها هيك، فما علّمت ولا بند رفاهية`);
  p.warnings = [...w, ...p.warnings];
  return p;
}

/** A note with 2+ date lines: every day goes through parseNote. Returns null for a one-day note (the old single-day flow handles it). */
export function parseMultiNote(text, categories, refDate = today()) {
  const { days, pre, summaries } = splitNoteDays(text, refDate);
  if (days.length < 2) return null;
  const out = days.map(d => {
    const p = parseNote(d.lines.join('\n'), categories, d.date, { tolerant: true });
    return applyFooter({ ...p, date: d.date, dateFound: true, header: d.header }, categories);
  });
  const dates = out.map(d => d.date).sort();
  const warnings = [];
  if (pre.length) warnings.push(`تجاهلت ${pre.length} ${pre.length === 1 ? 'سطر' : 'سطور'} قبل أول تاريخ: ${pre.slice(0, 3).join(' / ')}${pre.length > 3 ? ' …' : ''}`);
  for (const sm of summaries) { // "March 2026 Expenses / Total 500": checked against the days, never imported
    const tl = sm.lines.map(normDigits).find(l => /total|مجموع|اجمالي|إجمالي/i.test(l));
    const tm = tl && tl.match(new RegExp(`(?:total|مجموع|المجموع|اجمالي|إجمالي)[^\\d]*${NUM}`, 'i'));
    const ym = out.filter(d => +d.date.slice(5, 7) - 1 === sm.month && (!sm.year || +d.date.slice(0, 4) === sm.year));
    const got = ym.reduce((a, d) => a + d.sum, 0);
    const want = tm ? toFils(tm[1]) : null;
    sm.total = want; sm.daysSum = got; sm.ok = want == null ? null : near(want, got);
    warnings.push(`${want == null ? 'ℹ️' : sm.ok ? '✅' : '⚠️'} ملخص "${sm.header}" ما بينضاف كمصروف${want != null ? `: بالملاحظة ${jd(want)}، ومجموع أيامه هون ${jd(got)}` : ''}`);
  }
  const seen = new Set(), twice = new Set();
  for (const d of dates) { if (seen.has(d)) twice.add(d); seen.add(d); }
  if (twice.size) warnings.push(`في تاريخ مكرر بالملاحظة: ${[...twice].map(dateShort).join('، ')} (بنودهم كلها رح تنضاف)`);
  const off = out.filter(d => d.totalOff).length;
  if (off) warnings.push(`${nDays(off)}: المجموع بالملاحظة غير مجموع البنود (معلّم ⚠️ تحت)`);
  return { multi: true, days: out, summaries, pre, from: dates[0], to: dates[dates.length - 1], count: out.reduce((a, d) => a + d.items.length, 0), sum: out.reduce((a, d) => a + d.sum, 0), warnings };
}

const normTxt = s => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
/** Items not saved yet (same date + amount + text = already there). Counted per copy, so two real "5jd coffee" on one day both go in. */
export function dedupeDayItems(state, days) {
  const have = new Map();
  for (const e of state.entries) { const k = `${e.date}|${e.amount}|${normTxt(e.note)}`; have.set(k, (have.get(k) || 0) + 1); }
  const add = [];
  let skipped = 0;
  for (const d of days) for (const it of d.items) {
    const k = `${d.date}|${it.amount}|${normTxt(it.text)}`, n = have.get(k) || 0;
    if (n > 0) { have.set(k, n - 1); skipped++; } else add.push({ ...it, date: d.date });
  }
  return { add, skipped };
}

/** Exactly his format: "November 13\n20jd groceries\n...\nTotal 33.15 JD // Rafaheyah 0 JD" */
export function dayNote(state, date) {
  const d = parseYmd(date);
  const list = state.entries.filter(e => e.date === date).sort((a, b) => a.ts - b.ts);
  const lines = [`${EN_MONTHS[d.getMonth()]} ${d.getDate()}`];
  for (const e of list) {
    const cat = catById(state, e.cat);
    const txt = e.note?.trim() || [cat?.name, e.sub].filter(Boolean).join(' ') || 'other';
    lines.push(`${jdShort(e.amount)}jd ${txt}`);
  }
  const total = list.reduce((a, e) => a + e.amount, 0);
  const rafah = list.filter(e => e.rafah).reduce((a, e) => a + e.amount, 0);
  lines.push(`Total ${jdShort(total)} JD // Rafaheyah ${jdShort(rafah)} JD`);
  return lines.join('\n');
}

// ---------- Helpers ----------
export const catById = (state, id) => state.kv.categories.find(c => c.id === id);
export const catName = (state, id) => catById(state, id)?.name || 'محذوفة';
export const S = state => state.kv.settings;

// ---------- Balances (base value + every effect recorded after the base was typed) ----------
export function accountEvents(state) {
  const ev = []; // {acc, inflow (fils, + adds money / reduces card debt), ts}
  for (const e of state.entries) if (e.from !== 'none') ev.push({ acc: e.from, inflow: -e.amount, ts: e.ts });
  for (const t of state.transfers) { ev.push({ acc: t.from, inflow: -t.amount, ts: t.ts }); ev.push({ acc: t.to, inflow: t.amount, ts: t.ts }); }
  for (const i of state.incomes) if (i.status === 'received' && i.account) ev.push({ acc: i.account, inflow: i.receivedAmount ?? i.amount, ts: i.receivedTs });
  for (const o of state.obligations) for (const p of o.payments || []) ev.push({ acc: p.account, inflow: -p.amount, ts: p.ts });
  return ev;
}

export function balances(state) {
  const a = state.kv.accounts;
  const out = { savings: a.savings.base, cash: a.cash.base, card: a.card.base };
  for (const ev of accountEvents(state)) {
    const acc = a[ev.acc];
    if (!acc || ev.ts <= acc.baseTs) continue;
    out[ev.acc] += ev.acc === 'card' ? -ev.inflow : ev.inflow; // card holds outstanding debt
  }
  out.net = out.savings + out.cash - out.card;
  out.cardLimit = a.card.limit || 0;
  out.cardAvail = out.cardLimit - out.card;
  return out;
}

// ---------- Month stats ----------
export const entriesIn = (state, ym) => state.entries.filter(e => monthKey(e.date) === ym);
export const sum = list => list.reduce((a, e) => a + e.amount, 0);

export function monthStats(state, ym) {
  const list = entriesIn(state, ym);
  const byCat = {};
  for (const e of list) byCat[e.cat] = (byCat[e.cat] || 0) + e.amount;
  const rafahUsed = sum(list.filter(e => e.rafah && catById(state, e.cat)?.kind !== 'sadaqa'));
  return { total: sum(list), byCat, rafahUsed, count: list.length };
}

export function rafahStatus(state, ym = today().slice(0, 7)) {
  const budget = S(state).rafahBudget;
  const used = monthStats(state, ym).rafahUsed;
  const pct = budget > 0 ? used / budget : 0;
  return { used, budget, left: budget - used, pct, level: pct >= 1 ? 'red' : pct >= 0.75 ? 'yellow' : 'ok' };
}

/** Months (before refYm) that have any entries, newest first, max n. */
export function historyMonths(state, refYm, n = 3) {
  const set = new Set(state.entries.map(e => monthKey(e.date)).filter(m => m < refYm));
  return [...set].sort().reverse().slice(0, n);
}

export function avgMonthlySpend(state, refYm = today().slice(0, 7)) {
  const months = historyMonths(state, refYm, 3);
  if (months.length) return { avg: Math.round(months.reduce((a, m) => a + monthStats(state, m).total, 0) / months.length), basis: `معدل آخر ${months.length} ${months.length === 1 ? 'شهر' : 'شهور'}`, months };
  const cur = monthStats(state, refYm).total;
  const day = refYm === today().slice(0, 7) ? parseYmd(today()).getDate() : daysInMonth(refYm);
  return { avg: Math.round(cur / day * daysInMonth(refYm)), basis: 'ما في تاريخ، محسوب من الشهر الحالي', months: [] };
}

export function categoryAvg(state, refYm, catId) {
  const months = historyMonths(state, refYm, 3);
  if (!months.length) return null;
  return Math.round(months.reduce((a, m) => a + (monthStats(state, m).byCat[catId] || 0), 0) / months.length);
}

// ---------- Card cycle ----------
function dateWithDay(y, m, day) { const last = new Date(y, m + 1, 0).getDate(); return new Date(y, m, Math.min(day, last)); }

export function cardCycle(state, ref = today()) {
  const { stmtDay, dueDay } = S(state);
  const r = parseYmd(ref);
  let due = dateWithDay(r.getFullYear(), r.getMonth(), dueDay);
  if (due < r) due = dateWithDay(r.getFullYear(), r.getMonth() + 1, dueDay);
  // statement that this due date pays: the last statement day before the due date
  let stmt = dateWithDay(due.getFullYear(), due.getMonth(), stmtDay);
  if (stmt >= due) stmt = dateWithDay(due.getFullYear(), due.getMonth() - 1, stmtDay);
  const dueStr = ymd(due), stmtStr = ymd(stmt);
  const outstanding = balances(state).card;
  const closed = stmtStr < ref || stmtStr === ref;
  const spentAfter = sum(state.entries.filter(e => e.from === 'card' && e.date > stmtStr));
  const dueAmount = Math.max(0, closed ? outstanding - spentAfter : outstanding);
  return { dueDate: dueStr, stmtDate: stmtStr, closed, dueAmount, daysLeft: daysBetween(ref, dueStr), outstanding };
}

// ---------- Recurrence ----------
export function nextOccurrence(item) {
  const d = item.date;
  if (item.recur === 'monthly') return addMonthsDate(d, 1);
  if (item.recur === 'yearly') return addMonthsDate(d, 12);
  if (item.recur === 'months' && item.months?.length) {
    for (let k = 1; k <= 12; k++) { const n = addMonthsDate(d, k); if (item.months.includes(+n.slice(5, 7))) return n; }
  }
  return null;
}

/** Expected income occurrences up to date X (inclusive), including future repeats of recurring items. */
export function incomeUntil(state, X) {
  const out = [];
  for (const i of state.incomes) {
    if (i.status !== 'expected') continue;
    let cur = { ...i }, guard = 0;
    while (cur && cur.date <= X && guard++ < 60) {
      out.push({ id: i.id, source: i.source, amount: i.amount, date: cur.date, sure: !!i.sure });
      const n = nextOccurrence(cur);
      cur = n ? { ...cur, date: n } : null;
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

export const remaining = o => Math.max(0, o.amount - (o.payments || []).reduce((a, p) => a + p.amount, 0));

export function obligationsUntil(state, X) {
  const out = [], noDate = [];
  for (const o of state.obligations) {
    if (o.done) continue;
    const rem = remaining(o);
    if (!o.due) { if (rem > 0) noDate.push({ id: o.id, title: o.title, amount: rem }); continue; }
    if (o.due <= X && rem > 0) out.push({ id: o.id, title: o.title, amount: rem, date: o.due });
    if (o.monthly) {
      let d = addMonthsDate(o.due, 1), g = 0;
      while (d <= X && g++ < 60) { out.push({ id: o.id, title: o.title, amount: o.amount, date: d, repeat: true }); d = addMonthsDate(d, 1); }
    }
  }
  return { list: out.sort((a, b) => a.date.localeCompare(b.date)), noDate };
}

// ---------- Receivables "إلي عند الناس" (v1.7) ----------
// {id, ts, who, amount (fils|null), amountText, due (YYYY-MM-DD|null), expected (text), sure, note, done, receivedTs, receivedDate, receivedAmount, account, incomeId}
export const recvOpen = state => (state.receivables || []).filter(r => !r.done);
export const recvLabel = r => r.amount > 0 ? jd(r.amount) : (r.amountText || 'بدون رقم');
/** Only SURE ones with a number and a date on/before X count (in both cases); the rest are listed as not counted. */
export function receivablesUntil(state, X) {
  const list = [], notCounted = [];
  for (const r of recvOpen(state)) {
    if (r.sure && r.amount > 0 && r.due && r.due <= X) list.push({ id: r.id, who: r.who, amount: r.amount, date: r.due });
    else if (!r.sure || !(r.amount > 0) || !r.due) notCounted.push({ id: r.id, who: r.who, label: recvLabel(r), why: !r.sure ? 'مش أكيد' : !(r.amount > 0) ? 'بدون رقم' : 'بدون تاريخ' });
  }
  return { list: list.sort((a, b) => a.date.localeCompare(b.date)), notCounted };
}

// ---------- Projection ----------
export function projection(state, X, ref = today()) {
  const bal = balances(state);
  const inc = incomeUntil(state, X);
  const obl = obligationsUntil(state, X);
  const spend = avgMonthlySpend(state, ref.slice(0, 7));
  const days = Math.max(0, daysBetween(ref, X));
  const months = days / 30.44;
  const spendTotal = Math.round(spend.avg * months);
  const sureInc = sum(inc.filter(i => i.sure));
  const allInc = sum(inc);
  const oblTotal = sum(obl.list);
  const recv = receivablesUntil(state, X);
  const recvTotal = sum(recv.list);
  const base = bal.net - oblTotal - spendTotal + recvTotal;
  return { X, days, months, liquidity: bal.net, incomes: inc, sureInc, allInc, obligations: obl.list, noDate: obl.noDate, oblTotal, recv: recv.list, recvTotal, recvNotCounted: recv.notCounted, spendAvg: spend.avg, spendBasis: spend.basis, spendTotal, worst: base + sureInc, best: base + allInc };
}

// ---------- Advice ----------
export function entryVerdict(state, e) {
  const cat = catById(state, e.cat);
  if (cat?.kind === 'sadaqa') return { icon: '🤲', level: 'none', text: 'صدقة، الله يتقبّل' };
  const ym = monthKey(e.date);
  if (e.rafah) {
    const budget = S(state).rafahBudget;
    const used = sum(entriesIn(state, ym).filter(x => x.rafah && x.ts <= e.ts && catById(state, x.cat)?.kind !== 'sadaqa'));
    if (used > budget) return { icon: '❌', level: 'bad', text: `مش وقته: الرفاهية صارت ${jdShort(used)}/${jdShort(budget)}` };
    if (used >= budget * 0.75) return { icon: '⚠️', level: 'warn', text: `مقبول بس انتبه: ضايلك ${jdShort(budget - used)} رفاهية` };
    return { icon: '✅', level: 'ok', text: 'تمام' };
  }
  if (cat?.kind === 'need') return { icon: '✅', level: 'ok', text: 'ضروري' };
  // (v1.8, Ahmad: "المحلاظات ... مزعجة") the "above your average" note only when he turned it on in Settings (off by default)
  const avg = S(state).catNudges ? categoryAvg(state, ym, e.cat) : null;
  const monthCat = monthStats(state, ym).byCat[e.cat] || 0;
  const bal = balances(state);
  if (e.amount >= 50000 && bal.net < e.amount * 3) return { icon: '❌', level: 'bad', text: 'مش وقته: مبلغ كبير والسيولة ما بتتحمل' };
  if (avg != null && monthCat > avg * 1.5 && monthCat - avg > 10000) return { icon: '⚠️', level: 'warn', text: `مقبول بس انتبه: ${cat?.name} هالشهر فوق معدلك (${jdShort(avg)})` };
  if (e.amount >= 30000) return { icon: '⚠️', level: 'warn', text: 'مقبول بس انتبه: مبلغ مش صغير، تأكد إنه لازم' };
  return { icon: '✅', level: 'ok', text: 'تمام' };
}

export function dayVerdict(state, date) {
  const list = state.entries.filter(e => e.date === date);
  if (!list.length) return null;
  const vs = list.map(e => ({ e, v: entryVerdict(state, e) }));
  const bad = vs.find(x => x.v.level === 'bad'), warn = vs.find(x => x.v.level === 'warn');
  if (bad) return { icon: '❌', text: `${bad.v.text.replace(/^مش وقته: /, 'مش وقته: ')}` };
  if (warn) return { icon: '⚠️', text: warn.v.text };
  return { icon: '✅', text: 'يوم تمام، كله ضروري أو ضمن الحدود' };
}

export function adviceBanners(state, ref = today()) {
  const out = [];
  const ym = ref.slice(0, 7);
  const r = rafahStatus(state, ym);
  if (r.level === 'red') out.push({ level: 'red', text: `❌ الرفاهية خلصت: ${jdShort(r.used)}/${jdShort(r.budget)}. لآخر الشهر بس الضروري.` });
  else if (r.level === 'yellow') out.push({ level: 'yellow', text: `⚠️ الرفاهية ${Math.round(r.pct * 100)}%: ضايلك ${jdShort(r.left)} لآخر الشهر.` });

  const cc = cardCycle(state, ref);
  if (cc.dueAmount > 0 && cc.daysLeft <= 3) out.push({ level: 'yellow', text: `💳 البطاقة مستحقة ${cc.daysLeft === 0 ? 'اليوم' : `بعد ${cc.daysLeft} ${cc.daysLeft === 1 ? 'يوم' : 'أيام'}`}: ${jd(cc.dueAmount)}. حوّل من التوفير.` });

  // (v1.8, 2026-11-16, Ahmad: "المحلاظات خاي، مثلا المزرعة كدا شو صرلك؟ ... مزعجة") the "📈 X this month vs your average. شو صاير؟"
  // banner is opt-in now: Settings -> تنبيهات -> قارن التصنيفات بمعدلك (off by default)
  const ms = S(state).catNudges ? monthStats(state, ym) : { byCat: {} };
  for (const [catId, amt] of Object.entries(ms.byCat)) {
    const cat = catById(state, catId);
    if (!cat || cat.kind === 'sadaqa') continue;
    const avg = categoryAvg(state, ym, catId);
    if (avg != null && amt > avg * 1.5 && amt - avg >= 10000) out.push({ level: 'yellow', text: `📈 ${cat.name} هالشهر ${jdShort(amt)} ومعدلك ${jdShort(avg)}. شو صاير؟` });
  }

  const bal = balances(state);
  const soon = state.obligations.filter(o => !o.done && o.due && remaining(o) > 0).map(o => ({ o, n: daysBetween(ref, o.due) })).filter(x => x.n <= 14).sort((a, b) => a.n - b.n);
  if (soon.length) {
    const need = soon.reduce((a, x) => a + remaining(x.o), 0);
    if (bal.net < need * 1.2) {
      const x = soon[0];
      out.push({ level: 'red', text: `⏰ "${x.o.title}" ${x.n < 0 ? `متأخر ${-x.n} يوم` : x.n === 0 ? 'مستحق اليوم' : `مستحق بعد ${x.n} يوم`} (${jd(remaining(x.o))}) والسيولة واطية (${jd(bal.net)}). وقّف أي مصروف مش ضروري.` });
    }
  }
  return out;
}

export function bigPurchaseCheck(state, amount, from = 'cash', ref = today()) {
  const bal = balances(state);
  const spend = avgMonthlySpend(state, ref.slice(0, 7)).avg;
  const cc = cardCycle(state, ref);
  const lines = [];
  const res = [30, 60].map(n => {
    const X = ymd(new Date(parseYmd(ref).getTime() + n * 86400000));
    const obl = sum(obligationsUntil(state, X).list);
    const after = bal.net - amount - obl - Math.round(spend * n / 30.44);
    return { n, obl, after };
  });
  let verdict;
  const [r30, r60] = res;
  if (r30.after < 0) verdict = { icon: '❌', text: `مش وقته: خلال 30 يوم بتطلع بالسالب (${jd(r30.after)}) بعد الالتزامات والمصروف العادي.` };
  else if (r60.after < 0) verdict = { icon: '⚠️', text: `مقبول بس انتبه: بتمشي هالشهر، بس خلال 60 يوم بتطلع بالسالب (${jd(r60.after)}).` };
  else if (r30.after < spend * 0.5) verdict = { icon: '⚠️', text: 'مقبول بس انتبه: بعدها بيضل معك أقل من نص مصروف شهر احتياط.' };
  else verdict = { icon: '✅', text: 'تمام: السيولة بتتحمل والالتزامات مغطاة.' };
  if (from === 'card' && amount > bal.cardAvail) verdict = { icon: '❌', text: `مش وقته: المتاح بالبطاقة ${jd(bal.cardAvail)} بس.` };
  if (from === 'cash' && amount > bal.cash) lines.push(`الكاش ما بكفي (${jd(bal.cash)}).`);
  if (from === 'savings' && amount > bal.savings) lines.push(`التوفير ما بكفي (${jd(bal.savings)}).`);
  if (cc.dueAmount > 0 && cc.daysLeft <= 30) lines.push(`البطاقة مستحق عليها ${jd(cc.dueAmount)} يوم ${dateShort(cc.dueDate)} (محسوبة بالسيولة).`);
  lines.push('تذكير: الخصم مش سبب تشتري هلأ، وما في استدانة.');
  return { verdict, res, spend, liquidity: bal.net, lines };
}

// ---------- Income / obligation actions (return records to save) ----------
export function receiveIncome(inc, account, amount, ts = Date.now()) {
  const done = { ...inc, status: 'received', account, receivedAmount: amount, receivedTs: ts, receivedDate: today() };
  const n = inc.recur && inc.recur !== 'none' ? nextOccurrence(inc) : null;
  const next = n ? { ...inc, id: uid(), ts, date: n, status: 'expected', account: null, receivedTs: null, receivedAmount: null, receivedDate: null } : null;
  return { done, next };
}

export function payObligation(o, account, amount, ts = Date.now()) {
  const payments = [...(o.payments || []), { id: uid(), ts, date: today(), amount, account }];
  const upd = { ...o, payments };
  let next = null;
  if (remaining(upd) <= 0) {
    upd.done = true;
    if (o.monthly) next = { ...o, id: uid(), ts, payments: [], done: false, due: o.due ? addMonthsDate(o.due, 1) : null };
  }
  return { upd, next };
}

// ---------- Bulk import (v1.7): a pasted JSON block that ADDS incomes / obligations / receivables (schema: README "استيراد بيانات") ----------
const isYmd = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && ymd(parseYmd(v)) === v;
const jdIn = v => typeof v === 'number' ? (isFinite(v) ? Math.round(v * 1000) : NaN) : typeof v === 'string' && /^\s*[\d٠-٩]+(?:[.,٫][\d٠-٩]+)?\s*(jd|jod|دينار)?\s*$/i.test(v) ? toFils(v) : NaN;
const keyTxt = v => String(v ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
const incKey = i => `${keyTxt(i.source)}|${i.amount}|${i.date}`;
const oblKey = o => `${keyTxt(o.title)}|${o.amount}|${o.due || ''}`;
const recKey = r => `${keyTxt(r.who)}|${r.amount ?? ''}|${keyTxt(r.amountText)}|${r.due || ''}|${keyTxt(r.expected)}`;
export const RECURS = ['none', 'monthly', 'yearly', 'months'];
export const PRIORITIES = ['high', 'mid', 'low'];

/** Returns {error} or {incomes, obligations, receivables (records ready to save), dups, errors[]}. Nothing is saved here. */
export function parseImport(text, state, ts = Date.now()) {
  let src = String(text || '').trim().replace(/^```[a-z]*\s*/i, '').replace(/```\s*$/, '').trim();
  let data;
  try { data = JSON.parse(src); } catch (e) { return { error: `الـ JSON مش صحيح: ${e.message}` }; }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { error: 'لازم يكون كائن JSON فيه incomes / obligations / receivables' };
  const out = { incomes: [], obligations: [], receivables: [], dups: { incomes: 0, obligations: 0, receivables: 0 }, errors: [] };
  const seen = {
    incomes: new Set((state.incomes || []).map(incKey)),
    obligations: new Set((state.obligations || []).map(oblKey)),
    receivables: new Set((state.receivables || []).map(recKey)),
  };
  const err = (kind, k, msg) => out.errors.push(`${kind} #${k + 1}: ${msg}`);
  const list = v => Array.isArray(v) ? v : v == null ? [] : null;
  let n = 0;
  const L1 = list(data.incomes), L2 = list(data.obligations), L3 = list(data.receivables);
  if (!L1 || !L2 || !L3) return { error: 'incomes و obligations و receivables لازم يكونوا قوائم [ ... ]' };
  if (!L1.length && !L2.length && !L3.length) return { error: 'ما لقيت ولا شي: حط incomes أو obligations أو receivables' };

  L1.forEach((x, k) => {
    if (!x || typeof x !== 'object') return err('دخل', k, 'مش كائن');
    const source = String(x.source ?? '').trim(), amount = jdIn(x.amount), recur = x.recur ?? 'none';
    const months = Array.isArray(x.months) ? [...new Set(x.months.map(Number))].filter(m => m >= 1 && m <= 12).sort((a, b) => a - b) : [];
    if (!source) return err('دخل', k, 'source فاضي');
    if (!(amount > 0)) return err('دخل', k, 'amount لازم رقم أكبر من 0 بالدينار');
    if (x.date != null && !isYmd(x.date)) return err('دخل', k, 'date لازم YYYY-MM-DD');
    if (!RECURS.includes(recur)) return err('دخل', k, `recur لازم وحدة من: ${RECURS.join(' / ')}`);
    if (recur === 'months' && !months.length) return err('دخل', k, 'recur "months" بدها months: [1..12]');
    const rec = { id: uid(), ts: ts + n++, status: 'expected', source, amount, date: x.date || today(), recur, months: recur === 'months' ? months : [], sure: x.sure !== false };
    if (seen.incomes.has(incKey(rec))) { out.dups.incomes++; return; }
    seen.incomes.add(incKey(rec)); out.incomes.push(rec);
  });

  L2.forEach((x, k) => {
    if (!x || typeof x !== 'object') return err('التزام', k, 'مش كائن');
    const title = String(x.title ?? '').trim(), amount = jdIn(x.amount), priority = x.priority ?? 'mid';
    const paid = x.paid == null || x.paid === 0 ? 0 : jdIn(x.paid);
    if (!title) return err('التزام', k, 'title فاضي');
    if (!(amount > 0)) return err('التزام', k, 'amount لازم رقم أكبر من 0 بالدينار');
    if (x.due != null && x.due !== '' && !isYmd(x.due)) return err('التزام', k, 'due لازم YYYY-MM-DD أو null');
    if (!PRIORITIES.includes(priority)) return err('التزام', k, `priority لازم وحدة من: ${PRIORITIES.join(' / ')}`);
    if (!(paid >= 0)) return err('التزام', k, 'paid لازم رقم بالدينار');
    let rec = { id: uid(), ts: ts + n++, payments: [], done: false, title, amount, due: x.due || null, priority, monthly: !!x.monthly };
    if (seen.obligations.has(oblKey(rec))) { out.dups.obligations++; return; }
    seen.obligations.add(oblKey(rec));
    if (paid > 0) { // already paid before the app: a payment that touches no account
      const r = payObligation(rec, 'none', Math.min(paid, amount), rec.ts);
      rec = r.upd; rec.payments[0].note = 'مدفوع قبل التطبيق';
      out.obligations.push(rec); if (r.next) out.obligations.push(r.next);
      return;
    }
    out.obligations.push(rec);
  });

  L3.forEach((x, k) => {
    if (!x || typeof x !== 'object') return err('إلك', k, 'مش كائن');
    const who = String(x.who ?? '').trim();
    if (!who) return err('إلك', k, 'who فاضي');
    let amount = x.amount == null || x.amount === '' ? null : jdIn(x.amount), amountText = String(x.amountText ?? '').trim();
    if (amount != null && !(amount > 0)) { amountText = amountText || String(x.amount).trim(); amount = null; } // "100-150" in amount -> text
    let due = x.due ?? null, expected = String(x.expected ?? '').trim();
    if (due != null && due !== '' && !isYmd(due)) return err('إلك', k, 'due لازم YYYY-MM-DD');
    if (!due && isYmd(expected)) { due = expected; expected = ''; }
    const rec = { id: uid(), ts: ts + n++, who, amount, amountText: amount ? '' : amountText, due: due || null, expected, sure: x.sure === true, note: String(x.note ?? '').trim(), done: false };
    if (seen.receivables.has(recKey(rec))) { out.dups.receivables++; return; }
    seen.receivables.add(recKey(rec)); out.receivables.push(rec);
  });
  return out;
}

// ---------- Savings goals (v1.8, 2026-11-16, Ahmad: "ياريت و ياريت") ----------
// Stored in kv 'goals' (no IndexedDB schema change): [{id, ts, name, icon, target (fils), deadline (YYYY-MM-DD|null),
//   monthly (fils, his own plan when there is no deadline; 0 = none), start (fils already put aside before), contribs: [{id, ts, date, amount (+ put in / - took out)}]}]
// A goal is money SET ASIDE inside his accounts: it never moves a balance, it only keeps that money out of "safe to spend".
export const goalsOf = state => state.kv.goals || [];
export const goalSaved = g => (g.start || 0) + (g.contribs || []).reduce((a, c) => a + c.amount, 0);
const monthNo = ym => { const [y, m] = ym.split('-').map(Number); return y * 12 + m - 1; };
const ceilJd = f => Math.ceil(f / 1000) * 1000; // plan numbers in whole dinars: "35 بالشهر" reads better than 34.167

/** His usual monthly income: the average that actually arrived in the last 3 months the app knows about, else his sure recurring income. */
export function monthlyIncome(state, ref = today()) {
  const refYm = ref.slice(0, 7);
  const dates = [...state.entries.map(e => e.date), ...state.incomes.map(i => i.receivedDate || i.date)].filter(Boolean).sort();
  const first = dates.length ? dates[0].slice(0, 7) : refYm;
  const months = [1, 2, 3].map(n => addMonths(refYm, -n)).filter(m => m >= first);
  const got = {};
  for (const i of state.incomes) if (i.status === 'received' && i.receivedDate) { const m = i.receivedDate.slice(0, 7); got[m] = (got[m] || 0) + (i.receivedAmount ?? i.amount); }
  const hist = months.length ? Math.round(months.reduce((a, m) => a + (got[m] || 0), 0) / months.length) : 0;
  let rec = 0;
  for (const i of state.incomes) {
    if (i.status !== 'expected' || !i.sure) continue;
    if (i.recur === 'monthly') rec += i.amount; else if (i.recur === 'yearly') rec += i.amount / 12; else if (i.recur === 'months') rec += i.amount * (i.months || []).length / 12;
  }
  rec = Math.round(rec);
  if (hist > 0) return { avg: hist, basis: `معدل الدخل اللي وصلك آخر ${months.length === 1 ? 'شهر' : `${months.length} شهور`}` };
  if (rec > 0) return { avg: rec, basis: 'من دخلك المتكرر الأكيد' };
  return { avg: 0, basis: 'ما في دخل مسجّل' };
}

/** What he can put aside per month: usual income − usual spending − monthly commitments. */
export function saveCapacity(state, ref = today()) {
  const inc = monthlyIncome(state, ref);
  const spend = avgMonthlySpend(state, ref.slice(0, 7));
  const commit = state.obligations.filter(o => !o.done && o.monthly).reduce((a, o) => a + o.amount, 0);
  return { income: inc.avg, incomeBasis: inc.basis, spend: spend.avg, spendBasis: spend.basis, commit, cap: inc.avg - spend.avg - commit };
}

/** Per goal: progress, what to put aside per month / week, and how much of this month is still to be set aside (the reserve). */
export function goalPlan(state, g, ref = today(), capacity = null) {
  const ym = ref.slice(0, 7);
  const saved = goalSaved(g), left = Math.max(0, g.target - saved), done = saved >= g.target;
  const thisMonth = (g.contribs || []).filter(c => c.date && c.date.slice(0, 7) === ym).reduce((a, c) => a + c.amount, 0);
  const leftAtStart = Math.max(0, g.target - (saved - thisMonth)); // the plan is fixed for the month: putting money in lowers the reserve, not the plan
  let perMonth = 0, monthsLeft = null, late = false, daysLeft = null;
  if (g.deadline) {
    daysLeft = daysBetween(ref, g.deadline);
    monthsLeft = monthNo(g.deadline.slice(0, 7)) - monthNo(ym) + 1; // this month counts
    if (monthsLeft < 1) { late = true; monthsLeft = 1; }
    perMonth = ceilJd(leftAtStart / monthsLeft);
  } else if (g.monthly > 0) perMonth = Math.min(g.monthly, leftAtStart);
  if (done) perMonth = 0;
  const perWeek = Math.ceil(perMonth * 12 / 52 / 100) * 100;
  const reserve = done ? 0 : Math.max(0, Math.min(perMonth - Math.max(0, thisMonth), left));
  // when will he get there: at his own monthly plan, else at his saving capacity
  const rate = g.deadline ? perMonth : g.monthly > 0 ? g.monthly : Math.max(0, capacity ?? 0);
  const etaMonths = !done && rate > 0 ? Math.ceil(left / rate) : null;
  const eta = etaMonths != null ? addMonths(ym, etaMonths - 1) : null;
  return { saved, left, done, pct: g.target > 0 ? Math.min(1, Math.max(0, saved / g.target)) : 0, thisMonth, perMonth, perWeek, reserve, monthsLeft, daysLeft, late, rate, eta };
}

// ---------- Safe to spend today (v1.8) ----------
/** "الضايل الآمن": this month's income − commitments − goal money − what he already spent, spread over the days left (today included).
 *  Never more than the money he really has (liquidity + income still coming − commitments − goal money) once a real balance is typed. */
export function safeToSpend(state, ref = today()) {
  const ym = ref.slice(0, 7), mEnd = `${ym}-${pad(daysInMonth(ym))}`;
  const inMonth = d => !!d && d.slice(0, 7) === ym;
  const daysLeft = daysInMonth(ym) - parseYmd(ref).getDate() + 1;
  const incGot = state.incomes.filter(i => i.status === 'received' && inMonth(i.receivedDate)).reduce((a, i) => a + (i.receivedAmount ?? i.amount), 0);
  const incExp = sum(incomeUntil(state, mEnd).filter(i => i.sure));
  const recvExp = sum(receivablesUntil(state, mEnd).list);
  const usual = monthlyIncome(state, ref);
  // (v1.9, 2026-11-16, from Ahmad's screenshot: a big "safe" daily number while cash was low and a debt was due soon) his own rule:
  // "expected income doesn't count until it actually arrives". Expected income + money owed to him are shown as COMING, never spent ahead.
  const coming = incExp + recvExp;
  const hasBal0 = ['savings', 'cash', 'card'].some(k => (state.kv.accounts || {})[k]?.baseTs > 0);
  let income = incGot, incomeEst = false;
  if (income <= 0 && !hasBal0 && usual.avg > 0) { income = usual.avg; incomeEst = true; } // no balances at all: his usual month, flagged as a guess
  const oblPaid = state.obligations.flatMap(o => o.payments || []).filter(p => p.account !== 'none' && inMonth(p.date)).reduce((a, p) => a + p.amount, 0);
  const oblDue = sum(obligationsUntil(state, mEnd).list); // still to pay up to the month end (late ones too)
  const cap = saveCapacity(state, ref).cap;
  const goals = goalsOf(state).map(g => ({ g, p: goalPlan(state, g, ref, cap) }));
  const goalReserve = goals.reduce((a, x) => a + x.p.reserve, 0);
  const goalIn = goals.reduce((a, x) => a + Math.max(0, x.p.thisMonth), 0);
  const goalHeld = goals.reduce((a, x) => a + Math.max(0, x.p.saved), 0);
  const spentMonth = monthStats(state, ym).total;
  const spentToday = sum(state.entries.filter(e => e.date === ref));
  const hasIncome = income > 0;
  const byIncome = income - oblPaid - oblDue - goalIn - goalReserve - spentMonth;
  const accs = state.kv.accounts || {};
  const hasBal = ['savings', 'cash', 'card'].some(k => accs[k]?.baseTs > 0);
  const bal = balances(state);
  const byCash = bal.net - oblDue - goalReserve - goalHeld; // (v1.9) only money that is really here
  if (!hasIncome && !hasBal) return { ok: false, daysLeft, spentToday, spentMonth };
  let left, mode;
  // (v1.9.1, 2026-11-16, Ahmad: "شو هالقلتش" at 0.000: this month's spending was more than the income that ARRIVED this month (the rest
  // came out of savings), so the income line went negative while real money was still there) with balances entered, the money that is
  // really here decides; the income line is only used when there are no balances
  if (hasBal || !hasIncome) { left = byCash; mode = 'cash'; }
  else { left = byIncome; mode = 'income'; }
  const floor3 = x => Math.floor(x * 1000) / 1000; // (v1.9: whole-dinar flooring showed 0 for a small but real daily share)
  const todayBudget = floor3((left + spentToday) / daysLeft); // the share of today, before today's spending
  const today_ = todayBudget - spentToday;
  const todayIfComing = coming > 0 ? floor3((left + coming + spentToday) / daysLeft) - spentToday : null;
  return { ok: true, mode, today: today_, todayBudget, left, daysLeft, mEnd, income, incGot, incExp, recvExp, incomeEst, usualBasis: usual.basis, coming, todayIfComing,
    oblPaid, oblDue, goalReserve, goalIn, goalHeld, goals, spentMonth, spentToday, byIncome, byCash, net: bal.net, hasBal };
}
