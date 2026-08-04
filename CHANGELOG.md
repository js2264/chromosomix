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
