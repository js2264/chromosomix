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
  absolute: a block read once, and a zoom that magnifies it. Refinement is a palette command — *Refine
  on zoom* — rather than a switch on a map's picture row, which holds the turn and the baseline: the
  preference is one setting for the whole window, and a control on one map of a deck would claim it
  was that map's. A zoom that reads is a zoom that can wait, and a wait nobody asked for is a surprise
  rather than a feature.

Two things break the assumption and are handled as exceptions, not as the general case:
`__unbinned__` (§7.4) and non-metagenomic cooler files (§9).

---

## 3. Accepted inputs

### 3.1 Detection order

**Magic bytes first, attributes second.** Not every accepted file is HDF5: a `.hic` (§3.6) is a flat
binary container, and asking h5wasm to open one produces a stack trace rather than the sentence §10
requires. So the first four bytes decide the *container* before any attribute is read.

0. bytes `48 49 43 00` (`HIC\0`) → **hic** (§3.6), and nothing below is consulted
0b. bytes `1f 8b` (gzip, which BGZF also is) → not HDF5 in any case, so the first line is decoded:
    `## pairs format` → **pairs** (§3.7), refused with `pairs-binning-needed` until a resolution is
    chosen. Anything else gzipped is refused *here* rather than handed to h5wasm, whose answer to a
    request for a non-HDF5 file's attributes is `error - name not defined!` — a sentence about
    nothing the reader did
0c. a first line of `## pairs format` with no compression → **pairs**, as above

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

**The reader may add rungs the file has not got.** The ladder in a file is whatever the person who
ran `zoomify` chose to write — the default doubles, and a great many published `.mcool`s stop
wherever that person stopped. So a reader who wants a 10 kb picture of a file whose coarsest rung is
4 kb has had two options, and both are bad: look at 4 kb and squint, or leave the application, run
`cooler coarsen`, and come back. There is a third, and it costs nothing: **a 10 kb bin is ten 1 kb
bins added up**. This viewer has summed consecutive bins into one cell since its whole-genome view
was written (§7.2); what was missing was a way to *ask* for a particular grid rather than have one
fitted to the screen.

A `+` past the coarse end of the resolution picker asks for one. What can be given is exactly what
is **a whole number of some stored rung's bins**: on a `1 / 2 / 5 / 10 kb` ladder, 3 kb is three 1 kb
bins — perfectly ordinary, and not a rung anybody would have written, which is why it is worth
offering — while 2.5 kb is two and a half, and there is no such thing. A contact is recorded in a
bin and not at a position inside one, so half a bin's contacts cannot be separated from the other
half. The refusal is a fact about the format rather than a limitation here, and the dialog says so
in those words as the number is typed, because *2.5 kb is not a whole number of bins of any
resolution this file carries* tells a reader to type 2 or 3 and "invalid resolution" does not.
Several rungs may divide a target — 20 kb is twenty 1 kb bins or two 10 kb ones — and the **coarsest**
is taken: same picture, a twentieth of the stored pixels walked, and on a `--balance`d file the
values summed are the ones balanced closest to the resolution asked for.

Three properties make it a resolution rather than a rendering:

- **The grid is the sequence's.** Cells fall at `contigStart + m·k` whatever window was asked for
  (`snapToGrid`), so the same base pair lands in the same cell holding the same sum at every zoom
  and every pan — which is what a cooler at that resolution would also give, and what a grid
  anchored to the request would not.
- **It holds.** The zoom-to-refine ladder takes it as a floor and never reads past it; the
  whole-genome view takes it as a floor too, and its own plan still wins where the picture cannot
  hold that many cells, with the summary saying which.
- **It is in the link.** `coarsen=` beside `balance=` and `level=`, because a 10 kb map and a 1 kb
  map of one window are different pictures. Which resolutions a reader has *added* is a different
  question — a fact about the file, like which sequences they declared circular — and travels with
  the tracks they loaded (§8.15's argument, restated).

A derived rung wears a **`*`** in the picker, in the label rather than beside it, because the number
is what somebody quotes in a methods section and `3 kb` would be a resolution this file does not
contain. It sorts where its number says — 3 kb before 5 kb — since a ladder whose order is not its
resolutions' order is a lie about which of two pictures is coarser, and it carries a `×`, which the
file's own rungs do not: they are not the reader's to remove, and that asymmetry is the second thing
the `*` is saying.

**Otherwise it is drawn exactly as a stored rung is**, and the `×` takes no room until it is wanted.
A derived rung used to carry a dashed border whether or not it was the one being read, so a row of
four added rungs was four outlined chips beside one stored rung with no outline at all — the thing
the file *does* contain being the quiet one — and each of them reserved fourteen pixels for a `×`
that only appeared under the pointer, which made the row look padded for no reason a reader could
see. So: no border when it is not current, a **dotted** border where a stored rung's is solid, and a
`×` at zero width that the hovered rung grows to hold, pushing the rungs after it along. It keeps its
width rather than being undisplayed, because a button that is not displayed cannot be tabbed to and
this one is the only way back off a rung.

**Past nine rungs the row is a dropdown** beside the word, listing every rung in the ladder's own
order. It was a slider and one chip: between them they said how many rungs there were and which one
was being read, and named the rest only to a reader who hovered the slider's own tooltip — so the
control that was there to save room was also the one that hid the ladder. A `<select>` cannot hold a
button, so where the rung being read is the reader's own the `×` follows the picker.

**One caveat, always printed.** Counts coarsen *exactly*: a contact is in one fine bin and therefore
in one coarse bin, so the sum is the count. Balanced values do not. `cooler zoomify --balance` sums
the raw counts and then balances the coarse matrix at its own resolution, producing new weights;
summing balanced values instead applies the fine weights and adds the results. That is what every
aggregation in this field does and it is a good estimate — it is not the same number, and a reader
comparing a derived 10 kb map with a colleague's `zoomify`d one is owed the distinction. Which is
also why a stored rung always wins: a derived resolution that duplicates one is refused rather than
quietly shadowing it, and `chooseRung` still prefers a real rung for every read that is not held to
a declared grid (§9).

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
bounded read, tracks and annotations are offered (§8.5), and every §18 task but the metagenome four applies.
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

### 3.7 `.pairs` — imported, not opened

A 4DN `.pairs` file — plain, gzipped or bgzipped, with a `.px2` beside it or without one — is
accepted, and it is the only input that is **imported** rather than opened. Everything else in §3
is a matrix in a container; a pairs file is a list of contacts, and the difference decides the whole
of how it behaves.

**Why it cannot simply be opened.** Every other container states its resolutions: a cooler has one,
an `.mcool` and an `.mmetacool` list theirs, a `.hic` carries a ladder. A pairs file has none. The
grid is not in the file and cannot be inferred from it — a grid guessed from the largest coordinate
observed would differ between two subsamples of the same library, which is the one way of being
wrong that survives every check downstream and makes two files silently incomparable. So the first
open is **refused**, with `pairs-binning-needed`, and the refusal carries what a choice needs: the
sequences, the assembly, the record count where an index supplied one, and a suggested base
resolution. The app turns that into a dialog and opens again. It is the same two-step an `.mcool`
addressed at its root already takes (§3.4); what differs is only that a collection's answer is in
the file and this one is not.

**The cost is the framing, not the format.** A `.pairs.gz` is BGZF — a sequence of
independently-deflated members — and **Chromium's `DecompressionStream('gzip')` will not walk them**:
it stops after the first and throws `Junk found after end of compressed data.` Since BGZF's
end-of-file marker is itself an empty second member, that is true of every bgzipped file, not just a
large one. So members are decompressed one at a time, which is what the format is.

What that costs depends entirely on how finely the file was framed, because a deflate stream has a
fixed cost however little it carries. Inflate alone, measured in Chromium: **260 MB/s** at the 64 KiB
members `bgzip` writes, **78 MB/s** at the ~1.4 KB members `demo/ecoli/SRR19500734.pairs.gz` has —
165,000 of them. That ceiling belongs to deflate rather than to the browser API: `fflate`'s pure-JS
inflate measures 76 MB/s on the same members, so a dependency would buy nothing, and issuing members
concurrently is slower still. **Re-blocking a finely framed file is the fix that works**
(`bgzip -d < f.pairs.gz | bgzip > g.pairs.gz`), and the app says so rather than pretending the
difference is not there.

**One pass, and then it is a cooler.** The chosen resolution is binned in a single streaming pass
over the records, and every rung above it is derived from that table rather than from the file. The
result is held in memory and *is* the map: every view, the deck, the turn and every §18 task
read it through `PixelStore` exactly as they read a cooler, and none of them learns that the
container exists. **The second mount pays for that a second time**, and it is worth saying where
the cost is rather than leaving it to be discovered: the analysis worker opens the file for itself
(§18.3), a contact list has no index to reach into, and so a task on an imported map re-reads the
records once — behind the same bar and the same cancel the first pass had, once per session, with
every task after it answered from memory. The binning the reader chose travels with the job rather
than being asked again, because it is the same question and they have already answered it. The shape that makes this the right design is the data's own — on this
repository's demo files, yeast Micro-C is 179 M records and 13.7 M stored pixels at 1 kb, and the
mock community is 10.9 M records and 7.1 M pixels. **The input is gigabytes and the output is tens
of megabytes.** Pay for the file once; answer from memory afterwards.

This is §2's assumption honoured rather than bent. The pass is bounded, has a denominator, reports
progress and can be called off — §18's "one streaming pass with progress, cancel and a pre-flight
estimate", applied at open rather than to a task — and nothing after it costs a read at all.

**A fuller citizen than a `.hic`.** Because the file *was* read, the per-bin pixel index is a
by-product rather than a whole-file scan, so `binOffsets()` answers where `HicStore`'s refuses,
`nnz` is a real number rather than `null`, and no code downstream carries a branch for the case
where it is not.

**Three things the header decides, and one it cannot.**

- **`#chromsize:` is the bin table**, and is required by name. `#samheader: @SQ` is accepted as a
  fallback because pairtools writes both. A file with neither is refused with the command that adds
  them.
- **`#columns:` is honoured, never assumed.** The spec fixes an order and then permits any other;
  pairtools writes `chrom1` where the spec writes `chr1`, and real files carry extra columns and
  different orders. The spec's order is the fallback when no `#columns:` line is present.
- **Positions are 1-based**, per the spec and per `cooler cload pairs`. This is one subtraction and
  getting it wrong shifts every record at a bin boundary into its neighbour — invisible in a
  picture, permanent in a written file.
- **What it cannot decide is the genome layer.** `#chromsize:` has no concept of one, so an
  imported map is a **cooler-class citizen** in §9's sense: the contigs table is the landing view,
  `genomes` is `null`, and the four metagenome tasks are absent rather than disabled. Getting the
  MAG layer needs the contig and genome tables `metacooler create pairs` takes, and requiring those
  would be a second companion file — which is C3's line, and it is not crossed.

**The index is opportunistic, in §3.4's exact sense.** A `.px2` makes the import's cost knowable
before it starts — the pairix header carries an exact record count, which no other Hi-C container
hands over — and lets the import be scoped to a set of chromosome pairs. Without one, the file is
read whole and the progress bar counts compressed bytes instead. Both work; the index only ever
makes the same file cheaper. It is **not** §8.13's case: a pairs file has a whole-file fallback that
respects §12, so its absence is never a refusal.

**What is deliberately not read**: ~~the strand, pair-type and mapping-quality columns, and any
filtering on them.~~ **Narrowed**: the pair-type and mapping-quality columns, and **any filtering
at all**. A pairs file is the output of a pipeline that has already made those decisions, and
re-making them here would be the second application §13 refuses — the importer counts the records
the file contains, and if a reader wants different records they filter with `pairtools select` and
import the result. Nothing is inferred about restriction fragments, and no matrix is
ever built from alignments (§13); a `.pairs` is a contact list, which is a different thing and is
the reason this fits.

**The strands are read, and what the original rule was about is untouched.** The rule's reason was
*filtering*: a viewer that decided which records count would be re-making a pipeline's decisions.
Reading `strand1` and `strand2` decides nothing. No strand reaches a bin, a pixel, a rung or the
written `.mcool`; no record is kept or dropped for one; every number the matrix is built from is
identical whether the columns are there or not, and that is asserted rather than claimed
(`test/unit/pairs-bin.test.ts`). What they are read *for* is a **curve beside** the matrix: the four
orientation-resolved decays, counted in the import's own pass, at record resolution rather than on
the grid the reader chose.

It is worth the narrowing for one reason. The separation at which `++`, `+−`, `−+` and `−−`
converge is the **shortest separation a library can be believed at** — below it the counts are
self-circles, dangling ends and undigested fragments, each landing in one orientation and not the
others — and it is the one reading that binning destroys, because a bin sums the four together. It
is also usually *below* the grid somebody chose, which is why a curve on the map's bins could not
answer it. Every pairs-level QC in the field plots it; nothing that opens a matrix can.

The cost is two more fields off a record the loop is already walking, and the columns are optional:
a file trimmed to five columns imports exactly as before and simply has no such curve. Reported and
never acted on — nothing trims a file, sets a minimum separation, or warns that a map was binned
below the convergence point, because a threshold is a method with choices in it and §18.9's
argument about a half-good caller applies to one exactly as it applies to a loop. Where the figure
lives is §18.8, under P(s).

**Equivalence with a cooler is asserted, not assumed.** An imported map and the `.mcool` written
from it must answer *every* `PixelStore` method identically — `forEachWindow` on and off the
diagonal, `forEachBands`, `scanAll` and `binOffsets`. That is the property every view and every
§18 task actually depends on, and the way it would fail is the way that matters: not an
error, but one number differing for whichever tasks happen to use the method that diverged.

**An incomplete file is reported, not drawn in silence.** A BGZF file says where each of its
members ends and marks its own end with an empty one, so a file that stops mid-member or carries no
end-of-file marker was never finished — a cancelled upload, an interrupted `bgzip`, a partial copy.
Every record that did arrive is binned and drawn, because it is real; what is refused is doing that
*quietly*. Nothing in a contact map distinguishes *this library has no contacts on chromosome XIII*
from *this file stops before chromosome XIII*, and a reader cannot be left to work out which.

Reported alongside it: sequences with **nothing on their own diagonal**. That is the visible form of
the same fact — a diagonal is a map's most populated feature and a sequence without one is missing
from the data — and it is deliberately not "sequences no record named", which the file this was
written for would have passed: a list sorted by first chromosome and then cut still mentions the
sequences it never reaches, as the *second* chromosome of a trans contact.

A plain `.gz` gets no such claim. It carries no framing this side can check, and silence there means
*unknown* rather than *whole*.

**Correctness.** The binning is checked against a second implementation of the same arithmetic,
written the slow obvious way, over sorted, shuffled, gzipped, bgzipped and uncompressed files, at
contig boundaries and short final bins. The written `.mcool` is checked twice — read back through
this app's own reader, and compared cell for cell against that same independent binning — because a
round trip alone only proves the reader and the writer agree, which is exactly what they did about
`.hic` endianness (§3.6).

---

### 3.8 `.scool` — one file, many cells, summed

The single-cell container from [Wolff *et al.* 2021](https://academic.oup.com/bioinformatics/article/37/14/2053/5948994).
One cooler per cell over **one shared bin space**, and that shared bin space is the whole of the
design here: every cell indexes the same bins, so a bin id means the same thing in all of them, and a
set of cells is one map of one genome with their contacts added together.

**Two layouts, and neither is the special case.** The format was standardised in cooler 0.8.11 and
files predating it are the majority of what exists, so both are read and both are tested at every
step:

| | standard (`cooler.create_scool`) | flat (HiCMatrix, scHiCExplorer) |
|---|---|---|
| root `format` | `HDF5::SCOOL` | `HDF5::Cooler` |
| root attributes | `ncells`, `nbins`, `bin-size`, … | provenance only — none of them |
| shared tables | `/chroms` and `/bins`, hard-linked into each cell | absent; every cell carries its own copy |
| cells | `/cells/<name>` | the root's own children |

A standard container announces itself. A flat one cannot, and is recognised by **elimination**: it is
HDF5, it is not a cooler (no `/bins`, `/pixels` or `/indexes` of its own), not an mcool, not an
mmetacool, not a metacool — every one of those a single link lookup — and its first child is a
cooler. Nothing lists anything to decide this, which matters for the gate below.

**`ncells` is never consulted, even where it exists.** It is a count, and what a reader needs is the
*names*: a count cannot be ticked, cannot be sorted by depth, and is simply not written by the older
layout. One listing answers both questions.

**The cells table is the landing view** (§5.1's sibling), with `name`, `nnz` and `sum` leading —
every cooler writes the latter two, and depth is the axis that separates a usable cell from an empty
one. Columns are discovered exactly as the genomes table's are, with one addition: an attribute every
cell *agrees* on is dropped, because it describes the file rather than the cell and a column repeating
one value four thousand times cannot be sorted or filtered.

**A tick adds; it does not arrange.** This is the one thing about the view a reader could get wrong,
so the button says *sum* and the hint says it in words. Ticking genomes lays them beside each other —
each on the diagonal, the blocks between them off it. Ticking cells adds them up.

**The sum needs no arithmetic.** `scatterDense` is additive and per-pixel — it has to be anyway, since
a bounded rectangle may arrive in several chunks — so a store that hands one callback every selected
cell's chunks in turn *is* their sum: no summing code, no intermediate matrix, and a peak footprint of
one chunk. The same holds for the two other things a store answers. `nnz` is a total over the set, and
`bin1_offset` is a cumulative count, so the element-wise sum of the cells' own index arrays is the
cumulative count of the summed pixels — which is why the density proxy, the band planner and the
selection read all work over a cell set without knowing one is there.

**The set is a property of the file, not of the view.** It survives navigating into a chromosome and
back out, and it is carried in the link (`cells=`), with `*` for *all of them* — four thousand names
is not a URL, and "every cell" is the one selection whose meaning does not depend on the file's
contents. A view with no `cells` is the pseudo-bulk, which is what an scool dropped and pressed
through means. The breadcrumb names it in every view, because a map summed from one cell and a map
summed from four thousand are different experiments and the difference must not be inferrable only
from the picture.

**Balancing is by the shared bins or not at all.** Raw counts are summed and the file's shared
`/bins/weight` is applied once to the result, which is cooler's own definition of a balanced matrix
applied to the pseudo-bulk that was asked for. Balancing each cell before summing would make the
result something other than a contact count, and the flat layout has no shared bins to balance by, so
it is offered only when a shared weight column is there. One cell of an scool is addressable as a
plain cooler — `file.scool::/cells/<name>` — and behaves exactly like one, weights included.

**The open is gated, and it is the only read in this application that is** (§12). A container's cell
*names* live in the group's HDF5 link storage, which the library allocates as members are added —
immediately after each cell's pixels, for every writer that exists. The index of the file is therefore
interleaved with its data rather than gathered anywhere. Measured on the 3,882-cell Nagano 2017 file:
listing the cells is **1,015 reads averaging 512 bytes, spread uniformly across all 327 MB**. It is
not a quirk of that writer — a container written by `cooler.create_scool` behaves the same way, and a
synthetic 800-cell, 50 MB one touches all 48 of its megabyte blocks.

So there is no chunk size that wins: the reads are ~500 bytes about 320 KB apart, so any chunk large
enough to coalesce them is large enough to fetch the file, and any chunk small enough to avoid that
needs a round trip each. The reader is asked which to pay — one download, or a thousand small requests
— with the numbers on the buttons, and told that a local copy costs neither. **A local file is never
asked**, because the question is about round trips and a file on disk seeks for free.

**The two waits it costs, and what each can say.** The download, when that is what was chosen, is
reported in bytes with a cancel, exactly as §3.9's is. The listing itself cannot be: it is a single
call into HDF5 that issues its thousand small reads and returns when it has them, so the thread is
not free to report anything until it already has the answer. What it can say is *which* wait it is,
before it starts — an indeterminate bar under the name of the phase, which is the difference between
a reader who knows a thousand reads are in flight and one watching a spinner.

**A task measures the cells that are ticked.** The analysis worker mounts the file independently of
the reader's, so it has to be *told* the selection — without it a task opened the pseudo-bulk and
answered a question about two cells with the number for four thousand, which is a worse failure than
an error because nothing on screen contradicts it. The set travels with the run's target, and that
worker's mount is keyed on the cells as well as on the file: re-ticking is a new map at the same URI.

**One task measures the cells themselves**, and it is the exception the sentence above needs rather
than a contradiction of it. Per-cell contact QC (§18.8) is the only task whose unit is a cell: it
walks each of them separately and reports a row apiece, so *the ticked set* is what it is helping
the reader choose rather than what it measures — and it therefore defaults to every cell in the
file, restoring the selection afterwards. It costs what summing the same cells costs, to the read:
the same reads in the same order, with one accumulator per cell instead of one shared, which is why
a reader who has agreed to a pseudo-bulk has already agreed to this.

**Summing says how far it has got.** A cell sum is the only read here whose cost is linear in
something other than the picture asked for: the same window that draws instantly over one cell is
four thousand small reads over a whole file. So the fan-out counts cells — `summing 1,204 of 3,882
cells…` — on the veil in front of the map, and the whole-file view's own bar names cells rather than
pixels when cells are what it is counting. The store is told where to report; nothing between it and
the view layer learns that this file has cells.

The consolation is that the listing is the *only* cost. Every cell's attribute block sits in metadata
the listing already brought across — measured at **zero** additional source chunks on both files — so
the cells table's columns are free once the names are paid for, and a per-cell map is 2,802 stored
pixels on the Nagano file and reads instantly.

---

### 3.9 HiC-Pro — two text files, and the index that is not there

A HiC-Pro contact map is a pair, documented in that pipeline's own `RESULTS.md`:

- **`<prefix>_<res>_abs.bed`** — `chrom  start  end  binID`, one row per bin of the whole genome,
  where `binID` is **1-based and global**: it runs continuously across sequences rather than
  restarting at each;
- **`<prefix>_<res>.matrix`** — `binA  binB  count`, one row per non-zero pixel, naming those ids.
  `MATRIX_FORMAT` decides which half is stored: `upper` (the default), `lower`, `complete`, or
  `asis`.

The BED **is** a `/bins` table, and run-length encoding its first column gives the `/chroms` table
and `indexes/chrom_offset` this application is written against. The matrix **is** `/pixels`. What
the pair does not have is `indexes/bin1_offset`, and that single absence is the whole of what makes
this container different from every other one here.

**It is read whole, once, and then it is a cooler.** There is no index and no index that could be
derived without reading everything: the rows are text of variable width, so byte offset and bin id
have no relation, and `asis` says outright that they need not even be sorted. So a region cannot be
a bounded read, and pretending otherwise would mean scanning the file *per view* rather than once.
The answer is to pay it at open and hand the rest of the application exactly what it already uses —
two stable counting sorts — by column, then by row —
produce the sorted triplets and the cumulative index together, the second pass's bucket boundaries
*being* `bin1_offset`. Measured: **6.8 M pixels/s (≈100 MB/s)** parsing, and 12 bytes per pixel held
against about 15 as text.

A radix sort rather than a sort per row band, and the difference is not academic: bands are wide — a
row of a 100 kb human matrix has thousands of non-zero columns — so sorting each on its own is
quadratic in that width. On a 211 MB file it was 59 seconds against 3.7.

**So there is no `HicProStore`, and there should not be one.** This is where the container differs
from `.hic`, which cannot answer `pixels/*` or `indexes/bin1_offset` and needs a `PixelStore` of its
own. Here those datasets are served honestly from the parsed arrays and `CoolerStore` reads them
unchanged: the pixel path for a HiC-Pro map is the cooler path, byte for byte, and a second
implementation of it could only drift.

**All four `MATRIX_FORMAT` values open, and none of them is the special case.** The parser swaps the
ends of any pixel stored below the diagonal, so what reaches `planRead` and `scatterDense` is
upper-triangular whichever way the file was written. Two rows landing on one cell are not one case
but two, and they want opposite treatment: a **mirror** — `(a, b)` and `(b, a)`, which is what
`complete` writes — is one contact stated twice and the second is dropped, since adding it would
double every off-diagonal cell and leave the diagonal alone; a **repeat**, two rows on the same side,
is more evidence and is summed. Once both are upper-triangular they are indistinguishable, which is
why the side each row was *stored* on is carried as far as the collapse. It is one byte per pixel.

**The bin file is required, and is found three ways.** It is not a sidecar in §8.11's sense — a
`.tbi` is an optimisation and a `.bai` is a format's only bounded read, but an `_abs.bed` is the
matrix's coordinate system, so without it there is not a slower map or a refused one but *no map*.
So: dropped alongside the matrix, or picked out of a connected folder beside it, both through the
same rules that pair a BAM with its index; found by convention next to a URL, which is where
HiC-Pro writes it — `raw/` and `iced/` share one bed per resolution, so the `_iced` matrices are
probed against the raw directory's too; or named outright as `<matrix>#bins=<url>`, for a bucket
the convention cannot guess at. A matrix with none of the three is **refused by name**, and the
refusal says which of the three to reach for.

**The load is gated on bytes, not on being remote** (§12). Past 200 MB of matrix the reader is told
what the read will cost and that it is paid once — which is the part that turns a bad number into an
acceptable one. That threshold is a difference from §3.8's gate rather than an inconsistency: an
`.scool`'s cost is round trips, which a local file does not pay, and this one's is parsing and
memory, which it pays in full.

**The wait is watched and stoppable.** This and §3.8 are the only two opens in the application long
enough for anyone to want news of one, and both now report through the loading screen rather than a
spinner: bytes while the file comes across, pixels while it is parsed — two labelled sweeps rather
than one bar sliding between two denominators — and a **cancel** that stops the download mid-stream
and returns to the picker. Cancelling is an answer, not a failure, exactly as dismissing the gate is.
A 258 MB pair reads in about four seconds, three of them download.

**The parse's own trap, recorded because it is invisible.** The scan shared its integer reader with
`parseBins`, and V8 refuses to optimise a function whose inline caches are still moving —
`delaying optimization of scanSlice, IC changed`, once per tick, forever. Having parsed a bin file
first therefore left the matrix scan running *interpreted*: 35 seconds for a 258 MB file against 1.8
for the same arithmetic. The bins are parsed before the matrix in the application and never before it
in a test, so every measurement ever taken of this parser was of the fast path. The one hot loop
reads its own digits now, and that is not a duplicate to be tidied away later.

**Where it works, and where to convert instead.** The limit is the pixel count and nothing about the
format: about 100 M pixels is comfortable (≈1.5 GB of text, 15 s, 1.2 GB held), and past ~250 M it
is not a browser tab's job. That covers any small genome at any resolution, and human down to about
250 kb. Finer than that, `cooler load -f coo <bins> <matrix> out.cool` turns the very same two files
into a `.cool` which opens here in a handful of requests however large it is — and the panel says so.

**Two things are deliberately not read.** Fragment-level maps (`GENOME_FRAGMENT`), because a
fragment grid is variable bins under another name and §3.3 excludes those from the whole
application — refused with the config key that produced it. And the `.biases` file, because HiC-Pro's
biases normalise the *raw* matrix while its `iced/` matrix is the already-normalised one: a reader
that offered the first as a weight column would let somebody normalise twice. Open the `iced/`
matrix to see normalised counts, which is what it is for.

**Both threads open it the same way.** A contact map is mounted twice — once by
the reader worker that every view reads through, and once by the analysis worker so a long task
cannot block a pan (§18.3) — and the two have to agree about what a file *is*. They did not: the
reader grew this road and the analysis worker went on calling `MetaCooler.open`, so every task on a
HiC-Pro pair reached HDF5 with a `.matrix` and failed inside it with `error - name not defined!`.
The roads into a map now live in one module (`worker/open.ts`) that all three callers use — both
workers and the `metacooler-run` CLI — so a third container cannot be added to one and forgotten in
the others.

**Correctness.** The fixtures are written *from a cooler* and the manifest carries cooler's own dense
matrix, so the suite asserts that the two text files mean exactly the matrix they were written from —
a round trip through the format against the implementation this application is a port of. All four
`MATRIX_FORMAT` variants are checked against the same oracle, because only one of them is the common
case and that is how the other three come to be broken unnoticed.

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
genome view. Ticking any number of rows and pressing *show selected →* opens them as one map — each
on the diagonal, every pair's block off it (§5.3, §7.3). One ticked row is named on the button and
two are named as a pair, because a name says what is about to open where a count does not.

The four columns the format guarantees are labelled in the application's own words — `name`,
`length`, `contigs`, `bins` — with the file's identifier in the header's tooltip. Only those four:
a discovered column is the creator's to name and is rendered under the name they gave it, including
where that duplicates a core column, since a viewer that folded one away would be deciding a column
is redundant and would be wrong the first time the two disagreed.

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
2. otherwise a **contig**, optionally `contig:start-end` — the region *string* is cooler's
   (**0-based, half-open**, verified against `cooler.util.parse_region`, not the docstrings), and it
   is what the state, the hash and `metacooler show --range` carry
3. neither → error listing available genomes and contigs, truncated to ~20 of each

Genome and contig namespaces can collide; genome wins, as in Python. The UI labels which kind a
search matched.

**What a reader reads and types is the display form** (§26.1). The heading, the locus box's value
and the zoom steps' tooltips print `formatLocus` of that region string — `IV:1,000,001-1,400,000`,
1-based inclusive with grouped digits, which is what IGV, UCSC, samtools and every paper print — and
the box reads what was typed back through `typedLocusToRegion`, accepting every spelling the
tokenizer takes plus an en dash and Ensembl's `..`. All three used to print the region string
itself, so the heading and the block summary immediately under it named one window at two starts a
base apart, and a coordinate copied out of one and into the other moved the picture by a base. The
conversion sits at the box rather than on the reader: pressing Enter on the value the box is already
showing must change nothing, which is the round trip §26.1 states as a law. The box's example is
`locusPlaceholder`'s, like every other locus box (§26.6), written from this view's own noun —
`contig:1,000-20,000` — because a coordinate suffix on a genome name is an error here and the name
this view is of may be a genome's.

**Zoom is four buttons beside the box**, because what they change is the coordinate the box holds.
The scroll wheel on the map is a zoom of the *picture* — the same block, drawn larger or smaller —
and past the edge of what was read it stops. This is the other thing a genome browser means by
zooming: a different **range**, re-read, with the region string updated to say so. The four are
`10×` and `3×` out and `3×` and `10×` in, widest first, so the row reads as one axis of scale
with the current window in the middle of it; each one is the exact undo of the one opposite. Two
sizes rather than one because a single step is always wrong twice — three presses to leave a gene,
or one press past the locus — and they are ordinary bordered buttons like everything else in the
bar, since a control that is styled differently from its neighbours is a control a reader wonders
about.

**Every locus bar zooms in these same four steps**, and from the same pair — the region bar's, the
1D browser's and a deck's tracks cell's (§26.6). The browser's carried two unlabelled magnifiers at
1.8× instead, which is a factor nobody can predict or undo, so a reader who had learnt that one
press is 3× on the map got something else on the tracks beside it; and the `−` / `+` keys drive the
3× pair rather than a factor of their own. In a tracks cell the bar is the box and the four steps
alone: no `go`, since Enter submits and the lead's bar above the grid carries the button, and no `/`
badge, since one key cannot open two boxes and the lead's is the one it opens.

Every press moves the window about its own **centre**, which leaves what you were looking at in the
middle of what comes back. Against an end of the sequence the window slides in rather than asking
for a negative coordinate; once a press outward would cover the whole sequence it *is* the whole
sequence, named as such rather than spelled out in coordinates; inward it stops at the file's own
bin size, since a window narrower than a bin is a window the file cannot answer; and on a declared
circle (§8.15) it wraps past the origin rather than clamping, because a clamp would shove the window
sideways to fit inside a boundary the molecule has not got. Each button greys itself the moment
there is nothing in its direction to go to, and they navigate through the ordinary road, so three
presses and three presses of the back button are the same journey in reverse (§5.5).

The `‹ ›` pair **beside the title** is not that back arrow: it steps to the previous and next
sequence — the `[` and `]` keys as buttons (§5.5) — named by the neighbour it would open in its
tooltip, and greyed at either end, so a reader at the last sequence is told so rather than left
pressing a dead control. Two chevrons beside a title are the universal history pair, so the contract
has to say which of the two these are.

**And there is no back arrow in the bar, and no map/tracks cycle button.** Both were controls with
a shorter road already beside them: going back is the browser's own back, which the bar's
navigation has always fed, and *tracks only / map only / both* is the eye beside the map in the
column that lists what is drawn — where every other thing on screen is shown and hidden, one row at
a time, by the control that names it. A second way to do a thing is not a convenience when the
first way is a row the reader is already looking at; it is a control to learn, in the bar that has
to stay readable at a glance.

**Every dialog's body is inset from its panel, and no dialog has to remember it.** Each one names
its own body class, and each used to set its own padding — a rule spelled a dozen times, and the way
that shape fails is not subtle: a dialog written without the declaration comes out with its text
against the panel's border, looking broken, with nothing anywhere saying what was forgotten. So the
padding is stated once, against the panel's own children, at a specificity that beats a body class.
Three dialogs are flush on purpose, and they opt out by name in one place where the exception list
can be read whole: the command palette's search box and the feature card's footer each carry a
border across the panel's whole width, which an inset body would cut short of both edges, and the
stage (§18.13, §25) is a picture at the size of the window beside a column the reader drags the
width of — where an inset would also be measured *into* the drag, since the grip sizes the column
from the modal's own right edge.

### 5.5 Navigation

`genomes table → genome → contig → region`, with a breadcrumb whose segments are clickable to go back
up. Clicking an off-diagonal cell in any aggregated view opens the corresponding pair. Full view
state serialises to the URL hash.

**Every view has a trail, the 1D browser included**, where it reads `genome → Whole genome → IV →
1,000,001-1,400,000`: a genome opened as tracks has no chromosomes table to go up to, so its root is
the whole assembly, which is both where a browser opens and the one place above the sequence in
front of the reader. Without it the row appeared and vanished as the map's eye was pressed, and the
assembly a reader was looking at was named only on a tab and in a foldable column.

**The last crumb is the window alone**, under the crumb that names the sequence: the heading and the
locus box below it print the same place, and a row ending `› IV › IV:1,000,001-1,400,000` above two
more copies of that string is three readings of one fact in three typefaces.

**And a `+` at the coarse end of it**, which asks for a resolution the file does not store: any
whole number of one of its own bins, added up as it is read. §3.4 is where that lives — what the
bar contributes is the stop, starred, in bin-size order, with a `×` to take it back off.

**Nine rungs are chipped; past that the slider carries the walk alone.** A `zoomify` ladder that
doubles from 1 kb reaches a megabase in ten rungs and one that walks the 1–2–5 series reaches it in
nine, so nine covers most of the files in the wild — about three hundred pixels of short numbers,
right-aligned into whatever the trail leaves. The cap was six, on the grounds that more would push
the place the reader is looking at off the left of a laptop screen; what it actually cost was the
aim-and-click on the files with the most rungs to aim at, and on the files somebody is most likely
to *add* a rung to, since a ninth stop used to collapse an eight-rung row to a bare slider.

**The resolution is not a segment of that trail.** A rung of a `zoomify` ladder (§3.4) is the same
file drawn more or less finely: it does not contain the crumbs after it and clicking it does not go
anywhere, so it sits at the **far end of the bar, past the coordinates**, where the controls over the
picture belong. It spent a release as the second crumb, between the file name and the table, which
read as *this file, then this resolution, then these chromosomes* and put a control readers change
constantly at the one end of the row they scroll past on the way to the box they type in.

**A one-rung file is drawn without the slider.** There is nothing to slide along, so the row reads
`resolution  1 kb  +` and the `+` is the only control on it — which is §8.5's rule, not an exception
to it: a control that cannot keep its promise is absent rather than greyed, and a plain `.cool` is
the commonest file a lab opens. The slider arrives with the second rung, which is what the `+` makes.

It is a **slider over a row of labelled stops** rather than a dropdown, and the stops say `1 kb`,
`50 kb`, `1 Mb` rather than `1000`, `50000`, `1000000`. A ladder is an *ordered* thing with a fixed
number of rungs, which is exactly what a slider over stops shows — how many there are, which one you
are on, and which way is finer — and a dropdown of raw bin counts shows none of the three and asks
the reader to divide before the number means anything. Both halves write the same value: the stops
are real radio inputs, so the arrow keys and a screen reader get the list, and the slider commits on
release rather than per rung, since dragging across five rungs must not re-open the file five times.
An **mmetacool's entry picker is untouched** and stays where it is, before the root: switching to a
different nested metacool invalidates every crumb after it, so that one genuinely is a step of the
trail.

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

**The reader's word is *tab*.** Every string on screen says tab — *New tab*, *Rename this tab*,
*Close this tab*, *Share this tab* — because a tab is what is on screen and *session* is a word the
strip never shows: "Close this session" read as something larger than closing the thing being looked
at. *Session* stays as the implementation's word, in this document and in the code. The every-tab
file keeps its own name, said as *Save every tab as a file*, because it genuinely is a different
thing. No key closes one: ⌘W is the browser's chord for closing the window, and a binding that is
right about what it does and wrong about what it closes costs a workspace.

Three things are per *window* rather than per session, because they are preferences about this window
rather than facts about a file: the theme, and the fold and width of each column. The theme's cycle
is ordered against the machine's own scheme — from *system* to the opposite of what the OS is doing,
then to the same as it, then back to following it — so that the first press changes the picture; a
fixed order spends it on the choice that repaints nothing and reads as a control that does not work.

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

**The card asks for it only once there is a first map.** The zone is labelled *load a map into the
lower triangle* — not *a second map*, which is what §16's companion cell is called — and it is
absent until a map is open, because a triangle of nothing is a promise with nothing to keep it
(§8.5). A session with no map has one drop zone on that card, asking for a contact map.

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
is a lower bound, is rounded up, and is labelled as inferred wherever the genome is described. A
**label**, and once per surface: the Genome card's `lengths` row reads `inferred (rounded up)`, the
browser's summary line ends ` · lengths inferred (rounded up)`, and the way out of it — drop a
`chrom.sizes` or a bigWig — is said once, in the card, where the row it corrects is. It was said
four times on one screen, in sentences, of which the longest was the longest line on the page.

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
from there the next thing to ask is the opposite.

**The key alone, with no button beside it.** There was one in the region bar, offering the next
stop, and it has gone: the same three states are reachable one row at a time from the eye beside
the map in the column that lists what is drawn, which is where every other thing on screen is shown
and hidden. A second way to do a thing is not a convenience when the first way is a row the reader
is already looking at — it is another control in a bar that has to stay readable at a glance
(§5.4). The cycle stays because a *key* costs the bar nothing and is the fastest road for the
reader who has learnt it.

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
a third: `4.6 Mb`, then `4,605 kb`, then `4601520 bp`. Nobody reads a fourth decimal off an axis. On
one axis every tick keeps the step's decimals and a four-digit kilobase is grouped like every other
number on screen (§26.1): trimmed per tick, a row read `1.05 Mb 1.1 Mb 1.15 Mb 1.2 Mb`, which is two
precisions alternating along a single ruler.

**How many ticks it draws comes from how wide it is.** Ten was a constant chosen for the browser at
full width, and the same ruler is drawn in a deck cell a third as wide, where ten labels ran into
each other — `1250 kb1255 kb1260 kb` — and a coordinate axis whose numbers touch is the one part of a
browser a reader cannot read around. The gap a label needs is the heatmap's own, so the two rulers of
one genome thin out by one rule. And where the surface around the strip already captions it — the
Chromosomes table's bar says `16 sequences · 12.11 Mb` over it — the ruler draws its boundary marks
and no caption of its own: two captions for one strip say the strip is two things.

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
scaffolds as sixteen chromosomes. Under the list, what the ticks have done — `4 of 16 ticked` — and a
button that undoes it, *show the whole genome*. The count is said of the ticks and not of the list,
because a reader looking at nine rows of sixteen reads *showing 4 of 16* as a claim about the rows.

Under the Sequences card, the **Genome minimap**: the same sequences drawn end to end with the
current view marked on them, and one line under it saying what a click and a drag do. It says the
gesture and nothing else — the card above it already carries the sequence count and the assembly's
length — and it writes the window in the display form (§26.1), so the strip and the locus bar name
the same place with the same digits.

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
explicit debug action only: the status bar says **never run** until it is pressed, and the offer —
what a press will scan, and what it costs over a network — is in the panel the item opens rather
than in a second tooltip behind it. The item is absent altogether while no file is open, since there
is nothing to check and a check button that silently does nothing is what §8.5 forbids.

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

**Both unit systems on that row are named**, because both are on screen at once: the boxes are in
transformed units, so the row is labelled `clip (log10)` from the transform in force, and the line
under them prints the same pair in the units the colourbar is labelled in, followed by the word for
them — `auto · 0.000066 – 0.089 balanced`. Unnamed, the two read as a contradiction, and a reader
who typed the caption's own number into a `log10` box clipped the map a thousandfold too high. The
line is **absent until a block has been scaled**: `auto · 1 – 10` beside a view that has drawn
nothing is a caption for a picture that is not there. On screen the ramp picker is called
**colours**, which is what a lane's own row calls the same kind of choice; `colormap` is the word for
it here and on the command line, where it is a parameter rather than a label.

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

**Keyboard pan and zoom are supported**, so the picture takes focus — and says so: the focus ring is
drawn on the canvas's own edge pixels (`outline-offset: -2px`) rather than around it, since a ring
outside the figure reads as part of the figure while a reader tabbing into a map still has to be able
to see which of two pictures the next arrow press will move. It is not in an exported figure, which
is re-rendered rather than grabbed.

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

The map's format option is therefore labelled **PDF (image)** and the browser's **PDF (vector)**: a
biologist who saved a map as `PDF` for a figure and opened it in Illustrator expecting paths had been
told which they were getting by one card and nothing at all by the other.

**The 1D browser's PDF is vector**, and that is the one place the two exports differ. A contact map is
a raster honestly — twelve thousand bins are pixels and writing them as a million rectangles would be
a larger, slower file of the same picture — but nothing in a genome browser is: every mark there is a
rectangle, a polyline or a word. So the browser's PDF carries paths and text, and a figure dropped
into a manuscript can be restyled, recoloured and scaled by whoever receives it. It is produced by
handing the *same renderers* a context that emits PDF operators instead of pixels, so there is no
second drawing of the view to keep in step; text is Helvetica, one of the fourteen fonts every reader
has, so nothing is embedded. A vector page has no resolution, so the DPI control is *absent* while
one is chosen rather than greyed out — which is also what puts the format's full name and the button
on one line. The clipboard button in the same row takes a PNG whatever the format beside it says, so
while the select is away **its tooltip names the resolution it will use**: a slide-maker was pasting
a raster rasterised at a number they could no longer see or change.

### 7.3 Genome × genome overview — gated, not default

Available, but never automatic, because it costs a full pixel scan (§4):

- **Local files:** explicit user action, progress indicator, cancellable.
- **Remote files:** **warned above a byte threshold, with the download offered** — the scan streams
  in bounded windows, so only the bytes are large, and the reader knows their connection where this
  page does not. A caution with a way through takes `--warn` and not the colour of a refusal
  (§26.5): red over a button that proceeds is a reader told no by the picture and yes by the words.
  A full scan means downloading the file.
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
sentence, the same two figures and the same button as the scans: `compute whole genome` over one
sentence naming the stored pixels it will read, the cells it will sum them into, and the bytes it
will read or download. Both figures on every gate, because the pixels are what a local read costs
and the bytes are what a remote one costs, and a gate cannot know which of the two a reader is
paying. One gate said `compute overview` — a word that appeared nowhere else on screen, under a
toolbar button reading *whole genome* — and priced itself in bytes alone while its sibling priced
itself in pixels alone. It is also labelled and divided by **genome** rather than
by contig — the axis is the whole metagenome at every level, 2,082 contig hairlines over 48 blocks
are a grey wash, and an axis label that names a genome opens that genome. A *selection* follows the
same rule one level down, because it is the same rule: its axis names **what was ticked**. Tick
several genomes and it is divided and labelled by genome, exactly as the three levels above it are —
four ticked MAGs are four blocks, and the two thousand contig hairlines across them are the same
grey wash hiding the same structure. Tick contigs, or one genome, and the contigs keep the lines:
there the ticked names *are* the contigs, and a single genome has nothing coarser inside it than its
own. Where the axis is pooled the cells are held inside one genome for it, so a boundary drawn on it
is the boundary and not a cell past it — and an axis label, being a genome name wherever the axis is
divided by one, opens that genome from a selection exactly as it does from the three levels above.
The dispatch is on what the axis *is* (`WholeView.labelTarget`) and not on which view is asking,
which is how the two came to disagree: a genome name is a legal range (§5.4), so the selection's
label opened a region view of the genome — one screen short of where the gesture meant to go rather
than a broken click, and correspondingly easy to miss.

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
once, as a read-only statistic in the **Binning QC card** of the General column. It is a direct
diagnostic of binning quality, a metagenomics reader will look for it, and a reviewer will expect it.
It is a number, not a view: it opens nothing, selects nothing, and is not a row in any table. Label it
as a QC statistic — "unassigned: 1,204 contigs (30.1%) · 830 bins (8.3%)", each quantity whole, since
a count of contigs beside a percentage of bins leaves a reader to assemble either one from two
sentences — and not as a genome, with one clause under it saying it is never drawn. This is the sole
exception to the rule above and does not weaken it — no code path reaches `__unbinned__` through this
statistic.

It is also the only place it is **counted**. The File card's `genomes` row leaves it out, because the
genomes table a hand's width below that card does: two numbers for one fact on one screen is what
sends a reader hunting for a forty-ninth organism in a list of forty-eight.

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

**Linear annotations** — headed **Tracks** on screen, which is also what its rows, its tooltips and
every other surface call them; *annotation* survives as the column's name and in the two card names
below. Three drop areas, and everything they hold is drawn *beside* the map, never on it: **one GTF**
(at most one, because a second gene model over the first is a smear rather than a comparison),
**tracks** (bigWig, bedGraph, wig and — for its coverage — BAM (§8.13), any number, resolved as lines
or areas), and **bed-like files** (any number, resolved as genomic segments). Each is placed on any
of the map's four edges — above, below, or down either side — or on several at once; each carries its
own limits, style, colour and value scaling; and any set of tracks may share one autoscale group.

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
nothing in it comes from a file. They leave through the app's one export row (§26.6) with no
resolution and no clipboard, since a BED is not a picture, and its two options are named for the
marks they write in the card's own words — *lines (BED)* and *arrowheads & rectangles (BEDPE)*, not
*loops & boxes*, which named neither the sub-heads above them nor anything else on screen.

The three are three sentences — *this coordinate*, *this cell*, *this block of contacts* — and the
third is two intervals rather than one interval and a shape, because the boxes people draw are not
one shape: a domain is a square on the diagonal, a corner peak is a small square off it, and a locus
against a whole arm is neither. An on-diagonal rectangle is drawn as the same triangle a BED domain
is on a turned map, since that is what it is.

**One word for the mark: an arrowhead.** It is what this card's own section is called and what the
glyph is — a mark stood off a cell along its 45° axis — and it can be put at any off-diagonal point
rather than only at a loop. So the map's right-click menu offers *Arrowhead*, with *a loop at r × c*
as its hint, where it used to offer *Loop* and send a reader looking for their mark under a heading
called Arrowheads; the structure card's chord source is *your marks* for the same reason (§25.5).

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
the overlap explicitly ("16 of 16 sequences matched"). Silent zero-overlap is the most likely support
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

**A GFF row that names no parent is a feature, not a fragment.** GTF and an Ensembl-flavoured GFF3
are a hierarchy — gene, transcript, and the exons and CDS underneath — and a glyph is drawn per
*transcript*, assembled from whichever rows name it through `Parent` or `transcript_id`. A bacterial
annotation has none of that: Prokka, Bakta and DFAST write one row per feature with its own `ID` and
`locus_tag` and not a single `Parent` in the file, because a bacterial gene is one uninterrupted CDS
and a gene row above it would be a second copy of the same span. So a row that names no parent is
read as the whole feature it is, keyed on its own `ID` — two rows sharing one `ID` being GFF3's way
of writing a feature with a gap in it, and a row with no `ID` being one nothing can point at, drawn
keyless. The accession comes from `locus_tag` where the file writes one, which is per-gene by
definition; the symbol from `gene` or `Name`; and `product` joins `biotype` and `source` in the
detail string, because it is the whole of what a bacterial annotation has to say and the colour
picker (§8.16) can only offer what is written there.

The rows that describe the **sequence** rather than something on it — NCBI's per-contig `region`,
GenBank's `source` — are dropped by name. They were dropped by accident before, as rows with no
parent to place them, and drawn they would each be a box the width of the chromosome.

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
and its text nine; a lane in the browser is ninety and its name is what identifies the row. The
**name** carries the weight in both, because it is what identifies the row and the feature names
under it are the contents: at one size and one weight, `genes` read as the first item in a row of
gene names.

**Written over the data, the block sits on a plate.** In the browser it has a column of its own; the
margin beside a map belongs to the heatmap's own labels and a bottom canvas cannot grow backwards to
make one, so there the block is drawn over the lane and a halo around each glyph was the whole of the
protection. On a sixteen-pixel peak lane the label *is* the lane: `ATAC peaks` came out with orange
bars through every letter and `230 features in view` lay across a density block. A plate in the halo
colour at 0.85 keeps the argued placement and makes the words readable — the lane under it stays
visible as a shape, because the first eighty pixels of a peak set are data a reader may be counting.
A name longer than its lane is **cut in the middle** there as it is in a column, since a clipped name
is a different name: a track called `Distance to IV:1000000` was drawn as `Distance to IV:100000`,
which is a wrong coordinate stated as a fact. And a lane whose signal lives where a stacked range
line would land — the sequence lane, a fraction on a fixed `0 – 1` axis — keeps its range beside the
name on one line rather than under it.

**Where the pointer is, is written one way on both surfaces and in the browser's status line**: the
base, 1-based and grouped, while one pixel is worth less than a kilobase, and a unit form above that.
A lane tooltip that said `IV:1.18 Mb` over 1 kb bins was ten bins coarser than the picture beside it
and in a different grammar from the matrix readout a pixel above.

**A group's name is said where there is room for it.** The bar that marks a run of lanes sharing one
axis is drawn in the plot's own margin, six pixels, which cannot hold nine-pixel type — so beside a
map the bar is unnamed and the lane's tooltip names the group instead. An unexplained coloured rule
in the first member's colour reads as a mark rather than as a group, and the Groups card should not
be the only place to find out why three lanes are joined by a line.

**The sequence lane's axis starts at `[0, 1]` and moves like any other track's.** It was pinned, and
the pin was only half kept: the lane recorded its limit boxes as click targets, the editor stored
whatever was typed in them and the settings card offered `limits … auto`, while the lane alone
withheld the autoscale mark that is the way back. Yeast GC sits between 0.35 and 0.45, so narrowing
the axis is the natural move and the reader was then stuck. `[0, 1]` survives as the default, which
is what keeps two views of one genome matching until somebody deliberately changes one.

**A value axis is a fact about the data in the window, not about the lane's width.** Autoscale
resolves over the values the file states inside the window, quantised by the file's own summary
level, and a lane narrower than a thousand pixels is sampled as though it were that wide. Taken from
the drawn pixels instead, the same ATAC track over the same 400 kb read `0 – 111` on a 680-pixel
lane, `0 – 86.9` on a 560-pixel one and `0 – 36.9` in a deck cell — so the right-hand stack of one
map disagreed with the bottom one and two cells of one deck disagreed with each other about the same
file, which is the one conclusion a picture of one file must not invite (§16.2). The ceiling can then
sit a little above the highest mean drawn, which is the trade every other browser makes.

The rest follows the same shape. **Groups** are a fact about the tracks rather than about a view
(`annotations/groups.ts`), so one `GroupSettings` per open file is handed to both surfaces, one
`planStack` decides which lanes exist, and one `resolveGroupExtents` decides what they are drawn
against — which is what makes *scale each* mean the same thing in both places, having previously been
stored by one and ignored by the other. The **controls over the canvas** (`ui/LaneControls.ts`,
`ui/LaneLimitEditor.ts`) are parameterised by a host element, because that is the only thing that
differs: in the browser the layer and the canvas share an origin, and beside the map the layer is
positioned against the grid and offset per frame.

**A lane's limits are the colour clip's control** (§7.1, `ui/ClipRange.ts`'s idiom): two number
boxes, the `⇅` mark every autoscale in the app wears — unavailable while there is nothing to go back
to — and a line under them reading *auto · min – max* or *clipped · min – max*. It was a lit `auto`
word, which made one column carry two drawings of *let the data set the range*: lit when on here,
greyed when on beside the map. A reader who learned either learned nothing about the other.

Two constraints are permanent and are why this is a shared module rather than a shared file. Every
mark must be placed through `laneRect`/`laneText`, so a right-hand lane's quarter turn is
`render/lane.ts`'s business and nothing else's. And anything a lane *draws* lands in the exported
figure, so it must stay inside `VectorPage`'s op list, while anything that is a *control* must stay
in the DOM layer, which the figure geometry does not build.

**The sequence lane is the one lane whose *picture* changes with the zoom** rather than only its
resolution: GC content per bin until a base owns a pixel, and then the residues themselves. Both
come out of the annotations worker, which holds the FASTA and answers a window at a time exactly as
it answers a bigWig (§8.2), and the FASTA is also the assembly — every sequence and its exact length
— which is what lets a genome be browsed with nothing else open (§5.8).

**How the worker holds a FASTA is decided by its size, and the line is 64 MB.** Under it the file is
read whole and held whole, `.fai` or no `.fai`: a yeast genome is twelve megabytes, a fly's a hundred
and forty, and holding one is what makes every zoom draw GC content, every pan free and the motif
search (§18) possible. Over it the file is read **by its index**, `samtools faidx`'s five columns
(`annotations/fai.ts`): the assembly is the index's first two columns, which are a `chrom.sizes`, and
a window of residues is one ranged read at the byte the index puts it at — so a three-gigabase genome
is on screen the moment a kilobyte of index has arrived, and nothing of the sequence is fetched until
a lane asks for a window. The index is the one named on the URL (`<url>#index=<url>`, §8.13) or
dropped beside the file, and otherwise `<url>.fai`, guessed and never probed on the terms every other
sidecar is. What an indexed sequence gives up is everything that needed the whole of it in memory:
its GC lane draws nothing over a window wider than four megabases and its readout says why, the
motif search declines it in a note naming the line, and an alignment lane colours its mismatches
only from the slab the sequence lane last drew, never fetching for one (§8.13). Over the line with no
index that can be found, the file is read whole as it always was, and refused past 300 MB by a
sentence naming the size, `samtools faidx`, and where to put the result. A bgzipped FASTA is read
whole whatever its size, its `.fai` needing a `.gzi` beside it that this viewer does not read. The
generator writes the index into every IGV genome's row and session (§24.3), and a lane's summary
says *read by range from its index* so a reader knows which of the two they have.

**A lane says what it is waiting for.** The worker reports how far a read has got — a whole file
being downloaded for a row, a window of an indexed sequence fetched by range — under the request
that asked, the same `progress` message an analysis task sends (§18.3), and the two caches on the
main thread keep the last report beside the request it belongs to. A lane whose window is on its
way draws *fetching 1.2 of 4.0 MB* and a bar where its limits would go, on both surfaces
(`render/laneLabel.ts`); a row whose file is still coming draws the same words and bar in the Tracks
card. Where the host would not say how much is coming the bar is drawn half full, because a bar at
nought says nothing has happened and something has. And a lane that will not draw at this zoom says
so in the same place rather than sitting blank: an indexed sequence over a window wider than four
megabases answers *GC under 4 Mb, letters at base resolution — zoom in*, judged over the whole
request and not one region at a time — a whole-genome view of a cow is thirty chromosomes over the
line and two thousand scaffolds under it, and reading the scaffolds one request apiece was a lane
that stayed empty for minutes while it did.

**A remote file's size is learnt, not assumed.** The handle reads it off the `Content-Range` of its
first ranged request, which is how every bucket that follows `docs/hosting.md` answers — and how
4DN's open-data bucket does not: it exposes `ETag` and nothing else, so the browser sees no
`Content-Range` and the handle reports a size of nought. Taken at its word that was a header read
of nought bytes, "not a BAM", and the whole alignment file fetched to find out what its first block
said. A size the handle cannot give is asked for with a `HEAD`, whose `Content-Length` is one of the
few headers CORS lets every page read unasked; a size nothing will state is *unknown*, never
*empty*, and a header is still read within its bound. A BAM's browser therefore opens from its
header alone, in three small requests, and the index — the one download it costs, tens of
megabytes for a deep file — comes with a bar on its row while the browser is already on screen.

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

What is kept is one sentence: *the reader can point at a locus.* The 4C task's *pick on map* button
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
right. The *display* format is the same string with the digits grouped — `chrIV:500,001-510,000`,
still a plain hyphen (§26.1) — and the en dash is for a range of **values** (`0 – 111`), so a reader
can tell the two apart at a glance rather than meeting one window written three ways.
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

**A BAM is read by region and nothing else**: there is no zoom level in the file, no summary layer,
and no whole-file read that respects §12 — a human alignment file is tens of gigabytes and the demo
yeast one is not the case worth designing for. What makes reading by region bounded is knowing
*where in the file* a window's reads are, and there are two ways to know it. The **index** is the
first and the one to prefer: a `.bai` and a `.csi` are both read, decided by their magic bytes
rather than their suffix, and both spellings `samtools index` writes are paired with the file they
belong to. A remote file names its own — `<url>.bai`, guessed and never probed, since §12 has no
request to spend discovering that a file has no index — and where the guess cannot work, a
presigned URL or one carrying a query string, `<url>#index=<url>` says where it really is.

**The search is the second**, for a file that has no index at all, and it exists because the two
hosts the store drawer offers most publish none: on 2026-09-14 the whole of 4DN's open-data bucket
held 9,977 BAMs and not one index object, and ENCODE's file manifest listed 144,322 BAM rows and not
one index row — so a reader of the published site who opened a BAM from either was refused by name
for something they could not fix. A coordinate-sorted file is its own index, slowly: its records
are in (reference, position) order, so the first record at or after a position is found by binary
search over byte offsets, each probe a ranged read of two blocks that inflates them and recovers a
record boundary inside — a BGZF block from its own length landing on the next block's header, and a
record from its fields being in range, its name printable and NUL-terminated at the length it
states, and the record after it passing the same checks (`bam/search.ts`). A handful of probes
bracket a window in a six-gigabyte file — the first guesses interpolate from the position's share
of the genome laid end to end, where halving from the middle would take sixteen — and the probes
are kept, so the next window over the same file starts from them; the two rows a BAM imports as
share one search, joining a locate in flight rather than running their own. The result is the same byte span an index would give, to the block rather than
to the record, and everything after it — the read, the inflation, the walk from the record offset —
is the same code, which is what makes a file without an index draw exactly what one with an index
draws. The row's summary says which road it is on. Two things the search is not: it is not exact
below 16 kb — the walk begins that far before the window, the resolution a BAI's linear index has,
so a read beginning further before the window than that and still reaching into it is not drawn —
and it is not free, so a searched file answers one window at a time and refuses a whole-genome
view's window per contig, or any window over four megabases, before a probe is made.

The refusal that remains is **sort order**, and the search sharpens it. A name-sorted file has no
order to search, and a search over one would answer with whatever the probes landed on — so every
probe is held to the order the file claims, against both its neighbours, and a file that fails is
refused with the two offsets that disagree, whatever its `@HD` line said and especially when it said
nothing. That is how the file this refusal is read on is told apart from one that merely lacks an
index: every BAM on 4DN's bucket is a Hi-C pipeline's alignment output, written in read-pair order
for the pairs step that follows it and never sorted, and the refusal says so, and says the `.pairs`
or the contact map is the file to open. A header that claims `SO:queryname` or `SO:unsorted` is
refused on the claim alone, as before, and the refusal says `samtools sort`.

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
part-way through a fetch; without an index it comes from the search's two locates, which are
requests, and the four-megabase rule above is what keeps them from being made for a window the cap
would refuse. What the lane then shows is its name, an empty band, and a sentence naming the number
and the way forward.

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
and the width one feature needs is the `2` it has always been — a peak one pixel
wide *is* one pixel of genome.

**The count it is measured against is the fullest row the lane will use**, which
for a stranded set is a band per strand rather than the whole window in one row.
Measured over the window, a gene set that this lane spreads across two bands was
declared unpackable at half the features it can actually draw apart: the same 230
yeast genes over the same 400 kb came out as named boxes on a 680-pixel lane and
as a solid grey density block on a 455-pixel one, so opening a side panel made
the gene track look as though the annotation had been lost. Not the rows the lane
has *room* for, either — the packing reaches for a second row only where two
features overlap, so four rows do nothing for four hundred records sitting two to
a pixel, which is the case the rule exists for.

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

### 8.15 Circular sequences

A `.cool` cannot say that a sequence joins its own ends. Bins run from zero to
the last one and stop, and there is no field anywhere in the format for *and then
it starts again* — so a bacterial chromosome, a plasmid, a mitochondrion and a
phage all arrive looking exactly like a linear chromosome that happens to be
short. Everything the viewer then does with one is correct and slightly wrong:
the map has two artificial corners, the diagonal runs into a wall at each end,
every window near either end is dropped by every task for want of a whole window,
and the contacts joining the last bin to the first — which on a circle are the
most local contacts there are — sit in the far corner of the square, as far from
the diagonal as two bins can be.

**Nobody can infer it from the data, so the reader declares it.** A circular
chromosome's map has a bright far corner; so does a translocation, so does an
assembly error, and so does nothing at all if the sample is shallow. The one
thing that reliably knows is the person who chose the organism.

So it is a **column of tick boxes in the Chromosomes table**, beside the lengths,
one row per sequence. It was a tickbox in the Map card, and that was the right
card for what the flag *changes* and the wrong place for what it *is*: a
declaration about the assembly — which of these sequences is a plasmid, which is
the mitochondrion — asked one sequence at a time, of whichever one happened to be
on screen. Declaring three of them meant opening three maps, and there was
nowhere at all to *read* which had been declared. In the table the question is
asked about all of them at once, the filter row's own tick narrows to the ones
that carry it, and the **Sequences card in the General panel wears a `↻` beside
each declared name**, so a reader at work is told the answer rather than offered
a second place to click. It is the **last** column, after everything the file
itself carries: it is the one column that is not in the file — a declaration the
reader makes rather than a number somebody measured — so it goes where a reader's
own additions go rather than interrupting the run of the file's own fields.
A metacool has no column: §8.5's argument about names
applies hardest to a hundred thousand contigs off four thousand independently
assembled organisms, and a declaration is made about a molecule somebody knows
the shape of.

It is kept per file and carried in an exported workspace, beside the tracks
somebody loaded and the marks they drew. **Not in the view state**: a bare
`#`-hash link names a place and a colour scale (§5.5), and this is a fact about
the assembly rather than about the window.

#### A window typed across the junction

`chrom:2,900,000-100,000` is a legal region on a declared sequence and an error
everywhere else. cooler refuses an end below its start, correctly — on a line it
is a typing mistake — and on a circle it is the 200 kb either side of the origin,
which is where the most local contacts are and is the one window a linear reading
cannot ask for at all. The refusal is lifted for exactly the sequences the reader
has declared: the declaration travels with the `range` request (this worker
cannot know it), the extent comes back **unwrapped** in the space below, and
every other range keeps cooler's own error — with a sentence on it saying where
the tick is, because a reader who typed one usually meant it.

#### What the flag does to the picture

The window becomes **unwrapped**. A region view on a circular sequence pans in a
coordinate space that runs off both ends and is resolved modulo the sequence, so
`chrom:2,900,000-3,100,000` on a 3 Mb circle is an ordinary place to be looking
and is two stored pieces: the last 100 kb and the first 100 kb. On both axes at
once, so a square window across the junction is up to **four** stored blocks, one
of which is that far corner. `worker/wrap.ts` says which pieces and
`worker/wrappedMatrix.ts` reads and assembles them.

Unwrapped rather than modular because it is the only space in which panning is
*monotonic*. The alternative is a window whose start jumps from 2,999,000 to 0,
and every `covers`, `pad` and `recentre` in `ui/refine.ts` — the whole
zoom-and-travel policy of §2 — would have to learn about that. What those
rules learn instead is one thing: on a circular axis **every edge of the block
gives**, because there is no end of the world for one of them to be, and the
answer to reaching one is the same block width rotated round to where the reader
now is. The ceiling stops being a limit on *where* and becomes a cap on *how
wide*: one lap, past which a bin would be drawn twice.

**A circular view reads as it moves, whatever the refine setting says.** §2's
zoom-to-refine is off until a reader turns it on, and that is the right default
for what it was written for: a sharper picture of a place you are already at,
bought with reads you did not ask for. A circular slide is not that — past the
end of the sequence there is *no* block in hand, the window having left
everything that was ever read, so with the ladder asleep the picture stops at the
last bin, which is the exact wall the declaration was made to remove. A reader
who ticks the box has asked for the reads that make the wrap possible. Only for a
sequence they have declared: every other view keeps the setting's answer.

And the declaration does **not** rebuild the view. It changes how the block is
read, so the ladder is armed again — against the block that is *drawn*, not the
one the view first loaded — and nothing else moves. Rebuilding would reload the
view from its named region and throw away the zoom the reader needed in order to
be somewhere the question is worth asking from, which is most of the way to a
tickbox nobody would use twice.

The grid is chosen once for the whole window and every piece is read on it, which
is what makes the two halves of a junction-crossing block halves of one picture
rather than two pictures with a seam — `snapToGrid` anchors cells to the
*sequence*, so the piece ending at its last bin keeps that end and the piece
beginning at its first is already on a cell edge. One artefact survives and it is
honest: where the sequence's length is not a whole number of cells, the cell at
the junction is short. That is the partial last cell every pooled view of every
chromosome already ends with; what circularity does is move it into the middle of
the picture instead of leaving it at the edge.

**Everything drawn on the axis follows, and almost none of it had to be told.**
The block's axis runs carry the sequence *twice* — its tail, then its head — with
the second run's `unitStart` shifted a lap along, so `render/locus.ts` reads it as
*the beginning of the sequence, one lap on* rather than as somewhere past its
end. Ticks, the coordinate readout, tracks, features and annotations then place
themselves through the same piecewise map they already used for a
whole-genome view, which has carried several sequences on one axis since it was
written. Three things did have to change, and each is a place where *the first
stretch with this name* stopped being the right answer: a window now carries the
stretch it was cut from rather than looking one up by name, a mark is drawn at
**every** place its locus lands rather than the first — or it would flicker in
and out as the reader slid past the join — and the window a refine carries across
a change of grid picks the narrowest ordered pair of landings, without which the
panel refuses the very block the reader is sliding towards.

The turn (§17) needs nothing at all: it rotates whatever block is on screen, and
a wrapped block has a diagonal like any other.

#### What the flag does to the numbers

**Automatically, and with no per-task tickbox.** A plasmid is circular or it is
not; that is a fact about the molecule rather than a setting of the
directionality index, and a catalogue in which eleven tasks each carry their own
copy of it is one where a reader can get ten circular answers and one linear one
out of the same file without being told. The declaration travels in
`AnalysisFraming.circular`, which puts it in the provenance of every result — so
two exported tracks can be told apart.

The separation between two bins becomes the shorter of the two ways round,
`min(|i − j|, n − |i − j|)`, and the longest separation a sequence has becomes
half of it rather than all of it. `analysis/band.ts` is where that lives: a
**separation-addressed** accessor, `forward(row, offset)`, which the banded
kernels are written against as though every sequence were linear. A kernel asking
for `(row, col)` would have to decide for itself which of the two arcs it meant
and put `col` back inside the sequence before asking — two decisions, at every
call site, each of which is the wrap. Reading one costs exactly one extra
request: the corner of the contig's own square, where the cells joining its two
ends are stored.

What is circular today: **P(s)**, whose curve stops falling and turns *up* at the
far end when a circle is scored as a line — those are the contacts joining the two
ends of the molecule, wearing a chromosome-long separation, and every fit through
that tail is a fit through an artefact; **diamond insulation**, which reads a band
rather than tiled squares there and therefore scores the bins at the junction that
a linear reading leaves as gaps; and the three banded readings of §18.8 — the
**directionality index**, the **HiC score** and the **scalogram**.

What is not, and is stated rather than left to be discovered: **compartments**,
**chromosight** and the **observed/expected** map divide by an expected curve at a
linear separation, so near the junction their denominator is the curve's far tail
rather than its near one. A **deck companion** draws the sequence linearly — the
declaration is the lead map's — so a deck of a circular chromosome shows the lead
sliding and the companions standing still. Both are seams rather than wrong
answers, and both are in the same place: the reader can see the junction.

**The turn slides too, and it needed one gate widened.** `isTurnable` asked for
*one run or none*, on the sound ground that a boundary between two sequences is a
discontinuity in the x axis and the distance across it is not a distance. A
wrapped block has two runs — the sequence's tail, then its head — so it was
refused, and the refusal was silent in the worst way: `MatrixPanel.regrid`
declines a block it cannot turn, so the ladder read the very block the reader was
sliding towards and the picture simply stopped at the last bin with nothing said
anywhere. The gate now asks *one sequence*, which is what it always meant: several
runs are allowed when the block was read round a circle and every one of them
carries the same name. `turnedAxis` then builds a segment per run instead of one,
each carrying its own lap, and the turned picture reads the far side of the
junction as the beginning of the sequence exactly as the square one does.

### 8.16 How a segment is drawn

Everything that is a `FeatureSet` — a BED, a peak set, a bigBed, a gene model, a VCF — is drawn by
the same two renderers over the same layout (`render/features.ts`), so this is one set of rules for
all of them rather than four lanes that happen to look alike. Three things decide what a reader sees:
**what colour**, **which way**, and **where in the lane**.

**A segment is coloured by a field of the file, and it starts on strand.** Strand is the one column
every one of these formats can be asked for, it costs no scan to resolve, and it is the fact a reader
is most often after. It resolves to exactly three colours: forward keeps the colour on the row's own
chip, reverse is that hue turned 150°, and a feature whose file carries no strand takes
`BASE_COLOURS`' fifth slot — the grey the sequence lane writes an `N` in and the grey §8.14 gives a
variant with no single base behind it. One neutral for one claim, so a reader learns *no answer* once
rather than three times.

A file with **no strand in it at all** — a peak set, a call set, most BEDs — is the exception and
falls back to the lane's own colour for everything. Every feature taking the neutral would cost the
reader the colour that tells this lane from the three beside it and say nothing in exchange: a grey
meaning *no strand* only means something where a neighbour has one. For the same reason the key names
only the bands the file actually has, in the order they are drawn down the lane, so it can be read
against the picture rather than matched to it.

Deriving the two hues from the lane's own colour rather than fixing them at a conventional blue and
red is a decision about **decks**, not about strands. Four peak sets on one screen are told apart by
the colour their reader gave each of them, and a fixed pair would make all four the same picture; a
turned hue keeps a lane recognisable as *one track drawn two ways*, which is the same argument
§8.13 makes for an alignment lane's categories and is implemented through the same arithmetic
(`render/hue.ts`).

**Any other column of the file is offered too**, which is what makes this a control rather than a
default. `annotations/fields.ts` reads the keys back out of the `detail` strings the parsers write —
a GTF's `biotype` and `source`, a narrowPeak's `signal` and its two `-log10` columns, a VCF's `QUAL`,
`filter` and `SVTYPE` — and the picker lists what it found. That is the cost of §8.3's decision to
keep attributes in one joined string per feature rather than a column each, and it is paid in the
one place that needs it: discovery is a **strided sample** of at most twenty thousand rows, cached
per set, and a row's value is read from its own string once per *placement*, which the layout has
already bounded by the pixels on screen. A key with its number on the wrong side (`4 exons`) is not
a column and is not offered; a part with no key at all (a VCF's leading `A>G`) is not either.

A categorical column is drawn in `CATEGORY_PALETTE` — §8.12's palette, for §8.12's reason: one swatch
cannot describe six biotypes. Values are handed colours **commonest first**, so the palette's most
distinct colours cover the most features; past twelve the tail becomes one `other` bucket, because a
thirteenth colour nobody can name is not an answer. The lane's label chip then becomes the first
category's colour, exactly as a metadata strip's does, so the name on the row is still a colour that
is in the picture. A numeric column is a `viridis` ramp between the file's own ends, fitted to the
**file** and never to the window: a track's autoscale is safe because its axis is redrawn beside it,
and a colour that meant `protein_coding` before a pan and `lncRNA` after it is a legend that lies
without saying so. A row carrying no value for the chosen column is the neutral again — a GTF where
half the genes have a biotype is a file saying two things, and colouring the silent half as if they
were some category would be inventing the fact.

Both keys live in the **card**, under the control that decides them, for §8.13's reason and one more:
a feature lane can be sixteen pixels tall beside a map, which is not a legend's worth of room at any
font. They are built from `featureColouring` — the function the renderer itself calls — so a key that
disagreed with the picture would be a bug in the ink rule rather than a second palette drifting out
of step.

**A stranded feature points the way it runs.** On a segment box — and on a gene the file gives no
exon table, which is a box too — the arrowhead is cut *out of* the leading end rather than drawn past
it, so the glyph occupies exactly the bases the feature does and §8.4's rule holds:
the box that is drawn, the box that is clicked and the box the packing kept a row clear for are one
span. An ink says *which* strand; a point says *which way*, and a reader following an operon or a
tandem array is reading the second. The head is capped by the glyph's own height, so it is a point
rather than a spear, and by a third of the feature's width; below six pixels there is no head at all,
because a pentagon and a rectangle three pixels wide are the same ink with a different corner and the
reader has lost a pixel of extent to learn nothing. A long box additionally carries chevrons in the
halo colour, so a segment running across the whole window says its direction at every point rather
than only at one end.

A gene **with** exons keeps the chevrons on its spine and no head, which is not an omission: its
glyph is a line with boxes on it, a point on the last exon would be a point on a piece of the gene
rather than on the gene, and the chevrons already say the direction at every position along it. That
is also what every genome browser draws, and the one place this lane should not be inventive.

**The rows are banded by strand.** Unstranded first, then forward, then reverse, outward from the map
— which on the 1D browser and on a bottom stack reads top to bottom. Two genes on the same bases and
opposite strands are the case it is for: packed together they are two boxes one above the other and
which is which is a colour you have to look up; banded they are two boxes in the two places the
strands live, and the colour is a confirmation rather than the whole message. `+` above `−` is how
every stranded picture in genomics is laid out, and the features a file could not place either way
are neither of the two, so they go above both rather than between them.

The bands come from the **file** and not from the window (`strandBands`), which is the difference
between a layout and a flicker: decided per window, a region holding only forward genes would draw
them across the whole lane and the first reverse gene to scroll in would move every glyph on screen.
Each band gets a contiguous slice of the rows, split evenly with the remainder to the earliest bands
— proportional-to-load would pack better and would rearrange the lane on every pan.

Whether the bands fit is asked of the lane's **thickness**, not of `rowsThatFit`, and that is the
whole of whether this works where it is most wanted: `rowsThatFit` measures the height a row needs to
carry a *name under a feature*, twenty-odd pixels, so a segments lane at its default sixteen would
have one row and never band — and that is exactly the lane a stranded BED lands in. A band needs a
glyph and the gap under it, eight pixels, so a sixteen-pixel lane bands into two and its names go
back inside the features, which is what a lane that short does anyway. Below that a band would be a
hairline and the lane falls back to the single greedy packing it always had. A banded lane reports
the rows it was **allotted** rather than the rows it used, because a band that packs into one of its
two rows still has to sit where the allotment put it.

None of this reaches the collapsed picture. Past the point where there are more features than the
lane can draw apart, the lane is a count profile (§8.14's rule) drawn in the lane's own
colour: a density is a number, not a category, and colouring it by the first feature in each pixel
would be a claim about the other four hundred.

**A name is bounded, and it stays inside the lane.** A name below its feature may overhang it — a
gene four pixels wide has a name worth ten times that, and that zoom is what the placement exists
for — but by four times its feature's width or eighty pixels, whichever is more, and past that the
name is cut in the middle. Unbounded, a forty-six-character peak name (its caller's run id plus a
counter) was written under a three-pixel peak across a dozen unlabelled neighbours, so one peak in
twenty carried a name and every name read as the label for the group it lay across. And the text is
nudged inside the lane's own ends rather than left to the clip, because **a browser must never print
a gene name that is not in the file**: `MSW1` was drawn as `SW1`, `HEH2` as `HE` and `MUS81` as
`US81`, every one of them a plausible yeast symbol that a reader would search for or cite. Inside a
feature the name is dropped where the window has cut the box, since a name centred in half a box is
centred on a place the feature does not have.

**Where the settings live.** `AnnotationStyle.features` — `{ colourBy, arrows }` — a nested optional
record in the shape `reads` is one and for the same reasons: the fields mean nothing to a value
track, optional means no stored row changes shape, and one accessor (`featuresOf`) keeps `undefined`
from reaching a renderer. `colourBy` is an **open string** rather than a union, because the
interesting answers are the file's own; it is checked where it is used, and a stored choice whose
column this file does not carry is **kept and marked** rather than corrected away — the same session
opened against the other half of an experiment should colour by `biotype` again when the GTF comes
back. Unlike an alignment lane's colouring, none of this refetches anything: a feature set is in
memory whole and the field is a column of it, so a dozen answers cost one repaint between them.

### 8.17 barChart and bigBarChart

UCSC's `barChart` is BED6+5: the six columns every feature file begins with, then `name2`, then
`expCount`, then `expScores` — a comma-separated list of that many numbers. A row is therefore not
an interval with a *value* on it but an interval with a **vector** on it, one number per category,
and gene expression across fifty-four GTEx tissues is what the format was built for. `bigBarChart`
is the same thing written as a bigBed, and the two optional trailing columns (`_dataOffset`,
`_dataLen`) point into a sample matrix this viewer does not read.

**It is a `FeatureSet`**, and that is §8.14's decision restated under more pressure. A vector per
row is the strongest case there has ever been for a payload of its own, and it is refused for the
reason a VCF's was: `payload.kind === 'features'` is tested at a dozen sites across the browser, the
map lanes, the search box, the export and the analysis inputs, and a second feature shape breaks
none of them — it makes every one of them *skip* the lane, in silence, to be discovered one call
site at a time. So the vector is one optional field on the set (`FeatureSet.bars`), one flat
`Float32Array` with a stride rather than an array per feature, and the packing, the hit test, the
search, the export and a metaplot over its intervals are all the code a peak set already uses. What
it has of its own is a **kind**, because the glyph, the legend, the card behind a click and the
height the lane opens at are four questions no other feature kind is asked.

**The categories' names are not in the data.** `barChartBars` lives in the `track` line of a custom
track and in the trackDb stanza of a hub, so a bigBarChart dropped on its own arrives with the
numbers and nothing to call them. The `track` line is read where there is one; where there is not,
the categories are their own positions — `1` to `N` — and the set records **which of the two
happened**. Nothing is inferred from that but honesty: the legend says what it is naming, and the
`top` column (the dominant category, which is the one colouring a lane of charts really wants) is
written only where the categories have names. Numbered, it would be read back as a *number* and
drawn as a ramp over the order the categories happen to be listed in, which is §8.12's own
counter-example.

**A bigBarChart is identified by its schema.** bbi hands back the file's `autoSql`, so the question
is asked of the file's own declaration rather than guessed from its column widths — a tier better
than anything the text sniffer can manage, and the reason §8.7's "read it as the BED it holds"
needed no exception before this one. The rows then go through the same parser the text file does.

**The text sniffer has one collision and it is a bad one.** A BED9, a BED12 and a gappedPeak all
put `thickEnd` in column 8 and `itemRgb` in column 9: an integer followed by three comma-separated
numbers, which is exactly the agreement this format's meaning rests on, whenever `thickEnd` happens
to equal 3. What holds it shut is column 7 — `name2` here and `thickStart` there — so a barChart's
column 7 must not be an integer. That test is waived for a file *named* `.barChart`, the way the
peak sniffer waives its shape tests for a file named `.narrowPeak`: a reader who has named the
format has answered the question. The sniffer is asked **before** the BED one, with the VCF and
signal sniffers, for the reason all three are: `sniffFormat`'s last line is `return 'bed'`, so a
format it has not been taught is not refused but silently parsed as a BED — and a barChart read as a
BED is a lane of boxes whose ninth column, the whole of what the file is about, was never mentioned.

**Two pictures, and where the line is.** With room, a feature is `expCount` bars on a common
baseline, each the height of its value against the ceiling. Below one pixel per bar it is a single
box in the colour of the category that dominates the row and the height of that category's value —
so the glyph gives up *which categories* long before it gives up *which one* and *how much*, and a
lane at chromosome zoom is still a map of where each condition wins. The floor is a pixel and not a
fudge factor: under one, a bar is not thin, it is gone — rounded away or blended into its neighbour
— and a chart quietly missing half its categories is a different chart drawn with the same
confidence. A baseline is drawn under every glyph, because without one a row of short bars and a row
of tall bars hanging from above are the same picture.

**One colour per category**, and position is the identity: the third bar is the third category in
every feature on the lane. Where the file names colours (`barChartColors`) those are used, because a
GTEx track in the tissue colours every other GTEx picture uses is worth more than any palette this
could impose. Otherwise up to twelve categories take `CATEGORY_PALETTE` — §8.12's twelve, so one
swatch means one thing across the app — and past twelve they take a `viridis` ramp across their
positions rather than the palette cycled. A cycle **invents a pattern**: fifty-four tissues through
twelve colours is a repeating rhythm in every glyph on the lane, which reads as structure in the
data and is structure in the palette. Because the ink is not a choice, a barChart lane is the one
feature lane with no `colour by` picker and no arrowheads — a control that silently does nothing is
worse than an absent one (§8.13) — and what the card carries instead is the **key**, which is where
the bars get their names.

**The ceiling is one number for the file**, `maxLimit` where the file sets one and the largest value
otherwise, never fitted to the window: §8.16's rule for a numeric colouring, and it holds harder
here because a bar is read against its neighbours *and* against the same gene two windows away. A
track's autoscale is safe because its axis is redrawn beside it; a glyph carries no axis, which is
also why the ceiling is stated once under the lane's label rather than drawn on every chart.

**…and a switch, because the common case defeats the default.** Expression is heavy-tailed — a
handful of ribosomal genes run a thousand times the median — so against one ceiling the lane is flat
except for the genes a reader did not need a chart to find. `scale each chart` measures every chart
against its own tallest bar instead, and each glyph becomes a **shape**: which category wins, and by
how much against the rest of that feature. Two readings, both true, neither able to serve for the
other, and a switch rather than a heuristic on the distribution — a lane that quietly changed what
its heights meant when a file's tail got longer would be the worst version of both. The collapsed
glyph keeps the file's ceiling either way, because per feature it would be each feature's peak
divided by itself: every box full height, a lane saying nothing.

**…and a third reading, which is the only one under which two files can be compared.** Both of the
above are *relative* — to the file, or to the feature — so a GTEx lane and a knockdown's lane laid
side by side are each scaled to their own maximum, and the one with the quieter tail draws the taller
bars and looks like more expression. So a barChart lane takes the **limits** row every signal track
has, and it means here exactly what it means there: `auto` is the behaviour above, and a typed pair
is a fixed value axis the bars are drawn against. It overrides the per-chart switch rather than
composing with it — *each chart against its own top* and *every chart against these two numbers* are
contradictory answers to one question, and the one the reader typed wins — and it reaches the
collapsed glyph too, or a lane zoomed out would quietly change what its heights meant. A value above
the ceiling draws full height rather than out of the lane and into the one above it; one below the
floor draws nothing rather than downwards through the baseline. The line under the lane's label says
both ends of the axis, which is what makes the comparison it exists for possible. It seeds itself
from the file's own ceiling, so leaving `auto` starts on the picture that was already there.

**And an axis is moved the way an axis is moved.** Typing two numbers is the precise way and the
slow one; what a reader of a genome browser reaches for constantly is the **drag across the lane** —
towards the signal's own growing direction to make it taller — with the ⌘-scroll beside it as the
notched version of the same gesture. Both work on a barChart lane, on the map's stacks and in the
1D browser, and they start from the axis on screen: zero to the file's own tallest bar, the same
number the typed field seeds from, so a notch and a drag on one lane cannot begin from two different
places. The drag is the one thing here that is not about the format at all — a lane that answers a
drag across it with a pan, while every lane above and below it moves its ceiling, is a lane the
reader has to be told about.

This is where the four kind predicates come apart, and it is worth stating because they had agreed
until now. A barChart **draws no profile**, gets **no row of track controls** — no autoscale group,
no mode or flip switch, because a chart is not a measurement in anybody else's units — and **has a
value axis the reader may move**. *Has an axis* and *is drawn as a profile* are two questions; they
were one function's worth of answer only for as long as nothing but a profile had an axis.

**The rows are never banded by strand**, which is the one place §8.16's layout is overruled. Banding
divides the lane's height, and a barChart's height *is* its value axis — so a sixty-pixel lane split
into three bands buys a fact the card already states at the cost of two thirds of every reading on
it. How many rows fit is asked of the chart rather than of the label under it, and a lane dragged
very short gets one rough chart rather than a stack of unreadable ones.

**A row whose `expCount` disagrees with the file's** keeps its interval and loses its bars, and is
counted under the lane's label. The interval is not the part that was wrong, its categories are not
the file's categories, and there is no honest chart to draw for it — so it is `NaN` rather than a run
of zeroes, which would be a measurement. That is §8.7's bargain for a truncated bigBed made again: a
file that says what it dropped is usable, one that does not is a lie about the genome.

**The click opens the whole chart.** The glyph is at most a few dozen pixels wide, so the lane says
roughly which categories are high and the feature card says which, and how much — one row per
category with its colour, a bar and its number, in **file order**, so the card reads as the glyph
does and can be used as its legend. The colours come from the function the renderer itself calls, so
a bar named there in a colour it is not drawn in would be a bug in the ink rule rather than a second
palette drifting out of step.

### 8.18 Two interaction formats: interact and longrange

The one thing UCSC has that this application is already about. Everything else a genome browser
draws is a measurement *along* a genome; a contact map is a measurement *between two points of one*,
and so are these — a ChIA-PET loop set, a promoter–enhancer call, a set of SNP→gene assignments.
They are the annotation a reader most wants drawn **over** a Hi-C map, because whether they agree
with the map is the whole question.

| Format | On disk | Read as |
|---|---|---|
| `interact` | BED5+13: a bounding span, then the source and target triples with names and strands | `PairSet` |
| `bigInteract` | the same rows in a bigBed, identified by its `autoSql` | `PairSet` |
| `longrange` / `longTabix` | BED3 and a fourth column packing `chrom:start-end,score` | `PairSet` |

**Both become a `PairSet`, which is what a bedpe becomes**, so both are drawn by code that already
existed: arcs across the matrix on the overlay card (§8.1) and a lane of arcs in the map-less 1D
browser. Not a line of renderer was written for either, and that is the argument for the shape rather
than a happy accident — an `interact` and a bedpe differ in spelling and in nothing a picture can see.
Trans interactions survive, because a `PairSet` holds a contig per end; UCSC draws the far end of one
as a labelled vertical bar, having a single axis to draw it on, and on a contact map it is an
ordinary off-diagonal arc.

**What they were doing before.** Both are BED-shaped enough to reach `sniffFormat`, whose last line
is `return 'bed'`, so neither was refused:

- an `interact` with a fractional `value` — UCSC's own examples write `5.000000` — was **one box
  spanning both anchors and the gap between them**, with the ten columns naming the ends never read;
- an `interact` whose `value` happened to be a whole number matched the bedpe rule (column 3 not an
  integer, columns 4 and 5 integers) and was read as a **bedpe**: the interaction's name became the
  second contig and its 0–1000 score became the second start. Arcs between coordinates that were
  never in the file;
- a `longrange` was a BED4 whose *names* were the coordinates of the arcs.

So the sniffers run in front of the BED one, and each is stricter than it. An `interact` must be
exactly eighteen columns with integers, a score, a value, two strands **and** a bounding span that
really bounds whichever of its own anchors sit on `chrom` — the §8.17 agreement test, which three
unrelated columns do not satisfy by coincidence. Note what is *not* tested: that the contig columns
are non-numeric. An Ensembl contig is called `1`, and assuming otherwise is precisely the mistake
`sniffFormat`'s bedpe rule makes.

**`score` is `value`, not the 0–1000 beside it.** That column is a display score — UCSC's own
clamped, rounded scaling, for picking a shade of grey — and this viewer has its own scales. `value`
is the number the pipeline computed, so it is what ranks arcs, exports and reads out under a
pointer. The display score is kept in the detail, where a reader can see the two disagree.

**A `longrange` writes every interaction twice and that is the interesting part.** The format exists
to be `bgzip`ped and `tabix`ed, and a tabix query returns rows whose *first three columns* overlap —
so an interaction recorded only under its left end is invisible to anybody asking about its right.
Both ends are therefore written, as two mirrored lines. Read naively that is every loop drawn twice
and every count wrong by a factor of two, so the reciprocal is recognised and folded, and the lane's
summary says how many lines it folded. The key is the two ends in a fixed order **and the score**:
two interactions over the same anchors with different scores are two interactions, and a mirror pair
agrees about its score by construction, so exactly the duplicates the convention creates are dropped
and nothing else.

### 8.19 The genePred family

`genePred`, `genePredExt` and `refFlat`: how the gene models of half the assemblies in circulation
are actually distributed, and — measurably — what this viewer was missing. The IGV store it publishes
dropped **29 of IGV's 63 tracks** for exactly this reason (§24.3, `docs/stores.md`), and those 29 are
not a corner of the catalogue, they are the gene models. Every UCSC table download (`refGene`,
`ncbiRefSeq`, `knownGene`) is this format, and so is the `refFlat` half the RNA-seq world takes as
its annotation input.

Ten columns — `name chrom strand txStart txEnd cdsStart cdsEnd exonCount exonStarts exonEnds` —
which `genePredExt` extends by five (`score`, `name2`, two CDS status words, the exon frames) and
`refFlat` prefixes with a gene symbol. Any of the three, out of a MySQL table rather than the
download server, carries a leading **`bin`** index as well.

**So the same ten columns start at column 0, 1 or 2, and the width cannot say which**: eleven columns
is a `refFlat` *or* a binned `genePred`. Deciding by "does the first column look like a number" fails
on the one gene in the file called `7SK`. What the reader does instead is **try each offset and keep
the one where the format agrees with itself** — a strand where a strand belongs, five integers, and
two comma lists whose length is the exon count *and* whose blocks tile the transcript from `txStart`
to `txEnd`. Three numbers and two lists agreeing about a count and a span is a statement the file is
making, and it is the only kind of evidence a headerless text format can offer that does not arise by
accident. The offset is decided **per row**, which sounds lax and is the opposite: it is what reads a
concatenated file, and a dump whose `bin` column is present on some tables and not others.

**A `FeatureSet` with exons and a coding span**, which is what `parseGtf` produces — the two formats
describe the same objects and differ only in how they spell them. The one arithmetic difference is
that a genePred's lists are **absolute coordinates** where a BED12's are a size and an offset from the
feature's start, and reusing the BED path would have put every exon at the transcript's start plus its
own position.

`name` and `id` follow the rule §8's `FeatureSet` already states: `id` is the accession the file is
keyed by (`NM_001005484`), `name` is the symbol a reader looks for (`OR4F5`), and `name === id` is
how the set says the file gave no symbol. `refFlat` keeps the symbol in front of the ten and
`genePredExt` keeps it behind as `name2`; a binned `genePred` has neither, and its leading column is
a number this must not offer as a gene called `585`.

A **`bigGenePred`** needs none of this: its first twelve columns are a BED12, so §8.7's "read it as
the BED it holds" already draws its exons in the right places. What its `autoSql` buys is the
*kind* — a gene model rather than a peak set — which decides the glyph, the search box and the line
under the label. The rows still go through `parseBed`, because they are a BED12 and there is no
second parser to keep in step.

### 8.20 bedMethyl and bigMethyl

Base-resolution modification calls, as the quantitative lane they are. The human-epigenetics case is
the obvious one and not the strongest: the strongest is **metagenomic**, because bacterial
methylation — 6mA, 4mC, 5mC — is strain-specific and is used to *bin contigs*, which is the question
the MAG layer exists to answer. A `modkit pileup` over an ONT or PacBio assembly is one `bedMethyl`
and it belongs beside the contact map.

BED9, then the measurement: column 10 is the read depth a call rests on and column 11 is the
percentage modified. `modkit` appends seven counts; the older ENCODE WGBS spelling stops at eleven.
Both are read, because the eleventh column is the whole point and everything past it is provenance.

**It becomes a track**, for `annotations/signal.ts`'s reason: a modification call is a number at a
place, so it is a `kind: 'track'` whose data stays in the worker and is sampled per view (§8.2), and
it arrives with a range, a ceiling, an autoscale, a colour and the ⌘-scroll without any of them being
written again. Read as the BED9 it begins with — which is what happened before — it was a lane of
grey boxes one base wide, eighty million of them, with the percentage never mentioned. The starting
clip is **0–100** rather than the data's own range: a methylation lane autoscaled to 12–94 % says
nothing about how methylated anything is, and the autoscale every track has is one press away.

**The one thing it refuses to invent.** A `bedMethyl` may hold more than one modification over the
same bases — `m` and `h` at every CpG is the standard output of a 5mC/5hmC model — and those are two
measurements, not one. There is one lane per loaded file, so the reader draws the **most abundant
code** and says, under the lane's label, which codes were in the file and how many rows each had:
§8.7's bargain for a truncated bigBed made again. Averaging them would produce a number that is in
no file and is the methylation level of nothing.

Strands are **not** collapsed and do not need to be: a row is one base, and the two cytosines of a
CpG are at consecutive positions on opposite strands — two calls at two coordinates, side by side in
one lane with nothing overlapping. A file written with `--combine-strands` has already made that
choice. A row whose depth is zero is dropped rather than drawn as `0 %`, which would put a floor of
confident zeroes under every uncovered base in the genome.

A **`bigMethyl`** is this in a bigBed, and is the format that most needs its schema asked: its first
nine columns *are* a valid BED9, so §8.7 produces a lane that looks entirely correct — one box per
cytosine, in the file's own colours — and is missing the only column anybody opened the file for.

### 8.21 .2bit

UCSC's packed sequence format, read by byte range. §8.8 already reads a FASTA by range given a `.fai`
beside it, so the claim here is not random access. It is three other things.

**It is one file.** A ranged FASTA is two, and the second is the one people forget to publish: every
failure mode of §8.8 — no index, an index at an address the guesser did not try, an index that does
not match its FASTA — cannot arise, because the index *is* the file's first kilobyte.

**It is four times smaller.** Two bits a base against eight, before the line endings. hg38 is 3.1 GB
of FASTA and 800 MB of `.2bit`, and that difference decides whether a lab puts a genome on a bucket.

**It is what assemblies are published as** — and, the reason this is in the same release as §24.10,
**an assembly hub's genome is a `twoBitPath` and nothing else**. Without this reader every assembly
hub in the world opens as tracks over coordinates the viewer cannot read. The two features are one
feature.

A 16-byte header, an index of `name → offset`, then per sequence: `dnaSize`, the N blocks, the mask
blocks, and four bases a byte with `T C A G` for `0 1 2 3`, most significant pair first.

**The N blocks are read and applied.** A run of `N` is a gap in the assembly; it is data, and the
packed bits under one are not blank but whatever the writer left there (`T`, in every file kent
wrote), so a reader that skipped them would draw a convincing run of thymine across every centromere
in the genome.

**The mask blocks are stepped over by arithmetic and never fetched.** They record soft-masking —
the lowercase in a RepeatMasked FASTA — and hg38's chr1 has on the order of a million of them, eight
megabytes of offsets, for a distinction this viewer discards twice: `render/sequence.ts` upper-cases
every residue before drawing it, and `gcBins` counts a lowercase `c` as a `C`. Reading eight
megabytes a chromosome to compute something nothing looks at is the cost §8.8 exists to refuse. The
count is still read, because the packed DNA begins after them.

**A long `.2bit` is refused by name rather than misread.** Version 1 is the variant with 64-bit
offsets for files past 4 GB; nothing this viewer is likely to meet is one, and a reader guessing at
fields it had never seen would fail far from here, in the middle of a chromosome, as wrong residues.
The refusal names the version and the two commands that convert it.

The assembly is `origin: 'twobit'` and **exact** — every `dnaSize` is in the index — so an 800 MB
genome declares its chromosomes in a few hundred kilobytes without reading a base. The store is the
shape `IndexedSequences` has, and for the same reason: both are "an assembly in memory and a way to
turn a window into a byte range", and every caller above them wants exactly that. What differs is two
lines of arithmetic. The CLI reads one the same way (`cli/tracks.ts`), through the same pure
functions, so a metaplot over ten thousand windows of hg38 reads a few megabytes rather than
unpacking 3.1 GB.


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

Every refusal names the file's actual state and the concrete fix — **and its title names the
subject**: *Nothing to share*, *Too many tabs*, *That workspace could not be read*. A dialog headed
the same way for every refusal makes a reader read the paragraph to find out what was declined, and
read it again later to remember which of them they had seen. Where a refusal can be avoided
altogether it is: a control that has nothing to act on is unavailable, with the reason in its
tooltip, rather than live and answering with a dialog (§8.5).

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
| BAM with no index beside it | Not a refusal: read by search (§8.13), and the row's summary says so and names the index it did not find. Refused only where the file's length cannot be learnt, since a search needs one — and then name the `#index=<url>` convention |
| BAM whose index cannot be read | Read by search, the summary naming the index that did not read and what went wrong with it |
| BAM not sorted by coordinate | Name the order it *is* in, state that reads are drawn by region, and give `samtools sort -o sorted.bam <file>`. Where the header claimed otherwise or said nothing and the search found the reads out of order, name the two places that show it, give `samtools sort` then `samtools index`, and say that a Hi-C pipeline's alignment file is in read-pair order and not made for browsing |
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
demo is the reference). The open probes with a `HEAD` before its `GET` to test range support, and
that `HEAD` is skipped for a URL carrying its own signature — `X-Amz-Signature`, `X-Goog-Signature`,
or `sig=` beside `sv=` — since such a URL is signed for a single method. A presigned link therefore
opens and goes on working until it expires (§24.6); a public bucket URL is still what a citation
should point at, because a signature has a date on it.

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

And for a `.pairs` import (§3.7), which is the one open in this application with a denominator and a
real wait — everything else is a bounded read costing a handful of range requests, and this walks a
whole file:

| Operation | Budget |
|---|---|
| Probe a `.pairs`: header, and the index if there is one | ≤ 3 range requests. One BGZF member for the format check — cut *exactly*, from the member's own header — then the preamble, then the `.px2` whole, which is small by construction |
| The binning pass | **one sequential read of the file**, and no second pass ever. Measured on `demo/ecoli/SRR19500734.pairs.gz` (17.7 M records, 238 MB): **0.69 M records/s** at the 64 KiB BGZF framing `bgzip` writes, and **0.12 M records/s** at the ~1.4 KB framing that file actually has. The 5.7× is decompression, not parsing — see below. Progress in records where a `.px2` gave an exact count, in compressed bytes otherwise; cancellable throughout |
| Every rung above the base | 0 reads. Derived from the base pixel table, which is smaller than the record stream by the ratio of records to stored pixels — thirteen to one on `demo/yeast/` |
| Every view, afterwards | **0 reads, ever.** The map is in memory; a rung switch, a pan, a zoom, the deck and every §18 task cost no I/O at all |
| Writing the `.mcool` | 0 reads. Runs beside the open map, with its own bar and its own cancel; the int64 conversion buffer is capped at one chunk rather than one column |

If metadata reads explode, the known cause is walking HDF5's object hierarchy;
`hdf5-indexed-reader` addresses it with a pre-built path → offset index and was built for `.cndb`
chromatin files. Held in reserve — adopting it would not change any file format, only the reader.

**One open is exempt, and is the only one: an `.scool` over the network** (§3.8). Listing a
container's cells reads link records the writer interleaved with the cells' own data, so it is not a
bounded read and no chunk size makes it one — measured on a 3,882-cell file as 1,015 reads averaging
512 bytes spread uniformly across 327 MB, and reproduced on a container `cooler.create_scool` wrote.
The budget is not quietly widened for it. The reader is **asked**, before anything is read, which of
the two costs to pay:

| Operation | Budget |
|---|---|
| Open an `.scool`, local | unchanged — a file on disk seeks for free and is never asked |
| Open an `.scool`, remote | a **gate**, with both costs quoted: one `GET` of the whole object, or ~1,000 small range requests for ~5% of its bytes |
| The cells table, after that listing | **0** further chunks — every cell's attributes are in metadata already fetched |
| One cell's map | as any cooler's: a bounded read (2,802 stored pixels on the Nagano file) |
| Summing *k* cells | *k* bounded reads, linear in *k* and in nothing else — 12.7 s for all 3,882 of them, gated above §7.3's pixel threshold like any other whole-file read |
| What the reader sees while it happens | `summing 1,204 of 3,882 cells…`, counted in cells because cells are what the work is |

This is the case `hdf5-indexed-reader` above was held in reserve for, and it remains the way out:
a pre-built path → offset index would turn the gate into an ordinary bounded open.

**A second open is exempt, and for a blunter reason: a HiC-Pro pair is two text files with no index
at all** (§3.9). There is nothing to hold in reserve here — the format cannot be indexed without
being rewritten — so the whole matrix is read once, at open, and every read after it is bounded and
in memory. The gate is on **bytes rather than on being remote**, because the cost is parsing and
memory rather than round trips and a local file pays it in full:

| Operation | Budget |
|---|---|
| Open a HiC-Pro pair under 200 MB | read whole, ungated — about two seconds at 100 MB/s |
| Open one over 200 MB | a **gate** quoting the size, the estimated pixel count and that the cost is paid once |
| Every read afterwards | **0 requests** — the map is typed arrays; pan and zoom are free |
| Find the bin file beside a URL | ≤ 2 `HEAD` requests, then the refusal names all three ways to supply it |
| What the reader sees while it happens | bytes, then pixels, on a labelled bar with a cancel — 258 MB in ≈4 s, three of them download |

The way out here is not an index but a conversion, and the gate says so: `cooler load -f coo` turns
the same two files into a `.cool` that opens in a handful of requests at any size.

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
contact-based contig reordering or scaffolding; ~~no writing of `.cool`, `.mcool` or
`.metacool`~~ — **narrowed**, see §18.9 and §3.7: writing a matrix *derived from an opened map* is
still refused, and writing the **primary reduction of a `.pairs` file** is not; and no differential
APA.

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
| `vmin` / `vmax` | one press (§16.5) | yes |

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
and a reader who knows the libraries are comparable presses **match all scales**, which copies the
starred map's clip onto every panel once (§16.5). A press rather than a setting, because a setting
could not keep its promise: left on, every later nudge of any panel's clip either had to be undone
or left the deck claiming a shared scale it no longer had. After the press each clip is honestly its
panel's own again, which is the stronger claim made only where it is true.

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

**The session's heading leaves the first cell.** The view's title, its locus box, its zoom steps and
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

**Every cell's chain sits in its own heading, the lead's included.** Taking a cell off the shared
navigation (§16.3) is a statement about that cell, so the control for it belongs on it, beside the
star. The lead's used to be in the bar, which put one glyph at two heights meaning the same
per-cell thing — and the one in the bar, among controls that act on every cell, read as a lock over
the whole deck rather than as the first map's own. It is drawn like every other toggle in the
application: lit while the cell is following, plain while it is not, and dimmed never (§26.3).

The deck's bar holds what is shared, in the order the work is done: **add a cell…**, which opens the
row that takes a file, a published URL, the session's 3D structure or a stack of tracks (§16.11);
**match all scales** and **match all resolutions**, two presses that each copy the starred map's
clip or bin size onto every panel once; how many across; and the whole deck as one figure — saved,
or copied to the clipboard, which is what `⌘C` reaches while a deck is on.

Rearranging is the grip and is not a button here. **Adding is**, and that is the one thing the bar
repeats: a `+` on an edge draws an *empty* cell for something to be dropped on, and a published
cooler has nothing to drop — the URL box is the only road it can take (§11) — while the tracks cell
has no other road on screen at all. The toggle is named for what the row opens, a *cell*, rather
than for the map that is only one of the four things in it.

It is **read from the left**, in one run, with exactly one control across the gap at the far right:
**close deck**, a bordered word like every other control in the bar (§5.4). Everything else in the
bar adjusts a deck that is staying, and a destructive control in among them is one a hand reaches by
accident; a window's close has been at that end for thirty years. It was the same bare × a cell's
own close is, on the argument that the two would read as one gesture at two scales — and what they
read as is two identical marks a finger's width apart, one taking a cell and the other taking every
companion and the tracks loaded for them, which is the accidental reach this placement exists to
prevent. What it closes is every companion **and every track that was only there for them** — a
bigWig dropped on a companion's edge is an import into the session's one track list,
so closing the maps it was drawn on would otherwise leave it loaded, invisible, and holding a row
that says it is drawn nowhere. A track that is also on the first map is being read against a
picture that is staying, so it keeps its lane there and loses only the companions'. The first map is
untouched throughout: closing the deck leaves exactly what closing the last companion one at a time
would.

A companion's scale controls ride **on its picture**: a button in the bottom-left corner of the map,
**above the band the ruler's labels sit in** — the same twenty pixels the renderer keeps for that
corner, because at the very bottom the button covered the first coordinate on the axis, which is the
one number a reader uses to check that two pictures are of the same window — opening a menu upward
over it, holding the five fields that say what the numbers are and how they are drawn — the score,
the baseline, the transform, the ramp and the clip. Not the overlay marks,
which act on a picture the reader is already pointing at and are slower to reach through a menu than
through the row they came from; and not an export, which the deck's bar now offers for all of them
at once. A fold *under* each panel — what this replaces — pushed every other panel of the deck down
by the height of whatever was open in it.

**A card that cannot act is absent** (§8.5). The Map, Tracks and Export cards arrive with the block
and not before: behind the whole-genome gate — a heading, what the read would cost, and the button
that starts it — the column used to show the whole Map card over an empty canvas, clip and all, and a
reader who nudged the clip there and saw nothing happen concluded the card was broken. The **overlays**
row holds only the marks that light: the refit, which is an action, stands with the turn and the
recentre in the *picture* row, where it used to be the one unlit mark in a row of seven lit ones —
read as an overlay that was off, and turned on by a press that threw the reader's pan away.

The deck's controls ride **above the grid**, and each panel's scale controls ride **inside that panel**.
They are deliberately not a fourth card in the three side columns. Those columns are the *session's*
furniture and each describes the one file the session is of; and one of them — Annotations — does not
exist at all on a file with a genome layer (§8.5), which is exactly the kind of file a deck is most
useful for, so a deck control living there would be missing precisely where it is wanted. The chosen
placement is also the plainest statement of §16.2's split: shared controls above the grid, per-panel
controls on the picture they control.

The grid is inside `.content`, which pins the light palette **while it holds a picture** — a deck's
grid, a map's heatmap or a browser's stage — so the maps do not change colour in the dark theme and
no rule had to be written to keep them from it. The furniture framing a picture is pinned with it,
since a locus box in dark chrome beside a light map belongs to neither. The pin used to be on
`.content` itself, and every view mounts there: a reader who chose dark got the landing page, the
Genomes and Chromosomes tables, the whole-genome gate and the error view as a white sheet inside a
dark frame. A drop zone and a table of chromosome lengths are not figures that will be exported, and
the argument for pinning was only ever about the ones that are.

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

Nothing else is in the hash. The lock and the drawn column count live in the per-file session
memory (§8.6) beside the table filters, on the same grounds: the hash has never carried a pan or a
zoom, so there is nothing there for a lock to be consistent with, and how many
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

This is the first entry point a reader can *find*, and until there is a deck it is the only one —
once there is, its bar offers *add a cell…* beside it (§16.5). Before either, the first companion was
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

The column count a `+` sets is remembered per file (§8.6), and the bar's **N across** picker is the
other way to set it. The two write the same number, so the grid and the picker cannot disagree.
There are no layout presets to override any more: a row of lit presets arranged however many maps
happened to be open, which is not a shape a reader states, and a deck that reflowed into a row the
moment a map was closed was not an arrangement at all. The picker is the honest replacement, and it
is also the only way a deck that arrived in a link can be reshaped — a `+` only ever grows one.

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

### 16.11 Cells that are not maps

A deck was *N maps*; it is now *N cells*, of which the maps are the kind the lock drives. Two
kinds hold no file: a **structure** cell drawing the session's 3D model, and a **tracks** cell
drawing the session's tracks alone (§25). Both answer the same short contract (`panels/cell.ts`):
adopt the view, be told the lead's window as loci, remeasure, repaint, export a canvas, be
destroyed. Everything the deck says to a *map* by name — a lock member, a lane floor, a bin size,
a colour scale, the star — it goes on saying to the maps only. A cell holds no file, so it takes no
share of the read budget (§16.7) and is not an empty card either; the bar counts it as neither.

Both are opened from the deck's add row — *add a 3D structure*, which is greyed with its reason in
its own tooltip once the deck has one (§18.1), and *add a tracks cell*. Each leads with a verb, like
the rest of that row: labelled `3D structure` and `tracks`, as they were, two nouns at the end of a
row opened by a button saying *add* read as kinds of thing the URL box takes rather than as two more
cells to open.

In the link a structure cell is `3d` and a tracks cell `tracks`, in the `maps=` list where the
maps and the `~` of a vacancy are. A deck holds **a structure cell per model** — a second `3d` opens
a second cell — and as many tracks cells as the reader opens, named apart in the location control.

**A `~` is resolved against the cells the deck is already holding, before the record.** The hash can
say no more than `~` about a local map (§16.6), and what it is resolved against was the *stored*
record, re-opened through a filesystem grant. A file that arrived by **drag and drop** has no grant:
the browser hands over a `File` rather than a handle, and nothing can ask for one afterwards. So
dropping four coolers opened four live panels, published, came back round, resolved none of them,
and replaced all four with vacancies reading *this cell held that file and it could not be
re-opened* — about files the deck still had in hand. A live cell is the best possible answer for its
own index and is asked first; the record answers for the rest; and both only ever over a `~`, so a
list naming a remote map or a structure cell at that index still wins.

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

**The window reported is the same window either way.** The rotated lattice counts in half bins, so
the right half of the last bin has no column to be measured to and the summary line under a turned
map read `400 × 400 bins · 1.0 kb · IV:1,000,001-1,399,500 · 399.5 kb` — an arithmetic a reader
checks and does not get. Every window this view reports — the line under the picture, the framing an
analysis runs on, a bookmark, what the 1D browser opens at — is snapped to the file's own bin edges,
which changes nothing on a square map and restores the missing half bin on a band. The turn is a
presentation (§17.2), and a presentation that moved the window would not be one.

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

**And wherever it is offered it is off until it is asked for**, which is `flip` being absent meaning
square and only an explicit `true` meaning turned (§11).

It was the other way round, on the argument that a block with a diagonal is a band along a genomic
axis with tracks under it — that being what a contact map is *for* at this scale, and what every
published figure of one looks like. The argument is sound about the *figure* and wrong about the
*arrival*, and the reason is the paragraph above: the conditions that make a block turnable admit one
sequence against itself and nothing else, so every map the default reached was a single chromosome —
and a reader who clicks a chromosome in the table is asking to see that chromosome, not to have it
rotated on the way in. The picture changing shape as you arrive is a worse first frame than a square,
however good the band is once you have chosen it.

So the turn is a reading, like `O/E` and the smoothing beside it: one press, and then it is written
down. The hash of an ordinary view stays short because only the reader's "yes" is in it, and a link
with no `flip` in it opens the way this viewer opens.

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
what to load: *Load a loop set (BEDPE), or a feature set (BED, GTF).* A greyed row with an instruction
on it is not an unkept promise; it is the menu.

The line takes one shape — *`<Verb>` a `<thing>` (`<formats>`).* — and **a group whose every waiting
row is waiting on the same thing carries it once**, under the heading rather than on each row. Ten of
the sixteen tasks read the matrix, so a 1D browser session drew ten rows under ON THE MAP each
carrying the identical *Open a contact map.*: a column twice as tall as its content, in which the one
gate that differed was the hardest line in it to find. Rows whose sentences differ keep their own, and
every greyed row carries its own reason in its tooltip whether or not the sentence is printed under
it.

The distinction is not *can this run now* but *can what the reader does next make it run*, and
`TaskAvailability` is the three answers: `ready`, `waiting` with a sentence, `absent`.

**The panel exists without a contact map.** Three tasks — metaplot, track correlation and interval
overlap — read only the loaded tracks, and a 1D browser session (§5.8) is exactly where a reader has
the tracks and not the matrix. There the map tasks are `waiting` on *open a contact map*, the track
tasks run, the analysis worker is never mounted because nothing asks it for a pixel, and a result's
provenance names the assembly rather than a block.

**A locus a reader can point at is picked on the map, not typed.** Reading
coordinates off a picture in order to type them back in beside it is asking
twice. So `RegionParam.pickable` puts a *pick on map* button next to the locus
box — **next to**, in the same row and the same cell of the label grid, because
the argument above depends on the two being one control; pressing it arms
`ui/mapPick.ts`, the next Shift-drag on the map fills the box instead of zooming,
and the button goes out (§8.9). An *arm* rather than a
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

**The Analysis drawer** is the workspace: parameters, a **Run** button with **cancel** beside it and
the price after the pair, progress, results, exports. The row's controls are ordinary bordered buttons
like everything else in a bar (§5.4), and so are the exports under the results: the control that stops
a forty-second scan and the ones that get the numbers out of the application are the two a reader most
needs to find, and drawn borderless they read as captions. It is anchored to the right of the body, full height, resizable by its left
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
task somebody has to leave the app to redo.

**Every setting about the matrix is a number of bins, or a number of diagonals, and never a length of
genome.** It was the other way round — a length was asked for in base pairs, with the resolved bin
count printed beneath the box — and that rule had it backwards in both directions. A scan band, a
diamond, a shift, a stratum, a near-diagonal trim, the separation between two anchors: every one of
them *is* a count of the grid's own cells, which is why the runner's first act on a base-pair answer
was to divide it by the bin size and round. So the reader was doing arithmetic the run then undid, and
the same typed number meant one thing on one rung of an `.mcool` and another on the next — 100 kb was
a control clear of a 43-bin window at 1 kb and a control inside it at 10 kb, with nothing on screen
saying which. Where the quantity is a count of diagonals rather than of bins it says `diagonals`,
which is the HiC score's parameter and the near-diagonal trims. **The bin count under the box is gone
with the boxes it was for**, and what a run came to in base pairs is said once, by the runner, about
the file actually open: *a 50-bin window is 2 Mb at this file's 40 kb resolution*.

Two things are not that, and neither is an exception waiting to be tidied away. **A 1D track has no
bins of the matrix's**: a metaplot's flank, a FRiP's sampling step and a track correlation's window are
lengths of genome, they are the same length at every resolution, and they are asked in base pairs with
no mention of bins in a label, a unit or a hint — a correlation over bigWigs can run with no contact
map open at all. And **a plot's own axes stay in base pairs** (§26.2), so a pileup's `±21 kb`, a P(s)'s
abscissa and the `.scool` phasing plot's published band edges are unaffected: those three numbers are
a citation and an axis label, and in bins they would be a different number on every file.

Four parameter kinds refer to what is already loaded rather than to a number, and all four **default to
the starred entry** where the concept exists — the same star the 1D browser's feature search is keyed
on (§5.8): a feature set, a pair set, a track — bigWig *or* synthetic — and a sequence. This is what
lets a task like compartment phasing (§18.8) be a dropdown rather than a second file drop.

Parameters are remembered per file and per task, and travel in an exported session, so that reproducing
a figure is opening the session and pressing Run.

**A locus parameter is in cooler's grammar** — 0-based half-open, ungrouped — because that is the one
form a run's *record* can be in: it is what the runners parse, what the session file carries, what the
CLI button prints, and what a reader pastes from `metacooler show --range`. This is the one box in the
app that is not in the display form of §26.1, and it is the exception because it also takes a
comma-separated list, which the display form's thousands separators cannot survive. So it says which
grammar it is in, in its own title, and never claims to be "the same thing the locus boxes take".

**A locus picked off the map is converted on the way in.** `ui/mapPick.ts` writes the *paste* form —
1-based inclusive, which §8.9 pins for the clipboard because that is what samtools and bedtools take —
so the form shifts it by a base before it becomes a parameter. Without that, a drag framing bins
230–1042 reached the runner naming bin 231 onwards: one bin past the stretch the reader had just
pointed at, with nothing on screen saying so, and a 4C profile is read off its anchor.

**Which sequences to run on is one question and it has one shape: a column of tick boxes.** There
were two — a column of tick boxes on four tasks, and on five others a dropdown whose first option
read *every sequence* — and a reader met both in the same column, asked the same thing, a row apart.
The tick boxes are the superset: *all of them* and *one of them* are two of the answers a list of
tick boxes gives and *these three* is a third that a dropdown cannot express at all. So every task
whose question is *which sequences* takes the list, the answer is the names written out, and three
answers are three answers — **unanswered is every sequence** (the form ticks them all, and a stored
session or a `metacooler-run` line with no `--sequences` means the whole file), **a subset is that
subset**, and **nothing ticked is nothing to read**, which the estimate refuses rather than widening
back into a genome-wide run. A ticked sequence this file has not got is named and left out, never
silently dropped (§5.9). What stays a **locus** is what a list of names cannot answer: the 4C anchor,
the structure tasks' *distance to*, the reconstruction's own box, each of which takes a window or a
point on the map, and narrowing any of them to a whole sequence would remove the task's point.

**The form is the cards' form.** A label is one to three lowercase words in the same column down the
whole form, a select's options are lowercase, and one hint is one sentence beside the control it is
about — §26.4's rules, and this is the surface that was breaking all three. A label and its control
share a row: a single on/off button is not a group, and the full-width shape is for a group that is
genuinely one — a checklist, a number with a slider beside it, four marks in a row — whose hint then
goes *under* the group rather than beside the word above it. A hint never repeats what the control's
own label, options or state already say: a column of tick boxes that opens with every box ticked does
not need a line saying that every sequence is read unless you say otherwise.

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

**The framing line is one string in one grammar.** The window it names is the display form (§26.1),
written by `formatLocus` — so the drawer's *will run on*, the figure's caption and the cell's
subtitle agree character for character, where the head once said `IV:1,000,000-1,400,000` and the
picture under it `IV:1,000,001-…`, a one-base disagreement that reads as two windows. The reading is
named **once**: the balance flag and the score picker's label are both the word `balanced` on the
commonest file, and pushing both wrote `1 kb bins · balanced · balanced` into every provenance line
and every TSV header, which reads as two normalisations having been applied. Where the two differ,
both are said — `balanced · correlation` says what neither half says alone.

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

**Pressing Run does not destroy the last answer.** A result used to be replaced in place, so a second
press took the figure, the numbers and the parameters that produced them with it — and nothing about
a finished result makes it cheap to produce again: a pileup over forty thousand anchors is a minute of
range requests, and a reader who lost it by pressing Run lost the minute. What people actually do with
this catalogue is run a thing, change one number, run it again, and then want the two side by side —
or, more often, discover that the previous answer was the one worth keeping. So the runner keeps the
last **eight** runs of each task **on each map**, newest first, and the drawer offers `older` /
`newer` / `latest` over them with the run's own clock time and, in its tooltip, *which parameter
differs from the latest* — the reason the two pictures are two pictures, which nothing else on screen
states. Everything downstream follows the run on screen: the framing line, **recompute**, the CLI
command, the TSV and the vector export are all that run's, because a result is a record and stepping
back to one means stepping back to all of it. Bounded because these hold typed arrays, and not
persisted for the reason the framing is a snapshot: a history restored against a file that has since
been re-binned would be a list of figures that no longer describe anything.

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

**The estimate is a price and nothing else, and its class is said in words rather than in a colour.**
*One pass over the whole pixel table*, *154 strips along their diagonals*, *up to 40 MB at a time* —
followed by the requests and the bytes. It is `--text-dim` whatever it costs, because a cost is a fact
about what is being offered rather than a warning about the answer (§26.5), and `--danger` beside
**Run** means the one thing it means everywhere: this will not happen. Nor does the line promise
progress or a cancel. It used to end *progress is reported as it goes and it can be cancelled at any
point* on every scan — eighteen copies of a promise the bar and the button beside it make by
existing — which spent the one line a reader checks before spending compute on reassurance instead of
a figure.

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

**A matrix may carry profiles along its top and right edges.** One value per column above the picture
and one per row beside it, so they line up with it by construction rather than by a second resampling
in the renderer. The two edges rather than two arbitrary ones: the colour bar is on the right in this
application, so the right-hand profile sits between the picture and the bar, and the reader's eye
leaves the pileup along the same two edges its anchors are on. Each side is a list, because a reader
comparing two marks wants both above one pileup rather than two pileups, and each profile is
normalised on its own — two tracks in two units have no common axis. A key line above the picture says
which line is which, in the same palette a curve would draw them in, so a track drawn here and the
same track drawn as a curve two blocks down the drawer are recognisably one quantity. The figure's
requested height counts the bands, or the top one would be clipped away — which is the one part of a
figure a reader cannot reconstruct from the rest. The only task that sets them is the APA (§18.8).

**A curve's abscissa may be a list rather than a quantity.** One value per sequence, per sample,
per MAG — which is a bar chart, and the mark that draws it is §18.13's. The x values stay numbers and
the output carries a name for each of them, so the axis names the thing standing at each tick and the
figure keeps the wheel, the marquee and the two typed bounds a category axis would have cost it —
which a four-hundred-contig metagenome needs far more than a sixteen-chromosome yeast does. A tick
that falls between two members names nothing, because there is nothing between the fourth sequence
and the fifth. The TSV writes the names in its first column: a column of `0, 1, 2` beside a column of
fractions asks the reader to count bars on the picture to find out which row is which, which is the
same argument the matrix export makes for putting its ticks down the left edge.

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

**Where an output went is one sentence for the run, and the outputs are a row each.** The sentence says
where — *3 tracks added to the Synthetic tracks card in the Annotations panel.* — and each row under it
is a name and its export buttons. Not the sentence per output: spatial tracks makes three lanes, and
three lanes drawn as three dashed boxes each repeating the same thirty words, each with a lone TSV
under it, made a run of three exports read as a run of three paragraphs. The sentence also does not say
what a lane *is*, or which tools read a bed3d: the reader can see the lane on the map, and the format's
button carries its own tooltip.

**The result line is `computed in 2.0 s at 20:49:46`.** A clock on the wall, in the reader's own hours,
and never the ISO instant — which is what *copy provenance* beside it puts on the clipboard and what
every export carries at its head, and which read in a sentence as machine output that had leaked. The
exact stamp is that line's tooltip, so it is one hover from the words and identical to the copy.

### 18.8 The catalogue

Twenty-five tasks, in **four cards — 2D, 3D, 1D and Metagenome**. The build order is in
`TASKS_PLAN.md`; what follows is what each one must be.

**Cut by the dimension the question is about**, not by the file it reads: a task is **2D** when its
subject is the contact matrix, **3D** when its subject is a model of beads in space, **1D** when its
subject is a track or an interval set along the sequence. That puts *aggregate peak analysis* with
the matrix it piles up rather than with the loop set that says where, and *metaplot* with the track
it averages rather than with the features it averages over — each beside the thing a reader goes
looking under. **Metagenome** is the one group that is not a dimension and stays one because its
four tasks are not about a dimension: a MAG is a *bin of an assembly*, and *split-MAG detection*
belongs beside *MAG purity* rather than beside *compartments*.

Each is a **card** of the Analysis panel, with the frame, mark and fold every other card in every
other column has, in the order their first task appears in the registry (§18.8's catalogue order is
an argued reading order). A group whose every task is *absent* for the file in hand has **no card at
all**, which is how the Metagenome card stays away from a file with no genomes. Within a card the
task that **makes** the thing the others read comes first: *model from the map* opens the 3D card,
because a reader with no structure loaded has exactly one thing to do in it; *find a motif* opens
the 1D card for the same reason.

**2D.** *Contact probability P(s)* per contig, genome or file, with the log-log derivative, and
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
is on screen must not change what an O/E is taken against.

**And, where the map was imported from a `.pairs`, the four orientations beside it.** Not a
property of the matrix at all: it is counted from the records, in log-spaced base-pair bins, in the
import's own pass (§3.7), because binning sums the four together and destroys exactly the thing they
are read for. The separation at which `++`, `+−`, `−+` and `−−` converge is the shortest one the
library can be believed at, it is usually *below* whatever grid the reader chose, and the run reports
it as a number under the plot. All four are normalised by **one shared denominator** rather than each
by its own: ligation does not know which way a fragment pointed, so at long range the four are
equally abundant and lie on top of each other, and scaling each by its own total would divide the
short-range excess back out and take the convergence point with it. A `.pairs` that was never
imported can be named in the form and is read for its records alone — no map changes and nothing is
binned — and a local file has no address to name, so it is dropped on the app instead, which counts
the same curves in the same pass. Absent, with a sentence, on a map that was opened as a matrix.

*Scalogram*, which is P(s) with one summation left undone, and sits directly after it for that reason.
The decay curve averages every bin of a sequence into one line and answers *how does this genome fold*;
the scalogram keeps the bins apart and answers *where does this genome fold differently from itself*.
At each bin it accumulates the cumulative distribution of its contacts over separation — the two cells
either side of it at each distance, which on a circular sequence are the two ways round — and reports
the separation at which that cumulative reaches each of a set of quantiles. Cournac et al. (2012)'s
reading, and `HiContacts::scalogram()`'s quantity. It is a **distribution** and not a mean, because
contact probability has a heavy tail by construction: the mean separation of a bin's contacts moves by
a factor of two when the balancer drops a single distant cell, and its median does not. The quantile is
**interpolated** between the two separations the cumulative crosses the threshold between, because
rounding to the bin would quantise five smooth bands onto multiples of the bin size and step all five
in the same places.
Its reach is what it costs, it is a number of **bins** — it is the depth of the band the run reads,
and asked in base pairs it was divided by the bin size before it meant anything — and the default is
**0, the whole sequence**, because that is the only unbounded answer: cut at a thousand bins on a
250,000-bin chromosome and the ninetieth centile is the ninetieth centile *of what is within a
thousand bins*, a different number wearing the same name. The estimate prices the uncut run as the
square it is and says so; a reader who sets a cut is told what it came to in base pairs on this file
and gets the cut in the lane's own label, on every band, so the picture cannot be mistaken for the
unbounded one.

*Coverage and marginals* — total, cis, trans
and the cis/trans ratio — as synthetic tracks, which is how a reader sees that a domain is a coverage
artefact. *Cis and trans per sequence* is the same question one level up and the first number any
Hi-C paper quotes: per sequence its cis and trans contacts and the ratio between them, and beside
that the **sequence × sequence** square with a ranked table under it. The off-diagonal value is
observed over what the two sequences' own trans coverage predicts under indifference, `T_a·T_b/2T`,
scaled so that the expectation sums to the contacts there actually are — without that correction the
model spends part of the mass on a sequence contacting *itself*, which is not a trans contact, and
every cell comes out uniformly above one so a picture centred on 1 is centred on nothing. Above 1 is
a translocation, a fusion, a centromere cluster or a Rabl configuration, depending on the organism.
It is the same accumulation the inter-MAG network performs with the group being a contig rather
than a genome, and **it is not a translocation caller**: a ranked table against a stated null is a
summary of the file, and a call would need false-discovery control and a golden built from
`hic_breakfinder`'s own output, which is §18.9's bar and which nothing here attempts. The diagonal
is left out of the square rather than drawn, being one to three orders of magnitude above every
other cell and therefore the whole colour scale.
**And the per-sequence reading is a picture as well as a table**, because it is what the task is
opened for and it was the one output with nothing to look at: one bar per sequence, in the file's own
order, of the cis fraction, of the trans fraction, or of both stacked — which, the two summing to
one, is a full bar split at the cis fraction. A setting says which. **Fractions rather than
counts**, since a bar of a sequence's raw contacts is a picture of how long the sequence is and says
nothing else; the ordinate is a share and is written in per cent while the numbers behind it stay
fractions (§26.2); and a sequence with no contact at all is a gap rather than a bar of height zero,
which is the rule its row in the table already keeps. There is no ceiling on the number of bars as
there is on the square: a square becomes a grey band because its cells shrink in both directions at
once, while four thousand bars are a silhouette of the same shape, read the same way, and one
control away from the line that silhouette already is.
*Per-cell contact QC* is offered on an `.scool` and nowhere else, and it is there because the whole
of that container's interaction is a decision nothing was helping anybody make: the Cells table ranks
by `nnz` and `sum`, which is what the *writer* recorded and a statement about the sequencing rather
than about the contacts. Per cell, from its own pixels: total contacts, cis fraction, and the share
of its contacts in each of four separation bands — Nagano et al. (2017)'s, whose *near* against
*mitotic* scatter is the cell cycle drawn as a horseshoe. The edges are typed in base pairs with that
paper's mouse-sized defaults, because a yeast chromosome is inside the near band and the run says so
rather than drawing a column of points on the axis. **Base pairs and not bins**, which is the one
matrix task where that is so: the three edges are a citation, they are what the scatter's own axes and
the table's own column heads print, and nothing in the run ever counts bins with them — the histogram
measures a contact's separation in base pairs and compares it there. It costs exactly what a pseudo-bulk of the same
cells costs — the same reads in the same order, with one accumulator per cell instead of one shared —
and its numbers land back in the **Cells table** as sortable columns, because the gesture they are
for is the one that table already has: sort, tick a run of rows, sum them. It does not assign a
phase: the bands are a measurement with a citation and a cut through the horseshoe is a method with
choices, and §18.9's argument applies to a phase call as it does to a loop call. *Diamond insulation* at any window, or several windows at once, with boundary calling from its
minima; it never sums across a contig boundary, and never across a MAG boundary on a metacool.
**Both scans on the map read a diagonal rather than a square**, and that is what decides how fine a
resolution either can be run at. A diamond reaches `window` bins each side of the bin it scores and
chromosight correlates inside a band `max_dist` wide; neither has ever needed the `n²` square around
those cells, and reading one put a ceiling on each that belonged to the reader rather than to the
arithmetic — a single `Float32Array` is refused past 23,170 bins on any machine (§5.2), which is
116 Mb at 5 kb, and loop calling stopped at a hard-coded 8,192 bins, which is 41. Insulation now walks
the sequence as overlapping squares with a `window`-bin halo, filling in the *sums* — which are local
to a bin — and takes the score, which is a ratio against the mean over the whole sequence, once at the
end; `diamondSums` is unchanged and still goldened against cooltools, and the answer is identical cell
for cell rather than merely close. Loop calling reads the band it was always going to scan, which is
what `analysis/chromosight.ts` had already banded every one of its own objects to. Its gate is
therefore a bound on the **band** — the scan distance times the sequence — and no longer on the
chromosome: the whole mouse genome scans at 5 kb, and what is still refused is a deep scan on a fine
grid, named as the two settings that fix it. **A sequence a gate does skip is named**, which the old
one promised and did not do.
**It calls the domains between those boundaries too, and by default**: the span from each call to the
next, as a second overlay beside the points. That is not a second algorithm — it is the eight lines of
pairing that every reader was writing by hand — and it is on by default because a boundary set is half
an answer: everything downstream of insulation takes an *interval* rather than a point, and the scaled
pileup over those intervals is the domain APA. Consecutive domains **tile**, so the lane reads as a
segmentation the way the A/B track does, and each carries the **weaker** of its two edges as its score,
because a domain is only as well defined as its worse-supported side. Two boundaries make a domain and
one makes nothing: the two ends of a sequence are left out rather than run to the telomere, which would
assert an edge the data never placed.
*Directionality index* — Dixon et al. (2012)'s signed χ², and the other answer to the question the
diamond asks. Insulation says *little contact crosses here* and finds a boundary whatever is on either
side of it; the index says *this bin looks one way* and finds it from the asymmetry, which also marks
the inside edges of a domain and gives the sign flip the original paper's HMM segmented on. A boundary
both agree about is a boundary. Its window is in **bins, like the diamond's**, because both tasks are
read side by side against the same map and a form that asks for one in bins and the other in base pairs
makes that comparison arithmetic; the default is **50 bins**, which is Dixon's 2 Mb at the 40 kb his
paper worked at, and the run notes what that came to in base pairs on the file actually open, since a
50-bin window on a 1 kb bacterial map is 50 kb and is a different reading of the genome. The statistic
is computed as `sign(B − A)·(A − B)²/(A + B)`, which is the paper's long form collapsed by an identity
the tests check rather than trust, and `ignore_diags` defaults to **0** here where the diamond's is 2:
the index *differences* two sums that both contain the near-diagonal, so it largely cancels, and Dixon's
own numbers were computed with every cell in. `minValid` is a fraction of **each side separately**,
because a bin with a full window one way and an empty one the other is the worst case and would pass a
test on the total.

It calls **borders and domains**, the same two overlays the diamond produces and through the same
kernel. The reading the index gives of a domain is a shape rather than a value — the 5′ half looks
downstream and the 3′ half upstream — so a border is the negative-to-positive flip between two domains.
Called flip by flip that is fragile, because a track that stutters across zero has crossings a bin apart
and only one of them is an edge, and the rules that pick it are the rules of prominence written out
badly. So the index is **integrated** first: the running sum climbs through every downstream-biased
block and falls through every upstream-biased one, which makes each border a *local minimum* and each
stutter a dimple on the flank of the real trough — exactly the distinction `callBoundaries` already
draws for the diamond, with tests. One kernel decides what a called edge is, both overlays filter on the
same column and tile the same way, and the call lands **one bin past the minimum**, which is the first
bin that looks downstream again and therefore the opening bin of the new domain rather than the closing
bin of the old one.

The curve is standardised by the **median absolute index** before it is integrated, so the prominence is
in *bins of ordinary directional bias* rather than in χ². A χ² grows with how deep the library was
sequenced, so a threshold in the index's own units is a different threshold on every file; this one is a
property of the structure, and it is what makes a prominence a reader found on one map worth typing into
the next. The gaps the index leaves stay gaps — the sum carries across them but emits nothing, so a
dropped stretch cannot be the floor of a trough — and Dixon's own HMM differs from this in one visible
way worth knowing before comparing against a published set: the HMM leaves stretches it calls
unorganised in no domain at all, where borders-between-borders tile.
*HiC score* — the **mean** cell value along the bin's own line across the near-diagonal, which is the
reading Bignaud et al. use where the question is not where a domain ends but how tightly a stretch is
folded against itself. Every cell `a[k, k + d]` for `|d| ≤ D − 1`, over `N = 2D − 1`, which is how many
of them there are. The first two are **ratios** and are deliberately blind to depth, which is what makes
them comparable between chromosomes; this is a **mean of cell values** and is not, which is why it is a
third reading rather than a third smoothing of the same one — a region that has lost its local structure
has a smaller mean and an unremarkable insulation score, because the ratio it is measured against fell
with it.

**Half a crosshair, not a whole one.** Drawn on a map the shape is a straight line through the diagonal
— one arm-pair of the cross. The matrix is symmetric, so the row and the column carry the same contacts
under two names, and taking both would count every off-diagonal contact twice against a main diagonal
counted once; one arm-pair counts each contact exactly once. Every cell in it touches bin `k`, which is
what makes this a statement about *that bin* rather than about its neighbourhood: a square window would
also count the self-contact of `k − 1` and the corner joining `k − 1` to `k + 1`, cells that involve `k`
in no way, and on a bacterial map those borrowed cells make consecutive bins share half their score and
turn a single bright bin into a three-bin plateau. This is the shape the R the score comes from computes
and the app is checked against it: on `Bignaud2025_T7.mcool::2000` at `NC_000913.3:3,442,000`, the
kernel returns that script's own sum to the last digit once multiplied by `N`.

**The parameter is a count of diagonals**, counting the main one, defaulting to **3** — the main
diagonal and the one either side, five cells, reaching two bins each way, which is the bacterial reading
at the 2 kb resolution this score is computed on there. It is the R script's `num_diagonals` plus one,
that one counting the diagonals *beside* the main one. In diagonals rather than base pairs for the
reason the diamond's window and the index's are in bins (§18.5): the near-diagonal is a fact about the
grid, and the same typed distance meant three diagonals at one resolution and one at the next. The
runner says what the reach came to in base pairs on the file open and how many cells are behind each
point. The band behind it is read `D − 1` deep and no deeper, which is the shallowest read of the three
banded tasks — at the default, two bins, and on most files one strip with no tiling at all.

**A bin without a whole line through it scores nothing.** Dividing a short sum by a full `N` fades both
ends of every linear sequence towards zero, which reads as *this end is unstructured*; it is the
artefact the diamond refuses partial windows for, and it arrives here the moment the reading becomes a
mean. A circular sequence has no end to run off and every bin on one is scored. A cell the balancer
dropped *inside* a whole line is a different thing and is counted rather than guessed at: the mean is
genuinely smaller there, is never scaled up to pretend the missing cells were average, and a bin that
has lost more than `minValid` of its line scores nothing at all.

**`ignoreDiags` matters more here than its default suggests.** At three diagonals the main diagonal is
the bulk of the line; it is where self-ligation and undigested fragments land; and on a balanced map it
is the one place the weights were never fitted, since cooler's balancer excludes `ignore_diags`
diagonals from its own solve and then scales them anyway. A score carried by that cell is a score
carried by the protocol — and a peak that is in the weights rather than in the counts looks exactly like
a peak that is in the biology.

*4C profile* from an anchor — a sequence, a stretch of one, or on a metagenome a whole genome — output
as a bigWig. On a cooler it is **cis by default with trans as a stated-cost toggle**, and optionally
**over expected**, where "expected" means the anchor's own sequence's decay in cis and the mean of what
the anchor reaches off it in trans, so that a profile carrying both halves carries one quantity. Per
sequence rather than from P(s)'s genome-wide curve: a small chromosome divided by the average behaviour
of the large ones comes out with a slope that is a property of the set.
**And optionally over coverage, which is the other bias and a different one.** The decay is a property
of *separation*; coverage is a property of the **target bin** — a bin in a repeat, a bin with few
restriction sites, a bin the mapper half-lost is seen less by everything, so it is a dip in every
profile drawn against it whatever the anchor. On a raw map those dips are most of the small-scale
structure a reader would otherwise take for real, and they sit exactly where a spurious interaction is
most tempting to believe. So *Normalisation* is one control with four answers — none, by coverage, by
P(s), by both — rather than two controls or three exclusive options: the two divisions are independent,
a reader wanting a clean profile wants both, and the provenance line then says which of the four the
numbers are. The divisor is each bin's own total contact **centred on one**, so it is a bias correction
and not a change of units: a raw profile stays in contacts and an O/E ratio stays centred on one. The
mean behind that centring is taken over the bins that *have* coverage and not over every bin in the
file, or a cis run — which fills the marginal for one sequence and leaves the rest of the assembly at
zero — would scale the whole track by however much of the file that sequence happens to be. In cis the
divisor is the column sums of the square already in hand and costs nothing; with trans it is a total
over every bin, so the pixel walk **cannot stop at the anchor** the way §18.6 otherwise prices it, and
the estimate says the pass is the whole file rather than half of it. A marginal accumulated from half
the file would correct the bins before the anchor and leave those after it uncorrected — one quantity
by the axis and two by the arithmetic, which is the failure the trans expectation already exists to
prevent.
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
A reader who takes the thresholds over types the three distances — the scan band, the floor away
from the diagonal and the gap between two calls — as **counts of bins**, since each is a count of the
grid's own cells and upstream divides its own base-pair config by the bin size before using it. The
presets stay in base pairs, because they are generated from the installed package and must not be
edited, and they are converted in exactly one place.
It emits four things and the split is the point: a **loop set** (a bedpe, or a BED for the patterns
that live on the diagonal) that lands on the map as an overlay the moment the run finishes; the
**pileup** of every window it called, drawn on chromosight's own fixed 0–2 seismic scale so it can
be laid beside a published figure; the **spectrum** of the scores behind that pileup, because a
smooth shoulder running down to the threshold says the calling stopped where the threshold was
rather than where the pattern did; the **loop spectrum**, which is those same scores against how far
apart the anchors are; and a table of the strongest calls.

The loop spectrum is the plot the other two cannot give and the reason is that both of them average
the distance away: a pileup is a mean over windows at every separation the scan covered, and a
histogram counts scores with no regard to where they came from — so a set whose 30 kb calls are loops
and whose 2 Mb calls are noise is a plausible dot under a clean unimodal peak. Against distance the
two commonest ways a loop set is wrong are visible at a glance. Scores that **fall away with
separation** are a detector reporting the distance decay it failed to remove; scores **piled against
the minimum-distance cutoff** are calls made on the diagonal's own shoulder, which is where a template
that looks like a blob finds a blob in every map ever sequenced. It is a cloud of points with a median
line through it in log-spaced bands — the points are where the calls are, spread included, and the
line is the trend; bands rather than a fit, because nothing claims the relationship has a shape, and a
median because a tail in the score distribution is exactly what is being looked for. Log-spaced and on
a log axis, for the reason every distance plot here is. Drawn only off the diagonal, where there is a
separation to plot against; thinned by rank in separation past a couple of thousand marks, never
truncated, so it stays the same picture. The same plot comes back from the chromosight **pileup**
(where the scores are per anchor rather than per call) and from the ordinary APA over a loop set,
where the quantity on the ordinate is each anchor's own P2LL. This is the one task whose
output is a *claim about the data* rather than a summary of it, which is why §18.9's paragraph
against loop calling is answered in that section rather than here, and why its golden is the
package's own output rather than a re-derivation (§18.10).
*Reproducibility* is the one task in the catalogue whose unit is a **pair of files**, and it is a
port: HiCRep's stratum-adjusted correlation (Yang et al. 2017), which smooths both maps with a 2D
mean filter, correlates each diagonal **separately** — where the decay the two share is a constant
and contributes no variance — and pools the per-diagonal coefficients by the Cochran–Mantel–Haenszel
weight `N_k √(var₁ₖ·var₂ₖ)`. Both halves are load-bearing. Plain Pearson on two matrices comes out
near 0.9 for two *unrelated* maps of the same assembly, because almost all of the variance is in the
one gradient every Hi-C map has; and without the smoothing the coefficient measures depth as much as
structure, which is why two shallow replicates would score worse than two deep ones of different
conditions. It reads a **band** rather than a square, so a mammalian chromosome is a few dozen
bounded reads. How far it compares is a **number of strata**, capped at and defaulting to 500: a
stratum is a diagonal offset — which is the whole reason two maps on different grids cannot be
compared at all — so the 5 Mb this used to be asked in was divided by the bin size in two places, and
reached the cap on every file at 10 kb or finer.

**The other maps are the deck's**, in the order they are on screen and under the reader's own names
(§16) — there is no second file picker, because a coefficient against a file that is not on screen
is a number with nothing to look at beside it. The one thing the deck deliberately does not settle
is the grid: §16's lock is in base pairs precisely so a 1 kb file and a 5 kb one can follow each
other, and a stratum is a diagonal offset in *bins*, so a mismatched map is refused by name in the
estimate exactly as §5.7's triangle refuses a mismatched pair. Three outputs: the N×N coefficient
matrix on a fixed `[0, 1]` scale, the per-sequence table, and — the one that says more than the
scalar — the **correlation against separation**, which distinguishes *these agree near the diagonal
and not far from it*, which is a depth difference, from *these disagree everywhere*, which is two
experiments. Two departures from the reference are stated where they are made
(`analysis/hicrep.ts`): the reference is defined over dense raw counts and has no missing cells,
so a smoothing window here is a mean over the cells that **have** values and a stratum is correlated
over the positions where **both** maps do. Neither changes the answer on a file the reference was
defined for.

*CID* — insulation plus boundary calls plus a pileup over those calls — is **gone**, and its going is
the argument that withheld it carried to its end. Everything it did is reachable and now in one place:
insulation calls the boundaries, calls the domains between them, and an APA over those domains is the
pileup. What it added over that was a composite whose three settings never reached the step they named
— `AnalysisRunner.plan` walks a required task at *that task's* defaults — so its window, its region and
its prominence were controls that changed nothing, and its estimate read a window labelled base pairs
as a count of bins. A task nobody could run, whose settings did not work, duplicating two that do.

**Which settings are settings.** A parameter is a question the reader is *entitled to a different
answer to*; anything with one right answer per file belongs to the file. **Balancing** is the case that
settles the rule: a balanced cooler should be read balanced and a raw one has no weights to apply, so
the six matrix tasks derive it from `hasWeights` and show no control — it is still a parameter in every
other sense, so the runners are unchanged and an exported TSV still says what the numbers were computed
with. The same reading removes the near-diagonal trim's ambiguity (**bins, not base pairs**: the
near-diagonal is a fact about the grid, and a number typed in base pairs meant three bins at one
resolution and one at the next), takes P(s)'s *sequences to draw* away entirely (a run that leaves out
sequences by default answers a question about a subset the reader did not choose), and settles *which
sequences* on **one shape, the tick boxes** (§18.2) — where a dropdown offering *every sequence* or
one of them could not say *these three*, and where the seeding it used to get from the map's framing
silently narrowed three tasks to whichever chromosome happened to be on screen. Five tasks moved onto
it — P(s), the scalogram, insulation, the directionality index and the HiC score — and each reads
every ticked sequence on its own, which is one lane or one curve apiece. The **estimate** refuses a
run with nothing ticked, and refuses one whose ticked sequences are all too short for the window
rather than reading them and reporting a column of gaps; **unanswered** is every sequence, which is
what a job that never met a form means — a stored session, or a `metacooler-run` line with no
`--sequences`.

**Over tracks and feature sets.** *Metaplot*, in both **reference-point** (a point ± a flank) and
**scaled-region** (flank, body resampled to a fixed width, flank) modes, strand-aware, over any number
of bigWig or synthetic tracks, with a bootstrap band and a companion per-feature heatmap — because the
mean of a bimodal set is a line that describes nothing. *Aggregate peak analysis*, likewise in both
**fixed** (centre ± W bins) and **scaled-region** (the domain, or the rectangle between two anchors,
resampled to a fixed grid) modes; on-diagonal from a feature set, off-diagonal from a pair set, and
off-diagonal from **every pair of one feature set** inside a separation range;
normalised by **distance-matched controls by default**, by observed/expected, by **chromosight**, or
not at all; with the P2LL enrichment reported under it and a per-feature score table that can leave
the app.

**A pileup's axes are distances, in base pairs.** `-21 kb`, `0`, `+21 kb` — five labels along each
axis, the ends at the ends, the sign written out on both sides because what a label says is *which
side of the anchor*. They were counts of **bins**, which is a number only a reader holding the
resolution in their head can use and a different number for the same window at every resolution: a
±21 kb pileup reads `±21` at 1 kb and `±21` at 5 kb, two pictures five times apart labelled
identically. The labels are positions along the axis rather than the offsets of the cells they land
on, which is what keeps a symmetric window symmetric — rounding each quarter point to a whole bin
puts `-10 kb` opposite `+11 kb`. A *scaled* window has no such distance, its axis being the feature
from 0 to 1, and keeps its own labels. The rule is one function in `analysis/run/labels.ts` and the
three tasks that draw a pileup — APA, chromosight's own, and the chromosight pileup — all read it,
since two of them rounding differently is how one figure comes to look computed by another tool.

**A pileup is cut about a point of the feature, and which point is the reader's** — *start*, *centre*
or *end*, strand-aware, the same three the metaplot has offered since it existed and spelled the same
way. It took the midpoint and never said so, which on a gene set is a pileup at whatever is half way
along a gene: not the figure anybody draws, which is the one at the transcription start site. Worse,
a metaplot set to *start* and a pileup beside it were then aggregates of two different anchor sets
under one caption. The point the window is cut about is also the point a *generated* pair's separation
is measured between, or the range and the picture would disagree about which pairs they are of. The
axis label says which point it is; *bins from the centre* over a pileup of four thousand TSSs is a
caption for a figure nobody drew. Hidden where there is no point to choose: a loaded loop set brings
its own two anchors, and a domain pileup's window *is* the feature, start to end.

**Tracks aggregate along the pileup's two edges.** Any number of bigWigs or synthetic tracks may be
chosen, each averaged over the **same windows** the pileup is taken from — the real ones, never the
shifted controls, which are the denominator of the picture rather than the picture — and drawn as a
profile above it and beside it. That is the figure most papers using an APA actually print: the
aggregate contact map with the aggregate signal on its edges, which turns *these places touch* into
*these places touch, and this is what is bound where they do*. Until this a reader had to run the 1D
metaplot separately over anchors they re-derived by hand, and the two aggregates were over different
windows unless every setting happened to agree. Each profile is normalised **against its own extent, not from zero**, with the two
edges of one track sharing a ruler and the range printed in the key: two tracks in two units have no
common axis, a band three lines tall is not an axis either, and what a marginal promises is the
*shape* along the window. Drawn from zero — which is what shipped — a ChIP aggregate running from 45
to 92 is a line across the top of the band with a bump in it, while the same numbers as a metaplot
curve two blocks down the drawer are a peak twice the height of its baseline: two pictures of one
quantity disagreeing about whether anything happened. Each profile is resampled by the window's
**own** grid edges, so a cell of the profile is the cell of the pileup above it by construction
rather than by a second resampling that could land a domain boundary a column out, and it leaves as
numbers with the matrix it belongs to — a second block under the pileup's own table, since contacts
and signal are two units and a spreadsheet that read them as one rectangle would average them
together.
A track dropped between the form being filled in and Run being pressed is left out and said out loud,
rather than drawn as a flat line.

**The two edges show one profile unless the reader says otherwise.** Which anchor of a loop is
written first in a BEDPE is whichever sits further left on the sequence, and nothing else: it is not
upstream in any biological sense, not the cause of the contact, not the end with the factor on it.
Profiled apart, the top edge is every pair's second anchor and the right edge every pair's first, so
the two lines differ by whatever that arbitrary ordering happened to sort — and a reader comparing
them reads a difference between the two ends of a loop that the file never claimed. So each window
contributes **both** of its anchors to **both** edges, which is one mean over twice as many anchors:
better estimated as well as honest. The pooling is done a window at a time rather than by averaging
the two finished profiles, since the accumulators count per cell and a cell one of them never saw
would otherwise be weighted as though it had. A tickbox turns it off, for the file where the ordering
*is* the figure — a BEDPE whose left column is always the promoter, say — and it is offered only off
the diagonal, where both axes cut the same window from the same feature and the two profiles are
already the same numbers.

**The scaled mode on a feature set is the domain pileup**, and it is the picture that sits beside a
loop APA in every paper: TADs — insulation boundaries called, then the span from one to the next —
piled up with the body of every domain resampled onto the same columns and a flank each side. Four
things make it that picture rather than a plausible smear, and each was got wrong before it was got
right. The window is `[start − fL, end + fL]` **on both axes**, so the domain is the square in the
middle; it used to be laid out from the feature's *midpoint*, which is the same width and half a
domain to the right of where it belongs, and produced a figure with the body against one corner and
the whole flank on the far side. The body's two ends are pinned to their **own grid lines** for every
domain whatever its length, rather than the whole window being stretched evenly — otherwise a 20 kb
domain's boundary lands on one column and a 200 kb domain's on another and averaging them softens
both. The distance-matched control is shifted by a **multiple of the window** rather than by a count
of bins, because a control fifty bins from a thousand-bin window is mostly the window and the ratio
comes out at 1 everywhere. And the statistic under it is the **domain's own corner against the same
block across its boundary** rather than P2LL, whose lower-left quadrant here is the domain's two
neighbours and reads well above 1 on a set with no boundaries in it.

**Observed/expected is refused in the scaled mode, in the form rather than at Run.** One cell of a
scaled pileup is fed by windows at a dozen different separations — that is what scaling *is* — so it
has no one diagonal offset for a P(s) to be looked up at, and dividing by one anyway was a plausible
picture of nothing. The distance-matched control is the answer there and is drawn at the same
separations by construction. **Every anchor is piled up and every window is summed**: there is no cap on the anchors read
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
*Fraction of signal in features* — ChIP-seq's FRiP, over whatever is loaded: of everything a track
carries, the share of it inside a chosen interval set, against the share of the assembly that set
covers. The ratio of the two is the column to read, and it is the reason the covered fraction is
beside the FRiP rather than behind it: thirty per cent of the signal in thirty per cent of the
genome is a track with no preference at all, and the same FRiP over half a per cent is a sixtyfold
enrichment. The quantity is an **area**, `Σ value × width`, and not a mean of per-feature means — the
latter weights a 200 bp peak and a 20 kb domain alike, so it moves with the width distribution
rather than with the signal, and every published FRiP is a ratio of sums. The features are merged
before they are measured, or a GTF with one row per transcript counts its shared bases once per row
and reports a fraction above one; the features are read finely and the assembly coarsely, because a
span-weighted sum estimates the same area at any resolution *except at a boundary*, and a peak set is
nothing but boundaries while a genome-wide total has almost none. Both resolutions are reported.
*Interval overlap* — counts, Jaccard, intersection and differences — because "how many of my loops sit
on a boundary" is the question that follows every domain call.

**And that question is not answerable from those four numbers**, which is what the shuffle test
under them is for. Every one of them is descriptive and none has a scale: forty per cent of a loop
set on a boundary is either the result the run was made for or exactly what any forty per cent of the
genome would have given. The null is `bedtools shuffle`'s — one set relocated uniformly at random
**within the sequences it already occupies**, preserving its per-sequence count and its length
distribution exactly, which is what makes the comparison about position rather than about size or
about which chromosomes the set is on. Which of the two moves is a parameter, because the
per-feature statistic is not symmetric and neither is the question: *are my loops on boundaries* and
*are boundaries on my loops* have different nulls. Reported as the observed against the null's mean,
a fold, a z and a permutation p on the tail the observation actually fell on — one tail rather than
both, because a table offering both invites the smaller one to be quoted whichever way the result
went. The p carries Phipson and Smyth's `+1` and therefore has a floor of `1/(iterations+1)`: an
uncorrected permutation p can come out at exactly zero, which claims a significance the number of
shuffles cannot support. A sequence whose length this session does not know is drawn over the
furthest position either set reaches there, which is shorter than the sequence and overstates the
enrichment — so it is named rather than absorbed.

**The third anchor mode is the test a loaded loop set cannot be.** A BEDPE is somebody's claim about
which pairs matter, so a pileup over one measures the claim; every pair of a peak set within a
separation range is not a claim about anything, which is what makes it an answer to *do these places
contact each other more than places like them do*. The pairs are generated by a sliding window over
the set's own order, so the cost is the number of pairs **produced** rather than `n²` — four orders
of magnitude apart on a genome-wide set with a 2 Mb reach — and past a cap they are **sampled with
the run's own seed rather than truncated**, for §18.8's reason about the anchor cap that used to be
here: taking the first two hundred thousand is taking whichever sequences sort first, and a pileup of
chromosome I captioned *200,000 pairs* is a change of subject.

**And either off-diagonal mode may be split by separation**, into log-spaced bands with a pileup and
a control apiece. One pileup over pairs spanning 30 kb to 2 Mb is an average of a strong short-range
contact and a weak long-range one, which is a picture of neither — and the bands are log-spaced on
the observed range rather than by equal counts, because contact falls off with separation as a power
law and equal-count bands over a skewed set give a first band spanning a decade and a last one
spanning a factor of two, which are then not comparable with each other. Splitting by separation and
splitting by rank are two divisions of the same anchors and never both at once: `N × K` panels is a
figure nobody reads, so separation wins where it is asked for. A pair whose two anchors land in one
bin has no separation to band by and goes in the nearest band rather than being dropped, since every
anchor is piled up.

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
  span, which it accumulates from squares it is already reading. **The inter-MAG network is** a
  genuine composite, for the mirror-image reason: its upstream is the whole input, unconditionally.
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

**No writing of a `.cool`, `.mcool` or `.metacool` this app derived.** ~~No writing of `.cool`,
`.mcool` or `.metacool`.~~ The original rule was the second sentence, and its reason still stands: a
derived contact matrix is a format contract, and owning one means owning every question about what
its provenance, its balancing and its bin table mean. §13's rule is therefore read as covering files
the app *derives* and not only the file it opened.

What that argument is against is writing a matrix **derived from an opened map** — smoothed,
balanced, transformed, a rung the file did not carry — where every one of those questions is a
choice this app would be making on the reader's behalf and then sealing into a file that outlives
the session. That is still refused, and the reason is stronger than it looks: a picture drawn wrong
is wrong in one figure that somebody is looking at, and a `.cool` written wrong opens perfectly in
cooler, HiGlass and Juicebox, lands in supplementary data, and is re-binned by people who will never
see this app.

It does **not** reach the one case §3.7 adds, and the distinction is the whole of the reversal. An
`.mcool` written from an imported `.pairs` is not derived from anything: it is the **primary
reduction of a primary file**, and the three questions the paragraph above names are answered by the
input rather than by us.

- **The bin table** comes from `#chromsize:` and a bin size the reader chose in a dialog. Nothing is
  inferred and nothing is negotiated.
- **Provenance** is the source file's name, its preamble carried verbatim, the record count, and
  what the import skipped, clamped or had to merge — in named attributes and in `metadata`, so a
  file handed to somebody else says exactly what this session says.
- **Balancing** does not exist. No weights are written, none are implied, and `generated-by` says
  `unbalanced` so that a reader who wants them runs `cooler balance`.

And what is written is *what is on screen*: `sum` and `nnz` are the numbers the info panel is
showing, off the arrays the map is being drawn from. There is no second computation that could
disagree with the first — which was the other half of the original worry, and is the half that
would have applied to a derived matrix and does not apply here.

**The price of the reversal, and it is paid rather than argued away.** §18.9's own rule for a port
is that it arrives with a golden built from the reference implementation's output, and a written
format is held to the same bar. `cooler cload pairs` is the reference and is already in this
repository's own workflow (`data/README.md`), so the comparison is available rather than
hypothetical. What is checked today is two things, and neither is a self-comparison: the written
file is read back through this app's own reader and matched against the in-memory table, **and**
compared cell for cell against an independent binning of the same records written the slow obvious
way in `test/support/pairs.ts`. The round trip alone would only prove the reader and the writer
agree — which is exactly what they did about `.hic` endianness (§3.6), and why it is not the whole
of the check.

One structural difference from `cooler cload` is stated rather than left to be discovered:
`bins/chrom` is written as plain `int32` codes rather than as an HDF5 enum, because h5wasm exposes
no way to construct an enum type. cooler reads it, and `Cooler.bins()` returns integer codes where a
file from `cooler cload` returns a categorical of chromosome names. Everything numeric is identical.

**No differential APA**, and **no differential insulation task**. Two insulation tracks from two files
are two synthetic tracks, and comparing tracks is something the app already does; a task that only
subtracts one from the other would be a worse version of a picture the reader can already make.

**This does not reach a *statistic* about two maps, and the distinction is the whole of why
reproducibility is built.** The argument above is that a subtraction is a worse version of an
existing picture. A stratum-adjusted correlation is not a subtraction, derives nothing from two
figures, and is not a picture at all — there is no arrangement of this app's outputs that produces
it, which is the opposite of the case the paragraph refuses. `analysis/combine.ts` made the same
distinction for overlaying N curves on one axis and it holds here with more force, because a curve
at least *looks* like something the deck could draw and a coefficient does not. It is also a port
rather than an invention, with the two things §18.9's rule for a port demands — a published,
benchmarked method (`hicrep`, `hicreppy`) and the reference's own definition reproduced including
where it is inconvenient.

**No phase call on a single cell, and no clustering of cells.** Per-cell QC reports four band
fractions per cell and draws the scatter they make; where to cut the horseshoe is a method with
choices in it, and the paragraph at the top of this section applies to a phase label exactly as it
applies to a loop. The reader ticks the cells, which is what they would be doing in the paper's own
figure.

**No translocation or structural-variant calling.** *Cis and trans per sequence* ranks sequence
pairs against a stated null, which is a summary of the file in the sense the inter-MAG network is
one. A **call** needs false-discovery control and a golden built from `hic_breakfinder`'s or
`EagleC`'s own output, which is the bar the first paragraph of this section sets for any second
caller, and neither is attempted.

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

### 18.11 A set of scales is one picture

Some tasks produce a *set* of profiles that are one reading at several settings, and diamond
insulation at several windows is the case that forced this: the same score computed over diamonds of
10, 20, 40 and 80 bins. Adopted as four ordinary tracks that is four lanes, four autoscaled axes and
four curves crossing each other — and a reader comparing scales holds four pictures against each other
by eye. **A value per bin per window is a matrix**, and one line per window is what a matrix looks like
drawn as a bundle of curves.

So a lane gets a fourth drawing style, `heatmap`, where the value is a **colour** rather than a
position. It costs no height, which is the whole point: several of them fit where one track fitted.
Everything else about the lane is unchanged and deliberately so — the same limits, the same autoscale
group, the same ceiling drag, the same flip (which reverses the ramp, because that is what flipping an
axis means), the same `NaN`-is-a-gap rule, the same export. It is a mode of `drawTrack`, not a second
renderer.

**Heatmaps stack; everything else overlays.** Two translucent lines in one lane are legible because ink
adds and a reader can follow either. Two translucent colour maps are a third colour that means
neither — so a lane whose members *all* draw as heatmaps divides its own thickness between them
instead, and the height the reader set stays the height of the group. All of them and not most: a line
among three heatmaps has nowhere to be drawn but across the whole lane, over the colours, and dividing
the lane under it would leave it a fraction of the height its axis is labelled for. A mixed lane
overlays, and the reader who wanted the stack sets the odd one out. The rule is one function in
`annotations/types.ts` because both lane renderers ask it, and a rule about what a lane *is* that lives
in one renderer is one the other drifts from.

**The colours are chosen by the data unless the reader chooses.** *Auto* is a reading and not a
fallback: values that straddle zero are a departure from something and get a diverging map with its
middle on the zero, values that do not are an amount and get a ramp — the same reading the value axis
already makes when it decides where to put its baseline. Insulation is the first kind, and a log2 ratio
drawn on `viridis` puts "no change" at an arbitrary green. The per-lane picker sits beside the style
and **appears only under a heatmap**, because on a line the colour is the chip on the row's head and a
second colour control there is two answers to one question. It is built together with the style
control rather than by the card, so it appears on the pick that asks for it: a `<select>` keeps focus
after a pick, and every card defers its rebuild while a control holds a value the reader may still be
giving.

**A task may say how its set reads, once.** A `ProfileOutput` can carry a group, a drawing style and a
mode for that group, and multi-scale insulation carries all three: one group, in overlay, drawn as
heatmaps. They are written into the row's style on the way in and are the reader's from that moment —
renaming the group, breaking it up or switching a row back to a line are ordinary edits to an ordinary
track (§18.5), and nothing re-asserts the suggestion on the next repaint. The group's *mode* is the one
that is not the row's own, so it goes through `knowsMode`: a suggestion applies to a group nobody has
decided about, and a reader who pulled the stack apart and ran the task again gets it back the way they
left it. The group name is made specific to the map for the same reason the label is (§18.2) — a batch
over a deck would otherwise stack five replicates' rows into one lane.

The scales are emitted **widest first**, because lanes are laid out in the order they are adopted and
every published version of this figure sharpens downwards: the widest window on top, so a boundary that
survives every scale reads as a column through the whole stack. A single-scale run is untouched — an
ordinary ungrouped line — because there is no set for it to be part of, and a heatmap of one row is a
worse picture of one track than the track.

The Synthetic card carries the style control, and that is not an accident of layout: it is the **only**
card that lists a computed row, since the Tracks card leaves them out on purpose (§18.5), so a style
offered only there would be one a computed lane could never be given.

### 18.12 A set of quantiles is one shape

The scalogram needs something the heatmap stack cannot give it, and the difference is worth stating
because both look at first like "several profiles in one lane". Multi-scale insulation is several
*independent readings* of the same quantity, stacked so they can be compared; the scalogram's bands are
the **edges of one picture**, and what a reader is meant to see is a single shaded shape rising and
falling along the genome — not five lines to be matched against a legend.

So a lane gets a fifth drawing style, `ribbon`, and it is the only one whose picture depends on a track
that is not itself: a ribbon fills the band between its own curve and the curve of the member **below it
in the same lane**. Four filled areas in one lane cannot express that — they paint over each other in
the order they were drawn, and the reader sees the topmost one and four edges. Everything else about the
lane is unchanged for §18.11's reason: the same limits, the same autoscale group, the same ceiling drag,
the same `NaN`-is-a-gap rule, the same export, and it is a mode of `drawTrack` rather than a second
renderer.

**Ribbons tile; they do not overlay.** They do not overlap, so they are not dimmed — the dimming is what
makes two *overlapping* tracks both visible — and the rule is one function in `annotations/types.ts`
beside the heatmap one, because both lane renderers ask it. Two consequences follow. The **order
matters**, since each fills down to the one before it, and a lane whose members have been reordered
draws a different picture, which is correct: the reader has said the bands go in a different order. And
the band exists only where **both** curves do; a slot either of them is missing is a hole, because
drawing across it would invent an edge from the last value measured to the next one, over a stretch the
run deliberately said nothing about. Only the **top** edge of each band is stroked: the lower edge is
the neighbour's curve and is drawn by the neighbour, so stroking the closed path would draw every
interior hairline twice and darken every join.

The bands are emitted **innermost first** — ascending quantile — which is the opposite of §18.11's
widest-first and for the opposite reason: those are independent readings laid out by convention, and
these are the edges of one shape, so the order they are produced in *is* the order they nest in.

A `ProfileOutput` may also carry a **display scale**, and the scalogram is what that is for. Its values
are genomic separations, which run from one bin to a whole chromosome; on a linear axis the bands a
reader is comparing are squashed into the bottom tenth of the lane and the picture is carried entirely
by whichever bin reached furthest. A suggestion like the group and the style, written into the row's
style on the way in and the reader's from that moment, and a display scale and nothing else — the
numbers behind the lane and every number that leaves it as a file stay as they were computed.

### 18.13 A figure is a spec, a style and a renderer

Every picture a task produces is now **restylable**, and the whole of how is one separation: what a
figure is *of* is not what it *looks like*.

- A **`FigureSpec`** (`src/figures/spec.ts`) is the output as the plainest thing that can be
  plotted — numbers, names, axis titles, and the task's *suggestions* about scale and window. It
  carries no colour, no line width, no legend and no hidden series. Three shapes, because there are
  three genuinely different pictures: `xy` (one or more series over shared axes — a curve, a
  profile, a scatter, a histogram and a box plot are all this), `matrix` (a small dense grid, which
  keeps the `MatrixOutput` itself), and `table`.
- A **`FigureStyle`** (`src/figures/style.ts`) is everything the reader has decided. One flat
  record for every kind of figure, deliberately: a matrix has no line width and a curve has no
  colormap, and a union would cost a migration on every new control and would stop a table that
  became a scatter from carrying its own axis choice across.
- A **renderer** turns the pair into a picture, and which renderer depends on the kind.

**Contact maps are not drawn by a chart library, and never will be.** A contact map is a raster of
up to sixteen million cells behind a reader that pools on the way (§7), with its own gestures, its
own overlays and its own export path, and a heatmap series of one rectangle per cell is not a thing
it could ever be.

**A result matrix is, up to a size.** A saddle, a pileup, a cis/trans square and a
track-correlation heatmap are *small grids of labelled cells*, and the thing a reader wants from one
is the number under the pointer: which two sequences, how strong, is that cell the one the statistic
under the picture is about. A painted picture has no answer, and the colour bar is a caption rather
than a control. So a `matrix` whose cells number at most `MATRIX_CHART_CELLS` (20,000, about a
hundred and forty a side) is built as a heatmap by `figures/matrixOption.ts` and drawn by the same
chart every curve is; above that the painter draws it exactly as before — five hundred thousand
rectangles in an SVG is not a picture anybody can point at, so the interaction it would buy does not
exist at that size either. The colour scale is this application's own (`render/colormaps.ts`) and
the painter's rule restated — a task's fixed range, else symmetric about a declared centre, else
fitted, with what the reader typed above all three.

**The cells are square unless the rows are a list.** `MatrixOutput.aspect` says which, and both
renderers obey it. Square is the default and is what everything with a diagonal needs: a saddle is
read by comparing its two corners, and a corner stretched 40% along one axis looks stronger than the
one opposite it, so the aspect of such a picture must not be decided by how wide the drawer was
dragged. The exception is a picture whose rows are a **list** — the metaplot's per-feature heatmap,
three thousand features down against distance across — which has no diagonal, nothing to compare
across one, and which square cells turn into a ribbon a fifth of the card wide. It takes the whole
width, under the profile it shares an abscissa with, which is the figure every metaplot tool draws.
A chart's grid is stated as four insets and stretches to whatever it is put in, so a square aspect
means the builder is told the size of the box and answers with a grid in pixels — and the colour bar
stands beside the picture at the picture's own height rather than against the far edge at a fixed
one.

**Everything else is ECharts, drawn as SVG, and the PDF is still a true vector page.** That last
clause is the constraint the whole design was built to meet. Every figure meets the `PlotFigure`
contract — an element, a `draw(ctx, box)` that paints into *any* canvas context, a `destroy` — and
that contract is why the PNG is a redraw and the PDF is paths and text rather than a photograph
(§18.7). A charting library paints into a canvas of its own and hands back an image, which would
have cost exactly that. So the library is asked for **SVG**: on screen the SVG *is* the live chart,
and for an export the same option is rendered once more, offscreen, at the size being exported to,
and `figures/svgPaint.ts` replays it as canvas calls onto whatever context the caller passed —
paths and text into a `VectorPage`, pixels onto a canvas. One implementation, two destinations,
and no way for them to differ. `VectorPage` gained `bezierCurveTo` (a chart's curves are cubics),
`transform` (a `<g transform>` composes with the caller's placement rather than replacing it) and
`lineCap` for this.

Three limits of the replay are stated rather than hidden: a gradient fill becomes its middle stop,
because a page's `fillStyle` is a colour string and nothing here asks for a gradient; `<image>` is
skipped, because nothing these charts draw is a raster; and `<style>` is ignored, because what the
renderer puts there is `:hover` rules.

**The library arrives in a chunk of its own**, fetched when the first figure is built, exactly as
three.js is for the 3D cell (§25.1) — a reader who never runs an analysis never downloads a chart
library. Only the charts these figures draw are registered, named statically in one module so the
bundler can leave the rest out.

**Controls are in two places, and the split is the point.** A **slim strip** sits over every figure
with the two or three controls that are reached for constantly — the mark, the two log axes, the
legend, *fit*; a colormap for a matrix; a filter box for a table. They are bordered buttons in both
states, because §26.3's *lit means on, plain means off* has no third state where a toggle stops
looking like a control, and so are the figure's exports in the strip above it: `TSV`, `PNG` and `PDF`
in a bar beside a bordered icon read as buttons or as captions of the title, and they are buttons. Everything else is one button
away, in the **same dialog the 3D model opens in**: the figure at the size of the window, every
control in a resizable column beside it, the grip and the hide toggle behaving as they do there.
That shell is `ui/StageDialog.ts` and the two are callers of it rather than two implementations of
it. The figure's element is **moved** into the dialog and moved back, never copied, so the window a
reader zoomed to is the window the export draws.

**The window lives in the style, not in a zoom transform.** A wheel gesture and a number typed into
the sidebar are the same change to the same place, and the export draws whichever happened last —
which is what §18.7's *what you export is what you see* means once a figure can be panned.

**A box drawn on a figure is how a reader arrives somewhere.** Hold ⌘ (or Ctrl, the same key on the
other platforms) and drag a marquee over any chart, and the axes come back holding what was in it.
**Which axes** is read off the shape of the drag, with no mode to be in: an axis is set when the
drag covered at least a twelfth of *that axis's* length on screen, so a flick across the picture
sets the abscissa alone, a flick down it sets the ordinate, and a box sets both. Proportional rather
than a pixel count, so the rule reads the same in a folded drawer and in a full window; below it on
both axes the gesture is a click and nothing moves. A **double click** puts both axes back to the
windows a *control* last set — the numbers the reader typed, or the whole of the data where they
typed none — which is a second bookmark and not a second window: the single source above still
holds. The gesture is taken in the capture phase, because the chart pans on a drag and a picture
sliding under the box being drawn on it is the one thing this must not do; ECharts' own brush is not
used, since it arrives with a toolbox of buttons over the picture and zooms both axes always.

**A boolean is one of two shapes, and a tick box is neither.** A *named parameter* — smooth, fill
under, the grid, the tooltip — is a label and an `on`/`off` button on one row, which is what every
settings column in this app already draws. A *compact set of named things* — the two axis scales, a
table's columns — is a row of buttons each carrying its own name and lighting when it is on, which is
what the overlay marks already draw. Both are `btn-toggle` with `aria-pressed`, so one stylesheet rule
lights them (§26.3), and the figure's settings had a third idiom that was neither.

**A column head is aligned with its column**, left for text and right for numbers. A `<th>` centres
itself by default, which put every head over the middle of a column of left-aligned cells; and a head
is a button that sorts, so it has a name — a blank one is a control whose tooltip reads *Sort by* and
whose column the reader has to infer from its rows.

**New marks.** Line, area, step, points and bars over a pair of axes; histogram, box and violin as
summaries of the ordinate. The last three are rules with parameters rather than plots of the data,
so the rules are in `figures/stats.ts` where they can be read: Freedman–Diaconis for a bin width
unless one is typed, Tukey's whiskers stopping at the furthest *observed* value within 1.5 IQR, and
a Gaussian kernel density at Silverman's bandwidth for the violin — every violin on a figure scaled
by the same peak, because two violins each normalised to their own width say the two samples are
equally concentrated. A table can be drawn as any of them: one numeric column as a distribution, or
one against another as a scatter.

**Bars stack where the series are parts of one whole.** A sequence's cis and trans fractions sum to
one, and the reading is one bar split in two rather than two bars side by side whose sum the reader
performs. The task says which series share a stack; **only bars** honour it, because the same
declaration on a pair of lines would draw an upper line that is the sum of two quantities under an
axis claiming it is one of them — so a stacked bar chart restyled to lines is two lines again. The
all-maps overlay keeps the stacks **per map** (`analysis/combine.ts`), since four libraries in one
stack would be a single bar four libraries tall with each one's fraction standing on the sum of the
ones before it.

**A table is a view, not a printing.** Filter, sort and choose columns, which for four thousand MAGs
is the difference between a record and a tool. The filter is a substring over each cell's *text*,
because that is the search a reader means; a row missing a value sorts last whichever way the column
runs, because a row with no value is not a row with the smallest one.

**Every decision is remembered**, per file, per task and per output, in the `UiMemory` scope beside
the task's parameters (§18.2) and carried in an exported session (§5.6). The argument is §18.2's one
step further on: if the recipe is worth keeping then so is the picture the recipe was read from, and
a session that came back with the parameters but with every log axis, hidden series and colour
thrown away would reproduce the numbers and not the figure. What is stored is untrusted input like
everything else that outlives the build that wrote it, and every field is validated against the spec
it is about to be applied to.

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
URL box, the store tiles and the version picker, leaves the landing page's folder row with the one
place this build can reach — under *Connect a folder*, since a heading naming two kinds over a row
holding one is the same false promise in smaller type — and says in one sentence that this copy
opens local files only and where to go for the rest. A build that offered a URL field
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

Every door to a file the app had asked *which file* once and then closed: the landing page, the
file crumb's *Open a file*, a URL box. That is the right shape for opening one thing and the
wrong shape for the way people work with a directory of data, which is to open one, look, open the
next, and keep going. A **connected folder** is a place the window keeps, browsable in a column, for
as long as the reader wants it.

Four things are folders, and the whole point is that they are the same thing here:

- a **directory on the machine**,
- a **key prefix on a bucket**, public or private,
- a **Google Drive folder**, and
- a **Dropbox** (§24.9).

`browse/folder.ts` is the interface — given a path, the sub-folders and the files; given a file, how
to open it — and the backends are the whole of the difference. Nothing above that layer asks which
kind it is holding, so "a local folder or an S3 bucket, read the same way" is a property of that
file being small rather than a feature written twice.

**They are connected from one dialog, drawn as providers** (`ui/ConnectCard.ts`): a row of four
tiles — this machine, a bucket, Google Drive, Dropbox — and the form of the one pressed under it.
The dialog used to stack six sections down one scroll, and two of the six were not places: a Google
API key and a Google account are settings of *one provider*, and a reader meeting them between a
bucket and a Drive folder had to work out which they belonged to. They sit under Google Drive now,
which is the only tile that needs them, in the order a reader meets them — the key, because a
public Drive link fails without it; the account, because a private one fails afterwards with a key
in place; the folder, because it needs the account. Since then the key and the client id have
become the site's (§24.7), and each of the two panes that sign a reader in is **one title, a
`?` and a button** (`ui/connectHead.ts`): *Google Drive* or *Dropbox* on the left of a line, a `?`
at its far right, and one large sign-in button under it. **Every pane is headed by its own tile's
name** — *This machine*, *A bucket*, *Google Drive*, *Dropbox* — because a tab that renames its
subject on being pressed reads as a further step rather than as the thing pressed; two of the four
were imperatives, and *Connect to your Dropbox* under a tile saying *Dropbox* was the dialog asking
twice. What a pane is *for* is the dialog's title. The sign-in button says **sign in to Google** /
**sign in to Dropbox**, in the words the door said one press earlier (§24.2), and the bucket pane's
says **connect this bucket** rather than *save*: it does save the bucket, but what the reader
pressed a door for is the listing, and that is what happens (§20.3).
Everything the pane has to say about the service — what the grant is, where the token lives,
what is kept — is behind the `?`, shown on hover, on focus, or pinned by a click for a screen
with no hover; what is on the pane itself is what a reader acts on: the button, the reason it is
disabled on a site built without the registration, the code box a Dropbox sign-in opens, an
error. On the Drive pane the folder box — a name, a link or id, *connect this folder* — is not on
screen until the sign-in has happened, and appears under the button the moment it has, on the
same pane, under the same title; there is no second heading. A build that cannot offer a provider
does not draw its tile (§8.5): the standalone build offers this machine alone, and the desktop
build's Drive pane keeps its title and its `?` and says under them why there is no button.

**One verb names this door wherever it is.** The dialog is *Connect a folder*; the landing page's
heading, the Files column's button and the command palette all say *connect a local or remote
folder*. There were three — the landing page said *Mount*, jargon used nowhere else in the app, the
dialog it opened was titled *Open a local/remote folder*, and every button and every sentence about
the result said *connect* — so a reader pressed under one word, landed on a second and was
reassured in a third. A file is opened; a folder is connected (§26.4). The Files column's button
opens the dialog, and so do three of the four buttons in the landing page's row — those carry the
pane to open on, since a reader who pressed *sign in to Dropbox* has already chosen and must not be
asked again.
The fourth, *choose a folder…*, opens **the directory picker itself**: it is one gesture, the
browser draws it, and a dialog in front of it would be asking the reader to press the same words
twice (§24.2). Both screens call `connectDirectory` (`browse/connected.ts`) and therefore cannot
disagree about which of the two shapes this browser gets, nor about the label that says so.

### 20.1 One level, never a walk

`list` answers one path with its immediate children. Nothing recurses, and that is a constraint
rather than an omission: on a bucket a recursive listing is one signed request per prefix against a
key that may be allowed some of them and not others, and on a disk it is an unbounded walk of
somebody's home directory to draw a sidebar. The folder view is the folder, not an index of it —
the same rule its own filter states about itself.

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

The form's one button is **connect this bucket**. It was *save*, from when the same form stood in a
credentials dialog where saving was the whole of it; behind a door that said *connect a bucket…*,
beside a Drive pane that says *connect this folder*, *save* promised a stored setting rather than
the listing the reader came for — and the listing is what pressing it produces. There is no *test
connection* button, because that listing **is** the test: the same signature and the same preflight
as every later read, where a separate probe would be a second code path whose passing would mean
nothing about the first.

### 20.4 The fifth column, and the one that is not about the open file

§16.5 says the side columns are the session's furniture and each describes the one file the session
is of. **Files is the exception and is meant to be.** What it holds is the places this window is
connected to, which are the same in every tab and outlive all of them, exactly as the theme is. It
is therefore built once, never re-parented on a tab switch, and — alone among the five — **available
with nothing open at all**: a reader who has connected a folder and opened nothing yet is exactly
the reader it is for.

**It is there while a place is connected, and not otherwise** (`App.refreshFilesPanel`), which is
§8.5's rule as the other four columns already follow it. It used to be there unconditionally,
because its own *connect a local or remote folder* was the only door to a folder and a column
nobody can see is not a door. The landing page now offers the four places itself (§24.2), so what
that rule was buying on the first screen is an empty column beside a row of buttons saying the same
thing.
Connecting one opens the column on it (`reveal`), because the answer to the gesture is in there;
disconnecting the last one takes it away again. The doors are elsewhere and stay elsewhere: the
landing page — which is what a new tab is — and *Connect a local or remote folder* in the command
palette.

`f` folds it. The single-letter space was down to `q` and `z`, and neither is a letter anyone
reaches for a list of files, so `f` came from the `fills` overlay — which keeps its toggle, on
screen beside the picture it changes, and loses one keystroke. It stays in the command palette,
which promises to list everything the app can do.

### 20.5 Two verbs on a row

Every file row in the application carries the same two marks, and only marks (`ui/rowVerbs.ts`): a
`+` that **adds the file to the session in front** — a second map beside the one that is there,
anything else drawn on top, an empty tab filled rather than added to, which is the routing a dropped
file takes — and a window with a `+` where its corner was that **opens it in a session of its
own**, the empty tab in front or a new one, leaving whatever was open as it is. The words are in
the tooltips, which also say what *add* means for that kind of file. Both are offered whatever the
tab holds: on an empty tab the two land in the same place and the tooltips say so, because a row
with two marks in one store and one in the next is a row a reader has to think about. A workspace
row has the second alone — it is tabs, not a file, and there is nothing it could be added to. The
same pair stands on a store's rows (§24.2), on a folder's rows here, and, with words beside the
marks, on a gallery card and on the tray under a portal. Clicking a folder row's name is the first
verb.

Dragging a file lets the reader say *where*: onto the map's edge rectangles for a lane in a named
stack (§8.9), onto a companion for a track on that map (§16), onto the Tracks card, onto the content
area, onto the landing page's drop zone — which replaces, because that is what the landing page has
always meant.

**The Files column is the only door onto a connected place.** Its folder view lists every place the
window is connected to — a directory on this machine included — and a row hands back the file with
the credential the listing used; `ui/pickFromFolders.ts` is the same view in a dialog, which the
column's own places open and which a drag out of it resolves through. With nothing connected it says
so and names the column's *connect a local or remote folder* rather than offering an empty listing.

**The cards that ask for a file keep no second door.** Each of them — Tracks, Contact maps,
Structures, an empty cell of a deck — used to carry a box to paste a URL into, folded away behind
*or open one by URL*, and beside it a *from a connected place…* button onto that dialog. Both are
gone from all of them, and the deck's add row has lost the button too. **Structures** went last and
separately, having arrived with §25's card after the others were cleared: the rule is the card's
shape and not a list of cards, so a new one that asks for a file is a drop zone and nothing under
it. A structure held at an address still opens by every road it did — the landing page's box, a
session, a `#uri`, the Files column — and what is gone is the third of them on the card itself.

The box went first and for the obvious reason: it was the worse half of the pair it was in. A reader
holding a URL can drop the link on the window or paste it into the landing page's own box, which is
where this application says *open a file*; a reader **without** one was being asked to produce
something they have not got — and that is the commonest state in all three places the boxes stood
in. The bigWigs beside a map are keys in a prefix whose names came off a run sheet; a reader
repairing a shared deck is looking at a `~` precisely because the sender's file had no address a
page could fetch by name (§11).

The button went for a different reason, and it is the one worth stating: **browsing a connected place
is a column, not a dialog.** §20 opens by saying that every door to a file this application had asked
*which file* once and then closed, and that the way people work with a directory of data is to open
one, look, open the next, and keep going. A button that opened a one-shot copy of the column from
four different rows was four doors to one room, each of which closed on the first pick — the shape
the connected folder exists to replace. What a card that asks for a file needs is the drop zone and
nothing under it.

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
it said nothing: a **shared session** in the fragment (`#session=`, a whole workspace deflated into the
URL); a **view state** in the fragment (`#uri=…`, which is what a navigation leaves behind, so it has
to beat the `src=` or every reload would undo the reader's last click); and **`?config=<url>`**, a
published `.metacooler.json` fetched and opened through `Session.openConfigUrl` — the same road the
picker's own URL box takes, so a seeded session and a chosen one differ in nothing after the fetch.
With none of the three, an embed is the file picker, which is a legitimate thing to embed.

`?config=` is the pointer form of what `#session=` carries as a payload. A payload cannot be changed once
the embed is published and grows the URL by the size of the session; a pointer is a file on a bucket,
editable afterwards, of no length, and — because the names inside it resolve against its own URL
(`state/SessionConfig.ts`'s `resolveConfig`) — self-contained enough to be copied to another bucket with its data. Both are
read by one parser.

A relative `?config=` resolves against the page it was named on. Only `http:` and `https:` are kept:
the value is about to be fetched, and the other schemes are the ones with no server on the other end.

`?store=` is the third mounting parameter and is not a seed: it opens the store drawer over
whatever the window shows (§24.2), carrying the store's view in the rest of the address, and an
embed — which has no drawer — ignores it.

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

**The mark and the name**, left. In a window the brand is the way home — the picker, **in a new tab**,
so the tab in front keeps its file, its tracks and its deck: every page has taught a reader that the
logo is safe to press, and a dropped local file cannot be re-opened without another gesture (§11),
which is the same reason the file crumb stopped navigating to the picker. An empty tab *is* the
picker, so a tab with nothing in it goes straight there rather than opening a second empty one. In a
frame there is no new tab to open and nothing may be thrown away either (§21.2), so it is a link
*out*: this same view in the full application, in a new tab, with `embed` dropped from the query
string and the fragment carried across untouched. Its address is rewritten on every navigation, so
copying it copies where the reader actually is.

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

## 22. The package: the copy that goes to npm

A sixth build of the same source, after the site, the archived pin, the desktop shell, the CLI and
the standalone page. It emits `dist/` — the ordinary web app — and it is published to a registry as
a **built directory rather than as something to import**. Nothing depends on it; things *serve* it.

**What it is for is one question §21 could not answer.** An embed is an `<iframe>` and a URL, and
until now that URL was this project's GitHub Pages site. A page that frames it takes on a dependency
on somebody else's domain, deployment and lifetime — which is a reasonable thing to decline, and a
thing a figure in a paper should decline. A published version is the alternative: immutable,
checksummed, mirrored, and unpackable into any server the reader's institution already runs.

`package.json` used to say `private: true`, on the argument that this is an application rather than a
library and that a registry has no use for it. The first half is still true and is not what
publishing changes. What a registry is wanted for here is not dependency resolution; it is **hosting
nobody has to trust**, which is a distribution channel beside Pages rather than a claim that anyone
should `import` this.

### 22.1 The relative base, which is the whole of the build

Every other build knows where it will be served from and bakes absolute asset URLs accordingly: the
site root, `/v/<commit>/` for an archive (§21), `/` inside an asar. A tarball knows nothing — it is
unpacked into `/viewer/` on one site, `/npm/<name>@<version>/dist/` on a CDN, a deep path on the
next — so its base is `./`, and one published version serves all of them with no rebuild.

The rule that comes with it is the reader's: **the URL has to end in a slash, or name `index.html`.**
A relative base resolves against the document, so `…/viewer` without the slash looks for the assets
one directory too high. Most servers redirect; a CDN generally does not.

Two absences follow from not knowing where it is, and both are enforced rather than assumed
(`IS_PORTABLE`, `src/versions.ts`):

- **No service worker.** A copy mounted under a path it does not own must not claim a scope there —
  on a registry CDN that scope covers other people's packages.
- **No version manifest.** `SITE_BASE` resolves against the document, so asking for `versions.json`
  would be asking whichever directory the copy was unpacked into for a file only the deployment has.
  The About dialog therefore lists no other builds, which is correct: there is no site to list.

It also carries no source maps and nothing from `public/` — ~20 MB of a ~26 MB site build — because
a tarball is downloaded by everyone who installs it and cached for ever by every mirror. What is left
is ~6 MB unpacked, 1.7 MB compressed.

### 22.2 What is in it, and the one thing that rides along

`files` is `dist/` and `dist-cli/`, and it is the whole of what stands between a publish and 250 MB of
demo data: npm's default is everything not ignored by git. `dist-cli/` is there so the declared `bin`
resolves inside the package — `npx metacooler-run` then works against a published version with no
clone, which is what makes `h5wasm` and `@gmod/bbi` runtime dependencies rather than dev ones.

npm **force-includes the file `main` names**, ahead of `files` and ahead of a negation. `main` is the
Electron entry point (§15) and cannot be dropped without breaking `electron .`, so a pack run in a
working tree that has built the desktop target carries 18 KB of compiled main process with it. It is
inert — nothing in the package requires it — but it makes the tarball depend on local state, which is
why publishing happens from CI, on a clean checkout, where the directory does not exist.

### 22.3 Why the shape is asserted before it can be packed

`prepack` runs the build, so `npm pack` and `npm publish` both fill `dist/` from source at that
moment rather than shipping whatever was there. Then `check-package-build.mjs` refuses the result if
it is wrong, and the rules are held by a test (`package-shape.mjs`, `test/unit/package-shape.test.ts`)
in the arrangement §15 and §21's archived build both use.

That check earns its place twice over here. `dist/` is written by **two** builds — the site's and this
one — and only one of them may be published; a tarball packed over a site build would carry absolute
asset URLs that 404 on every mount that is not the site root, plus 20 MB of maps. And unlike every
other artifact in this repository, **a published version cannot be corrected**: an archived build is
rebuilt over on the next push and a deployment is redeployed, while a tarball is on the registry for
ever, mirrored by every CDN that has seen it and pinned in the lockfile of whoever installed it that
week. The pack is the last moment any of it is cheap to notice.

## 23. The console: what this window has done

The Analysis drawer carries a **copy CLI command** button under a finished result
(`analysis/cliCommand.ts`), and the argument that button makes is the one this section finishes. A
reader spends twenty minutes moving a window and nudging four numbers until the picture is right;
the moment they have two hundred files rather than one, clicking stops being the interface and the
run has to become a line in a shell. Transcribing that line by eye is the one step in the loop where
the numbers in the figure and the numbers in the table can quietly stop being the same numbers.

The button closed that gap for **the result on screen, while it is on screen**, and that leaves two
holes which are not small:

- **A batch is one command out of six.** *Run on all maps* over a deck of six is six runs against
  six files, and the drawer shows one result at a time. Five of those commands were never offered.
- **A day is not a result.** Change a parameter and run again, and the command that produced the
  figure from an hour ago no longer exists anywhere. So the reader who assembles a methods section
  at five o'clock is reconstructing it from memory — which is transcription again, with the numbers
  no longer in front of them.

So the command is written **when the run happens** rather than when a result is looked at, into a
log that outlives the result, the tab and the browser session. That log is the console.

### 23.1 One line per job, not per press

The record is written by `AnalysisRunner.execute`, which is the one place that knows a **job** from
a button: `runAll` queues one job per map, so a batch over six maps is six lines, each naming its
own file and each carrying its own command. Nothing else can produce that — the drawer holds one
result, the panel row holds one state per task, and both are per session.

It is also the only place that sees a run which produced nothing. A **failure** and a **Stop** leave
no `TaskResult` and therefore no `Provenance`, and a failure is precisely when a reader wants the
parameters back. So the line is opened when the job is dispatched, from a provenance composed out of
the job (`analysis/record.ts`), and the result's own replaces it the moment there is one — never
beside it, because two accounts of one run is how they come to disagree.

The command itself is `cliCommandFor`, called with the same `Provenance` the drawer's button passes
it. One function, two callers: a line in the console and a line on the clipboard cannot drift.

**Every run is a command, and the shell takes every task.** For a while the CLI refused by name — the
three tasks that read a bigWig, whose reader lived in the annotations worker alone; the one that reads
a second map, which the deck supplies and a shell has no concept of; and any run made in a session
with **no contact map**, since `metacooler-run` opened its first argument as one and a 1D browser
(§5.8) has none to name. Each refusal was honest, and each was recorded here as a sentence with the
refusal under it, which is a record with holes in it exactly where the reader is least likely to
look. So the shell gained what it was said not to have, each as the code the worker already runs:
`src/cli/tracks.ts` opens a bigWig, a bedGraph, a wig or a FASTA under `--tracks` and answers `sample`
in the worker's own shape; `--against` names the maps `hicrep` compares with, mounted through the
same `peer`; a track task with no positional runs over the assembly the tracks declare, framed exactly
as the session frames it; a FASTA named for compartment phasing becomes the per-bin GC vector the
session would have shipped; and a `.pairs` named for its orientation curves is read from disk. There
is no refusal left for `cliCommandFor` to write. What the record does not hold arrives as a `#` note
above the line rather than as a silent omission — the maps `hicrep` ran against are the deck's and not
the result's, so they are read off the session and, with no session to ask, the note says to add them.

**The framing is written, not only the parameters.** Three facts a session sets from the picture are
inputs to the arithmetic and parameters of no task: the score column the map is drawn from (§3.5),
the sequences declared circular (§8.15), and the ticked cells of an `.scool` (§3.8). A line without
them repeats a different run, so each is a reserved flag of the command's own — `--value`,
`--circular`, `--cell` — written whenever it differs from the shell's default and refused before the
run when the file cannot answer it. The window is *not* one of them: no runner reads the framing's
extent, which decides only whether the block on screen can be reused, so `--window` is written for
the record's label and the numbers are the same either way. An imported `.pairs` writes the
`--bin-size` it was framed at, since a contact list declares no resolution of its own (§3.7).

### 23.2 What else is on it, and what is not

A day is not only its runs, so three more things are recorded — each at the one place every road to
it already converges, which is the arrangement `AnnotationLoader.onFilesAdded` already uses:

- **A file opened**, in `Session.open` and `Session.openGenome`, *after* the read succeeds: a
  `.pairs` and an `.mmetacool` both reach that door twice, and a line written on the way in would
  name a URI the reader never got to look at.
- **A track loaded**, in `AnnotationLoader.addFiles` and `addUrl` — the two doors a *reader* drives.
  Not `restore`, `carry` or `reattach`, which are the app bringing back what it already had; a
  console that opened with nine lines after every reload is a console nobody reads.
- **A file written**, in `downloadBlob`, through which every export in the application passes. A
  reader whose figure was recorded because they exported it from the drawer but not when they
  exported the same figure from the map would be looking at a difference nobody can see the rule
  behind.

**Navigation is not recorded.** A pan is a reading of a file rather than an operation over one
(§18's opening paragraph draws that line), a minute of it would write dozens of lines, and the view
a result belongs to is already in that result's framing.

### 23.3 A script, not a transcript

What the panel hands over — one row, one day, or the lot — is **a shell script**: commands bare,
everything else commented. The day headings are `#`, the opens and the exports are `#`, a failure is
`# failed: …`, and a run the CLI cannot take is `#` too. So a day pasted into a file runs, in the
order it ran the first time, with the afternoon around it left in as the context saying what the
commands were for. The **save** button writes exactly that as `.sh`, and — being a file leaving the
app — records itself.

The **provenance** toggle is the choice between a script and an archive. Off, a row is its command
and the caveats that qualify it; on, each row is preceded by the full provenance block — the build,
the task and its version, the framing in words, every parameter one per line — which is the header
every exported file already opens with (§18.4). It is off by default, because eleven `#` lines per
row is a log nobody scans, and it governs the clipboard as well as the screen: a reader who turned
it off to paste clean commands must not find the provenance on their clipboard anyway. It is named
for what it shows, in the word the Analysis drawer's *copy provenance* already uses for the same
block: it read *output*, which beside a column of commands names the one thing it is not — what the
runs produced. And it is a toggle rather than a ticked box (§26.3), which leaves the header's
controls one shape each: three word buttons, a toggle, and the cross.

The caveats are **not** part of what the toggle hides. They are `cliCommandFor`'s notes about what a
shell cannot be told — a remote file, a window across several sequences, a parameter naming a set
with no file behind it — and a command that runs and answers a slightly different question is worse
than one that says what it left out.

They sit **above a command and below anything else**, which is one rule read twice: a caveat
qualifies a line the reader is about to run, so it comes first; a refusal explains a line that is
not a command at all, so it comes after the thing it is about. Written the other way round, every
run the CLI cannot repeat opened with a paragraph about a command that was never there.

### 23.4 The panel

A drawer along the bottom of the body, and deliberately the **same** drawer §18.1 specifies: it
floats over the content rather than joining the flex row, carries a shadow off the edge that faces
the window, is dragged by that edge with its height remembered, and is dismissed by Escape.

**It is not a modal**, on §18.1's terms exactly: no backdrop, no click-outside, no keyboard taken.
Every shortcut keeps working behind it, so reading back this morning's commands while panning the
map is an ordinary thing to do. Escape is a *dismissal* and not a cancel — closing the console stops
nothing, because the log is not the panel — and it fires in the bubble phase and skips an event
something else has already handled, so a marquee, a caret and an open dropdown all keep the Escape
they answer first.

**Along the bottom rather than beside the map**, because the log is wide and shallow: a command is
one long line and there are a few dozen of them in a day. In a column each wraps four times and six
of them fit; under the map it reads as what it is. It is also what lets the pair be up at once — the
Analysis drawer down the right, the console along the bottom, the map in the corner between them.

The **day is a separator across the list** rather than a column, carrying its own count and its own
copy, because "what did I run on Tuesday" is the question this panel exists to answer and one press
should be the whole of the answer.

The button is in the header, immediately **before the theme toggle**: to its left are the two other
things that take something out of this window — a link, and the workspace as a file — and everything
to its right is about the window rather than the work in it. `` ` `` opens it, on the key every
terminal in every editor is behind.

### 23.5 Kept for a week, in this browser, and in the account

`localStorage`, capped at **500 lines and seven days**, oldest dropped first. The point is to
recover *yesterday's* commands, so `sessionStorage` — the train of thought inside one window (§8.6)
— is the wrong store; and unbounded growth in a five-megabyte ceiling shared with the workspace
record and the bucket keys is a store that eventually refuses the write that matters.

A run that was on the worker when the window went away comes back **interrupted**, which is a status
nothing sets: recording it as failed would be inventing a failure, and leaving it running would be a
row that spins for the life of the tab.

**An embed writes nothing** and has no console at all — not the panel, not the button, not the
keydown listener (§21.2). What an embed would be logging is the page author's own afternoon, and the
record is a thing about the reader's window.

And it is **in the account** (§11). What this holds is a list of the files a reader opened and the
loci they looked at, which is exactly what somebody on a borrowed machine is owed a straight answer
about: `state/stored.ts` names it on its own line rather than counting it among the settings, and
"forget everything" drops both the key and the copy this window is holding in memory — without the
second, the next thing the reader did would write the whole list straight back out.

Nothing is sent anywhere. C1 holds here as everywhere else: the log is written by the page, into the
reader's own browser, and read by nobody else.

---

## 24. Stores, and remote sources beyond a bucket

The byte layer reaches any host that serves HTTPS, byte ranges and CORS without transfer
compression (§11), and that turned out to include the two portals a Hi-C reader is most likely to
want: the unmodified viewer opens 4DN's and ENCODE's released files straight off their public
buckets (`docs/remote-sources.md` §2 has the measurements). What it could not do was *name* them.
The only catalogue was the four demos; a connected 4DN bucket is forty thousand UUID-named folders
under one prefix, capped at 1,000 by §20.1. So the gap juicebox.js had on this app was never
access. It was a shelf in front of the files — and juicebox's shelf is three static files a script
regenerates, not a live connection to anything. This section is that shelf, called a **store**,
and the four smaller things around it: URLs that are not yet the file, links that expire,
credentials that are not a bucket key, and a search box over a portal for the reader who has none
of the above.

Three words, and the lines between them are the landing page's (§24.2). A reader **loads** files:
bytes they have, or the address of some. A reader **mounts** a folder: a place of their own — a
directory, a bucket, a Drive, a Dropbox — listed one level at a time in the Files column (§20). A
reader **connects to a data store**: somebody else's shelf, drawn as a page of its own. Everything
else that used to stand between them — a hub, a catalogue, an examples list — was one of the three
under another name, and is now called by it: a bucket is a *place* the window mounts (§20), and the
rest are stores.

Nothing here relaxes §1. Every store is a static document on somebody's bucket (C1, C5); a map with
no store opens exactly as before (C3); a store is fetched on a gesture and never on load (§11); the
one thing on this road that would need a server — a CORS proxy for a portal that refuses browsers
— is refused, and such a portal gets a generated store instead.

### 24.1 What a store is

A **store** is a JSON file, `kind: "metacooler.store"`, on any CORS-enabled host: a catalogue of maps,
genome files and workspaces with enough metadata to choose one **without opening any of them**,
which is what §11 promised under the name "catalog" and GAPS G10 recorded as unbuilt.
`state/store.ts` owns the shape, the parser and the resolver.

```json
{
  "kind": "metacooler.store", "version": 1,
  "name": "4DN open data", "generatedAt": "…", "source": "…",
  "base": "https://4dn-open-data-public.s3.amazonaws.com/fourfront-webprod/wfoutput/",
  "columns": [{ "key": "assembly", "label": "Assembly" }, { "key": "biosource", "label": "Biosource" }],
  "entries": [{
    "label": "Hi-C, HCT116 RAD21-AID (Rao 2017)",
    "uri": "000789fe-…/4DNFIM7ZVQOQ.hic", "kind": "map", "size": 839405381,
    "fields": { "assembly": "GRCh38", "biosource": "HCT116 …" },
    "note": "4DNFIM7ZVQOQ · PMID:28985562",
    "tracks": [{ "label": "CTCF", "url": "…/4DNFIK9NBYGJ.bw" }]
  }]
}
```

Four rules carry most of the design:

- **A store is narrowed, not walked.** Six hundred rows are chosen by *filtering* — assembly,
  biosource, assay, lab — and a folder row has only a name. So a store declares its `columns` and
  each entry carries `fields`, and the viewer draws it as facets over rows (§24.2) rather than
  pushing it through `ConnectedFolder.list()` (§20), which would draw the flat folder of opaque
  accessions juicebox deliberately does not show. The two meet only at the exit: a picked row is a
  URI and a source, the same thing a folder row or the URL box hands over.
- **A row may be a workspace.** `kind: "workspace"` names a `.metacooler.json`, opened through the
  road `?config=` already takes (§21.1, `Session.openConfigUrl`), so a store can offer a *composed
  figure* — tracks placed, a group, a colour scale, the window the paper used — and not only a bare
  file. This is the difference between matching juicebox and passing it, and it costs the format one
  string.
- **Names inside a store are relative to `base`**, or to the store's own URL directory when `base` is
  absent, resolved with the same `::group`- and `#index=`-preserving treatment `resolveConfig`
  gives a workspace (§21.1). A store with relative names beside its data is therefore a self-contained
  folder that can be copied to another bucket, as a demo dataset already is.
- **A row carries its size** when the generator knew it, so the load gate can ask its question
  before the first request instead of after the `HEAD`, and the row can say what a five-gigabyte
  file costs before it is clicked. `tracks` on a row are a shelf: once the row is open, the Tracks
  card offers them the way it offers the demo annotations (§8.5).
- **A row may name the group it belongs to.** The portal generators write the experiment set a 4DN
  file belongs to (`set`) and the experiment an ENCODE file belongs to (`dataset`), and every
  pre-configured session names its group the same way (`dataset`), so a page can fold rows under
  the set they came from and put *open with its tracks* on the heading (§24.3). A store with no
  such column is a flat list, which is what a lab's own shelf usually is.
- **A page draws a window of a thousand rows**, and counts, facets and ticks over every row the
  store has. Six hundred rows is nothing to a list; the ENCODE shelves are 55,000 (§24.3), which
  is a quarter of a million elements and a tab that stops for seconds on every keystroke. A cap
  rather than virtual scrolling, because scrolling a catalogue that size is not what anybody does
  with it — narrowing is, which is what the rail is for — and because virtual rows cost the page
  find-in-page. The cap is on **drawing** only: the rows that appear are the first thousand of the
  real answer, never a filter of the first thousand, and the line over the list says so when it
  bites.

The parser refuses what it must and tolerates the rest: a JSON that is not a store, or a store of a
newer major version, is a `ConfigRefusal` with a message naming which; an entry with no `label` or
no `uri` is dropped rather than fatal; a missing `kind` is read off the file name (`.json` is a
workspace, else §20.5's routing); unknown keys are ignored, which is what lets a generator add a
column before a viewer knows it.

### 24.2 Where stores are offered: the tiles, the drawer, and the four fronts

**The landing page has three things on it, and they are named.** *Load files* is one drop area with
the URL box under it behind a rule reading *or a URL* (`ui/LoadBox.ts`), which the file crumb's
*Open a file* reuses in a dialog with the other verb behind it. There is no *choose files* button:
a click on the target opens the same file dialog, and the same action drawn twice is a choice a
reader has to make between two controls that do one thing. The target says both things it does —
drop, or click — and no more; what opens as what is stated once, in **About**, whose first sentence
names the tracks, genomes and 3D models this viewer opens with or without a map, because a reader
holding a bigWig and no contact map has to be told somewhere that this application is for them too.
It is shallower than it was, and it carries no paragraph: a box deep enough to be the page said
that dragging was the way in, and there are two sections under it that have to be seen.
*Connect a local or remote folder* is a row of four buttons, side by side and
of equal height, wrapping a long label to a second line rather than breaking the row — *choose a
folder…*, which opens the directory picker itself, and *connect a bucket…*, *sign in to Google…*
and *sign in to Dropbox…*, which open the Connect dialog (§20) on that place's pane. Their
**widths** are their labels' rather than equal, so that at the page's own width every label gets one
line and the four read as the set they are; a narrower window or a wider font shrinks them together
and wraps the longest first, which is the fallback and not the resting state. *Connect to a data store* is a **grid** of tiles — the lab's
own figures, IGV's genomes, 4DN, ENCODE, DNA Zoo, Roadmap, every store the reader connected, and the
two doors — each a mark, a name and one line (`ui/stores/tiles.ts`). It was one row that could not
wrap, which was right while there were five and the set was the page's whole offer: a fifth tile on a
second line would have read as an afterthought. There are more than five now and a reader can connect
as many again, so it is equal columns that fill the width and spill onto the next line, on
`auto-fill` rather than `auto-fit` so that the last line's tiles stay the width of the ones above
them — four over three reading as seven of one thing rather than as three larger ones underneath.
Nothing else is on the page. The
picker's *browse…* and its *private buckets…* are gone — they were the folder row said less
plainly — and the *Hubs* dropdown of eighteen shelves was the tile row under another name.

**Three of the four are doors; the fourth is the gesture.** *Choose a folder…* opens the directory
picker itself, because it is one gesture and the browser draws it — a dialog in front of it would
be asking the reader to press the same words twice — and because both pickers need transient user
activation, which is spent by anything awaited first. *Connect a bucket…*, *sign in to Google…* and
*sign in to Dropbox…* open the Connect dialog on their own pane, which is the same grammar the
tiles beside them have (a tile opens the drawer on that store): what follows a press there is a
CORS-and-key form or a sign-in with a code to paste, and both already live on the dialog's panes
with the sentences §24.7 requires beside them, so a landing page that inlined either would be a
second copy of one. The ellipsis on every label covers both cases — something is about to be asked,
here or in a dialog.

Which places are offered, and what each button says, is decided once in `ui/connectFronts.ts` and
read by both doors. Two things follow from that. A sign-in that cannot work keeps its **tile**,
whose pane is the sentence saying why, and loses its **button**, because a row of things to press is
not where a reader is sent to read an explanation (§8.5) — and it cannot work for either of two
reasons, which the row treats alike: a **build** that cannot be registered (the desktop one, whose
`app://viewer` is not an origin Google's console will register) or a **site** built without the
registration its maintainer provides (§24.7), where the pane's disabled button and the sentence
beside it name the one thing a reader can do — ask them — and the landing page would be offering a
bold sign-in answered by an environment variable's name. And *this machine* is
worded identically on both screens: Chromium and the desktop build hold a directory as a grant that
survives a reload, while Firefox and Safari hand over a snapshot of the file list that does not
(§20), so the button reads *choose a folder…* on the first and *choose a folder (this visit)…* on
the second — wherever it is drawn, since both now run the same picker. *Choose files* is likewise
the same marked button the panes use, so one gesture looks the same wherever it is met.

**The Files column is no longer on the first screen, and that is what the row buys.** It used to be
there from the first paint and never withdrawn, because its own *connect a local or remote folder*
was the only door to a folder; it is now there exactly while a place is connected, like the four
columns beside it (§16.5, §8.5). Connecting one opens it on the folder, which is the only thing a
reader who has just connected one wants next.

**The two doors are named for the errand, and carry the marks of what they open.** *Connect to a
UCSC hub* takes a `hub.txt`; *Add a custom store* takes a store file — each leads with a verb, where
*A track hub* and *Your own store* named a category and left the verb to be guessed. The verbs are
not the same one, because the errands are not: a hub is somebody else's shelf, reached where it
stands and read across the network, which is what *connect* means everywhere else on the landing
page (§24.2) and in the Files column; a store config is a file this viewer takes a copy of and
remembers. Naming both *add* was the earlier answer and made the first of them promise the second's
gesture. The first wears UCSC's own logo, which is the one word a reader holding a hub is looking
for, and so does every hub the reader remembers. Roadmap beside it wears its own emblem over UCSC's
colour, so that the sentence *this is a UCSC hub* is what shows if the image ever fails. The second wears **this viewer's own icon**,
because the file behind that door is the one format in the grid written *for* this viewer rather
than translated into it (§24.1). Both marks come through `scripts/make-store-logos.mjs` like the
rest, which grew three things for them. An **incremental run**, so that adding a logo does not
mean re-obtaining the four whose sources are not committed. A **bleed** fit for a mark that is
already a tile — the app icon is a squircle plate with its own margin and shadow, and containing it
on white drew a plate inside a plate. And a **crop**, for a logo too long to survive being
letterboxed: Roadmap's is 958x208, which whole would fill a fifth of the tile's height and set its
wordmark at about five pixels on the landing page, so what is taken is the square at its left end —
its emblem, full bleed, no letterbox at all. The tile sets the store's name in type under the mark,
so a mark that cannot carry the name legibly carries the picture instead.

**Every store says whose it is, and links there.** A store is somebody else's data, and what a
reader is looking at is a catalogue this viewer translated — carrying none of the licence, the
citation, the release notes or the caveats the people who made it wrote down. So the drawer's head
carries an outbound link beside the download, an arrow leaving its corner, opening in a tab of its
own with `noopener`: RSG's team page, IGV's genome documentation, 4DN's portal, ENCODE's matrix, DNA
Zoo, Roadmap's WashU portal, and — on the hub door, which has no store behind it — UCSC's
`hgHubConnect`, which is where a reader without a hub in hand goes to find one. It is drawn **as
soon as the store is opened, read or not**, because whose shelf this is is a fact about the store
rather than about this reading of it, and the reader whose catalogue just failed to load is exactly
the one who wants the site behind it. The download is the opposite and stays absent until there is a
file (§8.5).

**Pressing a tile opens the store drawer** (`ui/StoreDrawer.ts`): the same kind of panel the
Analysis drawer (§18.1) and the console (§23) are, down the *left*, where files come from. It
floats over the body with a shadow to say so, is dragged by the edge that faces the map, stops at
the console's roof, puts itself down on Escape and takes neither the keyboard nor a click outside
itself, so a reader can narrow a catalogue beside the map they spent an hour on. It is **one per
window** rather than one per tab, on the Files column's argument (§20.4): a store is not a fact
about the file in front, and a switch of tab must not lose a catalogue somebody was half way
through narrowing. Its head carries the store's mark and name, the same row of tiles small, for
switching without closing, and *copy link*. The header has a toggle for it beside the Files
column's, on the backslash key — punctuation, like the console's backtick, so it cannot collide with
the letters the views are driven by, and at the other edge of the keyboard for the panel at the
other edge of the window — and the command palette has *Open or close the stores*. The header holds
nothing else on that side: the plug and the `+` that stood there were the Files column's own
*connect a local or remote folder* and the file crumb's *Open a file* said a second time.

**A store row carries its name with it.** A 4DN file is called by its accession on the bucket —
`4DNFI24F7GRY.mcool` — and by *Hi-C on HFF cells, protocol variations* on the shelf, and the second is
what a reader picked it by. So the row's line goes with the file through the same road a file named
by a Drive folder takes (`PickedFile.name`, §24.9): onto the map it becomes, onto the track it
becomes (`addRemote`'s label, and `relabelTrack` for the file that opened a browser and was seated
under its URL before the name could reach it), and onto the tab a row opens in a session of its own.

**The two galleries are one shape of card** (`GalleryView.ts`, `GenomesView.ts`): the name and the
card's one verb on the first line — the new-session mark, icon only, its words in the tooltip — the
chips under them, the line that says what is on screen where there is one, and the files the
session is made of behind a fold reading *8 files*. IGV's cards are the tighter of the two, four
across at the drawer's default width, and named without the assembly IGV brackets after the
genome's name — that is the chip under it. Every file is a store row with the two verbs of
§20.5, so a reader who wants the ATAC bigWig on their own map has it a fold away from the figure
it appears in; the lab's store lists every file its figures name (`fields.files` on the workspace
row, the URIs `|`-joined), and the few files no figure names sit under the cards in a fold of their
own. There is no section of files apart from the figures and no heading over the cards.

**ENCODE's two shard facets are facets like any other.** A genome and a kind of file are choices of
*which shards to read* (§24.3), and they used to be radios — one shard on screen at a time, so the
same dataset on two assemblies, or a dataset's signal beside its peaks, could not be seen in one
list. They are checkboxes now: tick two genomes and both shards are read, their rows shown as one
list with the two values written on every row under the facets' own keys, so a link carries the
choice as two ordinary facets and the matrix crosses the union. A shard read once is kept for the
drawer's life and not read again when unticked and re-ticked; a shard the workflow has not written
is a sentence beside the rows that were read, not a blank store; and a shard nobody has ticked shows
*on request* where its count would go, because nothing is read for a value nobody asked for.

**Each store is drawn by a front that knows what it is for** (`ui/stores/registry.ts`), which is
why one table for all of them was the wrong shape and is gone:

- **RSG lab data** — a *gallery* (`GalleryView`): one card per published figure with a title, one
  line, the assembly and the provenance as chips, the paragraph behind a fold, and *open*; the data
  files under the figures as rows. Inline, so it costs no request.
- **IGV genomes** — a *genome gallery* (`GenomesView`): one card per genome, whose button is its
  pre-configured session — the FASTA with every track IGV ships for it, in the 1D browser — and
  whose files are under a fold; a filter over genome and assembly.
- **4DN open data** and **ENCODE** — *portals* (`PortalView`): a rail of facets down the side, one
  per column with every value counted, a search box over the names, notes and cells, the rows that
  survive grouped under the experiment set or experiment they belong to with *open with its tracks*
  on the heading, a matrix of two facets against each other, and a tray for what is ticked. ENCODE's
  rows are twelve shards chosen by assembly and kind of file (§24.3), and the choice is two radio
  groups at the top of its rail; choosing fetches the shard, and everything else ticked survives it.
- **A store by URL** — the `+` tile: a box, and once a store has been read from it the portal front
  over it and *remember this store*. A remembered store is a tile of its own, drawn the same way,
  with *forget this store* on its page. Kept in `localStorage` under `metacooler-viewer:stores`,
  named in the stored-data screen and swept by *forget everything*, exactly as a bucket entry is.

**The facets follow two rules** (`state/facets.ts`): within a facet ticked values are OR, across
facets AND; and a facet's counts are computed against every *other* facet's ticks, so the number
beside an unticked value is what ticking it would add and a value ticked down to nothing stays,
at zero, to be unticked. The matrix is the same rule over a pair — a cell counts the rows that
pass the text and every facet not on an axis — capped by population with the cap said under the
grid, and a cell is a button that ticks both of its values and hands the reader back to the list.
The search matches every word against the label, the note and every cell, in any order.

**A row never destroys a tab** (`ui/stores/host.ts`). *Open* fills an empty tab and otherwise
opens a new one; *add*, offered only when there is something to add to, joins the open tab — a map
beside the map, anything else as a track — which is the routing a dropped file takes (§20.5). A
workspace row opens as tabs through the config road. The tray's *open together* opens the first
map ticked as the tab and joins every other row to it, in the order ticked, which is what dropping
four files on the window does for files that are somewhere else. Opening folds the drawer away,
because the reader chose what they came for and it is about to appear behind it; adding keeps it
up. A store reopened comes back where it was left.

**The view is a link.** `?store=<id or url>` is the third mounting parameter beside `?embed=` and
`?config=` (§21.1), and it competes with neither: it names a *shelf* rather than a picture, and the
shelf is a drawer over whatever the window shows, so a link naming both a config and a store gets
both. Every other parameter in the address is the store's view — `q=` the text, `<column>=<value>`
per ticked value, `view=matrix`, `axes=` — written by the drawer as the reader narrows, replacing
rather than pushing so the Back button still walks the map's own history, and taken out again when
the drawer closes. A reload with a store in the address reopens the drawer where it was; *copy
link* hands the same address to a colleague. A store id is a short name (`4dn`, `encode`,
`store:2`) and is kept as written; anything else is resolved and scheme-checked exactly as
`?config=` is, for the same reason.

**Nothing is fetched on load.** The tiles are descriptions; the lab's store is inline; every other
store is read when its tile is pressed, or when a `?store=` link names it — a link is a gesture.
A reader who never opens the drawer makes no third-party request at all, and that sentence is the
whole of what §11 has to say about a store: a fetch reveals that somebody opened the viewer, which
the demos already did.

A shipped store that answers `404` is not an error but a state — *not generated yet* — because the
generated stores are written by a workflow (§24.3) and a fresh fork has not run it. The front says
so, and says what runs it. The standalone build (§19) has no tiles and no drawer, for the reason it
has no URL box.

### 24.3 Where the built-in stores come from

`scripts/make_store.py` is the generator, with four generating front ends and no dependency beyond
the standard library. Its shape changed once the answer to *what should a portal store list* became
**everything this viewer can open** rather than *the contact maps*, and the change is worth stating
as a rule, because it is the rule that needs no maintenance: the filter is on whether a file name
has a route (§20.5), never on an experiment type or a format list, so Micro-C, a bigWig, a peak
file and whatever a consortium publishes next are in a store nobody edited. It has one exception,
and the exception is about what the viewer can *draw* rather than what it can open: a **BAM is its
reads**, the reads are drawn from a coordinate-sorted file (§8.13), and the alignment file an
interaction assay's pipeline publishes is in read-pair order — so the 4DN front end leaves out a BAM
whose experiment type is one of the 3C family (Hi-C in every spelling, Micro-C, Capture-C, ChIA-PET,
PLAC-seq, HiChIP, TCC, MARGI, Dip-C, TrAC-loop; `INTERACTION_ASSAYS` in the generator, matched on
the words so a new member arrives filtered), and a BAM the portal does not describe at all, which
has no assay to judge by and no cell to filter on. On 2026-09-15 that was 2,271 and 6,309 of the
store's 9,977 BAM rows, every one a click the viewer could only refuse; the 1,397 alignments of
RNA-seq, ChIP-seq, CUT&RUN, Repli-seq, DamID and TSA-seq stay, and so do every `.pairs` and every
contact map. The ENCODE front end makes the same exception for its Hi-C pipeline's alignments and
for those alone (`HIC_ASSAYS_ENCODE`; 471 rows that day): the list is narrower because the
pipelines are — ENCODE's ChIA-PET alignments come from ChIA-PIPE and are coordinate-sorted, where
4DN runs every interaction assay through its Hi-C pipeline, and both were measured on the files'
own `@HD` lines before the words were chosen. An undescribed ENCODE BAM stays, because its manifest
row still carries an assembly, an output type, a lab and a dataset. It is still a rule about the
file — which door it opens, whether it can be drawn — and not a list of assays worth showing.

**A spine and an enrichment.** The first version asked a portal's search API for both halves of a
row — which files exist, and what they are of — and that is the wrong shape for a complete
catalogue: a search is paged, slow over a million records, and answers with whatever its current
facets allow, while an object store's listing is complete by construction. Each portal front end
therefore has two sources and treats them differently. The **spine** says what files there are:
4DN's `ListObjectsV2` over `4dn-open-data-public`, and ENCODE's `encode_file_manifest.tsv` — a
gigabyte of TSV, rewritten daily at the root of `encode-public`, streamed line by line. A row
exists because an object exists. The **enrichment** says what each file is of — biosource, assay,
target, lab — from one lean search per portal, keyed by accession, never one request per file; a
file the enrichment does not cover keeps its row and loses cells. `--portal require|optional|skip`
decides what an unreachable portal means: fail the run (the default, so a store with columns is
never replaced by one without), publish the spine with its metadata columns empty, or never ask.

The old arrangement's failure was the silent one: 4DN's `ExperimentSetReplicate` search embeds the
*set's* processed files and not the per-experiment ones, so a catalogue built from it alone was
missing about nine files in ten and said nothing about it. The query now asks for
`experiments_in_set.processed_files` and both `other_processed_files` arrays as well, and the
bucket decides what is a row.

The four front ends:

- **`igv`** — `igv.org.genomes/genomes.json`, the file the IGV desktop app and igv.js both load
  their genome menu from: 41 genomes, each a FASTA and the tracks published with it. One row per
  file this viewer can draw, and one pre-configured session per genome. Every URL is **probed with
  a ranged GET** — the request the viewer itself makes, not a `HEAD`, because the two differ on a
  real bucket — which answers two questions at once: the size, which IGV's table does not carry,
  and whether the file opens with no credentials. A file that does not answer gets no row. IGV's
  `refgene` tracks — 29 of its 63 — used to be dropped here too, being UCSC `genePred` tables this
  viewer had no parser for; §8.19 reads them and they are published, which is most of IGV's gene
  models arriving at once. What is still dropped is six genomes whose sequences are **not
  public** — `igv-genepattern-org`
  answers `403 AccessDenied` anonymously, taking out IGV's own `hg38` and `hg19`, and one object on
  `igv.broadinstitute.org` takes out `rn6`. A genome whose sequence will not open is dropped whole,
  since its tracks annotate coordinates nothing can read; GRCh38 remains on the shelf through IGV's
  `hg38_1kg`, whose FASTA is on the public `1000genomes` bucket. Every refusal is named in the log,
  and a run after the permissions are fixed picks the rows back up with no change to the generator.
  The catalogue and the sessions are built from **one** reading of that table, so a file the
  catalogue dropped cannot reappear as a lane in a session.
- **`4dn`** — every routable object on the open-data bucket under `fourfront-webprod/wfoutput/`
  and `.../files/`, enriched from the portal. About 25,700 rows, where the Hi-C-only version had
  1,200: the bams, bigWigs, pairs, peaks and bedGraphs are what the other 24,500 are.
- **`encode`** — every released file in the manifest this viewer can open, enriched from the
  portal's `Experiment` search, at a breadth and in shards (both below). Annotation datasets are
  deliberately **not** enriched: 502,000 of them are the one-per-biosample footprint sets, a search
  over which costs more than the manifest itself, so an annotation's row carries its accession,
  output type, assembly and lab — everything the manifest knows — and an empty Biosample cell.
- **`bucket`** — `ListObjectsV2` over a prefix, one row per openable object with its size, which is
  the `make_catalog.py` §11 and GAPS G10 always promised, aimed at a lab's own bucket.

**Breadth, because ENCODE is 1,209,805 files.** That is what the manifest holds that this viewer
has a route for: 658,000 BED, 284,000 bigWig, 134,000 BAM, 123,000 bigBed, 4,100 `.hic`. One JSON
of it is a quarter of a gigabyte and a table nothing can draw, so `--breadth` chooses:
`representative` (the default) keeps one file per dataset, assembly and format — the one made from
the most libraries, then the newest, then the lowest accession, which is a total order so two runs
over unchanged data pick the same file — and drops the bulk `footprints` dump; `full` keeps every
file but that dump; `all` keeps everything. The default is **210,000 rows and every dataset ENCODE
has**, and each row says how many files it stands for, so what was collapsed is on the row rather
than in this paragraph.

**Shards, because 210,000 rows is still four shelves too many.** The `encode` front end writes one
store per assembly group (`GRCh38`, `hg19`, `mm10`, `other`) and output category (`signal`,
`annotation`, `alignment`) — twelve files, the largest about 25 MB and 55,000 rows, which is a
3 MB fetch once Pages has gzipped it. The two dimensions are the two things a reader arrives
already knowing: which genome, and whether they want signal, peaks or reads. The shard list is
fixed and enumerated in the generator, and `src/ui/stores/registry.ts` names the two facets that choose among them;
`test/dom/builtin-stores.test.ts` reads both lists and checks they agree, because a name that
drifted would be a shelf answering 404 for a file that exists under another name — and the front
would report it as *not generated yet*, which is the one failure that looks like a normal state. An unnamed assembly lands in `other`: a new assembly appearing at a portal must widen a
shard, never vanish.

**Pre-configured sessions.** A front end may also write session files — one `.metacooler.json` per
genome or per dataset, with the tracks placed — and a store of its own listing them as
`kind: "workspace"` rows (§24.1), each naming its group (`dataset`). IGV's hg38 is a FASTA and a
gene track, and offering those as two rows asks the reader to assemble what IGV had already
assembled; a 4DN experiment set is a contact map and the bigWigs published beside it. The viewer
opens one through the road a workspace already has (§21.1), and *where* it offers one is decided by
the group: IGV's sessions are the cards of its front, and a portal's sessions are *open with its
tracks* on the heading of the group whose rows they were made from (§24.2) — never a shelf of
their own, which was a menu entry that answered a question nobody asked in that form. Three rules the generator follows are worth
recording. A session is **one set of coordinates**: sessions are grouped by dataset *and assembly*,
because ENCODE publishes one experiment against GRCh38 and hg19 both and a session grouped on the
dataset alone drew hg19 tracks over a GRCh38 map with nothing on screen saying so. The **view
follows the lead file** (`landingState`, §5.1): a contact map opens on its genome list, a genome or
a track in the 1D browser. And a group with a map and no tracks is **skipped**, because it would be
a row that opens one file, which that file's own row already does.

**How much of a search to ask for at once is a fact about each portal, and both were measured the
hard way.** 4DN must be **paged**: `limit=all` over its set search with the files embedded is an
83 MB response, and the first live run of this design died on `IncompleteRead(43378383 bytes read,
39983032 more expected)` — the socket closed half way through, and the run ended in a Python
traceback where every other failure here is a sentence. ENCODE must **not** be: the run after that
one was answered `403 Forbidden` on `&limit=500&from=0`, having answered the same query with
`limit=all` perfectly the week before. So `PAGE_4DN` is 50 records a request and `PAGE_ENCODE` is
`limit=all`, and `--page-size` is there for the run that disagrees; the tempting uniformity is the
one thing the evidence rules out.

Around that, three rules that hold for both. Every **whole read is retried** three times when a
host agrees to answer and then stops talking — an HTTP *status* is never retried, because 4DN's
JSON-bodied 404 is zero results and retrying it would turn it into a failure. A **refused page says
what to do**: a 403 on a query carrying `from` names `--page-size 0` in its message, because that is
the fix and no status page will suggest it. And the paged walk stops on `total`, on a short page, or
on a page that adds no record it has not already seen — the last of which is **fatal when the walk
is short**, since a portal ignoring `from` would otherwise publish a store whose enrichment covers a
fiftieth of its rows: a catalogue that draws, and has empty cells in nine rows out of ten.

Three more facts the generator has to know are recorded here so they are not rediscovered: a 4DN
search with no hits answers **HTTP 404 with a JSON body**, which is zero results and not a failure;
a bucket listing's objects carry a `<ChecksumAlgorithm>` element between `ETag` and `Size`, so the
XML is parsed as XML — a regex that assumes the four-element order silently drops a quarter of the
bucket, which is how the first census of 4DN came out short; and ENCODE's manifest is read **by
column name** for the same reason, since columns have been added to that file before and a reader
that counted fields would have shifted every cell the week it happened. A run that finds nothing
exits 2 — distinct from the 1 an HTTP failure exits with — so that a workflow never overwrites a
good store with an empty one and never has to tell a portal outage from an empty catalogue by reading
a log. A run that loses **one** front end publishes nothing at all, because the branch is replaced
wholesale: a missing store would delete last week's good copy of that shelf rather than leave it.

`.github/workflows/stores.yml` runs all three portal front ends weekly and on demand, uploads
everything as a **timestamped workflow artifact** (`stores-<date>`, kept ninety days) and publishes
to the `stores` branch: the stores, the `sessions/` directory, an `index.json` naming what is there
with each shelf's row count and size, and a `fingerprint.json`. The branch is where the workflow
*writes*; where a browser *reads* is the **site**: `.github/workflows/deploy.yml` copies the
current files from the branch into `stores/` beside the app on every deploy, and the stores workflow
asks for a deploy as soon as it has published, so a fresh store is on the site minutes later with no
push to `main`. The viewer reads `<site>/stores/<name>.json` — same origin, so no CORS enters into
it, and an archived build or a preview reaches up to the site root for it, since the stores are
published once and not per copy; a build with no site to be relative to (the desktop, a standalone
file) reads the deployed site by `package.json`'s `homepage`, which GitHub Pages serves with
`Access-Control-Allow-Origin: *`. Not `raw.githubusercontent.com`, which was the first design: it
answers 404 to anyone not logged in when the repository is private, and a Pages site is public
whether or not its repository is. A branch rather than a commit to `main` because a store is data
about somebody else's data and changes on their cadence; a branch rather than a bucket because a
fork gets the whole arrangement with no secret to add.

Two things about that branch changed when a run started writing 100 MB. It is **rewritten, not
appended to** — one orphan commit, force-pushed — because a branch that kept each week as a commit
would carry five gigabytes of git objects within a year for a store whose only interesting state is
its tip, and a shallow clone of it is what every deploy does. What survives between runs is the
small part worth citing: `archive/` keeps dated copies of `index.json` and of every store under 2 MB,
pruned per shelf to the last 26 runs, and the 90-day artifact holds the large shards for anybody
who needs last Monday's exact ENCODE shelf. And **"nothing changed" is now a real answer**: every
file carries the instant it was written, so byte equality between two runs is impossible and the
shortcut was unreachable — every Monday pushed a hundred megabytes and asked for a deploy whether
or not a portal had published anything. `fingerprint.json` is the map of each file's hash with its
timestamps removed; a run whose fingerprint matches the published one stops there.

Every generated store carries `generatedAt` and `source` — *both* of the places it came from, the
store that decided which rows exist and the query that decided what is in their cells — because a
shelf with no provenance is a screenshot.

The catalogues juicebox.js reads (`igvteam/igv-data`, MIT) were read while designing this and are
a fine seed for a fixture. They are **not** fetched at runtime: a store that hot-links another
project's file inherits that project's cadence and schema, and the point of the format is that
this viewer owns what it offers. IGV's `genomes.json` is the one exception and is not an
exception to that rule: it is read by the *generator*, weekly, and what a browser fetches is this
project's own static file.

### 24.4 Live search over a portal (withdrawn)

Built, and taken out again before release. A form (`ui/PortalSearch.ts`, over `state/portal.ts`)
asked a portal's own search API from the browser for released Hi-C files matching a free-text
query and drew one page of hits as a store in the §24.1 table. ENCODE answered, its CORS being a
documented line of its Apache configuration. 4DN's portal, whose CORS could not be verified when
the form was written, was observed from the deployed preview on 2026-09-11 answering with no
`Access-Control-Allow-Origin`: the browser discards such a response and hands script no detail,
and nothing here may proxy (C1). A form that could only ever fail on the portal it was most wanted
for, and whose hits on the other were files the generated store already lists, did not earn its
place. The generated stores (§24.3) are the whole answer for both portals — served from a host
that answers browsers, narrowed by the front's own facets — and the form is in the history should
a portal start answering cross-origin.

### 24.5 URLs that are not yet the file

`sources/rewrite.ts`'s `canonicalUrl` is applied wherever a URL becomes a URI — the load box,
the Tracks and Contact maps cards, the deck's add row, a store row, `#uri=` and `?config=` on
arrival — so the address bar carries the form that works and a shared link already is one. Pure,
idempotent, never throwing, and a table rather than a policy:

| pasted | opened as | why |
|---|---|---|
| `https://www.dropbox.com/<path>` | `https://dl.dropboxusercontent.com/<path>` | the share link is a page; the content host serves ranges with CORS `*`. Host swap only, which is all igv-utils does. |
| `https://drive.google.com/file/d/<id>/…`, `/open?id=`, `/uc?id=` | `https://www.googleapis.com/drive/v3/files/<id>?alt=media&supportsAllDrives=true` | the API is the only ranged, CORS-answering form; it refuses without a key (§24.7) |
| `gs://<b>/<o>`, `https://storage.cloud.google.com/<b>/<o>` | `https://storage.googleapis.com/storage/v1/b/<b>/o/<o>?alt=media` | the JSON-API endpoint answers CORS for any origin; the XML host does so only with a bucket policy |
| `s3://<bucket>/<key>` | the URL form of a bucket scope naming that bucket, else `https://<bucket>.s3.amazonaws.com/<key>` | a scheme that could not travel in a link before |

`https://storage.googleapis.com/<bucket>/<object>` is deliberately **not** rewritten: it is the
form a bucket scope's base, the signer and the lister (§20.3) understand, and a bucket with a CORS
policy serves it as it stands. `inferSource` (§5.5's shareability test) canonicalises before it
decides, so `gs://` and `s3://` are shareable and a Dropbox page never is written into a hash.

### 24.6 Links that expire

A presigned S3 URL, a signed GCS URL and an Azure SAS are one URL each, and §11 refused the first
because the `HEAD` probe is not the method it was signed for. The probe now recognises a signature
in the query — `X-Amz-Signature`, `X-Goog-Signature`, or `sig=` beside `sv=` — and goes straight to
the one-byte `Range` `GET` it already had for hosts that say nothing about ranges. Nothing else
changes: the link works until it expires, and expiry looks like the `403` it is, named as such. A
SAS is not method-scoped and always worked; it is listed so the rule reads as one rule.

### 24.7 Credentials that are not a bucket key

A bucket key signs (§20.3, `docs/hosting.md`); everything else on this road is **a header**. The
remote arm of a source therefore carries `headers?` beside `credential?`, applied on every request
for that URL — the `HEAD`, the probe, every ranged read, the whole-object fallback, the sidecar
guesses, and the annotation worker's own fetch — and `s3/attach.ts`'s `withAccess` stamps both at
the two `postMessage` boundaries, independently for a source and its `bins` sidecar, exactly as
`withCredential` stamped one. Two kinds of row feed it, and they are kept differently on purpose:

- **A Google API key** — the site's, built in (`config/siteDefaults.ts`) — sent as
  `x-goog-api-key` to the Drive and GCS JSON APIs. A *public* Drive file needs it and nothing else;
  a public GCS object needs nothing. The key is made in the site's own Google project and
  restricted to the site's address, which is why it is the deployment's to provide and nobody's to
  type: nothing about it is in the browser.
- **A bearer token**, held in memory only and never written to storage, matched to a host pattern
  and dropped at its expiry. It is what a signed-in Google account produces: the site supplies a
  **client id** registered for its origin, the reader signs in through Google Identity Services,
  and the token rides every request to Drive (`drive.readonly`) and GCS (`devstorage.read_only`)
  until it expires, after which a `401` from a Google host is answered by the offer to sign in
  again rather than by the CORS explanation. Absent in the standalone build, which has no origin to
  register.

**Where the three values come from, and from nowhere else.** Each is read in one place —
`readApiKey`, `readClientId`, and `readAppKey` for the Dropbox key of §20 — and each answers the
value the page was **built with**: `config/siteDefaults.ts` exports `SITE_DEFAULTS`, three strings
the build fills from the `GOOGLE_CLIENT_ID`, `GOOGLE_API_KEY` and `DROPBOX_APP_KEY` variables of the
environment it ran in (`vite.config.ts`; the deploy reads the repository's Actions variables of the
same names, docs/deploy.md). None of the three is a secret — all end up in the page — and none is
anything a reader is asked for: the dialog offers the sign-in the registration makes possible and
no box for the registration itself, this browser stores nothing of it, and the stored-data screen
lists nothing for it. A client id is bound to the site's address and a key to its referrer, so a
value a reader could paste would be one for a *different* site; the boxes that used to take one
were a question every reader had to wonder about that only a maintainer could answer. A site
built without a registration says so where the sign-in would be, names the variable, and offers a
button that is disabled rather than absent — the exception to §8.5 this dialog makes, because the
sentence beside it names the one thing a reader can do.

The dialog says one thing plainly that a consent screen would bury: `drive.readonly` is read access
to **all** of the reader's Drive, where a bucket scope is one prefix — and where the token goes,
which is this tab's memory and nowhere else. It says them behind the `?` on the pane's title
(§20), not between the title and the button: the sentences are the page's, the page is the one
that hands over the credential, and a tooltip on that page is still the page saying them — one
hover away for the reader who wants them and out of the way of the one who came to press *sign
in*. And `docs/hosting.md` says the other: Drive throttles ranged reads and meters them against the project's quota, which is nothing
for the dozen requests an open costs and something for the thousands a fine-resolution pan costs, so
Drive is a host this viewer *reads*, not one it recommends. The same mechanism, with no Google in
it, is what a token from an institutional portal or a Terra-shaped signed endpoint needs — one
header on every request — which is why it is a header bag and not a Google integration.

### 24.8 Refused, and why

A **CORS proxy** (C1). **Fetching a store on load** (§11). **Storing a bearer token** — it expires
inside a session, and a secret that outlives its use is the one kind the stored-data screen cannot
make safe. **Hot-linking another project's catalogue** (§24.3). **Rewriting the GCS XML host**
(§24.5). **A Dropbox refresh token** — the one credential in this section that would make a
sign-in survive a reload, and a long-lived secret in `localStorage` for the convenience of not
pasting a code twice a day (§24.9). And one host fact, stated so nobody spends a week on it: the
Aiden Lab bucket `hicfiles.s3.amazonaws.com` answers `403` to every browser user agent and `206`
to one that begins with `IGV`, which no browser can send; juicebox.js needs a proxy for its own
public server, and this viewer will not have one.

### 24.9 A Drive folder and a Dropbox, as connected folders

§24.5 and §24.7 open *one file* a reader has the address of. The way people work with a Drive or a
Dropbox is the way §20 describes for a disk and a bucket — open one, look, open the next — so both
are **connected folders**, behind the same `ConnectedFolder` interface, in the same Files column,
with the same one-level, thousand-entry, no-walk rules (§20.1). Two things the interface did not
have were added for them and are stated here because they change what a backend may assume: a
backend may say **what a path is called** (`labelOf`), since a Drive path is a chain of folder ids
the crumb trail should not print; and a picked file may carry a **name**, which the session gives
the map (§16.10), since a Drive file is addressed by an id and a Dropbox file by a link that need
not end in its name. Both backends **register themselves** with `browse/connected.ts` rather than
being imported by it, so the file every panel subscribes to reaches for no token and a build that
cannot offer a backend (§19) never loads it.

**Google Drive** (`browse/gdrive.ts`) lists a folder — My Drive, or a folder the reader names by
link or id, shared drives included — with the account §24.7 signed in, through the Drive API's
`files.list`, folders first, Google-native documents left out because they have no bytes, a
thousand entries and then *truncated*. A folder is remembered by its id and label in
`localStorage`, named in the stored-data screen; the listing needs the account, so a remembered
folder after a reload says *sign in to Google* until the reader does. A picked file is the API's
media URL — the same address `canonicalUrl` gives a pasted share link — with its name carried
beside it, and **the name is what routes it**: the address ends in an id, which says nothing about
what the file is, so `routeFor` lets the name choose the door the address cannot, and the loading
screen and the tab say the name rather than the address. Where nobody gave a name — a share link
pasted into the URL box, a `view=browser` link, a track added by address — **Drive is asked for
it first** (`browse/driveName.ts`): one `files.get` with `fields=name`, on the same key or
token the read will carry, memoised by id for the page, and never in the way — a refusal, a site
with nothing to ask with, a network that did not answer all come back `null` and the open goes
ahead under the id as it always did. The answer is what the folder listing would have handed
along: it names the loading screen, becomes an empty tab's name, and routes the file by its
suffix, so a pasted `.mcool` takes the map door and a pasted `.bw` the genome door without a
byte read. Where no name says either — an id Drive would not name — the bytes are asked *before*
the map door is tried, because that door's failure is dear: HDF5 hunts for a superblock at doubling
offsets, a megabyte chunk at each, through the whole of a file that is not one, and over the Drive
API that was the better part of a minute for a 56 MB bigWig that then opened in three requests.
Those three are what the annotations worker's
remote handle costs now: it reads 256 KiB chunks and keeps them, one handle per address, so the
assembly question, the load and the first window read a bigWig's header once between them
(`worker/cachedFile.ts`) — the arrangement `RemoteRangeSource` has always made for a contact map,
and the one that makes a host where a request is a second rather than a millisecond usable at all.
The map door reads a Drive file by range as well, although a browser's `HEAD` of one comes back
`Content-Encoding: gzip` — Drive re-encodes what it is not asked a range of, and a page cannot
decline gzip — so `RemoteRangeSource` follows a re-encoded `HEAD` with one for `Range: bytes=0-`
before concluding anything: Drive answers that raw, with the file's length, and a host that
re-encodes the range too is refused as §15 always has (`docs/hosting.md`). Without it every Drive
map went down the whole-object road, silently and whatever its size.
What the row does not carry is a folder tree: `files.list` answers one parent at a time, which is
§20.1's rule arriving from the other side.

**Dropbox** (`auth/dropbox.ts`, `browse/dropbox.ts`) is the one provider here with an account and
no key: the site registers a *scoped-access* app with `files.metadata.read` and
`files.content.read`, and the app key — public by design, no secret — is built in (§24.7); nothing
is kept. The
sign-in is **PKCE with the code shown by Dropbox and pasted by the reader**, not a redirect: a
static page on any origin can do it, the desktop build's `app://` origin included, and there is no
callback route to add to a viewer that has none. The token lives in this tab's memory and dies
with it; the refresh token Dropbox would also hand over is refused (§24.8). The folder is in the
Files panel while a sign-in is live and not otherwise: the site's key is in every reader's page
(§24.7), and a row in every reader's panel, Dropbox or no Dropbox, would be noise with a × that
could not remove it. The folder is the whole
Dropbox the app was granted (or its app folder), listed with `files/list_folder` one level at a
time, and a picked file is a **temporary link** — unsigned, on the content host that serves ranges
with CORS `*`, valid four hours — which is what the address bar then carries: a link a colleague
can open for an afternoon and not a week, and the honest thing to put in a hash for a file whose
real address needs an account.

Neither backend was exercised against its provider from where it was written — the sandbox
reaches neither `accounts.google.com` nor any Dropbox host — so both are asserted against their
documented wire formats through a stubbed transport, and `docs/hosting.md` carries the manual check
for each. What is specified above is the contract; the first sign-in is the test.

### 24.10 A UCSC track hub is a store

A store is somebody's shelf of data written down once, with enough about each row to choose without
opening it (§24.1). A **track hub** is the same object, declared in a format that predates this one
by fifteen years and is what most of the world's published genomics data is actually indexed by: a
`hub.txt` naming a `genomes.txt` naming a `trackDb.txt` per assembly, each track a stanza with a
`bigDataUrl` and a `type`.

So `state/hub.ts` is a **translation** and not a second catalogue system. It reads the files and
produces a `StoreFile`, and from there a hub *is* a store: the same table, the same facets, the same
two verbs on every row, the same `?store=` in the address, the same *remember this store*, the same
download. Nothing downstream knows what a hub is, which is what makes them first-class rather than
bolted on.

**Recognised by content, at `fetchStore`.** A hub is spotted from its first stanza — a `hub` key with
a `shortLabel` or a `genomesFile` beside it — rather than from its URL, which is §8.3's rule applied
a level up: a hub is routinely served from an address that says nothing (a bucket key with no suffix,
a `?download=1`, a redirect), and a JSON store served from a file called `hub.txt` must still open as
a store. Doing it in `fetchStore` is what makes every road a store URL travels carry a hub too, with
none of them needing to learn the word.

**The stanza format, and the three things that bite.** `ra` is `key value` a line, a blank line
between records, `#` for a comment and a trailing `\` continuing a line. Indentation under a
composite is presentation — what nests a track is its `parent` line and nothing else — so it is
stripped. A repeated `track` key starts a new record even with no blank line before it, because hubs
in the wild do not always have one and a parser that insisted would merge a composite with its first
subtrack into one stanza whose `bigDataUrl` belongs to neither. And a `bigDataUrl` resolves against
the **`trackDb.txt` that named it**, a `twoBitPath` against `genomes.txt`, and an `include`d file's
tracks against *that* file: three bases, and using the hub's own for all three puts every track one
directory up.

**`useOneFile on`** puts hub, genome and track stanzas in the single file already read — what UCSC
now recommends for a hub of a handful of tracks — and nothing further is fetched. There, ordering
*is* the nesting: a track belongs to whichever `genome` stanza it follows.

**The genome row.** An **assembly hub** carries its own sequence as `twoBitPath`, always a `.2bit`,
which is why §8.21 is in this release rather than being a separate nicety: without it, every assembly
hub opens as tracks over coordinates nothing can read. A **db hub** names an assembly UCSC hosts
(`genome hg38`) and carries no sequence, so the row falls back to the `chromSizes` the hub declares,
and failing that to the **first bbi file in its own trackDb** — any `big*` type, since a bigBarChart,
a bigMethyl and a bigInteract are each a bigBed with a particular autoSql and nothing else — whose
header carries every sequence and its exact length (§5.8), the same door a dropped bigWig opens a
browser through, and it says so in the row's note. Narrowing that to bigWig and bigBed would leave a
hub whose tracks happen to be all one kind with no genome row at all, which is not hypothetical: the
Human cellular microRNAome hub is two bigBarCharts on hg38 and nothing else. What this deliberately does **not** do is reach for `hgdownload` to
fetch a `chrom.sizes` nobody asked for: C1 says nothing leaves the machine that the reader did not
ask for, and a third-party request invented by a translation layer is exactly that. A hub of nothing
but BAMs against `hg38` therefore gets no genome row, and keeps every track row it has.

**A contact map is not a track.** A `type hic` gets a row that takes the map door, and is kept off
the genome row's shelf: a shelf is annotations, and a map handed to the annotation loader is read as
text, sniffed as a BED and refused with a count of lines that failed the contig/start/end test —
true, and about the wrong question.

**And neither is a track the hub has switched off.** A published hub is not a short list. EPFL's
Breast Cancer Epigenomics hub declares some 440 bigWigs across nine composites and asks for twenty of
them; a shelf that ignored the difference would open all 440 at one press. A hub says which twice —
`parent <name> off` on a subtrack, `visibility hide` on the track or the composite over it — and a
hidden composite hides its children whatever their own word says, which is UCSC's rule and the only
reading on which the two words agree. The shelf is therefore what the hub asks for, the verb's own
tooltip counts it, and the store's description says `440 tracks, 20 on by default` whenever the two
differ. Every track still has a **row of its own**: off by default is not absent, and the reader who
came for one particular ChIP finds it there.

**One row per genome, one per track, and the genome carries the shelf.** The genome's `tracks` are
what the shell turns into the tracks in the Tracks card once it opens (§24.1), so *open with its
tracks* works on a hub with no session file existing anywhere: `ui/stores/ResultList.ts` takes the
verb from a published session where there is one and from a `tracks`-carrying row where there is not.

That verb **loads** them rather than offering them, through a road of its own in the shell
(`StoreHost.openWithTracks`), and the distinction is the whole of why it is a second verb: *open* is
one file and whatever the reader does next, while *open with its tracks* is a sentence that has to
come true — a reader who presses those words and gets a genome with a button proposing the tracks
has been handed the thing they pressed past. Every other road to the same file keeps the offer,
because opening a genome is not a request for eight more files, and the mark is spent when it is
read, so closing the tracks and reopening the genome does not bring them back.
Rows are grouped by **assembly**, which is what a hub is, and carry the hub's own `parent` — the
composite or super-track its author spent their time on — as the `group` column, which is the facet a
reader of somebody else's hub will actually narrow by.

**What is refused gets no row, and is counted in so many words.** A row that draws the wrong picture
when it is pressed is worse than an absent one. `cram` is refused on its own grounds and `halSnake`
because there is no file behind one; both are named in the store's description with their counts,
along with any `type` this viewer has no reader for. The drawable list is UCSC's own set of remote
types, and five of them — `bigInteract`, `interact`, `longTabix`, `bigMethyl`, `bedMethyl` — are
readable only because of §8.18 and §8.20: before those, a hub carrying one would have got a row that
misdrew when it was opened.

**One is shipped.** *Roadmap (UCSC hub)* is a built-in store whose rows are
`https://vizhub.wustl.edu/VizHub/RoadmapIntegrative.txt` — WashU's hub over the 111 reference
epigenomes — and it is the first shipped store that is **somebody else's hub rather than a file this
project generates**. That is the point of it: no shard list, no `stores/` entry, no workflow, no
front of its own. A URL, the grouping every hub has, and the same `fetchStore` every other store URL
already went through, which is what §24.10 claimed and this is the proof of. Its rows are read on
the gesture that opens it and not before, like every store's (§24.2), so the tile costs no request;
if WashU will not allow a cross-origin GET the front says so in the ordinary way, which is the same
sentence any hub gets and the reason there is nothing special to write here for it.

**Its own tile.** A hub gets a door beside the store one on the landing page, and the argument is the
portals': a hub is not a rarer kind of store file, it is the format an enormous amount of published
data is already in, and a reader holding one thinks of it as *the hub*. A door that never says the
word is a door they will not try. Nothing behind it is hub-specific — a hub pasted into the other box
works exactly as well — and a remembered hub keeps the hub mark and the hub's grouping, because both
are facts about the rows rather than about the door they arrived through.

**Pasted, when it cannot be fetched.** A store is fetched by the *page*, so the host has to allow a
cross-origin `GET` — and plenty never will, `genome.ucsc.edu` among them, which puts UCSC's own
example hubs out of reach of every browser-only viewer. Both doors therefore carry a paste box, with
an optional base for relative names. **One box and not three**, even though a hub is three files:
`useOneFile on` is a hub in a single file, and a `hub.txt`, `genomes.txt` and `trackDb.txt`
concatenated are the same thing, since the only keys the concatenation loses are the two saying where
the next file is. `hasGenomeStanzas` is what tells a whole hub from its first file, so a text that is
only a `hub.txt` is refused by name and told what to paste after it. A pasted shelf is not put in the
address bar and not offered for remembering: a store worth keeping is one with an address, and the
honest way to get one is to publish the file. Each box offers a **worked example** that reads — a hub
and a store over the published demo files — because an example beside a paste box is not there to
show syntax, which this document does better, but to be pressed: the reader's first edit should be to
something that already drew a shelf.

**What CORS costs, measured.** On 2026-09-16 neither `genome.ucsc.edu` nor
`hgdownload.soe.ucsc.edu` answers a cross-origin `GET`, which puts UCSC's own example hubs and the
whole of GenArk out of reach of every browser-only viewer — this one, igv.js, anything without a
server. The failure message says so for a `*.ucsc.edu` host rather than sending a reader to check a
URL that is perfectly correct, and says the part that would otherwise be found out one row at a
time: pasting such a hub's text gets past the header for the *hub*, and its `bigDataUrl`s are on the
same hosts and will not open. Downloading the hub and opening it from a mounted folder is the road
that works, and it is the reader's own machine doing the fetching, which is the only place this
project is willing to move that work to. What this does **not** do is proxy the fetch — routing a
reader's traffic through a third party to work around somebody else's header is exactly what C1
refuses.

**A hub to try it on.** `scripts/make_demo_hub.py` writes one over the yeast demo data — a `.2bit`
of its genome, the loop calls as `longrange`, the six bigWigs as a composite and the contact map as
`type hic` — so the whole path is walkable with `npm run dev` and
`http://localhost:5173/demo/yeast/hub.txt`, same origin, with no third-party host and no CORS
question standing between a reader and the answer. It is **strictly valid**, which constrains what
is in it: a hub's tracks are the `big*` formats plus `bam`, `cram`, `vcfTabix`, `hic` and
`longTabix`, so the demo's `.narrowPeak`, `.bed`, `.gtf` and `.barChart` cannot appear without a
`bedToBigBed` this project does not ship, and a hub naming them anyway would open here and fail in
UCSC's browser — the one thing a demo hub must not teach. The same loop calls as `interact` and the
demo's GTF as a `genePredExt` sit beside it as files to drop instead.

The `.2bit` that script writes is checked with `py2bit`, a wrapper around the C in kent's own tree.
That is the only check worth having: a file this repository wrote and this repository read proves
that two implementations share a reading of the format, which is exactly what they would do if the
reading were wrong.

## 25. A 3D structure beside the map

A chromatin model — one chromosome or several, one haplotype or two — read from a file of beads
with a place in space, drawn as a cell of the deck beside the maps and the tracks, linked to them
in both directions, and coloured by whatever the session already knows about the sequence. The
design it was built from, with the alternatives weighed and the sizes measured, is
`docs/structure-3d.md`; this section is what stands.

### 25.1 Words

A **structure** is the file and the row it makes in the Structures card — a row of kind
`structure` on the card `structure`, which is also a feature set: every bead is an interval. A **model** is one set of coordinates; a
**chain** is the beads of one sequence and one haplotype in genomic order; a **bead** is one row
of the file. A **cell** is any occupant of the deck (§16.11).

### 25.2 The formats

**g3d text**, WashU's own and what `g3dtools` takes: `chrom start x y z [haplotype]`, no header,
no end column, rows in any order, the sixth column `m`, `p` or `s` (or `maternal`, `paternal`,
`shared`), and the `chr7(mat)` fold of a `.3dg` read the same. The **width** of a bead is the
commonest step between consecutive sorted starts, counted across every sequence — the spacing the
file was modelled at, inferred rather than declared, and printed under the row so a reader whose
file was meant to be at 10 kb and reads *1.04 Mb* has been told the one thing this reader could
get wrong. It is independent of the map's bin size: the same file opens the same way beside a 1 kb
map and a 50 kb one.

**bed3d**: the same file with the end written down, `chrom start end x y z [haplotype]`, for a
model whose beads are the bins of a map or of any width a BED can say. Each bead keeps its own
end; the commonest length is the width under the row.

**Binary g3d**, the container `g3dtools` writes: a 64 000-byte msgpack header and one zlib block
per resolution, read by range like a BAM rather than whole like a text, through a reader written
here (`annotations/g3dBinary.ts`, `annotations/msgpack.ts`) rather than a dependency. It opens at
its finest resolution and names the others under the row. A version-1 container is refused by
name, with the way out (`g3dtools` rewrites it).

All four are sniffed by content before the BED family sees them — a five-column g3d read as a BED
would be a lane of boxes whose *end* is a coordinate in space — and **a file that names its format
is not sniffed at all**: `.g3d`, `.3dg`, `.bed3d`, gzipped or not, local or over HTTP, is read as
the structure it says it is. An unnamed file is asked two questions, and each exists to tell a
structure from a BED whose columns happen to be numbers: are the coordinates **fractional**, and do
the beads walk like a **chain** rather than scatter. A named file has been told apart already, by
the reader who named it — so a model whose beads *are* a scatter (a randomised control, a draw from
a null, a fragment set nobody has folded) is read as a structure rather than falling through to BED.
It used to be spared only the first question, which put such a file on the Structures card by name
while parsing its payload as a track: the row and what it held disagreed about what had been
loaded. The tests pin what a BED5, a BED6, a bedGraph and a narrowPeak are not. A structure row is **never a lane**: it is unplaced on import, offered no
location control, and skipped by every stack; its picture is the cell.

**The Structures card.** Every model the session holds — dropped, named by URL, or computed
(§25.6) — is a row of one card under the Tracks card, and of no other: the Tracks card and the
Synthetic card leave `structure` rows out. Each row carries the head every row has (colour, name,
eye, close), what it holds (`2,412 beads · 5 kb · 16 sequences`), the task and the framing for a
computed one, and **bed3d**, the model out (§25.7), after the word *export*. The **eye** in the row's
head is what shows and hides: it puts the model in **a cell of its own**, opening one beside whatever
is already there, and takes that cell away again. The lit eye is the whole of the state — the row
carried an accent bar down its left gutter as well, which was a second way of saying what the eye
already says. There is no second control for that and no button labelled with what is already true
(§26.3, §26.7) — a *shown in the deck* button beside the eye was two controls for one act, and a
reader who pressed the lit one expecting it to un-show got nothing. The card's own load zone names
the three formats and, like every other zone that asks for a file, says it takes a drop or a click.
A computed row that came back from a reload is detached and offers **recompute**, which opens its
recipe in the drawer, as the Synthetic card does (§18.5).

### 25.3 The deck of cells

**A structure cell** draws **one** structure row — the one the reader chose from the Structures
card or from the cell's own **structure** picker, remembered per file, or the first of the list no
*sibling cell* is already drawing; and **the deck holds one cell per model**. A model that arrives —
dropped, computed, or **computed again onto the same row** — opens a cell beside whatever was there
rather than taking it over. It used to be one cell per deck, which made two models something a
reader could only compare by swapping back and forth, and made a reconstruction landing destroy the
model it was to be judged against — the commonest way to lose a picture in this application. The
cell's own picker still swaps a model **in place**, which is the other question: the eye is a model
asking for a cell, the picker is a cell asking for a model. And **the row the cell is drawing, removed from the card, empties
the cell**, which says so, rather than quietly showing the next model along — however the cell came
to be drawing it, whether the reader picked it, the session restored it, or it was simply the only
one there was (a remembered choice whose row is already gone when a session opens falls back to the
first, since no cell was drawing it) — with three.js, which is loaded when the first cell is built and never with the page: a chunk of its own
on the web, folded into the one file of the standalone build. **Beads, sticks and a tube as three
toggles that combine** (the tube alone by default); a **dashed run of ink across every gap** in a
chain, always, so a chain with a missing bead reads as one chain with a hole and not as two; a halo
on the hovered bead; a **dashed chord of ink** across a hovered contact and the loops as chords of
ink, both drawn as cylinders rather than one-pixel lines so they are seen at the size of the tube
they cross, at **half its radius**, since a line drawn *about* the model that is as thick as the
model reads as a piece of it; **a fog tied to the slab**: it begins at the centre of rotation — the plane the slab is centred on,
which ⌘-click moves — and reaches the page exactly where the slab cuts, so what the fog says is
*how close this is to being cut away*, its slider weakening it by pushing that plane out (at 1 the
far face of the slab is the page, at a half it is half way there). Measured from the camera alone,
as it was, a thin slab left every one of the few beads it kept already half dissolved: the fog was
describing the whole model while the slab was showing a slice of it. Lit, always; lit, always; **orthographic,
always** — a model has no horizon, and perspective made the same distance read shorter at the back;
the camera remembered per file. What is **outside the window, or ghosted from the key, is drawn at
the ghost opacity** — 0.15 by default, a trace — and that slider is the one opacity there is:
everything else is drawn whole. It is a **real transparency**: a ghosted bead keeps its own hue and
lets whatever is behind it through, and at **0 it is gone** — not drawn, and not in the way of the
model behind it either. It used to be a colour mixed towards the page, which on a white page reads
as *pale* rather than as *faint*, still hid what was behind it, and at zero left a page-coloured bead
punching a hole in the picture; the 2D painter always had it right, so the same model on screen and
in an exported PDF disagreed about what ghosting meant. *Outside the window* has three answers: *ghost* (the default),
*hide*, and *show* — the window ghosts nothing, and only the key's own ghosting is left, which is
how a whole genome is looked at while the maps look at one window of it. The map's *legend* switch (§7) hides the key here too, so one switch
says what a figure carries. On/off settings are icon toggles, **lit when on** (§26.3): drawn as, chords, fog,
overlays. Every slider carries a **readout of the number it is at** beside it — a bead radius with
its value nowhere on screen is a figure nobody can reproduce — and a slider whose setting does
nothing is **greyed with its reason in its tooltip**: the ghost opacity while *outside the window*
is *hide*.

**A setting is one row.** A select sits on one line with its label wherever the card is wide enough
to read the value, and drops the label above it below about 15 rem — asked of the *card* through a
container query rather than of the window, because this card is drawn both in a 200-pixel Aesthetics
column and in the enlarged dialog's sidebar, which is twice that and resizable. And a slider that
only **shapes** something a toggle or a select **arms** shares that control's row: *fog* carries its
depth and *outside the window* its opacity, where each was two rows and the second carried a label
that repeated the first. A slider that is the whole setting — bead radius, tube radius, depth slab —
keeps a row of its own.

The card's rows are in one order, choices before the things that modify them: structure,
compare with (and its RMSD note), drawn as, overlays, colour by, colour scale, bead radius, tube
radius, haplotype, outside the window (with its ghost opacity), loops as chords, fog (with its
depth), depth slab, measurements, camera, frame, export. *Overlays* follows *drawn as* because the
two are one question asked twice: what the model is drawn as, and what is drawn over it.

**The settings are a card of the Aesthetics panel** — *3D structure*, in the view's own column of
cards right after its *Map* card and before *Tracks* and *Groups*, built from the same field
primitives, placed by the session whenever the deck has a structure cell and taken out when it has
none, the column scrolling over all of them as one — and not a menu in the cell: a view's settings are in that column, and the model is a
view. The cell keeps **five corner buttons** — mark a bead, mark a loop, measure (§25.4), frame the
window, enlarge — the frame wearing the same mark the Map card's refit does and the enlarge its own,
since two corner-bracket glyphs side by side were told apart only by hovering them; the dialog
borrows the card into its sidebar — the card alone, its *camera* and *frame* rows being the dialog's
camera controls — and gives it back where it was.

**And it borrows three settings that are not the row's own.** `legend`, `crosshair` and `tooltip`
are preferences about every picture in the app (§26.3), kept in one store and offered on the *Map*
card — which is in the column *behind* the dialog while the model is enlarged, so the one switch for
the key the reader is looking at was the one they could not reach. They appear as a **shared** row at
the foot of the sidebar for as long as the dialog is up, and nowhere else: §26.3 wants a control
offered once per column, and the Map card offers them there. Exactly the three this picture reads; a
fourth would be a control that does nothing to the thing it was pressed beside.

The card also carries a **depth slab** (two clipping planes either side
of the centre of rotation along the line of sight, at a fraction of the model's reach, the way into a
dense globule, and **the depth the fog is measured against** — see below; measured in the scene's
own units, against the model's reach, rather than in the file's), a **genomic ruler** (a tick of ink at the first bead of every step along each chain —
the first of 10 kb, 20 kb, 50 kb, 100 kb… at least ten beads wide and no more than about forty
ticks over the whole model, so a genome at 5 kb is read at 500 kb — labelled `500 kb`, `1.5 Mb`,
at most eighty labels, and no zero tick: a chain's start is where its name is),
**camera presets** (front, top, side), a **turntable** that turns the model slowly by itself, and
**frame** (the window, everything) — all of them **bordered buttons** like every other action in the
column (§26.6), since a quiet word beside a bordered toggle reads as a caption for it. The cell's actions are **commands** in the palette with keys —
`f` frame the window, `a` everything, `1` `2` `3` beads, sticks, tube, `l` names, `r` turntable —
**bound only while the model is enlarged**, and listed in the palette either way; the three modes
have none at all (§25.4), which is three letters — `e`, `o`, `m` — handed back to the breaks toggle,
the new tab and the Aesthetics panel that each already had one of them. They are single letters and
so are the app's own (`f` folds the Files panel, `a` the Annotations panel); a cell sits *beside* a
map and its commands come first in the palette's list, so binding them there took those letters from
the panels for as long as a model was on screen. In the dialog the model is the whole window and
there is nothing else a letter could mean. And a key is **printed on a control only where it is
bound**, through `withKey` (§26.4): the corner's *frame* and the card's *frame* and *turntable* are
retitled when the dialog opens and closes, because a card beside a deck reading `(f)` was offering a
letter that folds a panel instead. A phased file draws both homologues,
and the key's chips solo one. The picture takes the whole cell — a map's cell is its plot and its
lanes together, and a model has no axis to line up — and a button in its corner **enlarges** it into
a dialog with every setting in a sidebar beside it, **dragged wider or narrower by the grip between
them** and remembered per file, as a panel column is; the cell's own canvas, key and labels are
moved into the dialog and back, so the camera, the colouring and the pin the reader left it with are
what the cell shows afterwards; a button in the stage's bottom corner hides the sidebar and brings it
back. A **badge in the top-left corner** says what the hand is about to do, and goes accent for a mode the
reader is *in* rather than one the hand is passing through: *turn* (a drag orbits, **without limit** —
neither angle stops, so the model turns over the top and keeps going rather than hitting a wall
halfway through a drag; the clamp that used to hold the horizon level was a turntable's convention
and a structure has no horizon),
*move* (Shift held: a drag pans the whole model), *centre* (the centre key held — ⌘ on a Mac, Ctrl
elsewhere: a click on a bead makes it the centre of rotation), *fog* (Space held: the wheel brings
the fog forward or pushes it back, which the card's *fog depth* slider also sets, 0 to 1, 0.6 the depth the
cell always had), or *mark*, *loop* or *measure* (§25.4). It is a **readout and not a control** —
no border and no pill, the translucent backing the map's key has — because a bordered pill three
pixels from five bordered buttons is a button a reader presses and nothing happens. A **tap** of the centre key alone shows or hides the **centre
of rotation** — a ball at the camera's target with the three axes through it, drawn over the model —
which the card's *overlays* row also does; the keys act only while the pointer is over the
cell, its canvas is focused or its dialog is open. The three **sticky** modes — *mark*, *loop* and
*measure* — stay on until pressed again, so each button is lit while its mode runs (§26.3) and the
badge names it. It opens when a structure is dropped or named by URL while a map or
the browser is on screen, from the bar's add row, from a g3d dropped on an empty card, from a
link's `3d`, or by **dragging a row of the Structures card into an empty cell**; a second structure
replaces the picture rather than adding a cell. Every row of that card carries a **grip** for it,
because a reader with three models loaded has the row's own button — which always means *the*
structure cell, wherever it is — and no way to say *that one, there*; dragging says where as well as
which, and an empty cell is a place somebody already made room in. The drag carries the row's id
under a type of this application's own, so an empty cell can tell a model from a file while the drag
is still in the air, and the cell's hint offers both.

**The tracks cell** is the session's own browser over the lead file's sequences — the same store,
client, groups and marks — drawing only the tracks **placed on it**: the location control lists
it beside the maps, with its one edge live and the other three greyed and saying why. It follows
the maps and the maps follow it without joining the lock, whose currency is cells of a block: the
deck hands the cell the lead's window as loci, one way and never reported back, and a pan in the
cell takes the lead's *column* axis there (`MatrixPanel.showLocusOnColumns`), which the lock
spreads to every other map. The chain in its heading unhooks both roads.

**The browser as lead.** A session showing its 1D browser can open a deck: the browser stays the
session's view, re-parented into cell 0 as a map's is, and the cells beside it are tracks and the
structure. The deck learns a lead that is not a map — the browser's windows as loci, and a way to
be taken somewhere — and the browser reports every move of its window, a link's included. A map
may not join such a deck: the bar refuses it in words, the add row puts its map roads away, and a
map a link names is held as the cell it would have been, under its name.

### 25.4 Hover, both ways

A bead under the pointer is a place on every map and every lane: the maps draw it as a **dashed line
down and across the heatmap** on each axis the place is on (one line on a turned map, whose rows are
separation), and as the tick at the edge of the stacks the lanes already give a pointer on another
panel's track; the status bar names the bead, **and so does the cell's own corner**, which is where
a reader looking at the model is looking — one place for a bead, the pair and their distance for a
contact named by a map. The corner is not gated with the *tooltip* switch: that switch is about the
card that follows the pointer, not the line in the corner. The other way, a place pointed at on a map or a lane
lights its beads and, for a contact, joins the two with a chord; the **ball** on a lit bead is
translucent and depth-tested, so it sits in front of the bead or tube it marks and behind any part
of the model nearer the eye, as a ball at that place would.

**Three modes, a button each**, in the cell's corner and in the palette — and **no key**, because a
bare letter that arms a mode is a letter pressed by accident while the pointer happens to be over
the model. One is on at a time — arming the next disarms the
one that was on, pressing the one that is on turns it off — and the badge in the top-left corner
says which. They are three buttons and not one mode that counts clicks because marking a place and
marking a loop are two things a reader means, and a mode whose first click might be either is a
mode whose first click cannot be taken back by stopping.

**Mark a bead** turns every click into one of the reader's own marks (§8.1's manual annotations):
a **line** at the bead's locus on both axes, kept in the Manual annotations card and drawn by every
map, lane and tracks cell. On the model it is the bead again, **twice the radius, in the mark's own
colour** — a place is a thing on the model, so it is drawn as a bigger bead rather than as one more
line over one. **Mark a loop** holds the first bead clicked, names it in the status bar and closes
an **arrowhead** — the map's loop mark — on the second; Esc lets the held bead go. An arrowhead made
here is a chord on the model, since *loops as chords* switches to *your marks* when nothing else is
chosen. **Measure** is a **drag**: press on one bead, travel to another, let go, and the
measurement is made — the line follows the pointer on the way, so what is about to be measured is
what is drawn. The model does not turn under a measuring drag, because the hand is pointing rather
than steering; a press that lands on nothing turns it as ever. A press and release on the same bead
holds it instead, so the two-click gesture still closes a measurement for a reader who prefers it.
The card lists each one — the two loci, the distance in the model's units and the genomic separation
along the sequence, or *across sequences* — until its × removes it; each is drawn on the model as
dashed ink with the distance written at the middle, and in the figure the same.

**A card under the pointer** names the bead's sequence and where along it, in the same shape the
map's card has and under the same switch (§7's *tooltip*): a reader who turned the card off beside
the map meant it off. The line in the corner and the status bar are not gated, exactly as they are
not beside the map.

A store of one place (`ui/hoverLocus.ts`): one locus from a track, a bead or the browser's axis,
two from a map's cell — **one** while a span modifier is held, because that is the gesture the hand
is in the middle of: the crosshair has already stood up as a single line and the readout has already
stopped naming a contact, so a model still joining two beads would be the one surface left answering
a question the pointer stopped asking. The one place is the position along the diagonal, which is
what the line is drawn at and what the readout names. Each saying which surface it came from, every
subscriber ignoring its own.
A pointer on a map lights the bead at each end and joins the two with a chord; a pointer on a
bead is a mark on every map's column axis and a guide on every tracks cell; a pointer on a tracks
cell is the same on the maps and the structure. The deck's own cell-to-cell echo between maps is
untouched, and a map's hover is not relayed to the maps twice.

What the maps are looking at reaches the cell as loci on every pan; beads outside the window are
ghosted, hidden or shown, at the reader's choice, and the frame button puts the camera on what is
lit. **The pointer aims for you.** A bead is a few pixels across and a fibre is thinner, so the ray is
cast first — exact, and respecting what is in front of what — and where it hits nothing the nearest
bead whose centre falls within fourteen pixels is taken instead, the nearest to the eye winning
where several do, and never one the slab has cut away. **The cursor becomes a cross** whenever a
bead is being aimed at, either way, so the slack is visible rather than a surprise when the click
lands somewhere the hand did not press. A click pins a bead; Shift-click puts a mark at its locus
that every map and track then draws; a double-click on a bead takes the maps there; on the air, it frames. A picking mode armed
by the marks card or an analysis form takes a click on a bead as the place, on both axes at once,
as a track's does.

### 25.5 Colour, chords, names

**The key is a control.** Under *colour by sequence*, each sequence's row carries its swatch as a
colour picker — click it to choose the sequence's colour, kept with the row by name over the
palette's — and its name as a button: a **click ghosts** that sequence (drawn as the beads outside
the window are, and hidden with them under *outside the window: hide*), a **double-click shows it
alone** (every other ghosted; a second double-click brings all back). Ghosting stacks with the
window's: a ghosted sequence stays ghosted whatever the maps look at. The reader's own
**arrowhead marks** are offered under *loops as chords* as *your marks*, beside the loaded loop
sets, so a loop marked on the map or in loop mode is a chord on the model. The row is *label, toggle,
set* on one line, and **the toggle is absent while the set is `none`**: lit with nothing chosen it
was a *show the chords* that could not show one, and a reader pressing it could not tell which of
the two controls was why the model stayed bare (§8.5).

The homologue picker on a phased model is labelled **haplotype** and the row of name, ruler and
centre marks **overlays** — the word the Map and Tracks cards use for the same kind of row. Both read
*show* before, which is one name for two questions on one card.

**Telomeres.** A toggle under *overlays* puts a **yellow bead on every telomere** — the palette's own
yellow, drawn through the same channel a reader's mark is and therefore at the same larger radius,
in the same place under every drawing and every colouring, and in the vector export without a second
road. What counts as one is **both ends of every chain**, with nothing asked of the session: a chain of
one bead gets one mark rather than two, and beads the file left unplaced are skipped, so a chain
that opens with a gap is marked at the first bead that is actually somewhere.

An earlier rule asked, and the argument for it was sound — the end of a *chain* is not the end of a
*chromosome*, so the start was claimed only from a first bead at base zero, the far end only against
a length the *file itself* declared, and neither for a sequence ticked **circular** (§8.15). It was
also useless in practice, and the reason is worth keeping: a model's own lengths are a lower bound,
a lower bound cannot establish an end, and a whole yeast genome came out with five marks where a
reader was looking for thirty-two. The mark is a **chain end** and claims no more than that.

**Contacts from the pin.** With a bead pinned, *colour by contacts with the pinned bead* puts the
map's row through it onto the beads: each value through the map's own transform, clipped to its
`vmin`–`vmax`, in its colormap — the virtual 4C of the pin, read in space and agreeing with the
picture beside it cell for cell. **A pair the map never counted is the bottom of that scale**, not
`log10(0) → 0`: that clamp is numpy's and it is right on a map, whose scale starts at zero, but the
scale here is the map's *transformed* range and a balanced map's runs from about −3.6 to about 0 —
so the clamp drew every uncounted pair at the dark end, and a 4C in space came out with its darkest
beads exactly where there was no contact at all.

The same row was also drawn as **chords** from the pinned bead, under a *pin contacts* toggle and a
threshold. That is gone: the colouring says the same thing in the representation the model is
already in, and a cage of coloured cylinders over a globule was a second answer to a question the
first had answered.

**Compare with.** Another structure row — the loaded model against the reconstruction, or two
solvers' models of one map — is **superposed** on this one: the beads the two share are matched by
locus (and haplotype where both are phased), the other is rotated, scaled and moved onto this by a
similarity fit (Horn's closed form for the rotation, Umeyama's scale; `structure/align.ts`, held
still by a model asked back from a turned, scaled and shifted copy of itself), drawn in grey as a thin
tube in this model's frame, and the card says how many beads matched and the root-mean-square
distance between them. *Colour by displacement* colours each bead of this model by its distance to
its bead in the other, on a ramp, which is where the two disagree. Fewer than four shared beads is
no fit, and the card says so.

**The colour scale is the reader's**, where the colouring has one: a picker under *colour by* lists
every colormap this application carries, and *the colouring's own* — the default — keeps the rule
below, that a track's beads take the lane's colormap and contacts the map's, so a bead and the
picture beside it cannot disagree at the same value. It is offered only for a **ramp**: a colouring
by sequence or haplotype is levels and has no scale to change, and a control that does nothing under
the default colouring is one a reader tries and then distrusts. The key follows the choice, because
a legend naming one ramp over a model drawn on another is a legend that lies.

One picker, on the picture: **sequence**, **haplotype**, **position along the chain**, the file's
own **score** and any column it carries; and, from the session, **a track's values** at each
bead, read through the same sample cache the lanes use at one bucket per bead and on the lane's
own limits, so a bead coloured by a bigWig agrees with the lane at every value; **a feature
set's** colour where a bead overlaps one; **the reader's marks**; **the distance to the pinned
bead** in the model's units; and **contacts with the pinned bead** — the lead map's own row
through it, read out of the block in hand on the map's own transform, range and colormap, the
virtual 4C drawn in space. A colouring the list no longer has stays named in the picker rather
than silently becoming the first option. Two rules carried from the modules reused: fit the
colouring to the file, not to the window, so turning the model never changes what a colour means;
and use the lane's scale.

A **pairs row** — BEDPE, loops — can be drawn as chords between its anchors' beads, kept to the
loops touching the window and capped at six hundred, past which a model is a cage. The reader's
**bookmarks** are named on the model at their middle beads.

### 25.6 Analysis

Three tasks under *map*. The first two are listed greyed until a map is open and a structure
loaded. **Model versus
map** bins the beads to the map's bins per sequence and answers the validation picture: the
model's distances as a matrix and as `1/d^α`, the mean distance at each separation beside the
map's own P(s) over the same bins with the log-log slope, and a table of Spearman correlations
between `1/d` and the observed contacts per sequence and haplotype — rank-based, so the exponent
enters the picture and not the number. **Spatial tracks** turns the model into three profiles on
the map's bins — radial position, distance to a chosen locus, local compaction — which "a
synthetic track is a track" (§18.5) makes lanes, colourings of the model itself, and inputs of
every track task. Both are `structure/versusMap.ts`, pure over arrays, held still by tests.

**Model from the map** needs no structure: it makes one. It is the reversal of §25.8's refusal, and
the §18.9 bar is met the way it was met for chromosight — by porting a published method rather than
inventing one. **Method** offers the two positions the literature takes on what a contact count
*is*, because they are not two settings of one algorithm and they give different models of the same
map: **pastis-NB**, where a count is a count drawn from a distribution, and **ShRec3D**, where a
count measures a distance. pastis-NB is the default. One control is shared and is never hidden —
**Exponent α**, 3 by default, the same number *Model versus map* assumes and the one α is *not*
fitted by either method, so that a model made here and a model made by either published tool mean
the same thing by it.

**pastis-NB** (Varoquaux, Ay, Noble & Vert 2014 for the Poisson models; Varoquaux, Noble & Vert
2023 for the overdispersed one) reads a pair of beads `d` apart as having been counted
`c ~ NegativeBinomial(mean β·bᵢ·bⱼ·d^(−α), dispersion r)` times, and the model is the one that makes
the counts most probable. Two things follow, and they are why it is the default. **A zero is
evidence** — weak evidence, that the beads are far apart — rather than a distance of `0^(−1/α)`
that has to be dropped or invented, so **nothing is filled in**; on a map that is three-quarters
zeros this is the difference between a model and a guess. And **a count's precision is in the
likelihood**, so a pair seen ten thousand times holds its beads ten thousand times as firmly with
nothing weighted by hand.

**It is solved on the raw counts**, whatever the view is balanced with, and the balancing weights go
where pastis puts them — into the mean, as `bᵢ = 1/wᵢ`. This is not a preference: a balanced value is
a count times two weights, and **overdispersion is a statement about a count**. `variance > mean`
compares a squared quantity with a linear one, so scaling the data scales the two sides differently
and a balanced map is never found overdispersed whatever it actually is; handed balanced values the
negative binomial would silently become a Poisson. The coverage is still corrected — in the mean
rather than in the data — and the run says so, in a note and in the table. A bin the balancer
**rejected** (a `NaN` weight) is left out of the model, because the balanced view of the same map
does not draw it either and reading raw counts would otherwise put it back; it is counted in the
same note as a gap. A pooled cell's bias is the mean of its bins'. A file with no `/bins/weight` has
no bias to fold and the mean is `β·d^(−α)`. One consequence for the reader: a **balanced view cannot
be borrowed** by this method, so a run on one reads its blocks from the file, and the estimate says
so. The dispersion is **fitted from the counts, per genomic separation**, by
the method of moments (`r = m²/(v − m)`) over log-spaced separation bins — which is pastis-NB's one
claim over pastis-PM2, that overdispersion is not one number for a map but grows as the counts thin
out with distance; a bin with too few pairs to believe takes the nearest that had them, and a
separation whose counts are not overdispersed at all takes `r = 10⁶`, which is a Poisson to six
figures and is reported as *none*. The whole of the negative binomial over the Poisson is one
factor: the force on a pair is the Poisson's own `μ − c`, **shrunk by `r/(r + μ)`**. What is
optimised is three coordinates per bead and `log β`, by **L-BFGS** with a strong-Wolfe line search
— the optimiser pastis reaches for through SciPy — started from the MDS model ShRec3D would have
given, which is pastis' own initialisation and is why this method stands on the other rather than
replacing it. `β` is a variable rather than a constant because the scale of the model and the scale
of the mean are one degree of freedom, and the normalisation below fixes it. Three departures from
the paper are deliberate and named here: the dispersion is a **moment estimate per separation bin**
rather than their parametric fit of dispersion against the mean, and it is taken **once** rather
than alternated with the structure; there are **no restarts**, so the answer is one deterministic
model rather than the best of several local optima; and `α` is the reader's control rather than a
fitted parameter. The **MDS start is sixty SMACOF steps**, fixed, because it has only to land in
the right basin — **Refinement steps** under this method is the likelihood's budget.

**ShRec3D** (Lesne et al. 2014) is the same pipeline with the refinement every MDS toolkit ends
with: a contact count `c` is read as a distance `d = c^(−1/α)` — the law *Model versus map* assumes
the other way round; the pairs the map never counted (a zero, a `NaN`) are filled so the matrix is
complete; classical MDS (Torgerson: double-centred squared distances, three leading eigenvectors by
subspace iteration) gives a start; **SMACOF** (de Leeuw's majorisation, taken one bead at a time as
Gansner, Koren and North's localised stress majorisation) moves the beads until the model's
distances match the map's over the pairs the map counted, **each pair weighted by how often the map
counted it** — a filled pair weighs nothing — stopping at the step count asked for or once a step
improves the weighted stress by less than a millionth. The weighting is the point of refining at
all: the count sets a pair's target, but with every pair weighing the same the stress is the far,
weak, noisy pairs' and the near diagonal, where the map is most certain, is fitted worst. **Weight
pairs by** — shown only under this method, since a likelihood *is* its own weighting — offers the
count (a pair seen a thousand times is a thousand times as sure as one seen once, which is what a
Poisson count's precision says; the default), its square root (a weak pair is still heard on a deep
map), or nothing (every counted pair one vote: the plain SMACOF of every toolkit, kept so a reader
can see what the weighting changes). Three departures from ShRec3D are deliberate and named here:
its shortest-path filling is cubic in the bead count and would not finish in a tab, so the filling
is the mean observed distance at the same separation on the same sequence, walking outward to the
nearest separation with an observation, and the mean observed trans distance across two; ShRec3D
stops at the classical solution, which honours the filled pairs as much as the counted ones; and it
has no refinement to weight. The bead-at-a-time form is what makes the weighting affordable: the
full weighted Guttman transform is a linear solve in the weight Laplacian, and the localised one
costs a pass over the pairs like the unweighted one does, and never raises the stress.

Either way the model is centred and scaled to a unit root-mean-square radius: a map carries no
physical unit, and neither `c^(−1/α)` nor a `β` fitted against it is in one (§25.8).

**What it is solved over** is what the **Sequences** box names, seeded from what the map shows
(a locus, or every sequence on screen): where the view's block **as drawn** covers it — the loaded
locus at its drawn resolution, pooled cells included, which is the one task that honours
`binsPerCell > 1` rather than refusing it — the block is taken as it is, cis and trans together, one
bead per cell, filed under the sequence holding its first bin and cut at that sequence's end. Where
it does not — several sequences, a whole file, a block balanced the other way or not square — the
file is **read span by span**, one rectangle per pair of named spans (two sequences far apart cost
their two squares and the rectangle between them, never the sequences in between). **One bin of the
resolution the reader has selected is one bead** — never the drawn cell, whose width comes from a
raster cap and the size of the window rather than from anything anybody chose. The block on screen
is borrowed only when it is drawn *one bin to the cell*, where borrowing changes nothing and costs
no read; a pooled block is declined, which is `usableBlock`'s rule and every other task's (§18.4).
A coarser model is a coarser **rung**, selected in the view, which also reads far less: a genome at
5 kb from the 5 kb rung reads a twenty-fifth of what the 1 kb rung does for the same model. The box
**empty is the whole file**. A cell whose row the map counted nothing on — a filtered bin, a gap —
is left out of the model, and the run says how many were.

**There is no ceiling on the beads.** Both the time and the memory are quadratic in the count, and
what the estimate does about it is *say so* — the bead count and its bin width, the seconds per
hundred refinement steps and the gigabytes of matrices — for the reader to confirm before pressing
run. A number chosen in the source could only be a guess about somebody else's machine. What is
still refused is the allocation that cannot succeed: the matrices are asked for inside a `try` and a
browser that will not give them leaves a note naming the size, rather than a tab that dies. **Either
method holds two** dense `n × n` matrices of singles and no more — under ShRec3D the pairs' weights,
under pastis-NB the counts with a zero still distinct from a gap, and in both cases the counts
turned into the distances they imply over the buffer they already occupy, compacted onto the kept
beads in place and then filled over themselves — so twelve thousand beads is about a gigabyte. The
likelihood adds **vectors and not squares**: L-BFGS at depth eight keeps twenty vectors of `3n + 1`
doubles, six megabytes beside that gigabyte, where the Hessian a full quasi-Newton method would
write down is thirty terabytes. What it does cost is time — a likelihood evaluation is about 2.3
passes' worth of a SMACOF step, and a step is a line search of just over one evaluation — and the
estimate prices the method the reader picked rather than an average of the two.
**Every phase reports progress and breathes between units of work**: each rectangle read, each of
the eighty sweeps of the classical start, each SMACOF step, and under pastis-NB each *evaluation*
of the likelihood rather than each step, since a line search is several of them and each is as long
as a SMACOF step. The run's other output is a table, and it says which method ran: where the
contacts came from, the bead count and width, the pairs counted, and then either the law, the
weighting, the steps and the final weighted stress, or — under pastis-NB — the mean's law, how many
zeros were used as evidence, the fitted overdispersion near the diagonal and far from it (or
*none*, where the counts turned out Poisson and the run is a pastis-PM2), the MDS start, the
likelihood steps and evaluations, why the optimiser stopped, the final `−log L` and the fitted `β`.
Both end with Spearman's ρ between `1/d` in the model and the contacts — **against `raw/(bᵢbⱼ)`
where a bias was divided out**, which is exactly the balanced value, since balancing is `raw·wᵢwⱼ`;
ranking against the raw counts would score the model on coverage it was right to have removed. So it
is the same number *Model versus map* would give the row on a balanced map, and a reader can see how
well the model honours the map before believing it.

**Its result is a row**, not a picture: a `structure` row on the Structures card, of kind
`structure`, payload a bed3d-shaped feature set with its `model`, id `analysis:reconstruct3d:
reconstructed-model` (per map on a deck, as every computed row is), labelled `3D model · chrIV`
or `3D model · 16 sequences`, summarised as a loaded one is, carrying the task and the framing as
provenance. It replaces the last run's row, is the model the cell draws the moment it lands, is
what *Model versus map* and *Spatial tracks* read, persists as a recipe and comes back
`detached` with **recompute**, and leaves as a bed3d from the row, from the drawer and from the
Synthetic-card export road. The golden is the one a reconstruction can honestly have. For ShRec3D
(`structure-reconstruct.test.ts`): a helix whose contacts were made from it by the law comes back
as itself up to a rigid motion, a chain with most far pairs uncounted comes back with ρ above 0.9,
and a helix whose weak far pairs were corrupted keeps its near pairs when weighted by the count
and loses them when every pair weighs the same. For pastis-NB (`structure-negbinom.test.ts`, with
the optimiser held separately in `structure-lbfgs.test.ts` against Rosenbrock and a badly
conditioned quadratic): the gradient agrees with a central difference at every coordinate and at
`log β`; the objective is the Poisson's as `r → ∞`, and is stationary exactly where the mean equals
the count, for every `r`; a counted zero moves the likelihood and an unobservable pair does not; the
pull on a pair is the Poisson's shrunk by exactly `r/(r + μ)`; a helix whose counts were **drawn**
Poisson at the law's own mean, three-quarters of them zeros, comes back with ρ above 0.9 from a
classical start that was below 0.4; and a helix whose far counts were corrupted holds its near
diagonal about twice as well under the fitted dispersion as under a flat Poisson one.

### 25.7 Export

The card's last row is **the export row** (§26.6) — `[resolution] [format] [⭳] [⧉]` with a line
under it — so a model is saved the way a map and a browser are, and at the resolution the reader
chose rather than at a fixed one. Beads and sticks export as **paths** through
`structure/painter.ts`, projected through the same camera the screen was; a tube is a lit surface no
`arc` can be and exports as the raster the GPU drew, **at the row's own resolution**; the deck's
figure takes the cell's canvas like any other, at the deck's 300 dpi (§16.5). The clipboard takes a
PNG, as it does for a map.

**A model leaves as a bed3d** — `chrom start end x y z`, the haplotype column for a phased one, a
`#` line naming the row, its framing and when it was made, six decimals — from the **bed3d**
button of its row, from the drawer's result and from the export road a computed row shares with
called intervals. It is the file §25.2 reads, so it reads straight back here and in `g3dtools`.

### 25.8 Refused, and not yet built

- ~~**Inference** — computing a structure from the map.~~ Built as *Model from the map* (§25.6), as
  a port of pastis-NB and one of ShRec3D with SMACOF refinement, chosen by **Method**. What stays
  refused is a **physical unit** for it: the model is in its own units at unit radius, and a
  nanometre would be invented. Also refused, and named in §25.6: **restarts**, so one deterministic
  model rather than the best of several local optima; **fitting α**, which is the reader's control
  and is what makes a model here comparable with one from either published tool; and pastis-NB's
  **alternation** between the dispersion and the structure, where the dispersion is estimated once.
- **Ensembles, frames, point clouds** (FOF-CT, `.cndb`, several models of one map): a row holds
  one model. The scene's shape does not close the door.
- **A map beside a browser lead**: a companion needs a lead to follow, and a browser is not one
  yet.
- **A resolution picker for a binary g3d**: the finest opens; the others are named under the row.
- **Metadata columns as a colouring** and the Sequences card's ticks over the model: the key's
  chips and the haplotype solo cover the case a reader meets.

## 26. The interface's own grammar

Every section above governs one surface. This one governs what the surfaces have in common, and it
exists because the audit that produced it found the same drift in twenty places at once: six locus
boxes asking for the same thing in five phrasings, five ways of drawing a toggle that is on, three
spellings of a byte count, two coordinate conventions in two views of one genome. None of those is a
bug in the surface that has it. Each is a disagreement *between* surfaces, which is a thing no
section about one surface can see and no reviewer of one file can catch.

So the rules here are stated once and are binding on all of them. A new control that needs a look, a
word, a unit or a coordinate takes the one below; a surface that wants a different one changes this
section first.

### 26.1 Coordinates: three forms, and which is for a reader

A genome coordinate exists in exactly three forms in this application and they must never be
confused:

| Form | Grammar | Where it lives |
|---|---|---|
| **Machine** | cooler's: 0-based, half-open, ungrouped — `IV:1000000-1400000` | The session state, a `#`-hash link, `metacooler show --range`, every worker message, every file on disk |
| **Display** | 1-based inclusive, en-US grouping, plain hyphen — `IV:1,000,001-1,400,000` | Every character a reader sees: locus boxes, breadcrumbs, readouts, table cells, figure captions, tooltips |
| **Typed** | The display form, plus every spelling anyone writes it in | What a reader puts in a box |

The machine form cannot change: it is what a shared link has to keep meaning and what the reference
implementation takes. The display form cannot change either, because it is what IGV, UCSC, samtools,
Ensembl and every paper print, and a viewer that showed a locus a base off from the one a reader's
`bedtools` output names would be wrong in the way that is hardest to notice and worst to find.

**The law is the round trip.** A locus box shows the display form and accepts the typed form, so
pressing Enter on a value the box is already showing must not move the view by a base.
`typedLocusToRegion(regionLabel(r)) === r` for every region with coordinates, and
`test/unit/locus-display.test.ts` holds it. The helpers in `genome/assembly.ts` are the only
place any of this is written: `formatLocus` for a window, `formatPosition` for a single base or bin
start, `regionLabel` for a state string, `windowLabel` for the one crumb that hangs under the name it
would otherwise repeat, `typedLocusToRegion` for what was typed. A view that formats a coordinate
itself is a view that will drift.

The typed form takes what other browsers write, because a reader arrives by pasting: commas, `kb`
and `Mb`, an en dash, and Ensembl's `..`. A bare sequence name, a genome name, a gene name and `*`
have no coordinates and pass through untouched — as does anything the tokenizer refuses, so that a
refusal is about what the reader typed rather than about what a helper made of it.

**Copying is not displaying.** What the clipboard takes is 1-based inclusive and **ungrouped**, so it
pastes into a terminal, a spreadsheet or a BED-adjacent tool without separators to strip.

### 26.2 Units: one spelling of each quantity

`src/units.ts` holds the one formatter for every quantity the app prints, and it imports nothing —
no DOM, no `ui/` — so the annotations worker and the g3d parser print what the cards print.

- **Bytes are decimal**, in thousands: `18.1 MB`. Not because 1024s are wrong but because the
  operating system, the browser's download dialog and the file's own listing all show the reader
  1000s about the same file, and a viewer that called an 18.1 MB download `17.3 MB` was reporting a
  second size for it.
- **A bin size** takes `resolutionLabel`: `1 kb`, `12.5 kb`, `1 Mb` — trimmed, because a resolution
  is a round number by construction. **A measured span** takes `fmt.bp` and keeps its decimal:
  `400.0 kb` says it was measured to the hundred bases.
- **A setting about the matrix is not a span at all**: it is a count of bins, or of diagonals, and is
  printed as a count with `bins` or `diagonals` beside it (§18.2). An axis, a caption and a figure's
  own numbers stay spans — so the same run reads `50 bins` on its form and `2 Mb` on its lane.
- **A duration** takes `durationText`; **a finished-at time** takes `runClock`, local, six
  characters.
- A coordinate printed in full takes `fmt.pos`; a count takes `fmt.int`; a fraction takes `fmt.pct`.
- **A record card says which columns are the format's and which the file's.** On a metagenome the two
  sets overlap: `/genomes` guarantees `length`, `n_contigs` and `n_bins`, and a creator who joined a
  MAG-QC table in brings `Length`, `Contigs` and sixteen more — so the card listed every number
  twice with nothing to say why. Dropping the creator's copy would be wrong for the reason §5.1
  gives for keeping it in the table: a column somebody added is a column they meant, and the first
  time the two disagree the difference is the finding. So the card draws one quiet line between
  them, headed *joined in with the file*.
- **A table draws the same break in its header**, as a rule down the left of the first joined column
  (`ColumnDef.joined`), and gives each joined header the tooltip *joined in with the file, not part of
  the format*. Without it the header read `name length contigs bins Length GC-content …`: two columns
  of identical numbers, told apart by one capital letter, and no way to know which one a click was
  sorting by.

- **An axis is spelled by `axisNumber`, and a log axis is decades.** Past four decimal places a
  fixed-point tick stops being a number and becomes a run of zeros — a P(s) ordinate climbed to
  `0.0000001` and the slope beside it to eight zeros — so a tick that needs an exponent gets one. On
  a **log** axis every tick is a power of ten, so the moment one needs an exponent they all take it:
  an axis that reads `0.001`, `0.0001`, `1e-5`, `1e-6` changes notation halfway down itself. An
  abscissa in base pairs takes `fmt.bp` instead, so a P(s) reaching a megabase reads `1.00 Mb`
  rather than `1e6`, and an axis of **fractions** takes `fmt.pct` and says so in its own name —
  *Share of the sequence's contacts (%)* — so a cis fraction reads `93.3%` where the TSV under the
  figure holds `0.933`. That is the rule below applied to the surface rather than to the number, and
  the places are the tick's own: a whole per cent spends none of them.

- **A table cell is not a summary.** The Chromosomes table's `length` column prints `1,531,933` while
  the Sequences card beside it prints `1.53 Mb`, and both are right: a table holds the values a
  reader reads off exactly and copies out, so it groups the digits and keeps them all, while a
  summary line is a measurement and takes the unit. The rule is the surface, not the number — so a
  column of lengths is never rounded to `fmt.bp`, and a phrase about a span is never spelled out in
  full base pairs.

### 26.3 What a toggle looks like

**Lit means on. Plain means off. Nothing live is ever dimmed.**

The last clause is the one that was being broken: `.btn:disabled` is drawn by dimming, so a toggle
that dimmed itself when off was telling a reader who had learned "grey means you cannot" that a
track's eye was off and should be pressed. A control that is off is drawn exactly like a control
that has never been pressed, and the *lit* state is what carries the difference.

The state is read from the ARIA attribute the control already needs — `aria-pressed` for a toggle,
`aria-expanded` for a fold — so a toggle cannot be drawn without also being announced, and one rule
in `ui/styles.css` draws all of them. `test/unit/toggle-look.test.ts` holds the selector list and
refuses a second lit look. A toggle that has become unavailable is unavailable first: the lit rule
stands down for `:disabled`.

A **selection** is not a toggle. A chosen row, tile or folder carries a fill and a border and keeps
its text colour, because its text is content — a file's name — rather than a label. A toggle's whole
text is its label, so the label carries the state.

The rule cuts both ways: **a control with nothing to act on is dimmed.** An empty console offered
*copy*, *save* and *clear* at full strength — the first two would have written a file with nothing in
it, the third forgotten nothing — and a table greys its own *clear filters* when there is no filter
to clear. `disabled`, with the tooltip still saying what the control is for, so pointing at it
answers *why not*.

### 26.4 Words on controls

- **Button labels are lowercase** — `go`, `save`, `connect a folder` — except format names and proper
  nouns (`PDF`, `BEDPE`, `Google Drive`) and the zoom steps (`10×`). Field labels and select options
  too; a sub-head is written lowercase in the source and uppercased by the stylesheet, so one
  spelling survives a change of mind about the look.
- **One word per thing, app-wide.** A session in front of a reader is a **tab**. A stretch of DNA is
  a **sequence** in prose and a **chromosome** or **contig** only on the surfaces that report what a
  file itself calls it. A 1D dataset is a **track**. The occupants of the deck are **cells**; the map
  in one is a **map**. A file of beads is a **structure** and one set of its coordinates a **model**
  (§25.1). A reader **connects a folder** and **signs in to** a provider.
- **A hint is one sentence and never more.** No section numbers, no backticks, no Markdown, no
  naming of the module that implements it: a reader who needs `§18.6` is reading the wrong document.
  Where a group of controls shares a caveat, it is said once at the group rather than on each. Two
  kinds of line are not that hint and are not held to it: **a toggle** may add what its *off* state
  does, because that is a second fact and the control cannot show it (*"Track names, their value
  ranges and feature names. Off leaves the lines alone."*); and **an empty state** teaches the
  gesture that fills it, which is the only thing it is for. Nothing else gets a second sentence.
- **A hint carries a fact the control cannot show, or it does not exist.** What a number does to the
  result, what a unit means, what a mode refuses, what an empty answer means where that is not
  obvious, a consequence — *"Drops the near-diagonal, where unligated fragments dominate."* Restating
  the label, the options, the unit or the default is not a fact: a column of tick boxes that opens
  with every box ticked does not need a line saying every sequence is read, and a locus box does not
  need its own tooltip printed again underneath it. Both of those existed, on nine controls between
  them, and the line a reader learns to skip is the line that makes them skip the next one.
- **A shortcut is printed on the control that performs the action**, through `withKey` — a tooltip is
  read by someone already pointing at the thing, which is exactly when "is there a faster way" is
  asked. Never on a dead control: `No next genome (])` offers a key for a thing there is none of.
  A key whose glyph cannot be read at 11 px is printed as its name (`backtick`).

### 26.5 Colour means one thing each

`--danger` is a refusal and nothing else — never a price, never a caution, never emphasis. `--warn`
is "look at this before you trust it". `--ok` is a thing that finished. A **price** is `--text-dim`,
because a cost is a fact about what is being offered and not a warning about the answer. `--accent`
is what a reader can act on, and text set *in* an accent fill takes `--on-accent`.

### 26.6 One shape per job

- **A locus box** is built by `SearchBox` and its placeholder by `locusPlaceholder`, whose example is
  taken from the assembly in front of the reader rather than from a genome they may not have open —
  never `__unbinned__`, which §7.4 refuses to draw at any resolution.
- **A placeholder that lists what a box takes is cut to the box, clause by clause**, by
  `fitPlaceholder`: the clauses come off the end until what is left fits, the example always
  survives, and the offer in full is the box's tooltip. An input clips its placeholder with no
  ellipsis and reports no overflow, so `I:1,000-20,000, a sequence, a ge` in a 336-pixel bar looked
  like a bug and hid the clause a reader had not already guessed.
- **A navigation bar** is `[title] [‹ ›] [box] [go] [⊖10× ⊖3× ⊕3× ⊕10×] [bookmark]`, and the zoom
  steps come from `RegionView`'s own pair so the map's bar and the browser's are the same control
  over two pictures of one genome.
- **An export row** is `[resolution] [format] [⭳] [⧉]` with a line under it, built by
  `ui/exportRow.ts`; a card with no resolution to offer omits it and one that writes a file rather
  than a picture omits the clipboard. Data leaves by a bordered button named for its format.
- **A stepper** is `‹ ›` with the neighbour's name in the tooltip and `[` / `]` beside it.
- **A label and its dropdown share a line.** In a panel card the label column is 4.6rem — the width
  of the longest label in those cards, `clip (log10)` — which leaves every dropdown 97 pixels, enough
  for every option any of them offers. The line under the label is kept for a control that is not one
  dropdown — a row of icon toggles, a pair of clip boxes — and for a select whose options are not
  *words*: a **name out of a file** (`Yeast_structure`) or a **phrase** (`the same everywhere`),
  neither of which fits 97 pixels and neither of which can be shortened, since one belongs to the
  file and the other is the sentence the setting is. That is the 3D card, and it keeps the shape for
  all four of its selects rather than for two — the rule that matters is that a card does not hold
  both shapes. The Map card used to hold `score` above its select and `smooth`, `transform` and
  `colours` beside theirs, which is two shapes for one kind of question; the fix was the label
  column, not the row.
- **Every block in the General column is a card** with a `cardTitle`, so the column folds the way the
  other four do.
- **A dialog's heading is the category it is, uppercased by the stylesheet — unless it is a name.**
  A head carrying something out of a file (the enlarged cell's structure, the `.pairs` file being
  binned) keeps the file's own spelling through `titleIsName`: in genomics a name whose case has been
  changed is a different name, and `YEAST_STRUCTURE` over a card, a tab and a Structures row all
  reading `Yeast_structure` was four names for one file.
- **The picture is never the thing that gives way.** The side columns may be squeezed to their own
  minimum widths when the window cannot hold them all, and `.content` keeps a floor of 18rem: four
  columns at their widths come to about 1,180 pixels, so on a 1366-wide laptop with all four open the
  map used to be left 140 of them, with the reader's own locus cut to `IV:1,00`. A column has a
  folded tab to come back from; a map that thin has nothing. Below about 1,170 pixels the outermost
  column leans off the right edge, which is the one shape this trade cannot avoid.
- **A column's minimum width is a promise its cards still work at it.** Aesthetics' was 200 pixels,
  at which its two clip limits read `-4.1` and its selects cut `log10`; General's was 200, at which
  the File card's values had forty pixels — so both went up to 240 rather than the cards being made
  to fit a width nothing survives. Within a card the **keys** give way before the values: a long key
  over two lines is two words, while a grouped count broken across two lines is misread.
- **A list of regions is split by `splitRegionList`, never by `split(',')`.** Coordinates carry
  thousands separators, so the box that takes several sequences has two meanings for one character:
  a comma is part of a number when a digit is on its left and exactly three digits are on its right,
  and separates otherwise. `I, II` and `1,2` are two regions each; `IV:1,000,001-1,400,000` is one.
- **A floating surface takes `--shadow-2`** (or `--shadow-up` where it rises out of an edge), never a
  literal `box-shadow`: an ink-black shadow is invisible on the dark theme, which is what the token
  exists to answer.

### 26.7 The words for a state

A thing that can run says exactly one of: **never run**, **queued**, **running**, **done**,
**failed**, **cancelled**, or **reading…** while it fetches. No surface invents a seventh.
