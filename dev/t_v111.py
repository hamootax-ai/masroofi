"""v1.11 test (2026-11-16, Ahmad: "هل في خيار انه مثلا دينت شخص من مصرياتي ؟ او مثلا حولت من توفير لكاش"): lending from an account +
its return, and the one-tap transfer on home. Headless Chromium at iPhone size. Run with the dev server on 8765."""
import os, sys
from playwright.sync_api import sync_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else 'http://127.0.0.1:8765/'
SHOTS = os.path.join(os.path.dirname(__file__), '..', 'screens')
results = []
def check(name, cond, info=''):
    results.append(bool(cond))
    print(('PASS ' if cond else 'FAIL ') + name + (f'  [{info}]' if info else ''))

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
    bal = lambda: page.evaluate('__masroofi.L.balances(__masroofi.state)')
    def set_bal(acc, val, limit=None):
        page.click('nav [data-v=money]'); page.click('[data-act=moneySeg][data-val=acc]')
        page.click(f'[data-act=editBal][data-acc={acc}]'); page.fill('#bVal', val)
        if limit: page.fill('#bLimit', limit)
        page.click('#bSave'); page.wait_for_timeout(250)
    set_bal('savings', '500'); set_bal('cash', '100'); set_bal('card', '0', '1000')
    page.wait_for_timeout(1100)  # (events must be after the base was typed)

    # 1. quick transfer savings -> cash from home
    page.click('nav [data-v=add]')
    check('transfer button on home', page.is_visible('#quickTransfer'))
    page.click('#quickTransfer')
    page.click('[data-name=qtFrom][data-val=savings]'); page.click('[data-name=qtTo][data-val=cash]')
    page.fill('#qtAmt', '50'); page.click('#qtSave'); page.wait_for_timeout(300)
    page.screenshot(path=os.path.join(SHOTS, 'v111_home_transfer.png'))
    b1 = bal()
    check('transfer: savings 450, cash 150, net same', b1['savings'] == 450000 and b1['cash'] == 150000 and b1['net'] == 600000, str(b1))
    ms = page.evaluate('__masroofi.L.monthStats(__masroofi.state, new Date().toISOString().slice(0,7)).total')
    check('transfer is not an expense', ms == 0, str(ms))

    # 2. lend 30 from cash to Omar
    page.click('nav [data-v=money]'); page.click('[data-act=moneySeg][data-val=rec]')
    page.click('[data-act=newRecv]')
    page.fill('#rvWho', 'عمر'); page.fill('#rvAmt', '30')
    page.check('#rvLent')
    check('lend: account picker shows', page.is_visible('#rvLentBox'))
    page.click('[data-name=rvAcc][data-val=cash]')
    page.screenshot(path=os.path.join(SHOTS, 'v111_lend_sheet.png'))
    page.click('#rvSave'); page.wait_for_timeout(300)
    b2 = bal()
    check('lend: cash 120, net 570', b2['cash'] == 120000 and b2['net'] == 570000, str(b2))
    r = page.evaluate('__masroofi.state.receivables[0]')
    check('lend: receivable linked to its transfer', r and r.get('lentTransferId') and r.get('lentFrom') == 'cash', str(r))
    ms = page.evaluate('__masroofi.L.monthStats(__masroofi.state, new Date().toISOString().slice(0,7)).total')
    check('lend is not an expense', ms == 0, str(ms))

    # 3. edit the amount: 30 -> 40 moves the deduction too
    page.click('[data-act=editRecv] >> nth=0'); page.fill('#rvAmt', '40'); page.click('#rvSave'); page.wait_for_timeout(300)
    check('edit lent amount: cash 110', bal()['cash'] == 110000, str(bal()))

    # 4. he pays back 40 into savings: a transfer back, not income
    incomes0 = page.evaluate('__masroofi.state.incomes.length')
    page.click('[data-act=recvGot] >> nth=0')
    page.click('[data-name=rgAcc][data-val=savings]'); page.click('#rgSave'); page.wait_for_timeout(300)
    b3 = bal()
    check('returned: savings 490, cash 110, net back to 600', b3['savings'] == 490000 and b3['cash'] == 110000 and b3['net'] == 600000, str(b3))
    check('returned: no new income', page.evaluate('__masroofi.state.incomes.length') == incomes0)

    # 5. undo the return, then delete: everything back to the start
    page.click('[data-act=recvUndo] >> nth=0'); page.wait_for_timeout(300)
    check('undo return: net 560 again', bal()['net'] == 560000, str(bal()))
    page.click('[data-act=delRecv] >> nth=0'); page.wait_for_timeout(300)
    b5 = bal()
    check('delete lent: cash back to 150, net 600', b5['cash'] == 150000 and b5['net'] == 600000, str(b5))

    # 6. an old-style receivable (not lent) still adds income when it arrives
    page.click('[data-act=newRecv]'); page.fill('#rvWho', 'سامي'); page.fill('#rvAmt', '20'); page.click('#rvSave'); page.wait_for_timeout(300)
    check('plain receivable: balance unchanged', bal()['net'] == 600000)
    page.click('[data-act=recvGot] >> nth=0'); page.click('[data-name=rgAcc][data-val=cash]'); page.click('#rgSave'); page.wait_for_timeout(300)
    check('plain receivable arrives as income: cash 170', bal()['cash'] == 170000 and page.evaluate('__masroofi.state.incomes.length') == incomes0 + 1, str(bal()))

    check('no page errors', not errors, '; '.join(errors[:3]))
    b.close()
print(f'{sum(results)}/{len(results)} passed')
