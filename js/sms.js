// Bank SMS parsing (pure). Savings SMS are Arabic, card SMS are English.
import { toFils, pad } from './util.js';
import { guessCategory } from './logic.js';

const normDigits = s => String(s || '').replace(/[٠-٩]/g, d => '٠١٢٣٤٥٦٧٨٩'.indexOf(d)).replace(/٫/g, '.');
export const normalize = s => normDigits(s).replace(/[‎‏‪-‮⁦-⁩]/g, '').replace(/\s+/g, ' ').trim();

/** Stable 53-bit string hash (cyrb53) as hex. */
export function hash(str) {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) { const ch = str.charCodeAt(i); h1 = Math.imul(h1 ^ ch, 2654435761); h2 = Math.imul(h2 ^ ch, 1597334677); }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16);
}

/** Split pasted text or the Shortcuts file into single messages. */
export function splitMessages(text) {
  const t = String(text || '').replace(/\r\n?/g, '\n');
  let parts = t.split(/\n\s*-{3,}\s*(?:\n|$)/);
  if (parts.length === 1) {
    // pasted without separators: split before each message start
    parts = t.split(/\n+(?=\s*(?:تم\s+(?:إيداع|ايداع|دفع|تحويل)|سحب\s+نقدي|JOD\s*[\d.,]+\s+was\s+))/i);
  }
  return parts.map(p => p.trim()).filter(p => p && /\d/.test(p));
}

const NUM = '([\\d,]+(?:\\.\\d+)?)';
const num = s => toFils(String(s).replace(/,/g, ''));

/** dd/mm/yyyy with optional time like "11:47 AM", "PM 10:02", "14:26:42". Returns {date, at} (at = sortable minutes). */
function parseWhen(t) {
  const dm = t.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (!dm) return { date: null, at: null };
  const [, d, m, y] = dm.map(Number);
  const date = `${y}-${pad(m)}-${pad(d)}`;
  let h = 0, mi = 0;
  const tm = t.match(/(AM|PM|ص|م)?\s*(\d{1,2}):(\d{2})(?::\d{2})?\s*(AM|PM|ص|م)?/i);
  if (tm) {
    h = +tm[2]; mi = +tm[3];
    const ap = (tm[1] || tm[4] || '').toUpperCase();
    if ((ap === 'PM' || ap === 'م') && h < 12) h += 12;
    if ((ap === 'AM' || ap === 'ص') && h === 12) h = 0;
  }
  return { date, at: Date.UTC(y, m - 1, d, h, mi) };
}

const BILL_SUBS = [
  [/fiber|fibre|فايبر/i, 'فايبر'],
  [/jordan valley|miyahuna|water|مياه|مياهنا|yarmouk|aqaba water/i, 'ماء'],
  [/zain|orange|umniah|زين|اورنج|أمنية/i, 'خط'],
  [/edco|jepco|ideco|electric|كهرباء/i, 'كهرباء'],
  [/social security|ضمان/i, 'ضمان'],
];
export const billSub = name => (BILL_SUBS.find(([re]) => re.test(name)) || [, ''])[1];

const MERCHANTS = [
  [/gas station|manarah|manaseer|total|jopetrol|jo petrol|petrol|fuel/i, 'gas'],
  [/hypermax|carrefour|safeway|cozmo|supermarket|super market|market|bakery/i, 'groceries'],
  [/clinic|pharmac|hospital|medical|lab\b|dental|gym/i, 'health'],
  [/pets?\b|vet\b|veterinar|toys/i, 'cats'],
  [/chickano|kfc|mcdonald|burger|pizza|shawarma|cafe|coffee|restaurant|starbucks|snack|sweets/i, 'rafah'],
];
export function merchantCategory(merchant, categories) {
  const hit = MERCHANTS.find(([re]) => re.test(merchant));
  if (hit && categories.some(c => c.id === hit[1])) return { cat: hit[1], sub: '' };
  return guessCategory(merchant, categories);
}

/** Parse one message. kinds: deposit | bill | cliq | atm | card_debit | card_credit | unknown */
export function parseSms(raw, categories) {
  const t = normalize(raw);
  const h = hash(t);
  const refM = t.match(/Ref:\s*([\w.\-]+)/i);
  const ref = refM ? refM[1] : null;
  const balM = t.match(new RegExp(`الرصيد\\s*المتوفر\\s*${NUM}`));
  const base = { raw: String(raw).trim(), text: t, hash: h, ref, balance: balM ? num(balM[1]) : null, ...parseWhen(t) };
  let m;
  if ((m = t.match(new RegExp(`تم\\s+(?:إيداع|ايداع)\\s+مبلغ\\s*${NUM}`)))) {
    const src = (t.match(/من\s+(.+?)\s+بتاريخ/) || [])[1] || '';
    const atm = /صراف/.test(src);
    return { ...base, kind: 'deposit', amount: num(m[1]), account: 'savings', source: src.replace(/^صراف\s*(?:الي|آلي|الى|آلى)\s*/, '').trim() || src, viaAtm: atm };
  }
  if ((m = t.match(new RegExp(`تم\\s+دفع\\s+فاتورة\\s+(.+?)\\s+رقم\\s+(\\S+)\\s+بقيمة\\s*${NUM}\\s*دينار(?:\\s*و?\\s*عمولة\\s+بقيمة\\s*${NUM})?`)))) {
    const amount = num(m[3]), fee = m[4] ? num(m[4]) : 0;
    return { ...base, kind: 'bill', biller: m[1].trim(), billNo: m[2], amount: amount + fee, billAmount: amount, fee, account: 'card', cat: categories.some(c => c.id === 'bills') ? 'bills' : guessCategory(m[1], categories).cat, sub: billSub(m[1]) };
  }
  if ((m = t.match(new RegExp(`تم\\s+تحويل\\s+كليك\\s+بمبلغ\\s*${NUM}`)))) {
    const to = (t.match(/(?:إلى|الى)\s+(?:حساب\s+)?(\S+)/) || [])[1] || '';
    return { ...base, kind: 'cliq', amount: num(m[1]), account: 'savings', to };
  }
  if ((m = t.match(new RegExp(`سحب\\s+نقدي[^\\d]*${NUM}`)))) {
    return { ...base, kind: 'atm', amount: num(m[1]), account: 'savings' };
  }
  if ((m = t.match(new RegExp(`JOD\\s*${NUM}\\s+was\\s+debited\\s+from\\s+credit\\s+card\\s+ending\\s+(\\d+)\\s+at\\s+(.+?)\\s*\\.?\\s*Available\\s+balance\\s+JOD\\s*${NUM}`, 'i')))) {
    const merchant = m[3].replace(/\s+\.$/, '').trim();
    const housing = /housing\s*bank|بنك\s*الإسكان/i.test(merchant);
    const g = housing ? { cat: 'bills', sub: '' } : merchantCategory(merchant, categories);
    return { ...base, kind: 'card_debit', amount: num(m[1]), card: m[2], merchant, available: num(m[4]), account: 'card', cat: g.cat, sub: g.sub, viaHousing: housing };
  }
  if ((m = t.match(new RegExp(`JOD\\s*${NUM}\\s+was\\s+credited\\s+(?:to|on)\\s+(?:your\\s+)?credit\\s+card\\s+ending\\s+(\\d+)(?:\\s+(?:at|from)\\s+(.+?))?\\s*\\.?\\s*Available\\s+balance\\s+JOD\\s*${NUM}`, 'i')))) {
    return { ...base, kind: 'card_credit', amount: num(m[1]), card: m[2], merchant: (m[3] || '').trim(), available: num(m[4]), account: 'card' };
  }
  const any = t.match(/(?:JOD\s*)?(\d+\.\d{1,3})/);
  return { ...base, kind: 'unknown', amount: any ? num(any[1]) : 0, account: 'savings', cat: guessCategory(t, categories).cat };
}

/** Pair each bill with a card debit "at Housing Bank" of the same total; the pair becomes one card expense. */
export function mergeBillCard(items) {
  const cards = items.filter(i => i.kind === 'card_debit' && i.viaHousing && !i.mergedInto);
  for (const b of items.filter(i => i.kind === 'bill')) {
    const c = cards.find(x => !x.mergedInto && x.amount === b.amount);
    if (c) { c.mergedInto = b.hash; b.cardHash = c.hash; b.available = c.available; b.account = 'card'; b.cardMatched = true; }
  }
  return items;
}

/** Full pipeline: split → parse → drop duplicates (already seen or repeated in the batch) → merge pairs. */
export function parseBatch(text, categories, seen = {}) {
  const out = [], batch = new Set();
  let dups = 0;
  for (const raw of splitMessages(text)) {
    const it = parseSms(raw, categories);
    const refKey = it.ref ? `ref:${it.ref}:${it.amount}` : null;
    if (seen[it.hash] || (refKey && seen[refKey]) || batch.has(it.hash)) { dups++; continue; }
    batch.add(it.hash);
    it.refKey = refKey;
    out.push(it);
  }
  mergeBillCard(out);
  return { items: out, dups };
}
