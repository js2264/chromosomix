# MULTIRES-ZOOM — zoom that refines

*A feasibility study and an implementation plan for progressive refinement in `chromosomix`.*

Status: **built.** This document was written as a feasibility study, and what it proposed is now on
disk — with four of its five v1 exclusions overruled, which is the largest change between the plan
and the thing. §11 records what was decided, what that changed, and what was found by driving the
app that no test had caught.

Every claim about the code *as it was before this work* carries a `file:line` anchor and was read
rather than remembered; where the source's own comments and its code disagreed, this document said
so and followed the code. Anchors into files this work then changed have moved by a few lines; the
symbols are still the right ones.

---

## 0. The one-paragraph answer

Zoom-to-refine is **feasible**, and it is a smaller change than the specification's language implies.
It needs **no tile server, no tile cache, no resolution pyramid and no change to the worker
protocol** for its first and largest phase. The reason is that the reader *already* chooses a
resolution from the extent it is asked for — `fitPlan` (`src/worker/reader.worker.ts:414`)
binary-searches the finest grid that fits 4,096 cells per axis for whatever bin range a request
names — and it *already* anchors that grid to the sequence rather than to the request
(`snapToGrid`, `src/worker/reader.worker.ts:473`). "Refine on zoom" is therefore, mechanically,
**re-issuing the same `matrix` request with the extents narrowed to what is on screen**. What is
missing is not machinery. It is a caller that re-asks, a seam that swaps the block without moving
the picture, and a policy that decides when. All three have working precedents inside this
repository — one of them, `SampleCache` (`src/annotations/samples.ts`), is a complete
zoom-driven progressive-refinement loop that ships today, for the tracks drawn on the very same
axis as the map.

Of the four clauses SPECS §2 uses to refuse this (`SPECS.md:36-38` — *"no tiling, no LRU tile
cache, no resolution pyramid, no progressive refinement"*), **three stay true**. Only the fourth
has to be amended, and only in a bounded form: two blocks resident, refine inward only, terminating
at the file's own bin size.

---

## 1. Context, in the terms this question needs

### 1.1 What the app is

`chromosomix` is a browser-only viewer for `.metacool` metagenomic Hi-C contact maps, and
natively for `.cool` / `.mcool` / `.mmetacool`. Three constraints generate the whole design
(`SPECS.md:10-24`): **no backend of any kind**, **nothing is uploaded**, and **no preprocessing and
no required companion file**. There is no tile server because there is no server; a published file
is an object on a bucket read through HTTP range requests, and a local file is handed to a worker
and read in place through the Emscripten filesystem.

### 1.2 The bet, and what it bought

SPECS §2 states the load-bearing assumption: **MAGs are small**. A bacterial genome is 2–6 Mb, so
at 1–5 kb bins one MAG's matrix is a few hundred to a few thousand bins — a bounded, contiguous
slice of `/pixels`. One genome is one bounded read, held whole, after which

> the entire matrix is loaded in one bounded read and held in memory; pan and zoom are pure canvas
> operations with **zero** further I/O; no tiling, no LRU tile cache, no resolution pyramid, no
> progressive refinement. (`SPECS.md:36-38`)

That is restated at every layer — §5.2 (`SPECS.md:200-201`), §7.2 (`SPECS.md:536-538`), §12's
budget row *"Pan/zoom within a loaded genome | 0 requests, 60 fps"* (`SPECS.md:1092`), §13's
non-feature list (`SPECS.md:1120-1125`), §14's through-line (`SPECS.md:1156-1160`), §16's opening
(*"a panel is not a viewport onto a stream: it is a whole bounded block, held whole"*,
`SPECS.md:1230-1232`) — and it is enforced in code by a structural fact rather than a check:
**`MatrixPanel`, the widget that owns pan and zoom, holds an `AnnotationClient` and no
`ReaderClient` at all** (`src/ui/MatrixPanel.ts:515`; the header comment at `:8-11` calls this
structural rather than a promise). `src/render/heatmap.ts` imports nothing from `src/worker/`.

The bet paid. It deleted the tiling architecture, the cache-eviction policy and the progressive
renderer, and it is why the app opens a 26 MB, 4,395-MAG MetaTOR output on a laptop with the
network cable out.

### 1.3 What the app grew into

Two things happened after §2 was written, and both are recorded in the spec itself:

1. **cool and mcool became native, with whole-genome views where they fit** (§9,
   `SPECS.md:999-1035`). A yeast genome at 1 kb is 12,100 bins. A human chromosome at 5 kb is
   49,792 bins. Both are far past the small-MAG assumption, and both are now first-class views.
2. **Pooled reads were introduced** (`src/metacooler/pooling.ts`) so those views could exist at
   all: consecutive bins summed into one cell, *in the worker, from the stored pixels*, capped at
   `POOLED_CELL_CAP = RASTER_MAX_DIM = 4096` cells per axis
   (`src/metacooler/pooling.ts:49`, `src/render/heatmap.ts:69`).

The consequence is the gap this document is about. A whole-genome view of a cooler arrives already
coarsened, and **no amount of zooming recovers the detail**, because the coarsening happened in the
read. The app is honest about it: `poolingNote` puts *"aggregated 3 × 3 bins to a pixel"* under the
picture (`src/ui/MatrixPanel.ts:5974-5984`; drawn by `WholeView.ts:709` and `GenomeView.ts:266`),
and its docstring says why in full:

> Two things a reader needs and cannot deduce: that the picture is pooled, and that **zooming does
> not sharpen it** — the pooling is per block, not per view, so the answer is to open a smaller
> block, not to magnify this one. (`src/ui/MatrixPanel.ts:5967-5969`)

That is a coherent design and it is well documented. It is also not the interaction a HiGlass or
Juicebox user has in their hands.

### 1.4 What the code actually does on a zoom, today

The transform is four scalars on `HeatmapView` (`src/render/heatmap.ts`): `zoom` (CSS pixels per
matrix cell), `baseZoom` (the zoom at which the block fits), and `originX`/`originY` (the
block-local, fractional cell coordinate at the plot's left/top edge). Every mutator — `fit()`
(`:1841`), `panBy()` (`:1854`), `zoomAt()` (`:1866`), `zoomToBox`, `zoomToBand`, `showCellWindow()`
(`:1920`) — ends in the same four-step tail: mutate → `clampView()` → `syncScales()` → `changed()`.
`changed()` is bound by `MatrixPanel` to `schedule()`, a one-`requestAnimationFrame` coalescer.

The frame does, in order: `syncTurnDepth()`, `syncLaneMetrics()`, `heatmap.draw()`, `lanes.draw()`,
the view phrase, the colour key, and finally the viewport report to the deck lock
(`src/ui/MatrixPanel.ts:4753-4756`).

`draw()`'s *data* path is a `ctx.setTransform` plus one `drawImage` of a cached RGBA raster; the
separators, labels and overlays are redrawn on top every frame (`src/render/heatmap.ts:2510-2570`).
The raster is rebuilt on exactly three events — new matrix, new colour scale, new colormap —
flagged by `dirtyRaster` at `:1581`, `:1627`, `:1681`, `:1748`. `panBy` and `zoomAt` never set it.

**There is exactly one path in the app today where a zoom changes the data behind the picture**,
and it is zero-I/O: on a turned (45°) map, `MatrixPanel.syncTurnDepth()`
(`src/ui/MatrixPanel.ts:4157-4212`) re-cuts the band from the in-memory square block when the
reader zooms *out*, and installs it through `HeatmapView.reshape()` (`src/render/heatmap.ts:1623`),
which deliberately preserves `zoom` and `originX` instead of refitting. Its two cost defences are
the template for everything below: **act only when the picture is worse than the data it is cut
from** (`:4170`, `if (wanted <= turned.maxSeparation) return`), and **over-buy by 2×** so a gesture
costs one action rather than several (`:4177`, `turnDepthFor(data, wanted * 2)`).

### 1.5 What the reader has to do today to get finer data

Navigate. Concretely, one of:

- pick a locus (`region=contig:start-end`), which is a full view teardown and rebuild
  (`onChangeRegion`, `src/app/Session.ts:4042-4045` → `Session.navigate`, `:4183-4188`);
- drag a marquee, which resolves to a region and navigates;
- pick a contig from the contigs table;
- pick an explicit `.mcool` rung from the breadcrumb (`src/ui/Breadcrumb.ts:194-209`), which builds
  `path::resolutions/<binsize>` and re-`open`s the file (`src/app/Session.ts:1584-1589`, carrying
  everything but the clip through `carryAcrossEntries`, `:3117-3122`);
- or, in a deck, pick from a panel's `::1000` picker (`src/panels/MapPanel.ts:482-506`), which
  rewrites *that panel's slot ref* through `onResolved` → `PanelDeck.resolveRef`
  (`src/panels/MapPanel.ts:523-539`, `src/panels/PanelDeck.ts:756-760`) and reloads at
  `MapPanel.ts:540`.

Each of those is correct, addressable and shareable. None of them is a wheel.

### 1.6 The ladder is detected, and it was always meant to drive the zoom

The app classifies `.mcool` / `.mmetacool` entry sets already:

- an `.mcool` root is recognised **purely by the contents of `/resolutions`** —
  `h.keys('resolutions').length > 0`, checked *before* the `format === 'HDF5::Cooler'` branch
  (`src/metacooler/detect.ts:156-165`);
- entries whose names all match `/^\d+$/` and are `> 0` are a **zoomify ladder**, sorted
  numerically, and the name *is* the bin size (`orderEntries`, `src/metacooler/detect.ts:215-218`;
  the identical predicate is implemented a second time as `allIntegers`,
  `src/ui/FilePicker.ts:383-389`);
- otherwise they are a **sample collection**, in file order;
- the rung names are captured for free at open, at the **file root**, whatever group the handle is
  rooted at (`src/h5/Hdf5File.ts:81-102` → `Hdf5Handle.rootEntries` / `rootEntryGroup` →
  `OpenResult.entries` / `entryGroup`, `src/worker/protocol.ts:158-199`).

And the spec has asked for this to drive the zoom since the beginning:

> **all entry names parse as positive integers** → a `zoomify` resolution ladder. Wire the entries
> to the zoom control; hide the entry picker. (`SPECS.md:130-131`, §3.4)

> `.mcool` resolution levels are each fixed-bin, so §3.3's arithmetic applies unchanged; the levels
> drive the zoom control exactly as mmetacool entries do. (`SPECS.md:1032-1033`, §9)

README records the gap in the project's own words: *"The mmetacool resolution ladder is inferred
but not driven"* (`README.md:177-181`). `IMPLEMENTATION.md:235-236` lists the wiring as a task
inside M4.

So there is a genuine tension in the documents, and it is worth naming before proposing anything:
**§3.4 and §9 ask for the ladder to drive the zoom control; §2, §12, §13 and §14 forbid zoom from
costing a read.** Both readings are defensible — "wire the entries to the zoom control" can mean a
discrete resolution selector rather than continuous refinement — but the tension is real and this
proposal resolves it in favour of §3.4 and §9.

### 1.7 The precedent nobody has to argue for

The app already implements zoom-to-refine. Not for the map — for the **tracks drawn on the map's
own axis**, in the same panel, following the same pan and the same wheel.

`src/annotations/samples.ts` opens:

> The rule that keeps pan and zoom free of I/O, in one place. §2 says a pan performs no read, and
> §8.4 says the same of a track. That is not achieved by fetching less; it is achieved by fetching
> a *window wider than the view* at a resolution *rounded to a power of two*, and redrawing from
> what is in hand until the view leaves either. (`src/annotations/samples.ts:1-8`)

`SampleCache.samplesFor` (`:80-155`) is a complete progressive-refinement loop:

| Mechanism | Where |
|---|---|
| resolution quantised to a power of two, from bases-per-pixel | `samples.ts:117` |
| window padded 50 % beyond the view so a half-screen pan is free | `FETCH_PAD = 0.5`, `samples.ts:28`; `LocusAxis.windows(domain, pad)`, `render/locus.ts:167-186` |
| coverage check before refetching | `covers()`, `samples.ts:163-173` |
| in-flight de-duplication | `inflight: Set<string>`, `samples.ts:40` |
| stale-while-revalidate — *"a lane that blanks while it waits is not [invisible]"* | `samples.ts:69-74` |
| repaint on arrival, coalesced by the caller's frame | `onChange`, `samples.ts:45-46` |
| pruned against the store rather than driven by events | `prune()`, `samples.ts:57-67` |

SPECS §8.4 (`SPECS.md:839-842`) documents the policy as normative: refetch only when the visible
contig set changes or the required resolution crosses a factor of two — *"not once per frame, and
never during a drag."*

That is the reconciliation this whole proposal needs, already written down and already shipped:
**"pan and zoom are free of I/O" is a statement about the gesture, not about the session.** The
lanes honour it while refining. The map can too.

---

## 2. The question, stated precisely

"Zoom refines" can mean four different things. They have very different costs and only one of them
is being asked for.

| # | Reading | Cost | Verdict |
|---|---|---|---|
| **A** | Zooming into the block in hand re-reads the visible window at the finest grid that fits the picture, **within the currently open map** | one bounded read per settled gesture, *cheaper than the read that got you here* | **This is the proposal.** Works on every accepted file, ladder or not. |
| **B** | Zooming crosses **rungs of an `.mcool`/`.mmetacool` ladder** | one lazy `openHdf5` per rung over the retained byte source, then as A | **Phase 2.** An accelerator and a correctness fix, never a requirement (SPECS §3.4). |
| **C** | A **tile pyramid**: the view is a viewport onto a stream of fixed tiles, cached and evicted | a tile cache, an eviction policy, a seam-free compositor, a second render path | **Rejected.** SPECS §13, and unnecessary — see §3.2 below. |
| **D** | Zooming *out* past the block streams in wider data | bounded by the view's own domain; free through anything already read | **Built** (it was proposed as rejected — see §11.1). A widening read is clipped to the ceiling, so it can never become the gated full-file scan §7.3 prevents. |

Everything below is A, with B behind it.

---

## 3. Why it is feasible, and why it is small

Five facts, each verified in the source.

### 3.1 The reader already chooses a resolution from an extent

`handleMatrix` (`src/worker/reader.worker.ts:213-243`) does three things in order:

```ts
const asked = planOf(request.binsPerCell, request.contigsPerCell)      // :218
if (asked.binsPerCell > 1 || asked.contigsPerCell > 1) {               // :219
  return pooledResult(mc, request, request.rows, cols, asked)          // :220  ← raw extents
}
const planned = fitPlan(mc, request.rows, cols)                        // :222
if (planned !== null) {
  return pooledResult(mc, request,
    snapToGrid(mc, request.rows, planned),                             // :227  ← anchored
    snapToGrid(mc, cols, planned), planned)
}
const dense = await mc.matrix({ rows: request.rows, cols, ... })       // :232
```

`fitPlan` (`:414-439`) returns `null` when both spans already fit at `k = 1`, short-circuits to a
`contigsPerCell` plan when the axis has more sequences than cells, and otherwise binary-searches
the smallest `binsPerCell` for which `cellsIn(span, k) <= POOLED_CELL_CAP` on both axes.

**So a narrower request already comes back finer.** Every view except `WholeView` sends a bare
`{kind:'matrix', rows, cols}` with no plan at all — `RegionView.ts:290`, `GenomeView.ts:239`,
`PairView.ts:246`, `MapPanel.ts:701` — and reads the resolution it got back out of the response as
`binsize * (result.binsPerCell ?? 1)` (`src/panels/MapPanel.ts:788`,
`src/ui/RegionView.ts:311`, `src/ui/WholeView.ts:645`).

> **The single most important rule in this design:** a refine request must send **extents only**,
> never `binsPerCell`. A request that carries an explicit plan bypasses `snapToGrid` entirely
> (`reader.worker.ts:218-221`), which would anchor the cell grid at the pan position and make cell
> values change as the reader pans. That is the one way to break the anchored-grid invariant
> silently.

### 3.2 The grid is already anchored to the sequence, so levels nest exactly

`snapToGrid` (`:473-486`) widens an extent to `contigStart + m·k`, never to the request's own left
edge:

> The grid is a property of the sequence, not of the question … That is what makes a region behave
> like the chromosome it is cut from — the same base pair lands in the same cell, holding the same
> sum, in every view of it. (`reader.worker.ts:459-466`)

`test/unit/anchored-grid.test.ts:60` pins it — *"puts a base pair in the same cell whatever range
was asked for"* — though against a **restatement** of the rule rather than against `snapToGrid`
itself: the worker module runs `getH5()` at load and cannot be imported into a test, so the file
mirrors the arithmetic locally (`:28-39`) and tests the real `partitionAxis` beside it. A
regression in `reader.worker.ts:473-486` would not be caught. SPECS §3.3 (`SPECS.md:117-121`)
states the same property for a ladder's levels: `k = resolution / base_resolution`, integer, no
interpolation.

This is exactly the coherence a refinement scheme needs, and it is the reason **C (tiles) is
unnecessary**: because levels nest and cells are sequence-anchored, a coarse block and a fine block
of the same region agree cell-for-cell wherever they overlap. There is nothing to composite and no
seam to hide.

### 3.3 Refinement terminates, and the staircase is short

`POOLED_CELL_CAP = 4096`. A window of `W` bins therefore comes back at `k ≈ ceil(W / 4096)`, and at
`k = 1` — the file's own bins — once `W ≤ 4096`. **There is no level below the file's resolution,
so refinement has a floor and reaches it.**

With a factor-of-two hysteresis (refine only when the grid in hand is ≥ 2× coarser than the one the
picture could show), the steps are `k₀ → ⌊k₀/2⌋ → … → 1`, where `k₀ = ⌈nBins / 4096⌉`. Note that
the last step jumps straight to `k = 1` from `k = 3`, because `3/2 = 1.5` never crosses the
factor-of-two trigger:

| View | Bins | `k₀` | Refines to native |
|---|---|---|---|
| One MAG, 2–6 Mb at 1–5 kb | 400 – 6,000 | 1 – 2 | **0 – 1** |
| Whole yeast genome at 1 kb (`SPECS.md:1001-1002`) | 12,100 | 3 | **1** (`3 → 1`) |
| Human chr1 at 5 kb (`SPECS.md:1029`) | 49,792 | 13 | **3** (`13 → 6 → 3 → 1`) |
| A whole 4,395-MAG metagenome at contig level | pooled by `contigsPerCell` | — | n/a — see §D7 |

That is a **staircase of one to three bounded reads**, not a pyramid of fifteen levels and hundreds
of tiles. It is also why the primary case is unaffected: **for a MAG, zoom-to-refine changes
nothing, because the block already is the file's finest data.** The feature exists entirely for the
views the app grew into after §2 was written — whole-genome coolers, whole-chromosome regions, and
the pooled whole-file metagenome view.

### 3.4 Every refine is cheaper than the read that got you there

A bounded read costs one `indexes/bin1_offset` slice plus three contiguous `/pixels` column slices
per 1,000,000-pixel window (`readPixelWindow`, `src/metacooler/matrix.ts:387-397`;
`pixelSpanRange`, `:378-385`). The pixel count is `bin1_offset[hi] − bin1_offset[lo]` — the stored
pixels whose **row** bin falls in the window (`spanPixelCount`, `:319-324`).

`planRead` (`:523-530`) makes the span the row range for an on-diagonal or row-leading block, the
column range for a column-leading one, and their union when they overlap. So:

> **I/O scales with the window's span in bins, not with its area in cells.** So no single refine
> ever costs more than the read that drew the view, the first is the most expensive, and each one
> after costs about half the one before.

Concretely, for human chr1 at 5 kb (49,792 bins, `k₀ = 13`), the three refine points of §3.3 above are
windows of 24,576 / 12,288 / 4,096 bins. Padded 50 % and clipped to the anchor's own extent that is
36,864 + 18,432 + 6,144 = 61,440 bins of row band against the anchor's 49,792 — **about 1.2× the
anchor read spread across the entire zoom from whole chromosome to single bin**, with the largest
single step at **0.74×**. For a whole yeast genome at 1 kb it is one refine at **0.51×**. For a MAG
it is zero.

Two honest caveats. First, there is **no column index**: an off-diagonal window still pays for the
whole row band of its rows, and `pixelAccumulator` discards the pixels outside the column range
(`src/metacooler/aggregate.ts:309`). Second, the saving is a property of a file sorted by `bin1`,
which every accepted file is.

Remotely, each refine is the same shape of read the §12 budget already measures at **≤ 5 range
requests** for a MAG's matrix (`test/budgets/requests.test.ts:118-132`), helped by the
1 MiB-chunk / 64 MiB LRU cache and its coalescing of contiguous misses
(`src/sources/RemoteRangeSource.ts:30-34`, `:335-374`). Measured peak LRU occupancy on a full scan
is 14 of 64 chunks (`docs/performance-review.md:956-958`), so overlapping refines land warm.

### 3.5 Every mechanism the swap needs already exists

| Need | What exists today |
|---|---|
| install a differently-shaped block without refitting | `HeatmapView.reshape()`, `src/render/heatmap.ts:1623-1649` — written for the turned band, preserves `zoom` and `originX` |
| express the view as something two grids can exchange | `cellWindow()` / `showCellWindow()`, `:1896-1935`; the deck lock's currency is **base pairs** and it rounds outward, precisely so panels of different resolution can follow each other (`src/panels/lock.ts:1-43`) |
| convert the view to genomic windows | `MatrixPanel.framedWindows()`, `:5127-5133`, over `LocusAxis.windows(domain, pad)`, `src/render/locus.ts:167-186` |
| stop the colour scale moving under a data swap | the `gauge` argument to `setMatrix` — the auto range is measured from the gauge block and memoised, and `reshape` only invalidates it if a new gauge is passed (`src/render/heatmap.ts:1630-1641`, `:2947-2989`) |
| tell the panel its grid changed | `MatrixPanel.setResolution(binsize)`, `:3834-3836` |
| supersede an in-flight read | `ReaderClient.cancellable()`, `src/worker/client.ts:105-117`; cooperative `cancelled: Set<number>` polled between pixel windows, `src/worker/reader.worker.ts:82`, `:102-113`; a real macrotask yield so the cancel is actually delivered (`src/async.ts:29-44`) |
| report progress | `{type:'progress', id, done, total}`, `src/worker/protocol.ts:538` |
| a once-per-frame place to decide | `MatrixPanel.schedule()`'s rAF body, `:4702-4757` |
| a worked example of all of it | `SampleCache`, `src/annotations/samples.ts` |

---

## 4. What would have to break — and what would not

This is the section to read if the answer turns out to be "no". Almost everything on the "would
break" list is documentation.

### 4.1 The specification

Amendments, in dependency order. §2 is the root; the rest follow from it.

| Section | Line | What it says now | What it would have to say |
|---|---|---|---|
| §2 Scale assumptions | `SPECS.md:36-38` | *"no tiling, no LRU tile cache, no resolution pyramid, no progressive refinement"* | The first three stay. The fourth becomes bounded refinement: two blocks resident, refine inward only, terminating at the file's own bin size. |
| §2 | `SPECS.md:40-41` | HiGlass's streaming complexity *"is explicitly not built"* | Still true of tiles, a tile server and a cache-eviction policy. Reword so it names the mechanisms rather than the outcome. |
| §5.2 Genome view | `SPECS.md:200-201` | *"Zoom and pan operate on the in-memory matrix — no I/O"* | True during a gesture; qualify to *"…and a settled zoom past the block's own grid asks for one bounded read"*. |
| §7.1 | `SPECS.md:520-525` | the auto range is the percentile of the drawn pixels | Add the rule that it is measured once, from the anchor block, and does not move across a refine (which is what §17.6 already says for pan and zoom). |
| §7.2 | `SPECS.md:556-565` | *"One grid, and one place it is decided"* | **Unchanged, and load-bearing.** The refine must go through `fitPlan`/`snapToGrid`, never compute a grid from the viewport. |
| §8.6 Persistence | `SPECS.md:872-873` | a rung change is a fresh open | Phase 2 makes a rung a lazily-opened sibling on the retained source; the *addressable* rung is still a fresh open. |
| §9 cool and mcool | `SPECS.md:1032-1035` | levels *"drive the zoom control"* | Now true rather than aspirational. |
| §9 | `SPECS.md:1037-1039` | *"not a HiGlass replacement"* | Still true — no tile server, no whole-genome-human streaming — but the sentence needs to name what changed. |
| §12 | `SPECS.md:1092` | *"Pan/zoom within a loaded genome \| 0 requests, 60 fps"* | **Split into two rows** — see §4.2. |
| §13 | `SPECS.md:1120-1125` | *"tile server"* heads the non-features | Unchanged. |
| §14 | `SPECS.md:1154-1160` | *"a block either fits in one read or is refused, and there is no third path"* | This is the sentence zoom-to-refine contradicts most directly. The third path is: a block that fits is read; a block that does not is read *coarser* and then *refined inward* as the window narrows. |
| §16.2 | `SPECS.md:1277-1284` | the rung is a per-panel reader **choice** that sticks | A zoom-driven rung must be *subordinate* to an explicit pin: touching the picker pins the rung and refinement stops choosing. |
| §16.6 Links | `SPECS.md:1495-1497` | *"the hash has never carried a pan or a zoom"* | **Keep it.** See §8, last bullet — refinement is deliberately not addressable. |
| §17.2 | `SPECS.md:1710-1713` | a change of resolution destroys the panel | Phase 2's rung change must not, or the reader loses their tracks, box and framing mid-gesture. |

Also: `IMPLEMENTATION.md:230` (*"There is no tiling, no LRU cache, no progressive refine"*),
`IMPLEMENTATION.md:333` (Definition of Done), `README.md:48-54`, `README.md:167`,
`README.md:177-181`. `README.md:237-250` is **already stale** on the adjacent claim (it still says
cool/mcool are region-level only, which SPECS §9 superseded) and should be fixed in the same pass.

### 4.2 The performance budget

§12's row is enforced by `test/budgets/requests.test.ts` as `BUDGET.panZoom = 0` with a strict
`toBe`, plus `expect(source.rawReads, 'HDF5 was not even asked').toBe(0)` (`:42`, `:192-195`).

**A correction worth making explicitly, because several readings of this codebase get it wrong:**
that test does not exercise the UI at all. It opens a `MetaCooler`, calls `mc.genomeMatrix()` once,
then loops `crop()` + `rasterize()` over eight viewports at four zoom levels and calls
`mc.aggregate()` twice (`:169-199`). `crop` is a local helper documented as *"the way a zoomed
viewport reads out of it"* (`:70`). A refine implemented in `MatrixPanel`/the views would leave
every assertion in that file green.

That makes it worse, not better: the test would keep passing while the design claim in its own
comment — *"there is no tiling and no progressive refine precisely because this costs nothing"*
(`:179-180`) — became false. **It must be rewritten deliberately.** The proposed replacement:

| Operation | Budget |
|---|---|
| Pan/zoom within the block in hand | **0 requests, 60 fps** *(unchanged, and still true — refinement never runs during a gesture)* |
| Refine after a settled zoom | **≤ 5 range requests, one bounded read**, off the frame, cancellable |
| Zoom out to the anchor | **0 requests** |

### 4.3 The tests

Read as a specification of what must not break. Verified by opening each file.

| Test | Invariant | Verdict |
|---|---|---|
| `test/budgets/requests.test.ts:169` | pan/zoom is 0 requests and 0 raw reads | **Passes mechanically, must be rewritten anyway** (§4.2 above) |
| `test/unit/panel-deck.test.ts:418-465` | `planFor(state)` is a total function of `ViewState`, asserted with six whole-object `toEqual`s | **Would break** if `BlockPlan` gains a viewport term. It must not: the refine's extents ride beside the plan, not inside it (§D5). |
| `test/unit/viewstate.test.ts:26-63, :69` | hash round trip, `toStrictEqual` on ten cases | **Orthogonal** — refinement adds no `ViewState` key (§8). |
| `test/unit/viewstate.test.ts:324` | *"covers every optional key the serialiser knows about"* | Worth noting as a latent gap: the loop iterates a **hardcoded** list, not one derived from the serialiser, so a new key would pass it untouched. `score` already proves the failure mode is live — it is in `KEY_ORDER` (`ViewState.ts:57`) and never read by `parseViewState` (`:136-226`). |
| `test/unit/heatmap-navigation.test.ts:901` | *"re-cuts without moving the window"* — `reshape` preserves zoom and left edge | **The template to copy.** A refine that goes through `setMatrix` fails this class of assertion because `setMatrix` ends in `fit()` (`heatmap.ts:1590`). |
| `test/unit/heatmap-navigation.test.ts:933` | a value array of the wrong length is a reshape, never a blind swap | **Keep and reuse.** A finer block returns more values for the same window; this is the guard that stops it being misread. |
| `test/unit/heatmap-navigation.test.ts:958` | a band cut deeper than the box shows the same rows — the licence for not re-cutting on zoom-in, stated in the docstring at `:943-957` | **Orthogonal, and the precedent for the hysteresis rule.** |
| `test/unit/heatmap-navigation.test.ts:813-832` | the auto range comes from the gauge, not the crop | **Would break without care.** The anchor must be installed as the gauge (§D2, M1). |
| `test/unit/pooling.test.ts:212, :220-292` | the pooled read equals the dense read cell for cell, and never exceeds the cap | **Orthogonal**, as long as refinement goes through `fitPlan`/`poolBins` rather than a new read path. |
| `test/unit/anchored-grid.test.ts:60-77` | a base pair lands in the same cell whatever range was asked for — against a local mirror of `snapToGrid` (`:28-39`), not the reader's own | **Preserved only if the refine sends no `binsPerCell`** (§3.1 above). Worth closing the mirror gap in M0. |
| `test/unit/coarse-extent.test.ts:50-100` | a whole-chromosome region occupies exactly its own bins **at every resolution**, and the bin table beats the arithmetic on real files | **Phase 2 hazard.** Bin indices are not comparable across rungs; a cross-rung window must be converted through base pairs. |
| `test/unit/panel-lock.test.ts:168`, `:247` | a window translates between panels of different resolution without the deck oscillating; one hundred echo exchanges stand still | **Highest-risk interaction.** A refine that lands mid-broadcast re-emits a window derived from a new grid. Refinement must be silent to the lock (§D5, §7). |
| `test/unit/render-cost.test.ts:149` | zooming in culls to the visible domain, so it does *less* separator work | **Might break by design**: the point of refinement is that the drawn cell count stops shrinking with the zoom. |
| `test/unit/bins-guard.test.ts` | `/bins` is never read | **Orthogonal**, and a hard rail: nothing in a refine may reach for `/bins` to reconcile grids. |
| `test/unit/matrix.test.ts:162-189` | a bounded block reads exactly four datasets, in order (equality, not subset) | **Orthogonal** — but forbids adding a prefetch or a second index probe to the dense path. |
| `test/unit/dense-guard.test.ts:112-239` | the size guard is closed-form, pre-read and not overridable | **Never trips**, by construction: `fitPlan` caps the block at the same 4,096 the guard was written for. Only a refine that over-pads could trip it; budget the pad. |
| `test/unit/raster-scale.test.ts:110-122` | smoothing is on while minifying, off at ≥ 1 device pixel per cell | **Orthogonal but visible**: a correct refine drives cells-per-device-pixel toward 1, which flips smoothing off — a sharpening *pop* at the moment the block lands, independent of the data change. |
| `test/budgets/analysis.test.ts:237` | the two workers duplicate no more than the view's own block | **At risk**: the bound holds *because* the view holds one block. Two resident blocks doubles it. |

### 4.4 The copy

`poolingNote` (`src/ui/MatrixPanel.ts:5974-5984`) draws one phrase under the picture — *"aggregated
3 × 3 bins to a pixel"* — and its docstring (`:5967-5969`) states the rationale: **zooming does not
sharpen the picture, and the remedy is to open a smaller block**. The docstring becomes false the
moment refinement is on, and the phrase becomes a claim about a grid that is no longer stable. Both
have to change: the phrase into a live indicator (*"aggregated 3 × 3 · refining…"* → *"1 kb
bins"*), the docstring into the new rule. Its two callers are `WholeView.ts:709` and
`GenomeView.ts:266`.

### 4.5 What does **not** have to break

Worth stating, because the §2 language suggests otherwise:

- **No tile server.** Constraint C1 is untouched; refinement is client-side range reads against the
  same static object.
- **No tile cache and no eviction policy.** Two blocks resident per panel, both owned by the view,
  both discarded with it.
- **No resolution pyramid is required.** Phase A works on a plain `.metacool` with no ladder at
  all, which is what §3.4 demands: *"a plain `.metacool` must behave identically, minus the extra
  zoom levels"* (`SPECS.md:136`; README puts it as *"minus the extra speed"*, `README.md:46`).
- **No second render path.** `poolDisplay` → `colorize` → `putImageData` (`heatmap.ts:90-96`) is
  viewport-blind and needs no change whatsoever. Bin size is not a parameter of colouring, pooling,
  log scaling, clipping or the key; it reaches the renderer only as `AxisCoords.bpPerCell` for
  ticks and as `labelMinSpan` (`MatrixPanel.ts:3739-3757`).
- **No change to the worker protocol** in phase A.
- **No new `ViewState` key**, and no zoom in the URL hash (§8).
- **The layering rule survives.** `MatrixPanel` still holds no `ReaderClient` (§D5).

---

## 5. Design

### D1 — A refine is the same request, narrowed

The refine issues `{kind:'matrix', rows, cols, balance?, value?, budgetBytes}` with the extents set
to the **visible window padded by 50 %, clipped to the anchor block's extent**, and **no
`binsPerCell`**. `fitPlan` chooses the grid; `snapToGrid` anchors it; the response reports what it
chose in `binsPerCell` and the panel multiplies its bin size by it, exactly as it does today
(`MapPanel.ts:788`).

There is no new read path, no new guard and no new equivalence suite. That is the point.

### D2 — A few whole blocks, and a ceiling

*(Proposed as "two blocks, refine inward only"; overruled — §11.1.)*

Each view keeps the blocks it has read, most recent first, bounded at three and at 160 MB. That
small cache is what makes zooming **out** free: leaving the window a fine block covers falls back to
a coarser one that is still in hand, instantly and with no request. Going wider than anything held
costs one read, clipped to the **ceiling** — the view's own domain, which is the whole contig for a
region, the genome for a genome view, the file for a whole view, and its own block for a deck
companion. A zoom therefore cannot widen into the full-file scan §7.3 gates.

The **widest** block held is the colour gauge, so `vmin`/`vmax` do not move while the reader zooms
in; zooming out past it re-measures, which is right, because that reader is looking at data that was
not in the picture before.

None of this is a tile cache. Nothing is evicted mid-picture, nothing is stitched, and every entry
is a whole bounded block that was drawn on its own.

Memory: two blocks per panel, each ≤ 4096² × 4 B = **67 MB**, so ≤ 134 MB — the same order as
today's compare path, which already holds up to five block-sized arrays at once
(`MatrixPanel.ts:3906-3938`, `render/compare.ts:99`, `:191`). In a deck, `budgetBytes` is already
divided per panel (§16.7); refinement asks for half of a panel's share and is **not offered when
that does not fit**.

### D3 — The swap seam

`setMatrix` ends unconditionally in `fit()` (`heatmap.ts:1590`), which destroys the transform. The
refine must not go through it. `reshape()` is close but wrong on its own: it carries `originX` over
as a **raw cell index** and recomputes `baseZoom` from the new `ncols` (`:1644-1646`), so a block
with twice the columns for the same span would jump. `originY` is not preserved deliberately — it
is simply never touched, so on a band it is pinned by `restY` (`clampView`, `:1995-2002`) and on a
square block it survives as a raw cell index exactly as `originX` does, which is the same jump
again.

The correct sequence, all before the next frame so no intermediate state is ever drawn:

1. capture the visible window **in base pairs** — `framedWindows(locusAxes.rows, scaleY)` and the
   column equivalent (`MatrixPanel.ts:5127-5133`);
2. `setResolution(binsize × result.binsPerCell)` — *before* the block, as its own docstring demands
   (`:3830-3833`);
3. rebuild `locusAxes` from the new block's runs (`locusAxisFrom`, `render/locus.ts:221`);
4. map the captured bp window back to cells through the **new** axes (`locusToUnit`,
   `render/locus.ts:148-152`);
5. install the block and show that window;
6. re-run the rest of `setData`'s tail: `setAxisCoords`, `setLabelMinSpan`, `lanes.setAxes`,
   `laneEditor?.close()`, `heatmap.setScale(...)`, `schedule()`.

Steps 4–5 are the deck lock's arithmetic (`panels/lock.ts`), which already rounds outward so a
coarser grid shows *at least* what was asked for. Step 6 is not optional: `setMatrix` clears
`axisCoords` on purpose so a caller that forgets draws no ticks rather than the previous block's
coordinates (`heatmap.ts:1577-1580`), and every lane, ruler, overlay and hover readout is built
from `locusAxes` (`MatrixPanel.ts:3765-3814`).

### D4 — The policy

Copied from `SampleCache`, in one class, on the main thread (results arrive as **transferred**
`ArrayBuffer`s — `transfersFor`, `worker/protocol.ts:630-655` — so the worker's copy is detached
and a cache must live main-side).

- **Trigger.** Device pixels per cell is `heatmap.zoomLevel × devicePixelRatio`. It is closely
  related to — but not identical with — the quantity `draw()` already computes to decide smoothing,
  which is `zoom × min(strideX, strideY) × dpr` and therefore counts device pixels per *raster*
  pixel (`heatmap.ts:2542-2552`); the two coincide exactly when the block is at or under the cap,
  which it is on every path a refine touches. Refine when it is ≥ 2 **and** the grid in hand is
  coarser than the file's own bins.
- **Hysteresis.** Refine only when the target grid is at least 2× finer than the one in hand. This
  is §8.4's rule verbatim: *"the required resolution crosses a factor of two — not once per frame,
  and never during a drag."*
- **Settle.** A debounce of ~120 ms after the last transform change, cancelled by the next. This is
  genuinely new: there is no gesture-end or idle hook anywhere in the pan/zoom path, and the only
  timers in the panel are the 250 ms double-tap deferrals.
- **Pad.** 50 %, reusing `LocusAxis.windows(domain, 0.5)`, so a half-screen pan costs nothing.
- **Never blank.** Return the block in hand immediately; install the finer one when it lands.
- **De-duplicate and supersede.** One in-flight refine per panel, held as a
  `Cancellable<MatrixResult>` and cancelled when a newer one is issued
  (`ReaderClient.cancellable`, `client.ts:105`).
- **Keep refusals.** `MapPanel` deliberately keeps its read key after a failure so a deterministic
  refusal is not re-issued on every repaint (`MapPanel.ts:604-612`). The refine ladder must adopt
  the same rule, or a refused fine grid is re-requested on every frame of a drag.

### D5 — Where it lives

`MatrixPanel` must not gain a `ReaderClient`; that is a stated structural rule
(`MatrixPanel.ts:8-11`, `:515`). The viewport goes **up**, the block comes **down**:

```
HeatmapView.zoomAt / panBy
  → changed()
    → MatrixPanel.schedule()            [rAF, one per frame]
        …draw…
        viewportListener(rows, cols)     ← the deck lock, unchanged  (MatrixPanel.ts:4753)
        refineListener(windows, dpc)     ← NEW, a second slot
          → BlockLadder.blockFor(...)    [src/ui/refine.ts, main thread]
            → ReaderClient.cancellable<'matrix'>({rows, cols, …})
              → worker → fitPlan → snapToGrid → pooledMatrix
          → MatrixPanel.regrid(result)   ← NEW, the D3 sequence
```

A **second** listener slot rather than a replacement, so a deck's lock and a panel's refine
compose. The owning views — `RegionView`, `GenomeView`, `WholeView`, `MapPanel` — already own a
`ReaderClient` and already issue exactly this request; they gain a `BlockLadder` and route through
it.

### D6 — The ladder, as an accelerator

Phase A never needs it. Phase B buys three things, in descending order of value:

1. **A cheap anchor.** Today a whole-chromosome view of a fine cooler pools from the finest rung,
   which means walking the whole row band at that rung. Reading the anchor from a coarser rung
   costs proportionally fewer pixels for exactly the same picture.
2. **Correct balancing.** Summing balanced values is not balancing at a coarser resolution, and the
   code says so at length (`reader.worker.ts:399-412`): a `k × k` cell comes out about `k` times a
   single balanced value, and a `NaN` weight — which is how SPECS §6.4's *"a blank row is an unbalanced
   row"* diagnostic works — is dropped rather than propagated. The source names the fix:
   *"Balancing at the read's own resolution, and taking a coarser rung of a laddered file where one
   exists, are the real answers and are not attempted."* `cooler zoomify --balance` re-balances
   every level from raw counts, so a rung **is** the correct answer. `CHANGELOG.md:1669-1681`
   records the same deferral.
3. **Zoom-out headroom** past the anchor, if ever wanted. Not proposed.

What it costs: the worker holds exactly one `MetaCooler` and `handleOpen` closes the previous one
before opening the next (`reader.worker.ts:119-131`). A handle rooted at one rung physically cannot
address a sibling — `resolve()` strips leading slashes rather than escaping to the file root
(`h5/Hdf5File.ts:258-263`). So phase B needs the worker session to hold a small **map** of open
rungs. The byte source is already retained across opens by object identity / URL, with an idempotent
mount and a surviving chunk cache (`worker/sources.ts:24-34`, `:122-132`), so a second rung costs
one `new h5.File` over the same mount plus that rung's attrs, chroms and `chrom_offset` — measured
in the existing entry-switch path at 6 requests against 10 without retention (`sources.ts:74-81`).

And one hard rail: **bin indices are not comparable across rungs.** `test/unit/coarse-extent.test.ts`
is a whole file about a real yeast `.mcool` where *"the arithmetic and the bin table genuinely
disagree"* (`:58`) and chromosomes merge differently per rung. Cross-rung windows must be resolved
through base pairs, per rung, against that rung's own tables.

### D7 — What this is not

Stated as decisions, in the house style, so they are not mistaken for omissions. **Four of these
were proposed and then overruled** — see §11; what is left is the list as built:

- **No tiles.** One block per picture, always. There is no compositor and no seam.
- **No tile cache, no eviction mid-picture.** Two or three whole blocks per panel, owned by the
  view, freed with it — kept so that zooming back out is a swap rather than a request.
- **No per-axis resolution.** Both axes share one `k`, because the panel has one bin size and the
  labels down the side depend on it (`reader.worker.ts:417-421`).
- **No refinement of the genome × genome overview.** Its axes are genomes or contigs, not
  positions; a cell there *is* a sequence, so there is no finer grid to go to. This is the one
  exclusion that survived, and it survived because it is not a limitation — it is what the picture
  is.
- **No refinement written to the URL.** See §8, last bullet.

---

## 6. Implementation plan

Each milestone is independently landable and independently valuable. M0 is worth doing whether or
not the rest ever lands.

### M0 — Debts refinement would amplify

**M0.1 — The score column must survive a pooled read.** *(prerequisite, and a live bug)*

`SpanScanOptions` (`src/metacooler/matrix.ts:400-406`) carries `chunkSize`, `cancelled` and
`onProgress` — and no `value`. `forEachPixelSpanAsync` (`:436`) and `forEachPixelRangesAsync`
(`:480`) therefore call `readPixelWindow(h, at, end)` with three arguments, so
`DEFAULT_COUNT_COLUMN` applies. The synchronous `forEachPixelSpan` (`:361-375`) *does* take a
`value` parameter and the dense path threads it (`:600`).

The consequence today: `handleMatrix`'s **dense** branch spreads `request.value` into the query
(`reader.worker.ts:237`) and `readDenseMatrix` honours it (`matrix.ts:600`) — but `pooledResult`
(`:272`) and `handleAggregate` (`:521`) spread it into calls that never read it. So **crossing the
pooling threshold already changes which `/pixels` column is displayed**, silently, in the same
view. Under zoom-to-refine that becomes a zoom-dependent change of quantity, which is not
shippable.

- add `value?: string` to `SpanScanOptions`; thread it to `readPixelWindow` in both async walkers;
- pass `q.value` from `pooledMatrix` (`MetaCooler.ts:848`), `aggregateSparse` and
  `selectionMatrix`;
- extend `test/unit/pooling.test.ts`'s dense-vs-pooled equivalence to a non-`count` column. **This
  needs a new fixture**: no golden in `test/golden/` has a second `/pixels` value column —
  `floatcount.metacool` varies the *dtype* of `count`, not its name
  (`test/golden/_manifest.json:63-73`), so it exercises the float path and not the score-column
  path. Add one to `scripts/make_fixtures.py`.

**M0.2 — Correct a stale docstring.** `fitPlan`'s comment claims it plans *"only for a block that
begins on a contig boundary"* and that a mid-contig region is *"left dense and refused by size"*
(`reader.worker.ts:394-397`). The code contains no such test (`:414-439`), and the mid-contig case
is explicitly handled by `anchor()` (`:359-365`) and `snapToGrid`. Fix the comment; it will
otherwise mislead every reader of this plan.

**M0.3 — Make the layering claim testable.** *"Re-rasterising happens on exactly three events …
never on pan, never on zoom"* (`heatmap.ts:11-12`) is enforced today only by `MatrixPanel` not
importing the worker client. No test counts rasterisations — every canvas stub makes
`putImageData` a no-op. Add a counter on `HeatmapView` and a test pinning **one rasterise per
block, zero per zoom**, before the invariant is stressed.

**M0.4 — (optional) Make the dense path interruptible.** `readDenseMatrix` is synchronous end to
end (`matrix.ts:576-605`, using `forEachPixelSpan`), and remote bytes are fetched with synchronous
`XMLHttpRequest` from inside an Emscripten stream op (`RemoteRangeSource.ts:376-382`). A refine
that lands on a `k = 1` block therefore blocks the worker for its duration and **cannot be
superseded** — the `cancel` message sits in the queue. The read is bounded (≤ 4,096 rows' band), so
this is acceptable for v1; routing the dense path through `forEachPixelSpanAsync` would remove the
last head-of-line block.

### M1 — The swap seam

*New:* `HeatmapView.regrid(matrix: DenseMatrix, show: {rows: [number, number]; cols: [number, number]}): void`

Reshape semantics for **both** axes — replace `matrix`, clear `blockCache`, `pooled` and
`hoverCell`, set `dirtyRaster`, reset both `Scale` fulls, `recomputeBaseZoom()` — then the body of
`showCellWindow(show.rows, show.cols)`, then one `changed()`. Deliberately **not** touching
`gauge`/`gaugeRange`, so the anchor's colour measurement survives (`heatmap.ts:1630-1641` only
invalidates it when a gauge is passed).

*New:* `MatrixPanel.regrid(result: MatrixResult): void` — the D3 sequence: the tail of `setData`
(`:3684-3821`) minus `setMatrix`, `setAnchor`, `setFitAxis`, `writeTurnBox`, `syncLegendSlots` and
`setDerive`.

*Changed:* `MatrixPanel.setData` installs the block as its own gauge when refinement is enabled, so
the auto range is measured once and never re-measured.

*Tests:* mirror `heatmap-navigation.test.ts:901` for a **finer** block — same bp window before and
after, `zoomLevel` scaled by exactly the grid ratio, `vmax` unchanged; and a `MatrixPanel`-level
test that `locusAxes`, `axisCoords` and `labelMinSpan` all describe the incoming grid.

### M2 — The policy

*New:* `src/ui/refine.ts`

```ts
export const REFINE_PAD = 0.5          // matches annotations/samples.ts FETCH_PAD
export const REFINE_SETTLE_MS = 120
export const REFINE_AT_DEVICE_PX = 2   // cells this big are worth refining

export class BlockLadder {
  constructor(client: ReaderClient, onBlock: (result: MatrixResult) => void)
  /** The block to draw now; fires at most one read, never waits, never blanks. */
  blockFor(request: { rows: Extent; cols: Extent; balance?: boolean; value?: string;
                      budgetBytes?: number }): MatrixResult | null
  destroy(): void
}
```

Held state per key (`plan | score | balance`): the covered bin extents and the grid they came back
at. Coverage check before requesting; `inflight` guard; the previous `Cancellable` cancelled on
supersede; refusals remembered so they are not re-issued.

*New:* `MatrixPanel.setRefineListener(cb | null)`, fired from the rAF tail immediately after the
viewport report (`:4753-4756`), passing the padded genomic windows and device-pixels-per-cell.

*Changed:* `RegionView` (`:290`), `GenomeView` (`:239`), `WholeView` (`:589`) and `MapPanel`
(`:701`) construct a `BlockLadder` and route their matrix read through it. `Overview` does not.

### M3 — The anchor and the wall

The view holds the block it entered with. On a transform that leaves the refined block's covered
window, `regrid` back to the anchor — zero I/O — and let M2 refine again when the gesture settles.
With 50 % padding this is reached only by a pan of more than half a screen.

Zoom limits become honest for free: `minZoom = baseZoom / maxZoomOut` and
`maxZoom = max(baseZoom, shorterSide / minVisibleCells)` (`heatmap.ts:1951-1964`) are recomputed
from whichever block is installed, and the anchor is the one installed whenever the reader is
zoomed out.

### M4 — The ladder *(opportunistic; `.mcool` / `.mmetacool` only)*

*Worker:* `interface Session { maps: Map<string, MetaCooler>; primary: string; source; sourceKind }`
plus `mapFor(rung?: string)`, opening lazily through `openHdf5(uri, source, '/'+entryGroup+'/'+rung)`
on the **retained** source. Bounded — three rungs, LRU by last use — and cleared by `handleOpen`.

*Protocol:* `rung?: string` on the `matrix` and `range` arms (`worker/protocol.ts:443`, `:458`).
Two optional fields; every existing call site is unaffected.

*Client:* `BlockLadder` picks the **coarsest rung whose bin size ≤ the target bp per cell**,
resolves the window on that rung with a `range` request carrying the same `rung`, then issues the
`matrix`.

*Guards:*
- verify the ladder actually nests (`k = binsize / base` integer at every rung) before using it.
  Today that is asserted only in `test/unit/mmetacool.test.ts:186-201` and enforced nowhere in
  `src/`; a hand-built `[1000, 1500, 5000]` ladder would misbehave silently.
- make the ladder/collection predicate canonical in **one** place. It exists twice today, verbatim:
  `orderEntries` (`detect.ts:215-218`) and `allIntegers` (`FilePicker.ts:383-389`).
- read `entryGroup`, never a hard-coded `entries`/`resolutions` — the two formats differ, and the
  dead `showEntries` (`FilePicker.ts:240-260`) hard-codes one of them.
- an explicit pick from the breadcrumb or a panel's picker **pins** the rung; refinement stops
  choosing until the reader unpins. §16.2 makes the rung a reader choice that sticks
  (`SPECS.md:1277-1284`), and a zoom that overrode it on every wheel event would be a regression.

### M5 — Budgets, tests, copy, docs

- rewrite `test/budgets/requests.test.ts:169-199` and its comment; add a `refine` budget row driven
  through the same `stats` harness. Note that the counting stub throws on a request with no `Range`
  header (`test/support/counting.ts:78-93`), so any new read path stays measurable by construction.
- `poolingNote` (`MatrixPanel.ts:5974-5984`) becomes a live indicator, and its docstring
  (`:5967-5969`) is rewritten.
- the §4.1 documentation pass, including README's already-stale Scope section.
- a `UiMemory`/`localStorage` preference, in the plot-options store beside the overlay preferences
  (§7.2 keeps preferences out of the hash), with **refinement on by default**. Off by default would
  ship a feature nobody discovers; on by default keeps the honest-refusal copy correct for whoever
  turns it off.

---

## 7. Hazards, ranked

1. **The colour scale moves.** A finer block over the same region has systematically smaller cell
   values (coarse cells are **sums** of bins, `pooling.ts:127`) *and* a different percentile
   population (`autoRangeOfDisplay` is taken over the pooled display pixels, which are **maxima**,
   `heatmap.ts:263-294`). Left alone, the map visibly re-brightens mid-zoom for data that did not
   change. **Mitigation:** the anchor is the permanent gauge (D2, M1); `vmin`/`vmax` are measured
   once. This is the same mechanism §17.6 already uses to keep the range invariant across pan and
   zoom, and the same one the turned band uses across a re-cut.
2. **The deck lock oscillates.** `panels/lock.ts` swallows echoes with a half-cell tolerance derived
   from each panel's `bpPerCell` (`:245-261`), and `test/unit/panel-lock.test.ts:247` pins one
   hundred exchanges standing still. A refine that changes `bpPerCell` mid-exchange changes the
   tolerance under the guard. **Mitigation:** `setResolution` before the block (its docstring
   already demands this), and refinement must not emit a viewport report of its own — the next
   ordinary frame reports it.
3. **A gesture queues reads it cannot abandon.** There is no queue, no priority and no coalescing at
   the worker boundary — `ctx.onmessage` does `void handle(event.data)` and returns
   (`reader.worker.ts:995-997`). Combined with the synchronous dense path and synchronous remote
   XHR, a burst of refines can serialise behind a stale one. **Mitigation:** one in-flight refine
   per panel, cancel-on-supersede, settle debounce; M0.4 for the rest.
4. **Balanced values change meaning as the grid changes.** Already true today across the pooling
   threshold; refinement makes it a function of the zoom. **Mitigation:** M4 (a rung is
   re-balanced from raw counts) is the real fix; until then, say so in the note.
5. **Panning is walled at the refined window.** `clampView` walls at the installed block's edges.
   **Mitigation:** 50 % padding plus the free swap-back to the anchor (M3). The reader sees the
   picture coarsen for a frame at the boundary and then re-sharpen — which is what a HiGlass user
   sees at a tile boundary.
6. **A sharpening *pop* that is not the data.** Refining to `stride = 1` at the same zoom flips
   `imageSmoothingEnabled` (`heatmap.ts:2542-2552`), and tick steps subdivide as bins get finer
   (`chooseBpStep`, `:777-783`). Both are arguably desirable tells; both are visible and should be
   expected rather than diagnosed later.
7. **A refine per panel per deck.** Each `MapPanel` owns its own `ReaderClient` and therefore its
   own `Worker`, its own h5wasm runtime and its own retained source (`MapPanel.ts:239`). N panels
   refining is N of everything. **Mitigation:** refine only the panel under the pointer, or gate on
   the per-panel byte budget (§16.7).
8. **Refusals re-issued per frame.** `MapPanel` already keeps its read key after a failure for
   exactly this reason (`:604-612`). The ladder must too.

---

## 8. Rejected alternatives

- **A tile pyramid (reading C).** Needs a cache, an eviction policy, seam handling, and a second
  render path — and buys nothing here, because §3.3 above shows the staircase is one to three steps, not
  fifteen levels. Also collides with §13.
- **Re-`open`ing the file per rung** to drive the ladder. `handleOpen` closes the previous
  `MetaCooler` and discards its `bin1_offset` cache and memoised tables
  (`reader.worker.ts:119-131`, `MetaCooler.ts:1259-1263`), and on the main thread `Session.open`
  rebuilds the breadcrumb, the info panel and the whole annotation subsystem
  (`Session.ts:1510-1627`). §17.2 lists a change of resolution among the events that *destroy the
  panel and build another*. Nothing a wheel can do.
- **Computing the grid client-side and sending `binsPerCell`.** Bypasses `snapToGrid`
  (`reader.worker.ts:218-221`) and anchors cells at the pan position. This is the single most
  likely way to break the anchored-grid invariant silently, and it would be invisible until
  somebody noticed a cell's value changing as they panned.
- **Re-pooling client-side from the block in hand.** The renderer's own pooling is flat and
  contig-blind (`rasterStride`, `heatmap.ts:72`) — exactly the straddling `pooling.ts` exists to
  prevent — and it can only coarsen, never refine. The pooled result does not carry enough to be
  re-pooled honestly anyway: `BinPooling.slot`/`cellStart`/`members` stay in the worker.
- **Threading a `ReaderClient` into `MatrixPanel`.** Breaks the one structural layering rule the
  module headers assert, and would make the "pan and zoom perform zero I/O" claim untestable rather
  than merely untested.
- **Putting the zoom in the URL hash.** §16.6 states *"the hash has never carried a pan or a
  zoom"*, and `App.readHash` applies a pasted hash literally, by rule (`App.ts:598-608`). Making
  refinement addressable would mean two readers following one link see different data at different
  scroll positions. **A refine is a rendering of the view, not the view.** The `region` key is
  already the addressable form of "look here, finer", and the marquee already writes it.

---

## 9. Open questions for the author

1. **Default on or off?** This document recommends **on**, with a preference to disable. The
   counter-argument is that §2's promise is the project's most-cited sentence and that inverting it
   silently, even honestly, is a bigger change than a viewer usually makes to itself.
2. **Should a refine be reversible by an explicit control?** A "pin this resolution" affordance
   would let a reader freeze the grid for a figure. §16.2's per-panel rung picker is the obvious
   place, and M4 already makes it a pin.
3. **Does the `whole` view keep its gate promise?** `WholeView`'s gate copy promises *"It runs
   once: the picture is kept for as long as the file is open"* (`WholeView.ts:469-471`, in
   `renderGate`; the predicate itself is `gated()` at `:444-448`). Refines are bounded sub-reads,
   not further full passes, so the promise holds — but the wording assumes one read and should be
   revisited.
4. **Is refining under a derivation ever wanted?** §D7 forbids it in v1. The honest alternative
   would be to refine and say plainly that the baseline was re-measured for the window on screen,
   which is already true of a region view today.
5. **Is the 4,096-cell target right for a refine?** It is the renderer's cap and the reader's cap,
   deliberately the same number (`pooling.ts:39-49`). A refine that targeted the plot's own pixel
   width instead would read less and refine more often. Keeping 4,096 buys up to 5× of free zoom
   headroom per read; that is the trade, and it is the reason the staircase is short.

---

## 10. Summary

| | |
|---|---|
| **Feasible?** | Yes. |
| **Needs a tile server?** | No. |
| **Needs a tile cache or eviction?** | No — two or three *whole blocks* per panel, so zooming out is free. |
| **Needs a resolution pyramid in the file?** | No. Works on a plain `.metacool`; a ladder is an accelerator (SPECS §3.4's rule, kept). |
| **Needs a protocol change?** | Not for phase A. Two optional fields for phase B. |
| **Needs a second render path?** | No. `render/` is untouched except for one new method. |
| **New `ViewState` key or hash field?** | No. |
| **Spec clauses that must change** | One: §2's *"no progressive refinement"*, plus §14's *"there is no third path"* and §12's budget row, which is split rather than relaxed. |
| **Tests that must be rewritten** | One, deliberately: `test/budgets/requests.test.ts:169` — which would otherwise keep passing while its own comment became false. |
| **Prerequisite bug** | M0.1: the score column is dropped by every pooled read today, so crossing the pooling threshold already changes which quantity is drawn. |
| **Biggest hazard** | The colour scale moving under the reader's hand. The `gauge` mechanism already solves it. |
| **Where the precedent is** | `src/annotations/samples.ts` — the same feature, shipped, for the tracks drawn on the map's own axis. |


---

## 11. What was built, and where it differs from this plan

The plan above was written before any of it existed. Four of its five v1 exclusions were overruled
on review, and the reasons are worth keeping, because each of them was a real cost that turned out
to be payable.

### 11.1 The four exclusions that went

| Proposed exclusion | Decision | What it cost |
|---|---|---|
| No refinement on **zoom-out** | **Refine both ways.** | The single anchor became a small bounded cache — two or three whole blocks, LRU by bytes — and the ladder gained a widening read, over-buying 4× and clipped to the view's own domain. Zooming out through levels already read costs nothing at all; only going wider than anything held costs a read. |
| No refinement under a **derivation** | **Refine anyway.** | Nothing. `MatrixPanel.regrid` goes *through* `derive()` rather than around it, so O/E, VC, VC√ and ICE are recomputed on the incoming block exactly as they are on a navigation. The baseline does move with the window — which is already true of a region view today, and is a property of the derivation rather than of the zoom. |
| No refinement while **two files are blended** | **Refine both, in lockstep.** | One `read` callback returns `{ result, second }` and the panel installs both at once, so `alignable()` sees two blocks of identical shape. §5.7's refusal is untouched: the two files still have to share a grid, which the compare gate established before either read was made. |
| No refinement on a **turned (45°) map** | **Refine the square under it.** | Nothing, and it composes: `refineWindow` answers with the on-diagonal square the band was cut from, `derive()` re-cuts the band from the incoming square, and `syncTurnDepth` carries on doing what it already did. The two policies do not fight because they act on different things — one chooses the block, the other cuts a band out of whatever block is there. |

### 11.2 What was found by running it

Two defects survived a green test suite and were caught by driving the built app against
`demo/yeast/Yeast_microC_G2M_1kb.cool` at whole-genome zoom. Both are the kind that only appear when
a real block replaces a real block:

1. **The summary line was written once.** `4,046 × 4,046 bins · effective resolution: 3.0 kb` stayed
   above a picture that had become 63 × 63 at 1.0 kb. Fixed with an `onInstalled` hook that every
   view re-says its own line through.
2. **The gauge was never installed.** §7's first hazard, exactly as predicted and one line short of
   being prevented: `setData` passes the gauge `derive` produces, which is `undefined` for anything
   but a turned map, so the range was measured from the drawn block and a refine moved the legend
   from `-4.215 … -1.918` to `-3.21 … -0.245`. The widest block is now handed over the first time a
   refine narrows past it.

Measured on that file: **3.0 kb → 1.0 kb on one bounded read**, zero reads during the gesture, zero
on the way back out, and — because a 19 MB file fits inside the 64 MiB / 1 MiB-chunk LRU — zero
network requests for the refine itself.

### 11.3 Corrections to this document's own analysis

- **§3.4's cost estimate was wrong on the first pass** and is corrected in place: the staircase costs
  about 1.2× the anchor read across the whole zoom, not 0.15×, and the series runs expensive to cheap
  rather than the reverse. What holds is the claim that matters — no single refine costs more than
  the read that drew the view.
- **§4.4 mis-stated `poolingNote`.** *"Zooming does not sharpen it"* was its docstring, not the
  sentence under the map; the drawn phrase was `aggregated N × M bins to a pixel`. Both changed, and
  the phrase now ends `· zoom in to sharpen` or `· open a smaller block to sharpen` depending on the
  preference.
- **M0.1's test needs a new fixture.** No golden in `test/golden/` has a second `/pixels` value
  column — `floatcount.metacool` varies the *dtype* of `count`, not its name.
- **`crossResolution` needed two rules the plan did not anticipate**, and the real `.mcool` found
  them: a window that *starts* at a sequence starts at that sequence, and one that *reaches the end*
  of a sequence reaches its end, whatever the two bin sizes divide into. Without them the far edge of
  a whole chromosome landed in the next one at 2 kb, on exactly the five chromosomes
  `coarse-extent.test.ts` was written about.

### 11.4 What is in the tree

| | |
|---|---|
| The policy | `src/ui/refine.ts` — `BlockLadder`, `chooseRung`, `rungsOf`, the preference |
| The seam | `HeatmapView.regrid`, `MatrixPanel.regrid`, `MatrixPanel.setRefineListener` |
| Cross-rung coordinates | `crossResolution` in `src/metacooler/coords.ts`; `rung` / `binsize` / `source` on the wire |
| The multi-rung session | `src/worker/reader.worker.ts` — `mapFor`, `MAX_RUNGS`, `releaseRungs` |
| Tests | `refine-ladder`, `regrid-window`, `cross-resolution`, `raster-count`, and a §12 `refine` budget |
