# Changelog

Notable changes to the viewer, newest first. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[semantic versioning](https://semver.org/) — for an application that means the **format and URL
contract** rather than a code API: a major bump is a `.metacool` the previous version could open and
this one cannot, or a `#`-hash link that no longer resolves to the same view.

The deployed site at <https://js2264.github.io/metacooler.js/> is built from `main` on every push, so
it can be ahead of the newest entry here. Its exact build is in **About → version**, and in the
`/Producer` field of any PDF it exports.

## [Unreleased]

### Added

- **Tabs, and a real session behind each one.** Several files open at once, each
  with its own reader worker, its own annotation worker, its own stores and its
  own DOM. Switching a tab in re-parents that DOM rather than rebuilding it, so
  a map comes back with its pixels, its zoom and its scroll exactly as they
  were and without a single byte re-read — which is what a tab has to be for it
  to be worth having over a second browser window.

  The address bar names **the active tab and nothing else**, which is what was
  asked for and also the only coherent answer: a hash is one view state, and
  writing several would make every link a description of somebody else's
  workspace and make the back button walk a history that interleaves three
  files. The rest of the strip lives in `sessionStorage` beside the annotations
  (§8.6), and a restored tab is *named* rather than opened — the label and the
  view state come back, the worker does not, and clicking is what reads the
  file. Eight remembered tabs therefore cost eight labels. One that named a
  local file comes back to the picker with the explanation a pasted local-file
  link has always given, because no browser re-reads a dropped file without a
  gesture.

  Two tabs on one file now share nothing: the per-session memory is keyed on the
  session as well as the URI, so the second view starts with no tracks, no
  filters and no marks rather than adopting the first one's.

- **A second cooler in the lower-left triangle.** A contact matrix is symmetric,
  so half of every square on screen is a mirror of the other half and carries no
  information at all. That is the room this uses: the second file fills it, the
  picture stops being symmetric, and a broken symmetry is read far faster than
  two maps side by side.

  The split is the **matrix** diagonal, not the viewport's, which is what makes
  panning off the diagonal need no rule of its own — the far corner of a trans
  block is entirely above the line and shows the first file alone, and its
  transpose shows the second. Zoom, selection and every other gesture are
  untouched, because the merge happens once per read and hands the renderer an
  ordinary block.

  Dropped on a card in the Annotations column, where everything else that is
  laid over a map already lives. Refused *by name*: a metacool (§8.5's argument,
  applied to a whole matrix), a different bin size (one grid cannot be two
  resolutions), or a chromosome list differing in count, order, spelling or
  length (every coordinate is an index into one such list). An `.mcool` dropped
  at its root opens its finest resolution, as it does on the picker.

  GENERAL becomes File 1 and File 2, each with the mark of its own triangle and
  a close button: closing the second returns to one map, closing the first
  promotes the second, so either is reversible and what remains is an ordinary
  one-file map. `uri2` is in the hash, so a comparison is a link.

  One scale by default, because the same colour meaning the same count is the
  stronger claim. **Match depth** scales the second file so its 99th percentile
  meets the first's — the same order statistic §7.1 picks `vmax` with — for the
  case that motivates it: two libraries of different depth, where the shallower
  is otherwise a pale triangle telling you only that it was sequenced less. Two
  colourbars then read the same colours in each file's own counts, and the
  tooltip and the status line carry both numbers at every cell.

- **A genome browser that needs no contact map.** Until now a bigWig could only
  be looked at beside a cooler of the same assembly, and that was never a
  property of the tracks — it was a property of the coordinate model, which
  started from a matrix and had no way to describe a genome that was not one.

  So there is a second starting point. A `chrom.sizes`, a bigWig, a bigBed or a
  feature file declares the assembly — outright in the first three cases, and as
  a lower bound in the fourth, which is marked as inferred wherever the genome
  is described — and the axis becomes the whole genome laid end to end at one
  unit per base pair. Everything drawn on it is drawn by the code that draws the
  lanes beside a heatmap, through the same `LocusAxis` §8.4 already made the
  only one: a track cannot be at two positions because only one thing knows
  where a base pair is.

  The gestures are the map's, deliberately. A drag pans, Option-drag selects a
  range to zoom into, the wheel zooms about the pointer, a double click fits, a
  lane's border resizes it and its body reorders the stack — every one of them
  the gesture that already meant that. The one that is the browser's own is
  ⌘-scroll over a lane, which moves *that* track's ceiling from whatever it is
  currently resolved to; it is the adjustment a genome browser is asked for
  constantly and a map has no analogue for it.

  With it: a locus box that accepts `chrI:1,000-20,000`, a bare sequence name or
  `*`, and shows back exactly what it would accept; a feature search over every
  loaded gene model and peak set; click a gene to zoom to it and a sequence name
  to go there; a ruler that draws sequence bands zoomed out and base pairs
  zoomed in, because at those two extremes they are different questions; arcs
  for a BEDPE, which is what a loop call looks like in one dimension; range and
  group editors on each lane, revealed by pointing at it; autoscale groups that
  stack or share a single lane; and PDF/PNG export redrawn at the export scale.

  The two shapes of browser are one session. Drop a `.cool` anywhere on the
  tracks and the tab becomes its map, tracks and all; close the map from the
  File card and it falls back to a browser on the cooler's own `/chroms`, with
  the same tracks still loaded. A file whose name says nothing is opened as a
  map and, if that fails, identified by its bytes and re-routed rather than
  reported as broken.

- **bigBed is read.** Whole, and parsed as the BED it holds, so a bigBed12 draws
  its exons exactly as the text file would — one parser, one set of rules, one
  place where BED's quirks live. Not windowed, because a `FeatureSet` lives on
  the main thread precisely so that a pan redraws with no round trip (§8.4). A
  file past a million intervals is cut off and says so.

### Changed

- The app was one object holding a worker, a store, a file and a view, and it
  bound itself to the address bar in its constructor. It is now `app/Session.ts`
  — a file and the views of it — and `app/App.ts` — the window around them —
  with `main.ts` as three lines of bootstrap. `ViewStore` stops owning the hash,
  because there is one address bar and there may be six stores.

- The sample cache that keeps pan and zoom free of I/O moved out of
  `AnnotationLanes` into `annotations/samples.ts`. Two widgets need that rule now
  and its arithmetic — the padded window, the power-of-two bucket, keeping the
  old data on screen until the new data lands — is fiddly enough that two copies
  would drift.

- A `chrom.sizes` dropped on a browser whose lengths were *inferred* replaces
  them, and replaces only them: the URI, the session memory and every loaded
  track stay exactly as they were, because the genome did not change — only what
  is known about it. A `samtools faidx` `.fai` counts as one, decided by its
  name, which is the tiebreak `sniffFormat` already uses for the two cases its
  columns cannot settle.

### Fixed

- The icon generator dropped every SVG attribute whose name contained a digit,
  so every `<line>` was emitted with no coordinates and drew nothing. It had
  been latent because no icon used one; the magnifiers added here came out as
  bare circles.

## [0.5.1] - 2026-08-04

### Fixed

- Fixed unit tests that errored on Github runners without fixtures.

## [0.5.0] - 2026-08-04

### Added

- **Right-click the map to mark the cell under the pointer.** Vertical line,
  horizontal line, crosshair, loop — each row showing the coordinate it would
  use, so what is about to be marked is visible before it is — and copy
  coordinates. The two ways in that existed were typing a coordinate you already
  know and arming a mode and clicking; neither answers "this one, the one I am
  pointing at".

- **Lanes beside the map are draggable, and carry their own menu.** The border
  resizes a track, the body reorders the stack, and dragging *along* the axis
  still pans the map — which it has to, since that is what dragging a track has
  always done. The direction of the first movement tells the three apart, so
  nothing needs a modifier key and no gesture was given up for another. A right
  click on a lane offers its colour, its range, hide and remove: the two
  controls a reader beside the map actually reaches for, where the track is
  rather than across the window in a card.

- **Hand-drawn lines are continued into the lanes.** A vertical rule is a column
  and is drawn under the map; a horizontal one is a row and is drawn beside it;
  a crosshair is both. Loop anchors are small triangles on each stack's outer
  edge, pointing back at the map. A mark called out on the matrix is a
  coordinate, and the tracks beside it are what a coordinate is usually being
  compared against — the marks were on the map alone, which is where the
  comparison could not be made.

- **Tick any number of genomes or sequences and see them as one map.** Each on
  the diagonal and every block between them off it — the picture the pair view
  showed for exactly two, without the two diagonals that make an off-diagonal
  block readable. Both tables carry checkboxes now, with "select all" over
  whatever the filters leave visible (filter to completeness above 90, then take
  all of them) and "clear"; the button names two and counts more, because
  `MAG_7 × MAG_12 →` is worth more than a number and four names are longer than
  a button.

  It is a view state — `view=selection&genomes=a,b,c`, or `regions=` for
  sequences — so a selection is a link, a history entry and a back button, and
  `genomes=a,b` is precisely what `view=pair` used to be. The pair view stays
  where it is: the overview's cross-genome clicks lead there and so do links
  already sent.

  The read is the whole-file scan with most of the file left out. A selection is
  scattered through the pixels, so there is no shorter span to walk — the gate
  says so, and the progress bar and cancel are the ones the whole-genome read
  just gained. The axis is built from the selection in *file* order rather than
  the order it was ticked in, because a matrix whose rows jump about is a
  picture of the clicking; it is pooled against its own size, so four MAGs are
  drawn at four MAGs' resolution however large the file they came from is; and a
  genome resolves to its contigs, so ticking four MAGs and ticking their contigs
  are the same map. Checked on every fixture against the same oracle the pooled
  read uses: a scattered selection equals the dense block rolled up over the
  same grouping, cell for cell.

- **The app says what it is on the way in.** The mark — the same drawing as the
  favicon, the install prompt and the dock icon — is now a masthead on the
  landing page: mark and name on one line, centred, spanning 80% of the drop
  zone below them, with the tagline under and 20 px of air above. Both are
  scaled by one `clamp`ed font size, so the pair stays one thing from a phone to
  a wide window. In the header
  it sits at 26 px before the name, sharing its centre — the brand row was
  baseline-aligned, and an image's baseline is its bottom edge, so the mark hung
  visibly high against the words. The first screen used to open on an
  instruction, which made it a dialog rather than a page. It is read from the
  192 px file `npm run icons:app` already writes, not a fifth copy of the shapes.

- **"whole genome →" in the genomes and chromosomes tables.** The whole-file view
  was reachable from the chevron beside the root crumb and nowhere else, which is
  a corner of the window to find something the table in front of you is the
  question about. The metacool gets its scan, the cooler its map; the button is
  absent on a metacool's per-genome contigs table, where "the whole file" is not
  what is being asked.

- **The cooler's whole-genome read has a progress bar and a cancel**, the same
  two the whole-metagenome scan has always had — it is the same pass over every
  pixel of the same file, and the difference was in the plumbing rather than in
  the wait. What made it possible is the reader walking a span *asynchronously*:
  a cancel arrives as a message, and a synchronous loop never lets the message
  queue run however many microtasks it awaits, so a read that could take twenty
  seconds could not be called off and could not say how far along it was. The
  contig roll-up is watched the same way, since it walks the same pixels.

- **Hand-drawn marks can be saved.** The Manual annotations card grows the export
  row the Aesthetics panel has — a format, and a Save — writing lines as BED and
  loops as BEDPE, one base wide and half-open. Both come back through this app's
  own sniffer and parsers as an overlay on the map, which is the property
  `manual-export.test.ts` checks rather than the text; and both are what bedtools
  reads, because a coordinate someone chose outlives the session they chose it
  in. Nothing to write is a disabled button rather than an empty file.

- **The whole-genome view of a cooler is read at the resolution it is drawn at,
  and there is no longer a file size that defeats it.** It used to ask for one
  cell per file bin, which at 24,228 bins is 2.3 GB of values in one array — and
  a browser serves at most 2 GiB in one, whatever the machine has, so a whole
  yeast genome at 500 bp was offered, computed for several seconds, and then
  refused. The picture it was refused for was one nothing could have shown: the
  renderer pools any raster to 4,096 px per axis, so those 24,228 rows were
  always going to be drawn as about 4,000 pixels.

  So the pooling moved to the read. Every `stride` consecutive bins of a
  chromosome are summed into one cell, in the worker, straight from the stored
  pixels — the block that arrives is the one that was always going to be drawn.
  Yeast at 500 bp is 4,047 cells and 66 MB instead of 24,228 and 2.3 GB; at
  200 bp, where the dense block would have been 14.7 GB, it is the same 66 MB.
  A human cooler at 10 kb, 381.9 GB dense, is 67 MB and 760 kb cells. The read
  is bounded by construction at every bin size a file can have.

  **What arrives is an ordinary block one bin size up**, not a new kind of
  object: the stride restarts at every chromosome, so a cell is `stride` bins of
  one sequence and a run of cells is that sequence. The panel is told the coarser
  bin size and every coordinate, tick, tooltip, region box and figure caption is
  then right without knowing pooling happened — a box drawn on the 3 kb overview
  still opens that region at the file's own 500 bp. It is the relationship an
  `.mcool`'s 5 kb level has to its 1 kb level, computed on the way through rather
  than stored, and the sums are identical to `metacooler aggregate` over the same
  squares (`pooling.test.ts` checks every fixture, cell for cell, against the
  dense read rolled up by the existing folded aggregation).

  What the view still costs is the pass over the stored pixels, which is what it
  always cost, and that is now what it asks about: above ten million pixels the
  map waits behind a button that states how many there are and what resolution
  they will be summed into. Below it nothing is asked. The whole-metagenome scan
  is gated for that same reason, and the two views now behave alike down to the
  wording.

- **Both whole-file views are kept across navigation.** They are the expensive
  reads, so the shell holds whichever one it built, keyed on what was read (uri,
  level, balance): leaving one for a chromosome and coming back returns to the
  picture rather than to the gate. Changing the level or the balance is a
  different read, so that one is rebuilt and the old block released rather than
  left in memory unread.

### Removed

- **Captions on hand-drawn marks.** A text box under every mark, for a sentence
  the figure already makes. Gone from the card, from the model and from the
  drawing — and with it the label helper, the halo it needed and the type size it
  was written at.

### Fixed

- **A right-click on the map no longer navigates.** `mousedown` fires for every
  button, and the map's press/release pair had no guard, so a right-press was
  answered as a click on release: right-clicking a whole-genome view opened
  whatever cell was under the pointer, and the menu the press was for arrived
  over the view it had just left. The primary button only, now — and the same
  guard on the side panels' drag handle, where a right-press armed a resize the
  browser's own menu then sat on top of.

- **Both ends of a loop are marked on both 1D axes.** A loop is a statement
  about two loci, and a reader looking at the tracks under one end of it is
  asking what is at the other. Drawing the row anchor only beside the map and
  the column anchor only under it answered half of that on each edge, and
  neither half where the comparison is made.

- **The masthead's mark sits on the word's centre line.** Centring the two boxes
  left it visibly high: a line box carries the font's ascent and descent, so the
  ink of a word sits below the middle of its box while a square's ink is its
  box. Measured on the rendered pixels — 10.5 px of offset at a 97.6 px font —
  and corrected in `em`, so it holds at every size the `clamp` produces.

- **A block too large for one typed array says which limit it hit.** A browser
  serves at most 2 GiB in a single `Float32Array` whatever the machine has:
  measured in Chrome on a 16 GB Mac, 2,140,000,000 bytes is served, `2**31 - 4`
  is not, and four separate 1 GB arrays live side by side. It is a limit on one
  array, not on the tab, and the refusal used to blame "this machine".

  It is now checked ahead of the memory budget and cannot be overridden by a
  confirmation, because there is nothing to override; the message names the
  largest square block that can be made (about 23,170 × 23,170 bins) and the ways
  through. The whole-genome view no longer reaches it at all — it reads pooled —
  so what it governs now is a region, a genome or a pair.

  A test asserted that yeast at 500 bp loads densely, and was passing, because it
  exercised the *estimate* and the estimate never tried to allocate anything.

- **The Annotations panel scrolls as a whole, not card by card.** Twelve little
  scrollbars where the reader wanted one. `overflow-x: auto` was set on the cards
  so a wide one could scroll sideways inside a narrow column — but a box with
  `overflow-x: auto` and `overflow-y: visible` is not a thing CSS has: the
  visible half computes to `auto`, so every card was a scroll container in both
  directions, and a flex item shrinks by default, so each one was squeezed and
  scrolled inside itself the moment the panel was full. `flex: 0 0 auto` on the
  cards is the whole fix. `.side` keeps the opposite behaviour deliberately: a
  view's sidebar fills the column so its contig list can scroll where it is.

- **Less white between a key and its value in the File card.** The key column was
  a fixed 9rem, set when values were elided and had to start at a predictable
  place. They run to their full width now, so there is nothing to line up with,
  and the column takes what its longest key needs.

- **More room before any of that.** The memory budget is now half of what the
  device claims rather than a third, and the assumed memory where the browser
  says nothing — Firefox and Safari, on every machine — is 8 GiB rather than 4.
  A 20,000-bin block, 1.9 GB, was refused outright on both of those engines and
  now loads. Guessing high costs nothing since the allocation itself is caught
  and translated; guessing low was costing pictures the machine could draw.

- **The whole-metagenome view is a view state, not a mode the shell holds.** It
  was the only landing view of a file with no link, no history entry and no back
  button — pick it and the URL did not move, so it could not be shared, and
  reloading landed on the genomes table. It is `view=overview` now, a peer of
  the two tables it shares the root menu with, and everything that follows from
  that follows: the level and the colour scale are in the hash like every other
  view's, the back button leaves it, and the plot re-measures when a side panel
  is dragged — which, being mounted outside the shell's own view slot, it did
  not.

- **The three panels resize — which, despite 0.4.0, is the first time.** The
  drag handle, the remembered width and the double-click reset all shipped, and
  none of them could be reached: the handle was a sticky flex item at the end of
  a column that was already full, so it was laid out *below* the fold, and
  `sticky` only holds an element that scrolling would carry away — it never
  pulls one up into view. The negative margin meant to cancel its height could
  not, because a percentage margin resolves against the containing block's
  width whatever axis it is on. So the strip was real, painted, and permanently
  out of sight.

  It is now positioned against the column, and the column no longer scrolls:
  its body does. The heading staying put while the cards move under it is the
  same change seen from the front.

### Changed

- **Saving a figure is one row: resolution, format, Save.** It was a DPI
  dropdown, then a line of two buttons labelled `PNG` and `PDF`, two rows
  further down — which made the choice of file into the action itself and left
  the resolution stranded above the thing it applied to. Now the row reads the
  way the sentence does: 300 dpi, PDF, Save. Both defaults are unchanged; PDF
  simply stops being the second button and becomes the one that is already
  chosen.

- **Cards in General scroll sideways rather than eliding or wrapping.** A URI
  cut off at `Hum66.met…` and a genome name broken across three lines are the
  same failure: this panel is where you go to read the identity of what is on
  screen, and an identity you cannot read whole is not one. Keys and values now
  keep to a single line and the card scrolls under them. Hovering still gives
  the full text, for the reader who would rather not.

## [0.4.1] - 2026-08-04

### Changed

- **A real app icon, dark, everywhere an icon appears.** The mark is the thing
  the viewer draws — a block-diagonal contact map, three genomes on the
  diagonal and two long-range contacts off it — on a macOS-style plate. It
  replaces the flat blue square with two white blocks, and it is now one
  drawing rather than two: `scripts/make-app-icons.py` renders the browser tab
  favicon, the install prompt's 192 and 512, a new `apple-touch-icon.png` for
  the iOS home screen, and the 1024 square electron-builder derives every
  macOS, Windows and Linux icon from. The favicon is written into `index.html`
  by the same script, from the same constants, so the tab icon and the dock
  icon cannot drift apart the way the two hand-kept drawings could.

  The dark variant is the one that ships at every size. The light one is still
  drawn, into an ignored `out/`, so the mark exists in both values — but
  nothing in the build reads it.

  The plate's edge is now a ring band — the difference of two squircles, filled
  with a vertical gradient — rather than a stroked outline clipped back to the
  silhouette. The old way drew the border at full strength and then threw most
  of it away in the compositing, against a mask whose own edge is antialiased,
  which is why the light plate had a border only in the sense that something
  was there. Each variant now names a `rim` and a `bevel`: the light plate gets
  a warm dark hairline with a white highlight inside it, the dark plate the
  white hairline it already had, crisper.

- **The Linux window carries the icon too.** electron-builder installs the
  launcher entry and the hicolor ladder, but the window itself is drawn from
  what the process declares, so the taskbar and the alt-tab switcher showed the
  default Electron icon. `build/icon.png` now ships beside the asar as an extra
  resource and `BrowserWindow` names it. No change on macOS or Windows, where
  the bundle and the `.exe` already answer that question.

### Removed

- `scripts/make-app-icons.mjs`, superseded by `scripts/make-app-icons.py`. It
  wrote the same three files, so leaving it would have meant one `npm run
  icons:app` away from silently reinstating the old mark. `icons:app` now runs
  the Python script and takes `METACOOLER_PYTHON` the way `fixtures` does; it
  needs `pillow` and `numpy`, and the icons it draws stay committed, so no
  clone and no CI runner has to have either.

## [0.4.0] - 2026-08-04

### Added

- **Three named panels — General, Annotations, Aesthetics — all foldable and all
  resizable.** They had grown into three unrelated things: a sidebar with a fold
  button, a column added beside it with a fold button copied from it, and a
  controls column with no button and no name at all. They are the same object, so
  they are now one; what differs is a name, a side and a default width. Drag a
  panel's inner edge to resize it, double-click the edge to reset it, and both
  the width and the fold are remembered. <kbd>b</kbd>, <kbd>a</kbd> and
  <kbd>m</kbd> fold them. A card too wide for the column it is in scrolls inside
  it rather than spilling out of it.

- **The tracks pan and zoom the map.** A lane is a picture of the same window the
  map shows, drawn through the same scales, so dragging one and dragging the map
  are the same gesture on the same data — and a track you could read but not move
  was an exception a reader had to discover. Dragging a bottom lane scrolls the
  columns, dragging a right lane scrolls the rows, and a wheel over either zooms
  exactly as a wheel over the map does. The lanes carry the map's arrowhead
  cursor for the same reason.

- **An annotations panel of its own**, between the file sidebar and the map. The
  three annotation cards used to live in the file sidebar, folded in under the
  record card, and shared its scroll box: a growing list of tracks bought its
  height by pushing the file's own identity off the top of the screen, and
  folding the sidebar to get the room back took the annotations with it. They
  are now a column with its own fold (a `layers` button beside the sidebar's, or
  <kbd>a</kbd>) and its own scroll. The two left columns are ordered outward from
  the map by how often they are touched.

- **The colour and the name are edited where they are shown.** Clicking the
  swatch in a row opens the colour picker; clicking the name edits it in place.
  Both were fields behind the settings disclosure, which made the two commonest
  changes to an annotation among the most expensive. They are no longer offered
  in the settings, because they are no longer hidden.

- **Rows can be reordered**, by dragging the grip or by focusing it and pressing
  the arrow keys. The order is the order the lanes are stacked in beside the map,
  so this replaces removing three tracks and dropping them again in the order you
  wanted.

- **One hairline, and every value at once, when you point at a track.** Hovering
  a lane draws a single line — not a crosshair — across the lane stack and the
  map, at the position under the pointer, and the tooltip reads out *every* value
  track on that edge at that position rather than only the lane being pointed at.
  The lane the pointer is in is marked. A gene or peak under the pointer is
  described underneath.

- **Placing marks by clicking the map is a mode**, not a single shot. "Pick on
  map" stays on and becomes **Done**; every click places a mark until Done or
  <kbd>Esc</kbd>. Marking up a figure is eight gestures, not one, and the trip
  back to the sidebar between each was the whole cost of the feature.

- **Autoscale groups are a picker.** A group is only a group once two tracks are
  in it, so the second track has to be given the *same* name as the first — and
  the free-text box gave no way to find out what that was. A misremembered name
  raised nothing; it quietly made a group of one. The list is now the memory, and
  `new group…` is where a name is coined.

### Changed

- **The centre column stays light in the dark theme.** A contact map is a
  *figure*: its colormaps are built for ink on white, its labels and frame are
  drawn in the greys `ops/show.py` uses, and what leaves as a PNG or a PDF is
  light whatever the screen was. Letting the theme through meant the picture on
  screen was not the picture exported — and the halo behind every label, which is
  the page background, turned black behind dark grey text on a white plot.
  Everything around it — header, panels, status bar — is dark as before.

- **The lane tooltip names the position, not the lane.** The lane is the one the
  pointer is on, which the pointer already says and the marked row repeats; the
  heading is now the coordinate alone. Values read `name: number`.

- **The `auto` limit is a button**, bordered while it is on, rather than a tick
  box — and typing either bound turns it off, which is the only thing typing a
  bound can mean. The tick box was a third control on a row that already held two
  number boxes, and it took the width that made them overflow their card.

- **The annotation cards have lost their subtitles.** Each drop area under the
  heading already says what it takes and how it is drawn.

- **A new annotation is drawn on the right edge**, not the bottom. The bottom
  already carries the coordinate axis, the block labels and the colourbar
  caption, and a stack of tracks there pushes the map up the page; the space
  beside it is empty in every view. Both tick boxes still work as before.

- **Lane height is typed in pixels**, with the drawing style beside it, in place
  of a slider. A slider is for a quantity with no natural unit, and this one has
  the most natural unit there is.

- **Track limits are trimmed** the way the colour clip's boxes already were, and
  capped at three decimals. A bigWig header stores `float32`, so the faithful
  seed for a limit was `0.03999999910593033`.

- **Loop calls are ringed once**, on the upper side of the diagonal, instead of
  on both. The matrix is symmetric, so ringing both said the same thing twice —
  and on a set of any size the second ring was a few hundred circles the reader
  has to check against the diagonal to know they are not a second set. A view
  whose two axes are different blocks still shows the one placement it can.

- **A track's summary no longer counts the file's zoom levels.** That is a fact
  about how the bigWig was built rather than about what is in it, and it pushed
  the value range — the number a reader can act on — onto a second line.

### Removed

- **The per-track `linear`/`log2` scaling option.** It was a dropdown whose
  effect on a lane forty pixels tall was hard to read and easy to forget having
  set, and it put a lane on a different value axis from the one beside it, which
  is the opposite of what the autoscale group next to it is for. A ratio that
  wants a log axis is better written that way by the tool that made the bigWig,
  where the axis label can say so. A stored session that had `log2` set comes
  back linear.

### Fixed

- **The colourbar no longer disappears when tracks are shown.** Assigning
  `canvas.width` clears a canvas, and the legend's redraw was guarded on the
  colour *scale* having changed — which a resize does not change. Adding a track
  was enough to trigger it: the lanes relayout the plot, the resize observer
  fires, the bar is cleared, the guard says the scale is the same, and the legend
  is gone for as long as the view lasts. The invariant now lives inside `resize`,
  where a third caller cannot forget it.

- **A right-hand lane stack no longer overflows the column it is in.** The map's
  height budget accounted for the tracks stacked *under* it but its width
  accounted for nothing stacked *beside* it, so nine tracks on the right edge ran
  out under the view controls — where the far half of the stack was not merely
  off-screen but could not be hovered at all. Unreachable before this release
  because the bottom edge was the default; the default is now the right one.

## [0.3.0] - 2026-08-04

### Added

- **Tracks and annotations, on cool and mcool files.** Three cards in the left
  sidebar, and everything they draw. See [SPECS §8](SPECS.md#8-tracks-and-annotations).

  **Linear annotations** takes one GTF or GFF gene model, any number of bigWig
  tracks, and any number of BED-like segment files (BED 3–12, narrowPeak,
  broadPeak). Each is drawn beside the map on the bottom edge, the right edge or
  both, with its own colour, height, style (line, area or bars), value scaling
  (linear or log2), and limits — auto, which rescales to what is on screen, or a
  pair of numbers. Tracks that share an autoscale **group** resolve to one range
  over everything they show, which is the only way two of them can be compared
  by eye.

  **Map overlays** takes BED-like files as marks on the diagonal — a box for an
  extent, a mark across the diagonal for a point call, which is the only shape
  that survives being zoomed out — and BEDPE-like files as circles off it. A
  headed table with `chrom1/start1/end1/chrom2/start2/end2` counts as BEDPE,
  because that is what loop callers actually emit.

  **Manual annotations** takes vertical, horizontal and crossed lines, and
  arrowheads on or off the diagonal. Both are entered as coordinates or placed
  by clicking the plot, and both are stored in base pairs, so they survive a
  zoom, a pan and a change of resolution in an `.mcool`.

  Nothing drawn on the map fills the pixel it is about: loops are open circles,
  domains are outlines, and the arrowhead sits *outside* the cell it points at,
  on the far side from the diagonal — mirrored below it, so a mark placed while
  reading the upper triangle never points into the map from the lower one.

  Everything stays locked to the matrix because it is drawn through the matrix's
  own coordinate scales; nothing here computes a second mapping. Panning and
  zooming perform **no I/O**, as they already did for the map: a track fetches a
  window half again as wide as the view at a resolution rounded to a power of
  two, and everything inside that redraws from memory. Zooming out averages
  through bigWig's own zoom levels, and a feature lane with more features than
  pixels switches to a density profile rather than painting a solid bar. Hovering
  a lane names the feature or reads out the value; the crosshair continues from
  the map into every lane; exported PNGs and PDFs carry the lanes, redrawn at
  the export resolution.

  Contig names are checked on load and the overlap is always reported, in both
  directions — a GTF using `chrI` against a map using `I` is the most likely
  support question there is, and it presents as a broken feature rather than as
  two files disagreeing.

  Restricted to cool and mcool. On a `.metacool` the cards are **absent**, not
  disabled: a metagenome's axis is contigs from thousands of independently
  assembled organisms, so a file keyed on contig names either coincides with it
  or misleads.

- **One click loads the ten tracks published beside the yeast micro-C map.**
  Gene models, MNase, ATAC, Pol II ChIP-over-input, stranded RNA-seq, shotgun
  coverage, two peak sets and the loop calls — all on that map's own assembly.
  Offered only when the map itself came from a URL, never for a local file that
  happens to share the name.

- **The tooltip says how far apart a contact is.** Hover an off-diagonal cell
  within one chromosome or contig and it now reports the genomic distance
  between its two ends, which is the number a Hi-C map is actually read by. It
  is deliberately absent where there is no answer rather than shown as a large
  one: a trans cell has no distance along a sequence, and on the diagonal it is
  zero.
- **The tooltip names the genome, in the whole-genome view of a metacool.**
  It led with the contig, which on a metagenome is the finer half of the answer
  and rarely the one you want first. The genome now leads and the contig sits
  under it; a cell between two genomes names both. The picture underneath is
  unchanged — the separators are still the contigs.

- **A fifth example: a yeast micro-C map at one resolution.**
  `Yeast_microC_G2M_1kb.cool` — 16 chromosomes of synthetic yeast, 1 kb bins,
  179 M contacts, balanced. It is the first single-resolution cooler in the
  picker, so it is also the choice that lands somewhere with no resolution
  ladder to pick from.
- **Ten track resources published beside it**: MNase, ATAC, Pol II
  ChIP-over-input and stranded RNA-seq coverage, shotgun coverage, ATAC and Pol
  II peak calls, gene models, and the loop calls made on that map. They are not
  in the picker; the annotation cards above are what reads them. All ten are on
  the map's own assembly rather than on R64 — same 16 contig names, same
  lengths, no coordinate off the end of a chromosome — which is the property to
  check before republishing any of them. See
  [docs/deploy.md](docs/deploy.md#the-track-resources).

- **Works offline, and installs.** After one visit the app runs with no network at all — reload
  included — and browsers offer to install it as a standalone window. The app is cached; the data
  never is, and requests for it reach the network untouched. A new build is offered as a reload
  rather than swapped in underneath you.

- **A desktop application, for machines that cannot reach the website.** The same
  bundle packaged with Electron: a `.dmg` and a `.zip` for macOS (Apple Silicon and
  Intel), an NSIS installer for Windows, an AppImage and a `.deb` for Linux. It is a
  delivery channel and not a second feature set — it opens exactly the files the web
  build opens, in exactly the same way, with the same reader and the same privacy
  claim, and it never writes anything back. There is no auto-update: a new version is
  a new download. The first releases are **unsigned**, so macOS and Windows will each
  warn once before running it; [docs/desktop.md](docs/desktop.md) gives both warnings
  verbatim with the exact click that gets past them. The web app is unchanged — same
  URL, same build, nothing to install.

  It has a native menu, and one capability the web app cannot have: it asks
  remote hosts not to compress. `Accept-Encoding` is a forbidden header name in
  a page, so a `.metacool` served with `Content-Encoding: gzip` — which is what
  GitHub Pages does — is refused by the website with no way around it. The
  desktop build sets the header from outside the page, so the same file on the
  same host opens.

- **The footer states the privacy claim, which it had been promising to.** The
  dismissable notice on the picker says the footer keeps the same statement, and
  `StatusBar` asserted it in its own documentation, but nothing rendered it — so
  dismissing the notice removed the claim from the app. The statement is also
  reworded, in both targets, from "leaves your browser" to "leaves this machine":
  the first is false in a window that is not a browser, and the second is true in
  both.

### Changed

- **A selection opens a region instead of zooming.** Option-drag draws a square —
  it always resolved to one, so drawing a rectangle promised something it would
  not give — and releasing it opens what the square covers: the chromosome or
  contig the drag began in, ending at the edge of the box or of the sequence,
  whichever comes first. On the whole-metagenome view, where no smaller region
  exists, it opens the genome. Zoom is still the wheel, the keys and pinch.
- **Two fingers sideways go back and forward** over the heatmap, as they already
  did everywhere else on the page.
- **A selection in the trans corner opens the intersection**, not one of the two
  sequences: the rectangle between two chromosomes, or the genome pair. On the
  diagonal it is still one region.
- **Switching resolution in an `.mcool` keeps the view** you were in — the same
  genome, contig and range at the new bin size — instead of returning to the
  landing table. The colour clip is not carried, because it is in counts and
  counts scale with the bin.
- **A pooled picture says so.** Above 4,096 bins on an axis the raster is pooled,
  one pixel per block of bins carrying the strongest value under it; the summary
  now reads "drawn 4 × 4 bins to a pixel" and explains why the crosshair reports
  several coordinates inside one square, and why zooming does not sharpen it.

### Fixed

- `w` opens the whole-genome view again. The repaint short-circuit could not tell "nothing changed"
  from "show me the other picture of the same thing", and swallowed it.

## [0.2.0] - 2026-08-03

The first numbered release: everything below was built under `0.1.0`, which was never cut.

### Added

- **Opening files.** Drag and drop a local `.metacool`, `.mmetacool`, `.cool` or `.mcool` — read in
  place through the Emscripten filesystem, never uploaded — or a URL, read over HTTP range requests.
  The published demo datasets are offered as examples. A collection opens at one of its entries and
  offers the rest; an `.mcool` resolution ladder is a dropdown in the breadcrumb.
- **Tables.** A sortable, filterable genomes table as the landing view, with every metadata column
  the file carries and the free `bin1_offset` density proxy; the same for contigs. Filters, search
  and sort are remembered per file and per table.
- **Views.** One genome; the rectangular block between two genomes; a region, or the rectangle
  between two contigs; a cooler's whole genome; and the gated whole-metagenome overview, computed by
  one pass over every pixel or read from a sidecar edge list.
- **The heatmap.** Pan, drag-to-zoom on a modifier, wheel zoom, touch gestures, keyboard pan and
  zoom, a crosshair, a hover tooltip and a coordinate readout. `metacooler show`'s colour rule
  (`log1p`, 99th percentile) with typed clip bounds, a colormap picker including colour-vision-safe
  ramps, and balanced counts where the file carries weights.
- **Axis furniture.** Block names in the gutters, boundary ticks outside the plot, base-pair ticks on
  an axis with a single coordinate system, and dividers over the data. Each toggles independently.
- **Export.** PNG and PDF at 96–600 dpi, re-rendered rather than screen-grabbed, captioned with the
  file, genome, framed range, bin size, scale and time, and named with a timestamp.
- **The shell.** A file-info sidebar with a card for the row behind the current heatmap, a command
  palette, a keyboard-shortcut dialog, a light/dark/system theme, a status bar reporting bytes read,
  and an opt-in deep validation of the open file.
- **Deployment.** A static bundle published to GitHub Pages on every push to `main`, with the base
  path resolved at build time.

### Changed

- The whole-metagenome overview opens at contig level, marks genome blocks, and answers a click with
  the genome or the genome pair rather than a single contig.
- Axis labels appear as soon as fewer than fifty blocks are *in view*, so zooming brings out the
  names of a 20,000-contig map; contigs over 50 kb are labelled whatever the count. Clicking a label
  opens what it names.
- The view's controls are a column of the shell, scrolling on their own beside the plot.
- Reading, rendering and sorting were reworked for large files: a windowed pixel read, a pooled
  raster, memoised bin→unit maps, and sorting once per column rather than once per keystroke.

### Fixed

- A region no longer reaches into the next chromosome on a file whose bin table is not
  `binnify(chromsizes, binsize)` — five yeast chromosomes at 2 kb, where the extra bin also cost the
  view its base-pair ticks.
- A press no longer scrolls the canvas out from under the pointer, which made clicks near a genome
  boundary open the neighbour.
- Toggling labels no longer crops a fitted view.

## [0.1.0] - unreleased

The version the package carried while the viewer was being built. Never tagged and never deployed
under that name; its history is in the commit log.
