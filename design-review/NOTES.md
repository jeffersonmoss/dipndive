# Waterline (designer A, day mode)

The panel is a cross-section of the icon: dry air on top where the link and the video's title sit, a natural, uneven water surface, then the water, where the five mode buttons are tucked under the surface and hang down to their own depth and the answer is read, with the question bar at the bottom as the icon's black deep water.

## What makes it different

1. The page is split into three bands like the duck icon: white air at the top, pale water in the middle, and a near-black band of deep water at the bottom for asking questions.
2. The line between air and water is a real wave now, not a row of matching scoops: crests of different heights at uneven spacing, the way a water surface actually looks. The deep water at the bottom has its own surface, the same wave turned around and flattened, so the two lines never echo each other.
3. The five mode buttons sit under the water. Each one starts exactly at the surface above it: where a crest rises, the button reaches up into it; where the water dips, the button starts lower. Nothing sticks up above the waterline, at any panel width.
4. A thin film of water lies over the tops of the buttons, a little thicker under the tall crests, so they read as submerged rather than pasted on.
5. The buttons still hang to their own depth: the two Dive buttons reach deepest, the two Dip buttons halfway, Temp chat barely gets wet. You can see how deep each mode goes before reading a word.
6. The chosen button is pushed further under: it sinks, loses its raised ledge and drop shadow, closes a thick darker rim around itself, and the water above it turns deep in its own colour (dark orange over a Claude button, dark blue over a Codex one).
7. The video's title is the headline, large, above the waterline. The answer sits right below it, in the water.
8. The answer is not in a white box. It is printed straight on the water, and the first paragraph (the direct answer) is set larger than the rest. Follow-up answers are plain text too, under a dark question bubble.
9. List bullets are small hollow bubbles instead of black dots, in the answer and in History.
10. A new typeface for everything you read (Avenir Next, already on the Mac), instead of the plain system font.
11. The question area is a dark bar with a full-width question box on top and two big buttons under it. Speak is the biggest button on the panel. When it is listening it turns red and says Stop, but it never moves or changes size, and the question box gets a red rim.
12. Clear history, History and Options are three big buttons in a row at the bottom of the water, not small underlined links.
13. History opens in the panel as a clean list: each summary under its title, divided by a thin line, with a big Back button at the top.
14. The duck appears at the top as the brand, and in the empty panel next to the instructions.

## Design skills: where this deviates (for the reviewer)

15. The taste skill targets landing pages built with React, Tailwind and Motion. This is a Manifest V3 side panel with no build step and no remote code, so it is plain CSS, system fonts (Avenir Next, no font download) and no icon library (the existing microphone glyph is kept).
16. The skill asks for one accent colour. The owner fixed two brand families (Claude orange, Codex blue), so those stay on the mode buttons only; everything else uses a single ink and water palette.
17. The skill forbids flipping theme inside a page. The dark question bar is a deliberate, single colour-block device taken from the icon's black water, not a dark-mode section.
18. No photography: the brand icon is the only image, which fits a tool panel.
19. Day mode only, as asked. Night mode keeps working tokens so it stays legible, but it is not designed yet.
20. The buttons that are not chosen keep a solid raised ledge under them. The design skill frowns on hard ledges as a default; here the brief asks for a physically pressed-in look, and the ledge is what makes the chosen one read as sunk.
21. The busy indicator is a small spreading ripple. The detector flags pulsing dots as decoration; this one only runs while a summary is actually being made.

Screenshots: `after-empty.png`, `after-dip.png`, `after-dive.png`, `after-recording.png`, `after-pressed.png` (Claude Dip pressed), `after-history.png` (History open). Regenerate with `node design-review/shots.mjs [port]` (dev harness, fake models, throwaway headless Chrome, everything removed on exit).
