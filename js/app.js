import * as db from './db.js';
import { uid, toFils, jd, jdShort, nDays, nItems, today, thisMonth, addMonths, monthLabel, dayLabel, dateShort, parseYmd, ymd, daysBetween, esc, sha256, AR_MONTHS } from './util.js';
import * as L from './logic.js';
import * as C from './claude.js';
import * as SMS from './sms.js';
import * as IN from './inbox.js';

export const APP_VERSION = '1.9.1';
// (2026-11-14, Ahmad: "for now yes lets keep it manual") manual logging only: the bank-SMS import + auto inbox are hidden (code kept: set false to bring them back)
// (same day, later: "نكمله اوتوماتيكي") back on: manual logging AND the automatic bank-SMS inbox
const MANUAL_ONLY = false;

/* (v1.7) Settings -> "📥 استيراد بيانات": paste a JSON block. It only ADDS (never replaces); exact duplicates are skipped.
   Amounts are JD numbers (100, 12.5) and become integer fils. Dates are "YYYY-MM-DD". Every list is optional.
{
  "incomes": [        // expected income (فلوسي -> دخل)
    { "source": "مثال راتب", "amount": 100, "date": "2026-12-01",
      "recur": "monthly",           // "none" (default) | "monthly" | "yearly" | "months"
      "months": [],                 // with "months": the month numbers 1..12, e.g. [3, 9]
      "sure": true }                // default true; only sure income goes into the worst case
  ],
  "obligations": [    // what he owes (فلوسي -> التزامات)
    { "title": "مثال قسط", "amount": 100,  // the FULL amount
      "due": "2026-12-05",          // or null (then it is not in the projection)
      "priority": "mid",            // "high" | "mid" (default) | "low"
      "monthly": false,             // repeats every month after it is paid
      "paid": 0 }                   // optional: already paid before the app (touches no balance)
  ],
  "receivables": [    // what people owe HIM (فلوسي -> إلي)
    { "who": "مثال", "amount": 100, // or null when it is not one number...
      "amountText": "",             // ...then e.g. "100-150" / "حسب الحكم"
      "expected": "2027-01-15",     // a date, or free text ("بعد الموسم"); "due" also takes a date
      "sure": false,                // default false; only sure + a number + a date counts in the projection
      "note": "" }
  ]
}
   Duplicate = same source+amount+date (income), title+amount+due (obligation), who+amount+amountText+date+expected (receivable). */
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];

// ---------------- State ----------------
const state = { entries: [], transfers: [], incomes: [], obligations: [], receivables: [], chat: [], kv: {} };
const DEFAULT_SETTINGS = { rafahBudget: 60000, stmtDay: 20, dueDay: 4, model: 'claude-haiku-5-5', customModel: '', deepModel: 'claude-opus-5-5', prices: structuredClone(C.DEFAULT_PRICES), pricesVersion: 2, capUsd: 5, notes: '', sortByUse: true, catNudges: false, theme: 'dark' };
// (v1.8) catNudges: the "📈 X this month vs your average. شو صاير؟" notes, opt-in (Ahmad found them annoying). theme: dark | light | auto
const ui = {
  view: 'add', dayDate: today(), monthYm: thisMonth(), moneySeg: 'acc', projDate: null,
  qa: null, parsed: null, pendingImg: null, sending: false, persisted: null,
};
function resetQA(keepFrom) { ui.qa = { amount: '', cat: null, sub: '', note: '', from: keepFrom || 'cash', date: today(), rafah: false, rafahTouched: false }; }
resetQA();

async function load() {
  await db.openDB();
  for (const s of db.STORES) state[s] = await db.getAll(s);
  state.kv = await db.kvAll();
  const kv = state.kv;
  if (!kv.categories) { kv.categories = structuredClone(L.DEFAULT_CATEGORIES); await db.kvSet('categories', kv.categories); }
  if (!kv.accounts) { kv.accounts = { savings: { base: 0, baseTs: 0 }, cash: { base: 0, baseTs: 0 }, card: { base: 0, baseTs: 0, limit: 0 } }; await db.kvSet('accounts', kv.accounts); }
  const savedPricesVersion = kv.settings ? (kv.settings.pricesVersion || 1) : 2;
  kv.settings = { ...DEFAULT_SETTINGS, ...(kv.settings || {}) };
  kv.settings.prices = { ...C.DEFAULT_PRICES, ...(kv.settings.prices || {}) };
  if (savedPricesVersion < 2) { // v1 shipped placeholder prices: move untouched ones to the list prices
    for (const [m, old] of Object.entries(C.OLD_DEFAULT_PRICES)) { const cur = kv.settings.prices[m]; if (cur && cur[0] === old[0] && cur[1] === old[1]) kv.settings.prices[m] = [...C.DEFAULT_PRICES[m]]; }
    kv.settings.pricesVersion = 2;
  }
  await db.kvSet('settings', kv.settings);
  state.chat.sort((a, b) => a.ts - b.ts);
}

async function saveRec(store, rec) {
  const arr = state[store]; const i = arr.findIndex(r => r.id === rec.id);
  if (i >= 0) arr[i] = rec; else arr.push(rec);
  await db.put(store, rec);
}
async function delRec(store, id) { state[store] = state[store].filter(r => r.id !== id); await db.del(store, id); }
async function setKV(key, val) { state.kv[key] = val; await db.kvSet(key, val); }
const saveSettings = () => setKV('settings', state.kv.settings);
const settings = () => state.kv.settings;

// ---------------- Small UI helpers ----------------
let toastTimer;
function toast(msg, actLabel, act) {
  const t = $('#toast');
  t.innerHTML = `<div class="toast"><span>${esc(msg)}</span>${actLabel ? `<button id="toastAct">${esc(actLabel)}</button>` : ''}</div>`;
  if (act) $('#toastAct').onclick = () => { t.innerHTML = ''; act(); };
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.innerHTML = ''; }, actLabel ? 5000 : 2600);
}
function openSheet(html, bind) {
  $('#sheet').innerHTML = `<div class="sheet-bg" id="sheetBg"><div class="sheet" role="dialog">${html}</div></div>`;
  $('#sheetBg').addEventListener('click', e => { if (e.target.id === 'sheetBg') closeSheet(); });
  bind?.($('#sheet .sheet'));
}
const closeSheet = () => { $('#sheet').innerHTML = ''; };
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); }
  catch {
    const ta = document.createElement('textarea'); ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select(); try { document.execCommand('copy'); } catch {} ta.remove();
  }
  toast('انسخ ✓');
}
const amt = f => `<span class="amt">${jd(f)}</span>`;
const fd = s => s ? `<bdi>${dateShort(s)}</bdi>` : '';
// Native date pickers stay (best on iPhone) but are invisible; the visible text is always our Arabic style.
const dateField = (id, value, attrs = '', empty = 'بدون تاريخ') => `<label class="datebox"><span class="dlabel" data-empty="${empty}">${value ? dayLabel(value) : empty}</span><input id="${id}" type="date" value="${value || ''}" ${attrs}></label>`;
const monthField = (id, ym) => `<label class="datebox"><span class="dlabel">${monthLabel(ym)}</span><input id="${id}" type="month" value="${ym}"></label>`;
const CAL_SVG = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="3"/><path d="M3 10h18M8 3v4M16 3v4"/></svg>';
const iso = s => `⁦${s}⁩`;
const accOptions = (sel, list = ['cash', 'card', 'savings']) => list.map(a => `<option value="${a}" ${a === sel ? 'selected' : ''}>${L.ACCOUNTS[a]}</option>`).join('');
const catOptions = sel => state.kv.categories.map(c => `<option value="${c.id}" ${c.id === sel ? 'selected' : ''}>${esc(c.icon || '')} ${esc(c.name)}</option>`).join('');
const fromSeg = (name, sel, withNone = false) => `<div class="seg ${withNone ? 'wrap' : ''}" data-seg="${name}">${['cash', 'card', 'savings', ...(withNone ? ['none'] : [])].map(a => `<button type="button" data-act="seg" data-name="${name}" data-val="${a}" class="${a === sel ? 'on' : ''}">${L.ACCOUNTS[a]}</button>`).join('')}</div>${withNone ? `<div class="sub nonehint ${sel === 'none' ? '' : 'hidden'}">بينحسب بمجموع اليوم والشهر والرفاهية، بس ما بيغيّر أي رصيد. للمصاريف اللي صرفتها قبل ما تكتب أرصدتك الحقيقية.</div>` : ''}`;
const isStandalone = () => window.navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
const fmtUsd = n => '$' + (n || 0).toFixed(!n ? 2 : n < 0.01 ? 5 : n < 0.1 ? 4 : 2);

function sortedCats() {
  const cats = [...state.kv.categories].sort((a, b) => a.order - b.order);
  if (!settings().sortByUse) return cats;
  const since = ymd(new Date(Date.now() - 90 * 86400000));
  const use = {};
  for (const e of state.entries) if (e.date >= since) use[e.cat] = (use[e.cat] || 0) + 1;
  return cats.sort((a, b) => (use[b.id] || 0) - (use[a.id] || 0) || a.order - b.order);
}

// ---------------- Views ----------------
const TITLES = { add: 'مصروفي', day: 'اليوم', month: 'الشهر', money: 'فلوسي', ask: 'اسأل كلاود', settings: 'الإعدادات', sms: 'رسائل البنك', goals: 'أهداف التوفير' };

function render() {
  const v = ui.view;
  $('#title').textContent = TITLES[v];
  const hb = $('#hdrBtn');
  if (SUB.includes(v)) { hb.dataset.act = 'back'; delete hb.dataset.v; hb.innerHTML = '→ رجوع'; hb.setAttribute('aria-label', 'رجوع'); hb.classList.add('back'); }
  else { hb.dataset.act = 'go'; hb.dataset.v = 'settings'; hb.innerHTML = '⚙️'; hb.setAttribute('aria-label', 'الإعدادات'); hb.classList.remove('back'); }
  $$('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.v === v));
  $('#view').innerHTML = VIEWS[v]();
  AFTER[v]?.();
}
const SUB = ['settings', 'sms', 'goals'];
function go(v) {
  if (v === 'sms' && !ui.sms) openReview(); if (SUB.includes(v) && !SUB.includes(ui.view)) ui.prevView = ui.view; ui.view = v; render(); window.scrollTo(0, 0); }

/** Backup reminder level: never exported = yellow, red once there's been data for 3+ days; exported = ok, yellow after 7 days. */
function backupStatus() {
  const lb = state.kv.lastBackup;
  const recs = [...state.entries, ...state.incomes, ...state.obligations, ...state.receivables, ...state.transfers];
  const hasData = recs.length > 0;
  if (!lb) {
    const firstTs = hasData ? Math.min(...recs.map(r => r.ts || Date.now())) : Date.now();
    return { hasData, level: hasData && Date.now() - firstTs > 3 * 86400000 ? 'red' : 'yellow', text: 'ولا مرة', remind: hasData };
  }
  const days = Math.floor((Date.now() - lb) / 86400000);
  return { hasData, level: days > 7 ? 'yellow' : 'ok', text: days === 0 ? 'اليوم' : `قبل ${days} يوم`, remind: hasData && days > 7 };
}

function balancesCard() {
  const b = L.balances(state);
  const cc = L.cardCycle(state);
  const bs = backupStatus();
  return `<div class="card balcard" id="balCard">
    <div class="balhead"><span class="lbl">الصافي <span class="sub">(توفير + كاش − البطاقة)</span></span><b class="amt ${b.net < 0 ? 'bad' : ''}" id="netBig">${jd(b.net)}</b></div>
    <div class="baltiles"><div><span>توفير</span><b class="amt">${jd(b.savings)}</b></div><div><span>كاش</span><b class="amt">${jd(b.cash)}</b></div><div><span>بطاقة</span><b class="amt">${jd(b.card)}</b></div></div>
    <div class="minirow"><span>💳 مستحق يوم ${parseYmd(cc.dueDate).getDate()}: <b class="amt">${jd(cc.dueAmount)}</b>${cc.closed ? '' : ' <span class="pill">تقريبي</span>'}</span>
    <span>💾 آخر نسخة: <b id="backupAge" class="bk-${bs.level}">${bs.text}</b></span></div>
  </div>`;
}

// (v1.8, 2026-11-16, Ahmad: "ياريت و ياريت") 💸 الضايل الآمن: ONE number on home, how much he can spend today and stay on track. Tap = the math.
function safeCard() {
  const sf = L.safeToSpend(state);
  const head = `<div class="spendrow"><div><span>صرفت اليوم</span><b class="amt" id="spentToday">${jd(sf.spentToday)}</b></div><div><span>هالشهر</span><b class="amt" id="spentMonth">${jd(sf.spentMonth)}</b></div></div>`;
  if (!sf.ok) return `<div class="card safe" id="safeCard" data-act="safeInfo" role="button"><div class="safelbl">💸 الضايل الآمن لليوم</div>
    <div class="safehint">ضيف دخلك (فلوسي ← دخل) أو اكتب أرصدتك، وبحسبلك كم فيك تصرف كل يوم.</div>${head}</div>`;
  const lvl = sf.today <= 0 ? 'lv-bad' : sf.today < sf.todayBudget * 0.35 ? 'lv-warn' : 'lv-good';
  return `<div class="card safe ${lvl}" id="safeCard" data-act="safeInfo" role="button" aria-label="الضايل الآمن، اضغط للتفاصيل">
    <div class="safelbl">💸 الضايل الآمن لليوم <span class="info">؟</span></div>
    <div class="safebig amt" id="safeToday">${jd(Math.max(0, sf.today))}<small>د.أ</small></div>
    <div class="safesub">${sf.today <= 0 ? (sf.left <= 0 ? 'خلص مصروف هالشهر، بس الضروري لآخره' : 'خلصت حصة اليوم، بكرا بترجع') : `لآخر الشهر <b class="amt">${jd(Math.max(0, sf.left))}</b> · ${nDays(sf.daysLeft)}`}</div>
    ${head}</div>`;
}

function safeSheet() {
  const sf = L.safeToSpend(state);
  const r = L.rafahStatus(state), cc = L.cardCycle(state);
  const row = (label, v, cls = '') => `<div class="kv"><span>${label}</span><span class="amt ${cls}">${v}</span></div>`;
  const body = !sf.ok ? `<p>لسا ما في دخل مسجل ولا أرصدة. ضيف دخلك المتوقع من <b>فلوسي ← دخل</b> (أو اكتب أرصدتك بـ <b>فلوسي ← حسابات</b>) وبطلعلك الرقم.</p>` : `
    <div class="safebig amt" style="text-align:center">${jd(Math.max(0, sf.today))}<small>د.أ</small></div>
    <div class="sub" style="text-align:center;margin-bottom:8px">${sf.mode === 'cash' ? 'محسوب من فلوسك الموجودة (ما في دخل مسجل)' : 'محسوب من دخل هالشهر'}</div>
    <div class="explain">
    ${sf.mode === 'income' ? `${row(sf.incomeEst ? `+ دخل الشهر (تقدير: ${esc(sf.usualBasis)})` : '+ دخل وصل هالشهر', jd(sf.income), 'good')}
    ${row('− التزامات هالشهر', jd(sf.oblPaid + sf.oblDue), 'bad')}
    ${row('− أهداف التوفير هالشهر', jd(sf.goalIn + sf.goalReserve), 'bad')}
    ${row('− صرفت هالشهر', jd(sf.spentMonth), 'bad')}` : `${row('الصافي هلأ (توفير + كاش − البطاقة)', jd(sf.net))}
    ${row('− التزامات لآخر الشهر', jd(sf.oblDue), 'bad')}
    ${row('− محجوز للأهداف', jd(sf.goalHeld + sf.goalReserve), 'bad')}`}
    <div class="totalrow"><span>= ضايل لآخر الشهر</span><span class="amt" id="safeLeft">${jd(sf.left)}</span></div>
    ${row(`÷ ${nDays(sf.daysLeft)} (مع اليوم)`, jd(sf.todayBudget))}
    ${sf.spentToday ? row('− صرفت اليوم', jd(sf.spentToday), 'bad') : ''}
    </div>
    ${sf.coming > 0 ? `<div class="banner yellow">⏳ جاي بس لسا ما وصل: <b class="amt">${jd(sf.coming)}</b> (دخل متوقع + ديون الك). ما بينحسب إلا لما يوصل. لما يوصل بتصير حصة اليوم تقريباً <b class="amt">${jd(Math.max(0, sf.todayIfComing))}</b>.</div>` : ''}
    <ul class="dots">
      <li>🎉 الرفاهية: ضايلك <b class="amt">${jd(Math.max(0, r.left))}</b> من <span class="amt">${jd(r.budget)}</span> هالشهر (من ضمن الرقم، مش زيادة عليه).</li>
      <li>💳 البطاقة: مصاريفها محسوبة لما صرفتها، والسداد (${jd(cc.dueAmount)} يوم ${parseYmd(cc.dueDate).getDate()}) تحويل من التوفير، فما بينحسب مرتين.</li>
      <li>📅 الدخل المتوقع والديون اللي الك ما بتنحسب إلا لما توصل فعلاً (قاعدتك). الالتزامات اللي بدون تاريخ مش محسوبة.</li>
    </ul>`;
  openSheet(`<h3>💸 الضايل الآمن لليوم</h3>${body}<button class="btn" id="sfOk" style="margin-top:10px">تمام</button>`, sh => { sh.querySelector('#sfOk').onclick = closeSheet; });
}

// (v1.8) 🎯 goals on home: compact, one row each; tap = the goals screen
const goalBar = p => `<div class="bar ${p.done ? 'ok' : 'goal'}"><i style="width:${(p.pct * 100).toFixed(1)}%"></i></div>`;
function goalsHomeCard() {
  const gs = L.goalsOf(state);
  if (!gs.length) return `<button class="btn ghost goalcta" data-act="go" data-v="goals">🎯 حط هدف توفير</button>`;
  const cap = L.saveCapacity(state).cap;
  return `<div class="card goalscard" id="goalsHome"><div class="cardhead"><h2>🎯 أهدافي</h2><button class="linkbtn" data-act="go" data-v="goals">الكل ←</button></div>
    ${gs.map(g => { const p = L.goalPlan(state, g, today(), cap); return `<div class="goalrow" data-act="go" data-v="goals">
      <div class="gtop"><span class="gname">${esc(g.icon || '🎯')} ${esc(g.name)}</span><span class="gpct amt">${Math.round(p.pct * 100)}%</span></div>
      ${goalBar(p)}
      <div class="gsub"><span><span class="amt">${jd(p.saved)}</span> من <span class="amt">${jd(g.target)}</span></span><span>${p.done ? '🎉 وصلت' : p.perMonth ? `<b class="amt">${jdShort(p.perMonth)}</b> بالشهر` : p.eta ? `توصل ${monthLabel(p.eta)}` : ''}</span></div></div>`; }).join('')}</div>`;
}

function bannersHtml() {
  const list = [...L.adviceBanners(state)];
  const bs = backupStatus();
  if (bs.remind) list.push({ level: bs.level === 'red' ? 'red' : 'yellow', text: `💾 ${state.kv.lastBackup ? 'صارلك أكثر من أسبوع بدون نسخة احتياطية.' : 'ما عملت نسخة احتياطية لسا.'} <button class="btn sm" data-act="export" style="display:inline-flex;margin-top:6px">صدّر هلأ</button>` });
  if (!isStandalone()) list.unshift({ level: 'blue', text: '📲 إنت فاتح من المتصفح. البيانات هون منفصلة عن التطبيق المثبّت، افتح دايماً من أيقونة الشاشة الرئيسية. <a href="#" data-act="guide">كيف؟</a>' });
  return list.map(b => `<div class="banner ${b.level}">${b.text}</div>`).join('');
}

const VIEWS = {};
const AFTER = {};

// ----- Quick add -----
VIEWS.add = () => {
  const q = ui.qa;
  const cat = q.cat && L.catById(state, q.cat);
  return `${safeCard()}
  <div class="card qa" id="qaCard">
    <label class="qalbl" for="qaAmount">كم صرفت؟</label>
    <div class="amtbox"><input id="qaAmount" class="amount-in big" type="text" inputmode="decimal" enterkeyhint="next" placeholder="0.000" value="${esc(q.amount)}" autocomplete="off" aria-label="المبلغ"><span class="cur">د.أ</span></div>
    <div class="cats" id="qaCats">${sortedCats().map(c => `<button type="button" data-act="pickCat" data-id="${c.id}" class="${q.cat === c.id ? 'on' : ''}"><span class="ic">${esc(c.icon || '•')}</span>${esc(c.name)}</button>`).join('')}</div>
    ${cat?.subs?.length ? `<div class="chips">${cat.subs.map(s => `<button type="button" class="chip ${q.sub === s ? 'on' : ''}" data-act="pickSub" data-val="${esc(s)}">${esc(s)}</button>`).join('')}</div>` : ''}
    <label class="field"><span>ملاحظة</span><input id="qaNote" type="text" value="${esc(q.note)}" placeholder="مثلاً groceries"></label>
    <div class="field"><span>دفعت من</span>${fromSeg('qaFrom', q.from, true)}</div>
    <div class="row"><div class="field"><span>التاريخ</span>${dateField('qaDate', q.date, `max="${today()}"`)}</div>
    <label class="field toggle" style="margin-top:28px"><span>رفاهية</span><input id="qaRafah" type="checkbox" ${q.rafah ? 'checked' : ''} ${cat?.kind === 'sadaqa' ? 'disabled' : ''}></label></div>
    <button class="btn pri" data-act="qaSave">سجّل</button>
  </div>
  ${goalsHomeCard()}
  ${balancesCard()}
  ${bannersHtml()}
  ${MANUAL_ONLY ? '' : `<button class="btn" data-act="go" data-v="sms" id="smsBtn">📩 رسائل البنك${reviewCount() ? ` <span class="pill warn" id="reviewBadge">${reviewCount()} بدها مراجعة</span>` : ''}</button>${inboxOn() ? `<div class="sub" style="text-align:center" id="homeLastPull">📥 آخر سحب: ${agoText(inboxCfg().lastPull)}</div>` : ''}`}
  <details class="card" id="pasteBox" ${ui.parsed || ui.multi || ui.multiDone ? 'open' : ''}>
    <summary>📋 الصق ملاحظة اليوم</summary>
    <div class="sub" style="margin:6px 0">يوم واحد، أو ملاحظة فيها كذا يوم (كل يوم ببلّش بتاريخ) وأنا بقسمها.</div>
    <textarea id="noteText" placeholder="November 13&#10;20jd groceries&#10;13.15 gasoline&#10;Total 33.15 JD // Rafaheyah 0 JD" dir="auto">${esc(ui.noteText || '')}</textarea>
    <button class="btn" data-act="parse" style="margin-top:8px">حلّل</button>
    <div id="parsed">${parsedHtml()}</div>
  </details>`;
};
AFTER.add = () => {
  const q = ui.qa;
  $('#qaAmount').addEventListener('input', e => { q.amount = e.target.value; });
  $('#qaNote').addEventListener('input', e => { q.note = e.target.value; });
  $('#qaDate').addEventListener('change', e => { q.date = e.target.value || today(); });
  $('#qaRafah').addEventListener('change', e => { q.rafah = e.target.checked; q.rafahTouched = true; });
  $('#noteText').addEventListener('input', e => { ui.noteText = e.target.value; });
};

// (v1.7) a note with many days: one preview for all of them, saved as 'none' entries (his balances are already the real ones)
function multiHtml() {
  const m = ui.multi;
  const { add, skipped } = L.dedupeDayItems(state, m.days);
  const off = m.days.filter(d => d.totalOff).length;
  return `<div class="card hero" id="multiSum" style="margin:10px 0"><div class="lbl">ملاحظة فيها <b>${nDays(m.days.length)}</b> · ${nItems(m.count)}</div>
    <div class="big amt">${jd(m.sum)}</div>
    <div class="minirow" style="justify-content:center"><span>من ${fd(m.from)} لـ ${fd(m.to)}</span></div></div>
  ${m.warnings.map(w => `<div class="banner yellow">${/^[✅ℹ️⚠️]/u.test(w) ? '' : '⚠️ '}${esc(w)}</div>`).join('')}
  ${skipped ? `<div class="banner blue" id="multiDups">↩️ ${skipped} ${skipped === 1 ? 'بند موجود' : 'بنود موجودة'} قبل (نفس التاريخ والمبلغ والنص)، رح أتخطاها.</div>` : ''}
  <div class="banner blue">💡 رح ينحسبوا بمجموع الأيام والشهور والرفاهية، بس <b>ما بيغيّروا أي رصيد</b> (أرصدتك مكتوبة على الحقيقي).</div>
  <button class="btn pri" data-act="mSave" id="mSaveBtn" ${add.length ? '' : 'disabled'}>${add.length ? `ضيف ${nItems(add.length)}` : 'كله موجود قبل'}</button>
  <ul class="list daylist" id="dayList">${m.days.map(d => `<li class="item"><div class="ic">${d.totalOff || d.rafahMatched === false ? '⚠️' : '📅'}</div>
    <div class="main"><div class="t">${dayLabel(d.date)}</div><div class="s">${d.items.length ? nItems(d.items.length) : 'ما في بنود'}${d.items.some(i => i.rafah) ? ` · رفاهية <span class="amt">${jdShort(d.items.filter(i => i.rafah).reduce((a, i) => a + i.amount, 0))}</span>` : ''}</div>
    ${d.totalOff ? `<div class="s warn">المجموع بالملاحظة <span class="amt">${jd(d.total)}</span></div>` : ''}${d.warnings.filter(w => !/^المجموع بالملاحظة/.test(w)).map(w => `<div class="s warn">${esc(w)}</div>`).join('')}</div>
    <div class="v amt">${jd(d.sum)}</div></li>`).join('')}</ul>
  ${off ? '' : `<div class="sub" style="text-align:center">✅ كل الأيام مجموعها مطابق للملاحظة</div>`}`;
}

function parsedHtml() {
  if (ui.multi) return multiHtml();
  const p = ui.parsed;
  if (!p) return ui.multiDone ? `<div class="banner blue" id="multiDone">${ui.multiDone}</div>` : '';
  if (!p.items.length) return `<div class="banner yellow">ما لقيت بنود. الصيغة: <span class="amt">20jd groceries</span></div>`;
  return `${p.warnings.map(w => `<div class="banner yellow">⚠️ ${esc(w)}</div>`).join('')}
  <div class="field"><span>التاريخ ${p.dateFound ? '' : '(ما لقيت تاريخ، حطيت اليوم)'}</span>${dateField('pDate', p.date)}</div>
  <div class="field"><span>دفعت من (للكل)</span>${fromSeg('pFrom', p.from || 'cash', true)}</div>
  ${p.items.map((it, i) => `<div class="edit-row" data-i="${i}">
    <div class="row"><input type="text" inputmode="decimal" class="pAmt amt" value="${jd(it.amount)}" style="flex:.8"><select class="pCat">${catOptions(it.cat)}</select></div>
    <div class="row"><input type="text" class="pNote" value="${esc(it.text)}"><label class="toggle" style="flex:none;gap:6px"><span class="sub">رفاهية</span><input type="checkbox" class="pRafah" ${it.rafah ? 'checked' : ''}></label><button class="iconbtn" data-act="pDel" data-i="${i}" style="flex:none">🗑️</button></div>
  </div>`).join('')}
  <div class="totalrow"><span>المجموع</span><span class="amt" id="pSum">${jd(p.items.reduce((a, i) => a + i.amount, 0))}</span></div>
  <button class="btn pri" data-act="pSave" style="margin-top:10px">احفظ ${p.items.length} ${p.items.length === 1 ? 'بند' : 'بنود'}</button>`;
}
function readParsedEdits() {
  const p = ui.parsed; if (!p) return;
  p.date = $('#pDate')?.value || p.date;
  $$('#parsed .edit-row').forEach(row => {
    const it = p.items[+row.dataset.i];
    it.amount = toFils(row.querySelector('.pAmt').value);
    const newCat = row.querySelector('.pCat').value;
    if (newCat !== it.cat) { it.cat = newCat; it.sub = ''; }
    it.text = row.querySelector('.pNote').value.trim();
    it.rafah = row.querySelector('.pRafah').checked;
  });
}

async function addEntry({ amount, cat, sub = '', note = '', from = 'cash', date = today(), rafah, extra = {} }) {
  const c = L.catById(state, cat);
  const e = { id: uid(), ts: Date.now(), date, amount, cat, sub, note: note.trim(), from, rafah: c?.kind === 'sadaqa' ? false : (rafah ?? !!c?.rafah), ...extra };
  await saveRec('entries', e);
  return e;
}

// ----- Day -----
VIEWS.day = () => {
  const d = ui.dayDate;
  const list = state.entries.filter(e => e.date === d).sort((a, b) => a.ts - b.ts);
  const total = L.sum(list), rafah = L.sum(list.filter(e => e.rafah));
  const dv = L.dayVerdict(state, d);
  const ms = L.monthStats(state, d.slice(0, 7));
  const r = L.rafahStatus(state, d.slice(0, 7));
  return `<div class="navdate"><button class="iconbtn" data-act="dayShift" data-n="-1">→</button>${dateField('dayPick', d)}<button class="iconbtn" data-act="dayShift" data-n="1">←</button></div>
  <div class="card">
    ${list.length ? `<ul class="list">${list.map(e => { const c = L.catById(state, e.cat); const v = L.entryVerdict(state, e); return `<li class="item">
      <div class="ic">${esc(c?.icon || '•')}</div>
      <div class="main"><div class="t">${esc(e.note || c?.name || '')}</div><div class="s">${esc(c?.name || 'محذوفة')}${e.sub ? ' · ' + esc(e.sub) : ''} · ${L.ACCOUNTS[e.from]}${e.rafah ? ' · <span class="pill warn">رفاهية</span>' : ''}</div>${v.level === 'warn' || v.level === 'bad' ? `<div class="s">${v.icon} ${esc(v.text)}</div>` : ''}</div>
      <div class="v">${amt(e.amount)}</div>
      <div class="acts"><button data-act="editEntry" data-id="${e.id}" aria-label="تعديل">✏️</button><button data-act="delEntry" data-id="${e.id}" aria-label="حذف">🗑️</button></div></li>`; }).join('')}</ul>` : '<div class="sub">ما في مصاريف بهاليوم.</div>'}
    <div class="totalrow"><span>مجموع اليوم</span><span class="amt" id="dayTotal">${jd(total)}</span></div>
    <div class="kv"><span>رفاهية اليوم</span><span class="amt">${jd(rafah)}</span></div>
    <div class="kv"><span>مجموع الشهر</span><span class="amt">${jd(ms.total)}</span></div>
    <div class="kv"><span>الرفاهية بالشهر</span><span><span class="amt">${jdShort(r.used)}/${jdShort(r.budget)}</span> (ضايل <span class="amt">${jdShort(r.left)}</span>)</span></div>
    ${dv ? `<div class="verdict" id="dayVerdict">${dv.icon} ${esc(dv.text)}</div>` : ''}
  </div>
  <div class="btns"><button class="btn" data-act="copyDay">📋 انسخ ملاحظة اليوم</button><button class="btn" data-act="askDay">🤖 رأي كلاود</button></div>`;
};
AFTER.day = () => { $('#dayPick').addEventListener('change', e => { if (e.target.value) { ui.dayDate = e.target.value; render(); } }); };

function entrySheet(e) {
  const c = L.catById(state, e.cat);
  openSheet(`<h3>تعديل المصروف</h3>
    <label class="field"><span>المبلغ</span><input id="eAmt" type="text" inputmode="decimal" class="amt" value="${jd(e.amount)}"></label>
    <label class="field"><span>التصنيف</span><select id="eCat">${catOptions(e.cat)}</select></label>
    <label class="field"><span>تفصيل</span><select id="eSub"><option value="">—</option>${(c?.subs || []).map(s => `<option ${s === e.sub ? 'selected' : ''}>${esc(s)}</option>`).join('')}</select></label>
    <label class="field"><span>ملاحظة</span><input id="eNote" type="text" value="${esc(e.note)}"></label>
    <label class="field"><span>دفعت من</span><select id="eFrom">${accOptions(e.from, ['cash', 'card', 'savings', 'none'])}</select></label>
    <div class="field"><span>التاريخ</span>${dateField('eDate', e.date)}</div>
    <label class="field toggle"><span>رفاهية</span><input id="eRafah" type="checkbox" ${e.rafah ? 'checked' : ''}></label>
    <div class="btns"><button class="btn pri" id="eSave">احفظ</button><button class="btn ghost" id="eCancel">إلغاء</button></div>`, sh => {
    sh.querySelector('#eCat').onchange = ev => {
      const nc = L.catById(state, ev.target.value);
      sh.querySelector('#eSub').innerHTML = `<option value="">—</option>${(nc?.subs || []).map(s => `<option>${esc(s)}</option>`).join('')}`;
      sh.querySelector('#eRafah').checked = !!nc?.rafah;
    };
    sh.querySelector('#eCancel').onclick = closeSheet;
    sh.querySelector('#eSave').onclick = async () => {
      const amount = toFils(sh.querySelector('#eAmt').value);
      if (!(amount > 0)) return toast('المبلغ غلط');
      const cat = sh.querySelector('#eCat').value;
      const kind = L.catById(state, cat)?.kind;
      await saveRec('entries', { ...e, amount, cat, sub: sh.querySelector('#eSub').value, note: sh.querySelector('#eNote').value.trim(), from: sh.querySelector('#eFrom').value, date: sh.querySelector('#eDate').value || e.date, rafah: kind === 'sadaqa' ? false : sh.querySelector('#eRafah').checked });
      closeSheet(); render(); toast('انحفظ ✓');
    };
  });
}

// ----- Month -----
// (2026-11-14, Ahmad picked "all" of the redesign ideas) where the month's money went, at a glance: a donut + its legend
const DONUT_COLORS = ['#f2b84b', '#5aa7ff', '#3ccf7e', '#ff7a6b', '#b48cff', '#3fd0c9', '#ff9f43', '#8e98aa'];
function donut(rows) {
  const total = rows.reduce((a, [, v]) => a + v, 0) || 1;
  const top = rows.slice(0, 7);
  const rest = rows.slice(7).reduce((a, [, v]) => a + v, 0);
  const parts = top.map(([id, v], i) => ({ c: L.catById(state, id), v, col: DONUT_COLORS[i] }));
  if (rest > 0) parts.push({ c: { icon: '➕', name: 'الباقي' }, v: rest, col: DONUT_COLORS[7] });
  const R = 52, C = 2 * Math.PI * R;
  let off = 0;
  const arcs = parts.map(p => { const len = p.v / total * C; const a = `<circle r="${R}" cx="70" cy="70" fill="none" stroke="${p.col}" stroke-width="22" stroke-dasharray="${len.toFixed(2)} ${(C - len).toFixed(2)}" stroke-dashoffset="${(-off).toFixed(2)}"/>`; off += len; return a; }).join('');
  const legend = parts.map(p => `<div class="lg"><i style="background:${p.col}"></i><span>${esc(p.c?.icon || '')} ${esc(p.c?.name || 'محذوفة')}</span><b class="amt">${Math.round(p.v / total * 100)}%</b></div>`).join('');
  return `<div class="donut"><svg viewBox="0 0 140 140" width="140" height="140" aria-hidden="true"><g transform="rotate(-90 70 70)">${arcs}</g></svg><div class="legend">${legend}</div></div>`;
}
VIEWS.month = () => {
  const ym = ui.monthYm, prev = addMonths(ym, -1);
  const ms = L.monthStats(state, ym), pm = L.monthStats(state, prev);
  const r = L.rafahStatus(state, ym);
  const diff = ms.total - pm.total;
  const max = Math.max(1, ...Object.values(ms.byCat));
  const rows = Object.entries(ms.byCat).sort((a, b) => b[1] - a[1]);
  return `<div class="navdate"><button class="iconbtn" data-act="monShift" data-n="-1">→</button>${monthField('monPick', ym)}<button class="iconbtn" data-act="monShift" data-n="1">←</button></div>
  <div class="card hero"><div class="lbl">${monthLabel(ym)}</div><div class="big amt" id="monTotal">${jd(ms.total)}</div>
    <div class="minirow"><span>الشهر اللي قبله <b class="amt">${jd(pm.total)}</b></span><span class="${!pm.total ? '' : diff > 0 ? 'bad' : 'good'}">${pm.total ? `${diff > 0 ? '▲' : '▼'} <span class="amt">${jd(Math.abs(diff))}</span> (${Math.round(Math.abs(diff) / pm.total * 100)}%)` : 'ما في مقارنة'}</span></div></div>
  <div class="card"><div class="catbar"><div class="hd"><span>🎉 الرفاهية</span><span class="amt">${jdShort(r.used)}/${jdShort(r.budget)}</span></div>
    <div class="bar ${r.level}" id="rafahBar"><i style="width:${Math.min(100, r.pct * 100).toFixed(1)}%"></i></div>
    <div class="sub">${r.left >= 0 ? `ضايل ${jd(r.left)}` : `متعدّي بـ ${jd(-r.left)}`}</div></div></div>
  ${rows.length ? `<div class="card">${donut(rows)}</div>` : ''}
  <div class="card"><h2 style="margin-top:0">حسب التصنيف</h2>
    ${rows.length ? rows.map(([id, v]) => { const c = L.catById(state, id); const pv = pm.byCat[id] || 0; return `<div class="catbar"><div class="hd"><span>${esc(c?.icon || '')} ${esc(c?.name || 'محذوفة')}</span><span class="amt">${jd(v)}</span></div><div class="bar"><i style="width:${(v / max * 100).toFixed(1)}%"></i></div><div class="sub">قبل: <span class="amt">${jd(pv)}</span></div></div>`; }).join('') : '<div class="sub">ما في مصاريف.</div>'}
  </div>
  <button class="btn" data-act="copySummary">📋 انسخ الملخص</button>`;
};
AFTER.month = () => { $('#monPick').addEventListener('change', e => { if (e.target.value) { ui.monthYm = e.target.value; render(); } }); };

// ----- Money (accounts / income / obligations / projection / big purchase) -----
const MONEY_SEGS = { acc: 'حسابات', inc: 'دخل', rec: 'إلي', obl: 'التزامات', proj: 'توقّع', big: 'قبل الشرا' };
VIEWS.money = () => `<div class="seg moneyseg" style="margin-bottom:8px">${Object.entries(MONEY_SEGS).map(([k, v]) => `<button data-act="moneySeg" data-val="${k}" class="${ui.moneySeg === k ? 'on' : ''}">${v}</button>`).join('')}</div>${MONEY[ui.moneySeg]()}`;
const MONEY = {};
MONEY.acc = () => {
  const b = L.balances(state), cc = L.cardCycle(state), a = state.kv.accounts;
  const est = k => a[k].baseTs ? `آخر تصحيح ${dayLabel(ymd(new Date(a[k].baseTs)))}` : 'ما انحط رصيد لسا';
  const tr = [...state.transfers].sort((x, y) => y.ts - x.ts).slice(0, 15);
  return `<div class="card hero"><div class="lbl">السيولة الصافية</div><div class="big amt ${b.net < 0 ? 'neg' : ''}" id="liqNet">${jd(b.net)}</div><div class="sub">الدخل المتوقع والأصول مش محسوبين</div></div>
  <div class="card"><ul class="list">
    <li class="item"><div class="ic">🏦</div><div class="main"><div class="t">توفير</div><div class="s">${est('savings')}</div></div><div class="v amt" id="balSavings">${jd(b.savings)}</div><div class="acts"><button data-act="editBal" data-acc="savings">✏️</button></div></li>
    <li class="item"><div class="ic">💵</div><div class="main"><div class="t">كاش</div><div class="s">${est('cash')}</div></div><div class="v amt" id="balCash">${jd(b.cash)}</div><div class="acts"><button data-act="editBal" data-acc="cash">✏️</button></div></li>
    <li class="item"><div class="ic">💳</div><div class="main"><div class="t">البطاقة (المطلوب منك)</div><div class="s">الحد ${jd(b.cardLimit)} · المتاح ${jd(b.cardAvail)}</div></div><div class="v amt" id="balCard">${jd(b.card)}</div><div class="acts"><button data-act="editBal" data-acc="card">✏️</button></div></li>
  </ul>
  <div class="verdict">💳 مستحق يوم ${parseYmd(cc.dueDate).getDate()}: <b class="amt" id="cardDue">${jd(cc.dueAmount)}</b> (${fd(cc.dueDate)})<br><span class="sub">${cc.closed ? `كشف ${fd(cc.stmtDate)}` : `الكشف الجاي ${fd(cc.stmtDate)}، الرقم تقريبي`} · كشف يوم ${settings().stmtDay}، استحقاق يوم ${settings().dueDay}</span></div>
  <button class="btn" data-act="payCard" style="margin-top:10px">سدّد البطاقة من التوفير</button></div>
  <details class="card adv"><summary>🔁 تحويل بين الحسابات <span class="sub">(متقدم)</span></summary><div class="row"><label class="field"><span>من</span><select id="tFrom">${accOptions('savings')}</select></label><label class="field"><span>إلى</span><select id="tTo">${accOptions('card')}</select></label></div>
    <div class="row"><label class="field"><span>المبلغ</span><input id="tAmt" type="text" inputmode="decimal" class="amt" placeholder="0.000"></label><label class="field"><span>ملاحظة</span><input id="tNote" type="text"></label></div>
    <button class="btn pri" data-act="addTransfer">حوّل</button>
    <div class="sub" style="margin-top:6px">سداد البطاقة تحويل، مش مصروف. مصاريف البطاقة انحسبت وقت الشرا.</div>
    ${tr.length ? `<ul class="list" style="margin-top:8px">${tr.map(t => `<li class="item"><div class="ic">🔁</div><div class="main"><div class="t">${L.ACCOUNTS[t.from]} ← ${L.ACCOUNTS[t.to]}</div><div class="s">${fd(t.date)}${t.note ? ' · ' + esc(t.note) : ''}</div></div><div class="v amt">${jd(t.amount)}</div><div class="acts"><button data-act="delTransfer" data-id="${t.id}">🗑️</button></div></li>`).join('')}</ul>` : ''}
 
  </details>`;
};
MONEY.inc = () => {
  const exp = state.incomes.filter(i => i.status === 'expected').sort((a, b) => a.date.localeCompare(b.date));
  const rec = state.incomes.filter(i => i.status === 'received').sort((a, b) => b.receivedTs - a.receivedTs).slice(0, 10);
  const recurTxt = i => i.recur === 'monthly' ? 'شهري' : i.recur === 'yearly' ? 'سنوي' : i.recur === 'months' ? `أشهر: ${(i.months || []).join('، ')}` : 'مرة وحدة';
  return `<div class="banner blue">الدخل المتوقع ما بينحسب بالسيولة لحد ما توصل المصاري فعلاً.</div>
  <div class="card"><div class="totalrow" style="padding-top:0"><span>متوقع (أكيد)</span><span class="amt">${jd(L.sum(exp.filter(i => i.sure)))}</span></div><div class="kv"><span>متوقع (الكل)</span><span class="amt">${jd(L.sum(exp))}</span></div>
  ${exp.length ? `<ul class="list">${exp.map(i => `<li class="item"><div class="ic">${i.sure ? '🟢' : '🟡'}</div><div class="main"><div class="t">${esc(i.source)}</div><div class="s">${fd(i.date)} · ${recurTxt(i)} · ${i.sure ? 'أكيد' : 'مش أكيد'}</div></div><div class="v amt">${jd(i.amount)}</div>
    <div class="acts"><button data-act="recvInc" data-id="${i.id}" aria-label="وصل">✅</button><button data-act="editInc" data-id="${i.id}">✏️</button><button data-act="delInc" data-id="${i.id}">🗑️</button></div></li>`).join('')}</ul>` : '<div class="sub">ما في دخل متوقع.</div>'}
  <button class="btn" data-act="newInc" style="margin-top:10px">➕ دخل متوقع</button></div>
  ${rec.length ? `<h2>وصل مؤخراً</h2><div class="card"><ul class="list">${rec.map(i => `<li class="item"><div class="ic">💰</div><div class="main"><div class="t">${esc(i.source)}</div><div class="s">${fd(i.receivedDate)} ← ${L.ACCOUNTS[i.account] || ''}</div></div><div class="v amt">${jd(i.receivedAmount ?? i.amount)}</div><div class="acts"><button data-act="delInc" data-id="${i.id}">🗑️</button></div></li>`).join('')}</ul></div>` : ''}`;
};
// (v1.7) "إلي عند الناس": money other people owe him. Never in the balances; in the projection only when sure + a number + a date.
const recvWhen = r => r.due ? `${fd(r.due)}${r.expected ? ' · ' + esc(r.expected) : ''}` : r.expected ? esc(r.expected) : 'بدون موعد';
MONEY.rec = () => {
  const all = state.receivables;
  const open = all.filter(r => !r.done).sort((a, b) => (b.sure - a.sure) || (a.due || '9999').localeCompare(b.due || '9999') || a.ts - b.ts);
  const got = all.filter(r => r.done).sort((a, b) => (b.receivedTs || 0) - (a.receivedTs || 0)).slice(0, 10);
  const total = L.sum(open.filter(r => r.amount > 0)), sure = L.sum(open.filter(r => r.amount > 0 && r.sure));
  const noNum = open.filter(r => !(r.amount > 0)).length;
  return `<div class="card hero"><div class="lbl">إلي عند الناس</div><div class="big amt" id="recvTotal">${jd(total)}</div>
    <div class="minirow" style="justify-content:center;gap:14px"><span>أكيد <b class="amt">${jd(sure)}</b></span>${noNum ? `<span>+ ${noNum} بدون رقم</span>` : ''}</div>
    <div class="sub">مش محسوبين بالسيولة. بالتوقّع بس اللي "أكيد" وإله رقم وتاريخ.</div></div>
  <div class="card">${open.length ? `<ul class="list" id="recvList">${open.map(r => `<li class="item" style="flex-wrap:wrap"><div class="ic">${r.sure ? '🟢' : '🟡'}</div>
    <div class="main"><div class="t">${esc(r.who)}</div><div class="s">${recvWhen(r)} · ${r.sure ? 'أكيد' : 'مش أكيد'}</div>${r.note ? `<div class="s">${esc(r.note)}</div>` : ''}</div>
    <div class="v ${r.amount > 0 ? 'amt' : 'sub'}">${esc(L.recvLabel(r))}</div>
    <div class="acts" style="width:100%;justify-content:flex-end;margin-top:6px"><button class="btn sm" data-act="recvGot" data-id="${r.id}">✔️ وصلني</button><button data-act="editRecv" data-id="${r.id}" aria-label="تعديل">✏️</button><button data-act="delRecv" data-id="${r.id}" aria-label="حذف">🗑️</button></div></li>`).join('')}</ul>` : '<div class="sub">ما في حدا عليه إلك. 👌</div>'}
  <button class="btn" data-act="newRecv" style="margin-top:10px">➕ إلي عند حدا</button></div>
  ${got.length ? `<h2>وصلني</h2><div class="card"><ul class="list" id="recvGotList">${got.map(r => `<li class="item"><div class="ic">✔️</div><div class="main"><div class="t">${esc(r.who)}</div><div class="s">${fd(r.receivedDate)}${r.incomeId ? ` ← ${L.ACCOUNTS[r.account] || ''}` : ' · ما انضاف لحساب'}</div></div><div class="v amt">${r.receivedAmount > 0 ? jd(r.receivedAmount) : esc(L.recvLabel(r))}</div><div class="acts"><button data-act="recvUndo" data-id="${r.id}" aria-label="رجّعه">↩️</button><button data-act="delRecv" data-id="${r.id}" aria-label="حذف">🗑️</button></div></li>`).join('')}</ul></div>` : ''}`;
};
/** "100" / "12.5 jd" is a number; "100-150", "حسب الحكم", "تقريباً 50" stay text. */
function readRecvAmount(v) {
  const t = String(v || '').trim();
  if (!t) return { amount: null, amountText: '' };
  const n = /^[\d٠-٩]+(?:[.,٫][\d٠-٩]+)?\s*(jd|jod|دينار)?$/i.test(t) ? toFils(t) : NaN;
  return n > 0 ? { amount: n, amountText: '' } : { amount: null, amountText: t };
}
function recvSheet(r) {
  const x = r || { who: '', amount: null, amountText: '', due: '', expected: '', sure: false, note: '' };
  openSheet(`<h3>${r ? 'تعديل' : 'إلي عند حدا'}</h3>
    <label class="field"><span>مين؟</span><input id="rvWho" type="text" value="${esc(x.who)}"></label>
    <label class="field"><span>كم؟ (رقم، أو اكتب مثل 100-150 أو "حسب الحكم")</span><input id="rvAmt" type="text" dir="auto" value="${esc(x.amount > 0 ? jdShort(x.amount) : x.amountText || '')}" placeholder="0.000"></label>
    <div class="field"><span>متى متوقع؟ (تاريخ، اختياري)</span>${dateField('rvDue', x.due || '')}</div>
    <label class="field"><span>أو اكتب متى (اختياري)</span><input id="rvExp" type="text" value="${esc(x.expected || '')}" placeholder="مثلاً بعد الموسم"></label>
    <label class="field toggle"><span>أكيد؟ (بينحسب بالتوقّع)</span><input id="rvSure" type="checkbox" ${x.sure ? 'checked' : ''}></label>
    <label class="field"><span>ملاحظة</span><input id="rvNote" type="text" value="${esc(x.note || '')}"></label>
    <div class="btns"><button class="btn pri" id="rvSave">احفظ</button><button class="btn ghost" id="rvCancel">إلغاء</button></div>`, sh => {
    sh.querySelector('#rvCancel').onclick = closeSheet;
    sh.querySelector('#rvSave').onclick = async () => {
      const who = sh.querySelector('#rvWho').value.trim();
      if (!who) return toast('اكتب مين');
      const a = readRecvAmount(sh.querySelector('#rvAmt').value);
      await saveRec('receivables', { id: r?.id || uid(), ts: r?.ts || Date.now(), done: false, ...r, who, ...a, due: sh.querySelector('#rvDue').value || null, expected: sh.querySelector('#rvExp').value.trim(), sure: sh.querySelector('#rvSure').checked, note: sh.querySelector('#rvNote').value.trim() });
      closeSheet(); render(); toast('انحفظ ✓');
    };
  });
}
function recvGotSheet(r) {
  openSheet(`<h3>وصلك من ${esc(r.who)}؟</h3>
    <label class="field"><span>المبلغ اللي وصل</span><input id="rgAmt" type="text" inputmode="decimal" class="amount-in" value="${r.amount > 0 ? jd(r.amount) : ''}" placeholder="0.000"></label>
    <label class="field toggle"><span>ضيفه دخل على حساب</span><input id="rgInc" type="checkbox" checked></label>
    <div class="field" id="rgAccBox"><span>وين حطيته؟</span>${fromSeg('rgAcc', 'cash')}</div>
    <div class="sub" id="rgHint">رح ينسجل دخل واصل، والرصيد بيزيد.</div>
    <div class="btns"><button class="btn pri" id="rgSave">وصل ✓</button><button class="btn ghost" id="rgCancel">إلغاء</button></div>`, sh => {
    let acc = 'cash';
    sh.querySelectorAll('[data-name=rgAcc]').forEach(b => b.addEventListener('click', () => { acc = b.dataset.val; }));
    const inc = sh.querySelector('#rgInc');
    inc.onchange = () => { sh.querySelector('#rgAccBox').classList.toggle('hidden', !inc.checked); sh.querySelector('#rgHint').textContent = inc.checked ? 'رح ينسجل دخل واصل، والرصيد بيزيد.' : 'بس بتعلّمه وصل، وما بيتغيّر ولا رصيد.'; };
    sh.querySelector('#rgCancel').onclick = closeSheet;
    sh.querySelector('#rgSave').onclick = async () => {
      const raw = sh.querySelector('#rgAmt').value.trim(), a = raw ? toFils(raw) : NaN;
      if (inc.checked && !(a > 0)) return toast('اكتب المبلغ اللي وصل');
      if (raw && !(a > 0)) return toast('المبلغ غلط');
      const ts = Date.now(), upd = { ...r, done: true, receivedTs: ts, receivedDate: today(), receivedAmount: a > 0 ? a : null, account: null, incomeId: null };
      if (inc.checked) {
        const income = { id: uid(), ts, source: `من ${r.who}`, amount: a, date: today(), status: 'received', recur: 'none', months: [], sure: true, account: acc, receivedAmount: a, receivedTs: ts, receivedDate: today(), recv: r.id };
        await saveRec('incomes', income);
        upd.account = acc; upd.incomeId = income.id;
      }
      await saveRec('receivables', upd);
      closeSheet(); render(); toast(inc.checked ? `${iso('+' + jd(a))} على ${L.ACCOUNTS[acc]} ✓` : 'تعلّم وصل ✓');
    };
  });
}

const PRIO = { high: 'عالية', mid: 'متوسطة', low: 'عادية' };
MONEY.obl = () => {
  const open = state.obligations.filter(o => !o.done).sort((a, b) => ({ high: 0, mid: 1, low: 2 }[a.priority] - { high: 0, mid: 1, low: 2 }[b.priority]) || (a.due || '9999').localeCompare(b.due || '9999'));
  const done = state.obligations.filter(o => o.done).slice(-8).reverse();
  const totalRem = open.reduce((a, o) => a + L.remaining(o), 0);
  return `<div class="card hero"><div class="lbl">مجموع الباقي</div><div class="big amt" id="oblTotal">${jd(totalRem)}</div><div class="sub">الدفعات بتنقص الحساب اللي دفعت منه وما بتنحسب مصروف</div></div>
  <div class="card">${open.length ? `<ul class="list">${open.map(o => { const rem = L.remaining(o); const paid = o.amount - rem; const n = o.due ? daysBetween(today(), o.due) : null; return `<li class="item" style="flex-wrap:wrap"><div class="ic">${o.priority === 'high' ? '🔴' : o.priority === 'mid' ? '🟠' : '⚪'}</div>
    <div class="main"><div class="t">${esc(o.title)}${o.monthly ? ' <span class="pill">شهري</span>' : ''}</div><div class="s">${o.due ? `${fd(o.due)} · ${n < 0 ? `<span class="bad">متأخر ${-n} يوم</span>` : n === 0 ? '<span class="warn">اليوم</span>' : `بعد ${n} يوم`}` : 'بدون تاريخ'} · أولوية ${PRIO[o.priority] || ''}</div>
    <div class="bar ok" style="margin-top:6px"><i style="width:${(paid / Math.max(1, o.amount) * 100).toFixed(1)}%"></i></div><div class="s">مدفوع ${jd(paid)} من ${jd(o.amount)}</div></div>
    <div class="v amt">${jd(rem)}</div>
    <div class="acts" style="width:100%;justify-content:flex-end;margin-top:6px"><button class="btn sm" data-act="payObl" data-id="${o.id}">💸 دفعة</button><button data-act="editObl" data-id="${o.id}">✏️</button><button data-act="delObl" data-id="${o.id}">🗑️</button></div></li>`; }).join('')}</ul>` : '<div class="sub">ما في التزامات. 👌</div>'}
  <button class="btn" data-act="newObl" style="margin-top:10px">➕ التزام / دين</button></div>
  ${done.length ? `<h2>خلصت</h2><div class="card"><ul class="list">${done.map(o => `<li class="item"><div class="ic">✔️</div><div class="main"><div class="t">${esc(o.title)}</div><div class="s">${(o.payments || []).length} دفعات</div></div><div class="v amt">${jd(o.amount)}</div><div class="acts"><button data-act="delObl" data-id="${o.id}">🗑️</button></div></li>`).join('')}</ul></div>` : ''}`;
};
MONEY.proj = () => {
  const X = ui.projDate || ymd(new Date(Date.now() + 30 * 86400000));
  const p = L.projection(state, X);
  return `<div class="card"><div class="field"><span>لحد تاريخ</span>${dateField('projDate', X, `min="${today()}"`)}</div>
    <div class="grid2"><div class="card hero" style="margin:0"><div class="lbl">أسوأ حالة</div><div class="big amt ${p.worst < 0 ? 'neg' : ''}" id="projWorst" style="font-size:1.5rem">${jd(p.worst)}</div><div class="sub">بس الدخل الأكيد</div></div>
    <div class="card hero" style="margin:0"><div class="lbl">أحسن حالة</div><div class="big amt ${p.best < 0 ? 'neg' : ''}" id="projBest" style="font-size:1.5rem">${jd(p.best)}</div><div class="sub">كل الدخل المتوقع</div></div></div></div>
  <div class="card"><h2 style="margin-top:0">التفصيل (${p.days} يوم)</h2>
    <div class="kv"><span>السيولة هلأ</span><span class="amt">${jd(p.liquidity)}</span></div>
    <div class="kv"><span>+ دخل أكيد قبل التاريخ</span><span class="amt good">${jd(p.sureInc)}</span></div>
    <div class="kv"><span>+ دخل مش أكيد</span><span class="amt">${jd(p.allInc - p.sureInc)}</span></div>
    ${p.incomes.map(i => `<div class="kv sub"><span>· ${esc(i.source)} ${fd(i.date)}${i.sure ? '' : ' (مش أكيد)'}</span><span class="amt">${jd(i.amount)}</span></div>`).join('')}
    ${p.recvTotal ? `<div class="kv"><span>+ إلي عند الناس (أكيد) قبل التاريخ</span><span class="amt good" id="projRecv">${jd(p.recvTotal)}</span></div>
    ${p.recv.map(r => `<div class="kv sub"><span>· ${esc(r.who)} ${fd(r.date)}</span><span class="amt">${jd(r.amount)}</span></div>`).join('')}` : ''}
    <div class="kv"><span>− التزامات مستحقة قبل التاريخ</span><span class="amt bad">${jd(p.oblTotal)}</span></div>
    ${p.obligations.map(o => `<div class="kv sub"><span>· ${esc(o.title)} ${fd(o.date)}</span><span class="amt">${jd(o.amount)}</span></div>`).join('')}
    <div class="kv"><span>− مصروف متوقع (${jd(p.spendAvg)}/شهر × ${p.months.toFixed(2)})</span><span class="amt bad">${jd(p.spendTotal)}</span></div>
    <div class="sub">${esc(p.spendBasis)}</div>
    ${p.noDate.length ? `<div class="sub" style="margin-top:8px">مش محسوبة (بدون تاريخ): ${p.noDate.map(o => `${esc(o.title)} ${jd(o.amount)}`).join('، ')}</div>` : ''}
    ${p.recvNotCounted.length ? `<div class="sub" style="margin-top:8px">إلي عند الناس ومش محسوب: ${p.recvNotCounted.map(r => `${esc(r.who)} ${esc(r.label)} (${r.why})`).join('، ')}</div>` : ''}
  </div>`;
};
AFTER.money = () => {
  if (ui.moneySeg === 'proj') $('#projDate').addEventListener('change', e => { if (e.target.value) { ui.projDate = e.target.value; render(); } });
};
MONEY.big = () => `<div class="card"><label class="field"><span>كم سعر الشغلة؟</span><input id="bigAmt" type="text" inputmode="decimal" class="amount-in" placeholder="0.000" value="${esc(ui.bigAmt || '')}"></label>
  <div class="field"><span>رح تدفع من</span>${fromSeg('bigFrom', ui.bigFrom || 'cash')}</div>
  <button class="btn pri" data-act="bigCheck">افحص</button><div id="bigOut">${ui.bigOut || ''}</div></div>`;

function bigOutHtml(r) {
  return `<div class="verdict" id="bigVerdict" style="margin-top:12px;font-size:1.05rem">${r.verdict.icon} ${esc(r.verdict.text)}</div>
  <div class="kv"><span>السيولة هلأ</span><span class="amt">${jd(r.liquidity)}</span></div>
  ${r.res.map(x => `<div class="kv"><span>بعد ${x.n} يوم (التزامات ${jd(x.obl)} + مصروف عادي)</span><span class="amt ${x.after < 0 ? 'bad' : 'good'}">${jd(x.after)}</span></div>`).join('')}
  ${r.lines.map(l => `<div class="sub" style="margin-top:4px">• ${esc(l)}</div>`).join('')}
  <button class="btn" data-act="askBig" style="margin-top:10px">🤖 رأي كلاود</button>`;
}

// ----- Ask (chat) -----
VIEWS.ask = () => {
  const key = state.kv.apiKey;
  const cost = monthCost();
  const cap = settings().capUsd;
  return `${key ? '' : `<div class="banner blue" id="noKey">🔑 الدردشة بدها مفتاح Claude API خاص فيك. <br>1) ادخل console.anthropic.com ← API Keys واعمل مفتاح.<br>2) حطه بالإعدادات هون (بضل على تلفونك بس).<br>3) حط حد صرف شهري من Settings ← Limits.<br><button class="btn sm" data-act="go" data-v="settings" style="display:inline-flex;margin-top:8px">روح للإعدادات</button><br><span class="sub">باقي التطبيق شغّال كامل بدون مفتاح.</span></div>`}
  <div class="row" style="margin-bottom:8px"><div class="sub">هالشهر: <span class="amt" id="costMonth">${fmtUsd(cost)}</span> من <span class="amt">${fmtUsd(cap)}</span> · <span class="amt nw">${esc(C.currentModel(state))}</span></div><button class="btn sm ghost" data-act="clearChat" style="flex:none">🧹 امسح</button></div>
  <div class="chat" id="chat">${state.chat.length ? state.chat.map(msgHtml).join('') : '<div class="sub" style="text-align:center;padding:20px">اسأل عن أي مصروف، ابعت مصاريف اليوم، أو صورة فاتورة.</div>'}${ui.sending ? '<div class="msg assistant" id="typing">… بفكّر</div>' : ''}</div>
  <div class="composer">
    <div class="row" style="justify-content:flex-start;margin-bottom:6px"><button type="button" class="chip deep ${ui.deep ? 'on' : ''}" data-act="toggleDeep" aria-pressed="${!!ui.deep}" style="flex:none">🧠 تحليل أعمق</button><span class="sub">لهالسؤال بس، بـ <span class="amt nw">${esc(settings().deepModel)}</span></span></div>
    ${ui.pendingImg ? `<div class="row" style="justify-content:flex-start"><img class="preview-img" src="${ui.pendingImg.thumb}" alt=""><button class="btn sm ghost" data-act="dropImg" style="flex:none">✕</button></div>` : ''}
    <div class="row"><label class="iconbtn" aria-label="صورة" style="cursor:pointer">📷<input id="imgIn" type="file" accept="image/*" hidden></label>
    <textarea id="chatIn" rows="1" placeholder="اكتب…" dir="auto">${esc(ui.chatDraft || '')}</textarea>
    <button class="iconbtn" data-act="send" aria-label="إرسال" style="background:var(--acc);color:#1b1300" ${ui.sending ? 'disabled' : ''}>➤</button></div>
  </div>`;
};
AFTER.ask = () => {
  $('#chatIn').addEventListener('input', e => { ui.chatDraft = e.target.value; });
  $('#imgIn').addEventListener('change', async e => {
    const f = e.target.files?.[0]; if (!f) return;
    try { ui.pendingImg = await C.resizeImage(f); render(); } catch { toast('ما قدرت أقرأ الصورة'); }
  });
  const chat = $('#chat'); if (chat.lastElementChild) chat.lastElementChild.scrollIntoView({ block: 'end' });
};
function msgHtml(m) {
  if (m.role === 'error') return `<div class="msg assistant" style="border-color:var(--bad)">⚠️ ${esc(m.text)}</div>`;
  const logs = (m.logs || []).map((l, i) => `<button class="btn sm logbtn" data-act="logFromChat" data-id="${m.id}" data-i="${i}" ${l.done ? 'disabled' : ''}>${l.done ? '✓ انسجل' : `سجّل ${esc(l.amount)} · ${esc(l.cat)}${l.note ? ' · ' + esc(l.note) : ''}`}</button>`).join('');
  return `<div class="msg ${m.role}">${m.thumb ? `<img src="${m.thumb}" alt="">` : ''}${esc(m.text)}${logs ? `<div>${logs}</div>` : ''}${m.role === 'user' && m.deep ? '<div class="meta">🧠 تحليل أعمق</div>' : ''}${m.cost != null ? `<div class="meta">${m.deep ? '🧠 ' : ''}<span class="amt nw">${esc(m.model || '')} · ${fmtUsd(m.cost)}</span></div>` : ''}</div>`;
}
function monthCost() { const c = state.kv.cost; return c && c.month === thisMonth() ? c.usd : 0; }

function noKeySheet() {
  openSheet(`<h3>🔑 بدك مفتاح Claude</h3><p>عشان "رأي كلاود" والدردشة، حط مفتاح API تبعك بالإعدادات. المفتاح بضل على التلفون بس.</p><ol><li>console.anthropic.com ← API Keys ← Create Key</li><li>Settings ← Limits: حط حد صرف شهري</li><li>الصقه هون بالإعدادات</li></ol><div class="btns"><button class="btn pri" id="goSet">الإعدادات</button><button class="btn ghost" id="cl">بعدين</button></div>`, sh => {
    sh.querySelector('#goSet').onclick = () => { closeSheet(); go('settings'); };
    sh.querySelector('#cl').onclick = closeSheet;
  });
}

async function sendChat(text) {
  text = (text ?? '').trim();
  if (!text && !ui.pendingImg) return;
  const key = state.kv.apiKey;
  if (!key) { noKeySheet(); return; }
  if (monthCost() >= settings().capUsd) { toast(`وصلت الحد الشهري ${fmtUsd(settings().capUsd)}. غيّره بالإعدادات.`); return; }
  if (ui.sending) return;
  const img = ui.pendingImg;
  const deep = !!ui.deep;
  const userMsg = { id: uid(), ts: Date.now(), role: 'user', text: text || '(صورة)', thumb: img?.thumb || null, deep };
  await saveRec('chat', userMsg);
  ui.pendingImg = null; ui.chatDraft = ''; ui.sending = true; ui.deep = false; // deep = this one message only
  if (ui.view !== 'ask') ui.view = 'ask';
  render();
  // last ~10 turns, plain text; context + image only on the newest message
  const hist = state.chat.filter(m => m.role === 'user' || m.role === 'assistant').slice(-20);
  while (hist.length && hist[0].role !== 'user') hist.shift();
  const messages = hist.map((m, i) => {
    if (i < hist.length - 1) return { role: m.role, content: m.text + (m.thumb && m.role === 'user' ? ' [صورة]' : '') };
    const content = [];
    if (img) content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: img.b64 } });
    content.push({ type: 'text', text: `${C.buildContext(state)}\n\n${text || 'شوف هالصورة.'}` });
    return { role: 'user', content };
  });
  const model = deep ? (settings().deepModel || 'claude-opus-5-5') : C.currentModel(state);
  try {
    const r = await C.callClaude(key, model, C.SYSTEM_PROMPT, messages, deep);
    const cost = C.costOf(state, model, r.usage);
    const { clean, logs } = C.extractLogs(r.text);
    await saveRec('chat', { id: uid(), ts: Date.now(), role: 'assistant', text: clean || '…', logs, cost, model: r.model || model, deep, usage: r.usage });
    const cm = thisMonth();
    await setKV('cost', { month: cm, usd: (state.kv.cost?.month === cm ? state.kv.cost.usd : 0) + cost });
  } catch (err) {
    await saveRec('chat', { id: uid(), ts: Date.now(), role: 'error', text: navigator.onLine ? String(err.message || err) : 'ما في إنترنت. الدردشة بدها نت، باقي التطبيق شغّال.' });
  } finally {
    ui.sending = false;
    if (ui.view === 'ask') render();
  }
}

function findCatByName(name) {
  const n = String(name || '').trim().toLowerCase();
  const cats = state.kv.categories;
  return cats.find(c => c.name.toLowerCase() === n) || cats.find(c => n && (c.name.toLowerCase().includes(n) || n.includes(c.name.toLowerCase()))) || cats.find(c => c.id === L.guessCategory(n, cats).cat);
}


// ----- Bank SMS import -----
const KIND_LABEL = { deposit: 'إيداع بالتوفير', bill: 'دفع فاتورة', cliq: 'تحويل كليك', atm: 'سحب نقدي', card_debit: 'مشتريات بالبطاقة', card_credit: 'دفعة/مرتجع على البطاقة', unknown: 'رسالة مش معروفة' };
const ACTIONS = {
  deposit: [['income', 'دخل (من مصدر)'], ['transfer', 'كاش حطيته بالتوفير (تحويل)']],
  cliq: [['expense', 'مصروف'], ['debt', 'سداد دين/التزام'], ['out', 'تحويل لحدا (مش مصروف)']],
  card_credit: [['transfer', 'سداد من التوفير (تحويل)'], ['balance', 'بس حدّث رصيد البطاقة']],
  unknown: [['skip', 'تجاهل'], ['expense', 'سجّل مصروف']],
};
function smsSeen() { return state.kv.smsSeen || {}; }

/** Pair new items with entries saved by earlier imports (bill now, card SMS before - or the other way). */
function crossMerge(items) {
  for (const it of items) {
    if (it.kind === 'card_debit' && it.viaHousing && !it.mergedInto) {
      const e = state.entries.find(x => x.smsKind === 'bill' && !x.smsCard && x.from === 'card' && x.amount === it.amount);
      if (e) { it.mergedInto = 'entry:' + e.id; it.mergedEntry = e.id; }
    }
    if (it.kind === 'bill' && !it.cardMatched) {
      const e = state.entries.find(x => x.smsKind === 'card_debit' && x.smsHousing && !x.smsBill && x.amount === it.amount);
      if (e) { it.cardMatched = true; it.updateEntry = e.id; it.account = 'card'; }
    }
  }
  return items;
}

function defaultAction(it) {
  if (it.kind === 'deposit') return it.viaAtm ? 'transfer' : 'income';
  if (it.kind === 'cliq') return 'expense';
  if (it.kind === 'card_credit') return 'transfer';
  if (it.kind === 'unknown') return it.amount > 0 ? 'expense' : 'skip';
  return 'expense';
}

function prepItem(it) {
  it.action = it.action || defaultAction(it);
  it.include = it.include ?? (!it.mergedInto && !(it.kind === 'unknown' && !it.amount));
  it.date = it.date || today();
  if (it.note == null) it.note = it.kind === 'bill' ? it.biller : it.kind === 'card_debit' || it.kind === 'card_credit' ? it.merchant : it.kind === 'deposit' ? it.source : it.kind === 'cliq' ? 'كليك' : it.kind === 'atm' ? 'سحب نقدي' : '';
  if (!it.cat) it.cat = 'other';
  return it;
}
function smsParse(text) {
  const r = SMS.parseBatch(text, state.kv.categories, smsSeen());
  crossMerge(r.items);
  r.items.forEach(prepItem);
  ui.sms = r;
}

function smsItemHtml(it, i) {
  const merged = it.mergedInto;
  const showCat = ['bill', 'card_debit'].includes(it.kind) || (it.kind === 'cliq' && it.action === 'expense') || (it.kind === 'unknown' && it.action === 'expense');
  const showAcc = ['bill', 'card_debit'].includes(it.kind) || (it.kind === 'unknown' && it.action === 'expense');
  const openObl = state.obligations.filter(o => !o.done);
  return `<div class="card smsitem ${merged ? 'merged' : ''}" data-i="${i}">
    <div class="row" style="justify-content:space-between"><b>${KIND_LABEL[it.kind]}${it.flag ? ` <span class="pill warn">${esc(it.flag)}</span>` : ''}</b>${merged ? '' : `<label class="toggle" style="flex:none;min-height:36px;gap:6px"><span class="sub">سجّل</span><input type="checkbox" class="sInc" ${it.include ? 'checked' : ''}></label>`}</div>
    <div class="sub smsraw" dir="auto">${esc(it.raw)}</div>
    ${merged ? `<div class="banner blue">🔗 هاي رسالة البطاقة تبعت فاتورة، اندمجت معها كمصروف واحد (ما رح تنخصم مرتين).</div>` : `
    ${it.kind === 'bill' ? `<div class="sub">${esc(it.biller)}: ${jd(it.billAmount)} + عمولة ${jd(it.fee)} = <b class="amt">${jd(it.amount)}</b>${it.cardMatched ? ' · <span class="pill good">انطابقت مع رسالة البطاقة</span>' : ' · <span class="pill warn">ما لقيت رسالة البطاقة، اختار الحساب</span>'}</div>` : ''}
    ${ACTIONS[it.kind] ? `<label class="field"><span>شو هاي؟</span><select class="sAction">${ACTIONS[it.kind].map(([v, l]) => `<option value="${v}" ${v === it.action ? 'selected' : ''}>${l}</option>`).join('')}</select></label>` : ''}
    <div class="row"><label class="field"><span>المبلغ</span><input type="text" inputmode="decimal" class="sAmt amt" value="${jd(it.amount)}"></label>
    <div class="field"><span>التاريخ</span>${dateField('sDate' + i, it.date)}</div></div>
    ${showCat ? `<div class="row"><label class="field"><span>التصنيف</span><select class="sCat">${catOptions(it.cat)}</select></label>${showAcc ? `<label class="field"><span>من</span><select class="sAcc">${accOptions(it.account, ['card', 'savings', 'cash', 'none'])}</select></label>` : ''}</div>` : ''}
    ${it.kind === 'cliq' && it.action === 'debt' ? `<label class="field"><span>على أي التزام؟</span><select class="sObl">${openObl.length ? openObl.map(o => `<option value="${o.id}">${esc(o.title)} (${jd(L.remaining(o))})</option>`).join('') : '<option value="">ما في التزامات، ضيف واحد أول</option>'}</select></label>` : ''}
    ${it.kind === 'atm' ? '<div class="sub">تحويل من التوفير للكاش.</div>' : ''}
    <label class="field"><span>${it.kind === 'deposit' ? 'المصدر' : 'ملاحظة'}</span><input type="text" class="sNote" value="${esc(it.note || '')}"></label>`}
  </div>`;
}

function smsBalancesPreview(r) {
  const items = r.items;
  const sv = items.filter(i => i.balance != null).sort((a, b) => (a.at || 0) - (b.at || 0)).pop();
  const cd = [...items].reverse().find(i => i.available != null);
  const lim = state.kv.accounts.card.limit || 0;
  let html = '';
  if (sv) html += `<div class="kv"><span>رصيد التوفير من آخر رسالة</span><span class="amt" id="smsSavBal">${jd(sv.balance)}</span></div>`;
  if (cd) {
    html += lim ? `<div class="kv"><span>المطلوب على البطاقة (الحد − المتاح ${jd(cd.available)})</span><span class="amt" id="smsCardOut">${jd(lim - cd.available)}</span></div>`
      : `<label class="field"><span>حد البطاقة (مرة وحدة، عشان أحسب المطلوب من "Available balance")</span><input id="smsLimit" type="text" inputmode="decimal" class="amt" placeholder="0.000"></label>`;
  }
  return html ? `<div class="card"><h2 style="margin-top:0">الأرصدة</h2>${html}<label class="toggle"><span>حدّث الأرصدة من الرسائل</span><input type="checkbox" id="smsBal" checked></label><div class="sub">الرصيد الحقيقي من البنك بيحل محل التقدير.</div></div>` : '';
}

VIEWS.sms = () => {
  const r = ui.sms;
  const top = inboxOn() ? `<div class="card"><div class="row"><div class="sub" id="lastPull">📥 آخر سحب: ${agoText(inboxCfg().lastPull)}${inboxCfg().lastError ? ` · <span class="bad">${esc(inboxCfg().lastError)}</span>` : ''}</div><button class="btn sm" data-act="pullNow" style="flex:none">اسحب هلأ</button></div>${(state.kv.inboxPending || []).length ? `<div class="sub">⏳ ${(state.kv.inboxPending || []).length} بستنّى رسالتها التانية (فاتورة/بطاقة)</div>` : ''}</div>`
    : `<div class="banner blue">📥 بدك الرسائل تنسجل لحالها؟ حط توكن "صندوق الرسائل التلقائي" بالإعدادات. <button class="btn sm" data-act="go" data-v="settings" style="display:inline-flex;margin-top:6px">الإعدادات</button></div>`;
  const tools = `<details class="card" id="smsHelp" ${ui.smsHelp ? 'open' : ''}><summary>❓ كيف أوصّل الرسائل؟</summary>
    <p><b>تلقائي (الأحسن):</b> أتمتة بالاختصارات بتبعت كل رسالة للصندوق الخاص فيك على GitHub، والتطبيق بسحبها لما تفتحه. الخطوات بالتفصيل بالـ README.</p>
    <p><b>بملف:</b></p>
    <ol class="steps">
      <li>الاختصارات (Shortcuts) ← الأتمتة (Automation) ← <b>+</b> ← الرسالة (Message).</li>
      <li>المرسل (Sender): <span class="amt">HousingBank</span> (وأتمتة تانية لـ <span class="amt">Iskan CrCrd</span>) ← تشغيل فوري (Run Immediately).</li>
      <li>إجراء <b>إلحاق بملف نصي (Append to Text File)</b>: الرسالة + سطر جديد + <span class="amt">----</span></li>
      <li>الملف: <span class="amt">iCloud Drive/Shortcuts/masroofi_sms.txt</span></li>
      <li>بعدين: رسائل البنك ← <b>استورد ملف الرسائل</b>.</li>
    </ol>
    <div class="sub">الرسائل اللي انستوردت ما بتنعاد. مصاريف الكاش سجّلها بإيدك من "سجّل" واختار كاش، البنك ما بيعرف عنها.</div>
  </details>
  <div class="card">
    <textarea id="smsText" dir="auto" placeholder="الصق رسالة أو أكثر من البنك هون">${esc(ui.smsText || '')}</textarea>
    <div class="btns"><button class="btn pri" data-act="smsParse">حلّل</button><label class="btn" style="cursor:pointer">📂 استورد ملف الرسائل<input id="smsFile" type="file" accept=".txt,text/plain" hidden></label></div>
  </div>`;
  const results = r ? `${r.review ? `<h2 id="reviewHead">🔎 بدها مراجعة (${r.items.length})</h2>` : ''}${r.dups ? `<div class="banner blue" id="smsDups">↩️ ${r.dups} ${r.dups === 1 ? 'رسالة' : 'رسائل'} انستوردت قبل، تجاهلتها.</div>` : ''}
    ${r.items.length ? `${r.review ? '' : smsBalancesPreview(r)}<div id="smsList">${r.items.map(smsItemHtml).join('')}</div><button class="btn pri" data-act="smsApply" id="smsApplyBtn">سجّل المختار</button>` : '<div class="banner yellow">ما في رسائل جديدة.</div>'}` : '';
  const done = ui.smsDone ? `<div class="banner blue" id="smsDone">${ui.smsDone}</div>` : '';
  return r?.review ? top + done + results + tools : top + tools + results + done;
};
AFTER.sms = () => {
  $('#smsText').addEventListener('input', e => { ui.smsText = e.target.value; });
  $('#smsHelp').addEventListener('toggle', e => { ui.smsHelp = e.target.open; });
  $('#smsFile').addEventListener('change', async e => {
    const f = e.target.files?.[0]; e.target.value = ''; if (!f) return;
    ui.smsDone = ''; smsParse(await f.text()); ui.smsFromFile = true; render();
  });
  $$('#smsList .sAction').forEach(sel => sel.addEventListener('change', () => { readSmsEdits(); render(); }));
};

function readSmsEdits() {
  const r = ui.sms; if (!r) return;
  $$('#smsList .smsitem').forEach(card => {
    const it = r.items[+card.dataset.i]; if (it.mergedInto) return;
    const q = c => card.querySelector(c);
    if (q('.sInc')) it.include = q('.sInc').checked;
    if (q('.sAction')) it.action = q('.sAction').value;
    if (q('.sAmt')) it.amount = toFils(q('.sAmt').value);
    if (q('#sDate' + card.dataset.i)) it.date = q('#sDate' + card.dataset.i).value || it.date;
    if (q('.sCat')) it.cat = q('.sCat').value;
    if (q('.sAcc')) it.account = q('.sAcc').value;
    if (q('.sObl')) it.obl = q('.sObl').value;
    if (q('.sNote')) it.note = q('.sNote').value.trim();
  });
}

/** Save one reviewed/auto item. Records get the pull time as ts so a balance taken from the same SMS never counts them twice. */
async function saveSmsItem(it) {
  const ts = it.pulledAt || Date.now();
  if (it.mergedInto) {
    if (it.mergedEntry) { const e = state.entries.find(x => x.id === it.mergedEntry); if (e) await saveRec('entries', { ...e, smsCard: it.hash }); }
    return false;
  }
  if (!it.include || it.action === 'skip') return false;
  const marks = { sms: it.hash, smsKind: it.kind, ts };
  if (it.kind === 'bill') {
    marks.smsCard = it.cardHash || null;
    if (it.updateEntry) { const e = state.entries.find(x => x.id === it.updateEntry); if (e) { await saveRec('entries', { ...e, cat: it.cat, sub: it.sub, note: it.note, smsBill: it.hash }); return true; } }
    await addEntry({ amount: it.amount, cat: it.cat, sub: it.sub, note: it.note, from: it.account, date: it.date, extra: marks }); return true;
  }
  if (it.kind === 'card_debit' || (it.kind === 'unknown' && it.action === 'expense') || (it.kind === 'cliq' && it.action === 'expense')) {
    if (it.kind === 'card_debit' && it.viaHousing) marks.smsHousing = true;
    await addEntry({ amount: it.amount, cat: it.cat, sub: it.sub || '', note: it.note, from: it.kind === 'cliq' ? 'savings' : it.account, date: it.date, extra: marks }); return true;
  }
  if (it.kind === 'cliq' && it.action === 'debt') {
    const o = state.obligations.find(x => x.id === it.obl);
    if (o) { const { upd, next } = L.payObligation(o, 'savings', it.amount, ts); await saveRec('obligations', upd); if (next) await saveRec('obligations', next); return true; }
    return false;
  }
  if (it.kind === 'deposit' && it.action === 'income') {
    await saveRec('incomes', { id: uid(), ts, source: it.note || 'إيداع', amount: it.amount, date: it.date, status: 'received', recur: 'none', months: [], sure: true, account: 'savings', receivedAmount: it.amount, receivedTs: ts, receivedDate: it.date, sms: it.hash }); return true;
  }
  const tr = (from, to, note) => saveRec('transfers', { id: uid(), ts, date: it.date, from, to, amount: it.amount, note, sms: it.hash });
  if (it.kind === 'deposit' && it.action === 'transfer') { await tr('cash', 'savings', 'إيداع كاش'); return true; }
  if (it.kind === 'atm') { await tr('savings', 'cash', 'سحب نقدي'); return true; }
  if (it.kind === 'card_credit' && it.action === 'transfer') { await tr('savings', 'card', 'سداد البطاقة'); return true; }
  return it.kind === 'cliq' && it.action === 'out';
}

/** The bank's real numbers replace the estimates. Returns messages. */
async function applyBalances(items) {
  const msgs = [];
  const accs = structuredClone(state.kv.accounts);
  const at = Date.now() + 1;
  const sv = items.filter(i => i.balance != null).sort((a, b) => (a.at || 0) - (b.at || 0)).pop();
  if (sv && !(accs.savings.smsAt && sv.at && sv.at < accs.savings.smsAt)) { accs.savings.base = sv.balance; accs.savings.baseTs = at; accs.savings.smsAt = sv.at || null; msgs.push(`التوفير صار ${jd(sv.balance)}`); }
  const cd = [...items].reverse().find(i => i.available != null);
  if (cd && accs.card.limit) { accs.card.base = Math.max(0, accs.card.limit - cd.available); accs.card.baseTs = at; msgs.push(`المطلوب على البطاقة ${jd(accs.card.base)}`); }
  else if (cd) msgs.push('حط حد البطاقة عشان أحدّث المطلوب عليها');
  await setKV('accounts', accs);
  return msgs;
}

async function smsApply() {
  readSmsEdits();
  const r = ui.sms; if (!r) return;
  const bad = r.items.find(it => it.include && !it.mergedInto && it.action !== 'skip' && !(it.amount > 0));
  if (bad) return toast('في مبلغ غلط');
  const limIn = $('#smsLimit');
  if (limIn && limIn.value.trim()) { const lim = toFils(limIn.value); if (lim > 0) await setKV('accounts', { ...state.kv.accounts, card: { ...state.kv.accounts.card, limit: lim } }); }
  let n = 0;
  for (const it of r.items) if (await saveSmsItem(it)) n++;
  // review items already updated the balances when they were pulled
  const msgs = !r.review && $('#smsBal')?.checked !== false ? await applyBalances(r.items) : [];
  const seen = { ...smsSeen() };
  for (const it of r.items) { seen[it.hash] = Date.now(); if (it.refKey) seen[it.refKey] = Date.now(); }
  await setKV('smsSeen', seen);
  if (r.review) { const done = new Set(r.items.map(i => i.hash)); await setKV('inboxReview', (state.kv.inboxReview || []).filter(i => !done.has(i.hash))); }
  ui.smsDone = `✓ انسجل ${n}. ${msgs.join('، ')}${ui.smsFromFile ? '<br>الرسائل اللي بالملف صارت محفوظة عندي، إذا استوردت نفس الملف مرة تانية ما رح تنعاد. فيك تفضّي الملف من تطبيق الملفات إذا بدك.' : ''}`;
  ui.sms = null; ui.smsText = ''; ui.smsFromFile = false;
  render(); toast(`انسجل ${n} ✓`);
}

// ----- Auto inbox (GitHub repo filled by the iOS Shortcut) -----
const PENDING_MS = 30 * 60000;
let pulling = false, lastAutoPull = 0;
const inboxCfg = () => state.kv.inbox || {};
const inboxOn = () => !!(inboxCfg().token && inboxCfg().repo);
const reviewCount = () => (state.kv.inboxReview || []).length;
function agoText(ts) {
  if (!ts) return 'ولا مرة';
  const m = Math.floor((Date.now() - ts) / 60000);
  if (m < 1) return 'هلأ'; if (m < 60) return `قبل ${m} دقيقة`;
  const h = Math.floor(m / 60); if (h < 24) return `قبل ${h} ساعة`;
  return `قبل ${Math.floor(h / 24)} يوم`;
}
/** Sure enough to save without asking: card buys with a real category guess, ATM withdrawals. */
const autoSafe = it => (it.kind === 'card_debit' && !it.viaHousing && it.cat && it.cat !== 'other') || it.kind === 'atm';

async function pullInbox({ silent = false } = {}) {
  if (!inboxOn() || pulling) return null;
  if (!navigator.onLine) { if (!silent) toast('ما في نت'); return null; }
  pulling = true;
  const { token, repo } = inboxCfg();
  const pullTs = Date.now();
  const res = { saved: 0, review: 0, files: 0, deleted: 0 };
  try {
    // 1) read everything first (no side effects yet)
    const files = await IN.listInbox(token, repo);
    const got = [];
    for (const f of files) got.push({ path: f.path, ...(await IN.readFile(token, repo, f.path)) });
    res.files = got.length;
    // 2) parse + dedupe by content hash (a file whose delete failed last time is skipped here)
    const seen = { ...smsSeen() };
    const fresh = [];
    for (const g of got) for (const raw of SMS.splitMessages(g.text)) {
      const it = SMS.parseSms(raw, state.kv.categories);
      const refKey = it.ref ? `ref:${it.ref}:${it.amount}` : null;
      if (seen[it.hash] || (refKey && seen[refKey])) continue;
      seen[it.hash] = pullTs; if (refKey) seen[refKey] = pullTs;
      Object.assign(it, { refKey, pulledAt: pullTs, date: it.date || today() });
      fresh.push(it);
    }
    // 3) pair bills with "Housing Bank" card SMS across pulls (pending buffer), then save or queue
    const pool = [...(state.kv.inboxPending || []).map(i => ({ ...i, mergedInto: null, cardMatched: false })), ...fresh];
    SMS.mergeBillCard(pool); crossMerge(pool);
    const review = [...(state.kv.inboxReview || [])], pending = [];
    for (const it of pool) {
      prepItem(it);
      if (it.mergedInto) { await saveSmsItem(it); continue; }
      if (it.kind === 'bill' && it.cardMatched) {
        const card = pool.find(c => c.mergedInto === it.hash);
        if (card) it.pulledAt = Math.min(it.pulledAt, card.pulledAt);
        if (await saveSmsItem(it)) res.saved++;
        continue;
      }
      if (it.kind === 'bill' || (it.kind === 'card_debit' && it.viaHousing)) {
        if (pullTs - it.pulledAt < PENDING_MS) { pending.push(it); continue; }
        it.flag = it.kind === 'bill' ? 'ما وصلت رسالة البطاقة' : 'ما وصلت رسالة الفاتورة';
        review.push(it); res.review++; continue;
      }
      if (autoSafe(it)) { if (await saveSmsItem(it)) res.saved++; continue; }
      if (it.kind === 'card_debit' || it.kind === 'unknown') { it.cat = 'other'; it.flag = it.kind === 'unknown' ? 'رسالة مش معروفة' : 'تاجر مش معروف'; }
      review.push(it); res.review++;
    }
    await setKV('smsSeen', seen);
    await setKV('inboxPending', pending);
    await setKV('inboxReview', review);
    if (fresh.length) await applyBalances(fresh);
    // 4) only now delete the files (a failed delete is harmless: the hashes are remembered)
    for (const g of got) { try { if (await IN.deleteFile(token, repo, g.path, g.sha)) res.deleted++; } catch {} }
    await setKV('inbox', { ...inboxCfg(), lastPull: Date.now(), lastError: '' });
    if (res.saved || res.review) toast(`انسجلت ${res.saved} ${res.saved === 1 ? 'مصروف' : 'مصاريف'} تلقائياً${res.review ? ` · ${res.review} بدها مراجعة` : ''}`);
    else if (!silent) toast('ما في رسائل جديدة');
  } catch (err) {
    await setKV('inbox', { ...inboxCfg(), lastError: String(err.message || err) });
    if (!silent) toast(`ما زبط السحب: ${err.message || err}`);
    res.error = String(err.message || err);
  } finally {
    pulling = false;
    if (['add', 'sms', 'settings', 'day', 'month', 'money'].includes(ui.view) && !$('#sheet').innerHTML) {
      if (ui.view === 'sms') { if (ui.sms && !ui.sms.review) readSmsEdits(); if (!ui.sms) openReview(); }
      render();
    }
  }
  return res;
}
function openReview() {
  const q = state.kv.inboxReview || [];
  if (q.length && !ui.sms) ui.sms = { items: q.map(i => prepItem({ ...i })), dups: 0, review: true };
}
function autoPull() {
  if (MANUAL_ONLY || !inboxOn() || document.visibilityState !== 'visible' || Date.now() - lastAutoPull < 30000) return;
  lastAutoPull = Date.now();
  pullInbox({ silent: true });
}
document.addEventListener('visibilitychange', autoPull);
window.addEventListener('focus', autoPull);

// ----- Goals (v1.8) -----
VIEWS.goals = () => {
  const gs = L.goalsOf(state);
  const c = L.saveCapacity(state);
  return `<div class="card capcard"><div class="lbl">قدرتك على التوفير تقريباً</div>
    <div class="big amt ${c.cap < 0 ? 'bad' : ''}" id="capBig">${jd(c.cap)}<small> بالشهر</small></div>
    <div class="explain">
      <div class="kv"><span>دخلك بالشهر <span class="sub">(${esc(c.incomeBasis)})</span></span><span class="amt good">${jd(c.income)}</span></div>
      <div class="kv"><span>− مصروفك بالشهر <span class="sub">(${esc(c.spendBasis)})</span></span><span class="amt bad">${jd(c.spend)}</span></div>
      <div class="kv"><span>− التزامات شهرية</span><span class="amt bad">${jd(c.commit)}</span></div>
    </div></div>
  ${gs.length ? gs.map(g => goalCardHtml(g, c.cap)).join('') : `<div class="card empty"><div style="font-size:2.2rem">🎯</div><p>حط هدف (سيارة، طوارئ، سفرة...) وأنا بحسبلك كم لازم توفر بالشهر وبالأسبوع، وبحجزلك حصته من "الضايل الآمن".</p></div>`}
  <button class="btn pri" data-act="newGoal">➕ هدف جديد</button>
  <div class="sub" style="margin-top:10px">الهدف فلوس محجوزة جوّا حساباتك: ما بيحرك أي رصيد، بس بيطلّعها من "الضايل الآمن" عشان ما تنصرف.</div>`;
};
function goalCardHtml(g, cap) {
  const p = L.goalPlan(state, g, today(), cap);
  const when = g.deadline ? (p.late ? `<span class="bad">فات الموعد (${fd(g.deadline)})</span>` : `لحد ${fd(g.deadline)} · ${p.monthsLeft === 1 ? 'هالشهر' : `${p.monthsLeft} شهور`}`) : g.monthly > 0 ? `خطتك ${jdShort(g.monthly)} بالشهر` : 'بدون موعد';
  const fit = !p.done && p.perMonth > 0 && cap != null ? (p.perMonth <= cap ? '<span class="pill good">ضمن قدرتك</span>' : '<span class="pill warn">أكثر من قدرتك</span>') : '';
  return `<div class="card goal" data-id="${g.id}">
    <div class="gtop"><span class="gname big">${esc(g.icon || '🎯')} ${esc(g.name)}</span><span class="gpct amt">${Math.round(p.pct * 100)}%</span></div>
    ${goalBar(p)}
    <div class="gsub"><span><b class="amt">${jd(p.saved)}</b> من <span class="amt">${jd(g.target)}</span></span><span>${p.done ? '🎉 وصلت!' : `ضايل <span class="amt">${jd(p.left)}</span>`}</span></div>
    <div class="sub" style="margin-top:4px">${when}</div>
    ${p.done ? '' : p.perMonth ? `<div class="plan"><div><span>بالشهر</span><b class="amt">${jd(p.perMonth)}</b></div><div><span>بالأسبوع</span><b class="amt">${jd(p.perWeek)}</b></div><div><span>هالشهر حطيت</span><b class="amt">${jd(Math.max(0, p.thisMonth))}</b></div></div>
      <div class="sub">${p.reserve ? `ضايل تحط <b class="amt">${jd(p.reserve)}</b> هالشهر (محجوزة من الضايل الآمن)` : '✅ حطيت حصة هالشهر'} ${fit}</div>`
      : `<div class="sub">${p.eta ? `بقدرتك الحالية (${jdShort(p.rate)} بالشهر) بتوصل تقريباً ${monthLabel(p.eta)}.` : 'حط موعد أو مبلغ شهري عشان أحسبلك الخطة.'}</div>`}
    <div class="btns"><button class="btn sm pri" data-act="goalAdd" data-id="${g.id}">➕ حطيت</button><button class="btn sm" data-act="goalTake" data-id="${g.id}">➖ سحبت</button><button class="btn sm ico" data-act="goalEdit" data-id="${g.id}" aria-label="تعديل">✏️</button><button class="btn sm danger ico" data-act="goalDel" data-id="${g.id}" aria-label="حذف">🗑️</button></div>
  </div>`;
}
async function saveGoals(list) { await setKV('goals', list); }
function goalSheet(g) {
  const x = g || { name: '', icon: '🎯', target: 0, deadline: '', monthly: 0, start: 0 };
  const icons = ['🎯', '🛡️', '🚗', '🏠', '✈️', '💻', '📱', '💍', '🕋', '🎓', '🌱', '🐈'];
  openSheet(`<h3>${g ? 'تعديل الهدف' : '🎯 هدف جديد'}</h3>
    <div class="chips" id="gIcons">${icons.map(i => `<button type="button" class="chip ${i === (x.icon || '🎯') ? 'on' : ''}" data-ic="${i}">${i}</button>`).join('')}</div>
    <label class="field"><span>شو الهدف؟</span><input id="gName" type="text" value="${esc(x.name)}" placeholder="مثلاً صندوق طوارئ"></label>
    <label class="field"><span>كم المبلغ؟</span><div class="amtbox"><input id="gTarget" type="text" inputmode="decimal" class="amount-in" value="${x.target ? jd(x.target) : ''}" placeholder="0.000"><span class="cur">د.أ</span></div></label>
    <label class="field"><span>معك منه هلأ (اختياري)</span><input id="gStart" type="text" inputmode="decimal" class="amt" value="${x.start ? jd(x.start) : ''}" placeholder="0.000"></label>
    <div class="field"><span>لإيمتى؟ (اختياري)</span>${dateField('gDeadline', x.deadline || '', `min="${today()}"`)}</div>
    <label class="field"><span>أو كم بدك تحط بالشهر؟ (اختياري، إذا ما في موعد)</span><input id="gMonthly" type="text" inputmode="decimal" class="amt" value="${x.monthly ? jd(x.monthly) : ''}" placeholder="0.000"></label>
    <div class="btns"><button class="btn pri" id="gSave">احفظ</button>${x.deadline ? '<button class="btn ghost" id="gNoDate">شيل الموعد</button>' : ''}<button class="btn ghost" id="gCancel">إلغاء</button></div>`, sh => {
    let icon = x.icon || '🎯';
    sh.querySelectorAll('#gIcons [data-ic]').forEach(b => b.onclick = () => { icon = b.dataset.ic; sh.querySelectorAll('#gIcons .chip').forEach(c => c.classList.toggle('on', c === b)); });
    sh.querySelector('#gCancel').onclick = closeSheet;
    const nd = sh.querySelector('#gNoDate'); if (nd) nd.onclick = () => { const d = sh.querySelector('#gDeadline'); d.value = ''; d.dispatchEvent(new Event('change', { bubbles: true })); nd.remove(); };
    sh.querySelector('#gSave').onclick = async () => {
      const name = sh.querySelector('#gName').value.trim(), target = toFils(sh.querySelector('#gTarget').value);
      const st = sh.querySelector('#gStart').value.trim(), mo = sh.querySelector('#gMonthly').value.trim();
      const start = st ? toFils(st) : 0, monthly = mo ? toFils(mo) : 0;
      if (!name) return toast('اكتب اسم الهدف');
      if (!(target > 0)) return toast('اكتب المبلغ');
      if (!(start >= 0) || !(monthly >= 0)) return toast('في رقم غلط');
      const rec = { contribs: [], ...g, id: g?.id || uid(), ts: g?.ts || Date.now(), name, icon, target, start, monthly, deadline: sh.querySelector('#gDeadline').value || null };
      const list = [...L.goalsOf(state)]; const i = list.findIndex(z => z.id === rec.id);
      if (i >= 0) list[i] = rec; else list.push(rec);
      await saveGoals(list); closeSheet(); render(); toast('انحفظ ✓');
    };
  });
}
function goalMoveSheet(g, sign) {
  const p = L.goalPlan(state, g);
  const sugg = sign > 0 ? (p.reserve || p.perWeek || 0) : 0;
  openSheet(`<h3>${sign > 0 ? `➕ حطيت لـ ${esc(g.name)}` : `➖ سحبت من ${esc(g.name)}`}</h3>
    <div class="amtbox"><input id="gcAmt" type="text" inputmode="decimal" class="amount-in big" value="${sugg ? jd(sugg) : ''}" placeholder="0.000"><span class="cur">د.أ</span></div>
    <div class="sub" style="margin:8px 0">${sign > 0 ? 'بس بتعلّم إنك حجزتها للهدف، ما بيتحرك أي رصيد.' : `معك فيه ${jd(p.saved)}. السحب بيرجّعها للمصروف.`}</div>
    <div class="btns"><button class="btn pri" id="gcSave">${sign > 0 ? 'حطيت ✓' : 'سحبت'}</button><button class="btn ghost" id="gcCancel">إلغاء</button></div>`, sh => {
    sh.querySelector('#gcCancel').onclick = closeSheet;
    sh.querySelector('#gcSave').onclick = async () => {
      const a = toFils(sh.querySelector('#gcAmt').value);
      if (!(a > 0)) return toast('اكتب المبلغ');
      if (sign < 0 && a > p.saved) return toast(`معك فيه ${jd(p.saved)} بس`);
      const list = L.goalsOf(state).map(z => z.id === g.id ? { ...z, contribs: [...(z.contribs || []), { id: uid(), ts: Date.now(), date: today(), amount: sign * a }] } : z);
      await saveGoals(list); closeSheet(); render();
      const np = L.goalPlan(state, list.find(z => z.id === g.id));
      toast(np.done ? '🎉 وصلت لهدفك!' : `${iso((sign > 0 ? '+' : '−') + jd(a))} · ${Math.round(np.pct * 100)}% ✓`);
    };
  });
}

// ----- Settings -----
VIEWS.settings = () => {
  const s = settings();
  const cats = [...state.kv.categories].sort((a, b) => a.order - b.order);
  const priceRows = Object.entries(s.prices).map(([m, [i, o]]) => `<div class="row" data-model="${esc(m)}"><span class="sub amt" style="flex:1.4">${esc(m)}</span><input type="text" inputmode="decimal" class="prIn amt" value="${i}"><input type="text" inputmode="decimal" class="prOut amt" value="${o}"></div>`).join('');
  return `<div class="verbadge">مصروفي <b class="amt">v${APP_VERSION}</b></div>
  <h2>🎯 أهداف التوفير</h2><div class="card"><div class="sub" style="margin-bottom:8px">${L.goalsOf(state).length ? `عندك ${L.goalsOf(state).length} ${L.goalsOf(state).length === 1 ? 'هدف' : 'أهداف'}` : 'ما في أهداف لسا'}</div><button class="btn" data-act="go" data-v="goals">🎯 أهدافي</button></div>
  <h2>🎨 الشكل والتنبيهات</h2><div class="card">
    <div class="field"><span>المظهر</span><div class="seg" id="themeSeg">${[['dark', 'غامق'], ['light', 'فاتح'], ['auto', 'حسب التلفون']].map(([v, l]) => `<button type="button" data-theme="${v}" class="${(s.theme || 'dark') === v ? 'on' : ''}">${l}</button>`).join('')}</div></div>
    <div class="field"><span>حجم الخط</span><div class="seg" id="fontSeg">${[[1, 'عادي'], [1.12, 'كبير'], [1.25, 'أكبر']].map(([v, l]) => `<button type="button" data-fs="${v}" class="${(s.fontScale || 1.12) === v ? 'on' : ''}">${l}</button>`).join('')}</div></div>
    <label class="toggle"><span>قارن التصنيفات بمعدلك<br><span class="sub">ملاحظات زي "📈 المزرعة هالشهر فوق معدلك، شو صاير؟"</span></span><input id="catNudges" type="checkbox" ${s.catNudges ? 'checked' : ''}></label></div>
  <h2>🔑 Claude</h2><div class="card">
    <label class="field"><span>مفتاح API ${state.kv.apiKey ? '<span class="pill good">محفوظ</span>' : ''}</span><input id="apiKey" type="password" dir="ltr" autocomplete="off" placeholder="${state.kv.apiKey ? '•••••• (محفوظ)' : 'sk-ant-...'}"></label>
    <div class="btns"><button class="btn" data-act="saveKey">احفظ المفتاح</button>${state.kv.apiKey ? '<button class="btn danger" data-act="delKey">امسح المفتاح</button>' : ''}</div>
    <div class="sub">المفتاح بضل بهالتلفون بس (IndexedDB)، وما بنحط بالكود ولا بالنسخة الاحتياطية إلا إذا اخترت.</div>
    <label class="field"><span>الموديل</span><select id="model">${C.MODELS.map(m => `<option ${m === s.model ? 'selected' : ''}>${m}</option>`).join('')}</select></label>
    <label class="field"><span>موديل "تحليل أعمق"</span><select id="deepModel">${C.DEEP_MODELS.map(m => `<option ${m === s.deepModel ? 'selected' : ''}>${m}</option>`).join('')}</select></label>
    <label class="field"><span>أو اكتب موديل عادي (اختياري)</span><input id="customModel" type="text" dir="ltr" value="${esc(s.customModel)}" placeholder="claude-..."></label>
    <label class="field"><span>حد الصرف الشهري ($)</span><input id="capUsd" type="text" inputmode="decimal" class="amt" value="${s.capUsd}"></label>
    <div class="sub">هالشهر: ${fmtUsd(monthCost())}</div>
    <details style="margin-top:8px"><summary class="sub">أسعار الموديلات ($ لكل مليون توكن: دخول / خروج)</summary>${priceRows}</details>
    <label class="field"><span>ملاحظات عني (بتنبعت مع كل سؤال)</span><textarea id="notes" placeholder="مثلاً: عندي مزرعة، بشتغل من البيت...">${esc(s.notes)}</textarea></label>
    <button class="btn pri" data-act="saveAI">احفظ</button></div>

  <h2>📏 الميزانية والبطاقة</h2><div class="card">
    <label class="field"><span>ميزانية الرفاهية الشهرية</span><input id="rafahBudget" type="text" inputmode="decimal" class="amt" value="${jd(s.rafahBudget)}"></label>
    <div class="row"><label class="field"><span>يوم الكشف</span><input id="stmtDay" type="number" min="1" max="31" value="${s.stmtDay}"></label><label class="field"><span>يوم الاستحقاق</span><input id="dueDay" type="number" min="1" max="31" value="${s.dueDay}"></label></div>
    <button class="btn pri" data-act="saveBudget">احفظ</button></div>

  <h2>🗂️ التصنيفات</h2><div class="card">
    <label class="toggle"><span>رتّب أزرار التصنيفات حسب الاستخدام</span><input id="sortByUse" type="checkbox" ${s.sortByUse ? 'checked' : ''}></label>
    <div id="catList">${cats.map((c, i) => `<div class="catedit" data-id="${c.id}">
      <input type="text" class="cIcon" value="${esc(c.icon || '')}" style="text-align:center">
      <input type="text" class="cName" value="${esc(c.name)}">
      <div class="ops"><button data-act="catUp" data-id="${c.id}" ${i === 0 ? 'disabled' : ''}>▲</button><button data-act="catDown" data-id="${c.id}" ${i === cats.length - 1 ? 'disabled' : ''}>▼</button><button data-act="catDel" data-id="${c.id}">🗑️</button></div>
      <div class="opts"><label><input type="checkbox" class="cRafah" ${c.rafah ? 'checked' : ''} ${c.kind === 'sadaqa' ? 'disabled' : ''}> بتنحسب رفاهية</label>
      <label>النوع <select class="cKind" style="min-height:36px;padding:4px;width:auto"><option value="need" ${c.kind === 'need' ? 'selected' : ''}>ضروري</option><option value="judge" ${c.kind === 'judge' ? 'selected' : ''}>بنحكم عليه</option><option value="sadaqa" ${c.kind === 'sadaqa' ? 'selected' : ''}>صدقة (ما بنحكم)</option></select></label>
      <input type="text" class="cSubs" value="${esc((c.subs || []).join('، '))}" placeholder="تفاصيل مفصولة بفاصلة (اختياري)"></div></div>`).join('')}</div>
    <div class="btns"><button class="btn" data-act="catAdd">➕ تصنيف</button><button class="btn pri" data-act="catSave">احفظ التصنيفات</button></div></div>

  ${MANUAL_ONLY ? '' : `  <h2>📥 صندوق الرسائل التلقائي</h2><div class="card">
    <label class="field"><span>توكن GitHub ${inboxCfg().token ? '<span class="pill good">محفوظ</span>' : ''}</span><input id="inboxToken" type="password" dir="ltr" autocomplete="off" placeholder="${inboxCfg().token ? '•••••• (محفوظ)' : 'github_pat_...'}"></label>
    <label class="field"><span>الريبو</span><input id="inboxRepo" type="text" dir="ltr" value="${esc(inboxCfg().repo || 'hamootax-ai/masroofi-inbox')}"></label>
    <div class="btns"><button class="btn pri" data-act="saveInbox">احفظ</button>${inboxCfg().token ? '<button class="btn" data-act="pullNow">اسحب هلأ</button><button class="btn danger" data-act="delInbox">امسح</button>' : ''}</div>
    <div class="sub">آخر سحب: ${agoText(inboxCfg().lastPull)}${inboxCfg().lastError ? ` · <span class="bad">${esc(inboxCfg().lastError)}</span>` : ''}. التوكن بضل بالتلفون بس، وما بنحط بالنسخة الاحتياطية إلا إذا اخترت.</div>
    <button class="btn ghost" data-act="go" data-v="sms" style="margin-top:8px">📩 رسائل البنك</button></div>`}

  <h2>📥 استيراد بيانات</h2><div class="card" id="bulkCard">
    <div class="sub">الصق JSON فيه دخل والتزامات وإلي عند الناس. <b>بيضيف بس</b>، ما بيمسح ولا بيستبدل شي، واللي موجود قبل بيتخطاه.</div>
    <textarea id="bulkText" dir="ltr" spellcheck="false" placeholder='{"incomes": [...], "obligations": [...], "receivables": [...]}'>${esc(ui.bulkText || '')}</textarea>
    <button class="btn" data-act="bulkParse" style="margin-top:8px">حلّل</button>
    <div id="bulkOut">${bulkHtml()}</div></div>

  <h2>💾 نسخة احتياطية</h2><div class="card">
    <div class="sub">آخر نسخة: ${state.kv.lastBackup ? dayLabel(ymd(new Date(state.kv.lastBackup))) : 'ولا مرة'}</div>
    <label class="toggle"><span>ضمّن المفاتيح (Claude + توكن الصندوق) بالملف</span><input id="incKey" type="checkbox"></label>
    <div class="btns"><button class="btn pri" data-act="export">⬆️ صدّر</button><label class="btn" style="cursor:pointer">⬇️ استرجع<input id="importIn" type="file" accept="application/json,.json" hidden></label></div>
    <div class="sub">احفظ الملف بـ Files ← iCloud Drive.</div></div>

  <h2>🔒 القفل والتخزين</h2><div class="card">
    <div class="btns">${state.kv.pinHash ? '<button class="btn" data-act="setPin">غيّر الرمز</button><button class="btn danger" data-act="delPin">شيل الرمز</button>' : '<button class="btn" data-act="setPin">حط رمز 4 أرقام</button>'}</div>
    <div class="sub">قفل خفيف: بيمنع حدا يفتح التطبيق بالصدفة، بس مش تشفير.</div>
    <div class="kv"><span>التخزين الدائم</span><span id="persistState">${ui.persisted == null ? '…' : ui.persisted ? '<span class="good">مفعّل ✓</span>' : '<span class="warn">مش مضمون</span>'}</span></div>
    <div class="sub">على آيفون، التطبيق المثبّت على الشاشة الرئيسية ما بينمسح لحاله. ضل اعمل نسخ احتياطية.</div>
    <div class="kv"><span>وضع التشغيل</span><span>${isStandalone() ? 'مثبّت ✓' : 'متصفح'}</span></div>
    <button class="btn ghost" data-act="guide">📲 طريقة التثبيت</button>
    <div class="sub" style="text-align:center;margin-top:10px">مصروفي v${APP_VERSION}</div></div>`;
};
AFTER.settings = () => {
  $('#bulkText').addEventListener('input', e => { ui.bulkText = e.target.value; });
  $('#importIn').addEventListener('change', e => { const f = e.target.files?.[0]; if (f) importFile(f); e.target.value = ''; });
  $('#sortByUse').addEventListener('change', async e => { settings().sortByUse = e.target.checked; await saveSettings(); toast('انحفظ ✓'); });
  $('#catNudges').addEventListener('change', async e => { settings().catNudges = e.target.checked; await saveSettings(); toast(e.target.checked ? 'رح أقارن بمعدلك ✓' : 'وقفت المقارنات ✓'); });
  $$('#themeSeg button').forEach(bt => bt.addEventListener('click', async () => { settings().theme = bt.dataset.theme; applyTheme(); await saveSettings(); render(); }));
  $$('#fontSeg button').forEach(bt => bt.addEventListener('click', async () => { settings().fontScale = Number(bt.dataset.fs); applyFontScale(); await saveSettings(); render(); }));
  navigator.storage?.persisted?.().then(p => { ui.persisted = p; const el = $('#persistState'); if (el) el.innerHTML = p ? '<span class="good">مفعّل ✓</span>' : '<span class="warn">مش مضمون</span>'; }).catch(() => {});
};

function bulkHtml() {
  const b = ui.bulk;
  if (!b) return ui.bulkDone ? `<div class="banner blue" id="bulkDone">${ui.bulkDone}</div>` : '';
  if (b.error) return `<div class="banner red" id="bulkErr">⚠️ ${esc(b.error)}</div>`;
  const n = b.incomes.length + b.obligations.length + b.receivables.length, d = b.dups.incomes + b.dups.obligations + b.dups.receivables;
  const row = (ic, t, v) => `<li class="item"><div class="ic">${ic}</div><div class="main"><div class="t">${esc(t)}</div></div><div class="v ${/^\d/.test(v) ? 'amt' : 'sub'}">${esc(v)}</div></li>`;
  return `<div class="banner blue" id="bulkPlan">رح أضيف: <b>${b.incomes.length}</b> دخل، <b>${b.obligations.length}</b> التزام، <b>${b.receivables.length}</b> إلك</div>
  ${d ? `<div class="banner blue" id="bulkDups">↩️ تخطيت ${d} مكرر (موجود قبل)${b.dups.incomes ? ` · دخل ${b.dups.incomes}` : ''}${b.dups.obligations ? ` · التزام ${b.dups.obligations}` : ''}${b.dups.receivables ? ` · إلك ${b.dups.receivables}` : ''}</div>` : ''}
  ${b.errors.map(e => `<div class="banner yellow">⚠️ ${esc(e)} (ما رح ينضاف)</div>`).join('')}
  ${n ? `<details class="adv" style="margin:6px 0"><summary>شو رح ينضاف</summary><ul class="list">${[
    ...b.incomes.map(i => row('💰', `${i.source} · ${dateShort(i.date)}${i.recur !== 'none' ? ' · ' + ({ monthly: 'شهري', yearly: 'سنوي', months: 'أشهر' }[i.recur]) : ''}${i.sure ? '' : ' · مش أكيد'}`, jd(i.amount))),
    ...b.obligations.map(o => row('🧾', `${o.title}${o.due ? ' · ' + dateShort(o.due) : ''}${o.monthly ? ' · شهري' : ''}`, jd(L.remaining(o)))),
    ...b.receivables.map(r => row('🤝', `${r.who}${r.due ? ' · ' + dateShort(r.due) : r.expected ? ' · ' + r.expected : ''}${r.sure ? ' · أكيد' : ''}`, L.recvLabel(r))),
  ].join('')}</ul></details>
  <button class="btn pri" data-act="bulkSave" id="bulkSaveBtn">ضيف ${n}</button>` : '<div class="sub">ما في شي جديد أضيفه.</div>'}`;
}

function readCatEdits() {
  $$('#catList .catedit').forEach(row => {
    const c = state.kv.categories.find(x => x.id === row.dataset.id); if (!c) return;
    c.icon = row.querySelector('.cIcon').value.trim();
    c.name = row.querySelector('.cName').value.trim() || c.name;
    c.kind = row.querySelector('.cKind').value;
    c.rafah = c.kind === 'sadaqa' ? false : row.querySelector('.cRafah').checked;
    c.subs = row.querySelector('.cSubs').value.split(/[،,]/).map(s => s.trim()).filter(Boolean);
  });
}

// ----- Backup -----
async function exportData() {
  const includeKey = $('#incKey')?.checked;
  const kv = { ...state.kv, lastBackup: Date.now() };
  if (!includeKey) { delete kv.apiKey; if (kv.inbox) kv.inbox = { ...kv.inbox, token: undefined }; }
  const data = { app: 'masroofi', version: 1, exportedAt: new Date().toISOString(), entries: state.entries, transfers: state.transfers, incomes: state.incomes, obligations: state.obligations, receivables: state.receivables, chat: state.chat, kv };
  const name = `masroofi-backup-${today()}.json`;
  const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
  const file = new File([blob], name, { type: 'application/json' });
  let ok = false;
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: name }); ok = true; }
    catch (e) { if (e.name === 'AbortError') return toast('انلغى'); }
  }
  if (!ok) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    ok = true;
  }
  await setKV('lastBackup', Date.now());
  toast('انحفظت النسخة ✓');
  render();
}
async function importFile(file) {
  let data;
  try { data = JSON.parse(await file.text()); } catch { return toast('الملف مش مفهوم'); }
  if (data?.app !== 'masroofi') return toast('هاد مش ملف مصروفي');
  const n = (data.entries || []).length;
  if (!confirm(`رح أستبدل كل البيانات الحالية بالنسخة (${n} مصروف، ${(data.incomes || []).length} دخل، ${(data.obligations || []).length} التزام، ${(data.receivables || []).length} إلك) من ${String(data.exportedAt || '').slice(0, 10)}. متأكد؟`)) return;
  await db.replaceAll({ ...data, __keepKey: true });
  await load();
  if (!state.kv.lastBackup && data.exportedAt) await setKV('lastBackup', Date.parse(data.exportedAt) || Date.now());
  toast('انسترجعت ✓');
  render();
}

// ----- PIN -----
async function pinPad(title, onDone) {
  let val = '';
  const ov = $('#overlay');
  const draw = () => {
    ov.innerHTML = `<div class="overlay" id="pinOv"><div style="text-align:center"><div style="font-size:2.4rem">🔒</div><h3>${esc(title)}</h3><div class="pin-dots">${[0, 1, 2, 3].map(i => `<i class="${i < val.length ? 'f' : ''}"></i>`).join('')}</div>
    <div class="keypad">${[1, 2, 3, 4, 5, 6, 7, 8, 9].map(n => `<button data-k="${n}">${n}</button>`).join('')}<button data-k="x">⌫</button><button data-k="0">0</button><button data-k="c" style="font-size:1rem">${onDone.cancel ? 'إلغاء' : ''}</button></div></div></div>`;
    ov.querySelectorAll('[data-k]').forEach(b => b.onclick = async () => {
      const k = b.dataset.k;
      if (k === 'x') val = val.slice(0, -1);
      else if (k === 'c') { if (onDone.cancel) { ov.innerHTML = ''; onDone.cancel(); } return; }
      else if (val.length < 4) val += k;
      draw();
      if (val.length === 4) { const v = val; val = ''; setTimeout(() => onDone(v, draw), 120); }
    });
  };
  draw();
}
function lockScreen() {
  return new Promise(resolve => {
    const fn = async (v, redraw) => {
      if (await sha256('masroofi:' + v) === state.kv.pinHash) { $('#overlay').innerHTML = ''; resolve(); }
      else { toast('الرمز غلط'); redraw(); }
    };
    pinPad('ادخل الرمز', fn);
  });
}
function setPinFlow() {
  let first = null;
  const fn = async (v, redraw) => {
    if (!first) { first = v; $('#overlay').innerHTML = ''; pinPad('عيد الرمز', fn); return; }
    if (v !== first) { toast('الرمزين مش نفس الشي'); first = null; $('#overlay').innerHTML = ''; pinPad('رمز جديد (4 أرقام)', fn); return; }
    await setKV('pinHash', await sha256('masroofi:' + v));
    $('#overlay').innerHTML = ''; toast('انحط الرمز ✓'); render();
  };
  fn.cancel = () => render();
  pinPad('رمز جديد (4 أرقام)', fn);
}

// ----- Install guide -----
function showGuide() {
  $('#overlay').innerHTML = `<div class="overlay" id="guideOv"><div class="guide">
    <img class="logo" src="icons/icon-192.png" alt="">
    <h2 style="text-align:center;color:var(--text);font-size:1.4rem">ثبّت مصروفي على الشاشة الرئيسية</h2>
    <ol>
      <li>بكروم على الآيفون، اضغط زر <b>المشاركة</b> <span style="font-size:1.2em">⬆️</span> جنب شريط العنوان (فوق).</li>
      <li>انزل واختار <b>"إضافة إلى الشاشة الرئيسية"</b>.</li>
      <li>اضغط <b>إضافة</b>، وافتح التطبيق من الأيقونة.</li>
    </ol>
    <div class="banner red">⚠️ البيانات بتنحفظ جوّا التطبيق المثبّت بس. إذا فتحت من كروم بتلاقي نسخة فاضية ومنفصلة. <b>افتح دايماً من أيقونة الشاشة الرئيسية.</b></div>
    <button class="btn pri" id="guideOk">فهمت</button>
  </div></div>`;
  $('#guideOk').onclick = async () => { $('#overlay').innerHTML = ''; await setKV('guideDismissed', true); };
}

// ---------------- Actions ----------------
const ACT = {
  go: el => {
    go(el.dataset.v);
    // (v1.9, 2026-11-16, Ahmad: "كل ما افتح على سجِّل بفتحلي قائمة اني اكتب الرقم ... مزعجة / المفروض بس اضغط عالفراغ") no auto focus:
    // the keypad opens only when he taps the amount field
  },
  safeInfo: () => safeSheet(),
  newGoal: () => goalSheet(),
  goalEdit: el => { const g = L.goalsOf(state).find(z => z.id === el.dataset.id); if (g) goalSheet(g); },
  goalAdd: el => { const g = L.goalsOf(state).find(z => z.id === el.dataset.id) || L.goalsOf(state)[0]; if (g) goalMoveSheet(g, 1); },
  goalTake: el => { const g = L.goalsOf(state).find(z => z.id === el.dataset.id); if (g) goalMoveSheet(g, -1); },
  goalDel: async el => {
    const g = L.goalsOf(state).find(z => z.id === el.dataset.id); if (!g) return;
    if (!confirm(`نحذف الهدف "${g.name}"؟ (ما بيتغيّر أي رصيد)`)) return;
    const before = L.goalsOf(state);
    await saveGoals(before.filter(z => z.id !== g.id)); render();
    toast('انحذف', 'رجّعه', async () => { await saveGoals(before); render(); });
  },
  smsParse: () => { ui.smsText = $('#smsText').value; ui.smsDone = ''; smsParse(ui.smsText); ui.smsFromFile = false; render(); },
  smsApply: () => smsApply(),
  pullNow: () => pullInbox(),
  saveInbox: async () => {
    const tok = $('#inboxToken').value.trim(), repo = $('#inboxRepo').value.trim().replace(/^https?:\/\/github\.com\//, '').replace(/\/$/, '');
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return toast('اسم الريبو لازم يكون owner/name');
    if (!tok && !inboxCfg().token) return toast('الصق التوكن');
    await setKV('inbox', { ...inboxCfg(), repo, ...(tok ? { token: tok } : {}) });
    render(); toast('انحفظ ✓'); pullInbox();
  },
  delInbox: async () => { if (!confirm('نمسح توكن الصندوق؟')) return; await setKV('inbox', { repo: inboxCfg().repo }); render(); },
  back: () => go(ui.prevView && !SUB.includes(ui.prevView) ? ui.prevView : 'add'),
  toggleDeep: el => { ui.deep = !ui.deep; el.classList.toggle('on', ui.deep); el.setAttribute('aria-pressed', ui.deep); },
  seg: el => {
    const name = el.dataset.name, val = el.dataset.val;
    el.parentElement.querySelectorAll('button').forEach(b => b.classList.toggle('on', b === el));
    el.parentElement.nextElementSibling?.classList.contains('nonehint') && el.parentElement.nextElementSibling.classList.toggle('hidden', val !== 'none');
    if (name === 'qaFrom') ui.qa.from = val;
    if (name === 'pFrom' && ui.parsed) ui.parsed.from = val;
    if (name === 'bigFrom') ui.bigFrom = val;
  },
  pickCat: el => {
    const q = ui.qa; q.cat = el.dataset.id; q.sub = '';
    const c = L.catById(state, q.cat);
    q.rafah = c?.kind === 'sadaqa' ? false : !!c?.rafah; q.rafahTouched = false; // each pick resets to the category default
    q.amount = $('#qaAmount').value; q.note = $('#qaNote').value;
    const y = window.scrollY; render(); window.scrollTo(0, y);
  },
  pickSub: el => { ui.qa.sub = ui.qa.sub === el.dataset.val ? '' : el.dataset.val; const y = window.scrollY; render(); window.scrollTo(0, y); },
  qaSave: async () => {
    const q = ui.qa;
    q.amount = $('#qaAmount').value; q.note = $('#qaNote').value; q.date = $('#qaDate').value || today(); q.rafah = $('#qaRafah').checked;
    const amount = toFils(q.amount);
    if (!(amount > 0)) { toast('اكتب المبلغ'); $('#qaAmount').focus(); return; }
    if (!q.cat) { toast('اختار تصنيف'); return; }
    const e = await addEntry({ amount, cat: q.cat, sub: q.sub, note: q.note, from: q.from, date: q.date, rafah: q.rafah });
    resetQA(q.from);
    document.activeElement?.blur?.();
    render();
    const v = L.entryVerdict(state, e);
    toast(`${v.icon} ${iso(jd(amount))} · ${v.text}`, 'تراجع', async () => { await delRec('entries', e.id); render(); });
  },
  parse: () => {
    ui.noteText = $('#noteText').value;
    ui.multiDone = '';
    ui.multi = L.parseMultiNote(ui.noteText, state.kv.categories); // 2+ date lines; a one-day note takes the old path below, unchanged
    if (ui.multi) { ui.parsed = null; $('#parsed').innerHTML = parsedHtml(); return; }
    const p = L.parseNote(ui.noteText, state.kv.categories);
    p.from = 'cash';
    ui.parsed = p;
    $('#parsed').innerHTML = parsedHtml();
  },
  mSave: async () => {
    const m = ui.multi; if (!m) return;
    const { add, skipped } = L.dedupeDayItems(state, m.days); // again, against what is saved right now
    const base = Date.now() - add.length;
    const recs = add.map((it, k) => {
      const c = L.catById(state, it.cat);
      return { id: uid(), ts: base + k, date: it.date, amount: it.amount, cat: it.cat, sub: it.sub || '', note: it.text.trim(), from: 'none', rafah: c?.kind === 'sadaqa' ? false : !!it.rafah, paste: 'multi' };
    });
    await db.putMany('entries', recs);
    state.entries.push(...recs);
    ui.multi = null; ui.noteText = '';
    ui.multiDone = `✅ انضاف ${nItems(recs.length)} (${nDays(new Set(recs.map(r => r.date)).size)})${skipped ? `، وتخطيت ${skipped} مكرر` : ''}. ما تغيّر ولا رصيد.`;
    render();
    const ids = recs.map(r => r.id);
    toast(`انضاف ${recs.length} ✓`, 'تراجع', async () => { await db.delMany('entries', ids); const set = new Set(ids); state.entries = state.entries.filter(e => !set.has(e.id)); ui.multiDone = '↩️ رجّعت، ما انضاف شي.'; render(); });
  },
  pDel: el => { readParsedEdits(); ui.parsed.items.splice(+el.dataset.i, 1); $('#parsed').innerHTML = parsedHtml(); },
  pSave: async () => {
    readParsedEdits();
    const p = ui.parsed;
    if (p.items.some(i => !(i.amount > 0))) return toast('في مبلغ غلط');
    for (const it of p.items) await addEntry({ amount: it.amount, cat: it.cat, sub: it.sub, note: it.text, from: p.from || 'cash', date: p.date, rafah: it.rafah });
    const n = p.items.length, d = p.date;
    ui.parsed = null; ui.noteText = '';
    ui.dayDate = d; go('day');
    toast(`انحفظ ${n} ✓`);
  },
  dayShift: el => { const d = parseYmd(ui.dayDate); d.setDate(d.getDate() + +el.dataset.n); ui.dayDate = ymd(d); render(); },
  editEntry: el => { const e = state.entries.find(x => x.id === el.dataset.id); if (e) entrySheet(e); },
  delEntry: async el => {
    const e = state.entries.find(x => x.id === el.dataset.id); if (!e) return;
    if (!confirm(`نحذف ${jd(e.amount)} ${e.note || L.catName(state, e.cat)}؟`)) return;
    await delRec('entries', e.id); render();
    toast('انحذف', 'رجّعه', async () => { await saveRec('entries', e); render(); });
  },
  copyDay: () => copyText(L.dayNote(state, ui.dayDate)),
  askDay: () => {
    if (!state.kv.apiKey) return noKeySheet();
    const list = state.entries.filter(e => e.date === ui.dayDate);
    const txt = list.length ? L.dayNote(state, ui.dayDate) : `ما سجّلت شي يوم ${ui.dayDate}`;
    sendChat(`هاي مصاريف ${ui.dayDate === today() ? 'اليوم' : ui.dayDate}، شو رأيك؟\n${txt}`);
  },
  monShift: el => { ui.monthYm = addMonths(ui.monthYm, +el.dataset.n); render(); },
  copySummary: () => copyText(C.buildContext(state)),
  moneySeg: el => { ui.moneySeg = el.dataset.val; render(); },
  editBal: el => {
    const acc = el.dataset.acc, b = L.balances(state), a = state.kv.accounts;
    const isCard = acc === 'card';
    openSheet(`<h3>${isCard ? 'البطاقة' : L.ACCOUNTS[acc]}</h3>
      <label class="field"><span>${isCard ? 'المطلوب منك هلأ ("القائم" بتطبيق البنك، مش "المستحق")' : 'الرصيد الحقيقي هلأ'}</span><input id="bVal" type="text" inputmode="decimal" class="amount-in" value="${jd(b[acc])}"></label>
      ${isCard ? `<label class="field"><span>حد البطاقة</span><input id="bLimit" type="text" inputmode="decimal" class="amt" value="${jd(a.card.limit || 0)}"></label>` : ''}
      <div class="sub">الرقم اللي بتكتبه بيحل محل التقدير. المصاريف والتحويلات بعد هيك بتنحسب عليه.</div>
      <div class="btns"><button class="btn pri" id="bSave">احفظ</button><button class="btn ghost" id="bCancel">إلغاء</button></div>`, sh => {
      sh.querySelector('#bCancel').onclick = closeSheet;
      sh.querySelector('#bSave').onclick = async () => {
        const v = toFils(sh.querySelector('#bVal').value);
        if (isNaN(v)) return toast('الرقم غلط');
        const accs = structuredClone(a);
        if (v !== b[acc]) { accs[acc].base = v; accs[acc].baseTs = Date.now(); }
        if (isCard) { const lim = toFils(sh.querySelector('#bLimit').value); if (!isNaN(lim)) accs.card.limit = lim; }
        await setKV('accounts', accs); closeSheet(); render(); toast('انحفظ ✓');
      };
    });
  },
  payCard: () => {
    const cc = L.cardCycle(state);
    ui.moneySeg = 'acc'; render();
    $('#tFrom').value = 'savings'; $('#tTo').value = 'card';
    $('#tAmt').value = jd(cc.dueAmount || L.balances(state).card); $('#tNote').value = 'سداد البطاقة';
    $('#tAmt').focus();
  },
  addTransfer: async () => {
    const from = $('#tFrom').value, to = $('#tTo').value, amount = toFils($('#tAmt').value);
    if (from === to) return toast('اختار حسابين مختلفين');
    if (!(amount > 0)) return toast('اكتب المبلغ');
    await saveRec('transfers', { id: uid(), ts: Date.now(), date: today(), from, to, amount, note: $('#tNote').value.trim() });
    render(); toast(`حوّلت ${iso(jd(amount))} ✓`);
  },
  delTransfer: async el => { if (!confirm('نحذف التحويل؟')) return; await delRec('transfers', el.dataset.id); render(); },
  newInc: () => incomeSheet(),
  editInc: el => incomeSheet(state.incomes.find(i => i.id === el.dataset.id)),
  delInc: async el => { if (!confirm('نحذف هالدخل؟')) return; await delRec('incomes', el.dataset.id); render(); },
  recvInc: el => {
    const inc = state.incomes.find(i => i.id === el.dataset.id); if (!inc) return;
    openSheet(`<h3>وصل ${esc(inc.source)}؟</h3>
      <label class="field"><span>المبلغ اللي وصل</span><input id="rAmt" type="text" inputmode="decimal" class="amount-in" value="${jd(inc.amount)}"></label>
      <div class="field"><span>وين حطيته؟</span>${fromSeg('rAcc', 'savings')}</div>
      ${inc.recur && inc.recur !== 'none' ? '<div class="sub">رح ينعمل الموعد الجاي لحاله.</div>' : ''}
      <div class="btns"><button class="btn pri" id="rSave">وصل ✓</button><button class="btn ghost" id="rCancel">إلغاء</button></div>`, sh => {
      let acc = 'savings';
      sh.querySelectorAll('[data-name=rAcc]').forEach(b => b.addEventListener('click', () => { acc = b.dataset.val; }));
      sh.querySelector('#rCancel').onclick = closeSheet;
      sh.querySelector('#rSave').onclick = async () => {
        const a = toFils(sh.querySelector('#rAmt').value); if (!(a > 0)) return toast('المبلغ غلط');
        const { done, next } = L.receiveIncome(inc, acc, a);
        await saveRec('incomes', done); if (next) await saveRec('incomes', next);
        closeSheet(); render(); toast(`${iso('+' + jd(a))} على ${L.ACCOUNTS[acc]} ✓`);
      };
    });
  },
  newRecv: () => recvSheet(),
  editRecv: el => recvSheet(state.receivables.find(r => r.id === el.dataset.id)),
  delRecv: async el => {
    const r = state.receivables.find(x => x.id === el.dataset.id); if (!r) return;
    if (!confirm(`نحذف "${r.who}"؟${r.incomeId ? ' (الدخل اللي انضاف منه بضل، احذفه من "دخل" إذا بدك)' : ''}`)) return;
    await delRec('receivables', r.id); render();
  },
  recvGot: el => { const r = state.receivables.find(x => x.id === el.dataset.id); if (r) recvGotSheet(r); },
  recvUndo: async el => {
    const r = state.receivables.find(x => x.id === el.dataset.id); if (!r) return;
    if (!confirm(`نرجّع "${r.who}" لسا ما وصل؟${r.incomeId ? ' والدخل اللي انضاف منه بينشال من الحساب.' : ''}`)) return;
    if (r.incomeId) await delRec('incomes', r.incomeId);
    await saveRec('receivables', { ...r, done: false, receivedTs: null, receivedDate: null, receivedAmount: null, account: null, incomeId: null });
    render();
  },
  newObl: () => oblSheet(),
  editObl: el => oblSheet(state.obligations.find(o => o.id === el.dataset.id)),
  delObl: async el => { if (!confirm('نحذف هالالتزام؟ (الدفعات المسجلة عليه رح تنشال من الحسابات)')) return; await delRec('obligations', el.dataset.id); render(); },
  payObl: el => {
    const o = state.obligations.find(x => x.id === el.dataset.id); if (!o) return;
    openSheet(`<h3>دفعة على ${esc(o.title)}</h3><div class="sub">الباقي ${jd(L.remaining(o))}</div>
      <label class="field"><span>المبلغ</span><input id="pAmt2" type="text" inputmode="decimal" class="amount-in" value="${jd(L.remaining(o))}"></label>
      <div class="field"><span>دفعت من</span>${fromSeg('payAcc', 'savings')}</div>
      <div class="sub">الدفعة بتنقص الحساب، ومش بتنحسب مصروف بالشهر (عشان ما تنحسب مرتين).</div>
      <div class="btns"><button class="btn pri" id="paySave">ادفع</button><button class="btn ghost" id="payCancel">إلغاء</button></div>`, sh => {
      let acc = 'savings';
      sh.querySelectorAll('[data-name=payAcc]').forEach(b => b.addEventListener('click', () => { acc = b.dataset.val; }));
      sh.querySelector('#payCancel').onclick = closeSheet;
      sh.querySelector('#paySave').onclick = async () => {
        const a = toFils(sh.querySelector('#pAmt2').value); if (!(a > 0)) return toast('المبلغ غلط');
        const { upd, next } = L.payObligation(o, acc, a);
        await saveRec('obligations', upd); if (next) await saveRec('obligations', next);
        closeSheet(); render(); toast(upd.done ? 'خلص ✓' : `دفعت ${iso(jd(a))} ✓`);
      };
    });
  },
  bigCheck: () => {
    ui.bigAmt = $('#bigAmt').value;
    const a = toFils(ui.bigAmt); if (!(a > 0)) return toast('اكتب المبلغ');
    ui.bigOut = bigOutHtml(L.bigPurchaseCheck(state, a, ui.bigFrom || 'cash'));
    $('#bigOut').innerHTML = ui.bigOut;
  },
  askBig: () => {
    if (!state.kv.apiKey) return noKeySheet();
    sendChat(`بفكر أشتري شغلة بـ ${jd(toFils(ui.bigAmt))} من ${L.ACCOUNTS[ui.bigFrom || 'cash']}. شو رأيك؟ شيّك الالتزامات والبطاقة.`);
  },
  send: () => sendChat($('#chatIn').value),
  dropImg: () => { ui.pendingImg = null; render(); },
  clearChat: async () => { if (!confirm('نمسح كل المحادثة؟')) return; await db.clearStore('chat'); state.chat = []; render(); },
  logFromChat: async el => {
    const m = state.chat.find(x => x.id === el.dataset.id); const l = m?.logs?.[+el.dataset.i]; if (!l || l.done) return;
    const amount = toFils(l.amount); if (!(amount > 0)) return toast('المبلغ مش واضح');
    const cat = findCatByName(l.cat);
    const fromMap = { 'كاش': 'cash', 'بطاقة': 'card', 'توفير': 'savings', cash: 'cash', card: 'card', savings: 'savings' };
    await addEntry({ amount, cat: cat.id, note: l.note, from: fromMap[l.from?.trim()] || 'cash', date: today() });
    l.done = true; await saveRec('chat', m); render(); toast(`انسجل ${iso(jd(amount))} · ${cat.name} ✓`);
  },
  saveKey: async () => {
    const k = $('#apiKey').value.trim(); if (!k) return toast('الصق المفتاح');
    if (!/^sk-ant-/.test(k) && !confirm('المفتاح ما بلش بـ sk-ant-. أحفظه هيك؟')) return;
    await setKV('apiKey', k); render(); toast('انحفظ المفتاح ✓');
  },
  delKey: async () => { if (!confirm('نمسح المفتاح من التلفون؟')) return; delete state.kv.apiKey; await db.kvDel('apiKey'); render(); },
  saveAI: async () => {
    const s = settings();
    s.model = $('#model').value; s.deepModel = $('#deepModel').value; s.customModel = $('#customModel').value.trim(); s.notes = $('#notes').value;
    const cap = parseFloat($('#capUsd').value); if (!isNaN(cap) && cap >= 0) s.capUsd = cap;
    $$('[data-model]').forEach(r => { const i = parseFloat(r.querySelector('.prIn').value), o = parseFloat(r.querySelector('.prOut').value); if (!isNaN(i) && !isNaN(o)) s.prices[r.dataset.model] = [i, o]; });
    await saveSettings(); toast('انحفظ ✓');
  },
  saveBudget: async () => {
    const s = settings();
    const rb = toFils($('#rafahBudget').value); if (rb >= 0) s.rafahBudget = rb;
    const sd = parseInt($('#stmtDay').value, 10), dd = parseInt($('#dueDay').value, 10);
    if (sd >= 1 && sd <= 31) s.stmtDay = sd; if (dd >= 1 && dd <= 31) s.dueDay = dd;
    await saveSettings(); toast('انحفظ ✓'); render();
  },
  bulkParse: () => {
    ui.bulkText = $('#bulkText').value; ui.bulkDone = '';
    ui.bulk = L.parseImport(ui.bulkText, state);
    $('#bulkOut').innerHTML = bulkHtml();
  },
  bulkSave: async () => {
    const b = L.parseImport(ui.bulkText, state); // again against what is saved now, so a double tap adds nothing twice
    if (b.error) { ui.bulk = b; $('#bulkOut').innerHTML = bulkHtml(); return; }
    for (const st of ['incomes', 'obligations', 'receivables']) if (b[st].length) { await db.putMany(st, b[st]); state[st].push(...b[st]); }
    const d = b.dups.incomes + b.dups.obligations + b.dups.receivables;
    ui.bulk = null; ui.bulkText = '';
    ui.bulkDone = `✅ انضاف ${b.incomes.length} دخل، ${b.obligations.length} التزام، ${b.receivables.length} إلك${d ? ` · تخطيت ${d} مكرر` : ''}`;
    render(); toast('انضافوا ✓');
  },
  catUp: el => moveCat(el.dataset.id, -1),
  catDown: el => moveCat(el.dataset.id, 1),
  catDel: async el => {
    const c = L.catById(state, el.dataset.id);
    const used = state.entries.filter(e => e.cat === c.id).length;
    if (state.kv.categories.length <= 1) return toast('لازم يضل تصنيف واحد');
    if (!confirm(used ? `"${c.name}" عليه ${used} مصروف. رح ينقلوا لـ "أخرى". نحذفه؟` : `نحذف "${c.name}"؟`)) return;
    readCatEdits();
    let other = state.kv.categories.find(x => x.id === 'other' && x.id !== c.id) || state.kv.categories.find(x => x.id !== c.id);
    for (const e of state.entries.filter(e => e.cat === c.id)) await saveRec('entries', { ...e, cat: other.id });
    await setKV('categories', state.kv.categories.filter(x => x.id !== c.id)); render();
  },
  catAdd: async () => {
    readCatEdits();
    const cats = state.kv.categories;
    cats.push({ id: 'c' + uid(), name: 'تصنيف جديد', icon: '🏷️', kind: 'judge', rafah: false, subs: [], order: Math.max(0, ...cats.map(c => c.order)) + 1 });
    await setKV('categories', cats); render();
    const last = $$('#catList .cName').pop(); last?.focus(); last?.select();
  },
  catSave: async () => { readCatEdits(); await setKV('categories', state.kv.categories); toast('انحفظ ✓'); render(); },
  export: () => exportData(),
  setPin: () => setPinFlow(),
  delPin: async () => { if (!confirm('نشيل الرمز؟')) return; delete state.kv.pinHash; await db.kvDel('pinHash'); render(); },
  guide: (el, ev) => { ev?.preventDefault(); showGuide(); },
};
async function moveCat(id, dir) {
  readCatEdits();
  const cats = [...state.kv.categories].sort((a, b) => a.order - b.order);
  const i = cats.findIndex(c => c.id === id), j = i + dir;
  if (j < 0 || j >= cats.length) return;
  [cats[i], cats[j]] = [cats[j], cats[i]];
  cats.forEach((c, k) => { c.order = k; });
  await setKV('categories', cats); render();
}

function incomeSheet(inc) {
  const i = inc || { source: '', amount: 0, date: today(), recur: 'none', months: [], sure: true };
  openSheet(`<h3>${inc ? 'تعديل دخل' : 'دخل متوقع'}</h3>
    <label class="field"><span>المصدر</span><input id="iSrc" type="text" value="${esc(i.source)}"></label>
    <label class="field"><span>المبلغ</span><input id="iAmt" type="text" inputmode="decimal" class="amt" value="${i.amount ? jd(i.amount) : ''}" placeholder="0.000"></label>
    <div class="field"><span>التاريخ المتوقع</span>${dateField('iDate', i.date)}</div>
    <label class="field"><span>بتتكرر</span><select id="iRecur"><option value="none">لا</option><option value="monthly">كل شهر</option><option value="yearly">كل سنة</option><option value="months">أشهر معينة</option></select></label>
    <div id="iMonths" class="chips ${i.recur === 'months' ? '' : 'hidden'}">${AR_MONTHS.map((m, k) => `<label class="chip"><input type="checkbox" value="${k + 1}" ${(i.months || []).includes(k + 1) ? 'checked' : ''}> ${m}</label>`).join('')}</div>
    <label class="field toggle"><span>أكيد؟</span><input id="iSure" type="checkbox" ${i.sure ? 'checked' : ''}></label>
    <div class="btns"><button class="btn pri" id="iSave">احفظ</button><button class="btn ghost" id="iCancel">إلغاء</button></div>`, sh => {
    sh.querySelector('#iRecur').value = i.recur || 'none';
    sh.querySelector('#iRecur').onchange = e => sh.querySelector('#iMonths').classList.toggle('hidden', e.target.value !== 'months');
    sh.querySelector('#iCancel').onclick = closeSheet;
    sh.querySelector('#iSave').onclick = async () => {
      const amount = toFils(sh.querySelector('#iAmt').value), source = sh.querySelector('#iSrc').value.trim();
      if (!source) return toast('اكتب المصدر'); if (!(amount > 0)) return toast('المبلغ غلط');
      const months = [...sh.querySelectorAll('#iMonths input:checked')].map(x => +x.value);
      await saveRec('incomes', { id: inc?.id || uid(), ts: inc?.ts || Date.now(), status: 'expected', ...inc, source, amount, date: sh.querySelector('#iDate').value || today(), recur: sh.querySelector('#iRecur').value, months, sure: sh.querySelector('#iSure').checked });
      closeSheet(); render(); toast('انحفظ ✓');
    };
  });
}
function oblSheet(o) {
  const x = o || { title: '', amount: 0, due: '', priority: 'mid', monthly: false };
  openSheet(`<h3>${o ? 'تعديل التزام' : 'التزام / دين'}</h3>
    <label class="field"><span>شو هو</span><input id="oTitle" type="text" value="${esc(x.title)}"></label>
    <label class="field"><span>المبلغ الكامل</span><input id="oAmt" type="text" inputmode="decimal" class="amt" value="${x.amount ? jd(x.amount) : ''}" placeholder="0.000"></label>
    <div class="field"><span>تاريخ الاستحقاق (اختياري)</span>${dateField('oDue', x.due || '')}</div>
    <label class="field"><span>الأولوية</span><select id="oPrio">${Object.entries(PRIO).map(([k, v]) => `<option value="${k}" ${k === x.priority ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
    <label class="field toggle"><span>بتتكرر كل شهر</span><input id="oMonthly" type="checkbox" ${x.monthly ? 'checked' : ''}></label>
    <div class="btns"><button class="btn pri" id="oSave">احفظ</button><button class="btn ghost" id="oCancel">إلغاء</button></div>`, sh => {
    sh.querySelector('#oCancel').onclick = closeSheet;
    sh.querySelector('#oSave').onclick = async () => {
      const amount = toFils(sh.querySelector('#oAmt').value), title = sh.querySelector('#oTitle').value.trim();
      if (!title) return toast('اكتب العنوان'); if (!(amount > 0)) return toast('المبلغ غلط');
      await saveRec('obligations', { id: o?.id || uid(), ts: o?.ts || Date.now(), payments: [], done: false, ...o, title, amount, due: sh.querySelector('#oDue').value || null, priority: sh.querySelector('#oPrio').value, monthly: sh.querySelector('#oMonthly').checked });
      closeSheet(); render(); toast('انحفظ ✓');
    };
  });
}

document.addEventListener('click', e => {
  const el = e.target.closest('[data-act]');
  if (!el || el.disabled) return;
  const fn = ACT[el.dataset.act];
  if (fn) { if (el.tagName === 'A') e.preventDefault(); fn(el, e); }
});
// keep the Arabic label of invisible date/month pickers in sync
function syncDateLabel(e) {
  const inp = e.target; if (!inp.closest?.('.datebox')) return;
  const lab = inp.parentElement.querySelector('.dlabel');
  lab.textContent = !inp.value ? (lab.dataset.empty || '') : inp.type === 'month' ? monthLabel(inp.value) : dayLabel(inp.value);
}
// (2026-11-14, Ahmad: "حد البطاقة بكون 0.000 ... بكتب 1 بصير 0.0001") a money field you tap: a zero clears, any other amount gets
// selected, so typing replaces it instead of appending to it
document.addEventListener('focusin', e => {
  const inp = e.target;
  if (!(inp instanceof HTMLInputElement) || inp.getAttribute('inputmode') !== 'decimal') return;
  if (/^[0.,\s]*$/.test(inp.value)) inp.value = '';
  else setTimeout(() => { try { inp.select(); } catch {} }, 0);
});
// (v1.6.1) iOS ignores user-scalable=no in Safari: block the pinch gesture itself
['gesturestart', 'gesturechange'].forEach(t => document.addEventListener(t, e => e.preventDefault(), { passive: false }));
document.addEventListener('input', syncDateLabel);
document.addEventListener('click', e => { const inp = e.target.closest?.('.datebox input'); if (inp) { try { inp.showPicker?.(); } catch {} } });
document.addEventListener('change', syncDateLabel);
document.addEventListener('keydown', e => {
  if (e.key === 'Enter' && e.target.id === 'qaAmount') { e.preventDefault(); $('#qaNote')?.focus(); }
  if (e.key === 'Enter' && e.target.id === 'chatIn' && !e.shiftKey && matchMedia('(pointer:fine)').matches) { e.preventDefault(); sendChat(e.target.value); }
});

// ---------------- Boot ----------------
// (v1.8) dark (default, as before) / light / auto (follows the phone)
function applyTheme() {
  const t = settings().theme || 'dark';
  const dark = t === 'dark' || (t === 'auto' && !matchMedia('(prefers-color-scheme: light)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  document.querySelector('meta[name=theme-color]')?.setAttribute('content', dark ? '#0f1218' : '#f4f5f8');
  document.querySelector('meta[name=color-scheme]')?.setAttribute('content', dark ? 'dark' : 'light');
}
matchMedia('(prefers-color-scheme: light)').addEventListener?.('change', () => { if (state.kv.settings?.theme === 'auto') applyTheme(); });
function applyFontScale() { document.documentElement.style.setProperty('--fs', (16 * (settings().fontScale || 1.12)).toFixed(1) + 'px'); }
async function boot() {
  try { await load(); }
  catch (err) { $('#view').innerHTML = `<div class="banner red">ما قدرت أفتح التخزين: ${esc(err.message || err)}</div>`; return; }
  applyFontScale();
  applyTheme();
  if (state.kv.pinHash) await lockScreen();
  render();
  if (!isStandalone() && !state.kv.guideDismissed) showGuide();
  autoPull();
  try { if (navigator.storage?.persist) ui.persisted = (await navigator.storage.persisted()) || (await navigator.storage.persist()); } catch {}
  if ('serviceWorker' in navigator) {
    const hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.register('sw.js').then(reg => reg.update?.()).catch(() => {});
    let reloaded = false;
    // (2026-11-14, Ahmad: "ما بتقدر تعملها مرة و خلص") ONE open is enough: the new version installs, takes over and the page reloads by itself
    // within a few seconds; a toast then says it updated (and which version), so there is no need to reopen
    navigator.serviceWorker.addEventListener('controllerchange', () => { if (hadController && !reloaded) { reloaded = true; try { sessionStorage.setItem('justUpdated', '1'); } catch {} location.reload(); } });
    try { if (sessionStorage.getItem('justUpdated')) { sessionStorage.removeItem('justUpdated'); toast('✅ تحدّث التطبيق: v' + APP_VERSION); } } catch {}
  }
}
window.__masroofi = { state, ui, L, C, render, go, sendChat, pullInbox }; // debugging/tests
boot();
