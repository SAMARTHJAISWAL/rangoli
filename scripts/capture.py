"""Screenshots for the README and the social preview image.

Usage: python scripts/capture.py [base_url]     (default http://localhost:4173/)
Writes docs/hero.png, docs/night.png, docs/phone.png and public/og.png.
Two tabs share a room over BroadcastChannel, so the hero shot has a second
person's cursor and stroke in it.
"""
import math
import random
import sys
from pathlib import Path

from playwright.sync_api import Page, sync_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else 'http://localhost:4173/'
ROOT = Path(__file__).resolve().parent.parent
ARGS = ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist']


def open_room(ctx, room: str, name: str) -> Page:
    page = ctx.new_page()
    page.goto(f'{BASE}?net=local&nowelcome#{room}')
    page.wait_for_function('window.__rangoli !== undefined')
    page.evaluate(f'window.__rangoli.app.name = {name!r}; window.__rangoli.app.renderPeople()')
    page.evaluate('document.fonts.ready')
    return page


def board_xy(page: Page, fx: float, fy: float) -> tuple[float, float]:
    box = page.locator('#fx').bounding_box()
    return box['x'] + box['width'] * fx, box['y'] + box['height'] * fy


def stroke(page: Page, pts: list[tuple[float, float]]) -> None:
    page.mouse.move(*board_xy(page, *pts[0]))
    page.mouse.down()
    for p in pts[1:]:
        page.mouse.move(*board_xy(page, *p), steps=3)
    page.mouse.up()


def pick(page: Page, brush: str, colour: str, size: str = 'Medium', fold: str = '8') -> None:
    page.locator('#brushes').get_by_role('radio', name=brush, exact=True).click()
    page.locator('#colours').get_by_role('radio', name=colour, exact=True).click()
    page.locator('#sizes').get_by_role('radio', name=size).click()
    page.locator(f'#folds [data-fold="{fold}"]').click()


def main() -> None:
    room = f'shot{random.randrange(10**8):08d}'
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, args=ARGS, channel='chromium')
        ctx = browser.new_context(viewport={'width': 1440, 'height': 900}, color_scheme='light')
        me = open_room(ctx, room, 'Kaju Katli')
        friend = open_room(ctx, room, 'Jalebi')
        me.get_by_role('button', name='Sample rangoli').click()
        # The friend adds an outer ring of marigold petals and leaves their cursor on the board.
        pick(friend, 'Petals', 'Marigold', 'Bold', '12')
        stroke(friend, [(0.5 + 0.43 * math.cos(a / 20), 0.5 + 0.43 * math.sin(a / 20)) for a in range(0, 12)])
        pick(friend, 'Kolam dots', 'Chalk', 'Medium', '12')
        stroke(friend, [(0.5 + 0.39 * math.cos(a / 20), 0.5 + 0.39 * math.sin(a / 20)) for a in range(0, 12)])
        friend.mouse.move(*board_xy(friend, 0.74, 0.3))
        friend.mouse.move(*board_xy(friend, 0.745, 0.305))
        me.mouse.move(*board_xy(me, 0.2, 0.86))
        me.mouse.move(*board_xy(me, 0.21, 0.87))
        me.wait_for_timeout(900)
        me.evaluate("document.getElementById('toast').hidden = true")
        me.screenshot(path=str(ROOT / 'docs' / 'hero.png'))

        me.get_by_role('button', name='Lights out').click()
        me.wait_for_timeout(2200)
        me.screenshot(path=str(ROOT / 'docs' / 'night.png'), clip=me.locator('#fx').bounding_box())

        # The social preview: the same board at night, in the dark theme.
        me.set_viewport_size({'width': 1200, 'height': 630})
        me.emulate_media(color_scheme='dark')
        me.wait_for_timeout(1500)
        me.screenshot(path=str(ROOT / 'public' / 'og.png'))

        phone = browser.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=2, is_mobile=True, has_touch=True)
        m = open_room(phone, f'{room}p', 'Barfi')
        m.get_by_role('button', name='Sample rangoli').click()
        m.wait_for_timeout(600)
        m.evaluate("document.getElementById('toast').hidden = true; window.scrollTo(0, 0)")
        m.screenshot(path=str(ROOT / 'docs' / 'phone.png'))
        browser.close()
    for f in ['docs/hero.png', 'docs/night.png', 'docs/phone.png', 'public/og.png']:
        print(f, f'{(ROOT / f).stat().st_size // 1024} KiB')


if __name__ == '__main__':
    main()
