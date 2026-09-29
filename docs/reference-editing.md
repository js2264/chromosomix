# Editing the reference — design note

> **Status, 2026-09-29.** Partly built: the dev features (§29), the model of an edit and the axis it
> is drawn through, the stage in manual mode with its picture, and the session drawn through the
> edit — steps 1, 2 and 3 of §10, less the zoom past the stage's picture.
> `SPECS.md` §27 (editing the reference), §28 (two sequences on two axes) and §29 (dev features) are
> the contract, and each subsection there says *built* as it lands; this note is the design they were
> written from — the method in full, the architecture with the code it lands in, the alternatives
> weighed, and the order it will be built in. Both features are **dev features** (§29): on `main`,
> invisible to a reader until the switch in *About* is on.
>
> Where the build went another way than this note: the stage draws **its own picture** rather than
> moving the map's panel onto it (§3.1 below) — the picture is finer than a panel's and in the file's
> order, which is the whole trick of §3.7 — and draws the map's own lanes beside it through the lens;
> on the stage **a drag selects** and *Space*-drag pans; the move's live preview is the picture itself
> redrawn through the tentative edit, since at the whole-genome scale that *is* the settled edit. And
> the map's lens is not a slot map in the selection read (§2.4 below) but a map of its own under the
> reader (`metacooler/lens.ts`): the file opened as it is and presented as the edited assembly — its
> sequence table, its bin columns and a pixel store that reads the original rows a window needs, or
> from a `.hic` the original rectangles, and carries each pixel to where it lands — so no view, table
> or task learns there is an edit, and a change of edit opens the file again as a change of
> resolution does.

The feature in one sentence: **a stage where the reader edits the reference a contact map was built
against — cut, invert, move, join, duplicate, set aside — with the map, its tracks and every later
analysis redrawn through the edit as it is made, guided by suggestions the app computes from the map,
the sequence, the tracks and the reads, and snapped to under the pointer.** It is what Juicebox
Assembly Tools and PretextView do by hand, with three differences that are the reason to build it
here rather than send people to them: nothing is installed or uploaded; the tracks move with the map;
and the app says where it thinks the problems are, in the picture, where the reader's eye already is.

A second, independent task comes with it: **two sequences against each other on the map's two axes**
— a dot plot of two FASTA files, computed in the browser, to see a reordering at a glance (§28).

---

## 1. What was decided, and by whom

Every line below was put to the author as a question on 2026-09-29 and is their answer, not a default.

| Question | Answer |
|---|---|
| Use cases | All three: **de novo assembly curation** (contigs → chromosomes), **correcting a finished reference** (an engineered or synthetic strain, SCRaMbLE, a cancer line), **bacteria and MAGs** (circles, origins, contigs in the wrong MAG) |
| Where it lives | A **full-window stage**, the StageDialog shell the enlarged 3D model and a figure's *customise* already use — **one map and its tracks, never a deck** |
| How far an edit reaches | **The whole session**: every view, track, task and export, through a lens over the unchanged file. The stage also **exports** the edited sequence and the lifted data: contacts as `.cool`, and the 1D tracks |
| Where suggestions come from | **The app's own method**, not a port — "something that will ultimately be branded as a new approach". §18.9's port rule is narrowed for it, in writing |
| Semi-supervised means | **Both**: a review queue, and the answers re-tune the scoring |
| Evidence beyond the map | **The reference sequence** (gaps, telomeric repeats, GC skew), **loaded tracks** (coverage, mappability, candidate sites), **read-level evidence** (split reads, pair orientation). Not other maps: the stage has one |
| Scale | **Human-scale from the start** |
| Where a cut can land | **Any base.** Contacts are exact when they come from a `.pairs`; from a stored map, the bins at each junction are approximate |
| Duplications | **Allowed** — a segment may be used twice |
| Whole-genome picture | **Fixed at 16,384 cells** a side (about 190 kb a cell for human) |
| Gestures | **Direct manipulation** — and selection *off* the diagonal, snapping to the corners of discontinuous blocks, since "off-diagonal signals can be very useful" |
| Snap targets | The suggestions, **edit ends and contig boundaries** |
| Labels | **Marks on the map and a rail beside it, linked** |
| What learning remembers | **Per file**, saved with the session and workspace, replayable by the CLI |
| Metagenomes | **Membership and scaffolds**: contigs moved between MAGs, ordered and joined within one |
| Validation | **Simulated rearrangements** |
| Command line | **Full auto mode** in `metacooler-run` |
| Dot plot | **Computed in the browser**; **its own map-like view** and **a figure in the drawer** |
| Dev features | A new app-wide mechanism: dev features are **invisible** except for a switch in *About*. The editor, the dot plot and **everything `.metacool`** are dev features |
| The app's name | **Stays (meta)cooler** |
| A `.metacool` with dev off | **Refused like an unknown file** |
| The CLI and dev features | **No gate**: the CLI shows everything |

---

## 2. The lens: an edit is drawn, never written back

§13's rule survives intact: the app never modifies a file it opened. An edit is a **lens** — a
mapping between the file's sequences (the **original**) and the reader's sequences (the **edited
assembly**) — through which the whole session is drawn. Taking the lens away is taking the edit
away, and the file was never touched.

### 2.1 The model

```ts
/** A stretch of one original sequence, placed in an edited sequence. */
interface Piece {
  id: string            // stable across edits, so a suggestion or a label can name it
  sequence: string      // an original sequence's name, exactly as the file spells it
  start: number         // 0-based, half-open, base pairs on the original
  end: number
  strand: 1 | -1        // -1: read from end to start, and complemented
}
interface Gap { gap: number; kind: 'scaffold' | 'contig' }   // AGP's N gaps, length in bp
interface EditedSequence {
  name: string
  parts: Array<Piece | Gap>
  circular?: boolean
  genome?: string       // a metagenome's MAG this sequence belongs to (§27.10)
}
interface ReferenceEdit {
  version: 1
  original: { names: string[]; lengths: number[] }  // the assembly it was made against
  sequences: EditedSequence[]
  asideAs: Array<{ piece: Piece; why: 'debris' | 'contaminant' | 'haplotig' | 'unplaced' }>
  history: EditStep[]   // every step, oldest first; the sequences are their fold
  cursor: number        // how many of them are applied (undo moves it back)
  learned?: LearnedWeights
}
```

The **identity** edit is one sequence per original sequence, one piece each, forward, same name. An
edit carries the original assembly's names and lengths, and is refused on a file whose sequences do
not match them — with the sentence naming the first that differs (§10's rule). That fingerprint is
also what lets an edit made on a `.cool` be applied to the `.hic` of the same library, and to the
`.pairs` it was binned from, which is how exact contacts are reached later (§2.5).

Two functions are the whole of the lens, and everything in the app is written against them:

- **edited → original** is a *function*: every edited position is in exactly one piece or one gap, so
  it has exactly one original position (or none, in a gap), and a strand.
- **original → edited** is a *relation*: a position lands **zero times** (set aside), **once**, or
  **more than once** (a duplication). This is the shape §8.15 already gave circular sequences — a
  mark is drawn *at every place its locus lands* — and the circular code is where the app learned to
  hold it, so a duplication is a second instance of a solved problem rather than a new one.

### 2.2 Edits, history, undo

Every operation is a pure function `ReferenceEdit → ReferenceEdit`, recorded as an `EditStep`:

| Step | What it does |
|---|---|
| `cut(at)` | splits the piece under `at` in two; nothing moves |
| `invert(from, to)` | reverses the order of the parts in `[from, to)` and flips each piece's strand, cutting at both ends first |
| `move(from, to, sequence, at, strand)` | takes `[from, to)` out and inserts it at `at`, in either orientation, in the same sequence or another |
| `duplicate(from, to, sequence, at, strand)` | the same, leaving the original where it was |
| `join(a, aEnd, b, bEnd, gap)` | makes two sequences one, end to end, either orientation, with an N gap between |
| `split(at)` | makes one sequence two: the right half becomes a sequence of its own |
| `setAside(from, to, why)` | takes a stretch out of the assembly and lists it under *set aside*, tagged |
| `rotate(sequence, at)` | on a circular sequence, makes `at` its first base |
| `rename(sequence, name)`, `reorder(names)` | cosmetics, recorded because a link names sequences |
| `reassign(contig, genome)` | on a metagenome, moves a contig to another MAG (§27.10) |

Each step carries **who** made it (`reader`, `suggestion <id>`, `auto`), **when**, and — for a
suggestion — **its evidence**, frozen at the moment it was accepted. The history is the provenance: it
is what the console writes, what an exported AGP's header quotes, and what the CLI replays. Undo moves
a cursor back along it and redo forward; a new step after an undo drops the steps past the cursor, as
every editor does. The history list on the stage is that cursor made visible: a click on a row goes
back to it.

Steps are recorded in **edited** coordinates at the moment they were made, and the fold is replayed
from the identity, so every step means what it meant when it was made. Replaying a long history is
cheap — each step touches a handful of parts — so there is no second representation to drift from the
first.

### 2.3 Names

A sequence whose parts are exactly one whole original sequence, forward, keeps the original's name —
so an edit that only fixes chromosome XIII leaves the fifteen others as they were in every link, table
and track. Anything else gets a **new** name, never one the name matcher could take for the original's:
§5.9's tiers include `version` (`NC_001133` ≈ `NC_001133.9`) and `padded`, so `IV.1` would be matched
to `IV` by the very machinery that matches tracks to maps. The suffix is `_e1`, `_e2`, …, counted per
original, which no tier strips; the reader renames from the stage's sequence list, and a rename is a
step. An edited sequence's length is the sum of its parts, so a name kept at a new length cannot
happen by construction — the case §5.9's length veto would otherwise flag.

### 2.4 Where the lens sits: two seams, both already cut

The survey behind this note found that the app already has exactly two places where a sequence
becomes a picture, and both can take a lens without their callers knowing:

**The map: the reader worker's selection read.** A multi-sequence view is already a map from
original bins to axis slots — `selectionPooling` builds `slot: Int32Array(nBins)`, `-1` for bins not
shown (`metacooler/pooling.ts`), and `pixelAccumulator` folds every pixel into the upper triangle of
*slot* space (`metacooler/aggregate.ts`), which is exactly what a permutation needs. The lens
generalises it: the worker is given the edit once (a `lens` message, re-sent only when it changes),
snaps each piece to each rung's bins, and builds the slot map — **descending** for a reversed piece,
**two slots** for a duplicated bin. A `matrix` request then speaks *edited* bins, like the circular
path's unwrapped space (`worker/wrap.ts`) speaks a space that runs off the end of a sequence, and the
reply's `AxisGroup`s gain `reversed` and a piece id. One pass over the stored pixels of the pieces in
the window, whatever the number of pieces — never the F² sub-reads the circular path's stitching
would cost with F pieces.

**The tracks: `LocusAxis`.** Every lane, overlay, ruler and hover readout goes through one mapping,
(sequence, bp) → unit → pixel (`render/locus.ts`), and every fetch is asked in **original** coordinates
through `axis.windows()` — so the annotations worker needs **no change at all**. A `LocusSegment`
gains a strand and an original range; the ten `bpPerUnit > 0` guards that skip a reversed segment today
become the one orientation-aware conversion they should always have been; `segmentOf`, which takes
the first segment of a name, becomes *every* segment of it, as circular sequences needed. The track
kinds, easiest first: signal (already mirrors), marks and arcs (each anchor lifted alone), stranded
features (effective strand = strand × piece strand, exons interpolated with orientation), sequence
letters (reverse-complemented; no residue complement exists yet — `motif.ts`'s works on IUPAC masks),
and BAM reads, hardest, whose pair categories are reference facts that become discordant across a
cut.

**The two meet in the refine ladder.** A zoom that reads again (§2) already freezes the map, reads,
and swaps (`ui/refine.ts`); a drag on the stage uses the same path. While a piece is being dragged the
block in hand is **gathered** on the main thread through the tentative edit — at most 4,096² reads,
tens of milliseconds — so the map rearranges under the pointer at frame rate; on the drop, the worker
reads the settled edit exactly and the swap replaces the preview. The preview is honest about being one:
it moves cells whole and cannot cut inside a cell, and it lasts only as long as the hand is down.

### 2.5 Bins and bases

A cut can land on any base. What that costs depends on where the contacts come from:

- **From a `.pairs`, exact.** The import's binning pass (`pairs/bin.ts`) parses each record's two
  positions before it bins them; the lens maps each position through edited ← original first, flips the
  strand where the piece is reversed, and emits one record per landing. Every contact lands in the
  edited bin it belongs in, at any cut, and a re-binned `.mcool` is the *primary reduction of a
  primary file* through a declared edit — the case §3.7 already admits. The survey found the six
  places the pass must learn about it (sizes and offsets from the edited assembly, a false
  `wasUnsorted`, the pre-merge pixel count, the orientation curves, a tally of records set aside, and
  the ladder's monotone map), all local.
- **From a stored map, bins move whole.** A stored bin is never divided: a piece whose end falls
  inside a bin is placed to the nearest bin edge *for its contacts* (its bases stay exact in the
  sequence and the AGP), so **every count stays the integer it was** and every bin inside a piece is
  exactly a stored bin. What is approximate is the **junction**: where two pieces meet, the edited bin
  there may hold two stored bins' contacts, or none. That is the whole of the approximation, it is at
  most one bin per junction, and the export names how many junctions it applies to.

The rule for the picture is the rule for the export, so what is drawn is what is written.

### 2.6 Duplications

A duplicated stretch appears twice in the edited assembly. Its contacts are drawn in **both copies**
— the only way to show the structure — and marked as copies in the readout; an exported `.cool`
writes them twice and says so in its provenance, because a reader who re-maps reads to the edited
FASTA will find those reads multi-mapping and the region empty, and the file must not pretend
otherwise. Tracks and marks are drawn at both places, by the circular rule.

### 2.7 Persistence

The edit is a fact about a file, like its circular sequences and origins, and is kept the same way:
per file in `UiMemory` (`fileMemoryKey`, every rung sharing it), in the session config as an optional
field, in a saved workspace and in a link's `s=` payload. **`readTab` too** — `SessionConfig.ts`
records the bug where a new field was written out and silently dropped on import, and the test for
this field is the round trip through it. An AGP or a `.assembly` dropped on a map is read *as an
edit* and offered, never applied silently (the *add, do not replace* doctrine): it replaces the
current edit only when the reader says so.

---

## 3. The stage

### 3.1 The shell

The third caller of `stageDialog()` (`ui/StageDialog.ts`), after the enlarged model and a figure's
*customise*: the picture on the stage and its settings in a sidebar, a grip between them, a button to
put the sidebar away. What goes on the stage is **moved** in and back — the map panel with its
lanes, as the 3D cell's canvas is — so its zoom and its colours are what the reader comes back to.

- **One map and its tracks.** The stage takes the starred map (or the only one) and the lanes placed
  on it; a deck's other cells stay behind it, untouched. It is not a deck and never becomes one.
- **Escape never closes it.** Escape cancels, innermost first: a drag, then a selection, then a
  mode. A stage holding an hour of edits is closed by its `×`, or by `⌘W` — never by a key that also
  means *stop what I am doing*. (The Analysis drawer is not a modal for exactly the reason a stage
  must not behave like one: a modal "answers Escape by destroying what is being read".)
- **Its keys exist only while it is open**, as the enlarged model's do (§25.3), so none of them takes
  a letter from the panels behind it. They are commands in the palette, printed on the controls that
  perform them (§26.4).

### 3.2 What is on it

```
┌─ EDIT THE REFERENCE · Yeast_microC_G2M_1kb ──────────────────────────────── [×] ┐
│ ▬▬▶▬▬▶◀▬▬▬▬▶▬▬▬▬▶  pieces, top                              ┌─ sidebar ────────┐│
│ ┌──────────────────────────────────────────┐ rail           │ manual│review│auto││
│ │╲                                         │ ─ 1 ✂ .94     │ SUGGESTIONS  (12) ││
│ │ ╲    ◆1                                  │               │ 1 ✂ cut  IV   .94 ││
│ │  ╲   ┊╲          ⌟ 2                     │ ─ 2 ⇄ .88     │ 2 ⇄ inv  XIII .88 ││
│ │   ╲  ┊ ╲                                 │               │ …                 ││
│ │    ╲ ┊  ╲                                │ ─ 3 → .71     │ HISTORY           ││
│ │     ╲┊   ╲                               │               │ 3 invert XIII …   ││
│ └──────────────────────────────────────────┘               │ SEQUENCES  (17)   ││
│  lanes ───────────────────────────────────                  │ EXPORT            ││
│  lanes ───────────────────────────────────                  │ SETTINGS          ││
└──────────────────────────────────────────────────────────────┴───────────────────┘
```

- **The map**, square, whole assembly by default; zoom and pan as everywhere (wheel, drag with the
  modifier the map already uses, the zoom steps). The whole-genome picture is 16,384 cells a side
  (§3.7); a zoom past what it holds reads through the lens at the grid the picture can show.
- **Two pieces bars**, along the top and the left edge: every piece as a block in its **original
  sequence's hue**, a chevron for its strand. A moved piece keeps its colour, so a glance says where
  every stretch came from; a reversed one points the other way. They are also a grip: a piece is
  selected, moved and flipped from its bar as well as from the map.
- **The lanes** the map carries, drawn through the lens.
- **The rail**, beside the map on the right: each suggestion's label at the height of its position,
  with a leader line to it, packed so labels never overlap. Hovering a label lights its marks on the
  map, and hovering a mark lights its label — one highlight, two places.
- **The sidebar**: the mode (*manual*, *review*, *auto*); **Suggestions** — sorted by confidence,
  filterable by kind, each row its kind, position, confidence, the chips of its evidence (`map`, `gap`,
  `telomeric`, `reads`, `coverage`), and its state; **History**; **Sequences** — the edited assembly,
  each sequence its pieces, a rename, a circular tick, a sort by length, and *set aside* at the
  bottom; **Export** (§6); **Settings** — the evidence the method may use, the resolution it works at,
  and what it has learned, with a *forget* beside it.

### 3.3 What is drawn on the map

| Mark | Means |
|---|---|
| a **diamond** on the diagonal, and a **tick** on each axis | a breakpoint: the map says the reference is discontinuous here |
| a **corner** — an L of two short strokes, opening towards its quadrant | two ends that belong together: the corner of a block that stops |
| a **thin rule** across the map | an edit's end, or a contig boundary from an input AGP |
| a **square** on the diagonal, and a band on the axes and lanes | the selection |
| a **bracket with a turning arrow**, an **arrow** to an insertion line | an inversion, a move, on hover of a suggestion |

Suggestions are drawn in `--accent`, because they are what a reader can act on (§26.5); an edit
already made is ink; a rejected suggestion is gone from the map and struck through in the list.
Nothing here is `--warn` or `--danger`: a suggestion is an offer, not a caution.

### 3.4 Snapping

The pointer **snaps**: within 8 CSS pixels of a target along the axis it is moving on — within 10
of a corner, measured in the plane — the crosshair jumps to it, the target lights, its label lights
on the rail, and the readout names it (`snapped to 2 · inversion · XIII:412,300`). Holding **⌥**
releases it for as long as it is held; the readout says `free`. The targets:

- **the suggestions** — breakpoints on either axis, and corners in the plane;
- **edit ends** — every junction between two parts;
- **contig boundaries** — the components inside each sequence, from an AGP the reader dropped as
  the original's description (a scaffold's own contigs, which is where a curator expects a misjoin).

The nearest target within reach wins; at equal distance a suggestion beats an edit end beats a contig
boundary. A snap is a **proposal the hand can refuse** — it never moves anything by itself.

### 3.5 Gestures

Direct manipulation, with every act also on the right-click menu and in the sidebar (and so in the
palette), each printing its key:

- **Select along the diagonal**: a drag from one position to another, both ends snapped. The stretch
  is lit on the diagonal, the axes and the lanes.
- **Select off the diagonal**: a drag in the map's body draws a box whose sides snap to corners and
  breakpoints. A box off the diagonal names **two** stretches — its rows and its columns — and a press
  on a single corner names the stretch between its two ends. What is offered is what two stretches
  admit: move the rows' stretch next to the columns', swap them, invert either. This is the gesture the
  author asked for: the corner of a discontinuous block is where two ends meet, and grabbing it is
  grabbing both breakpoints at once.
- **Move**: drag the selection — its square on the diagonal, or its band on a pieces bar. A ghost
  follows the pointer, an insertion line snaps between parts, and the map rearranges under the hand
  (§2.4). `I` while dragging flips it on the way; the drop makes the step.
- **Invert** `I`, **cut** `C` (at the snapped position, or at both ends of a selection), **set aside**
  `⌫` (a menu asks *debris, contaminant, haplotig, unplaced*), **duplicate** — `⌥`-drag, the platform's
  own *drag a copy* — **split into a new sequence** `S`, **join** two sequences by dragging one's end
  onto another's on a pieces bar, **set the origin** `O` on a circular sequence.
- **Undo** `⌘Z`, **redo** `⇧⌘Z`, and the history list.

### 3.6 Three modes, one surface

The modes are not three tools. They are three answers to *who presses accept*:

- **Manual** — the suggestions are guides: drawn, labelled, snapped to, and never applied by
  themselves. The reader edits.
- **Review** — the suggestions become a queue, best first. The stage frames the current one, shows it
  **as it is and as it would be** (hold `Space` to see the map with it applied; the split view shows
  both), and waits: `Y` accepts, `N` rejects, dragging its ends adjusts it (snapped), `→` skips, `←`
  goes back. Each answer **re-tunes the scoring** (§4.8) and the rest are re-ranked — a suggestion can
  drop below the line, or rise above it, because of an answer about another.
- **Auto** — the task applies every suggestion above a threshold, best first, re-scoring after each,
  until none is left above it, and lists what it did. Every application is a step in the history,
  marked `auto` with its evidence, and undoable like any other.

`metacooler-run edit` is auto mode from a shell (§5).

### 3.7 The whole-genome picture

16,384 cells a side, fixed — about 190 kb a cell for a human genome, near PretextView's 32,768-pixel
map, and the finest bins the file stores for anything smaller (a yeast genome at 1 kb is 12,100
cells, and stays that). Held **quantized**: one byte per cell, the log of the balanced value over the
map's own range, the upper triangle — about 134 MB, where `Float32` would be a gigabyte. It is a
picture and nothing else: every number a reader sees — a readout, a confidence, an export — is read from the
file, never from the byte.

Reading it is a full pass over the stored pixels of the rung nearest the cell size, once per file —
the cost class §7.3's genome overview has, priced and gated the same way: estimated before it starts,
a bar with a cancel while it runs, refused with the numbers where the machine cannot hold it. It is
held in **original** order and drawn through the lens, which is what makes an edit instant at the
whole-genome scale: an edit changes the mapping, never the picture.

`RASTER_MAX_DIM` (4,096) stays what every other map in the app draws at. The stage's picture is its
own and is allocated only while a stage is open.

---

## 4. The method: ends and corners

The name is to be chosen; this section describes what it does.

### 4.1 The idea

A reference is a list of **adjacencies**: every base is next to the one after it. A Hi-C map is a
test of every one of them, because contacts fall off with distance along the molecule — two stretches
that are truly adjacent share the densest contacts there are, and two that are not share the
background. So every place the reference could be wrong is a place where **two ends** — the sequence
just left of a point and the sequence just right of another — either do or do not belong together,
and the map says which, in the four quadrants around the point where their rows and columns cross.

That point is a **corner**. On the diagonal it is a junction the reference already makes; off it,
it is a junction the reference does not make but perhaps should. **The method scores every candidate
junction by how well the contacts around its corner fit the map's own contact law**, treats the
reference as the set of junctions it makes, and treats every edit — a cut, an inversion, a move, a
join, a duplication — as trading some junctions for others. The best edit is the trade the map
favours most.

What makes this worth naming, rather than one more scaffolder:

1. **One object for breaks and joins.** Misjoin detection and scaffolding are, in every tool this
   was weighed against, two stages with two signals. Here a misjoin is a junction the reference makes
   and the map does not support, a join is one it does not make and the map does, and both are scored
   by the same quantity on the same window.
2. **Every rearrangement is a re-matching of ends.** Inversion, excision, move, duplication and
   circularisation are the four quadrants of one corner, not five detectors.
3. **The model's objects are the interface's objects.** What the method scores — ends and corners —
   is exactly what the reader sees as the corner of a block and grabs with the pointer. A suggestion is
   not a verdict from elsewhere; it is a mark on the thing the reader was looking at, which they can
   check by eye and adjust by hand.
4. **Evidence outside the map is a feature of the confidence, and the reader's answers tune the weights.**
   A gap, a telomere, a split read, a coverage dip — each moves the confidence by a weight, and the weights
   are what review mode learns.

### 4.2 The expected map

For bins `a`, `b` at resolution `r`, with coverage biases `βa`, `βb` (the balancing weights' inverses,
or the marginals where a file has none):

- on one edited sequence, `E(a, b) = βa βb P(d)`, where `d` is their distance **along the edited
  sequence** — so the model is always about the reference as currently edited;
- on two sequences, `E(a, b) = βa βb T`, the trans level.

`P(d)` is measured from the map itself, per distance, by a trimmed mean of `O / ββ` over every
diagonal (the top 1% of each diagonal dropped, so that a real rearrangement, a loop or a compartment
does not lift the law it is to be judged against), made non-increasing, and extended past the longest
sequence by the power law fitted to its last decade — which is what a de novo assembly of short contigs
needs, since its long-range decay cannot be measured inside any contig. `T` is the trimmed mean over
every trans pixel, with the same trimming for the same reason: centromere clusters, a Rabl
configuration and the translocations the method is looking for all lift the mean.

Three refinements, each because a naive model gets a class of genome wrong:

- **Overdispersion.** Hi-C counts are wider than Poisson, and a Poisson log-likelihood on them is
  overconfident by a factor that grows with depth. The variance-to-mean ratio `φ(d)` is measured per
  distance and every log-likelihood below is divided by it (a quasi-likelihood), so a junction score in one
  file means what it means in another.
- **Circles.** On a sequence declared circular (§8.15), `d` is the shorter way round, so the junction
  between the last base and the first is not a break.
- **Bacterial arms.** On a circle with an origin (§8.15), the secondary diagonal is biology — the two
  arms zipped by SMC — and read as an inversion it would be the largest bow-tie in the file. So the
  expected there includes the inter-arm decay the app already measures (`analysis/arms.ts`), and an
  anti-diagonal is scored against a model that expects it.

Bins the balancing masked, or with no coverage, are left out of every sum and every expectation: a
gap, a centromere or an rDNA array is **no evidence**, never evidence of a break — which is the
commonest false positive in every diagonal-depletion detector and the reason coverage is in the model
rather than a filter after it.

### 4.3 The junction score

An **end** is a point and a side: `(p, ←)` is the sequence just left of `p`, read leftwards; `(p, →)`
the sequence just right of it, read rightwards. For two ends `e`, `f`, the window is the `W × W` block
of their first `W` bins each — rows walking into `e`'s sequence, columns into `f`'s — and the hypothesis
*`e` and `f` are adjacent* predicts, at step `i` into one and `j` into the other, `βa βb P(i + j + 1)`.
The **junction score** is the log-likelihood of that against the two being apart (trans):

```
S(e, f) = (1/φ) · Σ_{i,j<W} [ O_ij · log(P(i+j+1) / T) − β_i β_j (P(i+j+1) − T) ]
```

`S > 0` says the map would rather these two ends met; `S < 0` says it would rather they did not.
Every quantity is a sum over one window, so any junction score is `O(W²)` and a whole scan is bounded.

### 4.4 Breakpoints and corners

- **A breakpoint** is a junction the reference makes and the map refuses: `S((p,←), (p,→)) < 0`. The
  **cut score** `C(p) = −S` is computed at every bin edge along every sequence, at every level of a
  pyramid (the picture's resolution, then finer), and its local maxima above a floor are the 1D
  candidates. At a TAD boundary the contacts drop, but nowhere near trans — so `S` stays positive and
  a boundary is not a break, which is exactly the distinction insulation cannot draw.
- **A corner** is a point `(p, q)` off the diagonal and its four quadrants, each one hypothesis about
  which ends meet:

  | Quadrant (rows × cols) | Ends that meet | What it means |
  |---|---|---|
  | `[p−W, p) × [q−W, q)` | `(p,←)` with `(q,←)` | the stretch `[p, q)` is inverted — one arm of a bow-tie |
  | `[p, p+W) × [q, q+W)` | `(p,→)` with `(q,→)` | the other arm of the same bow-tie |
  | `[p−W, p) × [q, q+W)` | `(p,←)` with `(q,→)` | `[p, q)` does not belong here: excise it (and find where it goes) |
  | `[p, p+W) × [q−W, q)` | `(p,→)` with `(q,←)` | `[p, q)`'s end meets its own start: a tandem duplication, or a circle |

  Corners are found in two passes. A cheap **corner detector** runs over the whole picture: the map
  over its expected, summed over each quadrant from an integral image, and a corner's response is how
  far its brightest quadrant stands above the other three — a Harris corner for contact maps, in the
  upper triangle, tile by tile so its memory is bounded. Its peaks, and every pair of 1D candidates,
  are then scored exactly with `S`.

### 4.5 Edits are trades of junctions

The reference is the set of junctions it makes; free ends are sequence ends. An edit **removes** some
junctions and **adds** others, and its gain is

```
Δ = Σ_added S(e, f) − Σ_removed S(e, f)
```

| Edit | Removes | Adds |
|---|---|---|
| cut at `p` | `(p,←)(p,→)` | — |
| invert `[p, q)` | `(p,←)(p,→)`, `(q,←)(q,→)` | `(p,←)(q,←)`, `(p,→)(q,→)` |
| move `[p, q)` to `r`, forward | `(p,←)(p,→)`, `(q,←)(q,→)`, `(r,←)(r,→)` | `(p,←)(q,→)`, `(r,←)(p,→)`, `(q,←)(r,→)` |
| move `[p, q)` to `r`, reversed | the same three | `(p,←)(q,→)`, `(r,←)(q,←)`, `(p,→)(r,→)` |
| join two sequences | — | their two ends |
| set aside `[p, q)` | `(p,←)(p,→)`, `(q,←)(q,→)` | `(p,←)(q,→)` |
| duplicate `[p, q)` in tandem | — | `(q,←)(p,→)`, weighed with coverage (§4.7) |

So a move is three corners and an inversion two, and a suggestion carries the corners it is made of —
which is what the stage draws when it is hovered, and what the reader snaps to when they adjust it.

### 4.6 The search

**Candidates** are the ends the method will consider: the 1D breakpoints, the ends named by corner
peaks, the ends of every sequence and every piece, the contig boundaries of an input AGP (for a de
novo assembly, every contig end), and the N-gaps of the sequence. With `K` candidate ends, the pairs
worth scoring are far fewer than `K²`: an end's partners are the ends its bins actually contact, read
off the sparse inter-candidate matrix and kept to the best few dozen.

**Suggestions** are the edits of §4.5 over those ends with `Δ` above a floor, each one the best edit
its corners admit (an inverted stretch is suggested as an inversion, not as two cuts), ranked by the
confidence of §4.8.

**Auto mode** is a local search: apply the best suggestion, re-score what it touched (only windows
that contain a changed junction change), repeat until none is left above the threshold; then a
polishing pass tries every remaining stretch in every candidate position — the 3-opt move — and keeps
what helps. For a de novo assembly the first pass is a greedy matching of free ends by `S`, which is
what a scaffolder does, and the rest is the same local search; a join that would close a sequence on
itself is refused unless the sequence is declared circular.

**Multi-scale**: the whole assembly at the picture's resolution, then each candidate refined at every
finer rung by bounded reads around it (§12's ≤ 5 range requests a window), down to the finest bins the
file stores. A junction is located to the bin by the map, and to the base by the evidence of §4.9.

### 4.7 Evidence beyond the map

Each is a **feature** of a suggestion, not a filter on it:

| From | Feature | Why |
|---|---|---|
| sequence | a cut in an **N-gap**, or at a **contig boundary** of an input AGP | junctions of a scaffold are where assemblers join, and where they join wrongly |
| sequence | **telomeric repeats** inside a sequence at the cut; at an end a join would bury | a chromosome end inside a scaffold is a misjoin; a real end must stay an end. The motif is the organism's (`TTAGGG` by default, `TG1-3` for yeast), set in Settings |
| sequence | **GC skew** on a circle | an inversion inside a replichore breaks the V of the cumulative skew; the origin a rotation should land on is its minimum (`analysis/oriter.ts`) |
| tracks | **coverage and mappability** under each window | a window the reads could not reach is weak evidence either way, so it shrinks the map's term rather than voting |
| tracks | a cut at a **candidate site** of a chosen feature set | e.g. loxPsym sites from *Find a sequence*, for a SCRaMbLEd strain |
| reads | **split reads** joining the two ends (a BAM's `SA`) | an adjacency observed directly, and the only evidence that places it to the base |
| reads | **pair orientation** switching across the junction (a `.pairs`' strands) | read pairs spanning an inversion junction come out `++` or `−−` |
| edit | the **size** of the edit, log | a prior against the smallest, where one bin of noise can make a corner |

### 4.8 Confidence, and what review mode learns

A suggestion's **confidence** is a logistic model over its features, with the map's `Δ` the first of them:

```
confidence = σ( w₀ + w_map · Δ/κ + Σ_k w_k · f_k )
```

read as *the chance a curator would accept this*. `κ` scales `Δ` to a per-kilobase unit so one weight
serves every resolution. The initial weights are stated in the code with the reason for each, and
the default threshold for auto mode is `0.5`.

**Review mode learns from each answer**: an accept is a `1` and a reject a `0` for that suggestion's
features, and one step of regularised logistic regression moves the weights — pulled back towards the
initial ones by a prior strong enough that three answers cannot overturn the map, weak enough that
thirty can teach it that, on this file, coverage dips at the rDNA are not breaks. The remaining
suggestions are re-ranked at once. The weights and the answers are kept **per file**, with the
edit (§2.7), shown in Settings with the answers they came from, and forgotten by *forget*;
`metacooler-run edit --weights` replays them, so a curation taught by hand can be re-run by a shell and
come out the same.

### 4.9 To the base

The map places a junction to the bin; the base comes from, in order: a **split-read cluster**
(exact), an **N-gap** (the cut goes in the gap and the gap is dropped from both new ends), a
**candidate site**, a **contig boundary**; and failing all of them, the bin edge the map chose, with
the readout saying *placed by the map, to 1 kb*. The two positions are always shown together, so a
reader knows which kind of placement they are looking at.

### 4.10 What it is not

Not a structural-variant caller: no genotype, no allele fraction, no false-discovery control across
samples, nothing reported as a variant. It edits **one reference to fit one map**. A cancer line's
rearranged karyotype is a legitimate use — the edited assembly *is* that line's genome as the map sees
it — and what comes out is a reference, not a list of calls.

### 4.11 Human scale

At 16,384 cells the 1D scan is `n·W²` ≈ 10⁶ window sums, the corner detector a tile-wise pass over
134 M cells, and the exact scoring a few thousand windows — seconds in the analysis worker, with
progress and cancel, and the map live throughout (§18.3). The refinement is bounded reads around
candidates. What does not scale is a candidate list in the tens of thousands for a fragmented de novo
assembly scored all-against-all, which is why partners come from the sparse contact matrix (§4.6).

---

## 5. The command line

```
metacooler-run edit map.mcool --sequence ref.fa [--tracks cov.bw] [--reads aln.bam]
                 [--pairs contacts.pairs] [--from start.agp] [--weights learned.json]
                 [--threshold 0.5] [--contacts] [--lift a.bw,b.bed] --out results/
```

Auto mode, the same runner the stage calls, writing `suggestions.tsv`, `applied.tsv`, `edited.agp`,
`edited.chrom.sizes`, `edited.assembly`, `edited.chain`, `edited.fa` (with `--sequence`), the lifted
contacts (with `--contacts`: exact from `--pairs`, bins-whole from the map), and the lifted tracks.
The console writes this line for every auto run on the stage. `--simulate` is the benchmark (§7).

---

## 6. What comes out

All through the save dialog (§26.6), each a new file, none touching the one opened:

- **Edited FASTA** — needs a FASTA or `.2bit` loaded; streamed piece by piece through the worker's
  ranged reads (`residuesOf`), reverse-complemented where a piece is reversed, gaps as `N`. A `.2bit`'s
  soft-masking is not carried (its reader skips the mask blocks).
- **AGP 2.1** and **chrom.sizes** — the standard description of the edited sequences in terms of the
  original's, gaps typed `scaffold` with linkage evidence `proximity_ligation`; the history in its
  comment header. Read back as an edit (§2.7).
- **Juicebox `.assembly`** — for round trips with JBAT, 3D-DNA and YaHS. Read back too.
- **liftOver chain** — original → edited, so any other file can be lifted with `liftOver` or `CrossMap`.
- **Lifted contacts** — a `.cool` or `.mcool`, **raw counts**, `generated-by` saying *unbalanced*, as
  the `.pairs` import writes: exact from a `.pairs`, bins-whole from a stored map, the approximated
  junctions and duplicated stretches counted in the provenance. The writer is `pairs/write.ts`'s, which
  holds the file in memory (MEMFS); a lifted map above the wasm heap is refused with the size and the
  way out — a coarser rung here, or `metacooler-run edit --contacts`, which writes to disk.
- **Lifted tracks** — a signal as bigWig or bedGraph, features as BED (strands flipped, features
  across a cut split in two), pairs as BEDPE, marks as the Manual card writes them.
- **A metagenome's**: the contig → MAG table `metacooler create` takes, and a FASTA and AGP per MAG.

---

## 7. Validation: simulated rearrangements

The method is its own upstream, so it is held to a truth known by construction rather than to
another tool's output. The harness **uses the lens against itself**:

1. Take a good assembly and its map: `demo/yeast/` (a `.pairs` binned from it, for exact contacts),
   `demo/ecoli/` (a circle, with its arms), a human chromosome from a public 4DN `.pairs`.
2. Draw a **scramble** — a random edit of known steps: cuts, inversions, moves within and between
   sequences, duplications, stretches set aside — with sizes log-uniform from five bins to a fifth of a
   sequence, and a seed.
3. Apply it as a lens: the scrambled FASTA, and the scrambled contacts — **exact**, by re-binning
   the `.pairs` through it, which is what the data would look like had the reads been mapped to the
   scrambled reference.
4. Run auto mode on the scramble and compare what it recovers with the inverse of the scramble.

Scored as: junction precision and recall (the set of adjacencies recovered against the truth);
the distance from each recovered breakpoint to the true one, in bases; orientation accuracy; the N50
of correctly assembled stretches; and the number of steps a reader would still need. `metacooler-run
edit --simulate` runs one scramble; `notebooks/validation.qmd` runs the grid and draws it. The same
harness is a regression test: a fixed small scramble of the yeast demo, recovered exactly, is a unit
test.

---

## 8. Two sequences, one against the other

**Matches**: canonical minimizers of `k = 19` over both strands, their window `w` chosen so that the
first sequence's minimizers stay under a budget (twenty million by default: every minimizer at
`w = 10` for a yeast genome, one in about 150 bases for a human one), sorted by hash in typed arrays
and **merge-joined** with the second's — no hash table, a sort each side — and every hash seen more
than 50 times in either dropped, as minimap2 drops its most frequent minimizers, so that a repeat
family is not a square of noise. An **anchor** is one shared minimizer, `(x, y, strand)`. Anchors
on one diagonal band (`x − y` forward, `x + y` reversed) with gaps under a few kilobases chain into a
**streak**: one line of the plot, with its anchor count and its extent on both axes.

**The view** is a map whose axes are two assemblies (`view=dotplot`, the two sequences' addresses in
the link): the density of anchors in each cell, **signed** — forward positive, reversed negative —
drawn in `RdBu_r` about zero, so a reordering is a red line that jumps and an inversion a blue one.
It zooms from the two genomes end to end down to the anchors themselves, drawn as dots once a cell is
a few bases. The x edges carry the first assembly's tracks and the y edges the second's, each matched
by name to its own sequences. The readout gives both loci and the strand.

**The figure** in the drawer is the same density at the task's resolution, restylable and exportable
like every task figure, with the streaks as a table (TSV) and as BEDPE, which the app reads back.

**Honest about sampling**: the caption says what was sampled (`exact 19-mers, one in about 150 bases;
hashes above 50 copies dropped`); a zoom past what the sample can show recomputes the window at a
denser sampling, which is bounded work. A dot plot of two human genomes is a picture of
chromosome-scale structure, and says so.

---

## 9. Dev features

A mechanism the app did not have: a feature on `main`, built and tested like any other, that a reader
**does not see at all** until a switch is on.

- **One switch**, in *About*: `dev features`, off by default, a preference kept in `localStorage`
  (a fact about this browser, not about a file). It is the only trace a dev feature leaves.
- **Off means absent**, not greyed — §8.5's doctrine at its strictest, and stated as its own rule
  because the corrected form of §8.5 (*list it, grey it, say what to load*) would otherwise apply:
  there is something the reader could do, and they are deliberately not told.
- **A registry** of what is dev, in one file: today `metacool` (both containers, the genomes table
  and the genome and pair views, the metagenome tasks, the example and every sentence that names
  them), `edit` (the stage, its task, its keys, the lens's surfaces) and `dotplot`. Making one public
  is deleting its line.
- **Off, a `.metacool` is refused like any file the app does not read**, in the generic sentence, and
  so is an `.mmetacool`. (A `.metacool` also satisfies cooler's own test (§3.1), so this is an active
  refusal, not a detection branch skipped.)
- **State a dev feature left is kept, not applied.** A link or a workspace carrying an edit opens
  without it while the switch is off; the record is untouched, so turning the switch on brings it
  back.
- **Never in an embed.** An embedded page has no *About*, and a host page is not a dev's browser.
- **The command line has no gate**: it is a developer's tool, and it shows every task.
- The name stays **(meta)cooler**; the static text around the app — the page's description, the
  install prompt's — stops naming `.metacool`, since it cannot follow a switch.

---

## 10. Build order

Each stage lands with its SPECS section brought up to date, its CHANGELOG entry, its tests and —
since every one of them is on screen — its gallery (`scripts/ui-edit.mjs`).

1. **Dev features** (§9, SPECS §29), with `.metacool` behind them. Small, app-wide, and a precondition:
   nothing below may reach `main` visible.
2. **The lens, drawn.** `ReferenceEdit` and its fold; the worker's slot map with reversal and
   duplication; `LocusSegment` with a strand and every renderer through it; the edited assembly in the
   tables. Tested against the identity edit (byte-identical pictures) and against hand-made edits.
3. **The stage, manual.** The shell, the pieces bars, selection on and off the diagonal, move with
   the live preview, invert, cut, set aside, duplicate, join, split, undo, history, snapping to edit
   ends and contig boundaries. Persistence. The gallery on the yeast demo.
4. **Exports.** AGP, chrom.sizes, `.assembly`, chain, FASTA, lifted tracks, lifted contacts (`.pairs`
   exact; stored maps bins-whole).
5. **The method.** Expected model, `S`, breakpoints, corner detector, suggestions, the rail, snapping
   to them, the simulation harness and its unit test.
6. **Review and auto**, learning, and `metacooler-run edit`.
7. **Evidence**: sequence (gaps, telomeres, skew), tracks, reads.
8. **Metagenomes** (§27.10).
9. **The dot plot** (SPECS §28).

## 11. Risks, and what is still open

- **The picture's read at human scale** is a full pass over a coarse rung — a few hundred megabytes
  from a remote `.mcool`. Gated and priced, but slow on a bad connection; a local file is the case to
  optimise for.
- **The `.mcool` writer holds the whole file in memory.** A lifted human `.mcool` at fine resolution
  does not fit; the CLI is the way out until a streaming writer exists.
- **BAM reads through a lens** are the hardest track kind (pair categories, mates, reads across a
  cut). They may land after everything else, drawn with the categories the lens can still vouch for.
- **The method's name**, and whether the confidence's initial weights are published as defaults or fitted
  to the simulation grid — the second is better science and a larger first step.
- **Duplications in an exported `.cool`** are written twice and flagged; whether a reader would rather
  have them split in half is worth asking once someone has used it.
