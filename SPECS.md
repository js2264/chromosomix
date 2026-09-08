# metacooler web viewer — specification

A viewer for `.metacool` files, in a browser and as an optional desktop application. No backend, no
preprocessing, no additions to the metacooler API. Nothing has to be installed to use it: the web
app is complete on its own, and the desktop build is the same bundle packaged for machines that
cannot reach it — it adds a distribution channel, never a requirement.

---

## 1. Constraints

These are hard, and everything below follows from them.

| # | Constraint | Consequence |
|---|---|---|
| C1 | No server-side component of any kind | No tile server, no metacooler on a host, no accounts, no uploads, no update service |
| C2 | No new metacooler API | The app consumes files exactly as current metacooler writes them |
| C3 | No required preprocessing | A file straight from `metacooler create` must open and work |
| C4 | `genome-then-length` ordering only | Every genome is one contiguous bin range; no scattered-run handling exists |
| C5 | Static hosting only | Public files are objects on a bucket; private files never leave the machine. The desktop build changes only where the *app* comes from, never where the data comes from |

C3 and C1 together mean the app can never *require* a companion file **for a contact map**. That
scope is the whole of what the rule was ever protecting: a file straight from `metacooler create`
must open with nothing beside it, and that is what makes the no-preprocessing claim true. It is not
a claim about every byte the app will ever read. An annotation format arrives with conventions of
its own, and one of them — a BAM — has no whole-file fallback that respects §12 at all: it is read
by region, and the index is the only thing that makes reading by region bounded. The narrow rule
that follows is stated positively at §8.13 rather than left as an exception: **a format whose index
is its only bounded read may refuse without one, and the refusal names the command that fixes it.**
Every other format keeps the rule unchanged, and the opportunism at §8.11 is unaffected.

C4 means a whole class of code — run gathering, fallback query planners, `genome_extent` failure
paths — is deleted rather than written.

---

## 2. Scale assumptions

The architecture rests on one fact: **MAGs are small.** A bacterial genome is 2–6 Mb. At 5 kb bins
that is roughly 400–1,200 bins, so a single genome's intra-genome matrix is at most low millions of
cells and its non-zero pixels are a bounded, contiguous slice of `/pixels`.

Therefore, within a genome:

- the entire matrix is loaded in one bounded read and held in memory;
- pan and zoom are pure canvas operations with **zero** further I/O;
- no tiling, no LRU tile cache, no resolution pyramid.

This is the central architectural difference from HiGlass, which must stream a 3 Gb genome. None of
the machinery streaming demands is built: there is no tile server, nothing is cut into tiles,
nothing is composited, and no picture is ever assembled from parts.

**The fourth clause used to be "no progressive refinement", and it is now bounded rather than
absent.** What the app grew into is what changed it: §9 made whole-genome coolers a first-class view
and §7.2 made a block larger than the picture arrive already coarsened, so a whole chromosome now
opens at a grid the reader can see is coarse — and, until this, could do nothing about but leave.
Zooming past what the block in hand can show therefore reads the window again, at the grid the
picture could show, **once the gesture has settled**. The properties that keep this inside §2 rather
than beside it:

- **a gesture still costs nothing**, and cannot continue into one. Crossing the edge of what the
  block in hand can show *freezes* the map — pan, zoom and refit refused, a spinner in the corner of
  the plot — until the new grid lands. One crossing is one read, by construction rather than by
  timing, and the reader is shown the moment their resolution changes instead of having it happen
  under them. Escape calls the read off and gives the gestures back, because a picture that is
  already complete is never worth locking the map for;
- **one block, never tiles.** The picture is always exactly one bounded read, drawn whole. Two or
  three are *retained* so that zooming back out is a swap rather than a request, which is a small
  bounded cache of blocks and not a tile cache: nothing is evicted mid-picture and nothing is
  stitched;
- **it terminates.** There is no grid below the file's own bins, so the staircase from the widest
  view to the finest data is `⌈log₂ k⌉` reads — one for a whole yeast genome at 1 kb, three for a
  human chromosome at 5 kb, **none at all for a MAG**, whose block already is the finest data in the
  file. §2's own case is untouched;
- **it is bounded by the view.** A zoom can never widen past the domain the view was entered on, so
  it cannot become the full pixel scan §7.3 gates;
- **it is a preference, and it is off.** The default is the behaviour that keeps this clause
  absolute: a block read once, and a zoom that magnifies it. Refinement is one press away on the
  map's own controls — first of the three switches that change *what picture this is*, before the
  turn and the baseline — because a zoom that reads is a zoom that can wait, and a wait nobody asked
  for is a surprise rather than a feature.

Two things break the assumption and are handled as exceptions, not as the general case:
`__unbinned__` (§7.4) and non-metagenomic cooler files (§9).

---

## 3. Accepted inputs

### 3.1 Detection order

**Magic bytes first, attributes second.** Not every accepted file is HDF5: a `.hic` (§3.6) is a flat
binary container, and asking h5wasm to open one produces a stack trace rather than the sentence §10
requires. So the first four bytes decide the *container* before any attribute is read.

0. bytes `48 49 43 00` (`HIC\0`) → **hic** (§3.6), and nothing below is consulted

Within HDF5, attribute-based, in this order. Order matters: **a `.metacool` also satisfies cooler's
`is_cooler()`** because of the `/chroms → /contigs` soft link and `format = "HDF5::Cooler"`, so
testing for cooler first would silently downgrade every metacool to a contig-only view.

1. `format == "HDF5::MMetaCooler"` and `/entries` present → **mmetacool collection** (§3.4)
2. `metacooler-format == "HDF5::MetaCooler"` and `genomes`, `contigs`, `bins`, `pixels`, `indexes`
   all present → **metacool** (§3.2)
3. `/resolutions` present → **mcool** (§9)
4. `format == "HDF5::Cooler"` → **cool** (§9)
5. otherwise → reject with "not a cooler or metacool file"

### 3.2 `.metacool` — the primary case

Accepted when:

- `metacooler-format-version == 1`
- `contig-ordering == "genome-then-length"` — **anything else is refused** (§10.2)
- **`bin-size` resolves to a positive integer and `bin-type` is not `"variable"`** — fixed-bin files
  only (§3.3). **`bin-size` must be resolved through a mirror of Python's `_int_attr`, not
  `Number(attr)`.** metacooler omits `bin-size`/`bin-type` entirely for variable bins, but a file
  written through cooler can carry the *string* `"null"`; `_int_attr` treats `""`, `"null"`, `"none"`
  and `"nan"` (trimmed, case-insensitive) as absent, accepts an integral float, and rejects booleans
  and non-numeric strings. `Number("null")` is `NaN` and a truthiness test on `"null"` is `true`, so
  a naive read accepts a variable-bin file.
- `storage-mode` is `symmetric-upper` or `square`, read from the attribute, never assumed

Read on open (all small, all cached for the session):

| Source | Size | Purpose |
|---|---|---|
| root attrs | O(1) | bin size, bin type, ordering, assembly, ngenomes, ncontigs, nnz, sum, metadata JSON |
| `/genomes` (all columns) | ~n_genomes rows | the landing table, including optional metadata columns |
| `/contigs` (all columns) | ~n_contigs rows | contig → genome mapping, lengths, optional columns |
| `/indexes/chrom_offset` | n_contigs + 1 | contig → first bin |
| `/indexes/genome_offset` | n_genomes + 1 | genome → first contig |

Never read on open: `/pixels/*` and `/indexes/bin1_offset` (one entry per bin — sliced on demand
only). `/bins` is never read at all — see §3.3.

### 3.3 Fixed-bin only, and what it buys

Variable-bin files (fragment-level and contig-level metacools, `bin-type = "variable"`,
`bin-size = null`) are **not supported**. They are refused at open (§10). This is a deliberate scope
decision, and it removes a variable-width coordinate path from every layer of the app rather than
one branch in one place.

The consequence worth stating explicitly: **`/bins` never has to be read** for coordinates (the one
exception is the optional weight column of §6.4, read only when balancing is asked for).** With a uniform bin size,
the entire coordinate model is arithmetic over two things already in memory —
`/indexes/chrom_offset` and `/contigs/length`:

```
bins_in_contig(c)      = ceil(contigs.length[c] / binsize)
bin_index(c, pos)      = chrom_offset[c] + floor(pos / binsize)
bin_start(b)           = (b - chrom_offset[c]) * binsize        // c from chrom_offset lookup
bin_end(b)             = min(bin_start(b) + binsize, contigs.length[c])
```

The last bin of each contig may be short — cooler's own rule, which the metacooler validator
enforces — and the `min()` above is the only place that matters. Everything else is exact.

So the `/bins` table, one of the four large tables in the file, is never touched: not on open, not
per view, not over the network. That is a meaningful cut in both request count and code surface, and
it exists only because variable bins were excluded.

**Resolution ladders are cleanly nested for the same reason.** `binnify` requires the target bin size
to be an exact multiple of the source, and `zoomify` requires every level to be a multiple of the
base. So for `k = resolution / base_resolution`, bin `b` at a coarse level covers base bins
`[b·k, (b+1)·k)` exactly. Zoom arithmetic is integer division with no interpolation and no edge
cases.

### 3.4 `.mmetacool` — opportunistic, never required

An mmetacool is a container of complete metacool entries and is **not** itself a valid cooler.
Opening one at its root is an error listing available entries, mirroring the Python `KeyError`.

Entry naming distinguishes two uses, and the app infers which:

- **all entry names parse as positive integers** → a `zoomify` resolution ladder. Wire the entries to
  the zoom control; hide the entry picker.
- **otherwise** → a sample/replicate collection. Show an entry picker; switching entries switches
  dataset.

This exists because *you* can run `zoomify` on files you publish yourself. It is a pure optimisation:
a plain `.metacool` must behave identically, minus the extra zoom levels. The app never asks for an
mmetacool and never degrades when given a plain file.

### 3.5 URI addressing

`file::group`, exactly as `metacooler.uri.parse_uri`:

```
f.metacool                 → { path: "f.metacool",  group: "/" }
f.mmetacool::entries/rep1  → { path: "f.mmetacool", group: "/entries/rep1" }
f.mmetacool::              → { path: "f.mmetacool", group: "/" }
```

Used in the file picker, in error messages, and in the URL hash so views are shareable.

---

### 3.6 `.hic` — a cooler-class citizen

Versions **7, 8 and 9**, local and remote, read-only, at BP resolutions only. A `.hic` is opened as
what it is — a contact map with chromosomes and no genome layer — and is therefore a **cooler-class
citizen** in every sense §9 uses the phrase: the contigs table is the landing view, a region is one
bounded read, tracks and annotations are offered (§8.5), and thirteen of the fourteen §18 tasks apply.
`genomes` is `null`; the four metagenome tasks are absent, not disabled.

**Why the format is here at all.** It is where the published record is. Most mammalian Hi-C on 4DN,
ENCODE and GEO is distributed as `.hic` and as nothing else, and a viewer that cannot open it cannot
be pointed at the literature. Nothing about it is in tension with §1: the file is block-indexed with a
master index at a known offset, so a region is a bounded range read through the same `ByteSource` —
the same LRU, the same §12 accounting, the same S3 signature — as everything else. If anything it
fits §2 better than HDF5 does, since the index is **two-dimensional** and an off-diagonal rectangle
costs the blocks it covers rather than a whole row band.

**A block is not a tile.** This is the sentence to keep, because the vocabulary invites the confusion.
Blocks are how the *file* is indexed. Nothing is composited, nothing is cached to be assembled, and
the result of a read is one whole bounded matrix handed up in COO exactly as a cooler's is. §14's
invariant is untouched.

**Three things are translated, and nothing else.**

- **The `All` chromosome is dropped**, by name and never by index — every Juicer file carries a
  synthetic whole-genome row at index 0, and it is not a sequence: its length is a fabricated round
  number and including it would shift every real bin. The file's own numbering is kept alongside,
  because the master index is keyed on it. Same doctrine, same reason, as §7.4's `__unbinned__`.
- **Normalisation vectors become `bins/weight`**, reciprocated: `.hic` stores a divisor per bin and
  cooler's weight is a multiplier. A file's best available normalisation is chosen — `SCALE`, then
  `KR`, then the coverage ones — and *named* in the info panel, so a reader is never guessing which.
  A bin the balancer dropped becomes `NaN`, which is what a balanced cooler writes for one.
- **The resolution ladder becomes entries**, spelled `file.hic::/resolutions/5000` exactly as an
  mcool's is. That is what wires it into the entry picker, the URL hash, §3.4's refine ladder and a
  deck descending to its lead's rung, with no code in any of them learning the format exists.

**What is not read**, and each is a §13-style decision rather than a gap: fragment-resolution
matrices (`unit = "FRAG"`), because a fragment grid is variable bins under another name and §3.3
excludes those from the whole application; the file's expected-value vectors, because §18 computes its
own against a golden and two expectations under one name would be a quantity that changes with the
code path; and writing, for §13's reason.

**Correctness.** The reader is checked three ways: against fixtures whose contents are known exactly,
across every encoding the format allows (v7/v8/v9, short and float values, short and int positions,
list-of-rows and dense blocks, grid and diagonal block numbering); against **`hic-straw`**, the
reference implementation, as a devDependency oracle on every one of those fixtures; and through
`MetaCooler` itself, asserting that the ordinary cooler surface answers identically. The second of the
three is not optional and the reason is recorded: the first version of the reader and the first version
of the writer agreed with each other that the format is big-endian. It is not.

---

## 4. Data access model and cost

Every operation the app performs, with its cost, because the cost model *is* the design:

| Operation | Reads | Cost |
|---|---|---|
| Open file | attrs, `/genomes`, `/contigs`, two offset arrays | kilobytes |
| List genomes with metadata | already cached | free |
| Per-genome pixel density | `bin1_offset[lo]`, `bin1_offset[hi]` | 2 lookups |
| Load one genome's matrix | 1 `bin1_offset` slice + 1 `/pixels` slice | bounded, contiguous |
| Genome pair (both loaded) | reuse; or 1 bounded slice | bounded |
| Contig-level view within a genome | aggregate the already-loaded genome matrix | free |
| **Genome × genome overview** | **every non-zero pixel** | **whole file** |

The last row is the only expensive operation, and there is no index that shortcuts it — summing all
genome pairs is inherently a full pixel scan (this is what `_aggregate_sparse` does). It is therefore
not the landing view (§5.1) and is gated (§7.3).

**Free density proxy.** `bin1_offset[hi] − bin1_offset[lo]` gives the number of non-zero pixels whose
row bin falls inside a genome, from an index already in memory. It is not a contact count and must
not be labelled as one, but as a per-MAG density indicator it earns a sortable column in the genomes
table at zero cost.

---

## 5. Views

### 5.1 Genomes table — the landing view

Opening a file lands here, not on a heatmap. Columns:

- `name`, `length`, `n_contigs`, `n_bins` (always present per the format)
- every extra `/genomes` metadata column, rendered generically from whatever exists — completeness,
  contamination, taxonomy, and anything else the creator joined in. No column names are hard-coded.
- non-zero pixel count (§4), sortable, marked as a proxy

Sortable and filterable on all columns; free-text search over genome names. Clicking a row opens the
genome view. Selecting two rows opens the genome-pair view.

Rationale: it costs two small reads, it is the operation a metagenomics user actually performs, and
a 400×400 heatmap of scalars is less informative than a sortable MAG table with quality metrics.

### 5.2 Genome view

The full intra-genome matrix for one MAG, loaded whole (§2). Contig boundaries drawn as separators
from `/bins/chrom` transitions. Contig names labelled when ≤ 50, matching the Python threshold.

Zoom and pan operate on the in-memory matrix — no I/O. A zoom that settles past what the block can
show reads the window again (§2), which for a MAG never happens: its block is already the file's own
bins. Level toggle between bin and contig aggregation, both computed locally from the loaded data.

### 5.3 Genome-pair view

The rectangular off-diagonal block between two genomes — the phage–host, plasmid–host and HGT view,
and the thing no existing browser does. Both genomes are contiguous under C4, so this is one bounded
query.

**Transpose handling is mandatory.** Storage is upper-triangular (`bin1_id ≤ bin2_id`). When the
column genome precedes the row genome in bin space, the block must be queried transposed and flipped.
Omitting this produces blank inter-genome panels, which would silently break the app's most
distinctive feature.

### 5.4 Region view

Within a genome, a `contig` or `contig:start-end` selection. Range parsing mirrors
`parse_metacooler_range` exactly, including its refusals:

1. label is a **genome name** → whole-genome extent; a coordinate suffix on a genome name is an
   **error**, not silently ignored
2. otherwise a **contig**, optionally `contig:start-end` (**0-based, half-open** — cooler semantics,
   verified against `cooler.util.parse_region`, not the docstrings)
3. neither → error listing available genomes and contigs, truncated to ~20 of each

Genome and contig namespaces can collide; genome wins, as in Python. The UI labels which kind a
search matched.

### 5.5 Navigation

`genomes table → genome → contig → region`, with a breadcrumb whose segments are clickable to go back
up. Clicking an off-diagonal cell in any aggregated view opens the corresponding pair. Full view
state serialises to the URL hash.

Pan and zoom are deliberately **not** in it: the hash carries what is being looked at, and one that
rewrote itself on every wheel notch would turn the back button into a scrollback. The one exception is
`focus`, and it is not a live position — it is a window a view *opens* standing on, applied when the
block arrives and never written back, so a link that named a place goes on naming it however far its
recipient then wanders (§8.10).

### 5.6 Sessions

Several files may be open at once, as tabs. A **session** is one file, its views, its tracks, its
annotations and its settings, and it is a real one: its own reader worker, its own annotation worker,
its own stores, its own DOM. Switching tabs re-parents that DOM rather than rebuilding it, so a map
comes back with its pixels, its zoom and its scroll intact and without a byte re-read.

The address bar names **the active tab and nothing else**. A hash is one view state and there is one
of those on screen; writing several would make every link a description of somebody else's workspace
and make the back button walk a history interleaving three files. The rest of the strip lives in
`sessionStorage` beside the annotations (§8.6), and a restored tab is *named*, not opened — its label
and its view state come back, its worker does not, and clicking it is what reads the file. A tab that
named a local file comes back to the picker with §11's explanation.

Three things are per *window* rather than per session, because they are preferences about this window
rather than facts about a file: the theme, and the fold and width of each column.

Two tabs on one file share nothing. The per-session memory is keyed on the session id as well as the
URI, so a second view of the same map starts with no tracks, no filters and no marks.

### 5.7 Two files in one square

A second cooler may be opened into the **lower-left triangle** of the same map. A contact matrix is
symmetric, so half of every square on screen is a mirror carrying no information; giving that half to
another file makes the picture asymmetric, which is what the eye reads a difference from.

The split is the **matrix diagonal**, not the viewport's: a cell belongs to the second file when its
row bin exceeds its column bin, wherever the view is. Panning off the diagonal is therefore not a
special case — a trans block above the line shows the first file alone and its transpose shows the
second — and zoom, selection and every other gesture are untouched, because the merge happens once
per read and hands the renderer an ordinary block.

Three refusals, each because the merged picture would otherwise be a lie rather than a limitation:

- **a genome layer** — §8.5's argument applied to a whole matrix rather than to a track;
- **a different bin size** — one grid cannot be two resolutions;
- **a chromosome list differing in count, order, name or length** — every coordinate in the picture
  is an index into one such list.

Either file can be closed. Closing the second returns to one map; closing the first promotes the
second, so the map that remains is an ordinary one. `uri2` is part of the view state, so a comparison
is a link — for two remote files, which is the same limit `uri` has always had (§11).

**The second file follows the first across a change of resolution.** A comparison belongs to the file
it is a comparison *of*, so opening another file puts it down; changing rung is not that, and the
reader closed nothing. What carries is the **bin size** rather than the URI, since the second file has
a ladder of its own: `rep2.mcool::/resolutions/1000` beside a 1 kb map is `…/5000` beside a 5 kb one,
looked up in that file's own entries and refused where it has no such rung — which is the bin-size
clause above, seen from the other side, and is said on the card rather than left to be discovered.
The reading carries with it: the operation, the depth match, and whether the second triangle was
hidden.

**Turned, the pair is two bands rather than two triangles** (§17.2). Either map, here or in a deck,
can also be given a name of its own (§16.10).

One colour scale by default, because the same colour meaning the same count is the stronger claim.
A **match-depth** option scales the second file so its 99th percentile meets the first's — the same
order statistic §7.1 picks `vmax` with — for the case that motivates it, two libraries of different
depth. Two colourbars then read the same colours in each file's own counts.

This is the design for **two** files and it stays exactly as it is. §16 is the design for N, which is
a weaker claim on the files and therefore a different picture; the two compose, and a session may
hold both at once.

### 5.8 The 1D genome browser

A session may hold a **genome** instead of a file: a list of sequences and their lengths, with tracks
drawn along it and no contact map at all. It is entered by opening a `chrom.sizes`, a bigWig, a
bigBed or a feature file, and it is not a second application — the tracks, their cards, their session
memory and their renderers are the ones §8 already specifies. What differs is the coordinate model
underneath, and only that: the axis is the whole assembly laid end to end at one unit per base pair,
rather than an axis of matrix bins. §8.4's rule is unchanged and is what makes this possible at all.

Lengths come from whatever named them, in descending order of trust: a `chrom.sizes` declares them, a
BBI header carries them, and a feature file yields only the furthest coordinate it mentions — which
is a lower bound, is rounded up, and is labelled as inferred wherever the genome is described.

The two shapes of session convert into each other. Dropping a `.cool` on the tracks makes the tab its
map, tracks and all; closing the map from the File card falls back to a browser on the cooler's own
`/chroms`, with the same tracks still loaded. Neither is a new session: the tab, its id and its
memory are the same throughout.

**One key walks the three pictures a file with tracks can be**: `v` goes from the map and its tracks,
to the tracks alone, to the map alone, and home. Two of those swap what is mounted and the third does
not, which is why it is a cycle written in one place rather than a toggle in each — a reader pressing
`v` is asking to see the same data with less and then more furniture around it, and where the
boundary between "another view" and "the same view drawn differently" falls is an implementation
detail they should never meet. Tracks-only comes first because it answers "get this matrix out of my
way", which is what a reader with six tracks open wants most often; the map alone follows because
from there the next thing to ask is the opposite. The button offers the **next** stop rather than
naming the current one: it is a control, and a reader reads it to find out what pressing it will do.

Nothing is hidden, moved or restyled by any of it. The map alone is the stacks drawing no lanes for as
long as it lasts, which is the same kind of presentation as the turn (§17.4) and reversible in the
same way: three presses come home to the arrangement the reader spent ten minutes on.

The gestures are the map's, deliberately (§7.2): a drag pans, Option-drag selects a range to zoom
into, the wheel zooms about the pointer, a **sideways** wheel slides along the axis, a double click
fits, a lane's border resizes it and its body reorders the stack. `[` and `]` step to the sequence
before or after this one, as they do on a map — the plainest thing anybody does with a genome, and it
was the one view where it had to be typed into the locus box. Two gestures are the browser's own.
⌘-scroll over a lane moves *that* track's ceiling, because it is the adjustment a genome browser is
asked for constantly and a map has no analogue for it. And a drag on the **ruler** selects a range to
zoom into with no modifier at all: the coordinate strip is where a reader points to say "this much",
and it is the one gesture whose meaning its position already settles, so spending a keystroke on it
buys nothing.

**The ruler gains digits as it is zoomed**, and it does that by being told the gap between its own
ticks. Two decimals of a megabase is ten kilobases, so a window narrower than that on a chromosome
measured in megabases wrote the same number under every tick — an axis of `4.60 Mb`, four times over,
under a picture zoomed in to answer exactly the question it was there for. The unit is chosen so that
two decimals can tell one tick from the next, and it steps down when they cannot rather than growing
a third: `4.6 Mb`, then `4605 kb`, then `4601520 bp`. Nobody reads a fourth decimal off an axis.

**The plot is the whole column, not the stack.** The canvas reaches the foot of the column rather
than the foot of the last lane, so pointing anywhere under the tracks names a coordinate, draws the
crosshair and reads every track at it — the axis does not stop where the tracks do, and a view with
two lanes in a tall window would otherwise have a screenful of surface that answers nothing. It stops
at the **start of the axis**, though: the strip before it is the handles' margin and, when it is on,
the track names' column, and neither is a position — so the line stops there and the readout says
nothing, rather than naming a base pair while the arrowhead is on a word. The height is a screen
fact only; a figure is a picture of the tracks, and blank paper under them is not part of it.

**Where a guide line is drawn the pointer is a small open cross**, and that is one rule across all
three surfaces. The arrowhead is the wrong shape over a picture being measured: it points from one
corner, so the coordinate it names is a pixel at its tip with a blunt body over everything below and
to the right of it — which on a matrix where a cell can be one pixel is the only thing covering the
answer. The cross is four short arms around a hole, so the pixel it is about stays visible through
the middle of it, and it is drawn a little heavier than the hairlines it stands among, which are one
device pixel and deliberately faint: a pointer that reads as one of the guides is a pointer that has
to be hunted for.

It is not a second copy of the guide lines, and the difference is what it is for. The lines are at
the position the app has *resolved* — the cell, the bin, the column — and the cross is where the
**hand** is, which between one frame and the next is somewhere the lines have not got to yet. Taking
the pointer away entirely, which this used to do, left nothing at all to follow in that gap, and a
surface with no pointer over it reads as a surface that is not listening.

So the cross comes exactly where the line comes, condition for condition: on the map while the
crosshair is on and the pointer is over a cell, here while it is on and the pointer is on the axis
rather than in the strip before it, and on a lane stack always, since a lane answers a pointer with
its own hairline whatever that preference says. The transient cursors stay — the closed hand while
panning, the crosshair while a selection is about to be drawn — because those say what is
*happening*, which no guide line does.

Only what follows the pointer goes down there. Everything that describes the *picture* — the sequence
boundaries, the name column's own edge — stops with the tracks: a boundary is a mark *on* the tracks,
and a rule carrying it through a screen's worth of blank space is a divider between two things that
are not there.

Each lane carries its own controls — colour, `auto`, a ceiling slider, its group — revealed by
pointing at it and drawn under the track's name rather than over its data. They are transparent to
the pointer while they are hidden, so a lane that has not been pointed at yet has no invisible band
across it where a drag would fail to pan.

The lane's **value range is drawn under its name and edited there**. Under the name because a number
at the far end of a lane has to be paired with its track by eye; edited there because it is the one
thing on a lane a reader changes, and a number that is already under its name is a number that can
have a caret put in it. Pointing at either end gives a text cursor and pressing opens a box at the
same size in the same place, so nothing moves when the number becomes editable. Typing a bound turns
autoscale off — that is what typing a bound means — and the other bound comes from the axis on
screen rather than from whatever was last stored, because the axis on screen is the one that was
being read. (The side panel's own boxes seed from the file's whole-genome extent instead: a panel is
not a view, and a number in it must not change when the view is panned.)

Four things the edit refuses, all for one reason — a limit nobody typed must never be stored.
Opening a bound and leaving it alone, or emptying the box, closes it and changes nothing; an
unreadable number and an inverted pair are marked in place with the caret still in them, rather than
silently discarded or answered with the `{0, 1}` axis `resolveLimits` gives an impossible range. And
the edit applies to **every track in the lane**, because a lane draws one range under however many
names it holds — committing to only the first would leave an overlay group as two lines at two
scales under one label, which is the picture the group exists to prevent.

The same layout applies beside a heatmap, on any lane tall enough for two lines. Where a lane is not,
the range goes back beside the name and stops being clickable, because its box would then overlap the
lower border that resizes the lane — an overlap in which the canvas promises a drag and the press
opens a text box is worse than either alone.

The **General column lists the sequences** under the Genome card: every contig, its length, a bar of
its length against the longest, and a click that shows the whole of it. A filter appears above a
dozen of them and the list is capped, because a `chrom.sizes` is as likely to be forty thousand
scaffolds as sixteen chromosomes.

### 5.9 One genome, many nomenclatures

Two files of the same genome disagree about its names more often than they agree. UCSC writes `chr1`,
Ensembl writes `1`, a `.hic` off 4DN writes `1`, a yeast cooler writes `chrI` and the `chrom.sizes`
beside it writes `01`. Every one of those is the first chromosome, and until this section every one
of them was a *different sequence*: a companion panel asked for `chr1` against a file calling it `1`
answered `unknown-label` and showed a blank rectangle under a bar claiming the deck was one
navigation, and a bigWig of the same assembly drew nothing beside a map that spelled it otherwise.

`src/genome/naming.ts` answers one question — *does this name, in this file, mean the same sequence as
that name, in that one* — under three constraints, and the constraints are the design.

**It never silently matches two different sequences.** A wrong match is worse than no match: no match
is a blank panel and a sentence saying why, and a wrong one is somebody else's chromosome drawn under
your label, which nothing on screen would show. So each step is a rule with a reason, `length` vetoes
rather than persuades, and a name whose shape the matcher does not recognise is matched **by its
spelling and not otherwise**. That last clause is what makes this safe on a metacool: assembler
contigs (`NODE_1_length_…`, `k141_9`, `tig00000001`) are opaque ids from independently assembled
organisms and two of them agree by coincidence (§8.5), so no numeral, no accession and no organelle
table is ever applied to one.

**The decisions come from the whole list, not one name at a time.** `X` is the tenth chromosome of
*S. cerevisiae* and the sex chromosome of everything else, and the string cannot tell you which. The
list can: a file that also holds `IX` and `XI` is counting in Roman numerals and its `X` is ten; a
file whose numerals stop at `V` — *C. elegans* is `I`…`V`, `X` — is naming a sex chromosome, and has
no chromosome ten to be confused with. The same test gets *S. pombe* right and gets every numeric
assembly right by never reaching the question. This is why the entry point is an index over a whole
file's sequences rather than a `canonicalise(name)` anybody could call on a string in isolation, and
why what it produces is **forwarded with the request**: a companion resolving the lead's region has
to read the numeral the way the lead wrote it.

Two further list-level rules, and each exists because a real file breaks the obvious version:

- A Hi-C library mapped against a **host plus a yeast spike-in** carries `chr1`…`chr22`, `chrX`,
  `chrY` *and* `chrI`…`chrXVI` in one list. The Roman evidence is overwhelming and the conclusion —
  that this file's `chrX` is chromosome ten — would re-key the host's sex chromosome onto the
  spike-in's tenth. So a list that numbers chromosomes **both** ways does not get to answer the `X`
  question at all: in a list that already counts in Arabic, `X` is the sex chromosome.
- SOAPdenovo, ABySS, Shasta and several binners number their contigs `1`, `2`, `3`. Read as ordinals
  those match `chr1` at the same rung an Ensembl file does, drawing a 4 kb contig under the label of
  chromosome one. Nothing about the string says which it is; the *count* does — no genome has two
  hundred chromosomes, and every draft assembly has thousands of contigs — so past that ceiling a
  bare number is an id and is matched by its spelling only. The ceiling applies per name as well as
  per list, which is what keeps Ensembl's *Drosophila* working: it carries hundreds of scaffolds
  named `211000022278279`, and those are neither chromosomes themselves nor evidence about the file
  that holds them.

Two more rules exist because a name can *look* like a convention without being one, and both were
found by reading real metagenome headers rather than by reasoning about the conventions:

- **The `chr` prefix comes off only when what is left reads as a chromosome.** `Christensenella_1`
  begins with `Chr` and `Chromobacterium_ctg1` with `Chrom`; stripped on sight they become
  `istensenella_1` and `obacterium_ctg1`, two names no file contains and which would then match each
  other's mangling. So a number, a Roman numeral, a sex letter, an organelle, an accession, UCSC's
  `Un_…` or a short letter run in front of a number gets the prefix taken off, and everything else
  keeps its name whole — which is also what a bacterial replicon genuinely called `Chromosome` needs.
- **Pipe decoration is reduced only when a database tag says so.** `MAG_042|NODE_1` and
  `MAG_007|NODE_1` are two organisms' first contigs, and reducing both to `NODE_1` would collide them
  at tier `exact` — the loudest possible version of the one thing this must never do. A header only
  loses its decoration if it carries one of NCBI's own tags (`gi`, `gb`, `ref`, `gnl`, …).

**Length corroborates; it never matches.** Two sequences of equal length are not the same sequence —
a metagenome has thousands of equal-length contigs — so no pair is ever matched *because* the lengths
agree. The implication runs the other way: where a name match is proposed, both lengths are known and
they differ, the match is reported as contested rather than taken quietly. hg19's `chrM` and hg38's
`chrM` are the case that matters — one name, two sequences, two bases apart.

**The ladder**, weakest interpretation first, and every match carries the rung it was reached by:

| tier | example |
| --- | --- |
| `exact` | `chr1` = `chr1` |
| `case` | `Chr1` = `chr1` |
| `decorated` | `ref\|NC_001133\|` = `NC_001133` |
| `prefix` | `chr1` = `chrom1` = `chromosome_1` = `1` |
| `padded` | `01` = `1` |
| `roman` | `chrXII` = `12` |
| `organelle` | `chrM` = `MT` = `MtDNA` = `NC_012920.1` |
| `accession` | `NC_000001.11` = `chr1`; `chrUn_GL000220v1` = `GL000220.1` |
| `version` | `NC_000001.10` ≈ `NC_000001.11` |

`version` is last and is the only rung known to be shaky: the same locus at two assembly versions is
two sequences, so it is offered and flagged rather than taken.

Only two ranges of per-species knowledge are hard-coded, and both are arithmetic rather than tables:
NCBI gave human chromosomes 1–22, X and Y the consecutive block `NC_000001`–`NC_000024`, and mouse
1–19, X and Y the block `NC_000067`–`NC_000087`. Everything else is a rule. A real alias table for
every assembly is megabytes, needs a network, and would have to be told which assembly a file is of —
which is the question this whole section exists to avoid asking (C1, C2).

**What is deliberately not equated.** A chromosome arm is not its chromosome: *Drosophila*'s `2L` and
`2R` are separate sequences and neither is `2`, which also keeps wheat's `1A`, `1B` and `1D` — three
homoeologues, one number — apart from each other. The number in front of that letter is capped at two
digits, because FALCON writes its contigs `000001F` and reading one as chromosome 1 arm F would put
an assembler's output into the karyotype namespace. `_random`, `_alt`, `_fix` and `_hapN` stay,
because a patch is not the chromosome it patches. A linkage group keeps its `LG`, because a linkage
map is numbered by linkage and an assembly by length and the two orders agree only by luck. `C`, `D`
and `M` are excluded from the Roman numeral system entirely — no genome has a hundredth chromosome,
so a `C` in a chromosome list is a chloroplast and an `M` a mitochondrion, every time. Organelle
spellings are matched whole and never by prefix, because *S. pombe*'s `MTR` is a mating-type region
sitting in the same file as its `MT`. And **genome names are never matched**: a metacool's genome
layer is independently assembled organisms, and nothing about their names is a convention.

**What is not attempted.** UCSC's `.1` → `v1` scaffold rewrite belongs to the hg38/mm39 generation;
the one before it lowercased the accession and *discarded* the version, so `chrUn_gl000220` cannot be
turned back into `GL000220.1` without knowing the assembly. Those names are left unrecognised rather
than guessed at, which costs a blank lane and a sentence where a guess would cost a scaffold drawn
under another scaffold's label. Two mitochondria in one file — UCSC's hg19 analysis set carries the
legacy `chrM` beside the rCRS as `chrMT`, on purpose — are not resolved either: both land in one
bucket, which makes the bucket ambiguous, which makes the matcher refuse unless a length settles it.
That is the general rule doing the work, not a special case.

**Where it fires, and where it must not.** In `parseMetacoolerRange` the matcher is consulted *after*
both namespaces have been asked literally and the answer would otherwise be a refusal. That placement
is the whole of how the range parser stays a faithful port of `metacooler.ops.range` (§5.4): every
string a file does carry resolves exactly as Python resolves it, in the same order, with the same
genome-wins rule, and a session of one file cannot tell the matcher exists. Only the error case
changed. The same after-the-strict-answer rule governs the ticked selection, the locus box, and
`contigOf`.

**Renaming at load is not enough on its own, and this is the part that is easy to get wrong.** A track
is loaded against the session's map and renamed into *its* vocabulary — but a deck draws the same
track beside every panel, and each panel samples through its own block's axis, so a companion asks
for a sequence by the name **its** file writes. One track, three vocabularies, and the rename can only
ever have chosen one of them. So every place a held track is asked for a name resolves as well as the
range does: the bigWig's refNames, a bedGraph's contigs, a FASTA's sequences, the feature sets the
renderer walks, and — the one with no file behind it at all — a synthetic track's grid, which is laid
out over the map the analysis was *computed on* and drawn beside every other.

**It says so.** A panel that answered a name it does not itself write prints a line under its heading
naming both spellings and the rule that joined them, and says separately when the two lengths
disagree; the line is cleared whenever the panel stops drawing that picture. The §8.2 overlap report
is computed after the rename and therefore counts a cross-convention match as a match — which is
right when the two are one sequence and a lie when they are not, so a rename whose two lengths
disagree is carried into the report and named there. Without that, the one case most warranting a
word would be the one case that reported a clean bill. `compareRefusal` (§5.7) no longer refuses two files for spelling
one assembly differently — but still requires the same list in the same order, and still refuses two
sequences of one name at different lengths, which is the check that catches hg19 against hg38.

---

## 6. Reader layer

A read-only JS mirror of the Python `MetaCooler` class — same names, same semantics, same errors, no
new concepts.

```ts
class MetaCooler {
  static open(uri: string, source: ByteSource): Promise<MetaCooler>;

  readonly uri: string;
  readonly binsize: number | null;
  readonly shape: [number, number];
  readonly info: Record<string, unknown>;      // incl. ordering, assembly
  readonly metadata: Record<string, unknown>;
  readonly genomes: Table;
  readonly contigs: Table;
  readonly chromnames: string[];
  readonly chromsizes: Map<string, number>;

  extent(region: string): [number, number];
  offset(region: string): number;
  genomeExtent(genome: string): [number, number];
  contigExtent(contig: string): [number, number];
  matrix(q: MatrixQuery): Promise<DenseMatrix>;
}
```

Plus `isMetaCooler`, `isMMetaCooler`, `listEntryNames`, `parseUri`, `parseMetacoolerRange`.

### 6.1 Byte-source abstraction

One interface, two implementations, chosen at construction. Nothing else in the codebase may import
h5wasm or call `fetch`.

```ts
interface ByteSource { readonly id: string; readonly size: number;
                       mount(): Promise<string>; close(): void; }
```

`LocalFileSource` wraps a `File`. `RemoteRangeSource` wraps a URL. Identical downstream.

### 6.2 Decoding requirements

**String columns.** metacooler writes them as fixed-length `S<n>`, sized by **UTF-8 encoded byte
length** rather than character count (`_str_to_hdf5`), precisely so multi-byte characters are not
truncated. Decode with `TextDecoder('utf-8')` and strip trailing NUL padding; never assume ASCII.
`CORE_COLUMN_KINDS` also permits kinds `O` and `U`, so a file produced by `create cool` may carry
variable-length strings instead — handle both.

**Names are ASCII, and this viewer does not claim otherwise.** `/contigs` *is* cooler's `/chroms`,
and cooler decodes every column of it with an ASCII `.astype("U")` — so metacooler refuses to write a
non-ASCII `/contigs` or `/genomes` name at all (`check_ascii_names` before the first write,
`schema.validate` after the last). A file with one cannot be produced by any documented command, and
supporting a shape the reference implementation will not create is a claim with nothing behind it. The
UTF-8 decode above is still required and still exercised: an **extra `/genomes` column** — an accented
taxonomy is the obvious one — is legal metadata cooler never sees.

**int64 becomes `BigInt64Array`.** `bin1_id`, `bin2_id` and all three offset arrays are int64.
`count` is **int32 at base resolution, int64 wherever counts have been summed** (`binnify`, `merge`),
**and float64 when the source column was float** — `resolve_count_dtype` preserves float sources
rather than truncating them, and `CORE_COLUMN_KINDS` accordingly permits `i`, `u` **or `f`** for
`pixels/count`. Three paths, resolved once at open. Unsigned integer columns are permitted throughout,
so test dtype *kind*, not an exact dtype. Consequences in JavaScript: mixing `BigInt`
with `Number` throws at runtime, not compile time; convert offsets to `Number` once on read (bin
counts are far below 2^53); resolve `count`'s dtype once at open rather than per pixel.

**Aggregation accumulates in `Float64Array`.** The format widens counts to int64 precisely because
summation overflows int32; the same applies in the browser.

### 6.3 Validation

Light by default: attributes, group presence, table lengths, `/chroms` soft link, declared-vs-actual
counts. All O(1).

The full Python `validate()` reads whole `bins` columns, the whole `genome_id` column, both offset
arrays and three pixel windows. Acceptable on local disk, unacceptable over HTTP. Offered as an
explicit debug action only.

### 6.4 Balancing

The format specification defines no weights column and `show()` uses `balance=False`. Balancing is
therefore **optional-if-present**, and it is built: when `/bins/weight` exists the view card offers a
toggle, and a balanced cell is `raw * w[i] * w[j]` — cooler's own definition. A `NaN` weight marks a
bin the balancer dropped; the product is `NaN`, which renders transparent, so a filtered row reads as
absent rather than as empty. Where there is no weight column the control is not offered, and asking
for one anyway is refused by name. No default weighting is invented.

This is the **one** read of `/bins` in the reader, and it is bounded: two slices of the weight column
for the bins actually on screen, never the whole column, never `/bins/chrom`, and never at all unless
the user asked for balanced counts. §3.3's rule is that *coordinates* never come from `/bins`; they
still do not, and `test/unit/bins-guard.test.ts` still proves it for every unbalanced path.

---

## 7. Rendering

### 7.1 Defaults match `metacooler show`

The same file must produce the same picture in the CLI and the browser, or every figure in the paper
diverges from what a reader reproduces locally.

- transform `log1p` (with `log10` and `none` selectable)
- colormap `afmhot_r`
- `vmin = 0`; `vmax` = 99th percentile of non-zero values in the **transformed** matrix, recomputed on
  view change, with manual override. A *refine* (§2) is not a view change and does not recompute it:
  a coarse cell is a sum of bins, so a finer block over the same place holds systematically smaller
  numbers, and re-measuring would re-brighten the map for a reader who changed nothing but the
  magnification. The range is measured from the **widest block held** and stays there while the
  reader zooms in; zooming out past it re-measures, which is right, because that reader is looking at
  data that was not in the picture before
- the **cell size** is named in the key, on its own line under the scale's name, and in the exported
  key as well — it is the one fact about a refining map that cannot be recovered from the pixels, and
  a figure that carries it needs no caption to say it
- separators at genome or contig boundaries, thin grey
- ticks in base pairs on any axis that stays inside one contig, and the contig names on any axis that
  does not — `_bin_axis`'s rule, because a bin index is not a position and does not restart at zero
  where the block does. An axis of **several** contigs is then ruled one contig at a time on top of
  those names, each measured from its own first base, because "where in this one am I" is the
  question a reader asks of a whole genome as much as of a single chromosome. Each stretch gets the
  room it actually has — a chromosome with room for no tick carries its name and nothing more, which
  is the rule the names themselves are elided by, and a metagenome's thousands of pixel-wide contigs
  carry none — its own step, since one chosen for the longest chromosome puts no tick on the
  shortest, and no tick on either of its own edges, where the boundary line already is. Above bin
  level there is still nothing: a cell there *is* a contig, and a position inside one would be an
  invention

Both bounds are overridable, as one clip range: two typed numbers and one control back to auto. The
URL carries `vmin` and `vmax` independently, in transformed units, and their absence means auto.

**What the app *opens* with is its own choice**, as the overlay defaults are (§7.2). Parity is a
property of the machinery — the same colormap table, the same indexing, the same percentile rule —
not of which entry the picker starts on, so the viewer opens on its own white → yellow → red → black
ramp, and a **cooler with a weight column** opens balanced in `log10` because that is what a finished
assembly's map is read in. `afmhot_r` on raw counts is one item away and still byte-identical, and a
`.metacool` — where the reader is asking how much two contigs touch, which is a count — is left on
the CLI's defaults exactly.

**The percentile is taken over the pixels that are drawn.** Above §7.2's raster
cap a block is pooled, one pixel to many cells, and a scale fitted to the cells
would describe a population no pixel on screen belongs to. Below the cap nothing
is pooled, the two are the same set, and the resolved bounds are bit-identical —
which is where the parity above actually lives, since `metacooler show` renders
at a size that never pools.

The rule above is for **raw counts**, where zero is a true floor. It does not survive balancing
(§6.4), whose values are fractions: `log10` of them is negative almost everywhere — on a 10 kb *E.
coli* map, 0.4% of cells transform positive and a `vmin` of 0 clips the other 99.6% to white. A
balanced block is therefore scaled to the 1st-to-99th percentile of the cells that carry a contact,
and `log10` draws an empty cell at the low end rather than at numpy's `0.0`, which for these values
sits above the whole picture. `metacooler show` never balances, so neither departure touches parity.

### 7.2 Technique

`ImageData` + `putImageData` to an offscreen canvas at matrix resolution, then `drawImage`-scaled to
the display canvas. Pan and zoom are canvas transforms over the in-memory matrix. A colour-vision-safe
colormap is selectable; keyboard pan and zoom are supported.

**The wheel's two axes mean two different things.** Up and down is the zoom, about the pointer.
Sideways **slides along the picture**, which is what two fingers mean over every genome browser there
is and what they already meant over this app's own tracks. It used to be left to the page so that the
platform's back-and-forward swipe would work over a map as it does over the rest of a document; that
is the wrong trade over the one element a reader navigates *by* sliding, and the swipe still works
everywhere outside the picture. Over a lane stack it means the same thing as over the map, because a
stack is drawn on the map's own axis — the map moving under the pointer while the profile above it
stayed put would read as the two coming apart.

**Touch is a first-class input**, not a fallback: one finger pans, two pinch, a tap opens what it
lands on and a double tap refits. Below 34rem the app is one column — the plot as wide as the screen,
the legend on its side beneath it. Every control revealed by *pointing* — a tab's ×, a track's colour
— is shown outright under `(hover: none)`, because a control that appears on hover appears never
where there is no hover; and every one of them is inert while it is invisible, so a tap or a click
that lands where one is hidden reaches what is behind it rather than firing a button nobody saw.

**One grid, and one place it is decided.** This is what a refine (§2) re-uses
rather than works around: it asks for a narrower window and *nothing else*, and
the reader plans the grid for it exactly as it plans every other read. A caller
that named its own grid would bypass the widening below and anchor the cells to
wherever the reader had panned to, so a cell's value would change as it crossed
the screen — which is why the plan is never sent by anything driven from a
viewport.

A block larger than the picture is coarsened **once, in the reader**, into cells that hold at most a capacity of bins
and never part of one sequence beside anything else: a sequence longer than the
capacity keeps cells of its own, cut at its own start, and only the ones too small
to fill a cell share. The capacity is searched for against `RASTER_MAX_DIM`, so the
grid the reader builds is the grid the renderer draws and nothing pools a second
time — the raster's own pooling is reached only by a block that already fits. The
grid is anchored to the *sequence*, not to the request, so the same base pair falls
in the same cell holding the same sum in every view of it, and a range is widened to
those cell edges rather than starting a grid of its own.

**What is accepted, and stated rather than fixed:** the raster is at most 4,096 px
per axis and a plot is commonly 800–1,600 device pixels, so `drawImage` still
minifies, and its filter averages across cell — and therefore sequence —
boundaries. Every stage before it is exact; this one blends neighbours that are
not neighbours, by up to a few pixels at a boundary. Removing it means performing
the reduction to display size in the app, sequence-aware, which measured 40–66 ms
per frame on the main thread and therefore belongs in a worker. It is a known
limitation of the drawing, not of the data: the numbers behind every pixel, the
readout, the axes and the export are all taken from the reader's grid.

**Two of the overlay preferences are about the tracks rather than the matrix**, and are shared by
both places the tracks are drawn: `text` takes every word off them — names, ranges, feature names —
and `fills` takes the shading out from under their lines, which is the envelope and an area track's
own fill together. Both are one thing to the eye and both are context for a line rather than a
series, which is what makes them the first things to go when several tracks share a lane or a figure
is going into a caption. They live in the same store as the matrix's own overlays (`localStorage`,
not the hash: §5.5 shares what is being looked at, not whether the reader likes shading).

**The figure saves as PNG or PDF at a chosen DPI.** It is re-rendered at that resolution through the
same drawing code rather than screen-grabbed, so the labels and hairlines are drawn rather than
enlarged, and the framing — pan and zoom included — is what is on screen. The PDF is one page holding
one lossless image, written by the app; its page size in points is derived from the CSS size, so the
DPI is a fact about the paper rather than a name.

**The 1D browser's PDF is vector**, and that is the one place the two exports differ. A contact map is
a raster honestly — twelve thousand bins are pixels and writing them as a million rectangles would be
a larger, slower file of the same picture — but nothing in a genome browser is: every mark there is a
rectangle, a polyline or a word. So the browser's PDF carries paths and text, and a figure dropped
into a manuscript can be restyled, recoloured and scaled by whoever receives it. It is produced by
handing the *same renderers* a context that emits PDF operators instead of pixels, so there is no
second drawing of the view to keep in step; text is Helvetica, one of the fourteen fonts every reader
has, so nothing is embedded. A vector page has no resolution, so the DPI control is *absent* while
one is chosen rather than greyed out — which is also what puts the format's full name and the button
on one line.

### 7.3 Genome × genome overview — gated, not default

Available, but never automatic, because it costs a full pixel scan (§4):

- **Local files:** explicit user action, progress indicator, cancellable.
- **Remote files:** refused above a byte threshold, since a full scan means downloading the file.
  Offered when a sidecar edge list is advertised in the catalog. **`metacooler network --level genome`
  is the right producer** — it emits a `node1 / node2 / value` TSV (optionally with `--header`) to a
  file or stdout, which for a few hundred MAGs is a few KB of text: no HDF5, no range requests, one
  `fetch`. Prefer it over `aggregate --level genome`, which produces a whole `.cool` for the same
  information.

Both remain opportunistic: a plain `.metacool` with no sidecar behaves identically, minus the
overview.

Opportunistic in exactly the same way as the mmetacool ladder: used when present, never required.

**Three levels, one control.** The whole-file view offers `bin × bin`, `contig × contig` and
`genome × genome` in a single picker; `level` in the hash selects between them and the shell mounts
whichever view draws the answer. Only the last two are accumulations over unit pairs — `bin × bin`
is the pooled whole-file read (§9), and on a metagenome it is the same picture as selecting every
row of the genomes table.

**`bin × bin` is the default.** A contig cell sums a rectangle of `length × length`, and a
metagenome's contigs span several orders of magnitude in length, so the contig axis spends its width
on the shortest sequences and its colour range on the longest: a block is as wide as a genome is
*fragmented* rather than as long as it is. Measured on the 48-MAG mock community, 62% of the contig
axis goes to contigs under 5 kb holding 4% of the sequence, one badly-assembled MAG takes 28% of it
for 4.5% of the assembly, and a third of the diagonal comes out empty. Bin cells are all the same
area, so one scale fits the whole picture — and landing on the legible level is worth more than
landing on the one that contains the others. The contig level stays, because "is this bin one
organism?" is a question only it answers. Where a sidecar edge list is advertised the default gives
way to `genome × genome`: that one is a small download rather than a pass over the file, so it is
the cheapest thing to land on.

**All three ask first, and all three are read by genome.** Being the default makes the gate
mandatory rather than optional: the rule is not "warn when it looks expensive" but that a pass over
every pixel never starts on its own, and a threshold would make it hold on large files and lapse on
small ones. So the bin level is gated whatever the file declares `nnz` to be, behind the same
sentence and the same button as the scans. It is also labelled and divided by **genome** rather than
by contig — the axis is the whole metagenome at every level, 2,082 contig hairlines over 48 blocks
are a grey wash, and an axis label that names a genome opens that genome. A *selection* is not
affected: its axis names what was ticked, which is the answer to a different question.

**And a click on a cell opens a genome at all three levels.** "Read by genome" is a claim about the
picture, and it has to be a claim about the gestures on it or it is only a claim about the ink: the
two accumulating levels resolved a cell to one MAG's map on the diagonal and to the pair off it,
while `bin × bin` — the *default*, the level a reader lands on — resolved to the contig under the
pointer and opened a region view of two `NODE_` sequences nobody had asked about. The same gesture
on the same file went somewhere else depending on which of three levels was chosen. All three now
dispatch on one rule (`overviewTarget`): same genome on both axes opens that genome, two genomes
open the block between them, and a file with no genome layer falls through to the sequence, which is
what a cooler's whole-genome view has always done. The contig is one click further in, from the
genome's own map, which is where a question about a contig is actually asked.

### 7.4 `__unbinned__` — never displayable

Reserved, holding every contig that binning failed to assign. It breaks the small-MAG assumption
outright — potentially thousands of contigs and a large share of all pixels — and it is **not a
genome**, so there is nothing coherent to display.

**Identify it by name, never by index.** `create` takes a `drop_unassigned` flag; when set, there is
no `__unbinned__` row at all and genome index 0 is an ordinary MAG. Matching on index 0 would hide a
real genome in exactly the files that were binned most cleanly. Match the literal name `__unbinned__`,
and treat its absence as normal.

The rule is absolute, not a default:

- absent from the genomes table, with no toggle to reveal it
- not selectable, in any view, as either axis of a pair
- rejected as a range label with a specific message (§10), not treated as an unknown name
- excluded from the genome × genome overview (§7.3), which incidentally makes that view far more
  readable, since `__unbinned__` normally dominates its own row and column

**Index integrity still matters.** It occupies genome index 0 and its contigs still occupy bins and
pixels. Nothing may be renumbered or compacted to make it disappear — `genome_id` values, the
`genome_offset` array and every bin index remain exactly as written. Exclusion happens at selection
and display time only. Silently reindexing to hide it would corrupt every downstream lookup.

**One retained number — confirmed.** The fraction of contigs and bins that are unassigned is shown
once, as a read-only statistic in the file info panel. It is a direct diagnostic of binning quality, a
metagenomics reader will look for it, and a reviewer will expect it. It is a number, not a view: it
opens nothing, selects nothing, and is not a row in any table. Label it as a QC statistic
("unassigned: 1,204 contigs / 8.3% of bins"), not as a genome. This is the sole exception to the rule
above and does not weaken it — no code path reaches `__unbinned__` through this statistic.

---

### 7.5 Derived values — computed here, never read

A cooler stores one number per pixel and, if somebody ran `cooler balance`, one weight per bin.
Everything else a reader wants is arithmetic over numbers that are already on screen, and none of it
requires a companion file, a preprocessing step or a server — so C1, C2 and C3 permit all of it.

Four families, in `render/derive.ts`, `render/smooth.ts` and `render/compare.ts`:

| Family | Offered as | Cost |
|---|---|---|
| **Normalisation** — VC, VC √, ICE | entries in the score picker (§7.1's control) | one to a few dozen passes over the block |
| **Baseline** — observed / expected | a toggle of its own | two passes |
| **Baseline** — the expected itself | an entry in the score picker | two passes |
| **Smoothing** — a despeckle, fixed or self-sizing | the `smooth` picker | one pass at a fixed radius; three cumulative passes and a bounded search per cell when it sizes itself |
| **Comparison** — ratio, difference | the `compare` control, beside the split | one pass over two blocks |

**Why this is honest here and would not be in HiGlass.** Every one of them measures a statistic
*from the block*, and that is a genome-wide statement only if the block is the genome — which §2 is
precisely the claim that it is. One block, so one answer. A tile server computing coverage from the
tile under the pointer produces a different normalisation at every zoom level and every pan; there
the same feature would need a precomputed weight column, which is why HiGlass reads one. Where the
assumption does not hold — a windowed region of a whole cooler chromosome — the number is a
statement about the window, and the caption says so rather than leaving the label to imply otherwise.

**Juicer's `KR` is not offered, and its absence is not a gap.** Knight–Ruiz and iterative correction
solve the same problem — the unique diagonal scaling that makes a symmetric non-negative matrix
doubly stochastic — and converge to the same weights; KR is a Newton solver that reaches it in fewer
passes. At §2's scale the fixed point converges in milliseconds, so the faster solver would buy a
name in a menu and nothing a reader could see. A file balanced with `KR` elsewhere and read here
under `ICE` shows the same picture.

**The baseline can be looked at as well as divided by**, and it is in the picker rather than beside
the toggle because it answers "what are these numbers" and not "compared to what". Every cell becomes
the mean the ratio would have divided it by — a banded triangle fading from the diagonal, with a flat
plate over every off-diagonal pair of sequences, and nothing else in it. The reason to offer it is
that an O/E is only as good as its denominator: at long separations the curve is a mean over few
cells and moves, and a ratio that swings there is swinging in the model rather than in the biology.
It **overrides** the toggle rather than composing with it — O/E of the baseline is 1 wherever it is
anything — so the toggle greys and says why, and it is drawn on a sequential ramp with no neutral,
because a mean of counts is count-like and a diverging scale centred at 1 would be centred where
nothing in the picture lives.

**Normalisation and baseline compose, and their order is fixed.** Normalise first: the decay curve is
an average over cells, so measuring it before the coverage bias is out means measuring it partly on
the bias, and every cell of a badly-covered bin is then compared against a baseline its own
under-coverage helped set. This is cooltools' order, for the same reason.

**The despeckle runs before every division, and one of its two shapes sizes itself.** Each cell
becomes the mean of the cells around it, **itself included**, and it is applied *per file, before two
are combined and before the O/E*, which is what makes it useful on a ratio rather than merely
cosmetic: `smooth(A) / smooth(B)` never has to average the `Infinity` that `x / 0` produces, because
a zero cell with contacts around it is no longer zero.

**The centre is in the mean, and it did not use to be.** The kernel began as `terra::focal` with a
zero centre weight, on the argument that a cell disagreeing with all eight of its neighbours is
evidence about the neighbourhood rather than about itself. That is right about rejecting outliers and
wrong about a sparse map, where a lone contact is not an outlier but the only measurement there is:
the zero-centre kernel replaced it with the mean of the eight zeros around it while spreading it into
those eight, so every isolated count rendered as a **hollow square with a hole where the contact
was**, and away from the diagonal most of the picture was made of those. It is also the wrong
estimator for what the filter now feeds — a local rate that the O/E divides — since discarding the
one cell being estimated at is both biased and needlessly noisy. Despeckling survives the change in
all but the narrowest window: a wild pixel is diluted to a ninth of its excess at `3 × 3` and to a few
hundredths at the widths the adaptive settings reach.

**The order changed with it, and the reason is the same one that puts the filter ahead of a
two-file ratio.** `observedOverExpected` draws a cell where nothing was observed as paper rather than
as the strongest depletion on the ramp — see below — and away from the diagonal *most* cells are that
cell: 98% of them at 200 bins out on a yeast map at 500 bp. An O/E computed first therefore handed the
filter a field that was almost entirely `NaN`, which no despeckle will touch, and every setting drew
the same picture. Smoothed first, a zero cell with contacts around it is never blanked and the map
fills in: that 98% falls to 1% under the adaptive settings and to 39% at `7 × 7`.

**The baseline is averaged over the same windows as the map**, and that is not optional. Dividing a
smoothed map by an unsmoothed curve is a biased operation: near the diagonal the decay is steep, so a
window spanning it averages cells whose baselines differ several-fold and the ratio comes out
systematically high — a measured 24–32% enrichment at radii 3 to 7 that is an artefact of the filter
and of nothing in the file. Averaged over the same cells with the same divisor the bias sits in both
halves of the ratio and cancels, and the mean returns to 1 where an O/E belongs.

**The curve is still estimated from the unsmoothed block.** That is the half of the old ordering worth
keeping: a decay curve is an average over cells, and fitting it to pre-averaged ones would let each
cell's neighbours count twice toward the baseline it is then compared against. Estimating before and
dividing after keeps the estimator honest and still lets the filter do its work.

A **fixed** window is the wrong tool away from the diagonal, and the reason is that the precision of a
box mean depends on the counts it covers rather than on the cells it covers. Near the diagonal a
7 × 7 box holds thousands of contacts; at 300 kb separation the same 48 cells are almost all zero, so
the mean is still noise and widening the box does not help, because what is in it grows in proportion
to nearly nothing. That is the observation
[serpentine](https://doi.org/10.1093/bioinformatics/btaa249) (Baudry *et al.*, 2020) is built on, and
its answer is to hold the counts constant instead of the window.

The **adaptive** setting takes that criterion and keeps this filter's locality. Each cell's window
grows until it covers a target multiple of the block's mean cell, floored at `3 × 3` and capped at a
radius of 192. Three things about it are deliberate:

- **It is a kernel, not a binning.** serpentine grows *regions* by random agglomeration and averages
  each, which makes the result a partition — right for a differential analysis, wrong for a viewer,
  because the partition is global and stochastic, so panning by one bin redraws every boundary and
  the map reshuffles under the reader. Here windows overlap and no partition is formed: a cell reads
  the same whether it sits in the middle of the viewport or at its edge, which is what lets a reader
  pan a smoothed map and believe what moves. That is the whole reason this viewer takes serpentine's
  *criterion* and not serpentine's *algorithm*.
- **The width is measured on the values as read, and the mean is taken over the derived ones.** That
  is serpentine's own separation — it thresholds on counts and reports a ratio — and here it is what
  makes the setting work at all under the O/E, whose values are near 1 everywhere by construction and
  would size every window the same.
- **The target is a multiple of the block's mean, not an absolute count**, because the cells reaching
  this stage are not always counts: `score` may have put balanced values in them (§6.4). Against the
  block's own mean the criterion means the same thing on both, and reduces to serpentine's threshold
  on counts when the cells are counts. A cell that cannot reach its target inside the cap keeps the
  cap and stays noisy, which is the honest outcome — a window that grew without limit would end up
  averaging the map into its own mean, and a flat field is not a better picture of thin data.

**Picking it turns the O/E on**, exactly as clicking the toggle would, and everything that follows —
`log2`, a symmetric range, a diverging ramp — follows from the neutral of 1 the O/E gives the result.
That is not a shortcut but the picture the setting is for: the window is sized on the counts and
divided by a baseline averaged over that same window, and on raw counts all it can denoise is a
picture of the distance decay that was never in question. Turning the O/E off again is left to the
reader, who may want exactly that.

**One setting rather than a ladder of strengths.** Three of them were three ways of asking one
question a reader has no way to answer, and the one kept is the one that preserves the most detail:
`3 × 3` where the data is rich, and much wider where it is not.

**One wild cell must not become a rectangle, and that takes two things.** A mean
has no defence against a single extreme value, and a box kernel's impulse response *is* a box — so
before this, one hot pixel raised every window that could reach it by the same amount and none of the
next ones along, drawing a hard-edged saturated block that reads as structure. Measured: one cell at
400× its neighbourhood produced a 20 × 20 bin block peaking at 5.3 in `log2` O/E, on a scale that
clips at 0.84.

The first of the two is a **cap on leverage**, applied in a pass before the averaging. Not a multiple
of the local mean, which is the obvious rule and is wrong here: away from the diagonal the map is
Poisson-sparse, so the window mean is 0.05 while the occupied cells hold 1, and *every* honest count
is twenty times the local mean. No fixed multiple both spares those and controls a spike. What the
artefact is, is leverage — a cell shifts the mean of every window reaching it by `(value − mean) / n`
— so the cap is written on that directly: no cell may add more than half again to the mean of a window
its own size, `cap = mean_without_it × (1 + ½ n)`. That scales itself, tight in a 3 × 3 near the
diagonal and two hundredfold in a sparse 21 × 21. The mean is taken **without the cell**, which is the
one thing the old zero-centre kernel had right: excluding the centre is correct for deciding whether a
cell is an outlier and wrong for estimating what to draw there, and the two passes do one each.

The second is a **shoulder on the kernel**. The mean is taken over three nested windows — `r/2`, `r`
and `3r/2` — and averaged, which puts a step in the weights instead of a cliff: the outermost shell
carries about 8% of the weight the centre does, so what remains of an outlier fades rather than
ending at a straight edge. The radii are chosen so this costs nothing in noise — the effective sample
is 3.90·r² against the plain box's 4·r², the same estimate over half again as much ground. With both,
a synthetic spike of 2000× no longer reaches the clip and the O/E mean stays at 1.00 in every band.

**Both of these reduce the artefact rather than removing it.** The cap bounds a flagged cell by
construction — the rule permits it to inflate its window by half, `log2 0.58` against a clip at 0.84 —
and on a real map the residual is still visible. Two stricter responses were implemented and dropped:
trimming the flagged cell out of the sum and the divisor, and replacing it with its eight neighbours'
mean. Both improved the synthetic case and neither removed the artefact reproducibly on real data,
which points at **the detector rather than the response** as the part still wrong, and at the
synthetic used to develop it as not reproducing whatever the real one is. Anyone picking this up
should start by reproducing the artefact from a real block rather than from a planted spike.

Blocks are capped at **16 M cells**, which is the 4096² raster cap — so in practice the setting is
available on anything the viewer will draw. The cumulative tables are built for a **band of rows** at
a time rather than for the block, so what is resident is about 128 MB whatever the block's size;
without that a 16 M block would allocate over half a gigabyte on the thread drawing frames. What the
cap costs instead is time, and it is roughly linear — and about twice what it was before the
winsorising pass, which reads the block again: 78 ms at 353², 300 ms at 841², 574 ms at 1,200², 1.5 s
at 4 M and **7.4 s at 16 M**.

**Above 1 M cells it runs on the analysis thread** (§18.3). Below that it is a hitch on a dropdown and
is done inline, which keeps the map from flashing unsmoothed on the way to being smoothed; above it
the cost climbs past a second and would be a frozen window. So `deriveBlock` runs the pipeline to the
point the smoothing would happen, hands the caller the arrays it would have used, and carries on with
the **unsmoothed** field — and **the caption says `counts`, not `smoothed`**, because a figure exported
mid-wait must not claim a filter it does not have. When the answer lands the caller derives again and
the step is a lookup. That is the correlation's arrangement, for the correlation's reason: every other
step in that module is synchronous, and a promise for the sake of one of them would make every caller
wait on arithmetic already finished. The fixed radii never defer at any size — one incremental pass is
not worth a round trip. Neither does a compared pair, where two blocks would need two jobs and a
half-finished pair would put a smoothed map over an unsmoothed one and call it a ratio. The last is a real freeze and the honest price of the cap being where it is;
everything short of a whole chromosome at a fine bin size is a fraction of a second. Should that need
fixing, the answer is the analysis thread rather than a lower cap — the work is a pure function of
two arrays.

Above the cap the fixed radius the setting is floored at is used instead, and **the refusal is said
twice**: in the export caption, which is all a figure carries once it leaves the app, and in the view
note under the heading, which is what a reader has while deciding what they are looking at. A refused
adaptive window draws a fixed one, and a fixed one looks like a map — this is §7.3's refusal shape and
the correlation's, with the note added because a caption nobody reads until they export is no use to
somebody looking at the screen.

**The two ends of a ratio are paper, not colour.** A cell where nothing was observed is `0`, and on a
scale centred at 1 that is the strongest depletion the ramp can draw — so an O/E map of a sparse
block came out as a wall of "maximally depleted" over every empty pixel, which is the loudest
possible statement of the one thing the file does not say. Zero is *nothing seen here*, which is what
paper means on every other map this viewer draws. An infinite ratio goes the same way, being a fact
about a baseline too small to divide by rather than a measurement of anything, and both are then out
of the auto range they would otherwise drag. A **negative** ratio stays: an extra `/pixels` column may
legitimately hold negative numbers, and blanking those would be this rule deciding what a file is
allowed to contain.

**Diverging values need three things to change together**, and changing fewer produces a plausible
picture of the wrong thing:

1. `log2` joins the transform list (§7.1's three are still frozen by the parity requirement — this one
   is the viewer's own, for values the CLI cannot produce). Twice and half then sit the same distance
   either side of neutral.
2. The auto range becomes **symmetric about neutral**. Otherwise the colour meaning "these agree"
   lands at an arbitrary point in the ramp, and a map of two identical files comes out uniformly
   coloured rather than uniformly neutral.
3. The colormap becomes **diverging** (`RdBu_r`, red is more). A ratio on a sequential ramp hides the
   only thing it is for.

The panel takes the transform, the colormap and the clip when a derivation is switched on and gives
all three back when it is switched off, because none of them means the same thing about a ratio as
about a count — a `vmax` of 8 is a sensible ceiling on `log1p` counts and nonsense on `log2` of a
ratio.

**Pooling changes too.** A contact map is pooled by its brightest cell, because its signal *is* the
bright cell. A ratio pooled that way shows only the arm above neutral, so every region where the
second file is the stronger one vanishes at fit zoom — half of what a difference map exists for.
A diverging field is pooled by departure from neutral instead.

**Tracks get the same three operations** (`annotations/derived.ts`), combined on the **common
refinement** of the two interval lists rather than on a grid: two bigWigs' intervals do not line up,
and evaluating both onto a uniform grid smears every boundary that falls inside a cell, so a sharp
edge in a control becomes a ramp and the ratio against it spikes at exactly the position that
mattered. A derived lane fetches nothing of its own — both operands go through the ordinary sample
cache — so it inherits §8.4's pan-and-zoom-free rule from the two it is made of.

**What a link carries.** The normalisation is a `score` and needs no key of its own; the baseline is
`oe`, the comparison is `op`, and the despeckle is `smooth` — one key with two vocabularies, a fixed
radius (`smooth=2` is 5 × 5) or the adaptive window (`smooth=a50`). All four are part of *what is
being looked at* rather than how it is shaded, so §11's rule applies: a recipient sees the numbers the
sender saw. A smoothed map matters most here, because it *looks like a map*: a link that dropped the
key would send a recipient a picture whose single-cell features had been averaged away with nothing
on screen saying so.

---

## 8. Tracks and annotations

A contact map is read against what is on the sequence: genes, peaks, coverage, called loops. This
section is the whole of that surface. It is **restricted to cool and mcool** — see §8.5 — and it is
additive: a file with no annotations loaded behaves exactly as it did before this section existed.

### 8.1 The three cards

Three cards in the left sidebar, above Binning QC, in this order. Each is absent — not disabled, not
empty — on a file that cannot carry them. A fourth, **Bookmarks** (§8.10), sits under them and is not
in this list because nothing in it is an annotation: it holds places rather than things drawn at
them.

**Linear annotations.** Three drop areas, and everything they hold is drawn *beside* the map, never
on it: **one GTF** (at most one, because a second gene model over the first is a smear rather than a
comparison), **tracks** (bigWig, bedGraph, wig and — for its coverage — BAM (§8.13), any number,
resolved as lines or areas), and **bed-like files** (any
number, resolved as genomic segments). Each is placed on any of the map's four edges — above, below,
or down either side — or on several at once; each carries its own limits, style, colour and value
scaling; and any set of tracks may share one autoscale group.

A fourth kind of lane belongs to no card at all: the **virtual 4C profile** (§8.9). It is a reading
of the matrix rather than a file loaded against it, so it has no row to be listed in, nothing to
remember across a reload, and no place in the 1D browser — and it is a lane in every other respect,
which is the point of it.

**Map overlays.** Annotations drawn *on* the matrix. Bed-like files mark on-diagonal borders or
elements; bedpe-like files mark off-diagonal pairs as circles. Kept apart from the card above because
these two answer a different question — not "what is on the sequence here" but "this pixel is a
feature" — and because one file is rarely wanted in both roles at once.

**Metadata annotations** (§8.12). The columns the open file already carries about its own genomes,
sequences and bins — completeness, contamination, an MGE call, a balancing weight — drawn against the
map's own cells. Discovered rather than loaded, so it is the one card whose contents nobody had to
find, and the one card a `.metacool` gets (§8.5). It sits under the tracks and over the marks,
because the column descends from what came out of a file to what a reader put there by hand.

**Manual annotations.** Marks the reader draws themselves: any number of lines (vertical, horizontal
or both), arrowheads (on- or off-diagonal) and rectangles (on- or off-diagonal, at any ratio), each
entered as coordinates or picked by clicking the map. This is the card that makes a figure, and
nothing in it comes from a file.

The three are three sentences — *this coordinate*, *this cell*, *this block of contacts* — and the
third is two intervals rather than one interval and a shape, because the boxes people draw are not
one shape: a domain is a square on the diagonal, a corner peak is a small square off it, and a locus
against a whole arm is neither. An on-diagonal rectangle is drawn as the same triangle a BED domain
is on a turned map, since that is what it is.

**Each kind asks the map for the gesture that suits it.** A line and an arrowhead each name a place,
and the gesture for a place is a click. A rectangle names an extent, and the gesture for an extent is
a **drag**: press at one corner, let go at the other, with the map's own marquee and its coordinate
chips showing what is about to exist. The marquee follows the hand on both axes — a selection is
squared because it *resolves* to one range, and a mark does not — and it snaps out to the edges of the
cells the two ends are in, which is what commits. Holding Shift locks the box to the diagonal, so a
domain is one gesture. All three modes stay on for as many marks as the reader wants, and a click
while the map is waiting for a drag places nothing rather than navigating.

**A box drawn on a turned map is a box of the square underneath it.** Both ends of the drag are taken
back to the square they were rotated out of, exactly as a click is, so pressing over one contact and
releasing over another names the rectangle those two contacts span — which may be off the diagonal,
and is the one thing a band selection there cannot say. Shift collapses each end onto its own midpoint
instead of snapping the pointer, which gives the on-diagonal square through the two places the drag
ran between. What is *drawn* while the hand moves is the mark itself rather than a rubber band: a
rectangle of rows against columns leans at 45° on a turned map and folds where it crosses the
diagonal, so a box on screen would be a box drawn around a shape that is not one.

A hand-drawn mark never sits on the pixel it is about (§8.1's rule for overlays generally). For the
arrowhead that means the glyph is stood off the cell along its own 45° axis **and** by a pixel square
to the axes: the mark is anchored at the cell's centre, so a diagonal gap alone clears the centre and
not the corner, and at any zoom where a bin is a handful of pixels the tip landed on the last row and
column of the cell it was pointing at.

### 8.2 bigWig

bigWig via `@gmod/bbi` v10 (the JBrowse 2 parser, MIT). Local files take a `generic-filehandle2`
`BlobFile`; remote files take its `RemoteFile`, which uses the global `fetch` — so local and remote
differ only in the handle, exactly as with HDF5, and neither path uploads a byte (§11).

Values are requested through `getFeaturesAsArraysMulti` at the view's pixel resolution: one call per
track per view covers every visible contig at once, `basesPerSpan` selects the file's own zoom level,
and the result is typed arrays rather than a million feature objects. That is what makes a
whole-genome view of ten tracks affordable, and it is the same "averaging when zoomed out" a genome
browser does — read out of the file rather than computed here.

**Contig-naming contract.** bigWig is keyed on chromosome names, which here are **contig** names from
`/contigs`, not genome names. On load, intersect the bigWig's chrom list with `chromnames` and report
the overlap explicitly ("16 of 16 contigs matched"). Silent zero-overlap is the most likely support
question and must be impossible.

**On a file with a genome layer the report is about genomes** (§8.5). The same arithmetic that is
informative on a cooler is alarming on a metagenome: a coverage track over four MAGs matches `794 of
20,566` sequences, which is true, and is also what a track about another organism entirely would
say. So where the map has genomes the sentence counts them — *794 of 20,566 sequences, in 4 of 48
genomes: metator_00001_00000, …* — and it is a **note rather than a warning**, because partial
coverage is the expected shape of a track over a co-assembly and painting it yellow would make the
ordinary case read as a fault. The two failures that *are* faults keep their voice: no overlap at
all, and a cross-convention match whose lengths disagree (§5.9).

### 8.3 Text formats

Parsed in full, in the annotations worker, never on the main thread — a 9.5 MB GTF is a tenth of a
second of parsing and that is a tenth of a second of frozen UI.

| Format | Accepted as | Coordinates |
|---|---|---|
| GTF / GFF | the one gene model | 1-based, inclusive; converted on parse |
| BED 3/4/5/6/9/12, narrowPeak, broadPeak | segments | 0-based, half-open |
| BEDPE, and a headed TSV carrying `chrom1/start1/end1/chrom2/start2/end2` | pairs | 0-based, half-open |

Detection is by content, not by extension: a `.tsv` of loop calls with a header row is the shape the
demo data has, and refusing it because of its suffix would be pedantry. A file whose contigs do not
intersect the map's is reported with the overlap count, as a bigWig is, rather than loaded to draw
nothing.

### 8.4 Geometry, and why nothing can drift

One rule: **the heatmap and every annotation share the axis `Scale` objects** (§`render/scale.ts`),
which are owned by the view and written by the heatmap's own pan and zoom. Nothing here computes a
second coordinate mapping, so a track and the matrix column above it cannot disagree by a pixel.

What a `Scale` speaks is *matrix coordinates* — fractional cell indices along one axis of the
rendered block — and what an annotation speaks is (contig, base pair). The bridge is a **locus axis**
built from the block's own `AxisGroup`s: a piecewise-linear map, one piece per contig run, derived
from `unitStart`, `unitLength` and the bin size. It is the same arithmetic the hover readout already
does, from the same two numbers, so a tick, a tooltip and a track cannot disagree either. It covers
every view without a special case: one contig, two different contigs, or all sixteen at once.

Annotations are meaningful at bin and contig level. At genome level they are hidden — a cell is a
whole genome there and a position inside one would be an invention.

**Pan and zoom stay I/O-free**, as §2 requires of everything else. A track fetches whole visible
contigs at a reduction level chosen for the current zoom and keeps them; panning and zooming redraw
from that cache. A refetch happens only when the visible contig set changes or the required
resolution crosses a factor of two — not once per frame, and never during a drag.

This paragraph is older than §2's fourth clause and it is what that clause now says too: the matrix
refines by the same rule, from the same three ideas — a window wider than the view, a resolution
quantised so a small zoom asks for nothing new, and the picture in hand left on screen until the
better one arrives.

### 8.5 Every container, and genomes with no map

**This section used to be a gate, and the gate is gone.** It read: every card, every lane and every
overlay is offered only where the file has no genome layer — which is exactly "this is a cooler"
(§9) — and on a `.metacool` none of them are rendered at all. The argument was that a metacool's
axis is thousands of contigs from thousands of *different organisms*, assembled independently, so a
bigWig or a GTF keyed on contig names either coincides or misleads.

**The premise was wrong about the files people have.** A metagenomic Hi-C dataset is *one
co-assembly* — one `spades`/`megahit` run over one library — which is binned into MAGs afterwards.
The names in `/contigs` are therefore one namespace, and on the reference file they are 20,566
sequences with 20,566 distinct names, `NODE_17248_len_278011` and its siblings. A bigWig of coverage
over that assembly is keyed on exactly those names, in exactly the (contig, start, end) coordinates
every other lane in this application is drawn in. There was never anything to coincide with: the
naming ladder (§5.9) is already inert on opaque assembler ids, matching them by spelling and nothing
else, which is what makes the rename safe on a metagenome in the first place.

So the cards are offered on every container. What a metagenome needed instead of a gate was an
**honest report**, and that is where the gate's real content went (§8.2): a track over a co-assembly
covers the organisms it was made about, so the sequence counts say `794 of 20,566`, which is
arithmetically true and reads exactly like a file that failed to match. The unit of the answer on a
file with a genome layer is the **MAG**.

The `__unbinned__` pseudo-genome is not one of them (§7.4): it is every contig binning failed to
place, and counting it would put a 49th organism in a sentence about 48 and name it as something a
track "covers".

Two things are still true of a session browsing an assembly **with no map** (§5.8): it offers the
same cards for the same reason, and one assembly means one namespace of sequence names.

**And §8.12 is the card that never needed the gate lifted.** A metacool's own `/genomes` and
`/contigs` tables are keyed on that file's own axis — there is no convention to coincide with, no
overlap to report and nothing to match, because the names *are* the map's — so the **Metadata** card
was offered on every container from the day it existed, and was for a while the only card a metacool
got.

**And the same argument settles the two ways a second *map* gets in.** The lower-left triangle
(§5.7) and the deck (§16) both rest on the one thing their pictures must share — a coordinate system
— and two metagenomes have none: their axes are contigs from two independent assemblies, so a region
that names a place in one names nothing in the other. `compareRefusal` has always said so, and the
**Contact maps** card offering it was still the first thing in the Annotations column of every
metacool — a control whose whole function on that file was to invite a gesture and then explain that
it does not work. It is absent there now, and so are the deck's `+` edges, its "add a map" command
and the deck a shared `maps=` link would otherwise build. A control a file cannot answer is not shown
greyed; it is not shown.

### 8.6 Persistence

The loaded set, and every per-annotation setting, is remembered per file in `UiMemory` — the same
session-scoped store the table filters use. Deliberately **not** in the URL hash: §5.5 shares *what is
being looked at*, a dropped local file cannot be re-read after a reload in any browser, and a link
that arrived carrying half an annotation set would be worse than one carrying none.

The key is the **session** and the URI, not the URI alone (§5.6). Two tabs on one file are two
workspaces and must not adopt each other's tracks.

What comes back is **every** decision, and that includes a track being turned *off*. Whether a row is
drawn is a setting like its colour and its height, and it used to be the one that did not survive:
the door a row comes back through is the same one a new row arrives by, and a new row is drawn. On an
`.mcool` that is not a rare event — the same file at another resolution is a fresh open with the
tracks restored around it (§3.4) — so changing the resolution quietly undid a reader's "not this
one", by way of a menu about something else entirely.

### 8.11 bedGraph and wig, and reading part of a file

Two additions to §8.3's list of text formats, and one to how any of them is read.

**bedGraph and wig are tracks, not feature sets.** A bedGraph *is* a bigWig
written out, so it becomes the same kind of thing: `kind: 'track'`, data held in
the annotations worker, sampled per view. That is what gives it a range, a
ceiling, an autoscale, a colour chip, the ⌘-scroll and every other affordance a
bigWig lane has, none of which had to be written twice. The one thing it cannot
borrow is the bigWig's on-disk zoom levels, so the summary for a window is
computed when the window is asked for — the same answer, paid for at read time
rather than at write time, which is the trade the text format already made.

The asymmetry this removes is worth recording, because it was invisible: **the
app wrote bedGraph and could not read one.** Every §18 result offers the button,
and dropping the file back produced a lane of featureless boxes, the value column
having landed in `name`. The sniffer is asked before the feature sniffer and is
deliberately the stricter of the two — exactly four columns, numeric on every row
inspected, or a `fixedStep`/`variableStep`/`track type=` line saying so — because
a rule that captured real BED4s would be a worse bug than the one it fixes.

wig's 1-based inclusive coordinates become 0-based half-open at the parser, which
is the one place the file's own numbering is read.

**A tabix sidecar makes any of it bounded.** Every other read in this application
is: HDF5 through range requests, a bigWig by zoom level and block, a `.hic` by
the blocks its rectangle covers. A GTF was downloaded whole. Where a `.gz` is
BGZF and a `.tbi` sits beside it — dropped alongside, or at the conventional
`<url>.tbi` — the index is read and only the byte spans holding *the sequences
this map is about* are fetched.

It is **opportunistic in exactly §3.4's sense**, and the fallbacks are the
feature: a plain GTF still works, a bgzipped one with no index still works, and
an index that is absent, corrupt, truncated or for another assembly falls back to
the whole-file read rather than refusing the track. An index that can prevent a
file from opening is worse than no index.

That rule is about an index which makes a *working* read faster, and it stands
unchanged for every format it was written about. Where the index is the only
bounded read a format has, its absence is a property of **the file** rather than
of the index, and there is no read to fall back to — so the refusal is the honest
answer and it names the command. See §8.13, which is the one format that is in
that position. Two further guards follow from that: a
sidecar is only *asked* for when the file is a `.gz`, and a span set that would
read more than four fifths of the file is abandoned, because a saving that is not
one costs a round trip to discover and nothing else.

The resolution is a **contig**, not a region, and that is a decision. §8.4's lanes
hold a whole `FeatureSet` and draw the part on screen, so region-serving would
need a second lifecycle — a fetch per pan — for a saving that only appears once
the per-contig slice is itself large. What the index buys is not reading the other
twenty-three chromosomes, and that is most of the win.

### 8.7 bigBed

Read whole, and parsed as the BED it holds. Not a windowed source like a bigWig: a `FeatureSet` lives
on the main thread precisely so that a pan redraws with no round trip (§8.4), and a windowed one
would give that up for a format whose usual contents — gene models, peak calls — are a BED's size
anyway. Feeding bbi's rows back through the BED parser rather than decoding them separately is what
makes a bigBed12 draw its exons exactly as the text file does: one parser, one set of rules, one
place where BED's quirks live. A file past a million intervals is cut off, and says so.

### 8.8 One lane, two surfaces

There are two places a track is drawn — the stacks on the map's four edges, and the map-less 1D
browser (§5.8) — and they are *one surface*, not two that are kept in step. §8.4 states that as a
coordinate rule; this states it for everything above the coordinates.

A lane's **label block** is drawn once (`render/laneLabel.ts`) and, crucially, hands back the boxes
it measured: the chip before each name, one box per end of the range, the spot for the autoscale
button, the row the handle sits on. A block that only *draws* can never be pointed at, and that is
precisely how the same two numbers came to be editable in the browser and inert beside the map. The
two surfaces differ only in the constants they pass — a lane beside a map can be sixteen pixels tall
and its text nine; a lane in the browser is ninety and its name is what identifies the row.

The rest follows the same shape. **Groups** are a fact about the tracks rather than about a view
(`annotations/groups.ts`), so one `GroupSettings` per open file is handed to both surfaces, one
`planStack` decides which lanes exist, and one `resolveGroupExtents` decides what they are drawn
against — which is what makes *scale each* mean the same thing in both places, having previously been
stored by one and ignored by the other. The **controls over the canvas** (`ui/LaneControls.ts`,
`ui/LaneLimitEditor.ts`) are parameterised by a host element, because that is the only thing that
differs: in the browser the layer and the canvas share an origin, and beside the map the layer is
positioned against the grid and offset per frame.

Two constraints are permanent and are why this is a shared module rather than a shared file. Every
mark must be placed through `laneRect`/`laneText`, so a right-hand lane's quarter turn is
`render/lane.ts`'s business and nothing else's. And anything a lane *draws* lands in the exported
figure, so it must stay inside `VectorPage`'s op list, while anything that is a *control* must stay
in the DOM layer, which the figure geometry does not build.

### 8.9 Four edges, and one gesture in one dimension

A lane may be drawn on **any of the map's four edges**, and the four are peers. `top` and `bottom`
follow the map's columns; `left` and `right` follow its rows. One rule covers all of them and it is
in `render/lane.ts`: a lane is laid out in *along* (the genomic direction) and *across* (the value or
stacking direction), **across always runs outward, away from the map**, and that module is the only
place that knows which of the two is x and which way each of them points. The consequence is that
"the far border", "the end the handle hangs off" and "where the baseline is" are one answer each
rather than four — which is what made adding the two mirrored stacks a coordinate conversion rather
than a second renderer.

Which way a lane *grows* is the one thing that is not a coordinate, and the two axes answer it
differently. A **horizontal** lane grows up the page wherever it is, above the map and below it
alike: there is a universal reading convention for a track on a genomic axis — every browser ever
built draws coverage rising from a floor under a ruler — and it beats every argument from the
picture's own symmetry, because a profile above a contact map hanging from its ceiling is one a
reader has to mirror in their head before they can compare it with the one below. A **vertical** lane
has no such convention, so what decides is the corner: it grows towards the matrix, since a lane
growing outward from the map's own edge reads as pointing away from the thing it is beside.

Exactly one edge therefore turns a lane's axis on arrival, which is what it was when there were only
two. Moving a lane between two edges turns it again exactly when that answer changes, so a reader who
deliberately hung a track from its ceiling keeps that decision through the move.

#### The lane that used to be here

There was a **virtual 4C lane**: shift-drag on the map named an anchor, and a strip appeared summing
that band of the matrix, computed from the block on screen. It was a synthetic entry in the same
`AnnotationStore` as everything else, which is what made renaming it, restyling it, rescaling it and
dragging it to another edge one implementation rather than a second copy — and that argument still
holds and is now made by the **synthetic tracks** of §18.5.

It is gone, and the reason is not the lane, it is the **second answer**. §18.9's 4C *task* asks the
same question of the *file* rather than of the picture: it reads the pixel table, so it is not
bounded by what happens to be loaded; it produces a track that is a track like any other, with a row
on a card and a bigWig to export; and it carries a provenance line saying what it is. A dimmer copy
of that appearing beside the map without being asked for, redrawing itself on every pan, is a worse
version of the same claim in the same session — and the two would disagree at every level but the
finest.

What is kept is one sentence: *the reader can point at a locus.* The 4C task's **Pick on map** button
arms `ui/mapPick.ts`; the next drag on a map names a locus for that form and the button goes out. It
is a mode on a picture, so it disarms after **one** pick and it disarms on Escape, and both rules are
in the module rather than in the map — the map's whole job is to ask `isArmed` before it decides what
a drag means.

**Above bin level a pick names the unit, not a span.** There is no `LocusAxis` on a genome × genome
picture — a cell is a whole MAG and a base pair inside one would be an invention (§8.4) — so the
gesture used to do nothing at all there: the button lit, the drag ran across the one picture a
metagenome's 4C is naturally anchored from, and the box stayed empty. What can honestly be reported
is the *run* under the drag, and a bare name is what every range grammar here already takes for the
whole of a sequence or the whole of a genome. It is refused where the axis is **pooled by units** —
a slot holding fifteen genomes, which its own label says with a `+15` — because naming one of them
would be naming whichever the reader did not point at.

The other half of that gesture is the **anchor** itself: the 4C runner has always resolved a genome
name, deliberately, so that *cis* means the whole MAG rather than whichever contig the first bin fell
in. The form refused one — it resolved the name against `/contigs` alone — so the name the picture is
labelled with could not be used on the picture it came from. It resolves both now, and the locus
box's own suggestions lead with the genomes on a file that has them: there are tens of those against
tens of thousands of contigs, and a list that opened on the contigs taught the reader the opposite of
what the grammar accepts. **And no default is invented at genome level**: a framing there counts
*slots*, so reading its extents as bins produced a real 48 kb window of whichever sequence the file
began with — a locus nobody chose, offered as the anchor, and run without a word if the button was
pressed.

#### Shift-drag is a zoom, in one dimension, everywhere

Freed of the anchor, **Shift-drag names a band of one axis and zooms to it**. Which axis is decided
by which way the hand went, so a drag a few degrees off vertical still means what it plainly meant.
Zoom is one scalar for both axes, because that is what keeps a cell square (`imshow(aspect="equal")`),
so a 1D gesture has a 2D consequence — and **that consequence is the diagonal**: the axis nobody
dragged is centred on the same stretch, so what comes back is the on-diagonal square. It used to keep
whatever centre it happened to have, which made the same drag land on a different picture depending on
where the view had been panned to, with nothing on screen saying which. Where the block has no
diagonal — a `chrI × chrII` panel — that axis keeps its centre, since there is no square to open and
pulling it to a bin the block does not contain would only jam it against an edge.

**Shift is the map's on-diagonal modifier throughout**, and the pointer says so before the drag
begins: while it is held the readout and the crosshair snap onto the diagonal — the perpendicular foot
of the pointer on the line the two axes name the same bin — so the reader can see which stretch a
Shift-drag would open. Only the reading moves; the cursor stays where the hand put it. It answers the
question a hand hovering over a contact map is usually asking anyway, and finding the diagonal by eye
at a fitted whole-genome view is a two-pixel target on a 45° line. Off on a turned map, where every
reading is already measured from the diagonal and the snap would be onto the picture's own bottom
edge.

**Recentre on the diagonal** is the same idea as a control: a button in Aesthetics → Map, between the
turn and `O/E`, that slides the view onto the nearest on-diagonal window at the zoom it is already at
— the perpendicular foot of the *picture's* centre, which is the least it has to move. Every gesture
that lands off the diagonal takes several more of the same gestures to come back from, and no drag can
say "here, but on the diagonal". Greyed where the block has no diagonal, and while the map is turned,
where the picture already is one.

The same gesture is on the **lane stacks** and in the **1D browser**, and it is the same gesture in
the strict sense — `HeatmapView.bandAt` is the one pixels-to-cells conversion, because §8.4 glues the
lane canvases to the map's along their shared axis, and two conversions would be two chances to name
different stretches. A band dragged out on a stack is drawn across the *map*: a stack has no marquee,
and one drawn only inside the track would say the band stops where the track does.

**Every one of these gestures copies what it framed.** Shift-drag writes `chrIV:500001-510000` — no
thousands separators, a plain hyphen, 1-based inclusive, which is the difference between a string
that pastes into samtools, bedtools, IGV and this app's own locus boxes and one that only looks
right. The app's *display* format uses an en dash and grouped digits, and that one is for reading.
Option-drag, which selects a box, writes both axes in the order this app always names them —
`chrI:1-10000|chrII:40001-50000`, rows then columns, each half exactly what that stretch would
produce on its own, separated by a character no coordinate grammar uses. In the browser a drag
crossing two sequences zooms and copies nothing: that is a fine thing to look at and it is not a
locus, and clamping it to one end would hand back coordinates for a region nobody selected.

### 8.10 Bookmarks

A fourth card under the marks, and the second thing in this section that comes from nobody's file:
**places worth coming back to.** A bookmark is a region and a bin size, and nothing else.

Both halves are decisions. The **region** is stated in (contig, base pair) like every other
annotation here (§8.1), so it means the same thing at 1 kb and at 20 kb. The **bin size** is carried
anyway, and separately, because on a contact map *where* and *how closely* are two questions: a loop
found at 1 kb is not visible at 20 kb, and giving a reader back the coordinates without the grain
gives them back a picture the note was never made against. What is deliberately **not** in it is the
zoom, the colour scale and which way the map was turned — those are how the picture was drawn at the
time, and a bookmark that restored them would be a saved screenshot rather than a saved place.

**Going there opens the whole sequence, standing on the location.** This is the requirement the
feature exists for and it is not what setting `region=chrI:1200000-1260000` does: that *cuts a block*
at those coordinates, so the edges of the picture are the edges of the data and panning off them
shows paper. A bookmark sets `region=chrI` and puts the location in **`focus`** (§5.5), which is a
window over a block read whole — so the first thing anybody does on arriving somewhere, look at what
is either side of it, works. `focus` is a one-shot initial condition rather than a live position:
pan and zoom are not in the hash, so the link keeps pointing at the place it was made for however far
the reader then wanders. It is applied on the diagonal, because a locus is one coordinate and a
contact map takes two — a square map takes the window on both axes and a turned one takes it along
the genomic axis and lets the other follow.

**Three ways in, because they are three moments.** A button beside `go` on the title line saves the
window on screen, which is for the place you have just found and do not want to retype. The card
takes typed coordinates, which is for a place from a paper or a colleague. And the card imports
**BED**, which is for the forty places anybody who has called peaks or loops already has in hand —
read as the first three columns and the name, so a narrowPeak, a BEDPE's first mate and a headed
table from R all import without a format question. An import claims no bin size, since a list of
intervals does not state one.

Kept in per-file session memory beside the marks (§8.6), which is what makes them survive a change of
resolution, a switch of view, a deck opening and closing, and a reload; and carried in an exported
session (§5.6), because a list of loci walked one after another is work, and it is the one part of a
workspace a recipient can act on without the bytes.


### 8.12 Metadata annotations: the file's own columns

Every container this viewer opens keeps tables beside its pixels, and those tables have always held
more than the arithmetic the reader needs. A `.metacool`'s `/genomes` carries completeness,
redundancy, GC content and whatever else the binner wrote; its `/contigs` carries what the assembler
and the annotator joined on — an MGE call, a coverage, a bin id; and every cooler's `/bins` carries at
least the weight it was balanced with. Until this section all of it was readable only as a *table*,
one row at a time, in a view that is not the picture.

**A metadata column is an annotation, and it joins the same store every other annotation joins.**
Adding one from the drop-down produces an ordinary entry with `kind: 'metadata'` (a value profile) or
`kind: 'classes'` (a set of labels), and from that moment the colour, the rename, the height, the
limits, the autoscale group, the four edges, the multi-map placement, the reorder, the hairline, the
tooltip, the figure export and the session memory are the one implementation those rows already go
through — the argument §18.5 makes for computed tracks, made a second time and settled the same way.
What is left for a card of its own is the drop-down, the provenance line, the legend and a TSV export.

**Two pictures, because a column is one of two things.** A *quantitative* column is a value per unit
and is drawn as bars against an axis, defaulting to bars rather than a line because one cell is one
unit and there is no ground between two MAGs to interpolate over. A *qualitative* column is not a
value at all and is drawn as runs of colour with the category written into the runs wide enough to
hold it, from a fixed colour-vision-safe palette rather than from the lane's own colour — the colours
belong to the categories, they have to mean the same thing in every lane and every figure, and one
swatch cannot describe six of them. Which of the two a column is comes from the values: text is
qualitative, numbers are quantitative, and small integers repeated over many rows are the labels a
binner writes rather than a measurement. A column whose every row is a different string is an
identifier and is not offered at all.

**The level rule: a table may be no finer than the axis.** This is the whole of what makes a metadata
lane adapt to the view, and it is a rule about honesty rather than about effort. One cell of a genome
× genome overview is a whole MAG, so a genome column has something exact to say about it and a bin
weight has not; one cell of a bin × bin view is a bin, so all three tables can speak. A coarser
column is therefore *broadcast* down — a MAG's contamination is exact on every contig and every bin
inside it, and drawing it as a constant invents nothing — and a finer column is refused upward,
because rolling bins into a MAG means choosing a statistic nobody asked for and then drawing it in
the same ink as a number the file wrote. The drop-down offers what this view can show and lists the
rest **disabled, with the reason**; a row already added to a view that has since coarsened stays in
the list and says it is not drawn here.

Inside a cell the aggregation *is* allowed, and the difference is that it stays in the unit the axis
is drawn in: a pooled block's cell is those bins, every one of them on screen at that position, so a
quantitative column is averaged over them (skipping `NaN`, which is a filtered bin and means *no
value here*) and a qualitative one takes the most common of them.

**Cells, not base pairs.** A metadata lane is indexed by the map's own cells, which is what lets one
be drawn on a genome × genome overview where no other lane can be: there is no `LocusAxis` there at
all (§8.4), because a cell is a whole MAG and a base pair inside it would be an invention. Which row
of which table each cell is comes from what the reader already sends with every block — the axis
runs, the bin each run's sequence starts at, and the pooling — so it is exact on all three levels,
dense or pooled, and resolved through the *bin* rather than through a name wherever a bin is
available. That last clause matters on a metagenome, where two MAGs are entitled to have assembled a
`contig_1` each.

**Reading `/bins` stays bounded.** §3.3's rule is that coordinates never come from `/bins`, and they
still do not: what is read at open time is the group's column *names and dtypes*, which reads no
values, and a column is then read over the bins the picture covers, cached by that range and widened
by half on either side so a pan costs nothing. A window too large to read at once is refused in the
row with the number, rather than by freezing the tab.

**Persistence and export.** A row is remembered per file like every other (§8.6) and comes back
**ready** rather than detached — there is no file to re-open and no recipe to re-run, because the
column is in the map that is already open. A row naming a column the file no longer has is kept and
says so. The TSV export writes the column at **its own** granularity, one row per unit of the source
table under `#` comment lines naming the file, the table and the column: a lane is drawn at whatever
level the view is, and a reader checking a bar against the file needs the rows the file actually
wrote (§18.7).

### 8.13 Alignments

A `.bam` opens as a lane, and it is the first kind here that arrives with a rule of its own attached
to it (§1). Everything below is that rule and what follows from it.

**What is built is the reader, the depth track and the pile of reads**, with their controls, the
per-read card, and mates and split reads drawn. What is deliberately absent is listed at the end of
this section, each with its own reason.

**The pair is the unit.** A BAM is read by region and nothing else: there is no zoom level in the
file, no summary layer, and no whole-file read that respects §12 — a human alignment file is tens of
gigabytes and the demo yeast one is not the case worth designing for. The index is the only thing
that makes reading by region bounded, so a BAM without one is refused **by name**, and the refusal
says `samtools index`. That is the narrow carve-out §1 states positively, and it costs nothing
anywhere else: §8.11's opportunism is about an index that makes a working read *faster*, and it is
unchanged for every format it was written about. A `.bai` and a `.csi` are both read, decided by
their magic bytes rather than their suffix, and both spellings `samtools index` writes are paired
with the file they belong to. A remote file names its own — `<url>.bai`, guessed and never probed,
since §12 has no request to spend discovering that a file has no index — and where the guess cannot
work, a presigned URL or one carrying a query string, `<url>#index=<url>` says where it really is.

The second refusal is **sort order**, and it is not a technicality. Every byte this reader fetches is
addressed by an index that describes a coordinate-sorted file; a name-sorted one handed to a region
query answers with whatever happened to be in those blocks, which is worse than refusing because it
looks like an answer. The `@HD SO:` line is read and the refusal says `samtools sort`.

**A BAM imports as two rows, and only one of them is anywhere but the browser.** One is *depth* — a
value per pixel, and therefore a track in every sense §8.2 means: it goes through `sample`, inherits
`profileOf`, the readout, the four edges and the figure, and joins an autoscale group with any other
track over the same assembly. The other is the *pile* of individual reads, which exists only in the
1D browser. The rule is geometry rather than policy: a read is drawn along the axis at its own
extent, and beside a heatmap the axis is an axis of matrix bins where the finest unit is a bin and
not a base. There is nothing for a read to be drawn *on* there, so a pile row is never placed on a
map, at any zoom.

Two **rows** rather than two bands of one lane, and that is the shape the whole of the rest of this
section follows from. They are two pictures with nothing in common — a curve against a value axis
against a stack of rectangles — and sharing a lane made every question about them conditional: how
tall is this, what does a ceiling drag do here, which band did that click land in, which of the two
does a resize grow. As two rows each is resized, reordered, hidden, exported and **closed** like any
other track, and a reader who wants the depth without the pile closes the pile. The lane machinery
needed no case for either.

What has to be paid for that is one link. The two rows point at each other, and everything that is
about *which reads count* — the mapping-quality floor and the duplicate switch — is written through
to both: a floor applied to the pile and not to the depth beside it is two pictures of two different
files under one name, and nothing on screen would say so. How the pile is *drawn* — the colouring,
the pair layout, the split-read switch — is the pile's alone, because none of it means anything to a
curve. Closing one row clears the other's link, so a write-through cannot chase a row that has gone.
In the worker the two rows share one open handle and one parsed index, keyed on the file **and its
index**: a BAI for a human alignment is single-digit megabytes to fetch and to parse, and the second
row must not pay that again to throw the result away.

The pair is made when the bytes come back rather than when the file is dropped (§8.3), so a file
named `.bam` that turns out to be something else gets one row; and it is made only for a **fresh
import**, so a reader who closed the pile and kept the depth is not handed the pile again on every
reload. The link is stored with the session, and the pile's kind survives its own load — a `bam` is
`alignments` by format, and re-deriving the second row's kind from the format would fold it back
into the first.

The same two-pictures-one-file shape is already true of the FASTA lane, which is GC content beside a
map and residues only in the browser (§8.8). Alignments differ in that the two pictures are far
enough apart to be worth two rows.

**Above what it can afford, the lane draws nothing and says why.** This is the one place an
alignment lane differs from every other kind, and it follows from having no summary layer: depth over
a window is a full read of the reads under it, so a window can be legitimately unanswerable. The
forecast comes from the index alone — the byte spans a region resolves to, summed before anything is
fetched — so a window too deep to draw is refused at **zero data requests** rather than discovered
part-way through a fetch. What the lane then shows is its name, an empty band, and a sentence naming
the number and the way forward.

The estimate that would have filled that space was considered and refused. The BAI linear index
gives compressed **bytes** per 16 kb window, which is not depth: it varies with read length and with
how well the reads compressed, it is floored at 16 kb, and CSI carries no linear index at all — so on
the files with the longest chromosomes it would simply be absent. Drawn on a depth axis it would be
the first quantitative lane in this application that means something other than what it says, which
is the rule `__unbinned__` (§7.4) and the bigBed truncation notice (§8.7) are both instances of. A
bigWig of the coverage is the honest answer at that width and the message names it, because
`@gmod/bbi` is already here and reads one.

**What a bin holds is mean depth**, and three decisions inside that are worth writing down because
each is a place a viewer can quietly disagree with `samtools` and never say so. A CIGAR `N` is not
covered: it is reference the read is aligned *across* rather than *over*, and counting it draws an
RNA-seq gene as a solid block and erases the only thing the picture was for. A `D` is covered,
because a deletion is a base the read asserts something about. Secondary and supplementary
alignments are excluded, because they are one molecule reported twice and they cluster at repeats and
breakpoints — the loci where the number is being read most carefully. Duplicates are **kept**: marking them is a
pipeline's decision, and hiding them silently would make this app disagree with every other reading
of the same file. It is offered as a switch instead, and it is off until a reader turns it on. And
the value is covered bases per bin divided by bin width rather than a count of reads touching the
bin, which is the same number at base resolution and an order of magnitude smaller at any other.

**The lane's controls travel on the request that needs them.** Colouring, a mapping-quality floor,
the duplicate switch and the split-read switch are a per-lane style like a colour or a ceiling, and
they are stored with the session and validated on the way back in. What is worth stating is where
they are *read*: they are fields on the `sample` and `reads` requests rather than state configured
once per open file. State would make the answer to a request depend on the order two messages
happened to arrive in, and it would leave the caches on the main thread keyed on nothing that
changed — so a reader's click would do nothing until they panned. Carried on the request, a cache
miss is a mismatched key rather than a race.

The two keys those caches use are deliberately different widths. Four of the five fields change what
comes back — the colouring decides the category column the worker sends, and the floor, the duplicate
switch and the split switch decide which reads exist — so the pile refetches on any of those. The
fifth, joining mates, is drawn from columns the pile already carries and is in no key at all. Depth
is a *count*, and a count does not care how the reads that made it were coloured — so the coverage
cache watches only the floor and the duplicate switch. Without that split, trying a colouring would
discard a whole-genome coverage scan, which is the most expensive read in the application, for a
change that cannot move the line by a pixel.

A change made while the previous window is still decoding **replaces** it. What is decoding was asked
under controls nobody is looking at any more, and this worker has no queue — so leaving it in place
holds up every other lane's `sample` behind an answer that will be thrown away. The test is against
the *running request's* controls and never against the drawn window's: written the other way it is
permanently unequal between the change and the first landing, so every frame cancels the request the
frame before issued, and on a real file the new pile never arrives at all.

What the colouring is **not** is a grouping. The rows are packed by position alone, so the categories
are interleaved down the pile rather than banded; a band per category is a separate feature and is
not built.

**The rows are packed for the window on screen, on the main thread.** They were packed in the worker,
over the window that was *fetched* — and that window is three view-widths, so a reader who zoomed in
was shown a packing made for a picture three times wider. Two more things followed from it: a window
read as several byte spans came back as several piles each numbering its rows from zero, which
collided when they were drawn into one band; and a template could not be packed as a unit at all,
because which reads share a row is a question about the picture and answering it in the worker would
mean re-reading the file to change a drawing.

What is given up is row stability under a pan, which the worker's packing had and this does not. It
is worth it because that stability was already a half-truth — the packer only ever saw the reads that
survived thinning, so any change of row budget re-packed everything — and because a row that is
stable and wrong is not the better failure.

**A template is the unit, and the layout says what is drawn between its ends.** `pairs` is the
default: both ends on one row, joined by a dotted thread across the part nobody sequenced. It
replaced a switch that drew a solid thread and left the packing to position, so at any real depth the
two ends of a fragment landed on different rows and the thread ran from one of them towards a mate
that was not there — the picture read as a scatter of unrelated reads. `fragments` fills that gap
instead of threading it; `reads` packs every record on its own, for a single-ended library.

**Each row is resized by its own floor**, which is what two rows bought and is the whole of the
gesture: there is no boundary inside a lane to drag any more. A pile lane is cut into two bands and
only two — a strip for its name and its read count, and the pile under it — and the strip is sized
from the label's own metrics rather than from a constant, because those metrics grow with the
reader's text size and a fixed strip wrote the read count through the top row of reads the moment
the type did.

A lane too short for a single read row draws **nothing**, and says *zoom in* rather than showing an
empty rectangle. That is the same answer it gives when the reader is too far out for a read to be
wider than the ink it would take, and it costs no fetch: the rung is decided from the frame, and the
depth over the same reads is the row beside it, drawn at every zoom.

**A position the reads disagree with the reference at is coloured, on both
rows.** In the pile it is the mismatch mark that was always there — a coloured
column per read, from `=`/`X`, from `MD`, or from a FASTA open in the same
session, and the lane names which of the three answered. On the depth row it is
the *share of the bin* that disagrees, drawn from the baseline up in one colour
so a quarter-height mark under a full-height curve reads as a quarter of the
reads.

One colour there and not four, because the pile beside it already says which
base was seen at exactly the zooms where this is drawn, and a pixel is one
column: what the depth row adds is *where* and *how much*, which is the question
the curve alone cannot answer. And that colour is deliberately **not one of the
four bases**: it shipped as the sequence palette's own T, which put one red in
one column under two opposite claims — *the reads disagree here* on the depth,
and *this read has a T here* in the pile. The rule the test pins is a hue
distance rather than a literal, because the fault was never the constant. It
was that nobody compared it to the palette. Only above a fifth of the depth, which is IGV's
own threshold and is roughly where a position stops looking like sequencing
error and starts looking like an allele — under it, every pileup is speckled and
a reader learns to ignore the mark.

Two limits decide when it is computed at all, and they point the same way. The
cost: finding the disagreements is a walk over every *aligned base* rather than
over the CIGAR's blocks, and the depth scan is the most expensive read in this
application (§12). The meaning: a variant is a claim about a position, and a bin
holding two hundred bases reports the genome's background mismatch rate as a
coloured pixel everywhere. So it is done only below sixteen bases per pixel, and
only where a FASTA covering the window is already open — never fetched for, and
never a second request.

What it is **not** is a variant call, and the distinction is the same one §18.9
makes about a half-good caller inside a viewer. It reports substitutions and
short deletions against whatever residues happen to be loaded. An insertion has
no reference position to be *at*, a soft clip is not aligned, and an `N` in
either sequence is an absence of information rather than a disagreement — so
none of the three is counted. Nothing here is filtered by base quality, tested
for strand bias, or given a score.

A FASTA dropped *after* the BAM has to reach the windows already in hand, or the
marks appear on the reader's next pan and not on the drop — which reads as the
file not having worked. Both caches therefore key on which reference rows are
open, alongside the window and the controls. It is a token and not an address:
the worker looks up its own residues, and this exists only to invalidate.

**Thinning is a property of the zoom, so the cache key carries one.** The pile is thinned in the
worker against the lane's row budget over the fetched window, so a window fetched for a wide view
holds about a third of a narrow view's reads. Answering a zoom from it drew a third of the pile while
the caption reported the wide window's numbers. The held window now carries the octave of view span
it was thinned for, and a zoom of one octave refetches — the same shape §8.4 already requires of a
sampled track, bounded at one refetch per halving, and unmoved by a pan (§2).

**Split reads are drawn and never counted.** A supplementary alignment is a further piece of one
molecule that the aligner could not place in a single run — across a breakpoint, a fusion, or a
junction a long read spans — so showing it is how a reader sees a split, and counting it would report
one fragment as two. The switch therefore reaches what is *drawn* and cannot reach what is
*counted*, which is the one asymmetry between a BAM's two rows and is deliberate. It is held by the
split itself: the depth is its own row on its own road, and `readFilterKey` leaves the switch out
entirely — so flipping it does not even invalidate the depth's cached samples. It used to be held by
a second, narrower filter inside the function that builds the pile, because that function also
counted bases; those counts are gone with the consensus they fed, and with them the one place a
filter widened for drawing could leak into a number. Such a read is drawn outlined rather than faded, since
faded already means "soft clip" here; and it is never joined to the primary as though it were a
mate, because it is the same end of the template rather than the other one.

**A click on a read opens a card, and the card fetches nothing.** Every field on it — the flags in
words, the CIGAR, the clips, the mate's locus, the insert size, the category it was coloured as —
is already in the pile the lane drew, which is why it answers at once and why it cannot disagree with
the rectangle that was clicked. The fields a BAM uses to mean "not recorded" are shown as that
rather than as numbers: `tlen: 0` is no insert size, `MAPQ 255` is not a mapping quality, and a mate
with no position is not a mate at position zero.

**The reader is written here**, as `hic/format.ts` and `annotations/tabix.ts` are and for the reason
they both give at length: every read in this application goes through a source that counts its
requests, caches its chunks and signs them where a bucket needs it, and a parser that fetches for
itself sits outside all three. `@gmod/bam` is a devDependency and the fixtures are read with it,
exactly as `hic-straw` reads the `.hic` ones — because a round trip against our own writer proves the
two agree and cannot prove they are right, and the first thing that oracle caught was a record prefix
off by four bytes in both halves at once.

Most of the byte layer was already written. `annotations/tabix.ts` has BGZF, virtual offsets, span
coalescing and the §5.9 name ladder, and a `.bai` is the same binning index a `.tbi` is. What it does
*not* have is the part this needs: it collapses every bin to one span per sequence and drops the low
sixteen bits of every offset, deliberately and for a reason that holds there — a feature lane holds a
whole `FeatureSet` and draws the visible part (§8.4). A contig's worth of BAM cannot work that way,
so `annotations/bam/index.ts` keeps bin-level chunks, both halves of every offset, the linear index
and the forecast.

**Not built, and each for its own reason.** No **mate fetching**: a mate lives at `PNEXT`, which is
off-screen by definition for anything but a short insert, so following them is one uncoalescable
range request per visible read with no locality at all. The mate's coordinates are decoded and shown;
the bytes are not chased. No **`SA` walk**: a split read's other pieces are drawn where the window
already holds them, from the supplementary records themselves, and the tag naming pieces *outside*
the window is not followed — for the same locality reason the mate is not. No **consensus band**: it was built, and it was a picture nobody asked for — a bar chart of the
commonest base, then a sequence logo, occupying the height that made the pile useful and repeating
what the mismatch marks in the reads already say. It is removed rather than deprecated, and with it
the per-position base counts that fed it. No **variant calling** — §18.9's argument about a half-good
caller inside a viewer applies here with more force, not less. No **contact matrix derived from alignments**: that is
the second application GAPS' original refusal was drawing a line against, and it still is. And no
**CRAM**, which is refused on stronger ground than "wrong app": it cannot be decoded without the
exact reference its records were compressed against, identified by an M5 checksum and conventionally
fetched from somebody else's registry — which C1 and C5 forbid outright — or supplied as a second
required file, which is the rule §1 has just been at pains to keep narrow.

### 8.14 Called variants

A `.vcf` opens as a lane of the variants somebody called. It is a **`FeatureSet`
like a BED and a GTF are** — no new payload, no new renderer, no new cache — and
that is the whole design: a variant lane packs, draws, hit-tests, exports,
searches, collapses and feeds an analysis through the code a peak set already
uses. What it has of its own is a `kind`, because the *controls* and the *card*
differ. A peak has a score; a variant has a REF, an ALT, and a thing that
happened.

The alternative was a payload arm of its own, and it was refused on the shape of
its failure rather than on its size. `payload.kind === 'features'` is tested at a
dozen sites across the browser, the map lanes, the search box, the export and the
analysis inputs. A third arm breaks none of them — it makes every one of them
*skip* the lane, silently, to be discovered one call site at a time.

**A VCF was already being read, wrongly.** `sniffFormat`'s last line is
`return 'bed'`, and `forEachRow` strips every `#` line — so a VCF arrived at the
sniffer as `chrV 1000 rs100 A G …`, matched nothing, and was parsed as a BED
whose every row failed the contig/start/end test. The refusal named a format the
reader never handed over. That is the same failure a four-column bedGraph had
before §8.11's sniffer existed, and it is why both sniffers are asked *before*
the one that cannot say no.

**The interval is the one thing that can lie.** A record spans the reference
bases it is about, which is `POS .. POS + len(REF)` for a substitution, an MNV
and an indel — VCF's padding base included, because that is what the record says
and what every browser draws. The fourth shape is not spelled out: a symbolic
ALT (`<DEL>`, `<DUP>`, `<INV>`) writes a single `N` in REF whatever the event's
size, so `INFO/END` and `INFO/SVLEN` are read, and without them a forty-kilobase
deletion draws as a one-pixel tick. That is a wrong answer that looks like an
answer, which §10 does not permit anywhere else either.

**A substitution is drawn in the colour of the base it substitutes to**, from the
one table `render/sequence.ts` holds and `render/alignments.ts` already borrows.
That is the whole of the ink rule and it buys the picture vertically: over one
locus a heterozygous A>G reads as one column in inks that agree — the sequence
row writes a green `A`, the pile puts orange `G` marks through half its reads,
the depth row's mark rises to half, and the variant row draws an orange box
saying somebody called it. A record with no single base behind it — an insertion,
a deletion, a symbolic ALT, several ALTs at once — takes the palette's fifth
slot, the grey an `N` is already drawn in, which in this application already
means *no single-base answer*. The lane's own colour was tried there and is
wrong visibly: the first colour `ANNOTATION_PALETTE` hands out is `#0072b2` and
C is `#2f6fb5`, ten degrees of hue apart, so on a stock lane an insertion and a
substitution to C were one blue. The reader's colour is what the *density* rung
is drawn in instead, which is where it does the work of telling two variant files
apart.

What the ink deliberately does not separate is an insertion from a deletion.
**Extent** does, and it is exact and free: a forty-kilobase deletion is a
forty-kilobase box and a SNV is one base, so the two classes worth separating are
separated by the strongest channel on the lane. The rest is in the card behind a
click, where `A>AGGT` and `AT>A` are two strings nobody confuses.

**A single base is given three pixels to be seen and to be hit**, written into
the placement rather than applied at paint time — so the box that is drawn, the
box the pointer finds and the box the packing keeps a row clear for are one
number (§8.4). Applied in the paint alone, as it first was, two thirds of every
mark was dead to hover and to click. The floor also changes when the lane stops
resolving individuals. The collapse rule is not "more
features than pixels" — it is *more features than the lane can draw apart*, which
is the drawn floor plus the gap that makes two read as two. At the old threshold
a stretch of variants seven bases apart at whole-contig zoom drew as several
hundred three-pixel marks that merged into one solid bar in whichever ink was
laid down last, reading as a single three-kilobase variant. Collapsing says the
true thing: there are many here. For every other feature lane the floor is zero
and the rule is the `span / 2` it has always been — a peak one pixel wide *is*
one pixel of genome.

**A VCF can say what genome it is on, exactly.** Its
`##contig=<ID=…,length=…>` block is a `chrom.sizes` written inside the file:
declared rather than inferred, which is the tier a BAM's `@SQ` table and a
bigWig's header sit at, and a tier above the "ends at its last feature" lower
bound every other text feature format offers. So a dropped VCF opens a browser
session over its real chromosomes (§5.8). The origin is its own member of
`AssemblyOrigin` for the reason `bam` is one — `lengthsAreExact` reads that field
and nothing else, so a VCF reporting `features` would tell a reader its
chromosomes end at their last variant while an `exact: true` sat beside it being
correct and being ignored. A file declaring no contigs is `features`, correctly.

**Reading part of one is free.** A bgzipped VCF with a `.tbi` beside it takes
`annotations/tabix.ts`'s road unchanged, because that road serves *text* and does
not know what format the text is (§8.11). Which is also why the sniffer cannot
depend on the header: `spansFor` starts at the first record's block, so the
indexed path — the one the index exists for — delivers a VCF with every `#` line
in the part of the file that was deliberately not fetched. The sniffer therefore
has two roads, the declaration and the column shape, and the shape one is
load-bearing rather than a fallback.

**How large a VCF this reads is the same question every text format here
answers, and the answer is the same.** The file is decoded into one string and
parsed whole, so a single-sample human call set — four to five million records,
a gigabyte or two of text — is past what a JavaScript string can hold before it
is past what the machine can. That is not a property of this format: it is
§8.11's whole-file road, and the index is the same mitigation it always was,
serving one contig at a time. A per-chromosome human VCF opens; a whole-genome
one does not, and the honest place to say so is here rather than in a lane that
falls over. Streaming the parse is the fix, it is a project rather than a patch,
and nothing in this section pretends otherwise.

**Not built.** The **genotype matrix**. A VCF's sample columns are a matrix of
variants × samples, and that is a second application's worth of picture for a
question a contact map is not asking — the same argument §13 makes about a
viewer that builds matrices from alignments. The columns are *counted* and the
count is said out loud in the lane's summary — *"1,284 variants · 2,504 samples
not drawn"* — because a reader who brought a thousand-genome file should be told
what the lane is showing them rather than left to infer it from a lane that looks
complete. No **allele-frequency height**: AF is in the card and in the detail,
and drawing it as a bar height would put three different measurements (AF from
`INFO`, AF computed from genotypes, no AF at all) in one channel with nothing on
screen saying which answered. No **BCF**, which is the binary encoding of the
same file and needs its own header dictionary decoder for no picture that differs
by a pixel; `bcftools view` writes the text, and the name guess claims no `.bcf`
so one is refused by its bytes like anything else. And no **variant calling**, which is
§18.9's argument and not a new one.

---

## 9. cool and mcool

Supported natively, and still not as a parallel implementation. A cooler is opened as itself: its
`/chroms` is the contig table, `MetaCooler.genomes` is `null`, and every genome accessor answers
`0`, `[]` or `null`. No downstream path branches, because none of them were genome-specific in the
first place — coordinates, the matrix read, aggregation to contig level and the pixel scan are all
bin arithmetic over `indexes/chrom_offset` and contig lengths, which both formats carry.

*This replaces the earlier synthesis design* (a one-row `/genomes` table named from the assembly,
every contig at `genome_id = 0`, `genome_offset = [0, n_contigs]`). Synthesis was the same work done
dishonestly: it put a row in the UI that is not in the file, it had to bypass the `/chroms`
soft-link check anyway, and it left a `synthesised` flag every view had to special-case. The absence
of a genome layer is a fact about the file, and the reader says so.

**Whole-genome where it fits, measured rather than assumed.** The old rule was *region level only*,
on the grounds that a eukaryotic cooler reintroduces the streaming problem §2 avoids. That is true of
a human cooler and false of the genomes this viewer is most often pointed at: yeast is 12.1 Mb, which
at 1 kb bins is 12,100 bins — one bounded read, about 600 MB on screen, and the single most useful
picture of the file. Refusing it would be refusing the case cool support is *for*.

So the size question is asked instead. `readDenseMatrix` estimates what a block costs — its cells,
the file's own `nnz` for the percentile buffer, and a raster pooled to a fixed ceiling — and compares
that to a budget derived from `navigator.deviceMemory`. Whole-genome is offered whenever the estimate
fits, and refused with the numbers when it does not; contig level always fits and is one control away
in the same view. Concretely:

- the entry point is the **contigs table**, not the genomes table, because there are no genomes;
  the genomes table and the whole-genome view are not offered at all for these files
- a region selection (`chrom` or `chrom:start-end`) loads and renders normally, using the same
  bounded-read path as a MAG
- the whole matrix is a view of its own (`view=whole`), offered in the root menu beside the
  chromosomes table. It is one bounded read, not a scan: the genome-wide view of a *metagenome*
  (§7.3) still costs a full pixel pass, because summing genome pairs has no index to shortcut
- the vocabulary follows the file: a cooler's sequences are **chromosomes**, and the genomes table is
  shown greyed out with the reason rather than hidden, so "does this viewer have one" is answered
  rather than raised
- whole-genome and whole-chromosome selections are size-guarded. Two guards, in order:
  `DENSE_MATRIX_BIN_LIMIT` with the CLI's own wording, and then a browser-side *estimate against a
  budget* — the dense values at 4 B per cell, the raster at 16 B per pooled pixel (a constant
  ceiling, since it is pooled at `RASTER_MAX_DIM`), and one bounded read window. There is no
  per-`nnz` term, because the pixel read is windowed rather than whole. The budget comes from
  `navigator.deviceMemory`, which is Chromium-only and capped at 8 — so it is a *warning* threshold
  rather than a wall: a browser-side refusal offers "load anyway" with the number, and the
  allocation itself is what actually decides, translating a `RangeError` into the same typed
  refusal. Human chr1 at 5 kb (49,792 bins, 2.5e9 cells, ~10 GB) is the case the second guard exists
  for; a whole yeast genome at 500 bp (24,322 bins, ~2.7 GB) is the case it must *not* refuse on a
  machine that can hold it
- `.mcool` resolution levels are each fixed-bin, so §3.3's arithmetic applies unchanged; the levels
  drive the zoom control exactly as mmetacool entries do — a settled zoom reads from the coarsest
  rung whose bins still fill a cell, which is fewer stored pixels for the same picture *and* the
  only honest way to draw a balanced map at a coarse grid, since `zoomify --balance` re-balances
  each level from raw counts and summing a fine level does not (§6.4). Bin indices are not
  comparable between levels, so windows cross through base pairs, per contig. The reader still holds
  one map *open*; the rungs a zoom touches are opened beside it over the same mounted bytes and
  released with the session. An `.mcool` addressed at its **root** is
  refused with `mcool-root`, naming its resolutions — the mirror of `mmetacool-root` — and the app
  opens the finest of them, as it does for a zoomify ladder

The app is therefore not a HiGlass replacement for standard Hi-C. Say so in the paper rather than let
a reviewer discover it: the claim is zero-install regional inspection of any cooler, plus a genome
hierarchy that HiGlass has no concept of.

---

## 10. Refusals and errors

Every refusal names the file's actual state and the concrete fix.

| Condition | Message |
|---|---|
| `contig-ordering != genome-then-length` | Name the actual ordering; state that the viewer requires genome-grouped layout; point to re-creating the file. **Known cost:** files built from a cooler (`cool` ordering) or a FASTA-ordered assembly are excluded, and those are plausible things for a user to have. |
| mmetacool opened at root | List available entries and the `::` syntax |
| `bin-type == "variable"` or `bin-size` null/missing | State that the viewer supports fixed-bin files only, and name the file's bin type. Fragment-level and contig-level metacools land here. Point to `metacooler binnify` as the route to a fixed-bin file. |
| Range or selection names `__unbinned__` | State that unassigned contigs are not a genome and cannot be displayed — distinct from the "unknown label" error, so the user learns the reason rather than doubting the name |
| `metacooler-format-version != 1` | State both versions |
| Dense selection too large | Enforce the same limit as Python: `DENSE_MATRIX_BIN_LIMIT = 50_000` bins per axis. Reuse the CLI's own hint wording ("use contig level", "narrow the range") |
| bigWig contigs don't match | Report the overlap count |
| Not HDF5 / HDF5 but not cooler | Distinguish the two |
| Range refers to unknown label | List genomes and contigs, truncated |
| Coordinate suffix on a genome name | State that genome ranges are whole-genome |
| Remote: ranges unsupported / CORS blocked | Distinguish the two; name the host |
| BAM with no index beside it | State that a BAM is read by region and has no whole-file fallback, name the sidecar to drop, and give `samtools index <file>`. Distinct from the row below: "there is no index" and "the index you gave me is not one" have different fixes (§8.13) |
| BAM whose index cannot be read | Name what went wrong reading it, and give `samtools index <file>` to re-make it |
| BAM not sorted by coordinate | Name the order it *is* in, state that reads are drawn by region, and give `samtools sort -o sorted.bam <file>` |
| CRAM | Refused for its own reason, not as collateral: it needs the exact reference its records were compressed against, which this viewer will not fetch from a third party (C1, C5). Give `samtools view -b`. **Today this row is only true of the folder listing**, which routes by name; a dropped `.cram` still falls down the text path and is refused as unreadable bytes |

---

## 11. Hosting and privacy

**Public files:** static objects on S3-compatible storage (Cloudflare R2 preferred for egress).
Requirements: `Accept-Ranges: bytes`; CORS permitting `GET` and `HEAD` and the `Range` header while
exposing `Content-Length` and `Content-Range`; `Content-Type: application/octet-stream`; long TTLs on
immutable versioned objects. A catalog JSON lists available files with the metadata needed to browse
without opening any of them.

**GEO and SRA cannot be hosts** — their download endpoints serve attachments without range or CORS
support. Such files are inputs to publication, never live sources.

**Remote HDF5** reads through Emscripten's `FS.createLazyFile` in a worker (h5wasm's `lazyFileLRU`
demo is the reference). h5wasm issues a `HEAD` before its `GET` to test range support, which breaks
presigned S3 URLs since those are single-method; plain public bucket URLs avoid this.

**Private files:** local drag-and-drop only. Identical code path, different byte source. Nothing is
uploaded, so there are no accounts, no storage, no hosting cost and no GDPR review. Stated
prominently in the UI and in the paper.

---

## 12. Performance budgets

Instrumented from the first commit and surfaced in a debug panel; these are also paper figures.

| Operation | Budget |
|---|---|
| Open + render genomes table (remote) | ≤ 20 range requests |
| Load one MAG's matrix (remote) | ≤ 5 range requests |
| Pan/zoom within the block in hand | 0 requests, 60 fps |
| Refine, on crossing the block's grid (§2) | ≤ 5 range requests, one bounded read |
| Pan to the edge of the block in hand | one read, **at the same resolution** |
| Zoom out to a block already read | 0 requests |
| Genome-pair block | ≤ 5 range requests |
| Time to interactive, cold, remote | ≤ 3 s on a typical connection |

And for an alignment lane (§8.13), where the open cost is separated from the window cost for the same
reason the table above separates opening a file from loading one MAG's matrix — a `.bai` for a human
WGS file is single-digit megabytes read once, and folding that into a per-window budget would hide
the cost it exists to police:

| Operation | Budget |
|---|---|
| Open a BAM: header + index | ≤ 3 range requests, **once for both rows** — the depth and the pile share one open handle and one parsed index — identify, header, index — and the index read is additionally reported in **bytes**, because a request count says nothing useful about a whole-file read. Three and not two: *is this a BAM* and *what is in its header* are one read (they are the same bytes, and asking twice was the first thing measuring this found), but the file's length is a request of its own on a source that must ask for it, and the index is a request of its own by construction |
| One alignment window | ≤ 5 coalesced range requests |
| Pan inside the window already fetched | 0 requests |
| Change a lane control | one window's reads again, and **0** for the depth row beside it — unless the change was the mapping-quality floor or the duplicate switch, which are the only two that alter a count and the only two written through to both rows. Joining mates costs **nothing**: it is drawn from columns the pile already carries. Depth is a count and does not care how the reads were coloured, which is why the two caches watch keys of different widths (§8.13) |
| A window above the byte cap | **0 data requests** — refused from the index alone, which is the whole point of forecasting before fetching |
| Colour the depth by variant | **0 extra requests** — the residues are read from a FASTA already open in the same worker, and never fetched for. It is bounded in CPU instead, by the sixteen-bases-per-pixel gate (§8.13) |

And for the analysis tasks (§18), where the first row is the one the whole threading design exists to
satisfy and is therefore the one that is tested first:

| Operation | Budget |
|---|---|
| **Any analysis task, effect on the view** | **0 dropped frames, 0 blocked reader requests** — pan and zoom stay live for the whole run, however long it is |
| Insulation / coverage / P(s), block already loaded | 0 range requests |
| Insulation, block not loaded (remote) | ≤ 5 range requests per contig |
| 4C, cis (remote) | ≤ 5 range requests |
| 4C, with trans | one streaming pass over pixels with `bin1 < anchor_end`; progress, cancel, and a pre-flight estimate before it starts |
| APA, k windows, local file | 0 network; ≤ k bounded reads after coalescing |
| APA, k windows, remote | ≤ 2 range requests per *coalesced* window, with the estimate shown before **Run** |
| Metaplot, k features | 0 matrix reads; ≤ 1 `sample` request per contig touched |
| Correlation / eigenvectors | 0 range requests beyond the block; refused above the bin-count gate (§18.6) |
| Adaptive smoothing of a block | 0 range requests; the arrays go over and back. Inline below 1 M cells (78 ms at 353²); on the analysis thread above it — 1.5 s at 4 M, 7.4 s at the 16 M cap. The map draws **unsmoothed** meanwhile, never blank and never captioned as smoothed |
| Analysis worker mount | opened on first use, never at session open |

If metadata reads explode, the known cause is walking HDF5's object hierarchy;
`hdf5-indexed-reader` addresses it with a pre-built path → offset index and was built for `.cndb`
chromatin files. Held in reserve — adopting it would not change any file format, only the reader.

---

## 13. Explicit non-features

Stated so they are decisions rather than omissions: tile server; user accounts; file upload; server-side
computation of any kind; required companion files **for a contact map** (§1 states the scope, and
§8.13 the one format that falls outside it: where an index is a format's only bounded read, its
absence is refused by name); required preprocessing; support for orderings other
than `genome-then-length`; whole-genome views that do not fit in memory (§9 — the limit is measured,
not a category); write access of any kind, in either target; an auto-update service; and a desktop
build with a feature set of its own — the package is a delivery mechanism, and the formats, views
and operations are the same in both targets.

**"Write access" means the app never modifies a file it opened**, and §18 makes that worth spelling
out rather than leaving to be inferred. The viewer has always *produced* files — a PNG, a PDF, a BED
of hand-drawn marks, a saved session — and §18 adds a bigWig to that list. All of them are new bytes
handed to the browser as a download; none of them touches the thing that was opened, and nothing about
them needs a server. The distinction is between authoring an output and editing an input, and only the
second is refused.

Four further non-features arrive with §18, for reasons given at §18.9: no loop or dot calling; no
contact-based contig reordering or scaffolding; **no writing of `.cool`, `.mcool` or `.metacool`** —
a decision rather than a limitation, since h5wasm could create one; and no differential APA.

Five more arrive with §8.13, each with its own reason rather than one shared one: no **mate
fetching** (one uncoalescable request per visible read, with no locality to coalesce on); no
**`SA` walk** — a split read's other pieces are drawn where the window already holds them, and
following the tag out of the window is the mate problem again under another name; no **variant
calling** (§18.9's argument about a half-good caller, which applies here with more force);
no **contact matrix derived from alignments** (the second application the original refusal was
drawing a line against); and no **CRAM** — which is refused on stronger ground than the others,
since it cannot be decoded without the exact reference its records name, fetched from a third-party
registry (C1, C5) or supplied as a second required file.

There is exactly **one** observable difference between them, and it is a host-compatibility
difference rather than a feature: the desktop build can ask a host not to compress, which a page is
forbidden from doing, so a file served with `Content-Encoding: gzip` opens there and is refused on
the website. See §15.

---

## 14. Resolved decisions

All three previously open questions are settled. Each removes code rather than adding it, which is
why the spec got shorter as it got more specific.

| Decision | Resolution | What it deletes |
|---|---|---|
| Variable-bin files | **Not supported.** Fixed-bin only (§3.3, §10) | The variable-width coordinate path throughout — and, as a second-order effect, every read of `/bins` |
| `__unbinned__` | **Never displayable** (§7.4) | The toggle, the guarded-open path, and the largest counter-example to §2's small-MAG assumption |
| cool / mcool | **Native; whole-genome where it fits** (§9) | The tiling architecture §2 exists to avoid — a block is one bounded read or it is refused, and it is never assembled from parts — and, since the reader went native, the synthesised one-genome table and the `synthesised` flag every view carried |

This row used to end *"a block either fits in one read or is refused, and there is no third path"*.
There is now a third path and it is worth naming, because it is not the one that was being refused:
a block that does not fit is read **coarser** (§7.2) and then read again, narrower and finer, as the
reader zooms into it (§2). Every one of those reads is a whole bounded block. What §2 deleted was
*assembling a picture out of tiles*, and that is still deleted.

The through-line: each answer protects the assumption in §2 that a unit of display fits in memory in
one bounded read. Variable bins broke the arithmetic, `__unbinned__` broke the size bound, and
whole-genome coolers broke both. With all three excluded, the invariant holds for every view the app
can reach — which is what makes a viewer with no tile server, no cache eviction and no progressive
rendering a defensible design rather than a compromise.

### Remaining judgement calls

Not blocking, but worth revisiting once something is on screen:

1. **The `genome-then-length` refusal (§10).** Clean, but it excludes files built via
   `create cool` (`cool` ordering) or from FASTA-ordered assemblies — plausible things for a user to
   have. Whether the error message alone is sufficient is a question for first users, not for now.
2. **The genome × genome overview (§7.3).** Gated rather than removed. If it turns out nobody waits
   for the scan, dropping it entirely would simplify the state model further.

---

## 15. Desktop target

The same bundle, packaged with Electron for machines that cannot reach the website. It is a second
invocation of the same bundler over the same source, never a change to the first: the web build is
what §1 constrains, and nothing here is allowed to alter it.

**The origin is frozen at `app://viewer`.** Everything the browser keys on an origin is keyed on
that string — `localStorage` (theme, per-file table state), the hash router's `history` entries, the
`Origin` header sent to remote hosts. Change it in a later release and every user's remembered
preferences disappear on upgrade with no error and no way to get them back.

**The renderer is served by a privileged standard scheme, never `file://`.** `app` is registered
before `whenReady` with `standard`, `secure`, `supportFetchAPI` and `stream`. `standard: true` is
what gives the page a real, non-opaque origin: without it `history.pushState` throws `SecurityError`
and the router dies on the first navigation into a genome. `file://` fails earlier and more quietly
— the module worker never constructs, so the app hangs on "Opening…" with nothing on the console.

**`allowServiceWorkers` is deliberately absent.** The desktop build has no offline story to tell,
because it is already on disk; §11's caching bargain buys nothing and costs a stale-build failure
mode. Three independent guards keep it out: the plugin is not in the desktop config so `sw.js` is
never emitted, `registerServiceWorker()` returns early off the web target, and Chromium refuses the
registration on an `app://` origin outright.

**`contextIsolation` and `sandbox` are on; `nodeIntegration` and `nodeIntegrationInWorker` are
off.** Not only for the usual reasons. `isNodeRuntime()` in the reader worker decides which h5wasm
filesystem path to take purely by whether `process` exists, so leaking Node into the worker sends
every open down the wrong path and it fails with a generic `not-hdf5` error, hundreds of frames from
the cause — and `mountTarget()` starts writing tens of megabytes into `TMPDIR` on the way.

**The CSP is delivered as a response header**, not a `<meta>` tag: a meta CSP does not reach a module
worker at all, and cannot express `frame-ancestors`. It keeps `'wasm-unsafe-eval'` — verified in both
directions; without it h5wasm fails to instantiate in both document and worker — and needs no
`'unsafe-inline'` for styles, because `el()` assigns through the CSSOM and the tree contains no
`innerHTML`, no `<style>` creation and no `style=` attribute.

**One request header is rewritten, and it is the target's only capability.** `Accept-Encoding` is a
forbidden header name in Fetch, so no page may set it; the main process may. Every http(s) request
goes out asking for `identity`. Measured: this changes nothing for ranged reads — Chromium already
sends `identity` whenever a `Range` header is present, because it cannot inflate a partial response
— and everything for the `HEAD` that `RemoteRangeSource.open()` probes with, which carries no range
and is otherwise answered compressed. The refusal that follows a compressed probe (§10,
`remote-compressed`) is correct and stays; the desktop build simply stops provoking it. No response
header is ever injected, and in particular no `Access-Control-Allow-Origin`: it could not make a
server produce partial content, and the `?edges=` sidecar fetch takes a user-supplied URL, which a
blanket injection would turn into a read-anything primitive.

**No path→bytes route.** Local files are read exactly as in the browser: a `File` from the drop, a
`Blob`, `FileReaderSync` in the worker. Routing the bytes through an IPC protocol handler was
measured at ~15× slower per read with a fixed ~3 ms floor per call, which is precisely what HDF5's
many-small-reads metadata walk punishes. If a local path is ever wanted, it is wanted as a *string*
for addressing, and the bytes stay on the Blob.

---

## 16. N maps side by side

Several contact maps on screen at once, navigating together — HiGlass's multi-view, arrived at from
this app's own constraints rather than ported from its architecture. There is no tile server and no
pyramid here (§2), so a panel is not a viewport onto a stream: it is a whole bounded block, held
whole, exactly as the single map already is. What N panels add is a **shared coordinate**, not a
shared cache.

The viewer already had two answers to "two files", and this is a third because neither of them
generalises. A **tab** (§5.6) is a whole second session with its own worker, tables, tracks and
address-bar entry, and only one is on screen at a time — it answers *open*, not *compare*. The
**lower-left triangle** (§5.7) is two files in one square, which is the strongest comparison
available and is why it is gated on a matching bin size and a matching chromosome list. Both survive
untouched, and a session may hold a blended square *and* a deck: they are different claims, and both
can be true of one screen.

### 16.1 The panel model

A deck is a **lead** and its **companions**.

The lead is the session's own file. It owns the breadcrumb, the genomes and contigs tables, the
tracks, the record card and, where there is one, the second file blended into its lower triangle. It
is not in the companion list and it is not reorderable, because "which file is this session of" is
not a thing that should change by dragging.

A companion is the smallest thing that is still a map: its own `ReaderClient` — so its own worker, its
own h5wasm instance, its own I/O — its own colour scale, its own block, and a heading with its name
on it. It has no annotations, no level toggle, no score picker and no second file. Each of those is a
control over something the deck *shares*, and five copies of a shared control are five ways to put
the deck out of step with itself.

The lead's element is **re-parented** into the first cell of the grid rather than rebuilt, so a
session with companions costs the session it would have been, plus the companions.

### 16.2 What is shared, and what is not

| | Shared | Per panel |
|---|---|---|
| Which region, genome, pair or selection | yes | |
| Aggregation level (`bin` / `contig`) | yes | |
| Score column and balancing | yes | |
| Derived values and the 45° turn (§7.5) | yes | |
| Pan and zoom | yes (§16.3) | opt out |
| Which rung of a collection (§3.4) | seeded from the lead, then the zoom's | yes |
| Transform and colormap | seeded from the lead | yes |
| `vmin` / `vmax` | opt in | yes |

The rule is: **what is being looked at** is shared, **how it is drawn** is not.

A rung is now *also* what a zoom reads from (§2), which does not change the row above but sharpens
it: the picker still names the map a panel is **addressed** as, the link still carries it, and a
reader who touches it has said something the zoom does not overrule. Concretely, **the rung that is
open is the finest one a zoom may use.** Somebody who opened the 2 kb level of a
`100/200/500/1000/2000/5000` file has said *2 kb*; a zoom that fetched the 100 bp level would be
overruling them with their own file. Coarser rungs are still the zoom's to choose, that being the
direction the picker did not rule on. What the zoom chooses is which level
answers one bounded read, and that is a fact about a picture rather than about an address.

**Resolution is the one thing on the shared side of that line that cannot be shared**, and it is why
the lock's currency is base pairs (§16.3). That is also what lets panels refine independently: five
maps each reading their own window at their own grid stay in step, because the lock was never
counting cells. Two files rarely have the same ladder, so a deck lands an
`.mcool` on the lead's bin size where that rung exists and on its finest otherwise — the right guess,
and only a guess: the rung that makes a comparison legible is not always the one that matches a
number. So the entry is a picker, as the `::1000` beside the companion's name, and the choice is
written into that panel's own address rather than held beside it. That is what makes it stick: the
map reopens at the rung the reader chose after every navigation, every change of chromosome, and
through the link.

The derivations sit on the shared side of it and the turn sits beside them, which is the rule read
carefully rather than an exception to it. A normalisation, an O/E baseline and a 45° rotation each
change what the numbers *are* or what shape they are in, so one panel drawing O/E beside four
drawing raw counts is four wrong comparisons rather than a choice, and a lead drawn as a band along
its diagonal beside four squares is five pictures in two coordinate systems under a bar claiming one
navigation. Each is applied by every panel and offered by exactly one: a companion is handed the
setting without the handler, so it draws the same thing and carries no second copy of the control.

The selection has to be shared, or a deck showing four files at four regions is four unrelated
pictures that happen to be adjacent. It is shared **by name** — `chrI:20,000-80,000`, `MAG_7`, a list
of ticked sequences — and each companion resolves the name through its own reader. That is what makes
the feature affordable, and it is also what makes its failures well worded: a file with no `chrI` is
refused by `parse_metacooler_range`'s own error, listing its own sequences (§5.4). No gate had to be
written for that case and none could have phrased it better.

The score is shared as a **resolved choice**, not as the hash key that named it. The resolution runs
through the *file's* default as every view's own picker does — read straight from the state it said
`count` for a map whose picker said `balanced`, which cost nothing while the only callers wanted a
column and a normalisation and cost a whole quantity the moment a deck asked what to share. A
companion is told the answer *and* whether it is balanced: under `log10` a balanced cell is
negative, and the automatic range keeps negatives only when it is told the matrix is balanced — a
companion that was not drew a blank rectangle over perfectly good data. A file somebody
balanced opens balanced and that default is nowhere in the URL, so two panels each applying their
own default disagreed silently — a balanced lead beside a companion drawing raw counts, under a bar
saying the score is one of the things a deck shares. Each panel still resolves the id against its
*own* columns, so a file that cannot serve it falls back to counts rather than to a read it has no
answer for.

A companion **opens on the lead's scale, clip included**: a map put beside another is put there to
be compared with it. The exception is that fallback — a panel drawing counts because it has no
weights must not inherit a clip measured in balanced units, which would draw a perfectly good map as
a black rectangle. There it takes the transform and the ramp and finds its own bounds.

The clip is still the panel's own from then on. `vmax` is a number of contacts, and two libraries sequenced to
different depths do not have the same one — one clip across a deck draws the shallower file as an
empty rectangle. This is §5.7's argument reached from the other side: there, one grid forces one
scale and the second file is rescaled onto it with **match depth**; here, two grids allow two scales,
and the reader opts *in* to sharing with **one scale**, off by default because it is the stronger
claim.

### 16.3 The navigation lock

The currency is **base pairs**, measured from each block's own start, and not matrix cells.

That is the whole of why panels can be honestly locked where triangles cannot. A 1 kb file and a 5 kb
file both answer `chrI:20,000-80,000`; the answers are 60 cells and 12. A lock in cells moves the
coarse panel five times too far, and would have to be gated on a matching bin size — which is exactly
§5.7's refusal, reintroduced for no reason. A lock in base pairs is one division and one
multiplication per axis at each end.

Conversion **rounds outward**: a window landing between two coarse cells becomes the smallest cell
window containing it, so a coarse panel shows at least what was asked for and never less. A window
running off the end of a shorter block is **slid back inside it, keeping its span**, not truncated to
whatever overlaps — truncating would answer a 40 kb view with a one-bin view, which is a wildly
different zoom in a deck whose whole promise is that the panels are showing the same thing. It is the
rule `HeatmapView.clampView` already follows for a pan against the edge of one map.

Both ends of the conversion read the grid **actually drawn**, which on a turned map (§16.2) is the
band and not the square it was rotated out of. A rotated cell is half a bin on both axes, and the
band is `2n − 1` columns wide; answering with the square's bin size and the square's column count
while reporting the band's window converts a whole-band view into twice the base pairs it covers and
then clamps it back to half the columns at the far end — every turned panel of a deck showing half of
what the one beside it shows. Up the side a turned panel's cells are half-bins of *separation*, so
two turned panels lock to each other in distance from the diagonal, which is the only thing they
could honestly share there.

There is one owner. Panels never speak to each other: each reports where it is and the lock decides.
With N panels each echoing to N−1 others there are N² conversations and no frame in which the deck is
in one state.

The feedback loop is real and is guarded three ways, because an echo has three shapes. A panel moved
programmatically redraws, and redrawing is how a panel reports — so every push returns as a report
one frame later, quantised to the receiving panel's grid and possibly slid inside its block.

1. The **synchronous** echo is swallowed by a flag held for the length of one broadcast.
2. A pushed panel is owed exactly **one** report and that report is thrown away. This is what stops a
   panel that *slid* from becoming the driver — without it, panning the lead past the end of the
   shortest companion's contig drags the lead back to where that companion stopped, which turns "pan
   past the end of the short one" into "you cannot pan past the end of the short one", in a deck
   assembled precisely because the files are not identical.
3. Anything arriving later at what is, to within **half a cell of the reporting panel**, the window
   already broadcast is swallowed as the same window seen through that panel's quantisation — a
   resize, a re-fit, a second frame of one gesture.

Without (3) a two-resolution deck drifts one coarse cell per frame until it hits a wall.

Any panel may be taken off the lead individually, the lead included.

### 16.4 The compatibility gate, and why it is weaker

`compareRefusal` (§5.7) refuses a genome layer, a different bin size and a different chromosome list.
Each names a way the *blended* picture would be a lie. Side by side, two of the three objections
evaporate: two grids may be two resolutions, and each panel indexes its own list of sequences.

What is left is the one claim panels actually make — *these two pictures are of the same place* — and
it is checked against the **blocks that came back**, not against the files. Two panels that resolved
one name to spans of different length resolved it against different sequences, whatever the name
says, and a shared window between them would be two places. The tolerance is one cell of the coarser
panel, because the last bin of a contig may be short (§3.3) and a stricter test would refuse every
honest pair whose bin size does not divide the contig.

A **turned** deck (§16.2) has a second way to disagree, and it is a different fact. Up the side of a
band is distance from the diagonal, and how far a map opens up it is a fraction of its own block
rounded to a whole bin — so two files at different resolutions turn to different depths, and one row
window between them would be two distances. That refusal is about the *bands* and not about the
sequences, and it is worded as such: borrowing the sentence above would tell a reader their files
resolved one name against different sequences when they did not, which is a claim they may act on.
It goes away when the deck is turned back off.

A panel the gate refuses is **still shown**, still readable and still exportable. Only the lock is
off, and the panel says so in a line under its own heading rather than only in a tooltip on a chain
icon — a lock that claims to be closed while the deck skips it is the one way this can be quietly
wrong, and a still map reads as data.

### 16.5 Layout, and the three side panels

The panels are a CSS grid of equal columns, as many across as the reader asked for — with a `+` on an
edge (§16.9) or with the picker in the deck's bar. Equal always: a comparison whose halves are
different sizes is one the eye has to correct for.

**The session's heading leaves the first cell.** The view's title, its locus box, its back link and
its block summary answer *what am I looking at*, which is one question however many pictures are on
screen — so in a deck they are hoisted above the grid and cell 0 holds the map and its file name,
exactly as every other cell does. Left inside, they made the first cell a head taller than the
others and the first map was drawn smaller than the maps it is there to be compared with. The
element is **moved**, not rebuilt, so the box keeps its caret and the summary keeps the numbers the
last read wrote into it; it goes back when the deck is put down.

The deck's own count rides on the end of that summary — `113 × 113 bins · … · 3 maps` — because how
many maps is a fact about what is being looked at, and the line that already says that is where a
reader is looking. Not in the bar, which is controls.

**The maps are aligned to the pixel, tracks or no tracks.** A companion carries no lanes of its own
(§16.8), so the room the lead's stacks take is *reserved* on every panel beside it, and each panel's
picture is pushed to the foot of its cell — the cells being equal, the plots are then the same size
at the same height whatever heading sits above them. Without it a map inset by a stack of tracks
stood beside a map that was not, which is a comparison the eye has to correct for before it can
begin, in the one widget whose entire purpose is that adjacent pictures are comparable.

**Rearranging is a drag, not a pair of arrows.** Every panel has a grip before its name; taking hold
of one shows the tiling, and dropping a map on a cell **exchanges** the two. `◀` `▶` could only say
*one place along a list*, which describes a 2 × 2 poorly: moving the bottom-left map to the top-right
was three presses, each shuffling everything in between. The lead has a name like every other cell
and **no grip** — it is the session's own view re-parented into cell 0, and which file a session is
of is not a thing that should change by dragging.

The deck's bar holds only what is shared: the master chain, one scale for all, how many across, and
the whole deck as one figure — saved, or copied to the clipboard, which is what `⌘C` reaches while a
deck is on. Adding a map is the `+` on an edge and rearranging is the grip, so neither is a button
here — a bar that repeats what the pictures already offer is a second place to look for the same
thing.

It is **read from the left**, in one run, with exactly one control across the gap at the far right:
the × that closes the deck. Everything else in the bar adjusts a deck that is staying, and a
destructive control in among them is one a hand reaches by accident; a window's close has been at
that end for thirty years. What it closes is every companion **and every track that was only there
for them** — a bigWig dropped on a companion's edge is an import into the session's one track list,
so closing the maps it was drawn on would otherwise leave it loaded, invisible, and holding a row
that says it is drawn nowhere. A track that is also on the first map is being read against a
picture that is staying, so it keeps its lane there and loses only the companions'. The first map is
untouched throughout: closing the deck leaves exactly what closing the last companion one at a time
would.

A companion's scale controls ride **on its picture**: a button in the bottom-left corner of the map,
opening a menu upward over it, holding the five fields that say what the numbers are and how they
are drawn — the score, the baseline, the transform, the ramp and the clip. Not the overlay marks,
which act on a picture the reader is already pointing at and are slower to reach through a menu than
through the row they came from; and not an export, which the deck's bar now offers for all of them
at once. A fold *under* each panel — what this replaces — pushed every other panel of the deck down
by the height of whatever was open in it.

The deck's controls ride **above the grid**, and each panel's scale controls ride **inside that panel**.
They are deliberately not a fourth card in the three side columns. Those columns are the *session's*
furniture and each describes the one file the session is of; and one of them — Annotations — does not
exist at all on a file with a genome layer (§8.5), which is exactly the kind of file a deck is most
useful for, so a deck control living there would be missing precisely where it is wanted. The chosen
placement is also the plainest statement of §16.2's split: shared controls above the grid, per-panel
controls on the picture they control.

The grid is inside `.content`, which pins the light palette for its whole subtree, so the maps do not
change colour in the dark theme and no rule had to be written to keep them from it.

### 16.6 Links

One key, `maps`, holding the companions in order.

Pipe-separated, not comma-separated like `genomes` and `regions`. A comma is legal in a URI path, so
`maps=a,b` resolves — to two maps that are neither of the ones that were sent — the first time
somebody publishes `sample,rep1.cool`. RFC 3986 excludes `|` from every part of a URI, so the split
cannot be wrong. It is left unescaped in the hash for the reason the comma is: `maps=a.cool|b.cool`
is a list at a glance and `maps=a.cool%7Cb.cool` is not.

A **local** companion is written as `~`, not omitted. `uri2` omits its local second file, which is
right when there is one slot: its absence says *nothing here*, which is true. With N slots omission
moves every companion after it one place to the left, so a deck of `[remote, local, remote]` arrives
as a deck of two with nothing anywhere saying a map is missing. The placeholder keeps the count and
the order, and the recipient gets a drop rectangle where the sender's file was. A cell the sender
drew empty (§16.9) is the same `~` and travels the same way, so an arrangement nobody has filled yet
is a link like any other.

`maps` **survives a navigation within one file**, and so does `uri2`. A navigation builds a fresh
state — `{ uri, view: 'contigs' }` and nothing else — which is right for the region, the genome, the
level and the pair, and wrong for the two keys that name what is on screen *beside* the view.
Without carrying them, clicking Chromosomes and then a contig, the plainest way there is to look at
another chromosome, arrived with no `maps`: the deck reconciled itself to nothing and released its
workers on the way past a table. Same file **by path**, so changing the resolution keeps the deck
and opening a different file does not. The carrying is the session's and not the store's — the
address bar is obeyed exactly as written, or a pasted link would show a deck nobody sent.

Nothing else is in the hash. The lock, the drawn column count and "one scale" live in the
per-file session memory (§8.6) beside the table filters, on the same grounds: the hash has never
carried a pan or a zoom, so there is nothing there for a lock to be consistent with, and how many
columns the grid has is furniture in the sense the width of a side panel is. Which cells are empty is
*not* furniture and is in the hash, because it is part of the list of maps rather than part of how
they are arranged — a deck of three with a gap in the middle is a different deck from a deck of
three.

### 16.7 Cost

`checkBrowserDenseSize` budgets **one** block against a share of what the device reports, and has no
idea how many blocks are about to be live. Five whole-genome coolers are five dense blocks, five
rasters and five pooled buffers, all resident, each passing a guard that was asked about one.

So the deck divides. Every panel is read with `budgetBytes` set to the deck's whole allowance — one
panel's — divided by the number of panels. Two consequences, both wanted: a deck can never cost more
than the single map it replaced, and **every map added shrinks every panel's share**, so an
over-large deck is refused by arithmetic rather than by a limit somebody had to guess. The refusal is
`checkBrowserDenseSize`'s own, with its own numbers in it, printed beside the panel it is about.

A hard ceiling of **six panels including the lead** sits above that, for the reason `MAX_SESSIONS`
has one: a panel is a worker and an h5wasm instance whether or not its block is large.

### 16.8 What is not offered

A companion answers views that name a **place** — a region, a genome, a pair, a selection, the whole
file. The two tables and the whole-metagenome scan (§7.3) are pictures of a *file*, and a second
file's genomes table is not this one with more rows in it. "Add a map" is disabled there rather than
hidden, so the answer to "can this viewer do that" is *yes, from a map*.

A companion **does** carry tracks, and that is a change from what this section used to say. §8's
contig-naming contract is between a track and one file's `/contigs`, and the reason a lane beside a
companion looked like a fourth thing keyed on a third assembly is that the *track* and the *lane*
were one object. They are two now (§17.4): a track is the import and the style true of it
everywhere, a lane is one placement of it on one map. There is still exactly one list of tracks and
one contig contract; what a deck adds is where each of them is drawn.

Which forces one rule on the layout. **Every map leaves room for the deepest stack on each edge**,
whichever map has it, and pads out the difference between that and its own. Without it a map with a
strip above it stands lower than a map without one, and two pictures of one place have to be
corrected for before they can be read against each other — which is the whole thing a deck is for.
The figure is asked of every panel at the moment it is used rather than accumulated as the panels
report: they announce their stacks in whatever order they finish reading, and a running maximum is a
maximum over whoever has spoken so far.

### 16.9 Drawing the deck

A `+` down the right-hand edge of the map, and another along the bottom. Pressing one opens a
**cell**, not a map: what comes back is the arrangement the reader asked for, with their own map in
the first of it and every other cell standing empty as a drop target. The empty cells are filled in
any order, from a drop, a file chooser or a URL, or never.

This is the feature's only entry point that a reader can *find*. Before it, the first companion was
reachable only through the command palette, so nothing on screen said several maps side by side was
a thing this viewer did — and the one gesture a reader would try, dropping a second cooler on the
map, means *load a track* (§8.3).

**Cells before maps, and that is the design rather than an ordering.** Adding maps one at a time
makes the arrangement a consequence of the order the files arrived in, and the arrangement is what
somebody assembling a figure is composing: two conditions across and two timepoints down is a
statement about the experiment, and reaching it by dropping four files into a row and then pressing
`◀` twice is repairing a layout rather than drawing one. So the shape is drawn first and is a thing
the reader states, not a thing that happens to them.

**The shape is a rectangle, filled in reading order.** `+` beside adds a column, `+` below adds a
row, and both add the whole edge — a single extra cell on the right of a two-row grid is not
expressible without pushing every map after it one place along, and a press must never move a map
that has already been placed. A ragged last row, which is what closing a map out of the middle
leaves, is squared up by the next press for the same reason: the holes are drop targets and the
rectangle is the shape that was drawn.

The column count a `+` sets is remembered per file beside the layout presets (§8.6) and **overrides
them**. The two answer different questions — a preset arranges however many maps are here, a drawn
count says what shape the deck is — and a deck that reflowed into a row the moment a map was closed
would not be an arrangement at all. Exactly one of the two is in force, so a lit preset never
disagrees with the grid.

**An empty cell is a real cell.** It takes a slot in `maps`, travels through a link as `~`, counts
towards the six-panel ceiling, and can be moved and closed like any other. It does **not** count
towards the memory budget (§16.7): an empty card has no worker and no block, and dividing the
allowance by it would read the two maps of a 2 × 2 deck at a quarter each while half went to
rectangles.

The `~` it is written with is the same one §16.6 introduced for a local companion, and the two are
deliberately not told apart in the hash: to the recipient they are the same thing, a position with
no file in it and a rectangle where the map goes. Within the session that drew them they are told
apart in words only — a cell a reader drew says *drop a map here*, and one a link left says a map
was here — because telling somebody a map used to be in a cell they drew empty a moment ago is a
small lie about their own deck.

A **collection** dropped into a cell opens one of its maps rather than refusing. An `.mcool` is a
ladder of complete coolers and is not a map at its root (§3.4), so opening one by name is an error
about `::` syntax the reader never typed, standing where their picture should be. The rung to land
on is the **lead's bin size**: two files with the same ladder are comparable at any of them, and the
finest-regardless rule would put a 1 kb map beside a 16 kb one and call it a comparison. What was
opened is written back into `maps`, so the link names the map rather than the collection — resolved
against a recipient's own lead it could otherwise be a different rung.

A file **dropped on an edge** opens the cell that edge names and fills it in one movement, which is
the gesture a reader tries first. It goes into the first cell that press opened rather than the
first empty cell in the deck: the two differ only when the deck already had a hole somewhere, and
there the aim is the tie-breaker. A map arriving by any other road — the bar's URL box, the file
chooser, the command palette — takes the first empty cell instead, because those name no position
and the empty cells are the reader's own instruction about where the next map goes.

### 16.10 Naming the maps

A map is labelled by its file, which is the right default and a poor name for the work: four
replicates of one experiment are four labels differing in a digit, and two conditions being compared
are `mat_G1.mcool::1000` and `mat_G2M.mcool::1000`, whose two informative characters are the last
thing anybody reads. So **any map a session is holding can be called something** — the one it is of,
the one it is compared against (§5.7), and every companion of a deck. The control is the Tracks
card's own, in both places it appears: an `<input>` that looks like text until it has the caret, on
the **Contact maps** card and on a deck cell's heading. Enter commits, Escape abandons, and an empty
box hands the map back to its file name, which is what makes a rename undoable.

The name is used **everywhere the map is named**, through one function: the card that lists it, the
heading over its cell, the two bands of a turned comparison (§17.2), the readout and the tooltip
under the pointer, the derived label on a ratio, and the caption on an exported figure. A rename is
not a rebuild — it changes what the picture is called and nothing about what is in it, and rebuilding
the view would put a gated whole-genome scan (§7.3) back behind its button.

Three things about where the name lives:

- **One record per session, not one note per file.** Every name sits under the session's own memory
  key, keyed by the file each one is for — `deck:looks`'s arrangement, and for its reason: a
  workspace is gathered from one key, so a name filed under a companion's own key would be a name
  the saved session did not contain. It travels in the workspace, in the durable record and in a
  share link, beside the tab's own name.
- **Keyed by the file, never by the rung**, so a name survives a change of resolution the way every
  other per-file fact does (§5.5). One consequence, which the deck's saved looks already had: one
  file open twice in a session has one name.
- **An empty name is not a name.** It is dropped rather than stored, so a map with no name is a map
  the record says nothing about — and a config that says nothing leaves the importing tab's names
  alone.

## 17. The turn: 45°, distance up the side

A contact map is symmetric about its diagonal, and the diagonal is where all the signal is. So a
square map spends most of its area on the far corners, which are empty, and draws the part anybody
is reading as a thin bright band across the middle. Turning it puts that band along the bottom of a
rectangle and gives the whole picture to it.

Two things follow, and the second is the real reason to do it. A domain becomes a **triangle
standing on the axis** and a loop becomes a **dot at the height of its own span**, both far easier
to see than a square-cornered block and a dot off the diagonal. And the x axis becomes *genomic
position* — the same axis a track is drawn against. A coverage profile under a square map lines up
with one edge of it; under a turned map it lines up with the picture. That is what every published
Hi-C figure is doing, and it is what §8.4's one coordinate model was already built for.

### 17.1 The geometry, and what it fixes

A cell `(b1, b2)` goes to `x = (b1 + b2) / 2` and `y = (b2 - b1) / 2`, both in bins, both drawn at
the same bases per pixel. A **true rotation**: nothing is stretched, a domain's two edges meet at a
right angle over its midpoint, and a base pair measured up the side is the same length as one
measured along the bottom.

The consequence to hold on to is that **height is half of separation**. A contact between two bins
100 kb apart sits 50 kb above the axis. The y axis is therefore *labelled* in separation, which is
the question a reader is asking, while the coordinate underneath it is half that. Stretching the
picture to make the two agree is the alternative and it is worse: it would put a domain's edges at
63° and make a base pair up the side shorter than one along the bottom, so nothing could be measured
off the plot with one ruler.

**The lattice is half-bin.** `b1 + b2` and `b2 - b1` always share parity, so the rotated grid is a
checkerboard with half its positions empty. Filling only those and interpolating blurs; drawing each
source cell as a diamond costs a path per cell. Instead each source cell fills **two adjacent
columns**, which makes the output dense, uniform, square-celled and exact to within the half bin it
is drawn at — and an ordinary uniform matrix, so pooling, colouring, pan, zoom, clip, the colourbar
and export are all the code they always were.

**The corners are empty, and that is honest.** A cell at the far left of the window and high up
needs a partner off the left-hand end of the block, which was never read. Those two corner triangles
come back `NaN` and draw as paper. Reading wider than the window would fill them and is the obvious
later improvement; nothing pretends they are zeros.

### 17.2 Where it is offered, and the box it is drawn in

Only on a block that **has a diagonal**: the two axes must cover the same bins, it must be one
sequence, and it must be at bin level. Each is the same condition from a different side — distance
from the diagonal is the whole of the y axis, so a block without one has no picture to make, and
"the distance across a boundary between two sequences" is not a distance. The toggle is **greyed
rather than hidden** where this is false, so a reader looking at a whole metagenome can see that the
control exists and find out what it wants of them.

**And wherever it is offered it is on**, which is `flip` being absent meaning turned and only an
explicit `false` meaning square (§11). A block with a diagonal is a band along a genomic axis with
tracks under it — that is what a contact map is *for* at this scale, and it is what every published
figure of one looks like; the square is the special view, wanted for looking at the far corners and
for reading a two-file comparison as one asymmetric square. The hash of an ordinary view stays short because only
the reader's "no" is written down, and a link with no `flip` in it opens the way this viewer opens.

A block with no diagonal draws square and **writes nothing back**. Recording the refusal would let a
metagenome a reader passed through switch the turn off for every map after it, which is a preference
edited by a navigation.

**The turn survives a navigation**, and that is the other half of it being a preference rather than a
fact about the block. Opening a region by dragging a box on the map, or clicking through Chromosomes
to another sequence, builds a fresh state; left to that, the band a reader had just shaped came back
as a square every time they went to look at something in it — which is the gesture a turned map is
for. It is carried across a navigation of the same file exactly as the deck and the second file are
(`READING_KEYS`, beside §16's `COMPANION_KEYS`), with the same exception: a state that has said
`false` is believed.

**A turned map is a rectangle of a size the reader chose.** Its height and its width are set by
dragging its own edges — a bar along the top, and one at each end — and neither moves when the map is
zoomed. What the zoom changes is what is *inside* the box: more or less genome across, more or less
distance up.

That is the whole of what the turn is for, and the alternative is what this used to do. A band was
fitted like any other matrix, on whichever axis was tighter, so its height was `depth × zoom` and
zooming in grew it until it filled the panel — at which point the picture is a square map again, with
the far corners the turn exists to throw away back on screen. A band that stops being a band as soon
as anybody looks closely is not a presentation, it is a starting position.

So **how far from the diagonal the band reaches follows the zoom** rather than being the number the
reader sets. The box is so many pixels tall, a cell is so many pixels, and the deepest contact on
screen is the quotient — which is also the honest reading: zoom in and you are looking at a shorter
stretch of genome, so the distances that fit above it are shorter too.

**A band deeper than the box is the same picture**, and that is what the re-cut costs almost nothing.
The band stands on the box's floor at every zoom, so rows past the top edge are clipped by the rule
that already clips the columns past either end: the rows on screen are the same rows either way. So
the band is re-cut only when it is too *shallow* — which is to say only on the way out. Zooming in
asks for less distance at every notch and is answered by the picture already drawn, where re-cutting
per notch is a rotation and a fresh pooling of the whole band per wheel event. It holds for a mirrored
pair too, and only because that pair is pinned by its middle rather than by an edge: the surplus is
then clipped equally from both, so the two bands show the same depth at every zoom.

And when it is too shallow it is cut **deeper than asked**, twice over, bounded by the block. Zooming
out is a gesture rather than a step; buying twice the distance the box wants right now is one
rotation instead of the several the rest of the gesture would have asked for. Not on a mirrored pair,
where the spare rows are not spare: one band stands on the box's floor and the rows past the top edge
are clipped, while two stand on the fold between them, so buying twice the depth pushes that fold —
and the whole of the first file with it — off the top of the picture.

The **colour scale is not re-measured** by a re-cut, and this is the other half of the same
sentence. The range is the square block's (§17.6) and measuring it is a pooling and a percentile
selection over that whole block — the most expensive thing the renderer does. The block a band is cut
from does not change when the cut does, so the measurement survives the reshape. Dropping it on every
re-cut, which is what a general-purpose "the matrix changed" invalidation does, spent four fifths of
every zoom on a turned map proving the colours were the colours they already were.

The box opens **as wide as the panel allows and a quarter as tall**, which is the shape of the
figures this is a viewer for. A whole triangle is exactly twice as wide as it is tall — that is what
the half-bin lattice makes it — so a quarter shows half the separation the block holds at the fitted
zoom: enough band for a domain to be a triangle rather than a smear, and short enough that the
picture still reads as one strip along the genome rather than as a map. A fraction of the width rather than a
distance in base pairs, deliberately: a default of "500 kb" is most of a bacterial chromosome and a
rounding error on a human one, and this viewer opens on both.

**The box is the session's, not the panel's**, and it outlives every navigation. A change of
resolution, a click on another chromosome, a zoom that opens a region — each of those destroys the
panel and builds another, so a box held as a field on one is a box the reader loses the first time
they go and look at something in it, which is the gesture shaping a band is *for*. It is a store, on
`ui/viewpoint.ts`'s rule and for `ui/viewpoint.ts`'s reason. Shared as well as remembered: the turn
is the deck's rather than one map's (§17.3), and a deck of bands at four heights is not a comparison.

What is stored is what the reader dragged, and it is fitted to each panel **on the way out** rather
than clamped on the way in. The panels drawing from it need not have the same room — a deck of four
is four narrower panels — and a window can be made narrow and wide again; a box clamped into storage
would lose the reader's number the first time it did not fit, where one clamped on the way out comes
back with the room. An untouched axis is stored as *nothing*, not as a number, because its default is
a rule — the panel's own width, and a third of it — and "as wide as there is room for" cannot be
written down as a width.

**What bounds the box is the room the panel has**, and it is measured against the panel rather than
against the grid the box sits in. The grid is sized by its contents, so a box narrowed by a drag
narrows the grid with it, and a ceiling read from there is a ceiling that follows the box down: every
drag inwards lowers the limit to wherever the edge has just got to, and the width can be given away
and never taken back. The room is the panel's own width less the stacks of tracks beside the map, and
the height a square map would have claimed — both facts that do not move when the box does.

**Both ends widen the box about its middle.** Two handles rather than one, because the box is
centred: with a single handle the reader has to know which end the app decided to grow from, and
either answer is wrong half the time. The edge under the pointer stays under it and the far one goes
out by the same amount — and the tracks follow, since a stack takes its width from the map's canvas
and a box that narrowed only the map would leave every track pointing at the wrong base pair.

**No height is reserved for the square**, and that is a decision that changed with the default. The
panel used to be held open at the height a square map would have taken so that flipping did not
resize it; a turned map is now what a block with a diagonal opens as, so reserving a square's height
means every ordinary view carries a screenful of paper above a band a quarter as tall — room kept for
the exception. The panel is as tall as its picture, and it is *squaring* the map that grows it. The
assembly is still centred across the column, where the box really can be narrower than the room.

There is nothing to align to the bottom either: a band fills its box by construction, so the diagonal
is on the box's own floor at every zoom — and there is no vertical pan at all, because a band dragged
off its own diagonal has lost the axis it is measured from.

**A two-file split is turned into two bands, not one** (§5.7). The square holds the first file above
the matrix diagonal and the second below it, and a turn that kept only the upper triangle would throw
away the entire reason the picture is split. Mirrored, the pair meets at **one shared genomic axis**:
the same position is the same column in both, the first file grows upward from the line and the second
downward, and the two are read against each other at every place without the eye having to reflect one
of them through a diagonal first. It is the same block read twice — `[i][j]` into the first band and
`[j][i]` into the second — so nothing is rotated twice and no second square is kept, and the diagonal
is drawn in both because it is the row the two files share.

The box is one box whether it holds one band or two, so a mirrored pair gets **half of it each**, and
its two horizontal edges are both far edges — the diagonal being in the middle of the picture, there
is no idle one. It is pinned by its **middle** for the same reason, which is where the paragraph above
about a band standing on its floor stops applying: a pair deeper than its box, which is what a zoom in
leaves, has a surplus to lose, and anchoring it by an edge takes the whole of that surplus off *one* of
the two files. What a reader saw was a sliver of the first map above a whole one of the second — and,
far enough in, the shared axis off the picture altogether and neither map identifiable. The ruler up the side runs outwards from the shared axis in both directions (§17.5),
so a separation is written twice and neither band is labelled with a negative distance; a pointer in the
lower band reads the lower band's file; and each band carries its map's name (§16.10) on its own side
of the line, the four corners being spoken for by the two rulers and the colour key. A **ratio or a
difference** stays one band: there is one derived field over the whole square there, so its two
triangles are the same numbers twice.

### 17.3 The turn is the deck's, not one map's

Like the derivations of §7.5, the turn is a property of the **session** and reaches every map in a
deck. A bar claiming one navigation over a band and four squares is not a comparison. The
navigation lock (§16.3) measures a turned map's window in the same base pairs it measures a square
one's, remembering that a rotated cell is half a bin — without which every turned panel drew half of
what the one beside it drew.

### 17.4 Tracks under a turned map, and marks on one

**Every track falls into the stack below the rectangle**, whichever edge it was put on, and a track
placed on two edges arrives there once. There is nothing for a vertical lane to be drawn against:
up the side is a distance, not a place.

This is a *presentation* of the placement and not a rewrite of it. The turn is something a reader
switches on and off, and a track that came back from it on the bottom edge because it happened to be
turned when they pressed the button would be the picture editing their settings behind them — so
"back where it came from on the way home" costs nothing, the store never having moved.

Marks are placed by the **pair of loci they were always about**, since there is no row axis to ask
where a locus is:

- a **line** stays a line at the same place on the genome, joining up with the same line in the lane
  below it — a mark stored as horizontal is drawn too, the axis it was drawn against being gone but
  the locus it names not;
- a **domain** becomes a triangle standing on the axis, apex over its own midpoint at the height of
  its own span;
- a **loop** becomes one dot at that height — the pair and its mirror rotate to the same point, so
  the square map's "which half do I ring" question does not arise;
- an **arrowhead** stands over the dot it names with its tip pointing back at it, square to the axis
  rather than at 45°, and on the far side from the diagonal so the cell is never under the glyph —
  the extra pixel of clearance is vertical only here, a sideways nudge on a turned map being a nudge
  to a different separation and so to a different pair of loci;
- a **rectangle** becomes the image of the contacts it names, which is a parallelogram leaning at 45°
  off the diagonal and the domain triangle on it. A box drawn *across* the diagonal has two such
  images, one per side, and both are drawn where they genuinely fall apart — a locus against a whole
  arm turns into two stripes leaning opposite ways, and drawing one of them would be drawing half the
  contacts the reader boxed. Where one image falls inside the other, which is every box drawn near
  the diagonal, only the outer is drawn: a second outline in there is the edge of nothing.

A call further out than the band shows is **not drawn**. That is outside the data rather than off
the edge of the picture, and a dot pinned to the top would claim a depth the map is not showing.

### 17.5 The ruler up the side

A distance, in the same 1–2–5 ladder every other ruler uses, and the same affine line: the gradient
is simply negative, separation growing towards the top of the picture while a row index grows
towards the bottom. The tick *spacing* is the one thing that could not be shared — the default is
the width of a base-pair label, because a horizontal ruler is what it was chosen for, and a turned
band is a hundred pixels tall, which at that spacing fits one tick, on the diagonal, in the corner
the column labels have already claimed.

A **mirrored pair** (§17.2) is measured outwards from a line in the middle of it, which is two
affine lines rather than one — and `AxisCoords`, which every ruler in the app is, is one. What it
carries instead is the row that line is *reflected about*: the ruler as written is the whole of it
before the fold, and past the fold it is the same line run the other way. So each half is an
ordinary ruler over an ordinary domain, walked by the same ladder twice; there is no second tick
mechanism, and no half labelled in negative distance for a reader to read as "100 kb, in the other
file".

### 17.6 What a drag means on a turned map

Both gestures collapse onto the **x axis**, because it is the only one with coordinates on it.

There is a third, and it does not: **drawing a box** for the Manual card (§8.1). The difference is
what the gesture is *about*. A selection and a 4C drag are about the picture — they open what they
cover, and up the side there is nothing to open — while a mark is about the data, and rows and columns
are things the square has. So a drawn box takes both ends back to the square, exactly as a click does,
and comes out as a rectangle of rows against columns which may be off the diagonal. It is drawn as the
mark it will become rather than as a rubber band, since that rectangle leans at 45° here.

Up the side is distance from the diagonal, which bounds no window: a marquee's top and bottom edges
name nothing, and a band of rows is a range of separations rather than a stretch of genome. Read as
block indices they are worse than useless — a marquee committed a box over rows the block does not
have, and a mostly-vertical 4C drag resolved to nothing at all, silently, because the row axis a turn
leaves is `null` (§17.4).

So a **selection** is a full-height band over a stretch of the genome, and it opens the square that
stretch cuts out: the same window on both axes of the block the band was turned out of. That is the
*on-diagonal* selection, which on a square map is what Shift adds to the selection modifier — here it
is the only honest reading, so the reader arrives at it without holding anything down for it. A **4C
drag** names that same stretch, whichever way the hand travelled, rather than asking the hand which
axis it meant. And the diagonal lock is off: on a turned map the diagonal is the bottom edge of the
picture, so snapping a corner onto it would be snapping to the frame.

The arithmetic is the rotation's, halved — a column is half a bin — and the rounding goes outward at
both ends. A reader who drags across a feature means the bins their band *touched*, not the bins it
wholly contained, and a band narrower than one bin is still a band.

**With a modifier down, the readout says one place.** The crosshair has already become a single
vertical line standing where a band would begin, and the card beside it went on printing the pair of
loci under the pointer and the distance between them — a fact about the cell, which is not what the
next drag will select. Held, it names the position along the bottom and nothing else: the midpoint of
the pair, which is what a turned column stands over, and the same number the ruler under the pointer
is printing. No distance, no count. Let go, the card is a card about a cell again.

The same inverse serves the readout, and has to: the two names, the separation, the pair of positions
and the value are all questions about the square block, and anything that answers one of them from a
turned row or a half-bin column is naming a place that is not on the picture. The **ruler** under the
map is the one thing that is not asked through it — it is an affine line in the axis's own units, and
under a turn a cell is half a bin. Only the *step* is halved: where the block starts is a distance
from the contig's first bin, counted in whole bins by everything else that reads it, and halving that
too put the ruler half of the way into the block behind the picture drawn on it. A window opening 120
bins in then labelled every tick 60 kb short, and the tooltip disagreed with the axis beneath the
very cell it was describing.

**And the guides are a pair of rays, not a cross.** A turned map's two directions are not its two
axes: hold one end of a contact still and let the separation grow, and the contact walks *diagonally*
across the picture — half a bin along for every bin further from the diagonal, which in matrix units
is exactly slope one. So the lines that say *which two places is this* leave the pointer at 45°, and a
vertical rule through it would cross contacts between two other places at every row but its own.

Which gives three marks, all of them the same statement seen from different sides of the picture:

- a pointer **on the map** gets an **X** centred on the contact — the two rays to both edges of the
  band. Near the axis the upper half is all that fits and it reads as a V; near the top of the band
  the lower half is, and it reads as a ∧. Neither is a special case: the clip is what makes them.
- a pointer **on a track** gets a **V** standing on the axis under it. The reader is naming one
  place, and the contacts that place is in are the two rays leaving it — both ways along the genome,
  because a place is an anchor of everything to its left as well as everything to its right.
- and a pointer on the map puts **two hairlines in every track**, one under each end of the contact,
  because the column it is over is the *midpoint* of the two and no track has anything at it. On the
  diagonal the two ends are one place and there is one line.

The X and the V meet the axis at the same two columns the hairlines are drawn at, which is what makes
them one instrument rather than three: the rays are anchored at the contact's own middle — the line
between the two columns it fills, not the centre of whichever of them the pointer happens to be over
— and a quarter of a bin is invisible as a position but is the difference between a guide that lands
on its anchor and one that lands beside it.

**And the colour scale does not move when the map is turned.** The automatic range is a property of
the *block that was read*, which is already the rule for a square map — it is measured once per read,
and neither a pan nor a zoom re-measures it. A band breaks that rule by being a **crop**: it holds
the near-diagonal separations and drops the rest, and the ones it drops are where the extremes live.
On a diverging field the effect is dramatic — the auto range is the 99th percentile of the departure
from neutral, and the far separations are where a small count over a small expectation produces the
largest departures there are, so turning an O/E map roughly *halved* its range and dragging the depth
handle moved it again on every pixel.

It is worth being precise about what is **not** the cause, because the obvious guess is wrong. A
square map holds each off-diagonal pair twice, once in each triangle, and a band holds it once — but
a percentile is invariant under duplicating every value, so counting both triangles neither doubles
the range nor changes it at all. Nothing needs halving on the square side. And nothing *could* be
done on that side anyway: §7.1 fixes the square's rule to `metacooler show`'s, to the bit. So the two
can only be made to agree in one direction, and the band adopts the block's range.

---

## 18. Analysis

Last rather than beside §8, where it arguably belongs, because source files cite these numbers at the
point where a decision is not obvious from the code and there are over three hundred such citations. A
section that reads slightly out of order costs nothing; renumbering §7.4 and §8.5 costs every one of
them. It was drafted as §16 and is §18 because §16 and §17 landed first — which is the same argument
made against this section's own author, and taken.

Everything before this section is a **reading of a file**. This one is a **computation over one**, and
the difference that matters is time. A reading is a frame: it happens between two paints, it is thrown
away when the view moves, and if it is slow the app is broken. A computation is a job: it takes as long
as it takes, it outlives the view that started it, it can fail halfway, and the only honest response to
a slow one is a progress bar and a cancel. Nothing in §5 through §9 was built for that, which is why
this is a section and not a paragraph.

One constraint has not moved and does not bend here. **C1 still holds: no server-side computation of
any kind.** Every number below is computed in the reader's own browser, from bytes the reader's own
machine already has. cooltools, coolpuppy, deeptools and pyBigWig appear in this section exactly once,
in §18.10, as dependencies of `scripts/make_golden.py` — a developer's tool that produces the oracle
files the test suite compares against. They are not shipped, not fetched, not invoked, and not
required by anyone running the app.

### 18.1 Three surfaces, and why it is three

**The Analysis panel** is a fourth column, right of Aesthetics, folded with `j`. It is a *list*: one row
per task, each with a title, a line of description and a state — never run, running, done, failed. It
carries no controls, because a panel that both lists twenty tasks and configures them is a panel that
does neither.

**A task that could never mean anything here is absent; one that is waiting for a file is listed and
greyed.** The first half is §8.5's doctrine and it stands: a disabled row is a promise the file cannot
keep, and a `.cool` has no genomes, so it offers no MAG tasks — nothing the reader does next produces
a `/genomes` table.

The second half is a correction to what this section first said, and the case that forced it is APA on
a map with no loops loaded. That task applies perfectly well to the file; it is one drag-and-drop from
running. Hiding it does not spare the reader a broken promise — it teaches them the application does
not do aggregate peak analysis. So a task in that state is listed, dimmed, and carries a line saying
what to load: *Load a loop set (BEDPE) to pile up off the diagonal, or a feature set (BED, GTF) to pile
up on it.* A greyed row with an instruction on it is not an unkept promise; it is the menu.

The distinction is not *can this run now* but *can what the reader does next make it run*, and
`TaskAvailability` is the three answers: `ready`, `waiting` with a sentence, `absent`.

**The panel exists without a contact map.** Three tasks — metaplot, track correlation and interval
overlap — read only the loaded tracks, and a 1D browser session (§5.8) is exactly where a reader has
the tracks and not the matrix. There the map tasks are `waiting` on *open a contact map*, the track
tasks run, the analysis worker is never mounted because nothing asks it for a pixel, and a result's
provenance names the assembly rather than a block.

**A locus a reader can point at is picked on the map, not typed.** Reading
coordinates off a picture in order to type them back in beside it is asking
twice. So `RegionParam.pickable` puts a **Pick on map** button next to the locus
box; pressing it arms `ui/mapPick.ts`, the next Shift-drag on the map fills the
box instead of zooming, and the button goes out (§8.9). An *arm* rather than a
mode the form leaves on: a reader who wanted one anchor should not find their
next three attempts to zoom quietly redefining it.

What gets written into the parameter is the **resolved locus**, never a sentinel,
and the pick is not a parameter of its own — which is a deliberate change from
the toggle this replaces. What belongs in a provenance line is the *place*;
"typed" versus "pointed at" is a fact about the reader's hand rather than about
the number. The box stays editable throughout, so a picked locus is a starting
point for a typed correction rather than a replacement for one. The button is
offered only where there is a map to point at, since the panel exists without
one.

**The Analysis drawer** is the workspace: parameters, a **Run** button with the price beside it,
progress, results, exports. It is anchored to the right of the body, full height, resizable by its left
edge with its width remembered, and it overlays the content and the two right columns rather than
squeezing them — at three quarters of the window there is nothing left to squeeze.

**It is deliberately not a modal.** The dialogs in §5 are questions; this is a place to work. A modal
here would take the keyboard (which is how the app is driven), would dismiss on a stray click outside
it (after a forty-second scan), and would answer Escape by destroying the thing the reader is reading.
The drawer does none of those: every shortcut keeps working behind it, an outside click does nothing,
and Escape returns focus to the map and leaves the drawer up.

The panel's fold is a **window** preference, like the other three columns. Which task is open is a
**session** fact, because it is about this file — so switching tabs shows the drawer exactly when that
tab had one open, and the content re-parents exactly as the other three columns' does.

**The Synthetic tracks card** is the third surface and the least obvious, and it exists because of a
mistake that was already made once and corrected: the virtual 4C profile started as a strip of its own
and became an entry in the `AnnotationStore`, which is what gave it renaming, limits, colour, edges,
reordering, the tooltip and the exported figure for free. That lane is gone (§8.9) and the argument it
made is not: a per-bin analysis result is the same object. It is therefore an ordinary track on an ordinary card in the **Annotations** panel — not a
picture in the drawer — and nothing downstream of it knows it was computed rather than loaded.

### 18.2 Every task is a descriptor, and every task is parametrised

A task is data: an id, a title, a predicate saying which files it applies to, a list of parameters, a
list of outputs, a cost estimate and a function. One generic form renderer turns the parameter list
into controls. **Adding a task is adding a descriptor**, never adding a screen — the same arrangement
`ui/plotOptions.ts` already uses for the overlay toggles, where one table drives the labels, the marks,
the tooltips and the commands, and the copy that goes stale is the one that does not exist.

**A hard-coded analysis parameter is a bug.** The window of a diamond insulation, the flank of a
metaplot, the number of controls in a distance-matched pileup, the quantile count of a saddle: each of
these is the thing a reader changes to answer their actual question, and a task that fixes one is a
task somebody has to leave the app to redo. Where a parameter is a length it is offered in **base
pairs** and the resolved bin count is shown beneath it, because bins are a property of the file and
base pairs are a property of the question.

Four parameter kinds refer to what is already loaded rather than to a number, and all four **default to
the starred entry** where the concept exists — the same star the 1D browser's feature search is keyed
on (§5.8): a feature set, a pair set, a track — bigWig *or* synthetic — and a sequence. This is what
lets a task like compartment phasing (§18.8) be a dropdown rather than a second file drop.

Parameters are remembered per file and per task, and travel in an exported session, so that reproducing
a figure is opening the session and pressing Run.

**A control the file cannot be asked about is not shown.** The descriptor still lists it and states the
rule — an option that needs a `/genomes` table, a switch that is only a question where there is no such
table (4C's *cis only* and *Normalisation*, §18.8) — and what varies per file is whether this one can
answer it. This is the single way the *never a screen* rule bends, and it bends by declared data rather
than by building a descriptor per file. Two things follow, and both are load-bearing: the **runner**,
not the form, settles a key whose control this file does not show, since a stored session and a form
filled in on another file both leave a value behind; and the **estimate** prices what the runner will
actually do, since a cost quoted from a parameter nobody was asked about is a cost for a different run.

### 18.3 The map stays live: a third worker

**A long analysis must not stop the reader from panning.** This is a requirement, not a preference, and
it is the reason the threading arrangement is what it is.

The reader worker owns the HDF5 mount and answers `matrix` requests; a scan inside it makes the next
pan wait behind minutes of arithmetic. The annotations worker already exists for precisely this
argument one level down — a `sample` behind a whole-genome pixel scan would wait, so tracks got a
thread of their own. Analysis is the same argument a third time, with a longer job.

So: **a third worker, with its own mount of the same source.**

- **No analysis ever runs on the main thread.** Not even a cheap one — a rule with an exception is a
  rule a frame gets dropped through.
- **The reader worker is never given analysis work.** This is what makes §12's first analysis budget
  row — *0 dropped frames, 0 blocked reader requests* — true by construction rather than by care.
- A local `File` is cloneable by reference, so a second handle on a local file costs nothing. A remote
  source costs a second range cache, and that cost is now **measured rather than expected**:
  `test/budgets/analysis.test.ts` compares one source doing the view's read and then a four-chromosome
  analysis against two independent sources doing the same two things, and the difference — the bytes
  genuinely fetched twice — is **one 1 MiB chunk**, 9 % of what a shared cache would have moved. It is
  bounded by where the two access patterns overlap at chunk granularity, not by the length of the scan.
- The mount is **opened on the first task that needs it** and closed with the session, so a reader who
  never opens the panel pays nothing at all.
- **One job at a time per session**, queued. Two scans over one byte source thrash it and both finish
  later than they would in sequence.
- **Every job reports progress and can be cancelled**, through the same hooks the genome × genome scan
  (§7.3) already uses.
- **A job survives navigation and tab switches** and is bound to the session rather than to the mounted
  view. Pan, zoom, open a chromosome, switch tabs, come back: it is still running, and the panel row
  says so. It does not survive the session, which cancels it.

Input reaches the worker one of two ways, and the task says which: a **copy** of a block the view
already holds, where that block is small enough for the copy to be free — a yeast chromosome at 1 kb is
9 MB — or the worker's **own reads**, bounded or streaming. The view's block is never *transferred*,
which would neuter the array the heatmap is drawing from.

### 18.4 The framing is an input, and it is a snapshot

**What a task runs on is the map's current framing**, captured at the instant **Run** is pressed: the
row and column bin extents, the bin size, any pooling in force, the score column, and whether balancing
is on.

It is a **snapshot**, and the result is a record rather than a live view. Panning afterwards does not
change a finished pileup; the drawer states the framing the result belongs to and offers to recompute
against the new one. This is the discipline the on-the-fly 4C lane never kept — it redrew itself from
whatever block happened to be loaded, which is one of the reasons it is gone (§8.9) — and it is why
the genome-wide 4C **task** (§18.8) is a different object from that **lane** rather than a bigger
version of it. The panel is what makes the two obviously different, which is a good reason for the
panel to exist.

**Provenance travels with the numbers.** Every result carries its task and task version, every
parameter, the framing snapshot, the file URI, the app's version and commit, and a timestamp. It is
shown in the drawer, copyable in one click, and written into every export whose format has a comment
syntax — TSV, bedGraph and BED, the same `#` provenance line `annotations/export.ts` already writes for
hand-drawn marks. A bigWig carries none, because BBI has nowhere to put one; writing it into the
`autoSql` offset would technically work and is refused, since a file that misuses a structural field to
carry a comment is worse than a file without the comment. That is a reason to offer the TSV beside the
bigWig, not a reason to abuse the header.

**A figure must come out the same twice.** Every task that samples — distance-matched controls,
bootstrap intervals — takes a **seed** with a stable default and uses a seeded generator, never
`Math.random()`. The seed is part of the provenance, and identical seeds with identical parameters
produce bit-identical output.

### 18.5 A synthetic track is a track

Any result that is one value per bin becomes an `AnnotationEntry` with `kind: 'track'` on a new
`synthetic` card, and from that moment it is indistinguishable from a loaded bigWig: the same colour
chip, rename, limits, autoscale, ceiling drag, four edges, reordering, autoscale groups, hairline,
tooltip, 1D browser and vector figure — because it is the same implementation and not a second one.
Its `source` is a new `computed` case carrying the task and its parameters, so the row can say what made
it.

Mechanically, a finished vector is **registered with the annotations worker as a bin-vector source**,
and the lane then asks for samples over a window exactly as it does of a bigWig. One new request kind,
and no renderer changes anywhere.

**A gap and a measured zero are not the same thing, and the difference is the
file's to declare.** `NaN` means *no value here* throughout, and the temptation
is to call every bin nothing landed in a gap. That is wrong for a cooler: it
stores only its non-zeros, so an absent pixel is a zero the file asserts rather
than a measurement it is missing. A bin is a genuine gap for exactly one reason —
the balancer dropped it (§6.4) — and a task that conflates the two produces two
different answers for one file depending on whether it read a dense block or
walked the pixels. The ratios are the exception and go the other way: a bin with
no contact at all has no cis *fraction*, because zero of zero is not zero and
drawing it at the floor would put a bin that never touched anything in the same
place as one that only ever reaches other sequences.

**On a file with no annotation *worker* the drawer is the lane.** This used to read "no annotation
layer", and §8.12 made the distinction load-bearing: a `.metacool` now has a store, a placement model
and a card, for its own metadata columns. What it still has no worker for is a **profile**, whose
values live in the annotations worker and are sampled from there like a bigWig's — so a row there
would be an empty strip under a sentence saying where to find it. Three of the tasks offered on one
produce exactly that: coverage and marginals, diamond insulation, and MAG purity's per-contig track.
A called **interval set** is the other half of the split and goes the other way: its coordinates are
on the entry itself, so a store is the whole of what it needs, and insulation's boundaries are drawn
on a metagenome's map like any other overlay. There the drawer draws the profile itself, bucketed to the width it
has with a min–max band so a spike inside a bucket is visible rather than sampled away, and carries the
exports the row would have carried: bigWig, bedGraph and TSV beside the PNG and the vector PDF. This is
not a second opinion about the rule above — wherever there *is* a card the profile goes to it and is a
track in every sense — it is what the rule has to say about the one layout where the card cannot exist,
which is otherwise a result that is computed, priced, reported as finished, and then dropped.

**Values are not persisted; the recipe is.** A vector is megabytes and session storage is not for that.
What survives a reload is the task, its parameters and its framing, and the row comes back in the
`detached` state with a **Recompute** button — which is precisely the state a dropped local file returns
in, for precisely the same reason (§8.6). An exported session therefore hands a colleague the analysis
rather than a number they have to take on trust.

**But a change of resolution is not a reload, and the values carry across it.** Opening an `.mcool` at
another level re-opens the file — a new store, a new annotations worker, a new workspace — and every
other part of the session already treats that as the same data seen differently: the view carries
(§5.5), and so does every loaded track. A computed row carries too, live, as the row the reader left
it: colour, name, edge, group, hidden or not, with its values still behind it, its exports still on it
and, for a called interval set, its features and its **Save as BED**. Dropping them would lose numbers
the tab is still holding.

They carry **unrescaled**. A profile is one value per bin on the bins it was computed on; re-binning a
1 kb insulation track to 5 kb would invent a score no window ever produced. So the vector is
re-registered on *its own* grid — a bin-vector source has always carried its `binsize` and contig
offsets, which is the same reason a bigWig at one resolution draws correctly over a map at another —
and the row's framing line goes on naming the level it was computed at. A row that was already
`detached` stays `detached`, because promoting it would be a lane with nothing in it.

This is for a change of *entry* only. A different file leaves the analysis behind: a computed row is an
answer about the file being closed, and carrying it forward would be showing a reader a picture of
somewhere they never pointed at.

### 18.6 Cost, and the three gates

Analysis makes it possible to ask for something expensive, so the cost model is part of the contract.
Every task declares its cost as one of three, and the drawer shows an estimate beside **Run** before
anything is read.

**Free** — computed from a block already in memory. Insulation, coverage, P(s) and the correlation
chain over a loaded genome are all of these, and cost no I/O whatever.

**Bounded** — a few range requests. The cis 4C profile is the row band and nothing else; a diamond
insulation on an unloaded contig is one diagonal band; an APA window is one small block.

**Scan** — a streaming pass, and therefore gated exactly as the genome × genome overview is (§7.3):
explicit action, a progress bar, a cancel, and a pre-flight figure in requests and bytes. Two tasks are
in this class, and both are honest about being so.

Three specific gates, each stated because each is a place the naive implementation is wrong:

1. **Whole-genome 4C is not a bounded read, and the read planner says so.** With rows set to the anchor
   band and columns to everything, the two ranges overlap, so `planRead` resolves to `symmetric` over
   the whole pixel table — because an upper-triangular store keeps every column *before* the anchor in
   other rows (§5.3, §6.2). Done properly it is one streaming pass over the pixels with
   `bin1 < anchor_end`, on average half the file, accumulating into a band of `|anchor|` rows and
   materialising nothing large. **On a cooler cis is the default** and is bounded, with trans as a
   toggle that says what it costs. **On a metacool there is no toggle and the run is always the walk**
   (§18.8): a MAG's contacts with the rest of the community are the reading such a file exists for, and
   the estimate prices the pass rather than the four requests the absent toggle would otherwise imply.

2. **The correlation matrix is N², and there is a bin-count gate.** A whole yeast genome at 1 kb is
   12,100 bins and a 586 MB correlation matrix; human chr1 at 10 kb is 24,900 bins and 2.5 GB. The gate
   mirrors `checkDenseSize` (§6.2) in form and in voice: it names the bin count, the bytes and the way
   out, and it refuses rather than quietly coarsening. Per-contig is the default scope, which is both
   the affordable choice and the conventional one.

3. **An aggregate pileup reads one small block per feature, at the file's native bin size, and never a
   bounding box.** This is a deliberate reversal of the obvious optimisation, and the reason is
   resolution: a whole-genome or bounding-box read is pooled at `RASTER_MAX_DIM` (§7.2), so a pileup
   taken from it silently inherits a coarsened bin on any sizeable genome, and the reader would have no
   way to know. `k` windows inherit nothing. Where the block is already loaded the reads are free; where
   it is not, adjacent windows are **coalesced** — the pixel-band merging the selection read already
   performs — and the resulting request count is shown before **Run**, so an expensive pileup is the
   reader's decision and not a surprise. On a local file it is not a question at all: a read is a
   `slice()`.

### 18.7 What comes out

Five output kinds, and a task may produce several: a **profile** (one value per bin → a synthetic
track), a **matrix** (a pileup, a saddle, a correlation heatmap → drawn with the app's existing
rasteriser and colormaps), a **curve** (with an optional band), a **table** (through the existing
virtual table, sortable and filterable) and **intervals** (a feature or pair set, offered as a new row
on the Annotations panel so a called boundary becomes an overlay on the map immediately).

Every drawer plot is drawn through a 2D context, which means the vector PDF page (§7.2) gives each of
them a true vector figure rather than a photograph of a chart.

**A curve is interactive, and an interactive figure is a plain figure of a derived output.** Turning
on a log axis produces a `CurveOutput` with `xScale: 'log'`; hiding a series produces one with fewer
entries in `series`; dragging a rectangle across the plot produces one whose `xDomain` and `yDomain`
are that rectangle. There is no zoom transform and no second code path, so a reader who zooms into a
shoulder and presses PDF gets *that* picture at vector resolution with its axes relabelled for it —
which a canvas transform would have answered with the whole curve under a clipping rectangle.

Three consequences are contract rather than detail:

- **The window is a rectangle, on both axes.** A curve is a shape in two directions, and a drag that
  could only cut the abscissa left a reader looking at a shoulder half a decade deep with the whole
  ordinate still in the picture. The two bounds of each axis are also four text boxes, because a
  figure that is going into a paper beside another one has to be set to the same window as it rather
  than dragged towards it, and because a marquee cannot express "from exactly 4 kb".
- **An automatic ordinate fits the window, not the series.** Otherwise a P(s) zoomed to 4 kb–1 Mb
  still spends its height on the near-diagonal spike sitting off the left edge.
- **A task may declare the window its figure opens on**, and P(s) does: 4 kb to 1 Mb, which is past
  the ligation artefacts at one end and inside the shortest chromosome at the other. It is a
  *default* — the marquee, the boxes and a double-click all move it, and the curve underneath runs
  from one base pair to the length of the longest sequence whatever it says. The reason it is needed
  is §18.8's first break: the diagonal and the first off-diagonal share a bin at 1 bp holding two
  thirds of every cis contact in a 1 kb map, and a log axis drawn over all of it squashes every
  decade anybody reads into its right-hand quarter.

**The files this app writes gain one format, and it is bigWig.** A bigWig is what a reader wants at the
end of the day — it is what a genome browser opens and what a colleague expects — and telling them to
run `bedGraphToBigWig` is a command-line dependency in an application whose entire claim is that it has
none. The writer is native, has no new npm dependency, and is affordable because the input is never
arbitrary: one value per bin, over a known assembly, at a fixed bin size.

Three properties of that writer are contract rather than implementation detail:

- **A bin with no value is omitted, never written as `NaN` — and `±Infinity` goes the same way.**
  Every downstream tool would report a `NaN` as a value, and BBI has nowhere to put an infinity at
  all: one reaches the total summary and every zoom record over it, where `sumData` becomes `NaN`
  and the bounds become infinite. That is a file which opens cleanly in every reader with its
  autoscale and its mean destroyed — and which, with only `+Infinity` present, is not even visibly
  broken, because `min` stays finite. A task that produces an infinity has a bug of its own; the
  writer is the backstop that keeps it out of the file. This is also why the sections are
  bedGraph-typed rather than fixed-step: gaps, dropped values and the partial final bin of a contig
  — which is shorter than the bin size, since a sequence length is not a multiple of it — are all
  expressed exactly, at four extra bytes per value that nothing notices.
- **Compression is zlib through the platform's own `CompressionStream`**, already used by the PDF
  writer; where it is unavailable the file is written uncompressed, which is a legal bigWig and beats
  refusing to export.
- **It round-trips through this app's own reader.** `@gmod/bbi` is already a dependency, so a written
  file is read back and compared value for value in the test suite, and cross-checked against pyBigWig
  in the goldens. A writer nobody reads back is a writer that is wrong.

**Four header facts were settled by measurement rather than by reading a table**, against the six real
bigWigs in `demo/yeast/`, because they are where writers most commonly disagree and because neither
`@gmod/bbi` nor libBigWig reads two of them at all — so a round-trip test cannot settle them, and did
not:

| Field | What it actually holds |
|---|---|
| the u64 at `fullDataOffset` | the number of **sections**, not of data items. `Yeast_ChIP_Pol2-vs-input.bw` reads 658, which is its R-tree leaf count, against 1,771,581 items on disk |
| `itemsPerSlot` in the unzoomed R-tree | **1** — one section per leaf slot — not the 1,024 items a section happens to hold. The zoom indexes carry 1,024, which is *their* records per block |
| total-summary `validCount` | **bases covered**, not items, with `sumData` and `sumSquares` weighted by each interval's span |
| the count before a zoom level's data | a **u32** block count, not a record count. The asymmetry with the u64 above is real |

One further thing no reader in this repo can check, and which is therefore asserted on the bytes:
**every internal node of the chromosome B+ tree carries the first key of the subtree beneath it.**
`@gmod/bbi` steps over an internal key and recurses into every child, and libBigWig walks the tree
eagerly too, so both find every contig whatever those keys say — while the UCSC tools binary-search on
exactly them. A writer that filled them with rubbish would pass a round trip and produce a file
`bigWigInfo` cannot navigate.

Interval outputs go out as BED and BEDPE, and they go out through `annotations/export.ts` — the module
the hand-drawn marks already used. It gained a `FeatureSet`/`PairSet` writer rather than one being added
under `analysis/write/`, and that is the whole of the decision: two BED writers in one repository is two
opinions about half-open ends waiting to diverge, and what varies between a hand-drawn mark and a called
boundary is the *row*, not the format. Both round-trip through this app's own parser, which is what the
tests assert rather than the text.

**Every** output additionally offers TSV, and that is the most important of them: it is what makes a
number in a figure checkable by the person reading the figure. Where an output has both, the two are not
alternatives — the BED is the file a tool reads, and the TSV is the same rows with the provenance above
them, which is a header a BED consumer would choke on and a reader needs.

### 18.8 The catalogue

Seventeen tasks, in three groups. The build order is in `TASKS_PLAN.md`; what follows is what each
one must be.

**On the map.** *Contact probability P(s)* per contig, genome or file, with the log-log derivative, and
producing the **expected** curve three later tasks consume. Two quantities are called P(s) and the task
offers both, because they answer different questions and a figure that mixes them reads a difference of
convention as biology: the **probability density**, which is the default — contacts at a separation over
the contacts in the whole map, then over the separation the bin covers, which is
`HiContacts::distanceLaw()`'s `norm_p` down to that package's gap distance and its break table, with one
correction to its denominator that §18.10 sets out — and the **expected**, which is
`cooltools expected-cis`: contacts over the bin pairs that could have held one, the polymer-physics
reading, and the number most published scaling exponents refer to. `density / expected = pairs(s) /
constant`, so they are the same picture while the separation is short against the sequences and diverge
as it approaches the longest one: on the yeast demo, within 1 % below 10 kb, 13 % apart at 100 kb, a
factor of fifty apart at 1.2 Mb — and on a mammalian map, whose chromosomes are two orders of magnitude
longer, indistinguishable over everything anybody fits. The second is also what observed/expected, the
compartment chain and the pileups **divide by**, and they reach it through `expectedAt` rather than
through the panel: the plotted curve is a figure and the denominator is a denominator, and changing what
is on screen must not change what an O/E is taken against. *Coverage and marginals* — total, cis, trans
and the cis/trans ratio — as synthetic tracks, which is how a reader sees that a domain is a coverage
artefact. *Diamond insulation* at any window, or several windows at once, with boundary calling from its
minima; it never sums across a contig boundary, and never across a MAG boundary on a metacool.
*4C profile* from an anchor — a sequence, a stretch of one, or on a metagenome a whole genome — output
as a bigWig. On a cooler it is **cis by default with trans as a stated-cost toggle**, and optionally
**over expected**, where "expected" means the anchor's own sequence's decay in cis and the mean of what
the anchor reaches off it in trans, so that a profile carrying both halves carries one quantity. Per
sequence rather than from P(s)'s genome-wide curve: a small chromosome divided by the average behaviour
of the large ones comes out with a slope that is a property of the set.
**On a metacool the form asks for the anchor and nothing else**, and the two switches are absent
because neither question survives contact with the file. An anchor there is one MAG among hundreds
sharing a tube, and the reading wanted is what it touches *everywhere* — a profile restricted to the
anchor's own assembly answers a question about a genome in isolation, which is not why anybody opened a
metagenomic map. And a decay curve accumulated from one MAG's contigs is not an expectation for contact
*between* MAGs, so the ratio it would produce is a number with two meanings in one track. The runner
settles both keys itself on such a file rather than trusting a value a stored session or a form filled
in on a cooler left behind: always trans, never over expected. The arithmetic of both switches is
untouched and still goldened (`run/fourc.ts`); what varies by file is which of it is *offered*, which
is the same stated rule §18.2 already bends by for options that need a `/genomes` table.
*Compartments* — expected → observed/expected → Pearson correlation → eigenvectors by power iteration,
behind the bin-count gate — with **phasing from a dropdown** over the loaded gene models and
FASTAs, defaulting to the starred one, reporting the correlation it used and saying so when that
correlation is too weak to decide a sign. It is over **several ticked sequences, every one of them by
default**, and by default the square it correlates holds their **cis and trans blocks together**: two
chromosomes in the same compartment touch each other in trans, and that is where a genome-wide
eigenvector's signal comes from, so ticking them all is one answer the per-chromosome runs cannot give
rather than sixteen runs stacked up. The *expectation* stays per chromosome and that distinction is the
whole of it — a cis cell is divided by its own sequence's decay at that separation, a trans cell has no
separation and is divided by its own pair's block mean. **Which halves it reads is a control** and the
three settings are three computations: *cis only*, the **default**, is **one correlation per sequence**
rather than one across them, because a single square with its trans blocks removed correlates to a
block-diagonal matrix whose leading eigenvector lives on one chromosome and is zero on the rest — and it
is priced and gated per sequence accordingly, which makes it the mode that still runs where the other
two are refused on size; *trans only* is the standard genome-wide call, with no distance decay entering
the answer at all, and needs two sequences. Both it and insulation take cooltools' **`ignore_diags`**
(`|col − row| < n`, default 2), which is what keeps the near-diagonal — self-ligation and unligated
fragments, the largest cells in the matrix and the least structural — from carrying a correlation or a
diamond sum that then reads as structure. It emits **A/B segments** from E1's sign beside the eigenvector,
because the interval is what gets cited and thresholding a bigWig elsewhere is a second tool for one
comparison against zero. *Saddle*, which follows from the two above.
*Pattern detection*, which is chromosight — loops, borders, hairpins, centromeres and stripes, by
normalised cross-correlation against a template, over a map detrended by its own distance law, with
neighbour suppression and a Benjamini-Hochberg q-value on every call. **The pattern is a parameter
and not five tasks**: they are one computation with different templates, and every threshold under
the picker follows the picker because chromosight tuned each of them per template — a form that
baked one preset's `pearson` into a box would report borders at twice the threshold upstream uses.
It emits four things and the split is the point: a **loop set** (a bedpe, or a BED for the patterns
that live on the diagonal) that lands on the map as an overlay the moment the run finishes; the
**pileup** of every window it called, drawn on chromosight's own fixed 0–2 seismic scale so it can
be laid beside a published figure; the **spectrum** of the scores behind that pileup, because a
smooth shoulder running down to the threshold says the calling stopped where the threshold was
rather than where the pattern did; and a table of the strongest calls. This is the one task whose
output is a *claim about the data* rather than a summary of it, which is why §18.9's paragraph
against loop calling is answered in that section rather than here, and why its golden is the
package's own output rather than a re-derivation (§18.10).
*CID*, which is insulation plus boundary calls plus a pileup over those calls — **withheld from the
panel for now**, since everything it does is reachable through insulation's own boundary calls and an
APA over them, and a composite whose two halves disagree about their units is worth holding back rather
than shipping with a caveat.

**Which settings are settings.** A parameter is a question the reader is *entitled to a different
answer to*; anything with one right answer per file belongs to the file. **Balancing** is the case that
settles the rule: a balanced cooler should be read balanced and a raw one has no weights to apply, so
the six matrix tasks derive it from `hasWeights` and show no control — it is still a parameter in every
other sense, so the runners are unchanged and an exported TSV still says what the numbers were computed
with. The same reading removes the near-diagonal trim's ambiguity (**bins, not base pairs**: the
near-diagonal is a fact about the grid, and a number typed in base pairs meant three bins at one
resolution and one at the next), takes P(s)'s *sequences to draw* away entirely (a run that leaves out
sequences by default answers a question about a subset the reader did not choose), and leaves a
**whole-sequence picker empty** rather than seeded from the map's framing, since empty is an answer
there — *every sequence* — and seeding silently narrowed three tasks to whichever chromosome happened
to be on screen.

**Over tracks and feature sets.** *Metaplot*, in both **reference-point** (a point ± a flank) and
**scaled-region** (flank, body resampled to a fixed width, flank) modes, strand-aware, over any number
of bigWig or synthetic tracks, with a bootstrap band and a companion per-feature heatmap — because the
mean of a bimodal set is a line that describes nothing. *Aggregate peak analysis*, likewise in both
**fixed** (centre ± W bins) and **scaled-region** (the domain, or the rectangle between two anchors,
resampled to a fixed grid) modes; on-diagonal from a feature set and off-diagonal from a pair set;
normalised by **distance-matched controls by default**, by observed/expected, by **chromosight**, or
not at all; with the P2LL enrichment reported under it and a per-feature score table that can leave
the app. **Every anchor is piled up and every window is summed**: there is no cap on the anchors read
and no minimum coverage a window must reach. Both existed and both were quietly a change of subject —
a cap makes the figure a pileup of whichever anchors sorted first, and a coverage floor drops exactly
the windows in sparse regions, which are the ones a weak pileup is weak because of. The accumulator
counts per cell, so a half-empty window contributes what it has and nothing more. The chromosight
normalisation is `chromosight quantify` and is a fourth control rather than
a fourth task: the other three divide the pileup by something computed from the windows, and this one
detrends **the map** by its own distance law before any window is cut, so a cell is
observed-over-expected at that separation on that sequence — which is what chromosight's figures are.
Three things follow and none is optional: the window is the **template's** size rather than the
reader's half-width, since the score under the picture is a correlation against those cells; the scan
distance is the **loop set's own reach**, which is what `cmd_quantify` sets it to, so a short-range
set is detrended against a curve fitted to short ranges; and **every anchor comes back**, scored or
not, because quantification answers about the positions it was given. It reports the same score
spectrum the detector does, over the same templates.
*Track correlation* across any set of tracks, over fixed bins or over a feature set's intervals.
*Interval overlap* — counts, Jaccard, intersection and differences — because "how many of my loops sit
on a boundary" is the question that follows every domain call.

Both aggregation tasks carry the same **ranking and subsetting** control: sort the features by any
numeric column and take a top-N, a quantile band, or K equal groups aggregated separately. This is what
turns *here are four hundred calls* into *the strongest fifty look like this and the weakest fifty look
like nothing*, and it is what makes a boundary set or a loop set falsifiable rather than decorative.

**On the metagenome**, and offered only on a `.metacool`, because these are the tasks nothing else can
do and the reason the panel is not nearly empty on this app's primary format. *MAG contact QC*: per
genome, its bins, its covered bins, its intra- and inter-MAG contacts and their ratio. *MAG purity*: per
contig, the fraction of its contacts landing outside its own MAG and which MAG they land in, flagging
the contigs whose plurality partner is somebody else — a direct read on binning quality, exported as a
BED and as a per-contig track. *Split-MAG detection*: the contig-level matrix of one MAG, split
spectrally in two, flagged when the cross-block contacts are too few for it to be one organism.
*Inter-MAG network*: the genome × genome matrix as a ranked edge table, written in the column order
`metacooler network --level genome` uses so the two are interchangeable downstream, and instant wherever
that sidecar is already advertised (§7.3).

`__unbinned__` appears in none of them as a row, exactly as §7.4 requires — and its contacts are
dropped from every metagenome accumulation rather than counted as inter-MAG, because counting them
would make every real MAG look leakier in proportion to how badly the *rest* of the file was binned,
which is the opposite of a per-MAG diagnostic.

**Three things about this catalogue are settled differently from how they are described above**, and
the reasons are worth recording where the descriptions are:

- **Aggregate peak analysis is not a composite**, despite needing an expected curve for one of its
  three normalisations. `requires` is resolved before every run, so declaring it would compute a
  whole-file P(s) on every pileup while observed/expected is not the default — and the expected a
  pileup needs is narrower than the task that produces one: the diagonal offsets its own windows
  span, which it accumulates from squares it is already reading. **CID and the inter-MAG network
  are** genuine composites, and for the mirror-image reason: their upstream is the whole input,
  unconditionally. (CID is not currently offered; the argument is about its shape, not its
  availability.)
- **Multi-scale insulation is a doubling ladder from a settable base**, not a list of widths. A list
  needs a free-text control the parameter model does not have, and a parser with failure modes of its
  own, to express what a base and a count express exactly. A genuinely irregular set of widths is two
  runs, which leaves two provenance lines rather than one.
- **Compartment phasing by GC content is built, and it is built through `TaskInputs`.** The sequence
  is held by the annotations worker and the task runs in the analysis one, so the main thread asks
  that worker to `sample` the FASTA at `basesPerPixel = binsize` — the same request its GC *lane* is
  drawn from, so this is one implementation and not a second GC path — maps the intervals onto the
  bin grid area-weighted, and ships the vector under the parameter's own key. A `sequence` parameter
  and a `track` parameter are therefore resolved identically, and `run/compartments.ts` never learns
  that a FASTA was involved. The vector is fetched for the **analysis venue only**: a task running in
  the annotations worker is holding the file it would be sent a copy of.

### 18.9 Explicitly not built

In the spirit of §13, and for reasons rather than for lack of time.

**No loop or dot caller of this app's own invention.** ~~No loop or dot calling.~~ The original rule
was the second sentence, and its reason still stands: a HiCCUPS-class caller needs false-discovery
control across several local backgrounds, and a half-good one inside a viewer is a liability
*precisely because its output looks like a result*. What that argument is against is **writing** a
caller. It is not an argument against **porting** one, and the distinction is the whole of the
reversal: `analysis/chromosight.ts` is chromosight — a published, benchmarked method that arrives
with the two things the objection demands, a background model (the distance law the map is detrended
by) and false-discovery control (Benjamini-Hochberg over Fisher-transformed correlations) — and its
golden is that package's **own output** over `demo/yeast/`, compared call for call rather than in
spirit (§18.10). A number a reader can reproduce by running `chromosight detect` on the same file is
the opposite of the failure mode this paragraph names; the alternative was a viewer that displays a
loop set it can neither produce nor check.

Two consequences are worth stating so the rule keeps its teeth. **A second caller needs a second
upstream**: anything added here must be a port of a published method with a golden built from that
method's own implementation, not a variation on this one that seemed reasonable. And **the port does
not get to improve on it** — the `>= 10 → 1` clamp, the `half = size // 2 + 1` window, the asymmetric
frame rules and the sub-diagonal band of `NaN` are all reproduced, including where a first reading
takes them for oversights, because changing one is changing what the score means and the agreement is
the entire value of having it.

**No contact-based contig reordering or scaffolding.** It would only be useful if the reordering could
be written back into a file, and it cannot — see the next paragraph — so it would produce an ordering
with nowhere to go.

**No writing of `.cool`, `.mcool` or `.metacool`.** This is a decision and not a limitation: h5wasm can
create a file in its virtual filesystem, and the app declines to. A derived contact matrix is a format
contract, and owning one means owning every question about what its provenance, its balancing and its
bin table mean. §13's rule is therefore read as covering files the app *derives* and not only the file
it opened.

**No differential APA**, and **no differential insulation task**. Two insulation tracks from two files
are two synthetic tracks, and comparing tracks is something the app already does; a task that only
subtracts one from the other would be a worse version of a picture the reader can already make.

**And, restating C1 because this is the section most likely to erode it:** no analysis runs anywhere but
in the reader's own browser. There is no compute service, no offloading of the expensive cases, and no
"upload it and we'll do the scan". A task that could only be done on a server is a task this app does
not have.

### 18.10 Correctness

This is the largest cost in §18 and the one that decides whether any of it should be believed. An
insulation score three per cent away from cooltools is worse than no insulation score, because somebody
will put it in a figure.

The bar in §14's spirit — goldens exported from a reference implementation, compared cell by cell —
carries over, and only its arithmetic changes, since these outputs are floats rather than counts:

- **`scripts/make_golden.py` gains an analysis section**, guarded so that a machine without the extra
  packages still produces every existing golden. The new developer-side Python dependencies are
  **cooltools** (expected, insulation, eigenvectors, saddle), **coolpuppy** (pileups),
  **chromosight** (detection and quantification), **deeptools** (`computeMatrix`, for the 1D
  metaplots) and **pyBigWig** (the writer cross-check).
- **The tolerance is recorded per task in the golden file**, not written into the test, so it is data
  that can be tightened: relative `1e-6` for anything that is a sum or a ratio of sums, `1e-4` for
  eigenvectors, where solvers legitimately differ, and exact for counts, bin indices and interval
  bounds.
- **An eigenvector is compared up to a sign before phasing and exactly after it**, since phasing is the
  step that makes the sign mean anything.
- **The fixture is the published demo data.** `demo/yeast/` already carries a real 1 kb micro-C cooler,
  a real loop table, a real anchor set, a real GTF, a FASTA and five real bigWigs, which is every input
  every task above needs — so the goldens are against real data and cost no new fixtures.
- **Determinism is tested directly**: the same seed and the same parameters, twice, byte for byte.
- **Every writer round-trips**: a bigWig back through `@gmod/bbi`, a BED back through this app's own
  parser.
- **Every remote task gets a budget test**, in the shape `test/budgets/` already has, and the first of
  them asserts §12's first analysis row — that the reader worker served its requests on time while a
  scan was running.

**Two of these were settled differently once the goldens were actually built**, and the record is here
rather than left to be inferred from the code.

**It is a second script, `scripts/make_analysis_golden.py`, not a section of the first.** The two prove
different layers, against different references, to different bars, on different inputs — the reader
against metacooler and cooler on the synthetic fixtures, the analysis against cooltools and friends on
the published demo data. Folded together they would produce a run that half-succeeds on a machine
missing one package and a manifest that has to say which half. `npm run fixtures:analysis` invokes it,
and every golden it cannot build is *named* in its manifest, because an absent golden and an unwritten
one look identical from the JS side. `deeptools` is not among the dependencies after all: the metaplot
oracle is pyBigWig, which reads the same file the app reads with `@gmod/bbi` and therefore proves the
two readers agree as well as proving the kernel.

**Each golden carries two oracles rather than one, and the distinction is load-bearing.** `direct` is
this repo's own definition recomputed in numpy from the same file, compared to equality; `reference` is
the other tool's number under *its* definition, compared to whatever relation actually holds. Writing
only the second would force a choice between a tolerance loose enough to cover a difference of
definition and a test that fails on a difference that is correct. `direct` asks whether the code
computes what it says; `reference` asks whether what it says is the quantity the field means by that
name. Three of the relations are exact — P(s) against `expected_cis`, coverage against `coverage` up to
the diagonal being counted once here and twice there, APA against coolpuppy once the diagonal-crossing
windows are excluded. **Insulation is not**, and cannot be: the two diamonds differ by a row, by two
diagonals, by a sum against a mean, by a median against a mean, and by a bad-bin mask. The golden lists
all five, records the correlation *measured* per chromosome and window, and the test asserts that it has
not degraded — which is a claim that is true, where equality would have been a claim that is false.

**And one golden has no `direct` half at all, deliberately.** There is no second definition of *what
chromosight detects* to recompute in numpy: the algorithm is the definition, so the oracle is the
package's own output at each stage — the detrended map it scans, the correlation map it thresholds,
every call that survives its filters with its score, p-value and q-value, and the pileup it plots.
Those are five separate comparisons rather than one end-to-end check, because a single failure would
say only "different loops" while these say whether the disagreement is in the distance law, the
convolution, the focus picking, the window filters or the multiple-testing correction — five bugs
with nothing in common but their symptom. The chromosomes are part of the answer rather than a sample
of it: neighbour suppression and the FDR are global, so a q-value over two chromosomes is not the
q-value of the same call over sixteen, and the golden fixes the set. What survives the comparison at
`1e-6` is everything a reader sees — the calls, the scores, the p-values, the q-values, the pileup —
and the one place a **relative** bound does not describe the difference is the correlation map itself:
a dense block reaches a task as `Float32Array` while chromosight works in float64 from the same
pixels, the distance law is a mean of those values so the error does not stay where it started, and
the residue lands as `3.2e-8` **absolute** on coefficients of a few ten-thousandths. That is four
orders below the 0.15–0.3 a call has to reach, which is why the calls compare exactly and the map
compares against an absolute floor.

**And one golden is against R rather than Python, for the curve the panel actually draws.**
`HiContacts::distanceLaw()` is P(s) as a *probability density* — the share of all cis contacts at a
separation, per base pair — where cooltools' `expected-cis`, goldened above, is P(s) as a *mean per bin
pair*. The catalogue entry says why the app plots the first and divides by the second; this golden is
what makes the first reproducible rather than merely similar. What it compares is the **numerator,
break for break**, because that is where every way of getting this wrong shows: the gap distance off
by one bin, the break table regenerated wrongly, the mirrored square not folded. It is exact at three
places a near-miss would be invisible on a log-log plot. The
**separation** is HiContacts' gap distance, `pairdist(type = 'gap')` over bins that HiCExperiment
builds as `IRanges(start + 1, end)`, so two bins *k* apart are `(k − 1)·binsize` apart and the
diagonal and the first off-diagonal share the first break — a one-bin shift, which is a factor of two
at the left edge. The **bins** are that package's 205 hard-coded breaks, which are exactly
`unique(round(1.1^n))`, so `logRoundedBreaks` regenerates them and the test compares all 205 rather
than trusting the identity. And each unordered pair of bins counts **once**: the accumulator is fed
mirrored dense squares, harmless to a mean and fatal to a share of a total, since the diagonal arrives
once among off-diagonals that arrive twice.

**The denominator is deliberately not HiContacts', and this is the one place the app disagrees with
it.** That break table was built for a *pairs* file, where a distance is continuous and the counts in
a break really are spread across its whole width. A contact matrix is not like that: its separations
sit on a lattice of `binsize`, and the breaks near ten kilobases are about a kilobase wide — so on a
1 kb map one break holds two lattice points and the next holds one, and dividing both by their
nominal widths makes the first almost twice as dense as the second. The result is a sawtooth of a
factor of two, alternating bin by bin, straight through the decade the cohesin shoulder is read in.
On `demo/yeast/Yeast_microC_G2M_1kb.cool` the log-log slope of the nominal-width curve moves by
**0.83 between neighbouring points** and swings between +1.7 and −2.9; the shoulder it is hiding is a
change of about **0.26**. Dividing instead by the separation the bin actually covers —
`offsets × binsize` — is the same quantity estimated on the lattice the data are on, moves the slope
by **0.087** between neighbours, and agrees with the nominal width wherever a break is wide enough to
hold several offsets, which is everywhere past about 50 kb at 1 kb bins. HiContacts says as much
itself: its matrix branch prints *"the P(s) curve will be an approximation"* and its pairs branch does
not. A test in the suite asserts both roughness figures from the golden's own numbers, so the
sawtooth cannot come back unnoticed.

The oracle is `scripts/hicontacts_ps.R`, which is HiContacts' own pipeline copied line for line with
one substitution — the two lines that read the map — rather than a transcription into numpy. Two of
that function's output columns are left out because nothing here computes them: `slope`, which it
loess-smooths where `logLogSlope` draws the raw central difference, and `norm_p_unity`, which is a
rescaling of the goldened column rather than a second curve. That is
the same rule the chromosight golden follows for the same reason: reproducing R's `findInterval(...,
all.inside = TRUE)`, its `left_join` and its group semantics in another language would make the oracle
a second implementation of the thing it checks. It is the first golden whose dependency is a program
rather than an importable module, which is what the `bin:` prefix in the generator's `have()` is for,
and like every other it is *named* in the manifest when it is skipped. One test in the suite is not a
comparison at all: it drives the kernel with the mirror fold switched off and records what that
produces, because what it produces still looks like a P(s).

---

## 19. Standalone target: one HTML file

A fifth build of the same source, after the site, the archived pin, the desktop shell and the CLI.
It emits exactly one file, `dist-standalone/index.html`, with every script, stylesheet, worker and
icon inlined, and it is meant to be opened by double-clicking it out of a downloads directory. As
with §15 it is a second invocation of the same bundler over the same source and never a change to
the first: `npm run build` is what the deploy workflow runs and must keep producing the same bytes.

**What it is for is three machines the other four targets do not reach.** An air-gapped or HPC
login node with no route to the website; a reviewer who will not install an unsigned binary and
should not have to; a laptop holding unpublished patient-derived data, which is the reader §11 was
written for. §11's promise — nothing is uploaded — holds in every build, but only in this one is it
structural rather than a claim, because there is no origin to upload to.

A remote file cannot be opened here at all — there is no origin to read one from — which is a
property of the target and not a bug in any format. It matters most for a `.bam`, since a dropped
one and its index are the *only* way to get alignments into this build, so the interface says so
rather than failing at it: the URL box is what is absent, and a dropped pair works exactly as it
does everywhere else.

**Four things a `file://` page cannot do.** Each was measured in Chromium before the config was
written, and each is absolute rather than a degradation:

1. **A module worker cannot be constructed.** This is the same failure §15 records against
   `file://` for the desktop renderer, and it is why that target registers a privileged scheme
   instead. Here there is no main process to register one, so the workers change shape:
   `worker.format: 'iife'` plus `?worker&inline` in `src/worker/spawn.standalone.ts` gives classic
   workers over blob URLs, which do construct.
2. **A sibling `.js` cannot be fetched** — the same refusal that blocks a dynamic import.
   `inlineDynamicImports` collapses the graph to one chunk, at both the app and the worker level,
   and the build's own plugin folds that chunk into the HTML.
3. **No network at all.** The origin is opaque, so every remote read fails before it is sent.
4. **No service worker.** Registration is refused. `pwa.ts` needs no change: it already treats a
   refusal as "this page has no cache", and the `TARGET !== 'web'` guard excludes this build anyway.

**The interface is honest about (3) rather than failing at it.** `IS_STANDALONE` removes the remote
URL box, the published examples and the version picker, and the file picker says in one sentence
that this copy opens local files only and where to go for the rest. A build that offered a URL field
which could never succeed would be a worse artefact than one that does not offer it.

**It is about 11 MB and four fifths of that is h5wasm.** The runtime ships its wasm base64-inlined
in its own JavaScript, which is the reason this target is possible at all — there is no `.wasm` to
fetch — and the reason it is this size. It appears twice, in the reader worker and in the analysis
worker, because a `file://` page has no shared chunk to give them; the app chunk itself carries
none. The size is the price of HDF5 and is not reducible without dropping it. It gzips to about a
fifth in transit and costs roughly a second of parsing on each open, with no HTTP cache behind it.

**Every way this build can fail is silent, so the shape is a rule the build enforces.** A page that
kept one `<script src>` paints its shell and stops, with nothing on a console nobody is looking at;
a page that kept the module worker format looks completely normal until a file is dropped on it.
`scripts/standalone-shape.mjs` holds the rules — one file, within a size band, no external script or
stylesheet, no root-absolute reference, no PWA tag, no `{type:"module"}` worker construction, and
the blob-URL construction present — and `check-standalone-build.mjs` runs them over the directory
as the last step of `npm run build:standalone`. The lower size bound is as load-bearing as the
upper: a build whose inlining silently did nothing produces a small, tidy, entirely broken file.

**And the rules can all pass on a page that does not run**, so `scripts/smoke-standalone.mjs` drives
a real Chromium at a real `file://` URL, mounts the app and opens a `.hic` through a real worker. It
skips with a named message where the browser is absent, in the same way the fixture-dependent tests
do.

**Storage is shared with every other `file://` page on the machine**, because they are all one
origin. Saved sessions and preferences are therefore not isolated between standalone copies, which
matters only when somebody opens two, and cannot be fixed from inside the page.

**Verified in Chromium.** Firefox and Safari are untested against this target; the constraints above
are Chromium's, and another engine may impose more.

---

## 20. Connected folders

Every door to a file the app had asked *which file* once and then closed: the picker, the header's
`+`, the modal bucket browser, a URL box. That is the right shape for opening one thing and the
wrong shape for the way people work with a directory of data, which is to open one, look, open the
next, and keep going. A **connected folder** is a place the window keeps, browsable in a column, for
as long as the reader wants it.

Two things are folders, and the whole point is that they are the same thing here:

- a **directory on the machine**, and
- a **key prefix on a bucket**, public or private.

`browse/folder.ts` is the interface — given a path, the sub-folders and the files; given a file, how
to open it — and the two backends are the whole of the difference. Nothing above that layer asks
which kind it is holding, so "a local folder or an S3 bucket, read the same way" is a property of
that file being small rather than a feature written twice.

### 20.1 One level, never a walk

`list` answers one path with its immediate children. Nothing recurses, and that is a constraint
rather than an omission: on a bucket a recursive listing is one signed request per prefix against a
key that may be allowed some of them and not others, and on a disk it is an unbounded walk of
somebody's home directory to draw a sidebar. The folder view is the folder, not an index of it —
the same rule the bucket browser's filter already stated about itself.

Both backends stop at **1,000 entries** and say so. S3's own page is a thousand; a local directory
had no limit at all, which is the wrong asymmetry to leave in, since a `fastq/` directory of forty
thousand files would build forty thousand rows on a gesture the reader cannot undo. "My file is not
here" and "my file is past the cap" look identical otherwise, and only one of them is actionable.

### 20.2 The local half, in two shapes

**A grant**, where `showDirectoryPicker` exists — Chromium and the desktop build. The page holds a
`FileSystemDirectoryHandle`: a capability, not a path and not a copy. Listings are read through it
when they are asked for, so the folder is live — a file a pipeline writes into it five minutes later
is simply there — and the handle is structured-cloneable, so it survives in IndexedDB and the folder
is still connected after a reload.

**A snapshot**, everywhere else. Firefox and Safari have no picker; `<input webkitdirectory>` hands
back a flat `File[]` carrying `webkitRelativePath`, from which the tree is rebuilt once. It does not
update and it does not survive a reload, because a `File` is bytes the page was handed rather than
permission to go and get them.

They are not the same feature and the panel says so on the row, in three words. §8.5's doctrine —
a control that cannot keep its promise is absent rather than disabled — does *not* apply: the
gesture works in all four browsers, and what differs is how long the answer lasts. Hiding it in two
of them would take a working feature away to avoid writing one clause.

Asked in `'read'` mode explicitly. §13's "the app never modifies a file it opened" should be true of
the question the reader is shown as well as of the code.

### 20.3 The bucket half, and the one thing a public bucket usually cannot do

A scope may now carry **no credential**, and that is a scope over public data rather than a broken
one. A public bucket costs one field — its URL — instead of six. An unsigned `GET` with no custom
headers is a *simple* CORS request, so it is not preflighted, which means the ordinary public-data
policy (`GET`, `HEAD`, `Range`) answers a listing as it stands and the whole class of preflight
failures the signed path has to explain cannot arise.

What it does need is `s3:ListBucket` granted to `*` in the **bucket policy**, which is a different
grant from the `s3:GetObject` that makes the objects downloadable — and most published buckets grant
the second and not the first. **A public bucket that refuses to be listed is a normal
configuration, not a fault.** With no backend (C1) there is nothing the app can do about it, so the
403 says which of the two grants is missing and says that files under the prefix still open by URL.
`docs/hosting.md` has the policy.

The rule inside a scope is **all three signing fields or none**; a row holding one or two is dropped
rather than downgraded to an unsigned one, because falling back would turn a mistyped secret into a
bucket that 403s on data the reader believes they have a key for.

### 20.4 The fifth column, and the one that is not about the open file

§16.5 says the side columns are the session's furniture and each describes the one file the session
is of. **Files is the exception and is meant to be.** What it holds is the places this window is
connected to, which are the same in every tab and outlive all of them, exactly as the theme is. It
is therefore built once, never re-parented on a tab switch, and — alone among the five — **available
with nothing open at all**, because the landing page is precisely where a reader with a folder of
coolers starts.

`f` folds it. The single-letter space was down to `q` and `z`, and neither is a letter anyone
reaches for a list of files, so `f` came from the `fills` overlay — which keeps its toggle, on
screen beside the picture it changes, and loses one keystroke. It stays in the command palette,
which promises to list everything the app can do.

### 20.5 Two verbs on a row

Clicking a file **loads it into the tab that is open**: a second map beside the one that is there,
anything else drawn on top, an empty tab filled rather than added to — the same routing a dropped
file takes and the same promise the header's `+` makes. The `→` at the end of the row says it out
loud.

Dragging a file lets the reader say *where*: onto the map's edge rectangles for a lane in a named
stack (§8.9), onto a companion for a track on that map (§16), onto the Tracks card, onto the content
area, onto the landing page's drop zone — which replaces, because that is what the landing page has
always meant.

A dragged row carries a **folder id and a path**, never bytes: the file behind it is fetched at the
drop, once, by the target that accepted it. The path alone would be ambiguous the moment two folders
are connected. Everything ends at `Session.addPicked`, which decides nothing — it hands a local file
to the same door a dropped one takes and a remote one to the door a typed URL takes. A third routing
table is how a `.cool` picked from a folder would come to open somewhere a `.cool` dropped on the
window does not.

**A file the viewer has no route for is drawn, dimmed and inert, with the reason in its tooltip.**
Hiding it would make the folder view disagree with the folder, which is the one thing it is for; a
`.bam` sitting there unhighlighted answers *why is nothing happening when I click it* before it is
asked.

### 20.6 What a connected folder is, in privacy terms

Wider than a chosen file, and worth being exact about how. The page can see the **names** of
everything under the directory and read any of them without a further gesture — that is what makes
browsing possible — and, for the durable shape, it can do so again after a restart.

What has not changed is where the bytes go: **nowhere**. §11 holds exactly as it held for a dropped
file. A local folder is read in place, a slice at a time, by code on the reader's own machine; a
bucket is read by the browser from the bucket. There is no server in between because there is no
server. Every connected folder is a line in the stored-data screen with the file grants, revocable
one at a time or all at once — which is the same bargain `state/handles.ts` already struck for a
single file, made visible at the wider grant.

In the standalone build (§19) the bucket half is absent — the origin is opaque, so every remote read
fails before a byte moves — and the local half is the snapshot shape, since the File System Access
API is not available to an opaque origin either.

## 21. Embedded in another page

Not a sixth build: the same web build, mounted differently. `?embed=1` renders **one view of one
file with no window around it**, so the app can be what it has never been able to be — the figure
*inside* somebody else's page: a portal, a lab's site, a paper's supplementary material, a course
page. `src/embed.ts` is the only module that reads the flag; everything downstream asks it.

**Nothing has to be installed at either end, and that is a consequence of §1 rather than a feature
added on top.** There is no backend to point at and no package to depend on, so an embed is an
`<iframe src=…>` and nothing else. Three properties this app already had are what make that work,
and each is load-bearing:

- **No `Cross-Origin-Opener-Policy` or `Cross-Origin-Embedder-Policy`, and no `SharedArrayBuffer`**
  (docs/deploy.md). This is the usual reason a wasm application *cannot* be embedded — cross-origin
  isolation has to be arranged by the *host* page and almost never is. h5wasm 0.10.x is
  single-threaded with the binary inlined, so there is nothing to isolate.
- **Every view state is in the hash** (§5.5), so what to show is sayable in the `src=`.
- **Every push is archived at `…/v/<commit>/`** (docs/deploy.md), so an embed can name an immutable
  build and go on rendering the same picture in five years. A figure in a paper should be pinned;
  the root is for a page that wants the newest.

The data host needs no new CORS entry per embedding site: a frame's requests carry the **frame's**
origin, which is the viewer's, so §11's hosting requirements are exactly as they were.

### 21.1 What decides what an embed shows

Three seeds, in the order they override one another, and each is reached only because the ones above
it said nothing: a **shared session** in the fragment (`#s=`, a whole workspace deflated into the
URL); a **view state** in the fragment (`#uri=…`, which is what a navigation leaves behind, so it has
to beat the `src=` or every reload would undo the reader's last click); and **`?config=<url>`**, a
published `.metacooler.json` fetched and opened through `Session.openConfigUrl` — the same road the
picker's own URL box takes, so a seeded session and a chosen one differ in nothing after the fetch.
With none of the three, an embed is the file picker, which is a legitimate thing to embed.

`?config=` is the pointer form of what `#s=` carries as a payload. A payload cannot be changed once
the embed is published and grows the URL by the size of the session; a pointer is a file on a bucket,
editable afterwards, of no length, and — because the names inside it resolve against its own URL
(`state/SessionConfig.ts`'s `resolveConfig`) — self-contained enough to be copied to another bucket with its data. Both are
read by one parser.

A relative `?config=` resolves against the page it was named on. Only `http:` and `https:` are kept:
the value is about to be fetched, and the other schemes are the ones with no server on the other end.

### 21.2 What it keeps and what it drops, and why each one

- **The window furniture.** Header, tab strip, restore slot, status bar. The header is controls over
  a window; the tab strip offers tabs an embed does not keep; the restore slot offers *the reader's
  own* previous workspace, which inside an article would be six of their files on a page that never
  asked for them (§11); the status bar is a byte counter under a figure.
- **Three of the five columns.** Files is the places this window has been connected to (§20),
  General is a reference card about the file, and Analysis starts jobs and writes results — all
  three about the window and the work around it. **Annotations and Aesthetics stay**, because they
  are controls over the *picture*: which lanes are drawn, how they are coloured, scaled and clipped.
  A reader looking at somebody else's figure has every reason to reach for those two.

  They arrive **folded**, whatever anything else says, and stand as their own named spines on either
  edge. This one was measured rather than reasoned. A column is open unless it has been folded — a
  fresh browser has nothing stored, and a session may carry a layout of its own — so the first real
  embed of a published figure came up in a 1,200-pixel frame behind five open columns, with
  **thirty-two pixels of map** between them. An embed is a picture first.

  An embed's columns also neither read nor write the stored fold and width. Reading would open a
  column inside somebody's figure because the reader once left it open on the app's own site;
  writing would rearrange the application for a reader who opened a panel in a page they were only
  reading. Same rule as the window's memory above, one level down.

  Everything else — the view, the analysis drawer, the content area, dropping a file, every keyboard
  shortcut — is built exactly as it is for a top-level window, so no view knows it is embedded.
- **History entries.** A frame's `pushState` writes into the *joint* session history, so an embed
  that pushed would take over the reader's Back button: clicking a genome and pressing Back would
  step the map instead of leaving the page. Every write replaces. The bar is still written — a
  reload and a copied link both read it — only the stack is left alone.
- **A memory of itself.** Neither the `sessionStorage` tab strip (§5.6) nor the durable record
  under it (`state/workspace.ts`) is written. An embed is one view seeded by its URL and must show what the page says on
  every load; and a third-party frame's storage is partitioned per embedding site, so what it wrote
  would be a store the reader has no interface to and no way to clear.
- **The service worker and the version notice.** An embed is not an app to install, and a bar
  offering "take the newest build" across the top of somebody's figure is chrome by another name —
  and an offer only the page's author could accept, since they pinned the build on purpose.

**The File System Access API is unavailable to a cross-origin frame**, and in the way that is hardest
to see: the pickers are *present* and reject when called. Every capability gate in the app therefore
tests `crossOriginFrame()` as well as `typeof`, and a cross-origin embed takes the same fallbacks
Firefox and Safari have always taken — an `<input type="file">` for files, the snapshot shape for a
directory (§20). **Dropping is untouched**, so "drop your own file on this figure" is an embed a page
can offer. A same-origin frame is deliberately not caught: the pickers work there.

### 21.3 The one bar it has

Not a smaller header: the breadcrumb row with three things added, and what is on it is what a figure
in somebody else's page owes its reader.

**The mark and the name**, left. In a window the brand is the way home — back to the picker, which is
one click away and catastrophic in a frame, since it would throw away the figure the page named with
no back button to return by (§21.2). So it is a link *out*: this same view in the full application, in
a new tab, with `embed` dropped from the query string and the fragment carried across untouched. Its
address is rewritten on every navigation, so copying it copies where the reader actually is.

**The file and where they are in it**, next: the ordinary breadcrumb (§5.5), in the same slot the
session fills in a window, with its own frame taken off so the row reads as one bar.

**The two panel toggles and About**, right. The toggles are the panels' *own* buttons — the same
objects the header holds in a window, so there is one fold path and not a second written for frames —
and each hides itself when its column has nothing to show. About is the same dialog the header opens,
and it is the answer to every question this bar raises: what this viewer is, that nothing is uploaded
(§11), which build is in the frame, and where the source is. An embedded figure that could not say
those four things would be asking a reader to trust a picture with no provenance.

### 21.4 The channel

An embed that can only be linked to is a picture. `postMessage` is the other half, and it is four
messages (`app/EmbedChannel.ts`). Out: `metacooler:ready`, once, carrying the protocol version and
the build and **nothing about the session**; and `metacooler:state`, the view state as the hash is
written from. In: `metacooler:where`, answered with the state; and `metacooler:navigate`, a **patch**
laid over what is on screen — `{ locus: … }` moves the browser without the host knowing what else is
in the state, a key sent as `null` is removed, and `state: null` is the picker.

Two rules decide the rest. **Only the window that framed this one is answered**, and only after it
has spoken — `ready` is the single exception and the reason the handshake terminates. Replies and
pushes go to the origin the host spoke from, never to `*`, because a reader can open *their own* file
in an embed and the URL that follows is not the host's to learn unless it asked to be told. An opaque
origin — a `file://` host, a sandboxed frame — cannot be named as a target, and is answered at the
window itself, which is the only address it has.

And a patch is **serialised and parsed back** through §5.5's reader rather than believed. It is an
object from another origin, so it is exactly as untrusted as a hand-edited link, and there is already
one reader that validates every key, clamps what needs clamping and drops what it does not recognise.
A `view` this build has never heard of falls back; a smoothing radius it does not offer is dropped;
an array where a genome name should be is not stringified into one. What the host is told afterwards
is where the view actually **went**, which for a trimmed patch is not always where it asked to go.
