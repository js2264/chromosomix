# A 3D structure beside the map — survey and design

Working document for a feature that does not exist yet: an interactive 3D view of a chromatin
fibre (one chromosome or several, one genome or several MAGs) inferred from a contact map, drawn
*beside* the map and the tracks, linked to them in both directions, and coloured by whatever the
session already knows about the sequence.

It is a survey rather than a spec. It reads the code as it is today, says where such a view would
plug in and why, evaluates whether it is worth building at all, and ends with a phased plan and the
questions only the author of the data can answer. Nothing here is implemented. When the decision is
taken, the design becomes a numbered `SPECS.md` section in the usual way, with its own refusals.

---

## 0. The short version

**Build it, as a cell of the deck, drawn on Canvas 2D, fed by an annotation row.** In one sentence
per decision:

| Question | Answer | Why, in one line |
|---|---|---|
| Is it worth having? | Yes, scoped tightly | This app's niche — small genomes, whole blocks in memory, analysis in the browser — is exactly where a consensus 3D model is cheapest to make and most defensible to show, and no existing 3D viewer opens the plain file a solver writes without a conversion step |
| Where does it live? | **A cell of the deck** (§16), not a drawer, not a side card | A structure is a *picture of a place*; the deck is the app's word for pictures of one place beside each other under one navigation. A drawer is the app's word for a workspace with a Run button, and it covers the map |
| How is the file held? | **An annotation row** (`kind: 'structure'`), on the `bed6+xyz` road | The file *is* a BED with three columns on the end; the annotation store already gives it sniffing, contig-name matching, persistence, share links, the colour-by-field picker and every export |
| How is it drawn? | **Canvas 2D, painter's algorithm**, camera as part of the figure's own input | No new dependency in a three-dependency project; a true-vector PDF through `ui/vector.ts` like the 1D browser; testable with `drawingOf`; identical in all six build targets. WebGL2 stays a later engine behind the same scene, hand-written, for point clouds |
| How is it linked? | **A hover-locus store** plus the echo hooks `MatrixPanel` already has | The deck already carries a pointer across panels in base pairs; the lane-hover shape (*one place*) is the shape a bead has; the readout bar is a store anyone can write |
| What does it refuse? | Structure *inference*, invented physical units, haplotype folding | Each named in its own section with the way out, in the §13 / §18.9 style |

What it is **not**: a port of Spacewalk or of the WashU 3D module. Both need their own binary format
produced by a converter, both draw with three.js, and both are viewers of a structure with a genome
browser attached. This is the other way round: a genome browser that already has the map, the
tracks, the analysis and the deck, adding one more picture of the same place.

---

## 1. Is it useful, and to whom

### 1.1 Who has this data

Four communities produce bead-per-interval coordinates, and they overlap less than one would hope:

1. **Consensus models from bulk Hi-C** — pastis (MDS, NMDS, PM1/PM2, the newer negative-binomial
   solver), ShRec3D, miniMDS, Chrom3D, HSA, 3DMax, LorDG. One model per map, one bead per bin,
   `NaN` where a bin had no contacts. This is the author's case (§1.4 below) and it is the one
   this app's scale assumptions were written for: a 4 Mb bacterium at 5 kb is 800 beads and a
   pastis run of seconds; a 12 Mb yeast at 10 kb is 1,200; a MAG is a few hundred.
2. **Polymer simulations** — polychrom/OpenMM loop-extrusion and block-copolymer models, HiP-HoP,
   MiChroM. Thousands of conformations per run, each the same shape as (1). Used to *explain* a map
   rather than to summarise it, and the comparison of interest is simulation-vs-data, side by side.
3. **Chromatin tracing** — multiplexed DNA-FISH (ORCA, DNA-MERFISH, seqFISH+). One trace per cell,
   tens to a thousand spots per trace, thousands of cells; the 4DN FISH Omics Format (FOF-CT) fixes
   the table as `Spot_ID, Trace_ID, X, Y, Z, Chrom, Chrom_Start, Chrom_End`. This is the fastest
   growing class and is what Spacewalk was built for.
4. **Single-cell Hi-C models** — Dip-C `.3dg` (`chr1(mat)  1020000  x  y  z`), Stevens et al.
   nuc_dynamics, the Nucleome Data Bank's `.cndb` (HDF5, many frames).

(1) and (2) are one bead per genomic interval on a regular grid and carry the map's own contig
names. (3) and (4) are ensembles, sparse on the genome, often haplotype-resolved. A design that
serves (1) and (2) well in a first release and *does not close the door* on (3) and (4) is the
right shape; a design that tries to serve all four at once is Spacewalk, which is a separate
application.

### 1.2 What the existing viewers do, and what none of them does

| Tool | Input | Draws with | Linked to | Coloured by | Needs |
|---|---|---|---|---|---|
| WashU Epigenome Browser 3D module | `.g3d` (binary, indexed, multi-resolution, haplotypes) | three.js | its own 1D tracks; the browser window is highlighted in yellow; gene and Hi-C anchors can be shown | bigWig ("paint"), BED annotations (chromHMM, compartments) | `g3dtools` conversion from text |
| Spacewalk (igv team, Aiden lab) | `.sw` (HDF5), FOF-CT | three.js | an embedded igv.js and juicebox.js | genomic position, tracks | `swtool`/`swcproject` conversion; its own page |
| Nucleome Browser | `.g3d` | three.js | every component through an event-dispatch channel | signals | a hosted platform |
| 3D Genome Browser 2.0 | its own models | — | its own tracks | — | a server |
| ChimeraX / PyMOL with pastis' PDB | PDB | GPU | nothing genomic | manual | a desktop application |

Three things none of them does, and each is something this app already is:

- **Open the file a solver writes, as written.** Every browser above wants a converted binary.
  pastis writes text; Chrom3D writes CMM; a `bed6+xyz` is what anybody with a spreadsheet writes.
  C3 (no preprocessing) applied to a structure is a genuine difference, not a convenience.
- **Compute the colouring in the same window.** Compartment eigenvectors, insulation, coverage,
  cis fraction, a virtual 4C, and for a `.metacool` the contig table's own MGE call, completeness
  and contamination — all are already one click away and all are already *tracks* (§18.5). Painting
  a model with an eigenvector computed thirty seconds earlier from the map beside it is a loop no
  hosted viewer closes, because none of them computes anything.
- **Put the model beside the map it came from, under one navigation.** The deck exists to say
  "these pictures are of one place"; the lock's currency is base pairs from each block's own start;
  a hover on any panel is echoed on every other. A structure is one more panel that speaks base
  pairs.

### 1.3 The honest case against

- **A consensus model from bulk Hi-C is a summary, not a measurement.** A population of cells has a
  distribution of conformations, and the MDS optimum is one point in it that may resemble none of
  them. A good fraction of the field treats these pictures as illustrations. The design has to make
  it hard to over-read: the model's own distance map beside the real map (§8) is the picture that
  keeps the reader honest, and the readout should say `model units`, never nanometres, unless the
  file says otherwise.
- **The people who make the models already have ChimeraX.** The gain is not "a 3D view exists" but
  "the 3D view knows what the map and the tracks know". If the linking and the colouring are thin,
  nobody will leave ChimeraX for this.
- **It is a new rendering surface**, the first since the 1D browser: camera, projection, picking,
  depth ordering, a figure export, tests, a spec section, a glossary. Realistically 4–6 k lines
  including tests across the three phases in §11, of which about half is the first release.
- **Screen.** A deck cell is a square the size of the map. On a laptop with three side columns
  open, two cells is already tight. That is the deck's existing problem and its existing answer
  (fold the columns; `v`), not a new one.
- **The mammalian `.hic` audience gets little** until ensembles and tracing arrive: nobody
  infers a single consensus structure of a human genome at 10 kb (310 k beads) and then looks at
  it in a browser. Phase 1 is for bacteria, yeast, MAGs, *Plasmodium*, and teaching. Whether phase
  3 is built decides whether it is for everyone else.

**Net.** High value for the lab's own bacterial, yeast and metagenomic work and for teaching;
medium for the wider cooler/`.hic` audience; a real differentiator only in combination with the
analysis panel and the deck, which is why the design below leans on both. Worth building as long as
phase 1 is kept small and the refusals in §10 are stated up front.

### 1.4 What the author has

> A file that looks like a bed file (standard 6 columns), plus 3D coordinates. Bed ranges are not
> necessarily the same width as the resolution of a contact map which could optionally be loaded.

So: `chrom  start  end  name  score  strand  x  y  z`, one row per bead, possibly with `nan` rows,
possibly several chromosomes, possibly several genomes, at a bead width that need not divide the
map's bin size and need not match it. Everything below takes that file as the primary format.

---

## 2. The data: what arrives, how it is recognised, how it is held

### 2.1 Formats, in the order they are worth reading

| Format | What it is | Loci in the file? | Ensemble? | Reader cost | Phase |
|---|---|---|---|---|---|
| **`bed6+xyz`** | the author's file; also what `pastis` users write once they join the bin table back on | yes | no (one file per model) | whole-file text parse, same as any BED | **1** |
| pastis `.structure` / `.xyz` text | `x y z` per bead in bin order, `nan` for missing, no loci | **no** | no | trivial parse; loci from the map's own bin arithmetic (§2.5) | 2 |
| PDB (`pastis --pdb`, Chrom3D) | `HETATM` per bead, chain per chromosome, residue number = bead index | partly (chain = chromosome, index = bead) | sometimes (`MODEL` records) | fixed-column parse | 2 |
| Dip-C `.3dg` | `chrom(hap)  pos  x  y  z` | yes, haplotyped | no | text parse; haplotype refusal (§10) | 2 |
| FOF-CT (4DN chromatin tracing) | `Spot_ID, Trace_ID, X, Y, Z, Chrom, Chrom_Start, Chrom_End, …` | yes | **yes**, one trace per cell | CSV parse, group by trace | 3 |
| `.g3d` (WashU) | binary, bed-like, indexed, multi-resolution, haplotypes, samples | yes | per sample | **bounded range reads** — the one 3D format that fits §12 as written | 3 |
| `.cndb` (Nucleome Data Bank) | HDF5, frames of a simulation | yes | **yes** | `h5wasm` is already here; SPECS §12 already names `hdf5-indexed-reader` as built for it | 3 |
| Spacewalk `.sw` | HDF5 | yes | yes | as `.cndb` | 3 if ever |

Phase 1 reads one format. The rest are listed so the in-memory shape (§2.4) is chosen with them in
mind rather than rebuilt for them.

### 2.2 Recognising `bed6+xyz`, and the collision that decides how

The annotation worker's `load()` is the registry
(`src/annotations/worker/annotations.worker.ts:1469-1606`), and it is a straight-line ladder whose
last rung is `sniffFormat`, whose last line is `return 'bed'`. The comment there states the rule:
*every format that is not a BED has to be recognised before BED is asked.* A structure sniffer goes
in that block, beside `sniffBarChart`, `sniffInteract`, `sniffGenePred` and `sniffBedMethyl`.

**Today the author's file is silently a broadPeak.** `peakFlavour` (`src/annotations/parse.ts:289`)
reads a nine-column file with a fractional number in columns 7–9 and no comma in column 9 as
`broad`. A `bed6+xyz` is exactly that. It would load without a word, draw as a peak lane with
`signalValue = x`, and be wrong everywhere. So the structure sniffer must run **before**
`peakFlavour` is consulted, and it needs a positive signal of its own rather than "nine columns and
floats". Three, any one sufficient, in this order:

1. **A header naming the columns** — `#chrom start end name score strand x y z` or the `track`
   line's `type=structure`. `readHeader` (`parse.ts:180`) already finds a header row; the sniffer
   reads its last three words. This is the contract the spec should state: *a structure file says
   so in its header.*
2. **The extension** — `.3d.bed`, `.xyz.bed`, `.structure`. The name is a tiebreak in every sniffer
   here (`barchart.ts:105`), never the whole test, and `.broadPeak` keeps winning its own name.
3. **The signature no peak file has: consecutive rows on one chromosome are neighbours in space.**
   Over the first few hundred rows, the median distance between consecutive beads on the same
   contig is a small fraction of the extent of the cloud; a broadPeak's `signal, p, q` triples have
   no such coherence. A `signalValue < 0` or a `p`/`q` below −1 also rules broadPeak out, since
   those are non-negative with −1 as the only sentinel, and model coordinates are centred.

The sniff is cheap (it is the same first-rows walk `looksLikeBarChart` does) and the third test is
what lets a plain nine-column file with no header and a `.bed` name still open as what it is.
A file that fails all three is a broadPeak, as now.

### 2.3 One row in the store, one kind in the union

Following the `barchart` precedent exactly (`src/annotations/types.ts:439-451` is the argument):

- `AnnotationKind` gains `'structure'`, and so does `ANNOTATION_KINDS` (the `satisfies` fails to
  compile otherwise). The predicates in `types.ts:205-335` each get a decision:
  `isIntervalSet → true` (its rows are intervals a metaplot can pile on, the same argument the
  file makes for `barchart`); everything else `false`.
- `FeatureSet` gains an **optional** `xyz?: { x: Float32Array; y: Float32Array; z: Float32Array }`
  beside `bars`. Not a third `AnnotationPayload` member — that doc explains why a second feature
  shape silently skips a dozen call sites.
- `FeatureBuilder` (`src/annotations/featureset.ts:53`) carries the triple through `finish()`'s
  **sort**, exactly as `bars` must — a parallel array in file order against a set in genomic order
  is a bead on the wrong gene.
- `DetectedFormat` gains `'structure'`; `cardFor` says `'linear'`; `kindFor` says `'structure'`;
  `guessOf` learns the two extensions; `cleanLabel` learns the suffix.
- `StoredEntry` needs **nothing**: `toStored`/`isStoredEntry` are driven by the kind list and the
  style is stored wholesale. A `structure?: StructureStyle` nest on `AnnotationStyle`, with its
  clamp beside the `reads`/`features` clamps in `store.stored()`, is the whole persistence change.

What the row buys, before any 3D code exists: the file appears in the Annotations column like any
BED, with contig-name overlap reported against the map (§8.2), renamed into the map's vocabulary
(`renameContigs`, so `chr1` meets `1` and `chrI` meets `I` through §5.9), drawn as an ordinary
segments lane on any edge (the beads *are* intervals), searchable, exportable, remembered in the
session, carried in a share link, and offered to every analysis task that takes "a BED". That is
the test that the representation is right: **phase 0 changes no renderer.**

### 2.4 The scene: what the 3D view actually holds

The row holds the file. The view holds a *scene* derived from it, in a pure module with no DOM —
`src/structure/scene.ts` — so that projection, picking and the locus bridge are tested in node and
shared by whichever renderer draws them:

```ts
interface Chain {              // one contig of one model
  contig: string               // in the map's vocabulary, after renameContigs
  genome?: string              // for a .metacool: contigGenomeIds → genome name
  first: number; last: number  // bead index range, contiguous after the sort
}
interface Structure {
  chains: Chain[]
  start: Int32Array; end: Int32Array         // bead intervals, per bead
  x: Float32Array; y: Float32Array; z: Float32Array   // normalised: centroid at 0, radius of gyration 1
  raw: { scale: number; unit: string | null }          // to print distances in the file's own units
  present: Uint8Array                          // 0 where the file said nan
}
```

Normalisation is what makes a camera default sensible for any file: centre at the centroid, divide
by the radius of gyration, keep the factor so the readout can say `0.83 model units` (or `nm` if
the header declared one). Gaps (`nan`) are kept as beads with `present = 0` so bead index stays
equal to row index and the tube is *broken* there rather than bridged — a bridged gap invents a
path the solver did not.

### 2.5 The bridge: (contig, bp) ↔ bead, at any bead width

The map's cells and the file's beads are on different grids, and the rule is the one §8.4 states
for tracks: nothing computes a second coordinate mapping. The `LocusAxis` stays the only pixel↔bp
bridge; the scene adds only **bp ↔ bead**, per chain, by binary search over sorted bead starts —
the same `searchOffset` shape `Coords` and `featureRange` already use:

- `beadAt(contig, bp)`: the bead whose `[start, end)` holds `bp`; if none (a gap, or between
  beads of a sparse file), the nearest bead on that chain within one bead width, else `null`.
  **`null` means "nothing here" and is drawn as nothing**, never clamped — the deck's own rule
  for an echo off the end of a shorter block (`PanelDeck.echoHover`).
- `beadsIn(contig, from, to)`: the run of beads overlapping a stretch, for a coarse bin over
  several fine beads, a selection, a manual rectangle, or a bookmark.
- `lociOf(bead)`: its `[start, end)`, for the readout and for the echo back onto the map.

A map bin wider than a bead lights a run of beads; a bead wider than a bin lights one bead for
several bins. Neither needs to know the other's width. Above bin level (`level: 'contig'` or
`'genome'`) a cell has no base-pair width; the scene answers a whole chain, or nothing, exactly as
`locusAxisFrom` returns `null` at genome level.

A pastis `.xyz` with no loci (phase 2) is bridged the other way round: when its row count equals the
map's bin count at the open rung, `Coords.binStart/binEnd` supply the intervals and the row becomes
an ordinary structure. When it does not, the refusal names both counts and the fix (*join the bin
table on with `paste`* — one line, given in the message).

---

## 3. Where it lives

The four candidates the author raised, read against the code.

### 3.1 A cell of the deck — recommended

The deck (`src/panels/PanelDeck.ts`) is a lead plus companions in a CSS grid of equal columns, one
navigation, per-panel presentation. Everything a structure panel needs to be *beside* a map is
already there, and each piece was surveyed against the code:

- **An empty cell is already a non-map occupant.** `VacantPanel` (`src/panels/MapPanel.ts:1520`)
  has "no worker, no reader and nothing to read: it is a sentence and a drop target", and it is a
  real cell with a `~` in the link. `Slot` (`PanelDeck.ts:366`) holds `panel | vacancy`; it grows a
  third field, `structure: StructurePanel | null`, or becomes a small discriminated union.
- **The `+` edges and the drop are the gesture.** `DeckFrame` already opens a cell on a press and
  fills it from a drop, a chooser or a URL. Dropping a structure file on an empty cell fills it with
  the model; dropping one anywhere else adds a row *and* grows the deck by one cell holding it —
  **add, do not replace**, the doctrine `GLOSSARY.md` states for every drop.
- **The link.** `maps=` gains a member. `PanelRef` becomes
  `remote | local | vacant | { kind: 'structure'; track: string }`, serialised as `3d` when the
  session holds one structure and `3d:<row label>` when it holds several. A structure cell is *not*
  `~` on the far end of a link, because the file that fills it travels in `#session=` as a track
  row already (a local one arrives detached with its name, like any local track).
- **Cross-panel hover is already fanned out by one owner** (`echoHover`, `echoLaneHover`,
  `PanelDeck.ts:1037-1120`), in base pairs, refusing rather than clamping. A structure cell is one
  more recipient and one more source (§4).
- **Per-panel presentation memory, the grip, rename, star, close, budget division, and
  `composeDeck`** come free once the occupant exposes `el`, `destroy`, `apply(state)`,
  `applyLook`, `remeasure`, `repaint`, and `exportCanvas(dpi, now)`.

What has to give:

- **`PanelDeck` is hard-typed to `MapPanel`/`MatrixPanel`** in a dozen methods (`adopt`, `build`,
  `settle`, `align`, `analysable`, `mapList`, `composeDeck`, `keepLanesOnLiveMaps`). This is an
  *extraction*: a `DeckPanel` interface pulled out of the union of what the deck calls, with
  `MapPanel` and `StructurePanel` both satisfying it, and the map-only calls (`useBinsize`,
  `setTurnReach`, `scoreOverride`, lane alignment) guarded by a `kind`. Bounded, mechanical, and
  the kind of change the existing `panel-deck.test.ts` catches.
- **`deckIsPossible`** (`src/app/Session.ts:5247`) refuses a deck on a `.metacool` (two metagenomes
  share no coordinate system) and outside the five map views. A structure of *this* file's contigs
  has no such problem, so the predicate splits: *a deck of maps* keeps its gate; *a deck whose
  companions are all structures* is allowed on a `.metacool` genome view and, in phase 2, beside
  the 1D browser (§3.5).
- **The lane-room alignment** (`deepestStacks`, `setLaneFloor`) pads every panel so the plots line
  up to the pixel. A structure cell reports no lanes and is padded like a companion with none; its
  picture is the square the map's picture is, at the same height, which is what the figure wants.
- **The budget** (`panelBudgetBytes`) divides a dense-block allowance. A structure holds a few
  hundred kilobytes of typed arrays and no worker; it should count as a cell for the layout and
  not as a panel for the division, which is one line in `filled`.

### 3.2 A drawer — no

The Analysis drawer (§18.1) is "a place to work": parameters, Run, progress, results. It overlays
the content and the two right columns because "at three quarters of the window there is nothing
left to squeeze". A structure in a drawer would cover the map it is meant to be read against, and
would be the one picture in the app that cannot be in a figure with the others. The drawer is the
right home for the *analysis* crossovers in §8 — a distance map, a model-vs-map curve — which are
results, not pictures of a place.

### 3.3 A side-panel card — no, except as controls

A column is 256–600 px wide and §16.5 argues at length that deck-shaped things do not belong in the
session's furniture. A card the size of the Minimap cannot be orbited or read. But the **controls**
belong in a card: the structure's row in the Annotations column carries its 3D options the way a
track's row carries its lane options (§5.4), and the Sequences card in the General column is where
chains are shown and hidden (§5.3). Picture in the centre, controls in the columns — the split
every other feature keeps.

### 3.4 A new `ViewKind` — the fallback, not the answer

`browser` is the exact precedent for a full-content-area view with its own canvas and no map, and a
`structure` view kind would get the hash, history, breadcrumb and share link for free. But it is a
*different screen* from the map: `deckIsPossible` would refuse a deck on it, so the model could
never sit beside the map, which is the whole point. And every navigation rebuilds a view
(`showContent` destroys the current one); a structure with its camera would have to be cached the
way `wholeFile` is. Keep it as the road if the deck extraction turns out worse than surveyed. A
narrower version is worth having anyway: a fourth stop on the `v` cycle, "structure alone", which is
the map-alone presentation with a different picture in the square and costs nothing once the cell
exists.

### 3.5 The 1D browser session

A session with an assembly and no map (§5.8) has tracks and would like a structure beside them —
tracing data often arrives with no map at all. The browser is not a deck panel today and the deck is
refused there. Two roads, in order of cost: (a) phase 2 widens `deckIsPossible` to allow a
structure-only deck beside the browser, the browser mounted in cell 0 the way the lead's view is
re-parented today; (b) the `v` cycle's "structure alone" stop, which works with no deck at all.
Do (b) in phase 1 because it is nearly free, and (a) in phase 2.

---

## 4. The link: hover, pick, window

The author's requirement, exactly: *pinpoint in 3D where along a chromosome I am hovering in 1D or
2D, and vice-versa.* Four surfaces, three shapes of pointer, one currency.

### 4.1 One store for the pointer's place

There is no hover bus today. Hover travels along single-slot setters that `PanelDeck` owns
(`setHoverListener`, `setLaneHoverListener`), and the readout bar is a module store
(`src/ui/readout.ts`, 29 lines) that anyone writes and the status bar reads. The app's stated rule
for a fact whose producer and consumer are on opposite sides of the window is a store, not a callback
threaded through four views (`src/ui/revealTrack.ts:10-14`). So:

```ts
// src/ui/hoverLocus.ts — the readout.ts template
export interface HoverPlace {
  loci: [Locus] | [Locus, Locus]   // a track or a bead names one place; a map cell names two
  source: string                   // 'lead' | a slot id | 'browser' | a structure cell's id
}
export function setHoverPlace(at: HoverPlace | null): void
export function subscribeHoverPlace(l: (at: HoverPlace | null) => void): () => void
```

Producers, each a two-line addition at the point where the locus is already computed:
`MatrixPanel.describe` (`cellLoci` already yields both loci, `MatrixPanel.ts:4015`),
`MatrixPanel.reportLaneHover`, `BrowserView.describe` / `forget`, and the structure panel.
Consumers: the structure panel (ignoring its own `source`), and a small driver that turns a place
into the map's existing echo. `PanelDeck`'s cell-currency echo is untouched; this is the same
decision it took — base pairs — one level up.

### 4.2 From the map and the tracks into the 3D view

| The pointer is on | The store carries | The structure draws | The readout adds |
|---|---|---|---|
| a map cell (`row × col`) | two loci | both beads lit, a **chord** between them, the rest dimmed by the depth cue | `· 3D 0.83` (model units), after the existing `chrI:… × chrIV:… · 12 contacts` |
| a diagonal cell, or a track beside the map, or the 1D browser | one locus | one bead lit with a halo | `· bead 412 of chrIV` |
| a turned map's cell | two loci (`cellLoci` already unrotates) | as the first row | as the first row |
| a cell above bin level | a whole sequence | the chain lit, no bead | nothing |
| nothing this file has | `null` from `beadAt` | nothing — never the nearest bead of another chain | nothing |

The chord is the one thing a 3D view can say that no other panel can: *these two loci, whose
contact you are pointing at, are this far apart in the model.* It costs one line and a number.

### 4.3 From the 3D view back onto the map and the tracks

A bead is **one genomic place**, so it takes the lane-hover shape, not the cell shape — the
distinction `setLaneHoverListener`'s doc draws (`MatrixPanel.ts:6919-6929`): a deck that folded
them together would have to invent the missing half. What already exists:

- On the map: `showLaneEcho({ axis: 'cols', unit })` draws the small guide on the diagonal (two 45°
  arms on a turned map) and a tick in every lane that measures that axis. A ten-line
  `showLocusEcho(locus)` beside it converts through `locusAxes.cols.locusToUnits` — the plural,
  because a circular sequence panned across its junction is on the axis twice (§8.15).
- In the 1D browser: the same guide `drawGuide` already draws for its own pointer, at
  `scale.toPixel(axis.locusToUnit(...))`, gated on `getPlotOptions().crosshair` like every other
  pointer-following mark.
- In the status bar: `setReadout('chrIV:1,204,000-1,214,000 · bead 412 · chrIV')`.

Every one of those honours the `x` (crosshair) and tooltip preferences, so the app does not
disagree with itself about whether pointers are being followed.

### 4.4 Click, pin, pick

- **Click a bead** pins the highlight until the next click, so a reader can move to the map and
  find the place with the pointer free. Shift-click adds a manual **line** mark at that locus
  through `ManualStore` — the mark then appears on the map, in the lanes, in the browser, in the
  export and in the BED the marks card writes, with no code of its own.
- **Double-click a bead** navigates: `Session.goToLocus` with a window of a few beads either side,
  which is what clicking a gene in the browser does.
- **Pick mode.** The structure panel implements `Armable` (`src/ui/mapPick.ts`) with
  `oneAxis: true`, so *Pick on map* for an analysis parameter or a manual mark works by pointing at
  the model too. `armAll` already arms every surface on screen with one shared ending.
- **A drag along the tube** is not a selection in phase 1. A drag is the orbit (§6.4); the
  selection gestures the map has (a marquee) have no honest analogue on a curve.

### 4.5 The window: what the deck is looking at

The lock (`src/panels/lock.ts`) carries one window in base pairs from each block's own start, and
guards its feedback loop three ways. A structure panel has no cell grid and its camera is not a
genomic window, so it should **not** be a `LockMember` that reports; a naive member oscillates, and
the lock's header says so. It is a one-way *listener*: the deck forwards the lead's framed windows
(`framedWindows`, per axis) and the structure responds by:

- lighting the beads inside the window and ghosting the rest (a toggle: others `hide / ghost /
  show`, default `ghost`), so zooming the map into a domain narrows the model to that domain;
- on a `selection`, `genome` or `pair` view, showing those chains and no others — this is *show and
  hide sequences* done by navigation rather than by ticks, and it is what "the deck shares what is
  being looked at" means for a model;
- optionally re-framing the camera on the lit beads (a button on the picture, `⌖`, and a
  preference), never automatically on every pan, which would make the model lurch under the hand.

Nothing flows back from the camera to the lock. "Frame this" is a gesture on the picture, not a
navigation.

---

## 5. Colouring, showing, hiding

### 5.1 The picker

One control, on the row and on the picture, mirroring `colourByField` (`src/ui/laneSettings.ts`)
so it reads like the one every feature lane has:

| Colour by | Palette | Reuses |
|---|---|---|
| **sequence** (default for several chains) | one hue per contig, `hueOf`/`rotateHue` from the row's colour; per genome on a `.metacool` | `render/hue.ts`, `CATEGORY_PALETTE` |
| **position along the chain** (default for one) | a ramp per chain, start to end | `colormapColor('viridis', t)` |
| the file's own columns: **score**, **name**, **strand**, any headed numeric column | number → ramp, category → Okabe–Ito | `featureFields`, `fieldRange`, `fieldLevels`, `featureColouring` — the whole §8.16 machinery |
| **a loaded track** (bigWig, bedGraph, BAM depth, a synthetic track) | the *lane's own* scale: its `limits`, `scale`, `colormap`; diverging ramps stay centred | `SampleCache.samplesFor` over each bead's own `[start, end)` with the covered-base-weighted mean `IntervalTrack.samples` already computes; a lifted `valueAt(samples, contig, bp)` out of `AnnotationLanes.ts:2093` |
| **a feature set** (BED, GTF, peaks, loops' anchors) | the feature's colour where a bead overlaps one, grey elsewhere; or the set's own colour-by | `featureRange` + `featureColouring(...).colourOf` |
| **a metadata column** of the file (§8.12): MGE call, completeness, contamination, weight | per contig or per bin, as the column is | `MetadataIndex`, `classify`, `categoryColour` |
| **manual marks** | a line colours its bead, an on-diagonal rectangle colours its run of beads, in the mark's own colour | `ManualStore.subscribe` |
| **distance to the pinned bead** — 3D-native | a ramp in model units | the scene alone |
| **contacts with the pinned bead** — the map's own row through that bead | the map's transform and ramp | the block in hand; zero I/O; this is the virtual 4C (§8.9) drawn in space |

Two rules carried over from the modules being reused, because they are what make a colour mean the
same thing on the model and on the lane beside it:

- **Fit the colouring to the file, not to the window** (`render/featureInk.ts:32-40`). Rotating the
  model must not change what a colour means.
- **Use the lane's scale.** A bead coloured by a bigWig takes `resolveLimits` of that lane, so the
  model and the lane agree at every value, and a test pins that (§9).

### 5.2 Legend

The map's key rides in the top-right corner of the picture, in the units the reader is using
(`render/legend.ts`, `MapKey`). The structure's key is the same object in the same corner: two
swatches and two numbers for a ramp, the category chips for a categorical, the chain names for
"by sequence". Clicking a chain's chip solos it.

### 5.3 Showing and hiding sequences

Three places, one state, so they never disagree:

1. **Navigation** (§4.5): the view's own sequences are shown; the others are `ghost` by default.
2. **The Sequences card** in the General column already lists every contig with a length bar and a
   click that goes there; it gains a tick per row when a structure is loaded. Ticks are the
   "others: show" set. On a `.metacool`, the genomes table's ticks do the same per genome.
3. **The key's chips** solo a chain (click) or toggle it (shift-click).

A chain the file does not have is listed greyed with *no coordinates in <file>*, per the corrected
§8.5 doctrine: listed and told what would make it work, not hidden.

### 5.4 Aesthetics — what is on the row and on the picture

On the picture, a button in the bottom-left corner opening a menu upward, exactly where a
companion's scale controls are (§16.5): **representation** (beads · sticks · beads and sticks ·
tube), **bead radius**, **tube width**, **depth cue** (none · fade · size · both), **others**
(hide · ghost · show), **gaps** (break · dashed), **labels** (none · chain names · chain names and
bookmarks), **axes gizmo**, and the **colour by** picker. On the row in the Annotations column the
same fields, since the row is where a track's options already live; both write one
`StructureStyle` and the picture is the source of truth for what is drawn.

Background is the light palette `.content` pins for the whole centre column
(`styles.css:1376-1401`); the canvas reads its ink through `readCanvasPalette`
(`MatrixPanel.ts:8312`), never `documentElement`, so a dark-theme export is not a black halo on
white paper — the bug that rule exists to prevent.

---

## 6. Rendering: technique and the dependency decision

### 6.1 How big the pictures are

| Data | Beads | Per frame on Canvas 2D (arcs + segments), Chromium, rough |
|---|---|---|
| a MAG, 3 Mb at 5 kb | 600 | < 1 ms |
| *E. coli*, 4.6 Mb at 1 kb | 4,600 | 2–4 ms |
| yeast, 12 Mb at 10 kb / 1 kb | 1,200 / 12,000 | 1 ms / 6–10 ms |
| *Plasmodium*, 23 Mb at 10 kb | 2,300 | 1–2 ms |
| human, 3 Gb at 100 kb | 31,000 | 20–25 ms as arcs; 3–5 ms as a stroked polyline with square dots |
| a chromatin trace, one cell | 30–1,000 | trivial; ×1,000 cells is a point cloud (§6.5) |

Everything the phase-1 audience has is a few thousand beads. The upper rows say where the Canvas 2D
path stops being comfortable (around 30 k beads as shaded discs, which is where the representation
drops to a polyline automatically) and where a GPU path starts earning its keep (point clouds).

### 6.2 Canvas 2D, painter's algorithm — the recommendation

- **Projection** is nine multiplications per bead: a rotation from `{azimuth, elevation}`, a
  perspective or orthographic divide, a translate and a uniform scale into the box. `render/rotate.ts`
  is the precedent for a non-axis-aligned transform done as arithmetic in a pure module with the
  isometry argued in the header.
- **Ordering** is a depth sort of bead indices (a typed-array sort, or a counting sort into 256
  depth buckets, which is O(N) and stable enough at this size). Segments are sorted with their
  midpoints. Painter's order is exact for discs of one radius and good enough for tubes.
- **Shading without gradients**: a lit disc is two `arc`s, the second smaller and offset towards
  the light, or a depth-cued alpha; a tube is a stroked polyline whose width follows depth.
  Gradients are deliberately not used because `createLinearGradient` is not in `VectorTarget`
  (`src/ui/vector.ts:132-174`), and the point of drawing this way is the next item.
- **A true-vector PDF for free.** `arc`, `moveTo`, `lineTo`, `fill`, `stroke`, `setLineDash` and
  `fillText` are all in the subset the 1D browser exports through. Five thousand beads are five
  thousand paths — "tens of cells are paths" is the rule `analysisPlots.ts:11-15` applies, and
  this is on the paths side. The same `draw(ctx, box)` serves the screen, the PNG at any dpi and
  the PDF, so there is no second drawing to keep in step (§7.2).
- **The camera is part of the figure's input, not a transform around `draw`.** This is the rule
  `interactivePlot.ts:11-25` states — an interactive figure is a plain figure of a derived object —
  and it is what makes the export correct by construction: `StructureFigure.draw` reads
  `{ scene, camera, style, lit, pinned }` and nothing else.
- **Picking** is a nearest-projected-bead search front-to-back within a radius, O(N) per move and
  well under a millisecond at 12 k. No ID buffer needed.
- **Tests** run in node without a canvas: projection goldens computed independently, a `drawingOf`
  assertion that the figure puts marks on a `VectorPage`, which is also the export test.
- **No dependency.** The project hand-writes its PDF in eighty lines rather than take a library
  (`export.ts:11-16`), and hand-writes its charts for the same reason. A 3D projection is less code
  than either.

### 6.3 Why not three.js, and what GAPS.md already says

`GAPS.md:394` refuses *WebGL rendering* — for the heatmap, whose technique re-rasterises on three
events and never on pan or zoom, so "there is nothing here for a GPU to fix". That sentence is
about the 2D map's cost model and does not touch a 3D picture; but it is the first line a reviewer
will quote, so the spec section must say in the open that it is not re-litigating it, and name what
a GPU would be for here (a point cloud redrawn every frame under orbit), and why phase 1 still does
not need one (a few thousand paths).

three.js itself would be the first main-thread runtime dependency in the project's history, about
600 KB minified against an 80-line-PDF precedent, forfeits the vector export, and cannot be
lazy-loaded away from the standalone file — `inlineDynamicImports` collapses the graph to one chunk
(§19). It stays out.

### 6.4 Interaction

Drag orbits. Wheel dollies about the pointer (zoom in and out; the author's requirement). Shift-drag
pans. Double-click refits to the lit beads, or to everything when nothing is lit. Arrow keys nudge
the orbit when the picture has focus. One finger orbits and a pinch zooms on touch. `⌖` on the
picture frames the current window. No new global shortcuts: the command list is one list
(`App.commands()`) and every entry costs a line in the shortcuts dialog; the structure's gestures
live on its picture.

### 6.5 The later engine

When point clouds or ensembles arrive (§8.3), a WebGL2 backend behind the same `Scene` and the
same `StructureFigure` contract: two shaders, instanced impostor spheres, an ID buffer for picking,
about 800 lines, hand-written. Its export is a raster, and the spec says so where `PanelDeck.saveDeck`
already says it for a deck: a raster wrapped in a one-page PDF is the honest answer for a picture
that is pixels. The CSP the desktop target keeps (`'wasm-unsafe-eval'`, no `unsafe-eval`) does not
touch shader compilation; the standalone target forbids nothing about canvas contexts, only module
workers and sibling fetches, neither of which a renderer needs.

---

## 7. Persistence and links

Applying §5.5 — *the hash carries what is being looked at, not how it is arranged* — and the
deck's own split of session config versus per-file memory (§16.6):

| Fact | Where | Precedent |
|---|---|---|
| the structure file | `tracks[]` of the session config, as a `StoredEntry` of kind `structure`; a local file arrives detached with its name in a share link | every loaded track |
| the cell, its position in the grid | `maps=` in the hash, as `3d` / `3d:<label>` | `~` for a vacant cell |
| representation, colour-by, radius, others, gaps, labels | `AnnotationStyle.structure`, stored wholesale with the row | `reads`, `features` nests |
| the camera | **per-file session memory** (`UiMemory`, `structure:camera`), not the hash | the lock, the column count, a lane's height: "the hash has never carried a pan or a zoom" |
| the pinned bead | nowhere; a click | `lastPick()` |
| a `.metacooler.json` config | all of the above except the camera, through `buildConfig`/`applyConfig` with no new field | `tracks`, `deck.looks` |

An embed (`?embed=1`) shows the cell like any other, with its picture's menu and without the
columns, and the `postMessage` channel's `locus` message lights the beads it names.

---

## 8. The analysis crossovers

These are what turn a viewer into an instrument, and each is a *result* that belongs in the
drawer or a *track* that belongs on a card, not a picture of a place — so none of them touches the
deck.

### 8.1 Model versus map — the validation picture (phase 3, early)

A task in `src/analysis/tasks/`, `group: 'map'`, `waiting` until a structure row is loaded (the
menu-not-promise doctrine of §18.1), producing outputs the drawer already renders:

- a **distance matrix** of the model at the map's bins (`MatrixOutput`, drawn by
  `interactiveMatrix`), and the same matrix as `1/d^α` with `α` a parameter defaulting to 3;
- a **distance-versus-separation curve** beside the map's own P(s) (`CurveOutput`, log-log, with
  the slope the P(s) task already draws) — the scaling exponent of the model against the data's;
- a **table** of Spearman correlations per chromosome between `1/d^α` and the observed contacts,
  cis and trans (`TableOutput`).

This is the picture that keeps a consensus model honest, and it costs no new output kind.

### 8.2 The model as tracks (phase 3, early)

Three `ProfileOutput`s, each one number per bead resampled onto the framing's bins — which is what
"a synthetic track is a track" (§18.5) makes into lanes, into colour sources for the model itself,
and into inputs of every track task: **radial position** (distance to the model's centroid),
**distance to a picked locus** (the spatial virtual 4C), and **local compaction** (beads within a
radius, a density). Each lands on the Synthetic card, exports as bigWig, and colours the model.

### 8.3 Ensembles and frames (phase 3)

A structure row may hold many models: FOF-CT traces, `.cndb` frames, several pastis runs. The scene
gains a `frame` index and the picture a slider and a play button; the model-versus-map task gains
"mean over frames" and the tracks gain a per-bead variance. This is the phase that decides whether
the feature serves the tracing community; it is deliberately not in phase 1 because the
representation (§2.4) already allows it and nothing in phases 1–2 has to change for it.

### 8.4 Inference — not built, and why

Computing a structure from the map in the browser — classical MDS of `1/c^α` on a MAG's 800 bins is
seconds of power iteration in the analysis worker — is tempting and is refused for phase 1 under
§18.9's rule: *a second caller needs a second upstream.* Anything computed here must be a port of a
published method with a golden built from that method's own implementation, never a variation that
seemed reasonable; and the port does not get to improve on it. A port of `pastis-mds` against
pastis' own goldens is a defensible later item with a bounded scope (MDS only, ≤ 2,000 beads, one
model); until then the refusal names the way out, which is the `pastis-mds` command line and a drop.

---

## 9. What the change looks like in the repository

### 9.1 Files

New:

```
src/annotations/structure.ts          sniffStructure, parseStructure (barchart.ts's shape)
src/structure/scene.ts                Structure, Chain, normalise, beadAt/beadsIn/lociOf
src/structure/camera.ts               Camera, orbit/dolly/pan, project, fit
src/structure/paint.ts                draw(ctx, box, input) — beads, sticks, tube, chord, key
src/structure/colour.ts               the colour-by resolvers over the annotation store
src/panels/StructurePanel.ts          the deck occupant: el, apply, applyLook, exportCanvas, menu
src/ui/hoverLocus.ts                  the pointer's place, readout.ts's shape
test/unit/structure-parse.test.ts     the sniff against BED9, broadPeak, narrowPeak, headed TSV
test/unit/structure-scene.test.ts     bridge arithmetic, gaps, circular contigs, above-bin refusal
test/unit/structure-project.test.ts   projection goldens computed independently, sort stability
test/unit/structure-colour.test.ts    a bead by a bigWig equals the lane's colour at that value
test/dom/structure-panel.test.ts      arrangement, hover in and out, destroy, drawingOf
test/dom/deck-structure.test.ts       a cell from a drop, from a link, closed with the deck
```

Touched: `annotations/types.ts`, `featureset.ts`, `loader.ts`, `store.ts`, `worker/protocol.ts`,
`worker/annotations.worker.ts`, `fields.ts` (optional x/y/z fields), `panels/deck.ts` (`PanelRef`,
`serialiseMaps`/`parseMaps`), `panels/PanelDeck.ts` (the extraction), `app/Session.ts`
(`deckIsPossible`, `cycleView`), `ui/MatrixPanel.ts` (`showLocusEcho`, the two store writes),
`ui/BrowserView.ts` (the store write, the echo guide), `ui/AnnotationCard.ts` (the row's block),
`ui/SequenceCard.ts` (ticks), `ui/laneSettings.ts` (fields), `state/SessionConfig.ts` (nothing, if
the row road is taken), `styles.css`.

Documentation, in the shape the last feature landed in: a numbered `SPECS.md` section (§25, the
next free number) with its own §12 row (*a structure file: read whole, once; every frame 0
requests*) and its refusals; a `CHANGELOG.md` entry under `[Unreleased]`; a README bullet;
`GLOSSARY.md` entries for **structure** (the file, and the row), **model** (one set of coordinates —
a structure may hold several), **bead**, **chain**, **the pinned bead**; and the demo data.

### 9.2 Demo data

`demo/ecoli` and `demo/yeast` each get a model: `scripts/make_structure_demo.py` runs `pastis-mds`
over the committed map at a coarse bin, joins the bin table on, writes `bed6+xyz`, and records in
its docstring what it was checked against — the same register `make_demo_hub.py` uses. The yeast
one is the better demo: sixteen chains, the Rabl arrangement (centromeres clustered, arms
radiating) is visible at a glance and is the picture the readme can show. Both are small enough to
commit.

### 9.3 Tests worth naming

- The sniff, adversarially: a BED9 with `itemRgb`, a broadPeak, a narrowPeak, a headed TSV, a
  `bed6+xyz` with and without a header, one with `nan` rows, one renamed `.bed`. Every one must
  land where it lands today except the last three.
- The bridge: a bead width that does not divide the bin size, both ways; a gap; a contig the map
  lacks; a circular contig present twice on an axis; a cell above bin level.
- The invariant that colour means the same thing on the model and on the lane, at the lane's own
  limits and transform — the analogue of `render.test.ts`'s byte-for-byte LUT check.
- The echo loop: a hover on the model produces one `showLocusEcho` on each map and none on itself;
  a hover on a map produces one lit chord; nothing oscillates because nothing reports back.
- `drawingOf(figure)` is non-empty and contains `re`/`c`-free paths (arcs and lines) — the export.

---

## 10. Refused inside this scope, and why

Stated the way §13 states them, each with its mechanism and its way out:

- **No structure inference** in phases 1–2 (§8.4). The way out is a solver on the command line.
- **No physical unit is invented.** Distances are `model units` unless the header declares one;
  a file that declares `nm` is believed and printed as such. Nothing converts.
- **No haplotype folding.** A `.3dg`'s `chr1(mat)` and `chr1(pat)` are two chains named as the file
  names them; they match the map's `chr1` only through a rename the reader applies (§5.9's
  aliasing extended by one rule, `(mat)`/`(pat)` stripped on request), and until then the overlap
  report says which names did not match, as it does for any track. Drawing both haplotypes on the
  map's one axis would draw two beads at one locus and claim a contact between them.
- **No bridging of gaps.** A `nan` bead breaks the tube; a solver that left a bin out did not place
  it, and a line through the gap would be this app's invention.
- **No drag selection on the tube** in phase 1 (§4.4), and no camera in the link (§7).
- **No WebGL in phase 1**, and no three.js in any phase (§6.3). Narrowed rather than restated: the
  `GAPS.md` refusal keeps its subject, the heatmap.
- **No writing of coordinates back** onto the file that was opened, as for every input (§13's
  meaning of write access). Exporting the loaded structure recoloured and re-ordered as a fresh
  `bed6+xyz` is authoring an output and is allowed; it is the export row the row already has.

---

## 11. A phased plan

| Phase | Delivers | Size | Depends on |
|---|---|---|---|
| **0 — the row** | `bed6+xyz` recognised before broadPeak, parsed in the worker, a `structure` row that draws as a segments lane, persisted and shared; the sniff tests | ~600 lines | nothing |
| **1 — the cell** | the scene and bridge; Canvas 2D beads/sticks/tube with depth cue; the deck occupant from a drop, a `+` cell or a link; hover in both directions with the chord and the readout distance; click to pin, shift-click to mark, double-click to go; colour by sequence, position, score, name; show/hide by navigation, Sequences ticks and key chips; PDF/PNG and the deck figure; `v` gains a structure-alone stop; SPECS §25, CHANGELOG, GLOSSARY, README, demo models | ~2,500 lines + ~900 tests | 0 |
| **2 — the colours and the roads** | colour by any loaded track, feature set, metadata column, manual marks, distance to the pin, contacts with the pin; loops overlay as chords; bookmarks as labels; pick mode; the structure-only deck beside the 1D browser and on a `.metacool` genome view; PDB, `.3dg` and pastis `.xyz`-against-bins readers | ~1,500 lines + tests | 1 |
| **3 — the instrument** | model-versus-map task; the three spatial tracks; frames and ensembles with FOF-CT and `.cndb`; the WebGL2 engine if point clouds need it | ~2,000 lines + tests | 2, and evidence that someone has ensembles |

Phase 0 is worth doing on its own and before any picture exists: it fixes a silent misread of a
plausible file, and it is the test that the representation is right.

---

## 12. Questions only the author can answer

1. **The header.** Will the files carry a header line naming `x y z` (or a `track type=structure`
   line)? If yes, the sniff is exact and the extension is a courtesy. If not, the coherence test in
   §2.2 carries the load, and a rare structure with wildly scattered beads would still fall to
   broadPeak.
2. **The unit.** Do the coordinates mean anything physical (nm, from a scaled model), or are they
   solver units? The readout prints what the header says and `model units` otherwise.
3. **Several models per file.** Will a run produce several structures of one map (replicates,
   a resolution ladder, several MAGs in one file)? One row per model is the phase-1 assumption;
   a file holding several needs the `frame` axis of §8.3 earlier than planned.
4. **Metagenomes.** Are there per-MAG structures of a `.metacool` in play, and would they come as
   one file with a genome column or one file per MAG? The first wants a `genome` field in the
   header; the second wants a way to say *these six rows are the six MAGs* — a group, in the
   Annotations column's existing sense.
5. **Ensembles and tracing.** Is anyone in the lab's audience holding FOF-CT traces or polymer
   trajectories? If yes, phase 3 is not optional and the row should be designed for a `frame` axis
   from the start (it is, in §2.4, but the UI is not).
6. **Inference.** Would a port of `pastis-mds` for small genomes, in the browser, be wanted enough
   to pay the §18.9 bar for it — pastis' own goldens, MDS only, a bead cap? It is the one item
   here that would be a capability no browser has.
7. **The word.** *Structure* (the file, the row) and *model* (one set of coordinates) is the
   vocabulary proposed; *3D* is the reader-facing word on the button and the `maps=` member.
   Confirm before it is written into the glossary, because it is written in a great many places
   after that.

---

### Sources read for §1.2

- Spacewalk — https://github.com/igvteam/spacewalk , https://igvteam.github.io/spacewalk/ ,
  https://aidenlab.org/spacewalk/ , `.sw` converters https://github.com/aidenlab/swtool and
  https://github.com/igvteam/swcproject
- WashU Epigenome Browser 3D module — https://www.nature.com/articles/s41592-022-01550-y ,
  https://epigenomegateway.readthedocs.io/en/latest/3d.html , demo files
  https://github.com/lidaof/eg-3d-demo
- Nucleome Browser — https://www.nature.com/articles/s41592-022-01559-3 ,
  https://nb-docs.readthedocs.io/en/latest/component_3d.html
- 3D Genome Browser 2.0 — https://academic.oup.com/nar/article/54/D1/D48/8317470
- pastis — https://members.cbio.mines-paristech.fr/~nvaroquaux/pastis/documentation.html ,
  https://pmc.ncbi.nlm.nih.gov/articles/PMC9857972/ , https://nellev.github.io/pastisnb/
- 4DN FISH Omics Format, chromatin tracing — https://fish-omics-format.readthedocs.io/ ,
  https://data.4dnucleome.org/resources/data-collections/chromatin-tracing-datasets ,
  https://arxiv.org/abs/2508.13255
