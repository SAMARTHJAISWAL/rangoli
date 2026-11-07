"""Record docs/demo.gif: two people's screens side by side, drawing on one board.

Usage: python scripts/record_gif.py [base_url]     (default http://localhost:4173/)
Needs Playwright (with Chromium) and Pillow. The two tabs share the room over
BroadcastChannel; the left one draws (driven by this script) and the right one
just watches, so everything that appears on the right arrived by syncing.
"""
import math
import random
import sys
from io import BytesIO
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont
from playwright.sync_api import Page, sync_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else 'http://localhost:4173/'
OUT = Path(__file__).resolve().parent.parent / 'docs' / 'demo.gif'
ARGS = ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist']
PANEL = 420          # each board in the GIF, pixels
LABEL = 34
FRAME_MS = 70


def font(size: int):
    for path in ['/System/Library/Fonts/Supplemental/Arial Bold.ttf', '/System/Library/Fonts/Helvetica.ttc', '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf']:
        try:
            return ImageFont.truetype(path, size)
        except OSError:
            continue
    return ImageFont.load_default()


class Recorder:
    def __init__(self, left: Page, right: Page, names: tuple[str, str]):
        self.pages = (left, right)
        self.names = names
        self.frames: list[tuple[Image.Image, int]] = []
        self.font = font(17)

    def board(self, page: Page) -> Image.Image:
        box = page.locator('#fx').bounding_box()
        img = Image.open(BytesIO(page.screenshot(clip=box))).convert('RGB')
        return img.resize((PANEL, PANEL), Image.LANCZOS)

    def snap(self, ms: int = FRAME_MS) -> None:
        canvas = Image.new('RGB', (PANEL * 2 + 36, PANEL + LABEL + 12), (246, 236, 220))
        d = ImageDraw.Draw(canvas)
        for i, (page, name) in enumerate(zip(self.pages, self.names)):
            x = 12 + i * (PANEL + 12)
            canvas.paste(self.board(page), (x, LABEL))
            d.text((x + 2, 8), name, fill=(42, 23, 32), font=self.font)
        self.frames.append((canvas, ms))

    def save(self) -> None:
        imgs = [f for f, _ in self.frames]
        sample = imgs[::3]
        sheet = Image.new('RGB', (imgs[0].width, imgs[0].height * len(sample)))
        for i, im in enumerate(sample):
            sheet.paste(im, (0, i * imgs[0].height))
        palette = sheet.quantize(colors=255, method=Image.Quantize.MEDIANCUT)
        q = [im.quantize(palette=palette, dither=Image.Dither.NONE) for im in imgs]
        q[0].save(OUT, save_all=True, append_images=q[1:], duration=[d for _, d in self.frames], loop=0, optimize=True, disposal=1)
        total = sum(d for _, d in self.frames) / 1000
        print(f'docs/demo.gif: {len(q)} frames, {total:.1f} s, {OUT.stat().st_size // 1024} KiB')


def xy(page: Page, fx: float, fy: float) -> tuple[float, float]:
    box = page.locator('#fx').bounding_box()
    return box['x'] + box['width'] * fx, box['y'] + box['height'] * fy


def pick(page: Page, brush: str, colour: str, size: str, fold: str) -> None:
    page.locator('#brushes').get_by_role('radio', name=brush, exact=True).click()
    page.locator('#colours').get_by_role('radio', name=colour, exact=True).click()
    page.locator('#sizes').get_by_role('radio', name=size).click()
    page.locator(f'#folds [data-fold="{fold}"]').click()


def draw(rec: Recorder, page: Page, pts: list[tuple[float, float]], every: int = 2) -> None:
    page.mouse.move(*xy(page, *pts[0]))
    page.mouse.down()
    for i, p in enumerate(pts[1:]):
        page.mouse.move(*xy(page, *p), steps=2)
        if i % every == 0:
            page.wait_for_timeout(50)  # let the live preview reach the other tab
            rec.snap()
    page.mouse.up()
    page.wait_for_timeout(120)
    rec.snap()


def main() -> None:
    room = f'gif{random.randrange(10**8):08d}'
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, args=ARGS, channel='chromium')
        ctx = browser.new_context(viewport={'width': 1100, 'height': 760}, device_scale_factor=1)
        pages = []
        for name in ('Kaju Katli', 'Jalebi'):
            page = ctx.new_page()
            page.goto(f'{BASE}?net=local&nowelcome#{room}')
            page.wait_for_function('window.__rangoli !== undefined')
            page.evaluate(f'window.__rangoli.app.name = {name!r}; window.__rangoli.app.renderPeople()')
            pages.append(page)
        a, b = pages
        rec = Recorder(a, b, ("Kaju Katli's screen (drawing)", "Jalebi's screen (watching)"))
        rec.snap(900)

        # A powder lotus petal, eight-fold and mirrored: one stroke becomes sixteen.
        pick(a, 'Powder', 'Rani', 'Bold', '8')
        petal = [(0.5 + r * math.cos(t), 0.5 + r * math.sin(t)) for r, t in
                 [(0.06 + 0.2 * u, 0.32 * math.sin(math.pi * u)) for u in [i / 18 for i in range(19)]]]
        draw(rec, a, petal)
        pick(a, 'Powder', 'Haldi', 'Medium', '8')
        draw(rec, a, [(0.5 + 0.06 + 0.16 * u, 0.5) for u in [i / 10 for i in range(11)]])
        rec.snap(500)

        # Peacock-blue wave and a ring of marigold petals.
        pick(a, 'Powder', 'Peacock', 'Medium', '8')
        draw(rec, a, [(0.5 + (0.3 + 0.03 * math.sin(t * 16)) * math.cos(t), 0.5 + (0.3 + 0.03 * math.sin(t * 16)) * math.sin(t)) for t in [i * math.pi / 4 / 20 for i in range(21)]])
        pick(a, 'Petals', 'Marigold', 'Bold', '12')
        draw(rec, a, [(0.5 + 0.36 * math.cos(t), 0.5 + 0.36 * math.sin(t)) for t in [i * math.pi / 6 / 10 for i in range(11)]])
        rec.snap(500)

        # Diyas: one click, eight lamps.
        pick(a, 'Diya', 'Sindoor', 'Medium', '8')
        a.mouse.click(*xy(a, 0.5, 0.08))
        pick(a, 'Diya', 'Rani', 'Bold', '1')
        a.mouse.click(*xy(a, 0.47, 0.5))
        for _ in range(6):
            a.wait_for_timeout(60)
            rec.snap()

        # Lights out, for both screens.
        b.get_by_role('button', name='Lights out').click()
        for _ in range(14):
            a.wait_for_timeout(50)
            rec.snap()
        a.evaluate('window.__rangoli.app.firework([6400, 3300])')
        for _ in range(16):
            a.wait_for_timeout(40)
            rec.snap()
        rec.snap(2500)
        browser.close()
    rec.save()


if __name__ == '__main__':
    main()
