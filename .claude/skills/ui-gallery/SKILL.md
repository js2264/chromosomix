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
node scripts/ui-figures.mjs gallery-figures   # the analysis figures: 01-curve.png … 25-metaplot-heatmap-dialog.png
node scripts/ui-methods.mjs gallery          # Model from the map under each Method: m1 … m4
node scripts/ui-structure-look.mjs gallery   # the structure cell's gestures: g-ghost-*, r*, t1 … t6
node scripts/ui-stars.mjs gallery            # the deck's stars and empty cells: s1 … s8
node scripts/ui-deck-reads.mjs gallery       # headings under zoom, own windows, the maps card: h*, w*, c*
node scripts/ui-saves.mjs gallery            # every export through the save dialog: x1 … x3
node scripts/ui-marks.mjs gallery            # marks on the card and the model's key: k1 … k5
node scripts/ui-captions.mjs gallery         # figures saved with their caption on and off: t1 … t9
```

The second script drives the part the first only passes through: the figures a task returns
(§18.13) — the slim strip, the settings dialog, every mark, a table filtered and sorted and
drawn as a chart, a matrix recoloured, a ⌘-drag over a heatmap and the double click that undoes
it, and the two figures that carry an aggregate: a pileup with a track profile along each edge
and a metaplot's per-feature heatmap. Run it after any change to `src/figures/`.

The third drives *Model from the map* under **both** methods (§25.6) and prints each fit table to
stdout as well as shooting it: the first gallery runs the task once, with whatever the form
defaults to, and stops where the drawer's table runs past the window — so the rows that say what
the negative binomial found, and the weighting control that only ShRec3D asks about, are exactly
what it cannot show. Run it after any change to the reconstruction or its form.

The fourth drives the structure cell's **gestures**, which a gallery of arrivals cannot show: the
ghost-opacity slider at each of four values (0 has to be *gone*, not pale), two long drags that
carry the model over the pole, the telomere toggle, the colour-scale picker appearing for a ramp and
not for levels, the three sticky mode buttons pressed, and the grips on the Structures card. It
prints what it found to stdout as well as shooting it, so a control that silently did not appear is
a line in the log rather than something to spot in a picture. Run it after any change to
`structure/three.ts`, `structure/camera.ts` or the cell's settings.

The fifth drives the **stars** of a deck (§16.5, §18.1, §25.3) and its empty cells (§16.9), on the
yeast deck demo (a cooler beside a `.hic`): the Aesthetics column's *Map* card following the star
onto a companion, a setting changed there reaching that map alone, the filled star pressed so that
nothing is starred — the card then says *every map* and sets them all, and the Analysis column greys
every task under one warning — an empty cell taking a row dragged from the Tracks card, and two
structure cells with neither starred. It prints what the card said at each step, so a card that did
not follow the star is a line in the log. Run it after any change to the stars, the Map card's
placement or `VacantPanel`.

The sixth drives what happens *between* two pictures of a deck (§5.4, §16.3, §16.9), at a
laptop's 1600 × 1000 with every column open: three zooms, printing the heading's height and every
side column's width before and after — they must come out exactly as they went in — then a
companion taken off the chain with a box drawn on it, which must read its own window (its cells
change, the first map's title does not) and give it back; then the Contact maps card listing every
map, a row of it dropped on an empty cell, a companion's eye closing its cell and opening it
again, and the × on a map's own cell hiding it — the cell staying as a tracks cell where a track was
drawn in it. Run it after any change to a view's heading, the side columns, `MapPanel`'s window or the
Contact maps card.

The seventh presses export buttons with the **save dialog** stubbed (§26.6) — a headless browser
cancels a real one the moment it opens — and prints what each asked it: the suggested name, the
Downloads folder, the type filter, and the bytes then written, with each card's line naming the
file under the name "the reader" typed; then, in a page with no dialog, the plain download. Run it
after any change to `ui/export.ts` or to an export button. Any script that waits for a `download`
event has to take the dialog away first (`window.showSaveFilePicker = undefined` in an init
script), or the export is cancelled before it starts.

The eighth follows the reader's **marks** from the Manual annotations card to the model (§8.1,
§25.5): two marks typed, the structure dropped, the colour-by menu's order printed, *colour by manual
annotations* and its key, a mark hidden from the key, one recoloured from it — with the card's row
checked to have taken the same colour — and one moved by typing over its row. Run it after any
change to the marks, the Manual annotations card or the structure's key.

The ninth saves **figures** with the Export card's *caption* switch on and off (§7.2) and writes
the saved PNGs themselves next to the shots, through a stand-in dialog that keeps the bytes: the
map's figure both ways, a deck with a tracks cell both ways (the deck's figure takes the first map's
caption), and the 1D browser demo's figure both ways, whose one-line caption is its own. It prints
each figure's height, which must drop by the caption's room when the switch is off. Run it after any
change to a figure's caption or to a figure pass.

Those last two of the first script need a form filled in before the run, which is why they are driven by name rather
than by position: an APA returns a pileup, a loop spectrum *and* a table, so "the last chart on
the page" is the scatter and not the picture. And the wait after pressing Run is that **the list
of figure titles changes** — waiting for a chart to exist returns at once, since the drawer still
holds the last task's, and waiting for the form to go away never returns at all, the form being a
slot that is emptied and refilled rather than removed.

Playwright comes from the global install when it is not a dev dependency (`npm root -g`), and
Chromium from `PLAYWRIGHT_BROWSERS_PATH`; the browser is launched with software WebGL
(`--use-angle=swiftshader`) so the structure cell renders in a container with no GPU.

## What it drives

The yeast demo (`?config=…/demo/yeast/Yeast_microC.metacooler.json`), the square map, the
side panels folded for room, then: the demo structure dropped on the Structures card,
the cell framed on the maps' window, a hover on a bead (the status bar names it) and on the map
(the chord), colour by the first track, a tracks cell with two tracks placed on it, the Analysis
panel, the spatial-tracks task run, the reconstruction (*Model from the map*) run and landing
in the cell, the Structures card with both models, and the cell's model picker. **Look at every screenshot** — a blank cell, a stale
note or a squashed plot is a bug the tests did not see, and this is where it shows.

## Gotchas met

- The Annotations panel is folded by default; its buttons are `button[title^="Show the … panel"]`.
- No card has a box to paste a URL into any more, so a file gets in by being **dropped**: fetch it
  in the page, build a `File`, and dispatch `dragenter`/`dragover`/`drop` with a `DataTransfer`.
  The click road opens the browser's own file picker, which the page cannot answer.
- The cell's own hover speaks in the status bar and on the maps, not in its corner readout.
- Vite serves `.gz` with `Content-Encoding: gzip` unless `vite.config.ts`'s dev plugin strips it.
