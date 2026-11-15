// Claude API (user's own key, called straight from the phone). No key = the app still works.
import { jd, today, monthLabel, ymd, parseYmd, dayLabel, dateShort } from './util.js';
import { monthStats, rafahStatus, balances, obligationsUntil, cardCycle, catName, S, ACCOUNTS, goalsOf, goalPlan, safeToSpend } from './logic.js';

export const MODELS = ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5'];
export const DEEP_MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5'];
// $ per million tokens (input, output) — current list prices, editable in settings
export const DEFAULT_PRICES = { 'claude-haiku-5-5': [0.1, 0.5], 'claude-sonnet-5-5': [2, 10], 'claude-opus-5-5': [4, 20] };
export const OLD_DEFAULT_PRICES = { 'claude-haiku-5-5': [1, 5], 'claude-sonnet-5-5': [3, 15], 'claude-opus-5-5': [5, 25] };

export const SYSTEM_PROMPT = `إنت مستشار مصاريف شخصي لصاحب هالتطبيق بالأردن، بتحكي أردني.

قواعده (ثابتة):
- ميزانية الرفاهية 60 دينار بالشهر (أو الرقم اللي بالسياق).
- مش رفاهية: أدوات الشغل والاشتراكات، الجيم (بينحسب صحة)، الصدقة (ما بتنحكم أبداً)، الفواتير، مصاريف المزرعة، العلاج والدوا.
- الدخل المتوقع ما بينحسب إلا لما يوصل فعلاً. قيمة الأصول (سيارة، أرض...) مش سيولة.
- هو ما بحب يستدين. قبل أي شرية كبيرة شيّك الالتزامات وموعد البطاقة.
- الخصم مش سبب تشتري هلأ.
- سداد البطاقة تحويل من التوفير مش مصروف، ومصاريف البطاقة انحسبت وقت الشرا.

أسلوبك:
- صارم بس منصف. المصروف الضروري: "تمام" وكمّل، بلا محاضرات.
- عربي أردني قصير، كإنك صاحبه، رأي حقيقي مش كلام عام.
- الحكم بهالشكل: ✅ ضروري / تمام، ⚠️ مقبول بس انتبه (سطر ليش)، ❌ مش وقته (سطر ليش).
- لما يبعتلك مصاريف يوم، رد بهالترتيب: البنود → مجموع اليوم → مجموع الشهر → الرفاهية X/60 (ضايل Y) → السيولة → الحكم بسطر أو سطرين.
- الأرقام بالدينار بثلاث خانات عشرية (13.150).
- إذا بدك تقترح يسجّل مصروف، حط بآخر سطر لحاله بالضبط:
LOG: المبلغ | التصنيف | ملاحظة | كاش أو بطاقة أو توفير
(سطر LOG لكل مصروف، وبس إذا في مصروف فعلاً لازم ينسجل. التصنيف من أسماء التصنيفات بالسياق.)`;

export function buildContext(state, ref = today()) {
  const ym = ref.slice(0, 7);
  const ms = monthStats(state, ym);
  const r = rafahStatus(state, ym);
  const b = balances(state);
  const cc = cardCycle(state, ref);
  const in60 = ymd(new Date(parseYmd(ref).getTime() + 60 * 86400000));
  const obl = obligationsUntil(state, in60);
  const inc = state.incomes.filter(i => i.status === 'expected').sort((a, z) => a.date.localeCompare(z.date));
  const cats = Object.entries(ms.byCat).sort((a, z) => z[1] - a[1]).map(([c, v]) => `${catName(state, c)} ${jd(v)}`).join('، ') || 'ولا شي';
  const todays = state.entries.filter(e => e.date === ref).map(e => `${jd(e.amount)} ${catName(state, e.cat)}${e.note ? ` (${e.note})` : ''}${e.rafah ? ' [رفاهية]' : ''} من ${ACCOUNTS[e.from]}`).join('، ');
  const lines = [
    `[سياق تلقائي: ${dayLabel(ref)}]`,
    `الشهر (${monthLabel(ym)}): المجموع ${jd(ms.total)}. حسب التصنيف: ${cats}.`,
    `مصاريف اليوم: ${todays || 'ولا شي لسا'}.`,
    `الرفاهية: ${jd(r.used)}/${jd(r.budget)} (ضايل ${jd(r.left)}).`,
    `السيولة: توفير ${jd(b.savings)} + كاش ${jd(b.cash)} − البطاقة ${jd(b.card)} = ${jd(b.net)}. البطاقة: مستحق ${jd(cc.dueAmount)} يوم ${dateShort(cc.dueDate)}${b.cardLimit ? `، المتاح ${jd(b.cardAvail)}` : ''}.`,
    `التزامات خلال 60 يوم: ${obl.list.map(o => `${o.title} ${jd(o.amount)} (${dateShort(o.date)})`).join('، ') || 'ولا شي'}${obl.noDate.length ? `. بدون تاريخ: ${obl.noDate.map(o => `${o.title} ${jd(o.amount)}`).join('، ')}` : ''}.`,
    `دخل متوقع (مش محسوب بالسيولة لحد ما يوصل): ${inc.map(i => `${i.source} ${jd(i.amount)} ${dateShort(i.date)}${i.sure ? ' أكيد' : ' مش أكيد'}`).join('، ') || 'ولا شي'}.`,
    `إلي عند الناس (مش محسوب بالسيولة): ${(state.receivables || []).filter(r => !r.done).map(r => `${r.who} ${r.amount > 0 ? jd(r.amount) : (r.amountText || 'بدون رقم')}${r.due ? ' ' + dateShort(r.due) : r.expected ? ' ' + r.expected : ''}${r.sure ? ' أكيد' : ' مش أكيد'}`).join('، ') || 'ولا شي'}.`,
    `التصنيفات: ${state.kv.categories.map(c => c.name).join('، ')}.`,

  ];
  // (v1.8) savings goals + the safe-to-spend number, so Claude's advice matches what the home screen says
  const goals = goalsOf(state);
  if (goals.length) lines.push(`أهداف التوفير: ${goals.map(g => { const p = goalPlan(state, g, ref); return `${g.name} ${jd(p.saved)}/${jd(g.target)}${g.deadline ? ` لحد ${dateShort(g.deadline)}` : ''}${p.perMonth ? `، لازم ${jd(p.perMonth)} بالشهر` : ''}`; }).join('، ')}.`);
  const sf = safeToSpend(state, ref);
  if (sf.ok) lines.push(`الضايل الآمن لليوم: ${jd(Math.max(0, sf.today))} (لآخر الشهر ${jd(sf.left)}، ${sf.daysLeft} يوم).`);
  const notes = S(state).notes?.trim();
  if (notes) lines.push(`ملاحظات عني: ${notes}`);
  return lines.join('\n');
}

/** Pull "LOG: amount | category | note | from" lines out of a reply. */
export function extractLogs(text) {
  const logs = [];
  const clean = String(text || '').split('\n').filter(line => {
    const m = line.trim().replace(/^[`*]+|[`*]+$/g, '').match(/^LOG:\s*([\d.,٠-٩]+)\s*(?:jd|JD|دينار)?\s*\|\s*([^|]*?)\s*(?:\|\s*([^|]*?)\s*)?(?:\|\s*([^|]*?)\s*)?$/);
    if (m) { logs.push({ amount: m[1], cat: m[2] || '', note: m[3] || '', from: m[4] || '' }); return false; }
    return true;
  }).join('\n').trim();
  return { clean, logs };
}

export function priceFor(state, model) {
  const p = S(state).prices || {};
  return p[model] || DEFAULT_PRICES[model] || p['claude-sonnet-5-5'] || [3, 15];
}

export function costOf(state, model, usage) {
  const [pi, po] = priceFor(state, model);
  const inTok = (usage?.input_tokens || 0) + (usage?.cache_creation_input_tokens || 0) + (usage?.cache_read_input_tokens || 0);
  return (inTok * pi + (usage?.output_tokens || 0) * po) / 1e6;
}

export function currentModel(state) {
  const s = S(state);
  return (s.customModel || '').trim() || s.model || MODELS[0];
}

/** messages: [{role, content}] already trimmed. Returns {text, usage, model}. */
export async function callClaude(apiKey, model, system, messages, deep = false) {
  const body = { model, max_tokens: deep ? 2048 : 1024, system, messages };
  if (MODELS.includes(model)) body.output_config = { effort: deep ? 'medium' : 'low' }; // short chat replies keep cost down; deep = think more
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify(body),
  });
  let data;
  try { data = await res.json(); } catch { data = null; }
  if (!res.ok) {
    const msg = data?.error?.message || res.statusText;
    const hint = res.status === 401 ? 'المفتاح غلط أو منتهي.' : res.status === 429 ? 'ضغط أو وصلت حد الصرف بالكونسول.' : res.status === 400 && /credit|balance/i.test(msg) ? 'الرصيد بحساب API خلص.' : '';
    throw new Error(`${res.status}: ${hint} ${msg}`.trim());
  }
  let text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
  if (data.stop_reason === 'refusal') text = text || 'ما قدرت أرد على هالطلب.';
  if (data.stop_reason === 'max_tokens') text += '\n…(الرد انقطع)';
  return { text, usage: data.usage, model: data.model || model };
}

/** Resize an image File to max 1024px JPEG; returns {b64, thumb}. */
export async function resizeImage(file, max = 1024) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
    const draw = (m, q) => {
      const s = Math.min(1, m / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * s); c.height = Math.round(img.height * s);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      return c.toDataURL('image/jpeg', q);
    };
    return { b64: draw(max, 0.82).split(',')[1], thumb: draw(240, 0.7) };
  } finally { URL.revokeObjectURL(url); }
}
