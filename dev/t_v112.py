"""v1.12 test (2026-11-23, Ahmad: tap a category on the month tab, e.g. البيت 525, and see exactly what went on it): the category
drill-down sheet. Seeds entries in 2 categories on different days (+ one last month), opens the month tab, taps a category and
checks the sheet lists exactly those entries grouped by day (newest first) and adds up to the row's total; edit + back + close;
a previous month shows only its own entries. v1.12.1 (Ahmad: "ميز التواريخ بالوان"): each day group has its own colour,
shared by its header stripe, day name, rows and day-number chips. Headless Chromium at iPhone size. Run with the dev server on 8765."""
import os, sys, re
from datetime import date
from playwright.sync_api import sync_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else 'http://127.0.0.1:8765/'
SHOTS = os.path.join(os.path.dirname(__file__), '..', 'screens')
results = []
def check(name, cond, info=''):
    results.append(bool(cond))
    print(('PASS ' if cond else 'FAIL ') + name + (f'  [{info}]' if info else ''))

t = date.today()
ym = t.strftime('%Y-%m')
pm = f'{t.year - 1}-12' if t.month == 1 else f'{t.year}-{t.month - 1:02d}'
d = lambda n: f'{ym}-{n:02d}'
SEED = [  # id, date, amount (fils), cat, note, from
    ('h1', d(3), 300000, 'home', 'كنب', 'card'),
    ('h2', d(3), 25479, 'home', 'منظفات', 'cash'),
    ('h3', d(9), 200000, 'home', 'غسالة', 'none'),   # 'none' still counts in the month total, so it must be listed too
    ('c1', d(5), 12500, 'cats', 'رمل', 'cash'),
    ('c2', d(7), 18400, 'cats', 'بيطري', 'cash'),
    ('p1', f'{pm}-15', 30900, 'home', 'ستارة', 'cash'),  # last month: never in this month's sheet
]
fils = lambda s: int(round(float(s.replace(',', '')) * 1000))

with sync_playwright() as p:
    b = p.chromium.launch()
    ctx = b.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=2, is_mobile=True, has_touch=True, color_scheme='dark', locale='ar-JO')
    page = ctx.new_page()
    errors = []
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.on('console', lambda m: errors.append(m.text) if m.type == 'error' else None)
    page.on('dialog', lambda dlg: dlg.accept())
    page.goto(BASE)
    page.wait_for_selector('#guideOv', timeout=8000); page.click('#guideOk')
    page.evaluate('''seed => { const s = __masroofi.state; seed.forEach(([id, date, amount, cat, note, from], i) =>
        s.entries.push({ id, ts: Date.now() + i, date, amount, cat, sub: '', note, from, rafah: false })); }''', SEED)

    page.click('nav [data-v=month]'); page.wait_for_timeout(200)
    rows = page.locator('.catbar.tap')
    check('category rows are tappable with a chevron', rows.count() == 2 and page.locator('.catbar.tap .chev').count() == 2, str(rows.count()))
    home_row = page.locator('.catbar.tap[data-cat=home]')
    row_total = fils(home_row.locator('.hd .amt').inner_text())
    check('home row total = 525.479', row_total == 525479, str(row_total))

    home_row.scroll_into_view_if_needed(); page.screenshot(path=os.path.join(SHOTS, 'v112_month_rows.png'))
    home_row.click(); page.wait_for_timeout(200)
    check('sheet opens with the category name', page.is_visible('.sheet') and 'البيت' in page.inner_text('.sheethd h3'))
    sheet_total = fils(page.inner_text('#cdTotal'))
    check('sheet total = row total', sheet_total == row_total, f'{sheet_total} vs {row_total}')
    ids = page.eval_on_selector_all('[data-cdid]', 'els => els.map(e => e.dataset.cdid)')
    check('lists exactly the 3 home entries of this month', sorted(ids) == ['h1', 'h2', 'h3'], str(ids))
    amts = [fils(x) for x in page.eval_on_selector_all('[data-cdid] .v', 'els => els.map(e => e.textContent)')]
    check('the listed amounts add up to the total', sum(amts) == row_total, f'{sum(amts)}')
    days = page.eval_on_selector_all('.cdday', 'els => els.map(e => e.dataset.date)')
    check('grouped by day, newest first', days == [d(9), d(3)], str(days))
    groups = page.evaluate('''() => [...document.querySelectorAll('.cdday')].map(h => [h.dataset.date,
        [...h.nextElementSibling.querySelectorAll('[data-cdid]')].map(li => li.dataset.cdid)])''')
    check('each entry sits under its own day', groups == [[d(9), ['h3']], [d(3), ['h1', 'h2']]], str(groups))
    day3 = fils(page.locator(f'.cdday[data-date="{d(3)}"] .amt').inner_text())
    check('day subtotal right (300 + 25.479)', day3 == 325479, str(day3))
    txt = page.inner_text('.sheet')
    check('shows notes', all(n in txt for n in ['كنب', 'منظفات', 'غسالة']) and 'ستارة' not in txt)
    page.screenshot(path=os.path.join(SHOTS, 'v112_cat_detail.png'))
    COLORS_JS = '''() => [...document.querySelectorAll('.cdgrp')].map(g => { const h = g.querySelector('.cdday'), cs = getComputedStyle(h);
        return { date: h.dataset.date, stripe: cs.borderRightColor, stripeW: cs.borderRightWidth, name: getComputedStyle(h.firstElementChild).color,
          rows: [...g.querySelectorAll('[data-cdid]')].map(li => getComputedStyle(li).borderRightColor),
          nums: [...g.querySelectorAll('.cdnum')].map(n => [n.textContent, getComputedStyle(n).backgroundColor]) }; })'''
    def color_checks(tag, cg):
        stripes = [g['stripe'] for g in cg]
        check(f'{tag}: header stripe on the right (RTL), 4px', all(g['stripeW'] == '4px' for g in cg), str([g['stripeW'] for g in cg]))
        check(f'{tag}: neighbouring days never share a colour', all(a != b for a, b in zip(stripes, stripes[1:])), str(stripes))
        check(f'{tag}: up to 6 days all distinct', len(set(stripes[:6])) == min(6, len(stripes)), str(stripes[:6]))
        check(f'{tag}: day name in its colour', all(g['name'] == g['stripe'] for g in cg))
        check(f'{tag}: every row has its day colour stripe', all(g['rows'] and all(r == g['stripe'] for r in g['rows']) for g in cg))
        check(f'{tag}: day-number chips match day + colour', all(len(g['nums']) == len(g['rows']) and all(t == str(int(g['date'][-2:])) and bg == g['stripe'] for t, bg in g['nums']) for g in cg), str([g['nums'] for g in cg][:2]))
    color_checks('home', page.evaluate(COLORS_JS))

    # tap an entry -> the edit sheet; cancel -> back to the list
    page.click('[data-cdid=h2]'); page.wait_for_timeout(150)
    check('tapping an entry opens the edit sheet', page.is_visible('#eAmt') and page.input_value('#eNote') == 'منظفات')
    page.click('#eCancel'); page.wait_for_timeout(150)
    check('cancel goes back to the category list', page.is_visible('#cdTotal'))
    # edit 25.479 -> 30 and save: back on the list, total and month row follow
    page.click('[data-cdid=h2]'); page.fill('#eAmt', '30'); page.click('#eSave'); page.wait_for_timeout(300)
    check('after save the list shows the new total', page.is_visible('#cdTotal') and fils(page.inner_text('#cdTotal')) == 530000, page.inner_text('#cdTotal') if page.is_visible('#cdTotal') else 'no sheet')
    page.click('#cdClose'); page.wait_for_timeout(150)
    check('X closes the sheet', page.locator('.sheet').count() == 0)
    check('month row updated too', fils(page.locator('.catbar.tap[data-cat=home] .hd .amt').inner_text()) == 530000)

    # the other category, closed with the back button
    page.click('.catbar.tap[data-cat=cats]'); page.wait_for_timeout(150)
    ids = page.eval_on_selector_all('[data-cdid]', 'els => els.map(e => e.dataset.cdid)')
    check('cats sheet: its 2 entries, 30.900 total', sorted(ids) == ['c1', 'c2'] and fils(page.inner_text('#cdTotal')) == 30900, str(ids))
    page.click('#cdBack'); page.wait_for_timeout(150)
    check('back button closes it', page.locator('.sheet').count() == 0)

    # the selected month is respected: go back one month
    page.click('[data-act=monShift][data-n="-1"]'); page.wait_for_timeout(200)
    page.click('.catbar.tap[data-cat=home]'); page.wait_for_timeout(150)
    ids = page.eval_on_selector_all('[data-cdid]', 'els => els.map(e => e.dataset.cdid)')
    check('previous month: only its own entry', ids == ['p1'] and fils(page.inner_text('#cdTotal')) == 30900, str(ids))
    page.click('#cdClose')

    # a long list stays usable: the header (with X) stays on top when scrolled
    page.click('[data-act=monShift][data-n="1"]'); page.wait_for_timeout(150)
    page.evaluate('''ym => { const s = __masroofi.state; for (let i = 1; i <= 20; i++) s.entries.push({ id: 'x' + i, ts: Date.now() + 100 + i,
        date: ym + '-' + String((i % 20) + 1).padStart(2, '0'), amount: 1000 * i, cat: 'home', sub: '', note: 'بند ' + i, from: 'cash', rafah: false }); __masroofi.render(); }''', ym)
    page.click('.catbar.tap[data-cat=home]'); page.wait_for_timeout(150)
    page.evaluate("document.querySelector('.sheet').scrollTop = 600"); page.wait_for_timeout(100)
    top = page.evaluate("document.querySelector('#cdClose').getBoundingClientRect().top - document.querySelector('.sheet').getBoundingClientRect().top")
    check('X stays visible after scrolling', 0 <= top < 40, str(top))
    page.screenshot(path=os.path.join(SHOTS, 'v112_cat_detail_scrolled.png'))
    row_total = fils(page.locator('#cdTotal').inner_text())
    amts = [fils(x) for x in page.eval_on_selector_all('[data-cdid] .v', 'els => els.map(e => e.textContent)')]
    check('long list still adds up', sum(amts) == row_total == page.evaluate(f"__masroofi.L.monthStats(__masroofi.state, '{ym}').byCat.home"), f'{sum(amts)} {row_total}')
    page.click('#cdClose')

    # v1.12.1 colours on a realistic grocery month (like Ahmad's screenshot): 7 days, 1-2 items a day
    GRO = [(21, 10500, 'Peanuts andall', 'card'), (21, 20290, 'Ayesh market', 'savings'), (18, 50530, 'ماركت العايش دجاج و لحمة و اغراض', 'card'),
           (16, 21560, 'من مول العايش، دجاج خضار اغراض', 'card'), (15, 3690, 'Qmart', 'card'), (13, 20000, 'groceries', 'none'),
           (13, 7250, 'خبز وبيض', 'cash'), (10, 14780, 'خضار', 'cash'), (6, 9990, 'حليب', 'cash')]
    page.evaluate('''([ym, gro]) => { const s = __masroofi.state; gro.forEach(([day, amount, note, from], i) => s.entries.push({ id: 'g' + i, ts: Date.now() + 500 + i,
        date: ym + '-' + String(day).padStart(2, '0'), amount, cat: 'groceries', sub: '', note, from, rafah: false })); __masroofi.render(); }''', [ym, GRO])
    page.click('.catbar.tap[data-cat=groceries]'); page.wait_for_timeout(200)
    cg = page.evaluate(COLORS_JS)
    check('groceries: 7 day groups', len(cg) == 7, str(len(cg)))
    color_checks('groceries', cg)
    check('groceries: still adds up', fils(page.inner_text('#cdTotal')) == sum(g[1] for g in GRO) == page.evaluate(f"__masroofi.L.monthStats(__masroofi.state, '{ym}').byCat.groceries"))
    page.evaluate("document.querySelector('#toast').innerHTML = ''")  # (the earlier save's toast)
    page.screenshot(path=os.path.join(SHOTS, 'v1121_cat_detail.png'))
    page.click('[data-cdid=g2]'); page.wait_for_timeout(150)
    check('groceries: tap still opens the edit sheet', page.is_visible('#eAmt')); page.click('#eCancel'); page.wait_for_timeout(150)
    page.click('#cdClose')

    check('version 1.12.1', '1.12.1' in page.evaluate("import('./js/app.js').then(m => m.APP_VERSION)"))
    check('no page errors', not errors, '; '.join(errors[:3]))
    b.close()
print(f'{sum(results)}/{len(results)} passed')
