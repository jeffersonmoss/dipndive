#!/usr/bin/env python3
"""Build transparent, 1x/2x hand-off arrow icons from the 256 px source."""
from pathlib import Path
from PIL import Image, ImageOps

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "extension" / "icons" / "handoff-arrow-left-source.png"
OUT = ROOT / "extension" / "icons" / "handoff"


def ink_mask(image):
    # The supplied raster has a white matte. Convert darkness to alpha to recover its black ink.
    gray = image.convert("L")
    return ImageOps.invert(gray)


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


if __name__ == "__main__":
    main()
