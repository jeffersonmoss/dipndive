"""Builds the mode-button logos in extension/icons/modes/ (system python3 with Pillow; not part of the companion).

Sources: the Claude and Codex app icons (256 x 256), extracted on 2026-10-01 from Jefferson's installed Claude.app and
ChatGPT.app. The sources are not kept; this script documents exactly how the committed files were made:
  python3 tools/mode_icons.py <claude.png> <codex.png>
The sources are gone, so the Dip logos can also be rebuilt from the committed Dive logos alone:
  python3 tools/mode_icons.py --dip-from-dive
1. Codex: the app icon as it is. Only its white surroundings are made transparent (color-to-alpha against white, for the
   light pixels connected to the border, so the white terminal prompt inside the blossom is untouched).
2. Claude: the starburst alone, in Claude orange (#D97757), on transparency (the buttons are black): each pixel keeps
   as much opacity as it was white (the star was white on the orange square), so the star's soft edge survives.
3. Each is cropped to its shape, centred on a square, and written at 36 px and 72 px (2x) as <name>-dive.
4. The Dip versions (<name>-dip) are the same logo faded toward black, as if it were partly transparent over the black
   button: the colours are kept and the opacity is DIP_OPACITY (0.58). Darker than Dive, never pastel.
"""
import sys
from collections import deque
from PIL import Image

OUT = "extension/icons/modes"
SIZES = (36, 72)
DIP_OPACITY = 0.58


def codex(src):
    im = Image.open(src).convert("RGBA")
    w, h = im.size
    px = im.load()
    seen = [[False] * h for _ in range(w)]
    q = deque((x, y) for x in (0, w - 1) for y in range(h))
    q.extend((x, y) for y in (0, h - 1) for x in range(w))
    while q:
        x, y = q.popleft()
        if not (0 <= x < w and 0 <= y < h) or seen[x][y]:
            continue
        r, g, b, a = px[x, y]
        if min(r, g, b) < 228:  # the blossom itself (its light top edge included)
            continue
        seen[x][y] = True
        al = max(255 - r, 255 - g, 255 - b) / 255.0
        if al <= 0.004:
            px[x, y] = (255, 255, 255, 0)
        else:
            un = lambda c: max(0, min(255, round((c - 255 * (1 - al)) / al)))
            px[x, y] = (un(r), un(g), un(b), round(a * al))
        q.extend(((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)))
    return im


def claude(src):
    im = Image.open(src).convert("RGBA")
    px = im.load()
    w, h = im.size
    orange = (0xD9, 0x77, 0x57)
    for y in range(h):
        for x in range(w):
            r, g, b, a = px[x, y]
            t = max(0.0, min(1.0, (b - 95) / (245 - 95))) if a else 0.0  # 0 on the orange square, 1 on the white star
            px[x, y] = orange + (round(a * t),)
    return im


def square(im):
    box = im.getchannel("A").point(lambda v: 255 if v > 8 else 0).getbbox()
    im = im.crop(box)
    side = max(im.size)
    out = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    out.paste(im, ((side - im.size[0]) // 2, (side - im.size[1]) // 2))
    return out


def faded(im, opacity=DIP_OPACITY):
    """The same logo at `opacity` (colours untouched): over the black button it reads as the logo faded toward black."""
    out = im.convert("RGBA")
    out.putalpha(out.getchannel("A").point(lambda v: round(v * opacity)))
    return out


def main(claude_src, codex_src):
    for name, im in (("claude", square(claude(claude_src))), ("codex", square(codex(codex_src)))):
        for kind, img in (("dive", im), ("dip", faded(im))):
            for s in SIZES:
                img.resize((s, s), Image.LANCZOS).save(f"{OUT}/{name}-{kind}-{s}.png", optimize=True)


def dip_from_dive():
    for name in ("claude", "codex"):
        for s in SIZES:
            faded(Image.open(f"{OUT}/{name}-dive-{s}.png")).save(f"{OUT}/{name}-dip-{s}.png", optimize=True)


if __name__ == "__main__":
    if sys.argv[1:2] == ["--dip-from-dive"]:
        dip_from_dive()
    else:
        main(*sys.argv[1:3])
