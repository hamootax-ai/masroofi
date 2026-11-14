import * as db from './db.js';
import { uid, toFils, jd, jdShort, today, thisMonth, addMonths, monthLabel, dayLabel, parseYmd, ymd, daysBetween, esc, sha256, AR_MONTHS } from './util.js';
import * as L from './logic.js';
import * as C from './claude.js';

export const APP_VERSION = '1.0.0';
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];

// ---------------- State ----------------
const state = { entries: [], transfers: [], incomes: [], obligations: [], chat: [], kv: {} };
const DEFAULT_SETTINGS = { rafahBudget: 60000, stmtDay: 20, dueDay: 4, model: 'claude-haiku-5-5', customModel: '', prices: structuredClone(C.DEFAULT_PRICES), capUsd: 5, notes: '', sortByUse: true };
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
  kv.settings = { ...DEFAULT_SETTINGS, ...(kv.settings || {}) };
  kv.settings.prices = { ...C.DEFAULT_PRICES, ...(kv.settings.prices || {}) };
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
const fd = s => { if (!s) return ''; const d = parseYmd(s); return `<bdi>${d.getDate()} ${AR_MONTHS[d.getMonth()]}${d.getFullYear() !== new Date().getFullYear() ? ' ' + d.getFullYear() : ''}</bdi>`; };
const iso = s => `⁦${s}⁩`;
const accOptions = (sel, list = ['cash', 'card', 'savings']) => list.map(a => `<option value="${a}" ${a === sel ? 'selected' : ''}>${L.ACCOUNTS[a]}</option>`).join('');
const catOptions = sel => state.kv.categories.map(c => `<option value="${c.id}" ${c.id === sel ? 'selected' : ''}>${esc(c.icon || '')} ${esc(c.name)}</option>`).join('');
const fromSeg = (name, sel) => `<div class="seg" data-seg="${name}">${['cash', 'card', 'savings'].map(a => `<button type="button" data-act="seg" data-name="${name}" data-val="${a}" class="${a === sel ? 'on' : ''}">${L.ACCOUNTS[a]}</button>`).join('')}</div>`;
const isStandalone = () => window.navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
const fmtUsd = n => '$' + (n || 0).toFixed(n < 0.1 ? 4 : 2);

function sortedCats() {
  const cats = [...state.kv.categories].sort((a, b) => a.order - b.order);
  if (!settings().sortByUse) return cats;
  const since = ymd(new Date(Date.now() - 90 * 86400000));
  const use = {};
  for (const e of state.entries) if (e.date >= since) use[e.cat] = (use[e.cat] || 0) + 1;
  return cats.sort((a, b) => (use[b.id] || 0) - (use[a.id] || 0) || a.order - b.order);
}

// ---------------- Views ----------------
const TITLES = { add: 'مصروفي', day: 'اليوم', month: 'الشهر', money: 'فلوسي', ask: 'اسأل كلاود', settings: 'الإعدادات' };

function render() {
  const v = ui.view;
  $('#title').textContent = TITLES[v];
  $$('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.v === v));
  $('#view').innerHTML = VIEWS[v]();
  AFTER[v]?.();
}
function go(v) { ui.view = v; render(); window.scrollTo(0, 0); }

function heroCard() {
  const b = L.balances(state);
  const cc = L.cardCycle(state);
  const lb = state.kv.lastBackup;
  const lbDays = lb ? Math.floor((Date.now() - lb) / 86400000) : null;
  return `<div class="card hero">
    <div class="lbl">الصافي (توفير + كاش − البطاقة)</div>
    <div class="big amt ${b.net < 0 ? 'neg' : ''}" id="netBig">${jd(b.net)}</div>
    <div class="minirow"><span>توفير <b class="amt">${jd(b.savings)}</b></span><span>كاش <b class="amt">${jd(b.cash)}</b></span><span>بطاقة <b class="amt">${jd(b.card)}</b></span></div>
    <div class="minirow" style="margin-top:6px"><span>مستحق يوم ${parseYmd(cc.dueDate).getDate()}: <b class="amt">${jd(cc.dueAmount)}</b>${cc.closed ? '' : ' <span class="pill">تقريبي</span>'}</span>
    <span>آخر نسخة احتياطية: <b>${lb ? (lbDays === 0 ? 'اليوم' : `قبل ${lbDays} يوم`) : 'ولا مرة'}</b></span></div>
  </div>`;
}

function bannersHtml() {
  const list = [...L.adviceBanners(state)];
  const lb = state.kv.lastBackup;
  const hasData = state.entries.length + state.incomes.length + state.obligations.length > 0;
  if (hasData && (!lb || Date.now() - lb > 7 * 86400000)) list.push({ level: 'blue', text: `💾 ${lb ? 'صارلك أكثر من أسبوع بدون نسخة احتياطية.' : 'ما عملت نسخة احتياطية لسا.'} <button class="btn sm" data-act="export" style="display:inline-flex;margin-top:6px">صدّر هلأ</button>` });
  if (!isStandalone()) list.unshift({ level: 'blue', text: '📲 إنت فاتح من المتصفح. البيانات هون منفصلة عن التطبيق المثبّت، افتح دايماً من أيقونة الشاشة الرئيسية. <a href="#" data-act="guide">كيف؟</a>' });
  return list.map(b => `<div class="banner ${b.level}">${b.text}</div>`).join('');
}

const VIEWS = {};
const AFTER = {};

// ----- Quick add -----
VIEWS.add = () => {
  const q = ui.qa;
  const cat = q.cat && L.catById(state, q.cat);
  return `${heroCard()}${bannersHtml()}
  <div class="card" id="qaCard">
    <input id="qaAmount" class="amount-in" type="text" inputmode="decimal" placeholder="0.000" value="${esc(q.amount)}" autocomplete="off" aria-label="المبلغ">
    <div class="cats" id="qaCats">${sortedCats().map(c => `<button type="button" data-act="pickCat" data-id="${c.id}" class="${q.cat === c.id ? 'on' : ''}"><span class="ic">${esc(c.icon || '•')}</span>${esc(c.name)}</button>`).join('')}</div>
    ${cat?.subs?.length ? `<div class="chips">${cat.subs.map(s => `<button type="button" class="chip ${q.sub === s ? 'on' : ''}" data-act="pickSub" data-val="${esc(s)}">${esc(s)}</button>`).join('')}</div>` : ''}
    <label class="field"><span>ملاحظة</span><input id="qaNote" type="text" value="${esc(q.note)}" placeholder="مثلاً groceries"></label>
    <div class="field"><span>دفعت من</span>${fromSeg('qaFrom', q.from)}</div>
    <div class="row"><label class="field"><span>التاريخ</span><input id="qaDate" type="date" value="${q.date}" max="${today()}"></label>
    <label class="field toggle" style="margin-top:28px"><span>رفاهية</span><input id="qaRafah" type="checkbox" ${q.rafah ? 'checked' : ''} ${cat?.kind === 'sadaqa' ? 'disabled' : ''}></label></div>
    <button class="btn pri" data-act="qaSave">سجّل</button>
  </div>
  <details class="card" id="pasteBox" ${ui.parsed ? 'open' : ''}>
    <summary>📋 الصق ملاحظة اليوم</summary>
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

function parsedHtml() {
  const p = ui.parsed;
  if (!p) return '';
  if (!p.items.length) return `<div class="banner yellow">ما لقيت بنود. الصيغة: <span class="amt">20jd groceries</span></div>`;
  return `${p.warnings.map(w => `<div class="banner yellow">⚠️ ${esc(w)}</div>`).join('')}
  <label class="field"><span>التاريخ ${p.dateFound ? '' : '(ما لقيت تاريخ، حطيت اليوم)'}</span><input id="pDate" type="date" value="${p.date}"></label>
  <div class="field"><span>دفعت من (للكل)</span>${fromSeg('pFrom', p.from || 'cash')}</div>
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

async function addEntry({ amount, cat, sub = '', note = '', from = 'cash', date = today(), rafah }) {
  const c = L.catById(state, cat);
  const e = { id: uid(), ts: Date.now(), date, amount, cat, sub, note: note.trim(), from, rafah: c?.kind === 'sadaqa' ? false : (rafah ?? !!c?.rafah) };
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
  return `<div class="navdate"><button class="iconbtn" data-act="dayShift" data-n="-1">→</button><input type="date" id="dayPick" value="${d}"><button class="iconbtn" data-act="dayShift" data-n="1">←</button></div>
  <h2>${dayLabel(d)}</h2>
  <div class="card">
    ${list.length ? `<ul class="list">${list.map(e => { const c = L.catById(state, e.cat); const v = L.entryVerdict(state, e); return `<li class="item">
      <div class="ic">${esc(c?.icon || '•')}</div>
      <div class="main"><div class="t">${esc(e.note || c?.name || '')}</div><div class="s">${esc(c?.name || 'محذوفة')}${e.sub ? ' · ' + esc(e.sub) : ''} · ${L.ACCOUNTS[e.from]}${e.rafah ? ' · <span class="pill warn">رفاهية</span>' : ''}</div><div class="s">${v.icon} ${esc(v.text)}</div></div>
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
    <label class="field"><span>دفعت من</span><select id="eFrom">${accOptions(e.from)}</select></label>
    <label class="field"><span>التاريخ</span><input id="eDate" type="date" value="${e.date}"></label>
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
VIEWS.month = () => {
  const ym = ui.monthYm, prev = addMonths(ym, -1);
  const ms = L.monthStats(state, ym), pm = L.monthStats(state, prev);
  const r = L.rafahStatus(state, ym);
  const diff = ms.total - pm.total;
  const max = Math.max(1, ...Object.values(ms.byCat));
  const rows = Object.entries(ms.byCat).sort((a, b) => b[1] - a[1]);
  return `<div class="navdate"><button class="iconbtn" data-act="monShift" data-n="-1">→</button><input type="month" id="monPick" value="${ym}"><button class="iconbtn" data-act="monShift" data-n="1">←</button></div>
  <div class="card hero"><div class="lbl">${monthLabel(ym)}</div><div class="big amt" id="monTotal">${jd(ms.total)}</div>
    <div class="minirow"><span>الشهر اللي قبله <b class="amt">${jd(pm.total)}</b></span><span class="${!pm.total ? '' : diff > 0 ? 'bad' : 'good'}">${pm.total ? `${diff > 0 ? '▲' : '▼'} <span class="amt">${jd(Math.abs(diff))}</span> (${Math.round(Math.abs(diff) / pm.total * 100)}%)` : 'ما في مقارنة'}</span></div></div>
  <div class="card"><div class="catbar"><div class="hd"><span>🎉 الرفاهية</span><span class="amt">${jdShort(r.used)}/${jdShort(r.budget)}</span></div>
    <div class="bar ${r.level}" id="rafahBar"><i style="width:${Math.min(100, r.pct * 100).toFixed(1)}%"></i></div>
    <div class="sub">${r.left >= 0 ? `ضايل ${jd(r.left)}` : `متعدّي بـ ${jd(-r.left)}`}</div></div></div>
  <div class="card"><h2 style="margin-top:0">حسب التصنيف</h2>
    ${rows.length ? rows.map(([id, v]) => { const c = L.catById(state, id); const pv = pm.byCat[id] || 0; return `<div class="catbar"><div class="hd"><span>${esc(c?.icon || '')} ${esc(c?.name || 'محذوفة')}</span><span class="amt">${jd(v)}</span></div><div class="bar"><i style="width:${(v / max * 100).toFixed(1)}%"></i></div><div class="sub">قبل: <span class="amt">${jd(pv)}</span></div></div>`; }).join('') : '<div class="sub">ما في مصاريف.</div>'}
  </div>
  <button class="btn" data-act="copySummary">📋 انسخ الملخص</button>`;
};
AFTER.month = () => { $('#monPick').addEventListener('change', e => { if (e.target.value) { ui.monthYm = e.target.value; render(); } }); };

// ----- Money (accounts / income / obligations / projection / big purchase) -----
const MONEY_SEGS = { acc: 'حسابات', inc: 'دخل', obl: 'التزامات', proj: 'توقّع', big: 'قبل الشرا' };
VIEWS.money = () => `<div class="seg" style="margin-bottom:8px">${Object.entries(MONEY_SEGS).map(([k, v]) => `<button data-act="moneySeg" data-val="${k}" class="${ui.moneySeg === k ? 'on' : ''}">${v}</button>`).join('')}</div>${MONEY[ui.moneySeg]()}`;
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
  <h2>تحويل بين الحسابات</h2>
  <div class="card"><div class="row"><label class="field"><span>من</span><select id="tFrom">${accOptions('savings')}</select></label><label class="field"><span>إلى</span><select id="tTo">${accOptions('card')}</select></label></div>
    <div class="row"><label class="field"><span>المبلغ</span><input id="tAmt" type="text" inputmode="decimal" class="amt" placeholder="0.000"></label><label class="field"><span>ملاحظة</span><input id="tNote" type="text"></label></div>
    <button class="btn pri" data-act="addTransfer">حوّل</button>
    <div class="sub" style="margin-top:6px">سداد البطاقة تحويل، مش مصروف. مصاريف البطاقة انحسبت وقت الشرا.</div>
    ${tr.length ? `<ul class="list" style="margin-top:8px">${tr.map(t => `<li class="item"><div class="ic">🔁</div><div class="main"><div class="t">${L.ACCOUNTS[t.from]} ← ${L.ACCOUNTS[t.to]}</div><div class="s">${fd(t.date)}${t.note ? ' · ' + esc(t.note) : ''}</div></div><div class="v amt">${jd(t.amount)}</div><div class="acts"><button data-act="delTransfer" data-id="${t.id}">🗑️</button></div></li>`).join('')}</ul>` : ''}
  </div>`;
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
  return `<div class="card"><label class="field"><span>لحد تاريخ</span><input id="projDate" type="date" value="${X}" min="${today()}"></label>
    <div class="grid2"><div class="card hero" style="margin:0"><div class="lbl">أسوأ حالة</div><div class="big amt ${p.worst < 0 ? 'neg' : ''}" id="projWorst" style="font-size:1.5rem">${jd(p.worst)}</div><div class="sub">بس الدخل الأكيد</div></div>
    <div class="card hero" style="margin:0"><div class="lbl">أحسن حالة</div><div class="big amt ${p.best < 0 ? 'neg' : ''}" id="projBest" style="font-size:1.5rem">${jd(p.best)}</div><div class="sub">كل الدخل المتوقع</div></div></div></div>
  <div class="card"><h2 style="margin-top:0">التفصيل (${p.days} يوم)</h2>
    <div class="kv"><span>السيولة هلأ</span><span class="amt">${jd(p.liquidity)}</span></div>
    <div class="kv"><span>+ دخل أكيد قبل التاريخ</span><span class="amt good">${jd(p.sureInc)}</span></div>
    <div class="kv"><span>+ دخل مش أكيد</span><span class="amt">${jd(p.allInc - p.sureInc)}</span></div>
    ${p.incomes.map(i => `<div class="kv sub"><span>· ${esc(i.source)} ${fd(i.date)}${i.sure ? '' : ' (مش أكيد)'}</span><span class="amt">${jd(i.amount)}</span></div>`).join('')}
    <div class="kv"><span>− التزامات مستحقة قبل التاريخ</span><span class="amt bad">${jd(p.oblTotal)}</span></div>
    ${p.obligations.map(o => `<div class="kv sub"><span>· ${esc(o.title)} ${fd(o.date)}</span><span class="amt">${jd(o.amount)}</span></div>`).join('')}
    <div class="kv"><span>− مصروف متوقع (${jd(p.spendAvg)}/شهر × ${p.months.toFixed(2)})</span><span class="amt bad">${jd(p.spendTotal)}</span></div>
    <div class="sub">${esc(p.spendBasis)}</div>
    ${p.noDate.length ? `<div class="sub" style="margin-top:8px">مش محسوبة (بدون تاريخ): ${p.noDate.map(o => `${esc(o.title)} ${jd(o.amount)}`).join('، ')}</div>` : ''}
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
  <div class="row" style="margin-bottom:8px"><div class="sub">هالشهر: <span class="amt" id="costMonth">${fmtUsd(cost)}</span> من <span class="amt">${fmtUsd(cap)}</span> · ${esc(C.currentModel(state))}</div><button class="btn sm ghost" data-act="clearChat" style="flex:none">🧹 امسح</button></div>
  <div class="chat" id="chat">${state.chat.length ? state.chat.map(msgHtml).join('') : '<div class="sub" style="text-align:center;padding:20px">اسأل عن أي مصروف، ابعت مصاريف اليوم، أو صورة فاتورة.</div>'}${ui.sending ? '<div class="msg assistant" id="typing">… بفكّر</div>' : ''}</div>
  <div class="composer">
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
  return `<div class="msg ${m.role}">${m.thumb ? `<img src="${m.thumb}" alt="">` : ''}${esc(m.text)}${logs ? `<div>${logs}</div>` : ''}${m.cost != null ? `<div class="meta">${fmtUsd(m.cost)} · ${esc(m.model || '')}</div>` : ''}</div>`;
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
  const userMsg = { id: uid(), ts: Date.now(), role: 'user', text: text || '(صورة)', thumb: img?.thumb || null };
  await saveRec('chat', userMsg);
  ui.pendingImg = null; ui.chatDraft = ''; ui.sending = true;
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
  const model = C.currentModel(state);
  try {
    const r = await C.callClaude(key, model, C.SYSTEM_PROMPT, messages);
    const cost = C.costOf(state, model, r.usage);
    const { clean, logs } = C.extractLogs(r.text);
    await saveRec('chat', { id: uid(), ts: Date.now(), role: 'assistant', text: clean || '…', logs, cost, model, usage: r.usage });
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

// ----- Settings -----
VIEWS.settings = () => {
  const s = settings();
  const cats = [...state.kv.categories].sort((a, b) => a.order - b.order);
  const priceRows = Object.entries(s.prices).map(([m, [i, o]]) => `<div class="row" data-model="${esc(m)}"><span class="sub amt" style="flex:1.4">${esc(m)}</span><input type="text" inputmode="decimal" class="prIn amt" value="${i}"><input type="text" inputmode="decimal" class="prOut amt" value="${o}"></div>`).join('');
  return `<h2>🔑 Claude</h2><div class="card">
    <label class="field"><span>مفتاح API ${state.kv.apiKey ? '<span class="pill good">محفوظ</span>' : ''}</span><input id="apiKey" type="password" autocomplete="off" placeholder="${state.kv.apiKey ? '•••••• (محفوظ)' : 'sk-ant-...'}"></label>
    <div class="btns"><button class="btn" data-act="saveKey">احفظ المفتاح</button>${state.kv.apiKey ? '<button class="btn danger" data-act="delKey">امسح المفتاح</button>' : ''}</div>
    <div class="sub">المفتاح بضل بهالتلفون بس (IndexedDB)، وما بنحط بالكود ولا بالنسخة الاحتياطية إلا إذا اخترت.</div>
    <label class="field"><span>الموديل</span><select id="model">${C.MODELS.map(m => `<option ${m === s.model ? 'selected' : ''}>${m}</option>`).join('')}</select></label>
    <label class="field"><span>أو اكتب موديل (اختياري)</span><input id="customModel" type="text" dir="ltr" value="${esc(s.customModel)}" placeholder="claude-..."></label>
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

  <h2>💾 نسخة احتياطية</h2><div class="card">
    <div class="sub">آخر نسخة: ${state.kv.lastBackup ? new Date(state.kv.lastBackup).toLocaleString('ar-JO') : 'ولا مرة'}</div>
    <label class="toggle"><span>ضمّن مفتاح API بالملف</span><input id="incKey" type="checkbox"></label>
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
  $('#importIn').addEventListener('change', e => { const f = e.target.files?.[0]; if (f) importFile(f); e.target.value = ''; });
  $('#sortByUse').addEventListener('change', async e => { settings().sortByUse = e.target.checked; await saveSettings(); toast('انحفظ ✓'); });
  navigator.storage?.persisted?.().then(p => { ui.persisted = p; const el = $('#persistState'); if (el) el.innerHTML = p ? '<span class="good">مفعّل ✓</span>' : '<span class="warn">مش مضمون</span>'; }).catch(() => {});
};

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
  const kv = { ...state.kv };
  if (!includeKey) delete kv.apiKey;
  const data = { app: 'masroofi', version: 1, exportedAt: new Date().toISOString(), entries: state.entries, transfers: state.transfers, incomes: state.incomes, obligations: state.obligations, chat: state.chat, kv };
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
  if (!confirm(`رح أستبدل كل البيانات الحالية بالنسخة (${n} مصروف، ${(data.incomes || []).length} دخل، ${(data.obligations || []).length} التزام) من ${String(data.exportedAt || '').slice(0, 10)}. متأكد؟`)) return;
  await db.replaceAll({ ...data, __keepKey: true });
  await load();
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
  go: el => go(el.dataset.v),
  seg: el => {
    const name = el.dataset.name, val = el.dataset.val;
    el.parentElement.querySelectorAll('button').forEach(b => b.classList.toggle('on', b === el));
    if (name === 'qaFrom') ui.qa.from = val;
    if (name === 'pFrom' && ui.parsed) ui.parsed.from = val;
    if (name === 'bigFrom') ui.bigFrom = val;
  },
  pickCat: el => {
    const q = ui.qa; q.cat = el.dataset.id; q.sub = '';
    const c = L.catById(state, q.cat);
    if (!q.rafahTouched || c?.kind === 'sadaqa') q.rafah = c?.kind === 'sadaqa' ? false : !!c?.rafah;
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
    render();
    const v = L.entryVerdict(state, e);
    toast(`${v.icon} ${iso(jd(amount))} · ${v.text}`, 'تراجع', async () => { await delRec('entries', e.id); render(); });
  },
  parse: () => {
    ui.noteText = $('#noteText').value;
    const p = L.parseNote(ui.noteText, state.kv.categories);
    p.from = 'cash';
    ui.parsed = p;
    $('#parsed').innerHTML = parsedHtml();
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
      <label class="field"><span>${isCard ? 'المطلوب منك هلأ (الرصيد المستحق الحقيقي)' : 'الرصيد الحقيقي هلأ'}</span><input id="bVal" type="text" inputmode="decimal" class="amount-in" value="${jd(b[acc])}"></label>
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
    s.model = $('#model').value; s.customModel = $('#customModel').value.trim(); s.notes = $('#notes').value;
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
    <label class="field"><span>التاريخ المتوقع</span><input id="iDate" type="date" value="${i.date}"></label>
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
    <label class="field"><span>تاريخ الاستحقاق (اختياري)</span><input id="oDue" type="date" value="${x.due || ''}"></label>
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
document.addEventListener('keydown', e => {
  if (e.key === 'Enter' && e.target.id === 'qaAmount') { e.preventDefault(); $('#qaNote')?.focus(); }
  if (e.key === 'Enter' && e.target.id === 'chatIn' && !e.shiftKey && matchMedia('(pointer:fine)').matches) { e.preventDefault(); sendChat(e.target.value); }
});

// ---------------- Boot ----------------
async function boot() {
  try { await load(); }
  catch (err) { $('#view').innerHTML = `<div class="banner red">ما قدرت أفتح التخزين: ${esc(err.message || err)}</div>`; return; }
  if (state.kv.pinHash) await lockScreen();
  render();
  if (!isStandalone() && !state.kv.guideDismissed) showGuide();
  try { if (navigator.storage?.persist) ui.persisted = (await navigator.storage.persisted()) || (await navigator.storage.persist()); } catch {}
  if ('serviceWorker' in navigator) {
    const hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.register('sw.js').then(reg => reg.update?.()).catch(() => {});
    let reloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => { if (hadController && !reloaded) { reloaded = true; location.reload(); } });
  }
}
window.__masroofi = { state, ui, L, C, render, go, sendChat }; // debugging/tests
boot();
