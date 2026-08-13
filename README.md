# metacooler-viewer

A browser-based viewer for [`.metacool`](https://github.com/js2264/metacooler) multi-genome
(metagenomic) Hi-C contact maps — and for `.cool`, `.mcool` and `.hic`, which open the same way and
behave the same once open.

Drop a file on the page and you get a sortable table of every MAG in it, the intra-genome contact
map of any one of them, and — the part no other browser does — the rectangular off-diagonal block
between *two* MAGs, which is where phage–host, plasmid–host and HGT signal lives.

Several files at once, as tabs. Two coolers in one square, split on the diagonal, when the question
is how they differ. And a plain 1D genome browser for when there is no contact map at all — a
`chrom.sizes`, a bigWig or a FASTA is enough to start one, and dropping a `.cool` on it turns the
same tab into its map. Tick a few chromosomes and the axis becomes those chromosomes; open a FASTA
and the sequence is a lane of its own, GC content zoomed out and the bases themselves zoomed in.

And then the analysis. An **Analysis** panel — the fourth panel, outermost on the right, `j` — lists fourteen tasks:
P(s), coverage, diamond insulation, virtual 4C, compartments with their saddle, metaplots and APA
with bootstrap confidence bands, loop ranking, track correlation, interval overlap, and four that
only a metagenome has — per-MAG contact QC, contig-level contamination calls, chimera detection and
the inter-MAG network. Each runs in a worker of its own, so the map stays live and pannable while a
whole-file scan is running. Results land in a resizable drawer, and every one of them exports:
bigWig for a signal, bedGraph, BED, TSV, PNG, and true vector PDF. The bigWig is written here, byte
by byte — no `bedGraphToBigWig` step, because a bigWig is what you actually wanted.

`.hic` is read here too, at versions 7, 8 and 9 — which is most of the published mammalian Hi-C on
4DN, ENCODE and GEO. It costs no constraint: the format is block-indexed, so a region is a bounded
range read through the same byte layer as everything else, and a block is an *index* unit rather than
a tile — nothing is composited, and a read still hands up one whole bounded matrix. Its resolution
ladder becomes the same entry list an `.mcool`'s is, so the picker, the hash, the zoom ladder and the
deck all work on one with no code of their own.

There is no server. There is no upload. There is no preprocessing step. A file straight out of
`metacooler create` opens and works.

---

## The three constraints, and why they are the whole design

Everything below follows from these. They are stated first because most of what this project does
*not* do is a direct consequence of them.

**No backend of any kind.** No tile server, no metacooler process on a host, no accounts. The
viewer is static files; the data are objects on a bucket, or a file on your disk. This is what makes
the app free to run, free to archive, and impossible to take offline.

**Nothing is uploaded.** A local file is handed to a worker by reference and read in place through
the Emscripten filesystem. Nothing crosses the network, which is why there is no account system, no
storage, no hosting cost and nothing to review for GDPR. You can open unpublished patient-derived
metagenomes on a laptop with the network cable out.

**No preprocessing, and no companion file is ever required.** Two optimisations exist — a `zoomify`
resolution ladder and a genome-level edge list from `metacooler network` — and both are strictly
opportunistic. A plain `.metacool` behaves identically, minus the extra speed.

The architectural bet that makes all three affordable is that **MAGs are small**. A bacterial genome
is 2–6 Mb, so at 1–5 kb bins a single MAG's matrix is at most a few million cells and its non-zero
pixels are a bounded, contiguous slice of `/pixels`. One genome is therefore *one bounded read*,
held whole in memory, after which pan and zoom are pure canvas transforms with **zero** further I/O.
That is the central difference from HiGlass, which has to stream a 3 Gb genome and needs a tile
server, a tile cache and a tile compositor to do it. None of that is built here, because none of it
is warranted.

**Zooming does sharpen the picture, though** — the one thing on that list that turned out to be
worth having. A whole chromosome, or a whole genome of a cooler, is larger than any screen and
arrives already coarsened; zooming into it and having nothing happen is not the interaction anybody
has in their hands. So a zoom that settles past what the block in hand can show reads that window
again, at the grid the picture could show. It is still one bounded read drawn whole — no tiles, no
compositing — and it stops at the file's own bins, which for a MAG means it never starts. Two or
three blocks are kept so that zooming back out is a swap rather than a request. **Off by default** —
a zoom that reads is a zoom that can wait, and §2's promise is that it does not — and one press away
on the map's own controls, beside the 45° turn and the O/E baseline.

Two things break the small-MAG assumption, and both are handled as exceptions rather than as the
general case: `__unbinned__` (never displayable) and non-metagenomic coolers (region level only).
Both are covered under [Scope](#scope-what-this-is-not) below.

---

## Running it

### Node on this machine

Node is not on the system `PATH` here. Put it there first:

```bash
export PATH=/pasteur/helix/users/jaseriza/opt/node-v24.18.1-linux-x64/bin:$PATH
node --version   # v24.18.1, npm 11.16
```

`node_modules/` is already installed — **do not run `npm install`**.

> **Known limitation of this host.** `vite` and `vitest` both load `rollup`, whose native binary
> (`@rollup/rollup-linux-x64-gnu`) requires `GLIBC_2.29`; this machine has glibc 2.28, so
> `npm run dev` and `npm test` cannot start here. `npm run typecheck` and `npm run fixtures` are
> unaffected. Everything runs normally on any host with glibc ≥ 2.29.

### Commands

```bash
npm run dev        # vite dev server; open the printed URL and drop a file on the page
npm run build      # tsc --noEmit && vite build  →  dist/
npm run build:cli  # the analysis CLI            →  dist-cli/metacooler-run.mjs
npm run build:standalone   # one self-contained page  →  dist-standalone/index.html
npm run preview    # serve the built dist/ locally
npm run typecheck  # tsc --noEmit
npm test           # vitest run
npm run fixtures   # regenerate test/fixtures/ and test/golden/
```

### One HTML file

`npm run build:standalone` produces a single `index.html` — the whole viewer,
h5wasm included, with every script, stylesheet, worker and icon inlined. It has
no server and no install: put it on a USB stick, email it, open it by
double-clicking, drop a file on it.

It is also attached to every [release](https://github.com/js2264/metacooler.js/releases)
as `metacooler-viewer-<tag>.html`, so nobody has to build it.

What it is for is the machine the hosted app cannot reach: an air-gapped
cluster, a reviewer who will not install anything, a laptop holding unpublished
patient data whose owner would rather not take anybody's word about what gets
uploaded. Nothing is uploaded from any build of this app, but this is the one
where that is *visible* — there is no origin to upload to.

The cost is the honest one. A page opened from a disk has an opaque origin, so
**local files only**: remote URLs, the example datasets and the version picker
are all absent, not broken. It is about 11 MB, four fifths of it the HDF5
runtime, parsed on every open with no HTTP cache behind it — roughly a second
before the page paints. Verified in Chromium; Firefox and Safari are untested.
Every browser profile on a machine shares one `file://` origin, so its saved
sessions are shared with any other `file://` page — which matters only if you
open somebody else's.

### The analysis from a shell

The fourteen tasks are reachable without the panel, over as many files as you
like, through the same kernels and the same writers:

```bash
npm run build:cli
node dist-cli/metacooler-run.mjs tasks
node dist-cli/metacooler-run.mjs insulation *.mcool --window chrII --out results/
node dist-cli/metacooler-run.mjs replay session.metacooler.json --over 'data/*.hic'
```

`replay` takes the session file **Save** and **Share** already produce and
re-runs the analyses in it, with the parameters in it, over other files —
parameters chosen by looking at a picture, applied to the other hundred and
ninety-nine without retyping. Local files only: the reader's range requests are
synchronous and exist in a worker rather than in Node.

`npm run fixtures` shells out to Python and needs an interpreter with `metacooler` installed:

```bash
METACOOLER_PYTHON=/pasteur/helix/users/jaseriza/repos/metacooler/.venv/bin/python npm run fixtures
```

It uses **only** the public `metacooler` and `cooler` CLIs — no hand-written HDF5 — and then exports
one golden JSON per fixture straight out of the Python API. `test/fixtures/` is generated and
gitignored; `test/golden/` is committed, so a `metacooler` upgrade that changes the format fails at
the golden boundary rather than somewhere in the middle of the app.

Large real-world files live in `data/` and are gitignored. Tests that need them
(`test/unit/real-file.test.ts`) skip with a named message when they are absent.

---

## Repository layout

```
src/
  types.ts constants.ts errors.ts format.ts uri.ts   # the shared contract
  sources/       ByteSource implementations: LocalFileSource, RemoteRangeSource
  h5/            the only code that imports h5wasm or touches raw HDF5 bytes
  metacooler/    the reader: detect, MetaCooler, coords, range, matrix, aggregate,
                 and store.ts — the PixelStore seam the two containers meet at
  hic/           the only code that knows what a .hic looks like on disk: the
                 header and footer, the block index and its two numbering
                 schemes, and the cooler-shaped handle that hides all of it
  genome/        an assembly with no matrix behind it, and its one axis
  worker/        message protocol; the worker owns all I/O
  render/        canvas heatmap, matplotlib LUTs, colour scale, colourbar, the
                 diagonal blend for two files, the 1D browser's ruler and arcs
  state/         ViewState and its URL-hash serialisation
  ui/            file picker, genomes/contigs tables, genome/pair/region views,
                 the 1D browser, its vector-PDF page, errors
  annotations/   the tracks and annotations layer: parsers, store, and their own worker
  analysis/      the fourteen tasks (§18): descriptors, pure kernels, a worker of its
                 own, the run/ adapters that walk pixels, and write/ — TSV, bedGraph
                 and a bigWig writer with no dependency behind it
  app/           App (the window, the tabs, the address bar) and Session (one file)
  main.ts        three lines of bootstrap
scripts/
  make_fixtures.py  make_golden.py  make_analysis_golden.py  gen_luts.py
test/
  fixtures/ (generated)   golden/ (committed)   unit/
docs/
  hosting.md     bucket configuration for published files
  deploy.md      publishing the app itself to GitHub Pages
SPECS.md         the specification — section numbers are cited throughout the source
IMPLEMENTATION.md  the build plan, and nine corrections where the docs were wrong
TASKS_PLAN.md    the build plan for §18, the Analysis panel
```

Three layering rules are enforced rather than encouraged, because breaking any of them is silent:

- **`h5wasm` is imported only under `src/h5/`.** That is what makes the local and remote paths
  identical everywhere downstream.
- **`@gmod/bbi` is imported only by the annotations worker.** Same rule, same reason: no file parser
  belongs in the main-thread bundle, and the demo GTF alone is ~310 ms of parsing.
- **No coordinate ever comes from `/bins`.** With fixed bins the entire coordinate model is
  arithmetic over `indexes/chrom_offset` and `contigs/length`, so one of the four large tables in the
  file is never touched — not on open, not per view, not over the network.
  `test/unit/real-file.test.ts` records every dataset path the reader touches while loading a MAG and
  fails if `/bins` appears. There is exactly one read of it in the whole reader: two bounded slices of
  `/bins/weight`, for the bins on screen, and only when balancing was asked for (§6.4).
  `test/unit/bins-guard.test.ts` proves the rule for every other path.

---

## What is implemented today

Read against the milestones in `IMPLEMENTATION.md`. This section describes the code that is on disk,
not the plan.

| | Milestone | State |
|---|---|---|
| M0 | Fixtures and golden oracles | **done** — 13 fixtures, 13 goldens + manifest, regenerated by one command |
| M1 | Reader core, headless | **done** — URI parsing, detection and acceptance gates, `MetaCooler`, fixed-bin coordinates, extents, range parsing |
| M2 | Matrix queries | **done** — bounded reads, dense-size guard, COO → dense, transpose handling, contig/genome roll-up |
| M3 | Render and first visible app | **done** — canvas heatmap with matplotlib's own LUTs, `metacooler show` defaults, genomes table, genome/pair/region views, breadcrumb, URL-hash state |
| M4 | Interaction | **done** — pan, zoom, level toggle and cross-navigation; a gesture still costs nothing, and a *settled* zoom past the block's own grid reads the window again (`src/ui/refine.ts`). The mmetacool and mcool resolution ladders are wired to it: a coarse read comes from the coarsest rung whose bins still fill a cell, which is fewer pixels for the same picture and the only honest way to draw a balanced map at a coarse grid |
| M5 | Remote sources | **done** — `RemoteRangeSource` (range probe, LRU chunk cache, the two distinct §10 refusals), `docs/hosting.md`, and the §12 request-budget regression tests in `test/budgets/` |
| M6 | bigWig tracks | **done, and wider than the milestone** — `src/annotations/` reads bigWig (`@gmod/bbi` v10), GTF/GFF, BED/narrowPeak/broadPeak/BED12, BEDPE and FASTA in a worker of their own; `src/render/` draws them as lanes on any of the map’s four edges and as overlays on it; three sidebar cards drive them. Restricted to cool/mcool (§8.5) |
| M7 | cool / mcool | **done** — opened natively, not as a synthesised one-genome metacool: a cooler's `/chroms` is the contig table, `genomes` is `null`, and its chromosomes are the landing view. Genome-wide is a first-class view whenever the size estimate says this machine can hold it (a yeast genome at 1 kb is 12,100 bins and opens in one read); balancing from `/bins/weight` is wired to a toggle. An `.mcool` root is refused by name and the app opens its finest resolution |
| M8 | Catalog, deploy, benchmarks | **partly** — a GitHub Pages workflow builds and publishes the app (`docs/deploy.md`); no `scripts/make_catalog.py` and no benchmarks |
| — | Sessions, comparison, 1D browser | **done** — tabs with a worker each (§5.6); a second cooler in the lower-left triangle, split on the matrix diagonal (§5.7); and a genome browser that needs no map at all, entered from a `chrom.sizes`, a bigWig, a bigBed, a FASTA or a feature file (§5.8) |
| — | Metadata annotations (§8.12) | **done** — the columns a file already carries about its own genomes, sequences and bins, discovered from its `/genomes`, `/contigs` and `/bins` tables and drawn as lanes beside the map: bars for a measurement, runs of colour for a set of labels. Indexed by the map's own cells rather than by base pairs, so a MAG's completeness draws on a genome × genome overview where no other lane can — and offered only where its own table is no finer than the axis. The one annotation a `.metacool` gets, since a column of its own tables cannot be matched to the wrong sequence |
| — | Analysis (§18) | **done** — every task in `TASKS_PLAN.md`'s catalogue, in a fourth worker so a whole-file scan never blocks the view; a resizable drawer; results that come back as synthetic tracks in the Annotations panel, indistinguishable from a loaded bigWig; and a bigWig writer of this repo's own. Goldened against cooltools, coolpuppy, pyBigWig and numpy on the demo micro-C map |

Other gaps worth naming rather than discovering:

- **The genome × genome overview does not refine.** Everything else does — a region, a genome, a
  pair, a whole file, and every panel of a deck — but the overview's axes are genomes or contigs
  rather than positions, so a cell there *is* a sequence and there is no finer grid under it. The
  entry picker also stays: a ladder is now driven by the zoom, and a reader who picks a rung by hand
  has still said something the zoom does not overrule.
- **The genome × genome overview** is implemented and correctly gated (explicit action, progress,
  cancellable; refused over HTTP above a size threshold; instant when a `metacooler network
  --level genome` edge list is advertised), but has not been exercised end-to-end on a large remote
  file.

Tests currently live in `test/unit/`: `reader-core`, `render`, `viewstate`, `real-file`,
`mmetacool`, and — for §8 — `annotation-parse`, `annotation-store`, `locus-axis` and `track-lanes`.
The annotation parsers are run against the *published demo files* rather than against three lines
written to pass: a real Ensembl GTF, two real MACS narrowPeaks and a real loop table. The §18
kernels have a file each (`analysis-insulation`, `analysis-apa`, `analysis-compartments`, …), and
`bigwig-write` reads every file it writes back with `@gmod/bbi` — the same library the app reads
other people's bigWigs with — then walks the B+ tree byte by byte, because no reader in existence
checks an internal node's keys and a wrong one is invisible until someone else's tool opens the file.

---

## Scope: what this is *not*

Every item here is a decision that removed code, not a feature that ran out of time.

**Fixed-bin files only.** `bin-type = "variable"` — fragment-level and contig-level metacools — is
refused at open, with a message naming the file's actual bin type and pointing at
`metacooler binnify`. Excluding variable bins is what makes the coordinate model pure arithmetic and
what deletes every read of `/bins`.

**`contig-ordering = genome-then-length` only.** Any other ordering is refused, naming the ordering
the file actually has. Only a genome-grouped layout puts each genome in one contiguous block of
bins, which is what makes a genome — or a genome *pair* — a single bounded read. The known cost is
real: files built from a cooler (`cool` ordering) or from a FASTA-ordered assembly are excluded.

**`__unbinned__` is never displayable.** The reserved genome holding every contig that binning
failed to assign is not a genome, and it breaks the small-MAG assumption outright. It is absent from
the genomes table with no toggle, not selectable as either axis of a pair, and refused as a range
label with its own message rather than a generic "unknown name". It is matched by **name**, never by
index, because `create --drop-unassigned` omits the row entirely and makes genome 0 an ordinary MAG
in exactly the files that were binned best.

Nothing is renumbered to make it disappear: `genome_id`, `genome_offset` and every bin index stay
exactly as written, and exclusion happens at selection and display time only. The single exception
is one read-only QC statistic in the file info panel — *"unassigned: 67,058 contigs / 23.8% of
bins"* — because that fraction is a direct diagnostic of binning quality that a metagenomics reader
will look for. It is a number, not a view: it opens nothing and selects nothing.

**Annotations are for one assembly at a time.** Gene models, tracks, peak sets, loop calls and
hand-drawn marks are offered on a cooler — and on a genome opened with no map at all — and are
*absent*, not disabled, on a `.metacool`. A metagenome's axis is contigs from thousands of
independently assembled organisms, so a file keyed on contig names either coincides with it or
misleads, and a gene model drawn across a MAG boundary would assert a coordinate system that does not
exist. See SPECS §8.5.

**Two files compared, not N.** The second map goes in the half of the square the first one was
mirroring, and there is no third half. It must be a cooler with the same chromosomes and the same bin
size, because every coordinate in the picture is an index into one list of sequences and one grid
cannot be two resolutions. Same chromosomes, not the same *spellings* — see below. SPECS §5.7.

**Nomenclature is not a compatibility problem.** `chr1`, `1`, `01`, `I` and `NC_000001.11` are the
same chromosome, and files that name it differently open side by side, navigate as one deck and take
each other's tracks. `chrM`, `MT` and `MtDNA` are one mitochondrion; `chrXII` is `12`;
`chrUn_GL000220v1` is `GL000220.1`. What it will not do is guess: `2L` is not `2`, a `NODE_1` out of
an assembler is nobody's chromosome one, and where the two files also disagree about a sequence's
*length* the match is reported rather than taken quietly — hg19's `chrM` and hg38's `chrM` are one
name and two sequences. There is no alias table to download and no assembly to declare; `X` is read
as the tenth chromosome or as the sex chromosome according to what else is in the file. SPECS §5.9.

**cool and mcool are whole-genome only where it fits, and this is not a HiGlass replacement.** The
entry point is the contigs table; a `chrom:start-end` selection loads through the same bounded-read
path as a MAG; and the whole matrix is a view of its own whenever a size estimate against
`navigator.deviceMemory` says this machine can hold it — a yeast genome at 1 kb is 12,100 bins and
opens in one read, human chr1 at 5 kb does not. Anything larger than the picture is coarsened in the
*read* rather than refused, and a zoom sharpens it back down to the file's own bins. What is still
not built is the thing that makes HiGlass HiGlass: no tile server, no tiles, no picture assembled
out of parts, and so no view of a 3 Gb genome. The claim is zero-install inspection of any cooler
that fits, **plus** a genome hierarchy HiGlass has no concept of — not a general Hi-C browser.

### Non-features

Stated as decisions so they are not mistaken for omissions: no tile server; no tiles and no picture
assembled out of parts; no user accounts; no file upload; no server-side computation of any kind; no
required companion files; no required preprocessing; no support for orderings other than
`genome-then-length`; no whole-genome view that does not fit in memory (the limit is measured, not a
category — see SPECS §9); **no write access of any kind** — the viewer never modifies a file it
opened.

That last one is worth spelling out now that the app writes bigWigs. It has always *produced* files
— a PNG, a PDF, a BED of hand-drawn marks, a saved session — and a bigWig is one more of them: new
bytes handed to the browser as a download, needing no server, touching nothing that was opened. The
line is between authoring an output and editing an input, and only the second is refused. Which is
also why there is **no writing of `.cool`, `.mcool` or `.metacool`**: h5wasm could create one, so
that is a decision and not a limitation. Three more arrive with the analysis panel, for the reasons
given in SPECS §18.9: no loop or dot calling, no contact-based contig reordering or scaffolding, and
no differential APA.

---

## Correctness

The reader is a mirror of the Python `MetaCooler`: same names, same semantics, same error text.
Where this repo and `metacooler/api.py` disagree, this repo is wrong.

That is enforced rather than asserted. `scripts/make_golden.py` exports, from Python, the `info`
block, both tables, all three index arrays, every genome extent, a battery of range strings
including the error cases, thirteen dense matrices at bin/contig/genome level, and
`pixels_for_genome_pair` records — and **exact integer equality is the bar** for anything derived
from counts. Two failure modes justify that on their own: the upper-triangular transpose (get it
wrong and every inter-genome panel is silently blank), and the aggregation fold (get it wrong and
every contig-level diagonal is silently doubled, which reads as "the diagonal is strong" rather
than as a bug).

`test/unit/real-file.test.ts` adds the check that fixtures cannot make: it opens a real 26 MB,
4,395-MAG MetaTOR output and asserts numbers that were read out of the file with `h5py` before any
of this code existed.

**The analysis has goldens of its own**, on the same principle and against different tools.
`scripts/make_analysis_golden.py` (`npm run fixtures:analysis`) builds eight of them from
`demo/yeast/Yeast_microC_G2M_1kb.cool` — a real 1 kb micro-C map, the one the app opens in the demo —
using **cooltools**, **coolpuppy**, **pyBigWig** and **numpy**, and `test/unit/analysis-golden.test.ts`
runs the kernels against them.

Each golden carries two oracles, and the split is the design rather than a convenience. `direct` is
this repo's own definition recomputed in numpy and is compared to **equality**: it is what catches a
transposed index or a doubled diagonal. `reference` is the other tool's number under *its* definition,
compared to whatever relation actually holds — and three of those relations are exact:

- **P(s)** equals cooltools' `expected_cis` cell for cell, once cooltools is told not to mask the
  first two offsets. The mirrored dense block doubles both the sum and the count, and the mean is
  what survives.
- **Coverage** satisfies `cooltools_cis == ours + diagonal`, exactly. cooltools sums the pixel table
  by both ends so a diagonal pixel counts twice; this repo counts it once, deliberately, and the
  identity is the proof that the difference is the one intended and not an off-by-something.
- **APA** equals coolpuppy's pileup, once the loops whose window would cross the main diagonal are
  left out. With them in the two differ by about 1 %, and every differing cell is below the diagonal.

**Insulation is not one of them, and the golden says so in five clauses.** cooltools' diamond is
offset by a row, drops the first two diagonals, divides by a count of valid positions, normalises by
the region median rather than the contig mean, and masks positions near a dropped bin. Both are
published definitions of the same thing; what is left between them is a correlation of 0.61–0.85 on
this dataset, and the golden records the measured value per chromosome and window so the test can
assert the correspondence has not degraded rather than pretend to an equality that was never true.

---

## Documents

- `SPECS.md` — the specification. Source files cite its section numbers (§3.3, §7.4, …) at the
  points where a decision is not obvious from the code.
- `IMPLEMENTATION.md` — the build plan, plus nine corrections where the metacooler documentation
  disagreed with the metacooler source. Those corrections are load-bearing; the one most likely to
  be re-broken is that `bin-size` can be the *string* `"null"`, so it must go through a verbatim
  port of Python's `_int_attr` rather than `Number()`.
- `TASKS_PLAN.md` — the build plan for the Analysis panel and drawer (SPECS §18): the task model, the
  worker that keeps the map live while a job runs, the native bigWig writer with its byte layout
  written out, the catalogue of tasks, and the goldens each of them has to match. Its milestones
  carry a *Changed during the build* note wherever the code diverged from the plan, which is most of
  what a reader of both documents needs.
- `docs/hosting.md` — the bucket configuration a published `.metacool` needs, and why GEO and SRA
  cannot serve as hosts.
- `docs/deploy.md` — how the site is built and published, how it works offline, how past builds
  stay reachable, and how a release is cut.
- `CHANGELOG.md` — what changed between versions. The running build names itself in
  **About → version**: version, commit and commit date — and the dropdown under it runs any of the
  recent builds at `…/v/<commit>/`, or any tagged release, permanently, at `…/v/v0.5.1/`. Useful
  when a figure came out differently last month, and the release URL is the one to cite; not
  available in the desktop app, which is versioned by being installed.

## Licence

MIT.
