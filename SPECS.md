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

C3 and C1 together mean the app can never *require* a companion file. C4 means a whole class of
code — run gathering, fallback query planners, `genome_extent` failure paths — is deleted rather
than written.

---

## 2. Scale assumptions

The architecture rests on one fact: **MAGs are small.** A bacterial genome is 2–6 Mb. At 5 kb bins
that is roughly 400–1,200 bins, so a single genome's intra-genome matrix is at most low millions of
cells and its non-zero pixels are a bounded, contiguous slice of `/pixels`.

Therefore, within a genome:

- the entire matrix is loaded in one bounded read and held in memory;
- pan and zoom are pure canvas operations with **zero** further I/O;
- no tiling, no LRU tile cache, no resolution pyramid, no progressive refinement.

This is the central architectural difference from HiGlass, which must stream a 3 Gb genome. The
complexity that streaming demands is not warranted here and is explicitly not built.

Two things break the assumption and are handled as exceptions, not as the general case:
`__unbinned__` (§7.4) and non-metagenomic cooler files (§9).

---

## 3. Accepted inputs

### 3.1 Detection order

Attribute-based, in this order. Order matters: **a `.metacool` also satisfies cooler's `is_cooler()`**
because of the `/chroms → /contigs` soft link and `format = "HDF5::Cooler"`, so testing for cooler
first would silently downgrade every metacool to a contig-only view.

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

Zoom and pan operate on the in-memory matrix — no I/O. Level toggle between bin and contig
aggregation, both computed locally from the loaded data.

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

One colour scale by default, because the same colour meaning the same count is the stronger claim.
A **match-depth** option scales the second file so its 99th percentile meets the first's — the same
order statistic §7.1 picks `vmax` with — for the case that motivates it, two libraries of different
depth. Two colourbars then read the same colours in each file's own counts.

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

The gestures are the map's, deliberately (§7.2): a drag pans, Option-drag selects a range to zoom
into, the wheel zooms about the pointer, a double click fits, a lane's border resizes it and its body
reorders the stack. Two are the browser's own. ⌘-scroll over a lane moves *that* track's ceiling,
because it is the adjustment a genome browser is asked for constantly and a map has no analogue for
it. And a drag on the **ruler** selects a range to zoom into with no modifier at all: the coordinate
strip is where a reader points to say "this much", and it is the one gesture whose meaning its
position already settles, so spending a keystroke on it buys nothing.

**The plot is the whole column, not the stack.** The canvas reaches the foot of the column rather
than the foot of the last lane, so pointing anywhere under the tracks names a coordinate, draws the
crosshair and reads every track at it — the axis does not stop where the tracks do, and a view with
two lanes in a tall window would otherwise have a screenful of surface that answers nothing. It stops
at the **start of the axis**, though: the strip before it is the handles' margin and, when it is on,
the track names' column, and neither is a position — so the line stops there and the readout says
nothing, rather than naming a base pair while the arrowhead is on a word. The height is a screen
fact only; a figure is a picture of the tracks, and blank paper under them is not part of it.

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

**String columns.** metacooler writes `name` columns as fixed-length `S<n>`, sized by **UTF-8 encoded
byte length** rather than character count (`_str_to_hdf5`), precisely so multi-byte characters are not
truncated. Decode with `TextDecoder('utf-8')` and strip trailing NUL padding; never assume ASCII.
`CORE_COLUMN_KINDS` also permits kinds `O` and `U`, so a file produced by `create cool` may carry
variable-length strings instead — handle both.

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
  view change, with manual override
- separators at genome or contig boundaries, thin grey
- ticks in base pairs on any axis that stays inside one contig, and the contig names on any axis that
  does not — `_bin_axis`'s rule, because a bin index is not a position and does not restart at zero
  where the block does

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

**Touch is a first-class input**, not a fallback: one finger pans, two pinch, a tap opens what it
lands on and a double tap refits. Below 34rem the app is one column — the plot as wide as the screen,
the legend on its side beneath it. Every control revealed by *pointing* — a tab's ×, a track's colour
— is shown outright under `(hover: none)`, because a control that appears on hover appears never
where there is no hover; and every one of them is inert while it is invisible, so a tap or a click
that lands where one is hidden reaches what is behind it rather than firing a button nobody saw.

**One grid, and one place it is decided.** A block larger than the picture is
coarsened **once, in the reader**, into cells that hold at most a capacity of bins
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

Three families, in `render/derive.ts` and `render/compare.ts`:

| Family | Offered as | Cost |
|---|---|---|
| **Normalisation** — VC, VC √, ICE | entries in the score picker (§7.1's control) | one to a few dozen passes over the block |
| **Baseline** — observed / expected | a toggle of its own | two passes |
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

**Normalisation and baseline compose, and their order is fixed.** Normalise first: the decay curve is
an average over cells, so measuring it before the coverage bias is out means measuring it partly on
the bias, and every cell of a badly-covered bin is then compared against a baseline its own
under-coverage helped set. This is cooltools' order, for the same reason.

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
`oe`, and the comparison is `op`. All three are part of *what is being looked at* rather than how it
is shaded, so §11's rule applies: a recipient sees the numbers the sender saw.

---

## 8. Tracks and annotations

A contact map is read against what is on the sequence: genes, peaks, coverage, called loops. This
section is the whole of that surface. It is **restricted to cool and mcool** — see §8.5 — and it is
additive: a file with no annotations loaded behaves exactly as it did before this section existed.

### 8.1 The three cards

Three cards in the left sidebar, above Binning QC, in this order. Each is absent — not disabled, not
empty — on a file that cannot carry them.

**Linear annotations.** Three drop areas, and everything they hold is drawn *beside* the map, never
on it: **one GTF** (at most one, because a second gene model over the first is a smear rather than a
comparison), **tracks** (bigWig, any number, resolved as lines or areas), and **bed-like files** (any
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

**Manual annotations.** Marks the reader draws themselves: any number of lines (vertical, horizontal
or both) and arrowheads (on- or off-diagonal), each entered as coordinates or picked by clicking the
map. This is the card that makes a figure, and nothing in it comes from a file.

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

### 8.5 cool and mcool only — and genomes with no map

Every card, every lane and every overlay is gated on the file having no genome layer — which is
exactly "this is a cooler" (§9). On a `.metacool` or `.mmetacool` they are not rendered at all.

The gate is about the *genome layer*, not about there being a matrix. A session browsing an assembly
with no map (§5.8) offers the same cards for the same reason the cooler does: one assembly, one
namespace of sequence names, and an overlap report that means something.

The reason is not squeamishness about effort. A metacool's axis is thousands of contigs from
thousands of *different organisms*, assembled independently; a bigWig or a GTF is keyed on contig
names that belong to one assembly, so the overlap is either a coincidence or a mistake, and drawing a
gene model across a MAG boundary would assert a coordinate system that does not exist. The honest
answer is to not offer it.

### 8.6 Persistence

The loaded set, and every per-annotation setting, is remembered per file in `UiMemory` — the same
session-scoped store the table filters use. Deliberately **not** in the URL hash: §5.5 shares *what is
being looked at*, a dropped local file cannot be re-read after a reload in any browser, and a link
that arrived carrying half an annotation set would be worse than one carrying none.

The key is the **session** and the URI, not the URI alone (§5.6). Two tabs on one file are two
workspaces and must not adopt each other's tracks.

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

### 8.9 Four edges, and the 4C lane that proves it

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

**The virtual 4C profile is a lane.** A 4C experiment fixes one locus and asks what it touches; a
contact map already contains the answer for every locus at once, and extracting one is a band of the
matrix summed (`render/viewpoint.ts`). Shift-dragging on the map names the anchor, as a locus rather
than as rows, so it survives a pan, a zoom, a change of resolution and a change of view.

What makes it a *lane* rather than a strip of its own is the whole of the design: it is a synthetic
entry in the same `AnnotationStore`, so renaming it, typing its limits, handing its axis back to the
data, dragging its ceiling, dragging its floor to resize it, dragging its handle to reorder it or to
move it to another edge, reading it in the tooltip and drawing it into an exported figure are all the
one implementation every other lane uses. It carries no file, so it is on no card, is never
persisted, and is not drawn in the 1D browser — and because it is computed from the block already on
screen rather than fetched, it is the one lane that draws on a block with no coordinate system at
all.

Moving it to another edge is not a rotation but a different question. A strip above or below the map
sums a band of **rows** and answers per column; a strip beside it sums a band of **columns** and
answers per row. Same anchor, same block, the transpose — which off the diagonal may have an answer
on one axis and none on the other, and the lane says so.

The lane also marks **where its anchor is on its own axis**, as a short bar in a gutter it keeps
clear off its floor — the one end of a lane the signal never reaches. The band being summed is on the
other axis and is therefore nowhere in the picture; this is the complementary fact, and it is the one
a reader keeps asking for, because on a map read about its diagonal it is where the self-contact peak
ought to be. Off the diagonal the anchor may name a sequence this axis does not carry, and then there
is no mark.

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
  drive the zoom control exactly as mmetacool entries do. An `.mcool` addressed at its **root** is
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
| Pan/zoom within a loaded genome | 0 requests, 60 fps |
| Genome-pair block | ≤ 5 range requests |
| Time to interactive, cold, remote | ≤ 3 s on a typical connection |

If metadata reads explode, the known cause is walking HDF5's object hierarchy;
`hdf5-indexed-reader` addresses it with a pre-built path → offset index and was built for `.cndb`
chromatin files. Held in reserve — adopting it would not change any file format, only the reader.

---

## 13. Explicit non-features

Stated so they are decisions rather than omissions: tile server; user accounts; file upload; server-side
computation of any kind; required companion files; required preprocessing; support for orderings other
than `genome-then-length`; whole-genome views that do not fit in memory (§9 — the limit is measured,
not a category); write access of any kind, in either target; an auto-update service; and a desktop
build with a feature set of its own — the package is a delivery mechanism, and the formats, views
and operations are the same in both targets.

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
| cool / mcool | **Native; whole-genome where it fits** (§9) | The tiling architecture §2 exists to avoid — a block either fits in one read or is refused, and there is no third path — and, since the reader went native, the synthesised one-genome table and the `synthesised` flag every view carried |

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
