---
name: ui-gallery
description: Drive the real app in headless Chromium and produce a gallery of screenshots of the UI — run after any change that touches what is on screen, and send the pictures to the reader.
---

# UI gallery

After any change to the UI — a panel, a cell of the deck, a control, a style — the reader
wants to *see* it, not read that tests pass. This drives the actual app and writes one PNG
per step; send those to the reader (as files, in the chat) and say what each shows.

## Run

```bash
npm run dev -- --host 127.0.0.1 --port 5173 &
timeout 60 bash -c 'until curl -sf http://127.0.0.1:5173/ >/dev/null; do sleep 1; done'
node scripts/ui-gallery.mjs gallery      # writes gallery/01-map.png … 19-compare-models.png
node scripts/ui-figures.mjs gallery-figures   # the analysis figures: 01-curve.png … 18-drawer.png
```

The second script drives the part the first only passes through: the figures a task returns
(§18.13) — the slim strip, the settings dialog, every mark, a table filtered and sorted and
drawn as a chart, a matrix recoloured. Run it after any change to `src/figures/`.

Playwright comes from the global install when it is not a dev dependency (`npm root -g`), and
Chromium from `PLAYWRIGHT_BROWSERS_PATH`; the browser is launched with software WebGL
(`--use-angle=swiftshader`) so the structure cell renders in a container with no GPU.

## What it drives

The yeast demo (`?config=…/demo/yeast/Yeast_microC.metacooler.json`), the square map, the
side panels folded for room, then: the demo structure added by URL through the Tracks card,
the cell framed on the maps' window, a hover on a bead (the status bar names it) and on the map
(the chord), colour by the first track, a tracks cell with two tracks placed on it, the Analysis
panel, the spatial-tracks task run, the reconstruction (*Model from the map*) run and landing
in the cell, the Structures card with both models, and the cell's model picker. **Look at every screenshot** — a blank cell, a stale
note or a squashed plot is a bug the tests did not see, and this is where it shows.

## Gotchas met

- The Annotations panel is folded by default; its buttons are `button[title^="Show the … panel"]`.
- The Tracks card's URL box adds through the loader, not the session's drop road.
- The cell's own hover speaks in the status bar and on the maps, not in its corner readout.
- Vite serves `.gz` with `Content-Encoding: gzip` unless `vite.config.ts`'s dev plugin strips it.
