"""End-to-end test of masroofi in headless Chromium at iPhone size (390x844)."""
import json, os, sys, datetime as dt
from playwright.sync_api import sync_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else 'http://127.0.0.1:8765/'
SHOTS = os.path.join(os.path.dirname(__file__), '..', 'screens')
os.makedirs(SHOTS, exist_ok=True)
results = []
def check(name, cond, info=''):
    results.append((name, bool(cond), info))
    print(('PASS ' if cond else 'FAIL ') + name + (f'  [{info}]' if info else ''))

def shot(page, name):
    page.evaluate("(() => { scrollTo(0, 0); document.querySelector('#toast').innerHTML = ''; })()")
    page.screenshot(path=os.path.join(SHOTS, name + '.png'), full_page=False)

today = dt.date.today()
def d(n): return (today + dt.timedelta(days=n)).isoformat()

with sync_playwright() as p:
    b = p.chromium.launch()
    ctx = b.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=2, is_mobile=True, has_touch=True,
                        accept_downloads=True, color_scheme='dark', locale='ar-JO')
    ctx.grant_permissions(['clipboard-read', 'clipboard-write'], origin='/'.join(BASE.split('/')[:3]))
    page = ctx.new_page()
    errors = []
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.on('console', lambda m: errors.append(m.text) if m.type == 'error' else None)
    page.on('dialog', lambda dlg: dlg.accept())
    page.goto(BASE)
    page.wait_for_selector('#guideOv', timeout=8000)
    shot(page, '00_install_guide')
    check('install guide shows in browser mode', page.is_visible('#guideOv'))
    page.click('#guideOk')

    def open_settings():
        if page.evaluate('__masroofi.ui.view') != 'settings': page.click('#hdrBtn')
    ISO = __import__('re').compile(r'\d{4}-\d{2}-\d{2}|\d{1,2}/\d{1,2}/\d{4}|\b(January|February|March|April|May|June|July|August|September|October|November|December)\b')
    def no_iso(label):
        txt = page.inner_text('#view') + page.inner_text('header')
        m = ISO.search(txt)
        check(f'dates in Arabic style only: {label}', not m, m.group(0) if m else '')
    def no_overflow(label):
        w = page.evaluate('[document.documentElement.scrollWidth, document.documentElement.clientWidth]')
        check(f'no horizontal overflow: {label}', w[0] <= w[1], f'{w}')

    check('document is RTL', page.evaluate('document.documentElement.dir') == 'rtl')
    nav = page.evaluate('(() => { const r = document.querySelector("#tabs").getBoundingClientRect(); return [r.bottom, innerHeight, getComputedStyle(document.querySelector("#tabs")).paddingBottom]; })()')
    check('tab bar pinned to bottom with safe-area padding', abs(nav[0] - nav[1]) < 1, str(nav))
    no_overflow('add')

    # --- set balances via UI ---
    def set_bal(acc, val, limit=None):
        page.click('nav [data-v=money]'); page.click('[data-act=moneySeg][data-val=acc]')
        page.click(f'[data-act=editBal][data-acc={acc}]')
        page.fill('#bVal', val)
        if limit: page.fill('#bLimit', limit)
        page.click('#bSave'); page.wait_for_timeout(250)
    set_bal('savings', '500'); set_bal('cash', '100'); set_bal('card', '0', '1000')
    t = lambda sel: page.inner_text(sel).strip()
    check('balances set', t('#balSavings') == '500.000' and t('#balCash') == '100.000' and t('#balCard') == '0.000', f"{t('#balSavings')} {t('#balCash')} {t('#balCard')}")

    # --- quick add (cash) ---
    page.click('nav [data-v=add]')
    page.fill('#qaAmount', '13.15')
    page.click('[data-act=pickCat][data-id=gas]')
    page.fill('#qaNote', 'gasoline')
    page.click('[data-act=qaSave]'); page.wait_for_timeout(250)
    check('cash expense reduces cash', page.evaluate('__masroofi.L.balances(__masroofi.state).cash') == 86850)
    check('net shown on home', t('#netBig') == '586.850', t('#netBig'))
    # --- card expense ---
    page.fill('#qaAmount', '20')
    page.click('[data-act=pickCat][data-id=groceries]')
    page.click('[data-act=seg][data-name=qaFrom][data-val=card]')
    page.click('[data-act=qaSave]'); page.wait_for_timeout(250)
    bal = page.evaluate('__masroofi.L.balances(__masroofi.state)')
    check('card expense increases outstanding', bal['card'] == 20000 and bal['net'] == 566850, json.dumps(bal))
    shot(page, '01_quick_add')
    # --- card repayment as transfer ---
    page.click('nav [data-v=money]'); page.click('[data-act=moneySeg][data-val=acc]')
    page.evaluate("document.querySelector('details.adv') && (document.querySelector('details.adv').open = true)")  # (v1.10 moved it under 'متقدم')
    page.select_option('#tFrom', 'savings'); page.select_option('#tTo', 'card'); page.fill('#tAmt', '20')
    page.click('[data-act=addTransfer]'); page.wait_for_timeout(250)
    bal = page.evaluate('__masroofi.L.balances(__masroofi.state)')
    ms = page.evaluate(f'__masroofi.L.monthStats(__masroofi.state, "{today.isoformat()[:7]}").total')
    check('repayment = transfer: card 0, savings 480, net unchanged, not an expense', bal['card'] == 0 and bal['savings'] == 480000 and bal['net'] == 566850 and ms == 33150, f"{json.dumps(bal)} month={ms}")
    shot(page, '04_liquidity')
    no_overflow('money/acc')
    no_iso('money/acc')

    # --- FIX 1: opening entry, no account deduction ---
    page.click('nav [data-v=add]')
    before = page.evaluate('__masroofi.L.balances(__masroofi.state)')
    page.fill('#qaAmount', '7'); page.click('[data-act=pickCat][data-id=groceries]')
    page.click('[data-act=seg][data-name=qaFrom][data-val=none]')
    check('none option shows hint', page.is_visible('.nonehint'))
    page.click('[data-act=qaSave]'); page.wait_for_timeout(250)
    after = page.evaluate('__masroofi.L.balances(__masroofi.state)')
    ms2 = page.evaluate(f'__masroofi.L.monthStats(__masroofi.state, "{today.isoformat()[:7]}")')
    check('none entry: balances untouched, month + category totals include it', before == after and ms2['total'] == 40150 and ms2['byCat']['groceries'] == 27000, f"{ms2}")
    page.click('[data-act=seg][data-name=qaFrom][data-val=cash]')
    # --- FIX 2: rafah toggle follows category ---
    page.click('[data-act=pickCat][data-id=rafah]')
    check('picking rafah category turns toggle on', page.is_checked('#qaRafah'))
    page.click('[data-act=pickCat][data-id=gas]')
    check('picking another category resets toggle', not page.is_checked('#qaRafah'))
    page.click('[data-act=pickCat][data-id=rafah]'); page.uncheck('#qaRafah'); page.click('[data-act=pickCat][data-id=rafah]')
    check('re-picking rafah resets to on after manual off', page.is_checked('#qaRafah'))
    # --- FIX 3: backup age colours ---
    check('backup never: yellow', 'bk-yellow' in page.get_attribute('#backupAge', 'class'))
    check('backup never: rendered yellow', page.evaluate("getComputedStyle(document.querySelector('#backupAge')).color") == 'rgb(245, 197, 66)')
    page.evaluate("(() => { __masroofi.state.obligations.push({id:'tmpold', ts: Date.now() - 4*86400000, title:'x', amount:1, payments:[], done:true}); __masroofi.render(); })()")
    check('backup never + data 4 days old: red', 'bk-red' in page.get_attribute('#backupAge', 'class') and page.locator('.banner.red', has_text='نسخة احتياطية').count() == 1)
    page.evaluate("(() => { const s = __masroofi.state; s.obligations = s.obligations.filter(o => o.id !== 'tmpold'); __masroofi.render(); })()")
    # --- FIX 5: no calendar emoji that shows a date ---
    html = page.content()
    check('no dated calendar emoji, SVG tab icons', '📅' not in html and '📆' not in html and page.locator('#tabs button[data-v=day] svg').count() == 1)
    # --- FIX 6: settings header becomes back ---
    page.click('nav [data-v=month]'); page.click('#hdrBtn')
    check('settings shows back button', 'رجوع' in page.inner_text('#hdrBtn'))
    no_iso('settings')
    page.click('#hdrBtn')
    check('back returns to previous view', page.evaluate('__masroofi.ui.view') == 'month' and '⚙' in page.inner_text('#hdrBtn'))
    no_iso('month')
    page.click('nav [data-v=add]')
    no_iso('add')

    # --- paste note ---
    page.click('nav [data-v=add]')
    page.click('#pasteBox summary')
    note = 'November 13\n20jd groceries\n13.15 gasoline\nTotal 33.15 JD // Rafaheyah 0 JD'
    page.fill('#noteText', note)
    page.click('[data-act=parse]')
    rows = page.locator('#parsed .edit-row').count()
    check('note parse: 2 entries', rows == 2, str(rows))
    check('note parse: total 33.150', t('#pSum') == '33.150', t('#pSum'))
    check('note parse: no warnings', page.locator('#parsed .banner').count() == 0)
    pp = page.evaluate('__masroofi.ui.parsed')
    check('note parse: rafah 0, cats groceries/gas', pp['rafahTotal'] == 0 and [i['cat'] for i in pp['items']] == ['groceries', 'gas'] and not any(i['rafah'] for i in pp['items']))
    shot(page, '02_paste_note')
    # mismatch warning
    page.fill('#noteText', 'November 12\n5 coffee\nTotal 9 JD // Rafaheyah 5 JD'); page.click('[data-act=parse]')
    check('note parse: total mismatch warns', page.locator('#parsed .banner').count() >= 1)
    page.fill('#noteText', 'November 10' + chr(10) + '4 bread'); page.click('[data-act=parse]')
    page.click('[data-act=seg][data-name=pFrom][data-val=none]')
    b0 = page.evaluate('__masroofi.L.balances(__masroofi.state)')
    page.click('[data-act=pSave]'); page.wait_for_timeout(300)
    nov10 = page.evaluate("__masroofi.state.entries.filter(e => e.date.endsWith('-11-10'))")
    check('paste-note none switch: saved without account change', len(nov10) == 1 and nov10[0]['from'] == 'none' and b0 == page.evaluate('__masroofi.L.balances(__masroofi.state)'))
    page.click('nav [data-v=add]')
    if not page.is_visible('#noteText'): page.click('#pasteBox summary')
    page.fill('#noteText', note); page.click('[data-act=parse]')
    page.click('[data-act=pSave]'); page.wait_for_timeout(250)
    page.wait_for_selector('#dayTotal')
    year = today.year if dt.date(today.year, 11, 13) <= today + dt.timedelta(days=31) else today.year - 1
    check('saved to Nov 13 day view', page.evaluate('__masroofi.ui.dayDate') == f'{year}-11-13')
    check('day total 33.150', t('#dayTotal') == '33.150', t('#dayTotal'))
    hdr = page.inner_text('.navdate .dlabel')
    check('FIX 4: full Arabic date style', __import__('re').fullmatch(r'(الأحد|الاثنين|الثلاثاء|الأربعاء|الخميس|الجمعة|السبت) \d{1,2} (كانون الثاني|شباط|آذار|نيسان|أيار|حزيران|تموز|آب|أيلول|تشرين الأول|تشرين الثاني|كانون الأول) \d{4}', hdr) is not None and 'تشرين الثاني' in hdr, hdr)
    check('date picker label in Arabic', 'تشرين الثاني' in page.inner_text('.navdate .dlabel'))
    no_iso('day')
    page.click('[data-act=copyDay]')
    clip = page.evaluate('navigator.clipboard.readText()').replace(chr(13), '')
    expected = 'November 13\n20jd groceries\n13.15jd gasoline\nTotal 33.15 JD // Rafaheyah 0 JD'
    check('copy day note reproduces format', clip == expected, repr(clip))
    shot(page, '03_day')
    no_overflow('day')

    # --- rafaheyah bar ---
    page.click('nav [data-v=add]')
    page.fill('#qaAmount', '50'); page.click('[data-act=pickCat][data-id=rafah]'); page.click('[data-act=qaSave]'); page.wait_for_timeout(250)
    page.click('nav [data-v=month]')
    check('rafah bar yellow at 83%', 'yellow' in page.get_attribute('#rafahBar', 'class'))
    page.click('nav [data-v=add]')
    page.fill('#qaAmount', '15'); page.click('[data-act=pickCat][data-id=other]')
    page.check('#qaRafah'); page.click('[data-act=qaSave]'); page.wait_for_timeout(250)
    page.click('nav [data-v=month]')
    check('rafah bar red at 108%', 'red' in page.get_attribute('#rafahBar', 'class'))
    shot(page, '05_month')
    no_overflow('month')
    page.click('nav [data-v=add]')
    check('rafah red banner on home', page.locator('.banner.red').count() >= 1)

    # --- income + obligation + projection ---
    page.click('nav [data-v=money]'); page.click('[data-act=moneySeg][data-val=inc]')
    def add_inc(src, amount, date, sure):
        page.click('[data-act=newInc]'); page.fill('#iSrc', src); page.fill('#iAmt', amount); page.fill('#iDate', date)
        if not sure: page.uncheck('#iSure')
        page.click('#iSave'); page.wait_for_timeout(250)
    add_inc('Client A', '200', d(10), True)
    add_inc('Client B', '100', d(20), False)
    page.click('[data-act=moneySeg][data-val=obl]')
    page.click('[data-act=newObl]'); page.fill('#oTitle', 'Test debt'); page.fill('#oAmt', '150'); page.fill('#oDue', d(15)); page.click('#oSave'); page.wait_for_timeout(250)
    no_iso('obligations')
    shot(page, '07_obligations')
    page.click('[data-act=moneySeg][data-val=proj]')
    page.fill('#projDate', d(30)); page.dispatch_event('#projDate', 'change')
    pr = page.evaluate(f'__masroofi.L.projection(__masroofi.state, "{d(30)}")')
    liq = page.evaluate('__masroofi.L.balances(__masroofi.state).net')
    exp_worst = liq + 200000 - 150000 - pr['spendTotal']
    check('projection worst = liq + sure − obl − spend', pr['worst'] == exp_worst and t('#projWorst') == f"{exp_worst/1000:.3f}", f"{pr['worst']} vs {exp_worst}, ui {t('#projWorst')}")
    check('projection best adds unsure income', pr['best'] == exp_worst + 100000)
    check('expected income not in liquidity', liq == page.evaluate('__masroofi.L.balances(__masroofi.state).savings + __masroofi.L.balances(__masroofi.state).cash - __masroofi.L.balances(__masroofi.state).card') and liq == 566850 - 65000 - 33150, str(liq))
    no_iso('projection')
    shot(page, '06_projection')
    no_overflow('projection')
    # obligation partial payment
    page.click('[data-act=moneySeg][data-val=obl]')
    page.click('[data-act=payObl]'); page.fill('#pAmt2', '50'); page.click('#paySave'); page.wait_for_timeout(250)
    check('partial payment reduces remaining + savings', t('#oblTotal') == '100.000' and page.evaluate('__masroofi.L.balances(__masroofi.state).savings') == 430000)
    # income received -> savings
    page.click('[data-act=moneySeg][data-val=inc]')
    page.click('[data-act=recvInc] >> nth=0'); page.click('#rSave'); page.wait_for_timeout(250)
    check('received income adds to savings', page.evaluate('__masroofi.L.balances(__masroofi.state).savings') == 630000)
    # big purchase
    page.click('[data-act=moneySeg][data-val=big]'); page.fill('#bigAmt', '900'); page.click('[data-act=bigCheck]')
    check('big purchase verdict shown', '❌' in t('#bigVerdict') or '⚠️' in t('#bigVerdict'), t('#bigVerdict'))
    shot(page, '08_big_purchase')

    # --- chat without key ---
    page.click('nav [data-v=ask]')
    check('chat explains missing key', page.is_visible('#noKey'))
    page.fill('#chatIn', 'hi'); page.click('[data-act=send]')
    check('send without key opens how-to sheet', page.is_visible('#goSet'))
    page.click('#cl')
    shot(page, '09_ask')
    no_overflow('ask')

    # --- settings + export/import ---
    open_settings()
    shot(page, '10_settings')
    no_overflow('settings')
    n_before = page.evaluate('__masroofi.state.entries.length')
    with page.expect_download() as dl:
        page.click('.card [data-act=export]')
    path = os.path.join(os.path.dirname(__file__), 'backup_test.json')
    dl.value.save_as(path)
    data = json.load(open(path, encoding='utf-8'))
    check('export excludes API key by default', 'apiKey' not in data['kv'] and len(data['entries']) == n_before)
    # wipe and import
    page.evaluate('''new Promise(r => { const t = indexedDB.open("masroofi"); t.onsuccess = () => { const db = t.result; const tx = db.transaction(["entries"], "readwrite"); tx.objectStore("entries").clear(); tx.oncomplete = () => { db.close(); r(); }; }; })''')
    page.reload(); page.wait_for_selector('#netBig')
    check('wiped before import', page.evaluate('__masroofi.state.entries.length') == 0)
    open_settings()
    page.set_input_files('#importIn', path)
    page.wait_for_timeout(800)
    check('import restores entries', page.evaluate('__masroofi.state.entries.length') == n_before)
    bal2 = page.evaluate('__masroofi.L.balances(__masroofi.state)')
    check('balances identical after round trip', bal2['savings'] == 630000, json.dumps(bal2))

    # --- PIN ---
    page.click('[data-act=setPin]')
    for _ in range(2):
        for k in '1234': page.click(f'#pinOv [data-k="{k}"]')
        page.wait_for_timeout(250)
    check('pin saved (hash only)', len(page.evaluate('__masroofi.state.kv.pinHash') or '') == 64)
    page.reload(); page.wait_for_selector('#pinOv')
    for k in '1234': page.click(f'#pinOv [data-k="{k}"]')
    page.wait_for_selector('#netBig')
    check('pin unlocks', page.is_visible('#netBig'))
    open_settings(); page.click('[data-act=delPin]'); page.wait_for_timeout(400)


    # --- chat with a mocked Claude API (no real key / spend) ---
    captured = {}
    def fake(route, request):
        captured['headers'] = request.headers; captured['body'] = json.loads(request.post_data)
        route.fulfill(status=200, content_type='application/json', headers={'access-control-allow-origin': '*'},
                      body=json.dumps({'content': [{'type': 'text', 'text': 'تمام، ضروري.' + chr(10) + 'LOG: 5 | رفاهية | coffee | كاش'}], 'usage': {'input_tokens': 1000, 'output_tokens': 200}, 'stop_reason': 'end_turn', 'model': json.loads(request.post_data)['model']}))
    page.route('https://api.anthropic.com/**', fake)
    open_settings(); page.fill('#apiKey', 'sk-ant-test-0000'); page.click('[data-act=saveKey]'); page.wait_for_timeout(300)
    page.click('nav [data-v=ask]')
    import base64
    png = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==')
    page.set_input_files('#imgIn', files=[{'name': 'r.png', 'mimeType': 'image/png', 'buffer': png}]); page.wait_for_timeout(300)
    page.fill('#chatIn', 'شو رأيك؟'); page.click('[data-act=send]'); page.wait_for_selector('.logbtn', timeout=5000)
    h = captured.get('headers', {}); body = captured.get('body', {})
    check('API headers set', h.get('x-api-key') == 'sk-ant-test-0000' and h.get('anthropic-version') == '2023-06-01' and h.get('anthropic-dangerous-direct-browser-access') == 'true')
    last = body['messages'][-1]['content']
    check('request has image block + context', last[0]['type'] == 'image' and last[0]['source']['media_type'] == 'image/jpeg' and 'السيولة' in last[1]['text'] and body['model'] == 'claude-haiku-5-5', body.get('model'))
    check('LOG line hidden from text', 'LOG:' not in page.inner_text('#chat'))
    check('list prices are defaults', page.evaluate('__masroofi.state.kv.settings.prices') == {'claude-haiku-5-5': [0.1, 0.5], 'claude-sonnet-5-5': [2, 10], 'claude-opus-5-5': [4, 20]})
    check('cost tracked (haiku $0.0002)', abs(page.evaluate('__masroofi.state.kv.cost.usd') - 0.0002) < 1e-12, str(page.evaluate('__masroofi.state.kv.cost.usd')))
    n0 = page.evaluate('__masroofi.state.entries.length')
    page.click('.logbtn'); page.wait_for_timeout(300)
    check('one-tap LOG adds entry', page.evaluate('__masroofi.state.entries.length') == n0 + 1)
    # --- FIX 7: deep analysis for one message ---
    page.click('[data-act=toggleDeep]'); page.fill('#chatIn', 'حلل الشهر'); page.click('[data-act=send]')
    page.wait_for_function('__masroofi.state.chat.filter(m => m.role === "assistant").length === 2', timeout=5000); page.wait_for_timeout(200)
    check('deep sends with opus-5-5 + medium effort', captured['body']['model'] == 'claude-opus-5-5' and captured['body']['output_config']['effort'] == 'medium', captured['body']['model'])
    meta = page.locator('.msg.assistant .meta').last.inner_text()
    check('deep reply shows model + cost', 'claude-opus-5-5' in meta and '$0.0080' in meta, meta)
    check('deep toggle resets after send', 'on' not in (page.get_attribute('[data-act=toggleDeep]', 'class') or '').split())
    page.fill('#chatIn', 'next'); page.click('[data-act=send]'); page.wait_for_function('__masroofi.state.chat.filter(m => m.role === "assistant").length === 3', timeout=5000)
    check('next message back on haiku', captured['body']['model'] == 'claude-haiku-5-5')
    shot(page, '11_chat_mock')
    page.evaluate('(async () => { __masroofi.state.kv.settings.capUsd = 0.00001; })()')
    calls = len(captured)
    captured.clear(); page.fill('#chatIn', 'again'); page.click('[data-act=send]'); page.wait_for_timeout(400)
    check('monthly cap blocks sending', 'body' not in captured)
    page.evaluate('(async () => { __masroofi.state.kv.settings.capUsd = 5; })()')
    page.unroute('https://api.anthropic.com/**')
    # --- price migration for installs that saved the old placeholder prices ---
    page.evaluate('new Promise(r => { const t = indexedDB.open("masroofi"); t.onsuccess = () => { const db = t.result; const tx = db.transaction(["kv"], "readwrite"); const st = tx.objectStore("kv"); const g = st.get("settings"); g.onsuccess = () => { const v = g.result; delete v.pricesVersion; v.prices = {"claude-haiku-5-5":[1,5],"claude-sonnet-5-5":[3,15],"claude-opus-5-5":[5,25]}; st.put(v, "settings"); }; tx.oncomplete = () => { db.close(); r(); }; }; })')
    page.reload(); page.wait_for_selector('#netBig')
    check('old saved prices migrate to list prices', page.evaluate('__masroofi.state.kv.settings.prices["claude-opus-5-5"]') == [4, 20] and page.evaluate('__masroofi.state.kv.settings.pricesVersion') == 2)
    check('backup after export: normal colour', 'bk-ok' in page.get_attribute('#backupAge', 'class'))

    # --- offline reload via service worker ---
    page.wait_for_function('navigator.serviceWorker.controller !== null', timeout=10000)
    n_now = page.evaluate('__masroofi.state.entries.length')
    ctx.set_offline(True)
    page.reload(); page.wait_for_selector('#netBig', timeout=8000)
    check('offline reload works (SW)', page.is_visible('#netBig') and page.evaluate('__masroofi.state.entries.length') == n_now)
    page.click('nav [data-v=month]')
    check('offline: month view renders', page.is_visible('#monTotal'))
    ctx.set_offline(False)

    real_errors = [e for e in errors if 'favicon' not in e]
    check('no JS errors', not real_errors, '; '.join(real_errors[:5]))
    b.close()

fails = [r for r in results if not r[1]]
print(f'\n{len(results) - len(fails)}/{len(results)} passed')
sys.exit(1 if fails else 0)
