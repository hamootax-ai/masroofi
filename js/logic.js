// Pure business logic: balances, month stats, card cycle, projection, advice, note parsing.
import { jd, jdShort, toFils, today, monthKey, addMonths, addMonthsDate, daysBetween, daysInMonth, parseYmd, ymd, EN_MONTHS, AR_MONTHS, uid } from './util.js';

export const ACCOUNTS = { cash: 'كاش', card: 'بطاقة', savings: 'توفير' };

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
  cats: ['cat', 'cats', 'vet', 'litter', 'cat food', 'قطط', 'قطة', 'بس', 'بيطري', 'رمل'],
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
const AR_MONTH_ALIASES = [...AR_MONTHS.map((m, i) => [m, i]), ...['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'].map((m, i) => [m, i]), ['اذار', 2], ['ايار', 4], ['ابريل', 3], ['اكتوبر', 9], ['اغسطس', 7]];
AR_MONTH_ALIASES.sort((a, b) => b[0].length - a[0].length);
const NUM = '(\\d+(?:[.,]\\d+)?)';
const CUR = '(?:jd|jod|دينار|د\\.?أ|دنانير)';

function normDigits(s) { return s.replace(/[٠-٩]/g, d => '٠١٢٣٤٥٦٧٨٩'.indexOf(d)).replace(/٫/g, '.'); }

export function parseDateLine(line, refDate = today()) {
  const l = normDigits(line).trim().replace(/,/g, ' ').replace(/\s+/g, ' ');
  let month = -1, day = NaN, year = NaN;
  const words = l.toLowerCase().replace(/(\d)(st|nd|rd|th)\b/g, '$1').split(' ').filter(w => !/^(sun|mon|tue|wed|thu|fri|sat)[a-z]*\.?$/.test(w));
  const isMonth = w => EN_MONTHS.findIndex(m => { const x = w.replace(/\.$/, ''); return x.length >= 3 && m.toLowerCase().startsWith(x); });
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
    if (new Date(year, month, day) - ref > 31 * 86400000) year--; // a "December 30" note read in January
  }
  return ymd(new Date(year, month, day));
}

/** Parse his daily note. Returns {date, items:[{amount, text, cat, sub, rafah}], total, rafahTotal, warnings[]} */
export function parseNote(text, categories, refDate = today()) {
  const lines = String(text || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  let date = null, total = null, rafahTotal = null;
  const items = [], warnings = [], skipped = [];
  for (const raw of lines) {
    const line = normDigits(raw);
    if (/^(total|المجموع|مجموع|الاجمالي|الإجمالي)\b/i.test(line) || /total/i.test(line) || /\/\/\s*rafah/i.test(line)) {
      const tm = line.match(new RegExp(`(?:total|مجموع|المجموع|اجمالي|إجمالي)[^\\d]*${NUM}`, 'i'));
      if (tm) total = toFils(tm[1]);
      const rm = line.match(new RegExp(`(?:rafah\\w*|رفاهي?ة)[^\\d]*${NUM}`, 'i'));
      if (rm) rafahTotal = toFils(rm[1]);
      continue;
    }
    if (!date && !/\d+(?:[.,]\d+)?\s*(jd|jod)/i.test(line)) {
      const d = parseDateLine(line, refDate);
      if (d) { date = d; continue; }
    }
    let m = line.match(new RegExp(`^${CUR}?\\s*${NUM}\\s*${CUR}?\\s+(.+)$`, 'i'));
    let amount, desc;
    if (m) { amount = toFils(m[1]); desc = m[2]; }
    else if ((m = line.match(new RegExp(`^(.+?)\\s*[:\\-–]?\\s*${CUR}?\\s*${NUM}\\s*${CUR}?$`, 'i')))) { amount = toFils(m[2]); desc = m[1]; }
    if (!desc || !(amount > 0)) { skipped.push(raw); continue; }
    desc = desc.replace(/^[-–:•*]+\s*/, '').trim();
    const g = guessCategory(desc, categories);
    const cat = categories.find(c => c.id === g.cat);
    const rafah = /rafah|رفاهية/i.test(desc) ? true : !!cat?.rafah;
    items.push({ amount, text: desc, cat: g.cat, sub: g.sub, rafah: cat?.kind === 'sadaqa' ? false : rafah });
  }
  const sum = items.reduce((a, i) => a + i.amount, 0);
  if (total != null && total !== sum) warnings.push(`المجموع بالملاحظة ${jd(total)} بس مجموع البنود ${jd(sum)}`);
  const rSum = items.filter(i => i.rafah).reduce((a, i) => a + i.amount, 0);
  if (rafahTotal != null && rafahTotal !== rSum) warnings.push(`الرفاهية بالملاحظة ${jd(rafahTotal)} بس المحسوب ${jd(rSum)}`);
  if (skipped.length) warnings.push(`ما فهمت هالسطور: ${skipped.join(' / ')}`);
  return { date: date || refDate, dateFound: !!date, items, total, rafahTotal, sum, warnings };
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
  for (const e of state.entries) ev.push({ acc: e.from, inflow: -e.amount, ts: e.ts });
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
  const base = bal.net - oblTotal - spendTotal;
  return { X, days, months, liquidity: bal.net, incomes: inc, sureInc, allInc, obligations: obl.list, noDate: obl.noDate, oblTotal, spendAvg: spend.avg, spendBasis: spend.basis, spendTotal, worst: base + sureInc, best: base + allInc };
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
  const avg = categoryAvg(state, ym, e.cat);
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

  const ms = monthStats(state, ym);
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
  if (cc.dueAmount > 0 && cc.daysLeft <= 30) lines.push(`البطاقة مستحق عليها ${jd(cc.dueAmount)} يوم ${cc.dueDate} (محسوبة بالسيولة).`);
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
