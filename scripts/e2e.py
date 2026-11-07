"""End-to-end checks: several real browser pages drawing on one board.

Usage: python scripts/e2e.py [base_url]     (default http://localhost:5173/)

Part 1 uses two tabs of one browser, synced over BroadcastChannel (?net=local),
so it is fast and needs no network. Part 2 uses two separate browser contexts
that can only reach each other over WebRTC, through the public Nostr relays,
exactly like two people on different machines. Part 3 checks the page itself.
"""
import random
import sys
import time

from playwright.sync_api import Page, sync_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else 'http://localhost:5173/'
ARGS = ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist']
results: list[tuple[str, bool, str]] = []


def check(name: str, ok: object, detail: object = '') -> None:
    results.append((name, bool(ok), str(detail)))


def url(room: str, local: bool = True) -> str:
    q = '?net=local&nowelcome' if local else '?nowelcome'
    return f'{BASE}{q}#{room}'


def rg(page: Page, expr: str):
    return page.evaluate(f'window.__rangoli.{expr}')


def wait_for(fn, timeout: float = 10.0, step: float = 0.1):
    end = time.time() + timeout
    while True:
        v = fn()
        if v or time.time() > end:
            return v
        time.sleep(step)


def board_point(page: Page, fx: float, fy: float) -> tuple[float, float]:
    box = page.locator('#fx').bounding_box()
    return box['x'] + box['width'] * fx, box['y'] + box['height'] * fy


def drag(page: Page, points: list[tuple[float, float]], pause_mid: callable = None) -> None:
    x, y = board_point(page, *points[0])
    page.mouse.move(x, y)
    page.mouse.down()
    for i, p in enumerate(points[1:]):
        x, y = board_point(page, *p)
        page.mouse.move(x, y, steps=4)
        page.wait_for_timeout(16)
        if pause_mid and i == len(points) // 2:
            pause_mid()
    page.mouse.up()


def open_page(ctx, address: str, errors: list[str]) -> Page:
    page = ctx.new_page()
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.on('console', lambda m: m.type == 'error' and 'WebSocket' not in m.text and errors.append(m.text))
    page.goto(address)
    page.wait_for_function('window.__rangoli !== undefined')
    return page


def part_tabs(p) -> None:
    room = f'tabs{random.randrange(10**8):08d}'
    browser = p.chromium.launch(headless=True, args=ARGS, channel='chromium')
    ctx = browser.new_context(viewport={'width': 1280, 'height': 860}, accept_downloads=True)
    errors: list[str] = []
    a = open_page(ctx, url(room), errors)
    b = open_page(ctx, url(room), errors)

    check('tabs: the two tabs find each other', wait_for(lambda: rg(a, 'peers()') >= 1 and rg(b, 'peers()') >= 1, 8))
    a.mouse.move(*board_point(a, 0.3, 0.3))
    a.mouse.move(*board_point(a, 0.32, 0.31))
    name_a = a.evaluate('window.__rangoli.app.name')
    check('tabs: each sees the other in the room list', wait_for(lambda: name_a in b.locator('#people').inner_text(), 5), b.locator('#people').inner_text())
    check('tabs: status counts both people', wait_for(lambda: '2 drawing here' in b.locator('#status-text').inner_text(), 5), b.locator('#status-text').inner_text())
    check("tabs: the other's cursor shows up", wait_for(lambda: b.evaluate('window.__rangoli.app.board.cursors.size') == 1, 5))

    seen_live = []
    drag(a, [(0.55 + 0.02 * i, 0.4 + 0.01 * i) for i in range(14)], pause_mid=lambda: seen_live.append(b.evaluate('window.__rangoli.app.board.live.size')))
    check('tabs: a stroke shows on the other tab while it is being drawn', seen_live and seen_live[0] >= 1, seen_live)
    check('tabs: the finished stroke arrives', wait_for(lambda: rg(b, 'strokes()') == 1, 5), rg(b, 'strokes()'))
    check('tabs: both boards are identical', rg(a, 'fingerprint()') == rg(b, 'fingerprint()'))
    check('tabs: no preview is left behind', wait_for(lambda: b.evaluate('window.__rangoli.app.board.live.size') == 0, 3))

    # Brushes, colours and symmetry are carried with the stroke.
    a.get_by_role('radio', name='Petals').click()
    a.get_by_role('radio', name='Peacock').click()
    a.locator('#folds [data-fold="12"]').click()
    drag(a, [(0.5, 0.2), (0.53, 0.22), (0.56, 0.25)])
    wait_for(lambda: rg(b, 'strokes()') == 2, 5)
    style = b.evaluate("(() => { const s = window.__rangoli.app.doc.visible()[1]; return [s.brush, s.color, s.fold, s.mirror]; })()")
    check('tabs: brush, colour and symmetry travel with the stroke', style == ['petal', 4, 12, True], style)

    # A click with the diya brush places lamps.
    a.keyboard.press('4')
    check('tabs: number keys pick a brush', a.get_by_role('radio', name='Diya').get_attribute('aria-checked') == 'true')
    x, y = board_point(a, 0.5, 0.15)
    a.mouse.click(x, y)
    check('tabs: a click places a diya everywhere', wait_for(lambda: rg(b, 'strokes()') == 3, 5))
    check('tabs: diyas get flames', b.evaluate('window.__rangoli.app.board.spots.length') >= 8, b.evaluate('window.__rangoli.app.board.spots.length'))

    # Undo only touches your own strokes.
    b.get_by_role('button', name='Undo').click()
    check("tabs: undo with nothing of yours says so", wait_for(lambda: 'Nothing of yours' in b.locator('#toast').inner_text(), 2))
    a.get_by_role('button', name='Undo').click()
    check('tabs: undo removes your last stroke for everyone', wait_for(lambda: rg(b, 'strokes()') == 2, 5))

    # Night mode is shared.
    b.get_by_role('button', name='Lights out').click()
    check('tabs: lights out reaches the other tab', wait_for(lambda: a.evaluate('window.__rangoli.app.doc.night'), 5))
    check('tabs: the button flips to Lights on', a.locator('#btn-night').inner_text() == 'Lights on')
    a.keyboard.press('n')
    check('tabs: N turns the lights back on for everyone', wait_for(lambda: not b.evaluate('window.__rangoli.app.doc.night'), 5))

    # Fireworks are shared and identical.
    a.get_by_role('button', name='Firework').click()
    check('tabs: a firework goes off on the other tab too', wait_for(lambda: b.evaluate('window.__rangoli.app.board.fireworks.length') >= 1, 3))

    # Sample rangoli, a late joiner, then clearing.
    b.get_by_role('button', name='Sample rangoli').click()
    check('tabs: the sample rangoli syncs', wait_for(lambda: rg(a, 'strokes()') == 20, 5), rg(a, 'strokes()'))
    c = open_page(ctx, url(room), errors)
    check('tabs: someone who joins later gets the whole board', wait_for(lambda: rg(c, 'fingerprint()') == rg(a, 'fingerprint()'), 8), (rg(c, 'strokes()'), rg(a, 'strokes()')))
    check('tabs: three people are counted', wait_for(lambda: '3 drawing here' in a.locator('#status-text').inner_text(), 8), a.locator('#status-text').inner_text())

    a.reload()
    a.wait_for_function('window.__rangoli !== undefined')
    check('tabs: a reload keeps the board (saved in the browser)', wait_for(lambda: rg(a, 'strokes()') == 20, 5), rg(a, 'strokes()'))

    c.get_by_role('button', name='Clear').click()
    c.get_by_role('button', name='Clear the board').click()
    check('tabs: clear empties every board', wait_for(lambda: rg(a, 'strokes()') == 0 and rg(b, 'strokes()') == 0, 5))

    with a.expect_download() as dl:
        a.get_by_role('button', name='Save image').click()
    check('tabs: save image downloads a PNG', dl.value.suggested_filename == f'rangoli-{room}.png', dl.value.suggested_filename)

    c.close()
    check('tabs: a closed tab leaves the room list', wait_for(lambda: '2 drawing here' in a.locator('#status-text').inner_text(), 10), a.locator('#status-text').inner_text())
    check('tabs: no console errors', not errors, ' | '.join(errors[:3]))
    browser.close()


def part_p2p(p) -> None:
    room = f'ptwo{random.randrange(10**8):08d}'
    browser = p.chromium.launch(headless=True, args=ARGS, channel='chromium')
    errors: list[str] = []
    # Separate contexts share no storage or BroadcastChannel: only WebRTC connects them.
    a = open_page(browser.new_context(viewport={'width': 1100, 'height': 800}), url(room, local=False), errors)
    b = open_page(browser.new_context(viewport={'width': 1100, 'height': 800}), url(room, local=False), errors)
    t0 = time.time()
    met = wait_for(lambda: rg(a, 'peers()') >= 1 and rg(b, 'peers()') >= 1, 45, 0.5)
    check('p2p: two browsers connect over WebRTC', met, f'{time.time() - t0:.1f} s')
    if met:
        drag(a, [(0.3 + 0.03 * i, 0.6) for i in range(8)])
        check('p2p: a stroke crosses the network', wait_for(lambda: rg(b, 'strokes()') == 1, 10))
        b.get_by_role('button', name='Sample rangoli').click()
        check('p2p: the boards converge', wait_for(lambda: rg(a, 'fingerprint()') == rg(b, 'fingerprint()'), 10), (rg(a, 'strokes()'), rg(b, 'strokes()')))
        b.get_by_role('button', name='Lights out').click()
        check('p2p: lights out crosses the network', wait_for(lambda: a.evaluate('window.__rangoli.app.doc.night'), 10))
    check('p2p: no console errors', not errors, ' | '.join(errors[:3]))
    browser.close()


def part_page(p) -> None:
    browser = p.chromium.launch(headless=True, args=ARGS, channel='chromium')
    errors: list[str] = []
    ctx = browser.new_context(viewport={'width': 1280, 'height': 860})
    page = ctx.new_page()
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.goto(BASE + '?net=local')
    page.wait_for_function('window.__rangoli !== undefined')
    check('page: a new visitor gets a room in the URL', len(page.evaluate('location.hash')) > 6, page.evaluate('location.hash'))
    check('page: the welcome dialog opens on an empty board', wait_for(lambda: page.locator('#welcome').is_visible(), 4))
    page.get_by_role('button', name='Start drawing').click()
    check('page: Start drawing closes it', not page.locator('#welcome').is_visible())
    brand = page.locator('a.brand')
    check('page: the title links to the repo', brand.get_attribute('href') == 'https://github.com/SAMARTHJAISWAL/rangoli')
    with page.expect_navigation():
        brand.click()
    check('page: clicking the title opens the repo', page.url.rstrip('/') == 'https://github.com/SAMARTHJAISWAL/rangoli', page.url)
    ctx.close()

    phone = browser.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=2, is_mobile=True, has_touch=True)
    m = phone.new_page()
    m.on('pageerror', lambda e: errors.append(str(e)))
    m.goto(url(f'phone{random.randrange(10**8):08d}'))
    m.wait_for_function('window.__rangoli !== undefined')
    check('phone: no sideways scrolling', m.evaluate('document.documentElement.scrollWidth - innerWidth') == 0)
    small = m.evaluate("[...document.querySelectorAll('button')].filter(b => b.offsetParent && b.getBoundingClientRect().height < 38).map(b => b.textContent.trim() || b.title)")
    check('phone: every button is big enough to tap', not small, small)
    box = m.locator('#fx').bounding_box()
    check('phone: the board fills the width', box['width'] >= 340, box['width'])
    m.touchscreen.tap(box['x'] + box['width'] * 0.7, box['y'] + box['height'] * 0.5)
    check('phone: a tap draws', wait_for(lambda: rg(m, 'strokes()') == 1, 3))
    check('page: no console errors', not errors, ' | '.join(errors[:3]))
    browser.close()


with sync_playwright() as p:
    part_tabs(p)
    part_p2p(p)
    part_page(p)

fails = [r for r in results if not r[1]]
for name, ok, detail in results:
    print(('PASS  ' if ok else 'FAIL  ') + name + (f'  ({detail})' if detail and (not ok or 'p2p: two' in name) else ''))
print(f'\n{len(results) - len(fails)}/{len(results)} checks passed')
sys.exit(1 if fails else 0)
