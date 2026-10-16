#!/usr/bin/env python3
"""Build transparent, 1x/2x hand-off arrow icons from the 256 px source."""
from pathlib import Path
from PIL import Image, ImageChops, ImageOps

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "extension" / "icons" / "handoff-arrow-left-source.png"
OUT = ROOT / "extension" / "icons" / "handoff"


def ink_mask(image):
    # The supplied raster has a white matte. Convert darkness to alpha to recover its black ink.
    gray = image.convert("L")
    return ImageOps.invert(gray)


# Outlined arrows (white with a thin black outline), used in both color schemes: they show on the white buttons of light mode
# and on the black buttons of dark mode. The outline is 1 px at 36 px and 1.5 px at 72 px. Drawn at 4x and scaled down so
# the outer edge is smooth.
OUTLINE_PX = {36: 1.0, 72: 1.5}
SUPERSAMPLE = 4


def outlined(mask, size):
    big = size * SUPERSAMPLE
    alpha = mask.resize((big, big), Image.Resampling.LANCZOS)
    radius = OUTLINE_PX[size] * SUPERSAMPLE
    reach = int(radius)
    grown = alpha.copy()
    for dx in range(-reach, reach + 1):
        for dy in range(-reach, reach + 1):
            if dx * dx + dy * dy <= radius * radius:
                grown = ImageChops.lighter(grown, ImageChops.offset(alpha, dx, dy))
    black = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    black.putalpha(grown)
    white = Image.new("RGBA", (big, big), (255, 255, 255, 0))
    white.putalpha(alpha)
    black.alpha_composite(white)
    return black.resize((size, size), Image.Resampling.LANCZOS)


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    source = Image.open(SOURCE)
    mask = ink_mask(source)
    for direction, oriented in (("left", mask), ("right", ImageOps.mirror(mask))):
        for tone, color in (("ink", (0, 0, 0)), ("light", (255, 255, 255))):
            rgba = Image.new("RGBA", oriented.size, (*color, 0))
            rgba.putalpha(oriented)
            for size in (36, 72):
                resized = rgba.resize((size, size), Image.Resampling.LANCZOS)
                resized.save(OUT / f"handoff-{direction}-{tone}-{size}.png", optimize=True)
        for size in OUTLINE_PX:
            outlined(oriented, size).save(OUT / f"handoff-{direction}-outline-{size}.png", optimize=True)


if __name__ == "__main__":
    main()
