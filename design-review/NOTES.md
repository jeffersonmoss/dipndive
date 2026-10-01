# Waterline (designer A, day mode)

The panel is a cross-section of the icon: dry air on top where the link and the video's title sit, a wavy waterline, then the water where the five mode buttons hang down to their own depth and the answer is read, with the question bar at the bottom as the icon's black deep water.

## What makes it different

1. The page is split into three bands like the duck icon: white air at the top, pale water in the middle, and a near-black band of deep water at the bottom for asking questions. A wavy line, drawn like the icon's, separates them.
2. The five buttons are no longer a row of equal squares. They hang from the waterline like depth markers: the two Dive buttons reach deepest, the two Dip buttons halfway, Temp chat barely gets wet. You can see how deep each mode goes before reading a word.
3. The chosen button sinks: it drops down, loses its raised ledge, and gets a deep shadow and a darker rim inside, as if it had been pushed into the water.
4. The video's title is now the headline, large, above the waterline. The answer to it sits right below, under the water.
5. The answer is not in a white box any more. It is printed straight on the water, and the first paragraph (the direct answer) is set larger than the rest.
6. List bullets are small hollow bubbles instead of black dots.
7. A new typeface for everything you read (Avenir Next, already on the Mac), instead of the plain system font.
8. The question area is a dark bar with a full-width question box on top and two big buttons under it. Speak is the biggest button on the panel. When it is listening it turns red and says Stop, but it never moves or changes size, and the question box gets a red rim.
9. The duck itself appears at the top as the brand, and in the empty panel next to the instructions.
10. Options moved to the top right next to the name; Clear history stays at the bottom. Both are now proper big buttons, not small underlined links.

## Taste skill: where this deviates (for the reviewer)

11. The skill targets landing pages built with React, Tailwind and Motion. This is a Manifest V3 side panel with no build step and no remote code, so it is plain CSS, system fonts (Avenir Next, no font download) and no icon library (the existing microphone glyph is kept).
12. The skill asks for one accent colour. The owner fixed two brand families (Claude orange, Codex blue), so those stay on the mode buttons only; everything else uses a single ink and water palette.
13. The skill forbids flipping theme inside a page. The dark question bar is a deliberate, single colour-block device taken from the icon's black water, not a dark-mode section.
14. No photography: the brand icon is the only image, which fits a tool panel.
15. Day mode only, as asked. Night mode keeps working tokens so it stays legible, but it is not designed yet.

Screenshots: `after-empty.png`, `after-dip.png`, `after-dive.png`, `after-recording.png`, `after-pressed.png` (Claude Dip pressed). Regenerate with `node design-review/shots.mjs [port]` (dev harness, fake models, throwaway headless Chrome, everything removed on exit).
