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
node scripts/ui-stars.mjs gallery            # the deck's stars and empty cells: s1 … s8, s8a, s8b
node scripts/ui-deck-reads.mjs gallery       # headings under zoom, own windows, the maps card: h*, w*, c*
node scripts/ui-saves.mjs gallery            # every export through the save dialog: x1 … x3
node scripts/ui-marks.mjs gallery            # marks on the card and the model's key: k1 … k5
node scripts/ui-captions.mjs gallery         # figures saved with their caption on and off: t1 … t9
node scripts/ui-cards.mjs gallery            # cards moved by their headings, through every rebuild: c1 … c8
node scripts/ui-bacteria.mjs gallery-bacteria  # a bacterial chromosome from origin to compartments: b01 … b36
node scripts/ui-tracks.mjs gallery           # the Tracks card, points, the pointers, map first, a circle, genes: tr01 … tr24
node scripts/ui-deck-lead.mjs gallery        # a lone bed3d as its model, the first cell moved, hidden, back: l1 … l4, m1 … m5
node scripts/ui-copy-this.mjs gallery        # Copy this on every right-click menu, and the PNG each put on the clipboard: cp1 … cp9
node scripts/ui-lane-carry.mjs gallery       # a lane's grip carried to another map, a +, a tracks cell, an empty cell; a model's row on a +: lc1 … lc14
node scripts/ui-track-location.mjs gallery   # the location marks, a left lane growing away, Space, the File card and the star, card rows on a + and an empty cell: tl1 … tl13
node scripts/ui-fourc.mjs gallery            # the 4C form's exclude anchor region, and the profile with and without the anchor: fc1 … fc4
node scripts/ui-deck-cells.mjs gallery       # a tracks cell's axis, both anchors' hairlines, cells renamed, a lane out of a tracks cell, one side of two carried, the Structures eye, a track beside the map in a tracks cell, the height bars: dc1 … dc24
node scripts/ui-correlation.mjs gallery      # the map's correlation at 4,096, 2,048 and 1,024 bins with its wait printed, the veil, a whole chromosome, the Compartments warning, yeast IV: co1 … co9
node scripts/ui-compartments.mjs gallery     # the Compartments table under cooltools and under the correlation, each printed: cp1, cp2
node scripts/ui-interarm.mjs gallery         # Inter-arm alignment's form, and its table with the control row on E. coli and on P. aeruginosa PAK (read from the zoo), printed: ia1 … ia5
node scripts/ui-interarm-expected.mjs gallery  # the score picker's inter-arm on PAK: offered once the first open ticks the circle, expected / along the arms / inter-arm on ori, the card, a hover, the link, unticked and ticked, and not on yeast: ie01 … ie11
node scripts/ui-peaks.mjs gallery-peaks      # peaks called on a bigWig, alone and with a replicate: p01 … p13
node scripts/ui-deck-maps.mjs gallery        # eight maps dropped at once, maps named in a task's tabs and all-maps tables, ori and arms on every map, rows of the Contact maps card reordered: dm01 … dm10
node scripts/ui-insulation-hicrep.mjs gallery  # the Analysis column with Reproducibility ready, then HiCRep's and insulation's forms and runs on the yeast deck: ih00 … ih10
node scripts/ui-overlay-maps.mjs gallery     # a loop set's maps field on a deck of three, a row and a file dropped on a map's middle, the batch box: om01 … om19
node scripts/ui-contacts.mjs gallery         # the breadcrumb's contacts box: 10M typed, the figure and a task on the drawn map, a deck's chevrons down and up, two files in one square, a Boost-HiC refusal and its two ways out: ct01 … ct18
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
structure cells — the 3D card naming the starred one under its title, then the other starred, then
neither. It prints what the card said at each step, so a card that did
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

The tenth moves **cards by their headings** (§26.6) and then makes every column rebuild under them:
a card carried within Aesthetics (shot in the air, with its landing slot) and one carried into it
from Annotations, a zoom, a reload, the General column rearranged across its nested hosts, a press on
a heading (which must still fold it), ⌥↓, a second tab and back, a deck arriving (its 3D card must
land after the Map card), the palette's reset, and on the two-map deck the Map card carried to
General with the companion then starred (the card there must become the companion's). It prints
every column's cards after each step, so a card that did not come back is a line in the log. Run it
after any change to `ui/cardLayout.ts`, to a column's builder or to a card's heading.

The eleventh drives what the yeast demo cannot show, because it has no circle and no origin: *P.
aeruginosa* PAK from the DNA Bacterial Zoo read as circular on its first open, *Origin and terminus*
and *Base composition* run from the Chromosomes table, the origin in the table's column, the map
framed on it with `ori` — lit while the origin is in the middle, through a zoom and not a pan, and
pressed again to go back to the sequence from its first base, each step printed to stdout — the O/E
taken along the arms with `arms` and correlated at 8 kb, the inter-arm and compartment tasks —
compartments by each *method*, the correlation's run with its own lane and components table after
cooltools' default —
*Base composition* again in a 1D browser holding the FASTA alone, at 10 kb (§8.15, §18.8) — and
then that browser's own Chromosomes table: a circle ticked and an origin typed there (and one past
the end refused), the map dropped over the browser taking both, and a fresh map's origin at its
first base, `ori` centring on it (§5.8, §8.15); and *Signal by group* comparing GC content between
the A and B the arms' compartments found, by the call's names and by E1's sign, with an origin typed
into the table first; and last, the DNA Bacterial Zoo as `scripts/dbz-store.sh` writes it (§24.2,
§24.3) — the cards, a species' fold, its session opening the map with the HiC score, insulation and
E1 along both arms under it and nothing on it, the circle and origin that session declares, `ori`
on that origin, and the shipped tile with nothing uploaded naming what builds it.
`GALLERY_ONLY=declarations`, `GALLERY_ONLY=groups` or `GALLERY_ONLY=store` runs one part alone,
in a minute or two. It reads the lab's bucket; where the browser cannot
reach it, serve the three files — `PAK_MM142.mcool`, `PAK.fa` and
`PAK_MM142_500.coverage.coverage-total.bw` — with `python3 scripts/DBZ_store.py serve <folder>` and
name the folder's address in `GALLERY_DATA`; for the store part, serve a store the script wrote and
name its `store.json` in `GALLERY_STORE`. Run it after any change to §8.15's declarations, to the
arm reading, to those tasks, or to the store's script.

The twelfth drives the **Tracks card and the lanes** (§5.8, §8.1, §8.6, §8.8, §8.15, §18.5): the
Annotations column's foot with Metadata annotations and Bookmarks folded, two tracks ticked and set
together from the batch box — `points` and one pair of limits — a diamond insulation run whose rows
land on the Tracks card marked `*`, the crosshair toggled off and on over a lane with the arrowhead
painted where the hand is (a screenshot carries no cursor) — `tr09b` magnified, its tip on the
hairline — the map's ring pointer painted the same way and a crop round it five times over
— `tr10b` at rest and `tr11b` in a cell wider than the ring, where the guide lines must stop at its
ticks and nothing may be drawn inside it — a typed locus with no ring round the map, the 1D browser
drawing points and its arrowhead on the hairline (`tr12b`, `tr12c`), the same session on a throttled
line drawing its map before
its tracks with their room kept, and a circle whose pan stops at its end, framed on `ori` and zoomed
on the join — then genes (§8.16): the rounded, pointed blocks beside the map and in the 1D browser, a
two-exon transcript (ACT1), the lane's right-click menu opened on a gene, the lane squished and
collapsed from that menu, and the same `rows` choice in the card. It prints what each step found. Run
it after any change to the Tracks card, the batch box, a track style, the pointers or the crosshair,
the order a session loads in, §8.15's frame, or how a feature is drawn.

The thirteenth drives the deck's **first cell as a cell like the others** (§16.9) and a structure
file opened on its own (§25.3): a bed3d written from the demo's model dropped on the landing page —
which must open as the model alone, filling the column with no scroll, the empty 1D browser it names
hidden behind it — then `show the 1D browser` in the deck's bar, the browser's heading with its grip
and its ×, the browser moved by its grip and hidden again; and on the yeast deck the first map moved
to the other cell, hidden by its × — the other map alone, starred, the first map's row on the
Contact maps card dimmed with its eye dark — the locus box typed with it hidden (the map on screen
must follow), and its eye putting it back where it stood. It prints the grid's order, the hash, the
star and the card's eyes at each step. Run it after any change to the deck's grid, its lead, the
Contact maps card's eyes, or what a lone structure opens as.

The fourteenth presses **Copy this** on every right-click menu that has it (§7.2) — the map, a lane
beside it, a lane of the 1D browser, and a 3D model after a right click that does not drag — with
the clipboard stood in for by a `navigator.clipboard.write` that keeps the PNG it is handed, as the
saves gallery keeps its dialog's bytes. It writes the menu as it opened and the copied PNG itself,
which must be the data object alone: the map's cells with no axis, key, frame, overlay or pointer
(`cp3` is the same map on screen, to hold it against); one lane with no name, range, handle or name
column; the model with no centre of rotation, key or buttons. It prints each PNG's size and what the
corner said. Run it after any change to a right-click menu, to what a renderer draws round its data,
or to `copyPicture`.

`scripts/ui-interarm-expected.mjs` drives the baseline's **inter-arm half** (§7.5, §8.15) on *P.
aeruginosa* PAK at 8 kb, opened on its chromosome for the first time — so the circle is ticked by
the first open after the view is built, and the score picker has to be *told* to offer `inter-arm`
(`ie01` is the picker opened out as a list, since a native dropdown's popup is not in a
screenshot). Then, framed on the origin with `ori` first — its press is a navigation, which starts
from the file's own score as every navigation does — `expected`, the same with `arms`, and
`inter-arm`: the two quadrants across the arms and nothing on either arm, the O/E and `arms` greyed
with their reasons, the key `Inter-arm expected`, and a hover's readout; then the link to it from
the sequence's first base, the circle unticked on the Chromosomes table (the entry goes and the
link lands on counts) and ticked again, and the yeast demo's picker without it (`ie11`). It prints
the picker's options, the key, the toggles and the hash at every step. Where the browser cannot
reach the zoo, serve `PAK_MM142.mcool` with `python3 scripts/DBZ_store.py serve <folder>` and name
the folder in `GALLERY_DATA`. Run it after any change to the score picker, to `render/derive.ts`'s
baselines, to `analysis/arms.ts`, or to how a circle is offered.

`scripts/ui-peaks.mjs` drives **Peak calling** on the 1D browser demo's ATAC bigWig (§18.8): the task
on the 1D card, its form, a run on the one track — the note that says no test was made, the violin of every
candidate's curvature on a log axis — then the strongest 5,000 with the cut drawn as a second violin
and the table per sequence, the new lane under the MACS2 peaks of the same reads at the demo's locus
and at 8 kb, where they can be compared peak for peak; then Pol II as the replicate, shot mid-fit
(*IDR, round N*, with the cancel button), and its answer: the note naming each edge of IDR's
parameter box the fit ended on — Pol II is not a replicate of ATAC — the four violins, the six
thresholds and both lanes. It prints the notes of each run to stdout. The replicate run fits IDR
over the whole genome and takes two minutes. Run it after any change to the task, to `yapc.ts` or
`idr.ts`, or to how a figure draws a violin.

`scripts/ui-deck-maps.mjs` drives a **deck of many maps** end to end (§16.9–§16.11, §18.7, §8.15):
eight copies of the yeast cooler dropped on the landing page with a GTF and a FASTA, every one of
which must open in its own cell (printed, with a count of the cells that say *could not be
re-opened*, which must be 0); three copies of the *E. coli* demo renamed on their headings, run on
together — Inter-arm alignment's `all maps` tab with its stacked table, Reproducibility's shown once
— every map named by its name; the first map's card setting O/E and `arms` on every map with none
starred, `ori` framing every map across the junction, and a starred companion's own card; then the
Contact maps card's rows carried up and down it (shot mid-carry) and moved by the arrow keys, the
grid printed after each. `GALLERY_ONLY=drop`, `maps` or `order` runs one part. Run it after any
change to how a deck is filled, to the Contact maps card, to what a task names a map, to the
all-maps tab, or to how a companion reads a circle.

`scripts/ui-insulation-hicrep.mjs` drives the two tasks held to their references to the pixel
(§18.8) on the yeast deck. First the Analysis column as the deck opens, *Reproducibility* ready
beside the second map (§18.1) — it stood greyed there until another task had run — and then that
task **first**, on the fresh deck: its form and a run between the cooler and the `.hic`, the
coefficient matrix, the table per sequence and the correlation by separation, which starts at the
first diagonal. Run after insulation's, it would find the other map whether or not a first run
could. Then *Diamond insulation*'s form — its *Boundaries* section holding the diamond coverage the
calls are read over — and a run, with its lane and its domains on the map. It prints the row's
state, each run's notes and the per-sequence rows. Run it after any change to either task's form,
to `analysis/insulation.ts`, to `analysis/hicrep.ts`, or to how the deck tells the column its maps.

`scripts/ui-overlay-maps.mjs` drives which maps an overlay is drawn on (§8.1), on a deck of three
yeast maps it writes itself (`gallery/_overlay-deck.metacooler.json`, served beside `demo/`): the
loops row's *maps* field and the deck at each state — imported onto the first map, the Hi-C map's
mark pressed, *every map*, the first map's mark pressed off, *no map* — then the two drops onto a
map's middle, *on this map*: the loops row carried onto the Hi-C map, with the middle the only
rectangle lit for it, and a loop *file* dropped on the third map, all five lit, which opens there
alone. Dispatched with a real `DataTransfer` rather than dragged by the mouse, so the rectangles
can be shot while the hand is still in the air. Then the ATAC row's *location* beside it, the batch
box's two fields with both rows ticked, and the Analysis column's *Compartments* and
*Reproducibility* rows. It prints the lit marks, the lit rectangles and the count at every step.
Run it after any change to `ui/lanePlacement.ts`, to how `MatrixPanel` paints its overlays or takes
a drop, or to `AnnotationStore.overlays`.

`scripts/ui-contacts.mjs` drives the **contacts box** at the end of the breadcrumb (§6.5): the yeast
micro-C as stored, its own total in grey; `10M` typed and the map redrawn from ten million contacts;
a figure saved with the caption that says so, P(s) run on the drawn map with its framing line and the
console's `metacooler-run … --contacts` printed; a total that is not one, refused in the box; the
box emptied. Then the deck demo, a cooler beside a `.hic` whose total is counted: the chevrons
pressed down and up (through Boost-HiC), and the deck's figure. Then two files in one square — the
second named in `GALLERY_PAIR`, since the demo has no second yeast map with the cooler's sequences —
with the Map card's fields printed to show *match depth* is gone. Last, E. coli at 1 kb asked for
500M: the Boost-HiC refusal, *read as stored*, and the same total at 2 kb. Every step prints the
box's value, placeholder, title and chevrons, and the hash. `GALLERY_ONLY=map`, `deck`, `pair` or
`refusal` runs one part. Run it after any change to the box, to resampling, or to what names a drawn
map.

Those last two of the first script need a form filled in before the run, which is why they are driven by name rather
than by position: an APA returns a pileup, a loop spectrum *and* a table, so "the last chart on
the page" is the scatter and not the picture. And the wait after pressing Run is that **the list
of figure titles changes** — waiting for a chart to exist returns at once, since the drawer still
holds the last task's, and waiting for the form to go away never returns at all, the form being a
slot that is emptied and refilled rather than removed.

Playwright comes from the global install when it is not a dev dependency (`npm root -g`), and
Chromium from `PLAYWRIGHT_BROWSERS_PATH`; the browser is launched with software WebGL
(`--use-angle=swiftshader`) so the structure cell renders in a container with no GPU.

The three after *Copy this* drive the gestures a gallery of arrivals cannot show. **Lane carry**
takes a lane by its grip with real pointer moves — a pointer drag captured on the lane's canvas,
which no `dragover` hears — and lets go on another map's rectangle, on a `+`, on a tracks cell and
on an empty cell, printing each cell's lane stacks before and after, so a lane that landed but did
not *leave* is a line in the log; it finds the grip by hunting the lane canvas for the `is-grab`
hand. **Track location** drives the four location marks on one map and on a deck, a left-hand lane
(which must grow away from the map), a pan off the diagonal put back by Space, the General
column's File card before and after the star moves to Hi-C, and a Tracks card row dragged — a real
HTML5 drag, not dispatched events, since a cell that refuses `dragover` never gets a drop — onto a
`+` and onto an empty cell. **4C** fills the anchor, runs the task with *exclude anchor region*
off and on, and shoots the left-hand lane each time.

## What it drives

The yeast demo (`?config=…/demo/yeast/Yeast_microC.metacooler.json`), the square map, the
side panels folded for room, then: the demo structure dropped on the Structures card,
the cell framed on the maps' window, a hover on a bead (the status bar names it) and on the map
(the chord), colour by the first track, a tracks cell with two tracks placed on it, the Analysis
panel, the spatial-tracks task run, the reconstruction (*Model from the map*) run and landing
in the cell, the Structures card with both models, and the 3D card naming the starred cell. **Look at every screenshot** — a blank cell, a stale
note or a squashed plot is a bug the tests did not see, and this is where it shows.

## Gotchas met

- The Annotations panel is folded by default; its buttons are `button[title^="Show the … panel"]`.
- No card has a box to paste a URL into any more, so a file gets in by being **dropped**: fetch it
  in the page, build a `File`, and dispatch `dragenter`/`dragover`/`drop` with a `DataTransfer`.
  The click road opens the browser's own file picker, which the page cannot answer.
- The cell's own hover speaks in the status bar and on the maps, not in its corner readout.
- Vite serves `.gz` with `Content-Encoding: gzip` unless `vite.config.ts`'s dev plugin strips it.
