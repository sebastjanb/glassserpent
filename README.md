# Glass Serpent

Steer a serpent across a lit arena, eat crystals to grow and cut off rivals so they burst into food.

A game for Meta Ray-Ban Display glasses: one static page on a 600×600 canvas, no server, no account, own artwork.
Black is transparent on the glasses' display, so the game draws on black.

| Input | Action |
| --- | --- |
| Left / Right | turn 45° |
| Up | boost (burns length) |
| Down | tight 135° turn |
| Pinch | pause |
| Back | leave the app |


On the glasses add `https://sebastjanb.github.io/glassserpent/index.html` (keep `index.html`: without it the glasses read
the app manifest from the host root and show another app's icon).

## Files

- `site/game.js` — the game. Bump `VERSION` for every release.
- `site/kit.js` — shared input, head-motion, sound and drawing helpers. Copied from `GlassArcade/kit/kit.js`; edit it there.
- `site/index.html`, `site/sw.js`, manifests — written by `GlassArcade/scaffold.py`, which also renames the cache from `VERSION`.
- `site/.well-known/meta-wearables-manifest.json` and `icon.png` — the name and icon the glasses show.

Publish: push to `main`; `.github/workflows/pages.yml` serves `site/` on GitHub Pages.
