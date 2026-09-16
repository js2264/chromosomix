# A 3D structure beside the map — survey and design

Working document for a feature that does not exist yet: an interactive 3D view of a chromatin
fibre (one chromosome or several, one genome or several MAGs, one haplotype or two) read from a
g3d file, drawn *beside* the map and the tracks as a cell of the deck, linked to them in both
directions, and coloured by whatever the session already knows about the sequence.

It is a survey rather than a spec. It reads the code as it is today, says where such a view plugs
in and why, evaluates whether it is worth building, and ends with a phased plan and the questions
only the author of the data can answer. Nothing here is implemented. When the decision is taken,
the design becomes a numbered `SPECS.md` section in the usual way, with its own refusals.

Revision 2 changes three decisions of the first draft, each at the author's direction: the file
format is WashU's g3d text format rather than a home-grown `bed6+xyz`; the renderer is three.js rather
than a hand-written Canvas 2D painter, because interaction is the point of this picture and a
library is the price of doing it well; and the deck generalises from *N maps* to *N cells of one
place*, so that a map with its tracks, a cell of tracks alone, and a structure can stand in one
row — which also makes the deck available to a session that has tracks and no map.

Revision 3 settles the questions revision 2 left open, with the author's answers: a g3d's
resolution is the spacing of its sorted starts and nothing else, and it is independent of the
map's rung; the file is text, possibly gzipped, and is read whole over HTTP like any other text
annotation — there is no binary road; a phased file draws both homologues; a tracks cell draws
from the session's one track list, with the edge controls inactive where there is no map; one
structure cell per deck, two being a future suggestion rather than a plan item; and the vector PDF
of beads and sticks is in the first release.

---

## 0. The short version

| Question | Answer | Why, in one line |
|---|---|---|
| Is it worth having? | Yes, scoped tightly | This app's niche — small genomes, whole blocks in memory, analysis in the browser — is where a consensus 3D model is cheapest to make and most defensible to show; and reading g3d makes every structure WashU can show openable here with no conversion, and every structure made here openable there |
| What file? | **WashU's g3d text format** (`chrom start x y z [hap]`), named `.g3d`, or the same gzipped as `.g3d.gz`, local or by URL | The format WashU specifies as the input of `g3dtools`; read whole in the annotations worker like every other text annotation, so a `.g3d.gz` on a bucket is one request |
| Where does it live? | **A cell of the deck**, where a cell may be a map, a stack of tracks, or a structure | A structure is a *picture of a place*; the deck is the app's word for pictures of one place beside each other under one navigation. Generalising the cell is what also lets a tracks-only cell exist and lets a 1D session have a deck |
| How is the file held? | **An annotation row** (`kind: 'structure'`) | The store already gives it sniffing, contig-name matching, haplotype as a colour field, persistence, share links and every export; the 3D panel is a *view of a row*, never a second loading path |
| How is it drawn? | **three.js**, pinned, behind a thin adapter over a pure scene | Lit tubes, instanced beads, fat lines, transparency, outlines, raycast picking, orbit and trackball controls — the interactions the author wants as first-class, at a cost this project can now afford to state in the open |
| How is it linked? | **A hover-locus store** plus the echo hooks `MatrixPanel` already has, and a lock that learns one-axis members | The deck already carries a pointer across panels in base pairs; a bead and a track both name *one place*; the lock's currency is already base pairs |
| What does it refuse? | Structure inference, invented physical units, invented phasing, a declared resolution, a vector PDF of a lit surface | Each named in §10 with its mechanism and its way out, in the §13 / §18.9 style |

---

## 1. Is it useful, and to whom

### 1.1 Who has this data

Four communities produce bead-per-interval coordinates:

1. **Consensus models from bulk Hi-C** — pastis (MDS, NMDS, PM1/PM2, the negative-binomial
   solver), ShRec3D, miniMDS, Chrom3D, HSA, 3DMax, LorDG. One model per map, one bead per bin, a
   missing bead where a bin had no contacts. A 4 Mb bacterium at 5 kb is 800 beads; a 12 Mb yeast
   at 10 kb is 1,200; a MAG is a few hundred. This is what `g3dtools` was written to convert, and
   what the author has.
2. **Polymer simulations** — polychrom/OpenMM loop extrusion, block copolymers, MiChroM. Thousands
   of conformations per run, each the shape of (1), compared *against* a map rather than derived
   from it.
3. **Chromatin tracing** — multiplexed DNA-FISH. One trace per cell, tens to a thousand spots per
   trace, thousands of cells; the 4DN FISH Omics Format (FOF-CT) fixes the table as
   `Spot_ID, Trace_ID, X, Y, Z, Chrom, Chrom_Start, Chrom_End`. The fastest growing class.
4. **Single-cell Hi-C and diploid models** — Dip-C `.3dg` (`chr7(mat)  16760000  x  y  z`),
   which is the g3d text with the haplotype written into the chromosome name, and the Nucleome
   Data Bank's `.cndb` (HDF5, many frames). g3d carries haplotypes natively, which is why the
   author's example has an `m`/`p` column.

(1), (2) and (4) are one bead per genomic interval on a regular grid, per haplotype. (3) is an
ensemble, sparse on the genome. A design that serves (1), (2) and (4) in a first release and does
not close the door on (3) is the right shape.

### 1.2 What the existing viewers do, and what none of them does

| Tool | Input | Draws with | Linked to | Coloured by | Needs |
|---|---|---|---|---|---|
| WashU Epigenome Browser 3D module | the g3d text (`chrom start x y z [hap]`) as `g3dtools`' input; the browser itself loads the packed container `g3dtools` writes (indexed, multi-resolution, haplotypes, samples) | three.js | its own tracks; the browser window highlighted; gene and Hi-C anchors shown on the model | bigWig ("paint"), BED annotations | the `g3dtools load` step, a hosted browser |
| Spacewalk (igv team, Aiden lab) | `.sw` (HDF5), FOF-CT | three.js | an embedded igv.js and juicebox.js | genomic position, tracks | `swtool` conversion, its own page |
| Nucleome Browser | `.g3d` | three.js | every component through an event channel | signals | a hosted platform |
| ChimeraX / PyMOL with pastis' PDB | PDB | GPU | nothing genomic | manual | a desktop application |

What this app would add, and each is something it already is:

- **The text opens as it is.** Every viewer above loads a packed container built from it. Reading
  WashU's g3d text directly (§2.2) keeps C3 true for a structure, and a file that opens here is the
  file WashU's own `g3dtools load` takes, so it opens there after that one step.
- **The colouring is computed in the same window.** Compartments, insulation, coverage, a virtual
  4C, and on a `.metacool` the contig table's own MGE call and completeness, are one click away and
  are already tracks (§18.5). No hosted viewer closes that loop, because none computes anything.
- **The model stands beside the map it came from, under one navigation**, in the same figure, with
  the map's tracks beside both. That is the deck, generalised (§3).

### 1.3 The honest case against

- **A consensus model from bulk Hi-C is a summary, not a measurement.** The design has to make it
  hard to over-read: the model's own distance map beside the real map (§8.1) is the picture that
  keeps a reader honest, and distances print as `model units` unless the file declares otherwise.
- **The people who make the models already have ChimeraX.** The gain is not that a 3D view exists
  but that it knows what the map and the tracks know. If the linking and the colouring are thin,
  nobody leaves ChimeraX.
- **It is a new rendering surface and a library.** A pinned three.js, an adapter, a camera, picking,
  exports, tests, a spec section, a glossary. Realistically 5–7 k lines across the phases in §11,
  half of them in the first release, and the deck generalisation on top (§3.5).
- **Screen.** A cell is a square the size of the map. On a laptop with three columns open, three
  cells is tight. The deck's existing answers apply: fold the columns, `v`, one column per row.
- **The mammalian `.hic` audience gets little** until ensembles land. Phase 1 is for bacteria,
  yeast, MAGs, *Plasmodium*, diploid single-cell models, and teaching.

**Net.** High for the lab's bacterial, yeast and metagenomic work and for teaching; medium for the
wider audience; a differentiator only in combination with the analysis panel and the deck, which is
why the design leans on both.

---

## 2. The data: the g3d format, how it is recognised, how it is held

### 2.1 What arrives

The format is **WashU's g3d text format**: the format the WashU Epigenome Browser's `g3dtools`
specifies as its input and documents column by column, and the format the author's files are in.
Exactly as the author gave it:

```
chr7    16760000    -14.3866688728  -36.3919302029  19.8483965881   m
chr7    16760000    -24.9116268071  50.0521268287   9.91073185128   p
chr7    25160000    -10.1170055526  -34.8975763469  20.2401719179   m
```

`chromosome  start  x  y  z  [haplotype]`, tab-separated, where the sixth column is `m`
(maternal), `p` (paternal) or `s` (shared) and is `s` when absent. Facts the reader has to handle,
each visible in the example:

- **Rows are not sorted** (`50320000` is followed by `26200000`). The row is sorted on
  `(chromosome, haplotype, start)` at parse, which the `FeatureBuilder` does for genomic order
  already and which must keep the coordinates with their rows (§2.3).
- **There is no end column, and there is no header.** A bead's width is the file's resolution,
  and the resolution *is* the spacing of consecutive starts once the rows are sorted: the
  **mode of the differences between consecutive starts** within one `(chromosome, haplotype)` —
  `1,040,000` here, with wider gaps where beads are missing. That is the whole definition; nothing
  in the file and nothing in the app declares it otherwise. The number is printed in the row's
  summary line (`1,213 beads · 1.04 Mb · 2 haplotypes · 23 chromosomes`) so it is seen.
- **The structure's resolution is fixed, and the map's is not.** A reader changes the map's rung
  and the map re-reads; the g3d stays at the spacing it was written at. The two never have to
  agree because the bridge between them is base pairs (§2.5), not bins — the same reason a computed
  profile keeps the grid it was computed on when the map under it changes rung (`BinVector`
  carries its own `binsize`; `test/dom/analysis-carry.test.ts` pins it). A rung change costs the
  structure nothing and moves no bead.
- **A haplotype is a second chain over the same loci.** `chr7/m` and `chr7/p` are two beads at
  every position, and they are held as two chains (§2.4) rather than as two files or as two
  beads in one chain. This is the one place the first draft's design changes shape: the map's
  one axis has one `chr7`, and a locus on it lights *two* beads.
- **Missing beads** are absent rows, not `nan` rows. A gap in the starts wider than one
  resolution breaks the tube.
- **Units are the solver's.** Nothing in the file says nanometres, and nothing is asked.
  Distances print as `model units` (§10).

The other formats, in the order they are worth reading:

**How it is read.** Whole, in the annotations worker, as every text annotation is: a local file
by reference, a URL by one `GET`, `.gz` inflated on the way in — the same rung of the loader
ladder a BED or a GTF takes (`annotations.worker.ts:1536-1543`, "else whole-file inflate"). A
`.g3d` or `.g3d.gz` on a bucket with CORS is therefore one request at open and none afterwards,
which is the §12 row for a structure. There is no index and none is wanted: the files are
megabytes, and a 1 Mb diploid human model is 6,000 rows. Gzip is recognised by its magic bytes and
not by the name, as everywhere else in the loader, so a `.g3d` that happens to be compressed still
opens; the `.gz` suffix is what the reader is told to expect and what the demo writes.

| Format | What it is | Phase |
|---|---|---|
| **`.g3d` text**, and **`.g3d.gz`** | above | **1** |
| Dip-C `.3dg` | g3d text with `(mat)`/`(pat)` on the chromosome name; `g3dtools 3dg` is exactly that rewrite | 2 (a name rule, ten lines) |
| `bed6+xyz` | a BED with three columns on the end; the first draft's primary. Kept as a secondary road because it is what anybody with a spreadsheet writes, and because today such a file is **silently read as a broadPeak** (`peakFlavour`, `src/annotations/parse.ts:289`) — the sniff must run before it | 2 |
| pastis `.xyz` / `.structure` text | `x y z` per bead in bin order, no loci; bridged against the map's own bin arithmetic when the row count matches, refused by name otherwise with the `paste` one-liner that joins the bin table on | 2 |
| FOF-CT, `.cndb`, Spacewalk `.sw` | ensembles; the `frame` axis of §8.3; `h5wasm` is already here for the HDF5 ones | 3 |
| the packed container `g3dtools load` writes, which WashU's browser loads and which may also be named `.g3d` | indexed, multi-resolution, range-readable; told apart from the text by its magic bytes | a future suggestion (§13), not a plan item; refused by name until then |

### 2.2 Recognising the text

The annotation worker's `load()` is the registry (`src/annotations/worker/annotations.worker.ts:1469-1606`),
a straight-line ladder whose last rung is `sniffFormat`, whose last line is `return 'bed'`; the
comment there says every format that is not a BED must be recognised before BED is asked. A
`sniffG3d(text, name)` goes in that block beside `sniffBarChart`, `sniffInteract`, `sniffGenePred`
and `sniffBedMethyl`, walking the first few hundred rows the way `looksLikeBarChart` does:

1. five or six tab-separated columns;
2. column 2 an integer;
3. columns 3–5 finite numbers, at least one of them fractional or negative over the sample
   (a file of positive integer lattice coordinates is the one ambiguous case, and it is the third
   test that settles it);
4. column 6, if present, one of `m`, `p`, `s`;
5. **consecutive rows on one `(chromosome, haplotype)` are neighbours in space**: the median
   distance between consecutive beads is a small fraction of the extent of the cloud. No BED-family
   file has this signature, and it is what lets a five-column file with no header and a `.bed`
   name still open as what it is.

Collisions checked: a five-column file is a BED5 only if column 3 is an integer end ≥ column 2,
which a coordinate fails whenever it is fractional or negative; a bedGraph is four columns; the
peak flavours are nine, ten and fifteen. The extension (`.g3d`, `.g3d.gz`, `.3dg`) is a tiebreak,
never the test, as in every sniffer here — and the packed container `g3dtools load` writes may
carry the same `.g3d` name (WashU's own example input is `test.g3d.bed.gz`, so the convention is
loose on both sides), which is why the name cannot decide on its own: the container opens with a
magic the text cannot, and a `.g3d` that starts with it is refused by name with the
future-suggestion's wording (§13) rather than parsed as text.

### 2.3 One row in the store, one kind in the union

Following the `barchart` precedent (`src/annotations/types.ts:439-451` is the argument):

- `AnnotationKind` gains `'structure'`, and so does `ANNOTATION_KINDS` (the `satisfies` will not
  compile otherwise). Each predicate in `types.ts:205-335` decides: `isIntervalSet → true` (its
  rows are intervals a metaplot can pile on, the same argument the file makes for `barchart`),
  everything else `false`.
- `FeatureSet` gains an **optional** `model?: { x, y, z: Float32Array; hap: Int8Array; width:
  number }` beside `bars`, `width` being the inferred spacing. Not a third `AnnotationPayload`
  member: that doc explains why a second feature shape silently skips a dozen call sites.
- `FeatureBuilder` (`src/annotations/featureset.ts:53`) carries the triple and the haplotype through
  `finish()`'s sort, exactly as `bars` must — a parallel array in file order against a set in
  genomic order is a bead on the wrong gene, and here on the wrong haplotype too.
- Each row's `detail` carries `hap m`, so `featureFields` discovers **haplotype as a categorical
  field** and the §8.16 picker offers *colour by haplotype* with no code of its own.
- `DetectedFormat` gains `'structure'`; `cardFor` says `'linear'`; `kindFor` says `'structure'`;
  `guessOf` learns the extensions; `cleanLabel` learns the suffixes. `StoredEntry` needs nothing:
  the style is stored wholesale, so a `structure?: StructureStyle` nest on `AnnotationStyle` with
  its clamp beside the `reads`/`features` clamps is the whole persistence change.

What the row buys before any 3D code exists: the file appears in the Annotations column like any
BED, with contig-name overlap reported against the map (§8.2) and renamed into the map's vocabulary
(`renameContigs`, so `chr7` meets `7` through §5.9), drawn as a segments lane on any edge (the beads
*are* intervals, and the two haplotypes stack as two rows of boxes), searchable, exportable,
remembered, shareable, and offered to every task that takes a BED. **Phase 0 changes no renderer**,
and that is the test that the representation is right.

### 2.4 The scene: what the 3D view holds

A pure module with no DOM and no three.js — `src/structure/scene.ts` — so projection, picking, the
locus bridge and the haplotype rules are tested in node and shared by any renderer:

```ts
interface Chain {                 // one contig of one haplotype of one model
  contig: string                  // in the map's vocabulary, after renameContigs
  hap: 'm' | 'p' | 's'
  genome?: string                 // for a .metacool: contigGenomeIds → genome name
  first: number; last: number     // bead index range, contiguous after the sort
}
interface Structure {
  chains: Chain[]
  start: Int32Array; end: Int32Array          // bead intervals (end = start + width)
  width: number                               // the resolution: spacing of sorted starts
  x: Float32Array; y: Float32Array; z: Float32Array   // normalised: centroid 0, radius of gyration 1
  raw: { scale: number }                      // to print distances in the file's own units
  frames?: number                             // §8.3; 1 in phases 1–2
}
```

Normalisation makes a default camera sensible for any file. A gap between two beads wider than
one width breaks the tube there rather than bridging it (§10).

### 2.5 The bridge: (contig, bp) ↔ bead, at any width, for two haplotypes

The map's cells and the file's beads are on different grids, and the rule is §8.4's: nothing
computes a second pixel↔bp mapping. The `LocusAxis` stays the only one; the scene adds only
**bp ↔ bead**, per chain, by binary search over sorted starts — the `searchOffset` shape `Coords`
and `featureRange` already use:

- `beadsAt(contig, bp)`: the bead holding `bp` on **every** haplotype chain of that contig — two
  beads for a diploid file, one for a haploid; `[]` where the file has nothing within one width,
  and `[]` is drawn as nothing, never clamped, which is the deck's own rule for an echo off the
  end of a shorter block.
- `beadsIn(contig, from, to)`: the runs overlapping a stretch, per haplotype, for a coarse bin
  over fine beads, a selection, a manual rectangle, a bookmark.
- `lociOf(bead)`: its `[start, end)` and haplotype, for the readout and the echo.

Above bin level a cell has no base-pair width, so the scene answers whole chains or nothing,
exactly as `locusAxisFrom` returns `null` at genome level.

Because the bridge is base pairs, the map's rung and the structure's spacing are two independent
facts that are never reconciled: a 1 kb map over a 1 Mb model lights the one bead that holds the
cell; a 5 Mb roll-up of the same map lights the five beads it covers; changing from one to the
other re-reads the map and touches nothing in the scene.

---

## 3. Where it lives: the deck, generalised

### 3.1 What the author asked for

> A map in a first cell (with tracks), then in a second cell only tracks, then in a third cell the
> 3D structure. And the deck available even if no contact map is loaded.

Today a deck is *N maps* (§16.1): a lead that is the session's own `MatrixPanel`, companions that
are each a file and a worker, and a gate (`deckIsPossible`, `src/app/Session.ts:5247`) that refuses
a deck on a `.metacool` and outside the five map views. The 1D browser (`BrowserView`) is a whole
alternative mount of the content area, never a cell.

The generalisation is one sentence: **a deck is cells of one place, and a cell is a map, a stack of
tracks, or a structure.** Everything below follows from it.

### 3.2 Cell kinds

| Cell | Occupant | Has | Reports to the lock | Follows the lock on | Lanes |
|---|---|---|---|---|---|
| `map` | `MapPanel` (as now) | its own worker, block, scale, four edges of lanes | rows and cols | rows and cols | on its edges, `MapId` = slot id |
| `tracks` | a `BrowserView` in a cell | the session's own annotation store, client, groups and marks; the file's `/chroms` as its assembly | **cols only** | cols only | its stack, `MapId` = slot id |
| `structure` | `StructurePanel` (§6) | a view of one structure row; a renderer | nothing | cols (and rows, for a chord) — a listener | none |
| `vacant` | `VacantPanel` (as now) | a drop target | — | — | — |

`MapId` (`src/annotations/placement.ts:52`) is already an opaque string "because nothing in this
module has any business knowing what a panel is", so a tracks cell is simply a cell id whose only
placement is its stack, and every existing verb — *put this track on every map, take it off this
one, copy this map's lanes* — works on it unchanged. **There is one track list, the session's**,
and a cell is one more place a track can be sent, exactly as a companion map is today. A track may
be on the lead's bottom edge *and* in the tracks cell at once, which is the arrangement the author
described.

The per-cell placement control (the four edge buttons on a track's row, turned on their side
beside a deck) keeps its shape for every cell, and in a cell that has no map the **`top`, `left`
and `right` buttons are inactive**, greyed with *no map in this cell* on them, leaving the one that
means *in this cell's stack*. Greyed rather than absent because the corrected §8.5 doctrine (§18.1)
says a control is absent only when nothing the reader does next could make it work — and dropping
a `.cool` on that cell would.

### 3.3 The lead is the session's own view, whichever shape it has

A session with a `file` has a map as its lead, as now. A session with an `assembly` and no file has
its `BrowserView` as its lead — re-parented into cell 0 the way the map's view is today
(`PanelDeck.frame()`, `PanelDeck.ts:599`), never rebuilt. That is the whole of "the deck available
without a map": the lead's `LockMember` is one-axis, and its companions may be tracks and
structures; a `map` companion beside a browser lead is allowed too, since the browser's axis is base
pairs like every other member's, and it is how a reader in a 1D session drops a `.cool` beside
their tracks without turning the session into a map session.

`deckIsPossible` splits into two questions: *does the view name a place* (region, genome, pair,
whole, selection, and now the browser with a locus) and *may this cell kind join*. Map companions
keep the `.metacool` refusal (two metagenomes share no coordinate system); tracks and structure
companions of *this* file's contigs are allowed on a `.metacool` genome view.

### 3.4 The lock learns one-axis members

`LockWindow` (`src/panels/lock.ts:83`) is `{ rows, cols, unit }` and every member reports and is
shown both axes. A tracks cell and a browser lead have one axis. The smallest honest change:

- `LockMember` gains `axes(): 'both' | 'cols'`. A one-axis member reports `cols` only and is
  shown `cols` only; its `show(rows, cols)` ignores `rows`.
- The lock's window keeps `rows` from the last two-axis report. A `cols`-only report moves every
  map's columns and leaves its rows where they are — which is the same thing a lane hover echo
  already says (`echoLaneHover`: a track names one axis). On a turned map `cols` is position, so a
  band follows a track exactly.
- The three feedback guards are unchanged: a one-axis member is owed one report after a push and
  `windowsAgree` compares the axis it has.
- `spansAgree`, the compatibility gate, compares `cols` alone for a one-axis pair.

The currency is already base pairs from each block's own start, and a `BrowserView`'s axis is base
pairs at one unit per base (`assemblyAxis`), so its `bpPerCell()` is 1 and its cells are its
window; `showLocus(text)` and `onLocusChange` already exist on it (`BrowserView.ts:986`, `:298`),
so the member is a thin wrapper. `test/unit/panel-lock.test.ts` pins the guards and gains the
one-axis cases.

### 3.5 What the generalisation costs, and in what order

This is the "major work" the author expects, itemised against the code so it can be staged, with
each stage leaving the app whole:

| Stage | Change | Where | Size |
|---|---|---|---|
| **A** | Extract a `DeckPanel` interface from what `PanelDeck` calls on `MapPanel` (`el`, `destroy`, `apply(state)`, `applyLook`, `remeasure`, `repaint`, `syncName`, `setStarred`, `exportCanvas`, a `LockMember`), and a `kind` guarding the map-only calls (`useBinsize`, `setTurnReach`, `scoreOverride`, lane alignment). No behaviour change; `panel-deck.test.ts` and `deck.test.ts` stay green | `PanelDeck.ts` (`adopt`, `build`, `settle`, `align`, `analysable`, `mapList`, `composeDeck`, `keepLanesOnLiveMaps`), `deck.ts` (`PanelRef`) | ~600 lines moved, ~150 new |
| **B** | The structure cell as a listener (§4, §6): drop, `+`, link member, hover both ways, export. Needs A and nothing else | `StructurePanel.ts`, `Slot`, `serialiseMaps` | the structure work proper |
| **C** | The lock's one-axis members (§3.4); the tracks cell as a `BrowserView` over the file's `/chroms` assembly sharing the session's store, client, groups and marks; `MapId` for its stack; `maps=` member `tracks` | `lock.ts`, `PanelDeck.ts`, `Session.ts` (an assembly for a map session: `closeMap` already builds one), `BrowserView.ts` (a `LockMember` wrapper, a `laneEcho`) | ~700 lines + tests |
| **D** | The browser as lead: `deckIsPossible` split, `frame()` re-parenting the browser, a map companion beside a browser lead, `.metacool` allowances for non-map cells | `Session.ts` (`syncDeck`, `framed`, `mountBrowser`), `PanelDeck.ts` | ~400 lines + tests |

A and B deliver the author's third cell. C delivers the second. D delivers the deck without a map.
B does not wait for C or D, which is why the structure can land first.

Two things the generalisation must keep, both stated in §16: **equal cells**, so a comparison's
halves are the same size — a tracks cell is a square whose stack fills it, as "the plot is the
whole column" already says of the browser (§5.8); and **plots aligned to the pixel**, which the
lane-room reservation (`deepestStacks`, `setLaneFloor`) keeps for map cells and which tracks and
structure cells simply do not take part in, reporting no stacks.

### 3.6 The roads not taken

- **A drawer.** The Analysis drawer is "a place to work" and overlays the map; a structure in it
  covers the picture it is read against. The drawer is the right home for the *results* in §8.
- **A side-panel card** for the picture: a column is 256–600 px. The card is right for the
  *controls* (§5.4), as a track's row is right for a lane's.
- **A new `ViewKind`.** `browser` is the precedent, and it would get the hash and history free, but
  it is a different screen from the map and can never stand beside it. A fourth stop on the `v`
  cycle, *structure alone*, is worth having regardless and costs nothing once the cell exists.

---

## 4. The link: hover, pick, window

### 4.1 One store for the pointer's place

There is no hover bus today: hover travels along single-slot setters `PanelDeck` owns
(`setHoverListener`, `setLaneHoverListener`), and the status readout is a module store
(`src/ui/readout.ts`). The app's stated rule for a fact whose producer and consumer are on opposite
sides of the window is a store (`src/ui/revealTrack.ts:10-14`):

```ts
// src/ui/hoverLocus.ts — readout.ts's shape
export interface HoverPlace {
  loci: [Locus] | [Locus, Locus]   // a track, a bead, a tracks cell: one place; a map cell: two
  source: string                   // 'lead' | a slot id | 'browser'
}
export function setHoverPlace(at: HoverPlace | null): void
export function subscribeHoverPlace(l: (at: HoverPlace | null) => void): () => void
```

Producers, each two lines where the locus is already computed: `MatrixPanel.describe`
(`cellLoci` yields both loci, `MatrixPanel.ts:4015`), `MatrixPanel.reportLaneHover`,
`BrowserView.describe`/`forget`, the structure panel. Consumers: the structure panel (ignoring its
own `source`), and a small driver that turns a place into the map's existing echo.
`PanelDeck`'s cell-currency echo stays as it is.

### 4.2 Into the 3D view

| The pointer is on | The store carries | The structure draws | The readout adds |
|---|---|---|---|
| a map cell | two loci | both beads lit on every haplotype, a **chord** per haplotype between them, the rest dimmed | `· 3D 0.83 m / 1.12 p` (model units) |
| a diagonal cell, a lane beside a map, a tracks cell, the browser | one locus | the bead lit on every haplotype, with a halo | `· bead 412 · chr7 m, p` |
| a turned map's cell | two loci (unrotated by `cellLoci`) | as the first row | as the first row |
| a cell above bin level | a whole sequence | the chains lit, no bead | nothing |
| nothing this file has | `[]` from `beadsAt` | nothing — never the nearest bead of another chain | nothing |

The chord is what no other panel can say: *these two loci, whose contact you are pointing at, are
this far apart in the model* — and on a diploid file, *on each homologue*.

### 4.3 Back onto the map and the tracks

A bead is **one genomic place**, so it takes the lane-hover shape, not the cell shape — the
distinction `setLaneHoverListener`'s doc draws (`MatrixPanel.ts:6919-6929`). On the map,
`showLaneEcho({ axis: 'cols', unit })` already draws the small guide on the diagonal (two 45° arms
on a turned map) and a tick in every lane on that axis; a ten-line `showLocusEcho(locus)` converts
through `locusAxes.cols.locusToUnits` — the plural, since a circular sequence panned across its
junction is on the axis twice (§8.15). In a tracks cell and in the browser, the same guide
`drawGuide` draws for their own pointer. In the status bar, `setReadout`. All gated on the `x`
(crosshair) and tooltip preferences, so the app does not disagree with itself about whether
pointers are followed.

### 4.4 Click, pin, pick

- **Click a bead** pins the highlight until the next click; the pin is also a colour source (§5.1).
  Shift-click adds a manual **line** mark at that locus through `ManualStore`, which then appears on
  the map, in every stack, in the export and in the BED the marks card writes.
- **Double-click a bead** navigates: `Session.goToLocus` with a window of a few beads either side,
  as clicking a gene in the browser does.
- **Pick mode.** The panel implements `Armable` (`src/ui/mapPick.ts`) with `oneAxis: true`, so
  *Pick on map* for an analysis parameter or a manual mark works on the model too; `armAll`
  already arms every surface with one shared ending.
- **A drag along the tube** is not a selection in phase 1: a drag is the orbit.

### 4.5 The window

The structure panel is a **listener**, not a reporting `LockMember`: its camera is not a genomic
window and a member that reported one would oscillate, as the lock's header warns. The deck forwards
the lead's framed windows and the structure responds by lighting the beads inside the window and
ghosting the rest (a toggle: others `hide / ghost / show`, default `ghost`); on a `selection`,
`genome` or `pair` view, showing those chains — which is *show and hide sequences* done by
navigation, and what "the deck shares what is being looked at" means for a model. A `⌖` on the
picture frames the lit beads; the camera never moves on its own under the hand.

---

## 5. Colouring, showing, hiding

### 5.1 The picker

One control, on the row and on the picture, mirroring `colourByField` (`src/ui/laneSettings.ts`):

| Colour by | Palette | Reuses |
|---|---|---|
| **sequence** (default for several chains) | one hue per contig; per genome on a `.metacool` | `render/hue.ts`, `CATEGORY_PALETTE` |
| **haplotype** (default for a phased file) | one hue per chromosome at two lightnesses, so a homologue reads as the *same* chromosome and the pair reads as a pair; both homologues are always drawn, and the key's `m`/`p` chips solo one | the categorical field the row already exposes |
| **position along the chain** | a ramp per chain | `colormapColor('viridis', t)` |
| **a loaded track** (bigWig, bedGraph, BAM depth, a synthetic track) | the *lane's own* limits, scale and ramp | `SampleCache.samplesFor` over each bead's `[start, end)` with the covered-base-weighted mean `IntervalTrack.samples` computes; a lifted `valueAt(samples, contig, bp)` out of `AnnotationLanes.ts:2093` |
| **a feature set** (BED, GTF, peaks, loop anchors) | the feature's colour where a bead overlaps one | `featureRange` + `featureColouring(...).colourOf` |
| **a metadata column** (§8.12): MGE call, completeness, weight | per contig or per bin | `MetadataIndex`, `categoryColour` |
| **manual marks** | a line colours its bead, an on-diagonal rectangle its run | `ManualStore.subscribe` |
| **distance to the pinned bead** — 3D-native | a ramp in model units | the scene |
| **contacts with the pinned bead** — the map's own row through it | the map's transform and ramp | the block in hand; zero I/O; the virtual 4C (§8.9) drawn in space |

Two rules carried over from the modules reused: **fit the colouring to the file, not to the
window** (`render/featureInk.ts:32-40`), so rotating the model never changes what a colour means;
and **use the lane's scale**, so a bead coloured by a bigWig agrees with the lane at every value
(a test pins it, §9.3).

### 5.2 Legend, showing, hiding

The key rides in the top-right corner of the picture like the map's (`render/legend.ts`, `MapKey`):
swatches and numbers for a ramp, chips for categories, chain names for *by sequence*, `m`/`p`/`s`
chips for haplotypes. Clicking a chip solos; shift-click toggles. Three places share one state:
navigation (§4.5), the Sequences card's ticks (a tick per row when a structure is loaded; per genome
on a `.metacool`), and the key's chips. A chain the file lacks is listed greyed with *no coordinates
in <file>*, per the corrected §8.5 doctrine.

### 5.3 Aesthetics — on the picture and on the row

On the picture, a button in the bottom-left corner opening a menu upward, where a companion's scale
controls are (§16.5): **representation** (beads · sticks · beads and sticks · tube · ribbon),
**bead radius**, **tube radius**, **opacity** (whole model, and *others* separately), **depth cue**
(none · fog · size), **lighting** (flat · lit · lit with outline), **others** (hide · ghost ·
show), **gaps** (break · dashed), **labels**, **axes gizmo**, **projection** (perspective ·
orthographic — the second for figures), and the **colour by** picker. The row in the Annotations
column carries the same fields; both write one `StructureStyle`.

Background is the light palette `.content` pins for the centre column (`styles.css:1376-1401`);
the renderer's clear colour and label ink come from `readCanvasPalette` (`MatrixPanel.ts:8312`),
never `documentElement`, so a dark-theme export is not a black halo on white paper.

---

## 6. Rendering: three.js, and what it costs to say so

### 6.1 The decision

The first draft argued for a hand-written Canvas 2D painter because it kept the dependency count
at three and the PDF vector. The author's direction is that interaction is the point of this
picture and a library is the price of doing it well. Read against the alternatives:

| Library | Size (minified, tree-shaken use) | Gives | Against |
|---|---|---|---|
| **three.js** | ~350–450 KB for what this needs, out of ~650 KB whole | `TubeGeometry` over a `CatmullRomCurve3` with lighting, `InstancedMesh` spheres, `Line2` fat lines, transparency with sorting, `OutlinePass`/`SSAOPass`, `Raycaster` picking, `OrbitControls`/`TrackballControls`, `OrthographicCamera`, `WebGLRenderer.render` into any canvas size for exports | breaking changes every release (pin exactly, as `electron` is); no vector output |
| deck.gl | > 1 MB | `OrbitView`, `PointCloudLayer`, `LineLayer`, GPU picking | React-shaped, opinionated, far larger |
| Babylon.js | > 1.5 MB | everything three does and an editor | size, and a scene-graph style further from this codebase |
| regl / twgl | ~100 KB | a thin WebGL API | then every geometry, control and pass above is written here — the first draft's cost with a dependency on top |
| NGL / Mol\* / 3Dmol | 1–4 MB | molecular representations, cartoons | built for atoms and residues; beads are a corner case |

**three.js.** It is what every viewer in §1.2 draws with, it has the exact five things the
representations in §5.3 need, and it is the smallest library that has them. Pinned exactly.

### 6.2 What it costs, stated in the open

The spec section has to say each of these, because each is a departure from a rule the code
argues for:

- **The first main-thread runtime dependency.** `export.ts:11-16` writes the PDF in eighty lines
  rather than take a library; `interactivePlot.ts:1-9` does the same for charts. The argument was
  never "no dependencies", it was "not for this arithmetic". A lit, instanced, picked 3D scene is
  not that arithmetic, and the line is drawn there: three.js draws the structure and nothing else.
- **The tube's PDF is a raster; the beads' and sticks' is vector.** `VectorTarget`
  (`src/ui/vector.ts:132`) cannot carry a lit surface, so the tube and ribbon representations
  export as `PanelDeck.saveDeck` already exports a deck: a raster at the export dpi wrapped in a
  one-page PDF, rendered into an offscreen `WebGLRenderer` target of that size — a 300 dpi picture,
  not a screen grab — with the comment saying why. **Beads and sticks export as paths**, in the
  first release: a small painter (`src/structure/painter.ts`, about three hundred lines) takes the
  scene and the camera's own view matrix, projects, depth-sorts, and draws discs and segments
  through `VectorTarget` — `arc`, `moveTo`, `lineTo`, `fill`, `stroke`, all in the subset the 1D
  browser exports through, no gradients. It is not a second renderer: the scene, the camera, the
  colours, what is lit and what is ghosted are the same objects three.js was handed, so the figure
  is the picture on screen in the representation that is paths. It is also the one path the
  `drawingOf` test harness can exercise without a GPU.
- **`GAPS.md:394` refuses WebGL for the heatmap**, and stays right: the map re-rasterises on three
  events and never on pan or zoom. The section narrows the entry to its subject rather than
  deleting it, the way BAM and VCF entries were narrowed.
- **Bundle.** The site build lazy-loads a `three` chunk on the first structure opened (Vite splits
  it out of the main graph; nothing is paid until a file is dropped). The standalone target
  collapses every import into one file (§19, `inlineDynamicImports`), so its 11 MB grows by the
  library's size, under the 24 MB ceiling `scripts/standalone-shape.mjs` asserts. Both numbers go
  in the CHANGELOG entry when measured.
- **Contexts.** Browsers cap live WebGL contexts (Chromium at 16). A deck of six cells cannot
  reach it, but a tab strip of eight sessions each holding a structure could, and a re-parented
  canvas keeps its context. One `WebGLRenderer` per session, drawing each structure cell through a
  scissor region (three.js's documented "multiple elements" arrangement), keeps it to one per tab;
  `webglcontextlost` is handled by rebuilding the scene from the row, which is cheap because the
  row is the source of truth.
- **Tests.** jsdom has no WebGL, and this project does not fake canvases (`test/support/dom.ts`).
  The renderer is therefore a thin adapter over the pure scene: everything with a number in it —
  normalisation, the bridge, the haplotype rules, the camera's matrices, what is lit and what is
  ghosted, the colour of every bead — lives in `src/structure/*` and is tested in node; the painter
  is tested through `drawingOf`; the adapter alone is exercised in a real browser by hand.
- **CSP and targets.** The desktop CSP keeps `'wasm-unsafe-eval'` and no `unsafe-eval`; shader
  compilation needs neither. The standalone `file://` target forbids module workers and sibling
  fetches, neither of which a renderer needs. All six targets read the same source; the adapter
  imports `three` statically so the standalone inlining sees it.

### 6.3 The renderer

- **Scene graph.** One `Group` per chain: an `InstancedMesh` of spheres for beads (one draw call
  per chain, per-instance colour), a `TubeGeometry` along a `CatmullRomCurve3` through the present
  beads for the tube (rebuilt only when the representation or the radius changes, never per frame),
  `Line2` for sticks, a dashed `LineSegments2` across gaps when *gaps: dashed*. Colours are written
  into instance and vertex colour buffers from the pure colour resolver; a colour-by change touches
  buffers, not geometry.
- **Camera.** `PerspectiveCamera` by default, `OrthographicCamera` for figures; `OrbitControls`
  with damping, wheel dolly about the pointer, shift-drag pan, double-click refit, arrow keys when
  focused, touch orbit and pinch. The camera state `{ target, azimuth, elevation, distance,
  projection }` is a plain object the panel owns and the adapter applies — the same "an interactive
  figure is a plain figure of a derived object" rule `interactivePlot.ts` states, kept so the
  export renders the object the controls built.
- **Picking.** `Raycaster` against the instanced beads; on the tube, against the beads' positions
  with a radius, so a pick is always a bead index and never a point on a surface with no locus.
- **Lit and ghosted.** *Others* at reduced opacity in a second material, sorted after the lit ones;
  the hovered bead scaled up with an emissive tint; the pinned bead outlined.
- **Text.** Chain labels and the key are DOM over the canvas (the picture's own `MapKey` element),
  not sprites, so they scale with `textScale` and export through the same path as the map's key.

### 6.4 Performance, so the numbers are in the open

| Data | Beads | three.js |
|---|---|---|
| a MAG, 3 Mb at 5 kb | 600 | trivial |
| *E. coli* at 1 kb | 4,600 | trivial |
| yeast at 1 kb, diploid human at 1 Mb (the example) | 12,000 / 6,000 | 60 fps on integrated graphics |
| human at 100 kb, two haplotypes | 62,000 | 60 fps as instanced beads; the tube at that count is rebuilt in ~100 ms on a representation change and drawn at 60 fps after |
| human at 10 kb | 620,000 | out of scope for a consensus model; the point-cloud representation of §8.3 |

Everything is one read of the whole file at open — one `GET` for a URL, inflated in the worker
— and **0 requests per frame, per gesture and per change of the map's rung**, which is the §12
row.

---

## 7. Persistence and links

| Fact | Where | Precedent |
|---|---|---|
| the structure file | `tracks[]` of the session config as a `StoredEntry` of kind `structure`; a local file arrives detached with its name in a share link | every loaded track |
| the cells and their order | `maps=` in the hash: `3d` for the structure cell, `tracks` for a tracks cell, a URI for a map, `~` for a vacant cell. One structure cell per deck, so `3d` needs no label; the row it shows is the session's structure row | `~` |
| representation, colour-by, radii, opacity, others, gaps, labels, projection | `AnnotationStyle.structure`, stored with the row | `reads`, `features` |
| the camera | **per-file session memory** (`UiMemory`, `structure:camera`), not the hash | the lock, the column count: "the hash has never carried a pan or a zoom" |
| the pinned bead | nowhere | `lastPick()` |
| a `.metacooler.json` | all of the above except the camera, through `buildConfig`/`applyConfig`, no new field | `tracks`, `deck.looks` |

The `maps` key keeps its name for link compatibility; the glossary's *deck* entry changes from
*N maps side by side* to *N cells of one place*, and says why the key is still called `maps`.

---

## 8. The analysis crossovers

Results that belong in the drawer, tracks that belong on a card; none touches the deck.

### 8.1 Model versus map — the validation picture

A task in `src/analysis/tasks/`, `group: 'map'`, `waiting` until a structure row is loaded (§18.1's
menu-not-promise doctrine), producing outputs the drawer already renders: a **distance matrix** of
the model at the map's bins per haplotype (`MatrixOutput`), and the same as `1/d^α`; a
**distance-versus-separation curve** beside the map's own P(s) (`CurveOutput`, log-log, with the
slope); a **table** of Spearman correlations per chromosome between `1/d^α` and the observed
contacts (`TableOutput`). No new output kind.

### 8.2 The model as tracks

Three `ProfileOutput`s resampled onto the framing's bins, which "a synthetic track is a track"
(§18.5) turns into lanes, colour sources for the model itself, and inputs of every track task:
**radial position**, **distance to a picked locus** (the spatial virtual 4C), **local compaction**.
Per haplotype where the file has two.

### 8.3 Ensembles, frames, point clouds

A structure row may hold many models: FOF-CT traces, `.cndb` frames, several g3d texts of one map.
The scene gains a `frame` index and the picture a slider and a play button; the task in §8.1 gains
*mean over frames* and the tracks a per-bead variance; the representation gains a **point cloud**
(a `Points` object, the one place three.js earns its size outright). Deliberately not in phase 1;
nothing in phases 1–2 changes for it.

### 8.4 Inference — not built

Computing a structure from the map in the browser is refused for phases 1–2 under §18.9's rule: a
second caller needs a second upstream, ported from a published method with its own goldens, never a
variation that seemed reasonable. A port of `pastis-mds` for small genomes is a defensible later
item; until then the refusal names the way out, which is `pastis-mds` and `g3dtools` on the command
line and a drop.

---

## 9. What the change looks like in the repository

### 9.1 Files

```
src/annotations/g3d.ts                 sniffG3d, parseG3d (barchart.ts's shape); the width inference; the 3dg name rule
src/structure/scene.ts                 Structure, Chain, normalise, beadsAt/beadsIn/lociOf, haplotypes
src/structure/camera.ts                the camera object, orbit/dolly/pan/fit as arithmetic
src/structure/colour.ts                the colour-by resolvers over the annotation store
src/structure/three.ts                 the adapter: scene graph, materials, controls, picking, raster export
src/structure/painter.ts               beads and sticks through VectorTarget, for the vector PDF
src/panels/StructurePanel.ts           the deck occupant: el, apply, applyLook, exportCanvas, menu, key
src/panels/TracksPanel.ts              stage C: a BrowserView in a cell, as a one-axis LockMember
src/ui/hoverLocus.ts                   the pointer's place, readout.ts's shape
test/unit/g3d-parse.test.ts            the sniff against BED5/6/9, bedGraph, the peak flavours, 3dg; the width from unsorted rows with gaps; a .gz
test/unit/structure-scene.test.ts      bridge arithmetic at a width the bin does not divide, two haplotypes, gaps, circular contigs, above-bin, a rung change
test/unit/structure-camera.test.ts     matrices and fits, goldens computed independently
test/unit/structure-painter.test.ts    drawingOf: discs and segments in depth order, no gradients, the lit ones last
test/unit/structure-colour.test.ts     a bead by a bigWig equals the lane's colour at that value
test/unit/panel-lock.test.ts           one-axis members, the guards
test/dom/structure-panel.test.ts       arrangement, hover in and out, destroy, the menu
test/dom/deck-cells.test.ts            map + tracks + structure from drops and from a link; the browser as lead
test/unit/standalone-shape.test.ts     the new size, measured
```

Touched: `annotations/types.ts`, `featureset.ts`, `loader.ts`, `store.ts`, `worker/protocol.ts`,
`worker/annotations.worker.ts`, `fields.ts`; `panels/deck.ts`, `PanelDeck.ts`, `lock.ts`;
`app/Session.ts`; `ui/MatrixPanel.ts` (`showLocusEcho`, two store writes), `ui/BrowserView.ts`
(the store write, the echo guide, the member), `ui/AnnotationCard.ts`, `ui/SequenceCard.ts`,
`ui/laneSettings.ts` (the greyed edges); `styles.css`; `package.json` (`three`, pinned, with a
`comments` entry in the existing register); `vite.*.config.ts` (the chunk).

Documentation, in the shape the last feature landed in: a numbered `SPECS.md` section (§25) with
its §12 row and its refusals, and a paragraph in §16 for the generalised cell; a `CHANGELOG.md`
entry under `[Unreleased]` with the measured bundle numbers; a README bullet and a line in the
format list; `GLOSSARY.md` entries for **structure**, **model**, **bead**, **chain**,
**haplotype** (as a chain), **cell** (widened), and the amended **deck**; `GAPS.md:394` narrowed.

### 9.2 Demo data

`scripts/make_structure_demo.py` runs `pastis-mds` over `demo/ecoli` and `demo/yeast` at a coarse
bin and writes `Ecoli.g3d.gz` and `Yeast_microC.g3d.gz`, recording in its docstring what it was checked against — and
checks the written file opens in `g3dtools`, which is the independent reader the format has. The
yeast model shows the Rabl arrangement at a glance — centromeres clustered, arms radiating — and is
the picture the README can show. The author's own phased example is the haplotype fixture, if it
can be shared.

### 9.3 Tests worth naming

- The sniff, adversarially: a BED5 with numeric names, a bedGraph, the three peak flavours, a
  headed TSV, the example above with and without its sixth column, unsorted, a `.3dg`. Each lands
  where it lands today except the last three.
- The bridge: a bead width that does not divide the bin size, both ways; a gap; two haplotypes at
  one locus; a contig the map lacks; a circular contig on an axis twice; a cell above bin level;
  the resolution inferred from unsorted starts with gaps.
- The invariant that colour means the same thing on the model and on the lane at the lane's own
  limits and transform — the analogue of `render.test.ts`'s byte-for-byte LUT check.
- The echo loop: a hover on the model produces one `showLocusEcho` on each map and none on itself;
  a tracks cell's report moves every map's columns and no map's rows; nothing oscillates.
- The link round trip: `maps=a.cool|tracks|3d` parses, serialises, and rebuilds three cells in
  order with a `~` where a local map was; a second `3d` in a link is dropped with a note, since a
  deck holds one.
- The width: the example file, shuffled, with two chromosomes and a haplotype column, yields
  `1,040,000` and not the gap; the same file with its sixth column removed yields the same width
  over one chain; a file of three rows yields the one difference it has.

---

## 10. Refused inside this scope, and why

- **No structure inference** in phases 1–2 (§8.4). The way out is a solver and `g3dtools`.
- **No declared resolution.** The width is the spacing of sorted starts, printed on the row; no
  header, no control and no map rung changes it. A file whose starts are irregular gets the mode
  and a summary that says how many beads are not at it, which is the fact the reader needs.
- **No physical unit is invented.** Distances are `model units`; the format carries no unit and
  the app does not ask for one. Nothing converts.
- **No phasing is invented.** A file without the sixth column is `s` throughout, as the format
  says. A `.3dg`'s `(mat)`/`(pat)` become `m`/`p` because that is the rewrite `g3dtools 3dg`
  makes; nothing else is read as a haplotype.
- **No bridging of gaps.** A missing bead breaks the tube; the solver did not place it and a line
  through the gap would be this app's invention. *Gaps: dashed* draws the absence, not a path.
- **No vector PDF of a lit surface.** The tube and ribbon export as a raster at the export dpi,
  and the export row says so; beads and sticks export as paths through the painter, which draws
  the same scene through the same camera.
- **One structure cell per deck.** Two models side by side is a future suggestion (§13), and
  keeping it out is what lets `3d` be a bare word in the link and the structure row be *the*
  structure row.
- **No WebGL for the heatmap.** `GAPS.md:394` keeps its subject.
- **No drag selection on the tube** in phase 1, and **no camera in the link** (§7).
- **No writing back** onto the file that was opened (§13's meaning of write access). Exporting the
  loaded structure recoloured, re-ordered, or coarsened as fresh g3d text is authoring an output
  and is allowed.

---

## 11. A phased plan

| Phase | Delivers | Size | Depends on |
|---|---|---|---|
| **0 — the row** | g3d text and `.gz` recognised and parsed in the worker, local or by URL; the width inferred and printed; a `structure` row that draws as a segments lane with haplotype as a colour field; persisted and shared; the sniff and bridge tests | ~700 lines | nothing |
| **A — the extraction** | `DeckPanel` out of `PanelDeck`; no behaviour change | ~750 lines moved or new | nothing |
| **1 — the cell** | the scene and camera; the three.js adapter with beads, sticks, tube, opacity, depth cue, lighting; both homologues of a phased file; the structure cell from a drop, a `+` cell or a link; hover both ways with the chord and the readout; click to pin, shift-click to mark, double-click to go; colour by sequence, haplotype, position, score; show/hide by navigation, Sequences ticks and key chips; **vector PDF of beads and sticks through the painter, raster PDF/PNG of the tube**, and the deck figure; `v` gains a structure-alone stop; SPECS §25, CHANGELOG with measured sizes, GLOSSARY, README, `GAPS.md` narrowed, demo models | ~3,300 lines + ~1,100 tests | 0, A |
| **C — the tracks cell** | one-axis lock members; a `BrowserView` in a cell over the file's `/chroms`, drawing from the session's one track list; the greyed edge buttons; `maps=…|tracks|…` | ~700 lines + tests | A |
| **D — the deck without a map** | the browser as lead; the gate split; a map companion beside a browser lead; `.metacool` allowances | ~400 lines + tests | C |
| **2 — the colours and the roads** | colour by any track, feature set, metadata column, marks, the pin's distance and contacts; loops as chords; bookmarks as labels; pick mode; `.3dg`, `bed6+xyz` (fixing the broadPeak misread), pastis `.xyz` against the map's bins | ~1,700 lines + tests | 1 |
| **3 — the instrument** | model-versus-map task; the spatial tracks; frames, ensembles and point clouds with FOF-CT and `.cndb` | ~2,000 lines + tests | 2, and someone with ensembles |

Phase 0 is worth doing on its own. 1 does not wait for C or D, which is why the structure lands
before the tracks cell, and C and D are what the author's three-cell row and the map-less deck are.

---

## 13. Future suggestions, not in the plan

Listed so they are decisions deferred rather than omissions, and so nothing in the plan closes
the door on them:

- **Two structure cells in one deck** — two models of one map, or a model against a simulation —
  under one navigation. The design allows it (a cell is a view of a row) and the plan excludes it;
  it would need `3d:<label>` in the link and a way to say which row a cell shows.
- **The packed g3d container** `g3dtools load` writes and WashU's browser loads — indexed,
  multi-resolution, range-readable, with samples. Worth it the day a bucket serves one that is too
  large to read whole, with `g3djs` as the test oracle the way `hic-straw` is for `.hic`.
- **A port of `pastis-mds`** for small genomes in the analysis worker, under §18.9's bar (§8.4).
- **Coarsening a model** the way `g3dtools` does, by averaging beads, so a whole-genome view of a
  fine model draws fewer beads. Cheap, and unneeded at the sizes in §6.4.

---

## 12. Questions still open

The questions of revision 2 are answered and folded in above (resolution, the binary, haplotypes,
the track list, one cell, the vector figure). Two remain, and neither blocks phase 0 or A:

1. **Inference.** Would a port of `pastis-mds` for small genomes be wanted enough to pay the §18.9
   bar for it? It stays in §13 until answered.
2. **The words.** *Structure* (the file, the row), *model* (one set of coordinates), *chain* (one
   contig of one haplotype), *cell* widened to mean any occupant of the deck. Confirm before they
   are written into the glossary, because they are written in a great many places after that.

---

### Sources read for §1.2 and §2.1

- WashU Epigenome Browser 3D module and the g3d format — https://www.nature.com/articles/s41592-022-01550-y ,
  https://epigenomegateway.readthedocs.io/en/latest/3d.html , the `g3dtools` documentation at
  https://g3d.readthedocs.io/en/latest/g3dtools.html (the text input format: chromosome, start,
  X, Y, Z, haplotype `m`/`p`/`s` with `s` when omitted; the `load` and `3dg` commands),
  https://github.com/lidaof/eg-3d-demo
- Spacewalk — https://github.com/igvteam/spacewalk , https://igvteam.github.io/spacewalk/ ,
  https://aidenlab.org/spacewalk/ , https://github.com/aidenlab/swtool , https://github.com/igvteam/swcproject
- Nucleome Browser — https://www.nature.com/articles/s41592-022-01559-3 ,
  https://nb-docs.readthedocs.io/en/latest/component_3d.html
- pastis — https://members.cbio.mines-paristech.fr/~nvaroquaux/pastis/documentation.html ,
  https://pmc.ncbi.nlm.nih.gov/articles/PMC9857972/ , https://nellev.github.io/pastisnb/
- 4DN FISH Omics Format — https://fish-omics-format.readthedocs.io/ ,
  https://data.4dnucleome.org/resources/data-collections/chromatin-tracing-datasets
- three.js — `npm view three` (0.186.0 at the time of writing)
