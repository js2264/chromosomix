# metacooler-viewer

A unified genome browser for `.*cool`, `.scool`, `.hic`, `.pairs`, HiC-Pro, and other similar formats, 
and other genome-wide data formats like bigWig, bedGraph, GTF, FASTA, BAM and VCF. 
It is a single-page application that runs entirely in the browser, with no 
server-side processing or data upload.

## Main features 

- Serverless: There is no upload, no required preprocessing step, no backend of any kind. The viewer is static files, and reads data directly from standard genome-wide formats. 
- Support 1D genomic formats: bigWig, BED, bedGraph, GTF, FASTA, BAM, VCF, chrom.sizes, ...
- Support 2D genomic formats: `.*cool`, `.hic`, HiC-Pro, `pairs(.gz)`, ..., with resolution ladder and on-the-fly balancing.
- Dedicated Analysis panel, with exportable results: 
  - for common 1D analysis tasks: metaplots, track correlation, interval overlap, ...
  - for common 2D analysis tasks: P(s), diamond insulation, coverage, virtual 4C, compartments annotation and saddle plot, loops and borders detection, APA, loop ranking, ...
- Dedicated Annotations panel, supporting linear tracks, 1D and 2D manual annotations, bookmarks and synthetic annotations.
- Dedicated Aesthetics panel: to customize scales, color map, normalization, track layout, grouping, ...
- Tabbed sessions: Several genomes opened at once, as tabs. 
- Synchronized navigation across contact maps: Open two contact maps and pan and zoom them together.
- Adaptative resolution: The viewer automatically chooses the best resolution that can be displayed based on the current zoom level. Genome-wide views are automatically coarsened to fit the screen, and zooming in refines the resolution.
- Cloud-based file access: Open files directly from local files, S3 buckets or any HTTP(S) server that supports range requests.
- CLI-based analysis: The same analysis tasks available in the Analysis panel can be run from a command line, with the same parameters and producing the same results.

## Philosophy

1. **No backend of any kind.** No tile server, no specific process on a host, no accounts. The viewer is static files; the data are objects on a bucket, or a file on your disk. This is what makes the app free to run and free to archive.

1. **Nothing is uploaded.** A local file is handed to an air-gapped worker by reference and read in place through the Emscripten filesystem. Nothing crosses the network, which is why there is no account system, no storage, no hosting cost and nothing to review for GDPR. You can open unpublished patient-derived
genomic data on a laptop with the network cable out.

1. **No pre-parsing of genomic files is required.** Contact maps and 1D genomic files are read in bounded reads, and the rest is pure canvas transforms with **zero** further I/O. That is the central difference from HiGlass, which needs a tile server, a tile cache and a tile compositor to stream contact maps. 

**`.scool` opens as what it is: a few thousand single cells over one shared bin space.** A **Cells**
table lands first — every cell in the file, sortable by the depth its own attributes record, filterable
by name — and a click opens one cell's map. Tick several and they are **added together**, because
every cell here indexes the same bins, so a set of them is one map with their contacts summed: the
thing that turns a sparse single-cell matrix into a readable one. Tick all of them and you have the
pseudo-bulk — and while it adds them up it says how far it has got, because summing four thousand
cells is four thousand reads and a spinner would not be honest about that. The chosen cells stay
chosen as you walk into a chromosome and back out, and they travel in the link. Both layouts open — the standard `/cells` container `cooler` writes, and the flat one
every pre-2021 tool produced.

Opening one over the network is one of the two places this viewer asks a question first, and it says
why: a container's cell names live in HDF5 link records that writers scatter across the whole file,
so there is no bounded read that reaches them. Download it once, or read it in a thousand small
pieces — both costs are on the buttons, and a copy on your own disk has neither.

**A HiC-Pro map opens as the pair of text files it is.** Drop the `.matrix` and the `_abs.bed`
together, or pick the matrix out of a connected folder and its bin file comes with it, or give a URL
and the bin file beside it is found where HiC-Pro writes it. The BED is the coordinate system and the
matrix is the pixels, so between them they are an ordinary contact map — the chromosome table, every
region, the analysis panel, tracks and export, all of it. All four `MATRIX_FORMAT` variants open, the
`iced/` matrices included.

It has no index, and it is the one format here that cannot have one, so the whole matrix is read at
open — about a second per hundred megabytes, with a bar that counts the bytes coming across and then
the pixels coming out, and a cancel if you change your mind — and after that it *is* a cooler: every
region instant, panning free. Past a couple of hundred megabytes you are told that before it happens, and told the
cost is paid once. Fine-resolution human maps are better converted, and the panel says how:
`cooler load -f coo` turns the same two files into a `.cool`.

There is no server. There is no upload. There is no preprocessing step. A file straight out of
`metacooler create` opens and works.

1. **A `.pairs` file is imported, not merely opened.** Everything above is a matrix — the thing a pipeline produces at its end. What is on disk after running one is a list of contacts, with no grid in it, and turning it into something openable used to mean leaving for `cooler cload` or `metacooler create pairs` first. Now you drop it, pick a base resolution and how many ladder rungs you want, and the file is read **once**: every rung is built in that pass, and every view afterwards costs no I/O at all. Plain, gzipped or bgzipped; a `pairix` `.px2` beside it makes the cost known before the read starts, and its absence changes nothing except that the whole file is read. The input is gigabytes and the output is tens of megabytes — yeast Micro-C is 179 M records and 13.7 M stored pixels at 1 kb — so you pay for the file once and answer from memory afterwards. `demo/ecoli/SRR19500734.pairs.gz` is 238 MB and 17.7 M records, and imports in about forty seconds.

   How long that takes is decided mostly by **how the file was bgzipped**, which is worth knowing because you can change it: a `.pairs.gz` is a sequence of independently compressed blocks, and a deflate block costs about the same to start whether it holds 1 KB or 64 KB. That E. coli file is framed in ~1.4 KB blocks — 165,000 of them — and runs at 0.12 M records/s; the same records at the 64 KB blocks `bgzip` writes by default run at 0.69 M records/s. If a file feels slow, re-block it:

   ```sh
   bgzip -d < slow.pairs.gz | bgzip > fast.pairs.gz   # ~5x, on a file framed finely
   ```

1. **The `.mcool` is written back out, and downloads when it is ready.** Every rung, as a real cooler, with the pairs header carried verbatim in `metadata` and raw counts that say `unbalanced` so nobody mistakes them for balanced ones. It is the one file this viewer writes that another tool reads as a *format* rather than as a picture, and the [spec](SPECS.md) says at §18.9 exactly which refusal that narrowed and what it was checked against. What it is not is a `.metacool`: `#chromsize:` has no concept of a genome, so an imported map has chromosomes and no MAG layer — `metacooler create pairs` still wants the contig and genome tables for that.

## Using metacooler.js

### Install as a PWA (Progressive Web App)

Use your favorite browser to go to [https://js2264.github.io/metacooler.js](https://js2264.github.io/metacooler.js) and: 

- On **Chrome** or **Edge**: click on the **Install** in the URL bar (far right button). 
- On **Safari**: click on **Share → Add to Dock**.
- On **Firefox**: support to be added soon. 

The app is then available offline as a desktop app as a PWA (Progressive Web App).

### Install as a desktop app

To install the app as a desktop app, you can fetch the latest release from [https://github.com/js2264/metacooler.js/releases](https://github.com/js2264/metacooler.js/releases). Builds are available for Linux, macOS and Windows. The app is then available offline as a desktop app.

### Install with Node, from a local machine

Node needs to be installed on the local machine.

```bash
node --version
```

Then the repository can be cloned and the dependencies installed:

```bash
git clone js2264/metacooler.js
cd metacooler.js
npm install
npm run dev
```

### From a static HTML file

`npm run build:standalone` produces a single `index.html` (roughly 12Mb). It has
no server and no install: put it on a USB stick, email it, open it by
double-clicking and you end up with a fully functional genome browser.

It is attached to every [release](https://github.com/js2264/metacooler.js/releases)
as `metacooler-viewer-<tag>.html`.

## Embedding metacooler.js in a page

A minimal version of the viewer can be added to any HTML page as an `<iframe>`. Nothing needs to be installed. There is no extra package dependency and no modifications to make to the page's header, just drop the `<iframe>` in. The `src` attribute is the URL of the viewer, with a query string that tells it what to show.

```html
<iframe
  src="https://js2264.github.io/metacooler.js/?embed=1#uri=https://rsglab-data.s3.eu-west-3.amazonaws.com/demo/yeast/Yeast_microC_G2M_1kb.cool&view=region&region=IV:1000000-1400000&transform=log10&balance=true"
  width="100%"
  height="640"
  loading="lazy"
  style="border: 0"
  title="Mitotic micro-C of synthetic yeast, IV:1.0–1.4 Mb"
></iframe>
```

Paste it into a page and it works (not rendered here though because GitHub does not allow `<iframe>`). The `src` URL is the same as the one you would use to open the viewer in a browser, with the addition of `?embed=1` to tell it to hide the header and tab strip. 

The text below is a live version of the above `<iframe>` (it will not work on GitHub, but it would work on any HTML page):

<iframe
  src="https://js2264.github.io/metacooler.js/?embed=1#uri=https://rsglab-data.s3.eu-west-3.amazonaws.com/demo/yeast/Yeast_microC_G2M_1kb.cool&view=region&region=IV:1000000-1400000&transform=log10&balance=true"
  width="100%"
  height="640"
></iframe>

**Three ways to say what the embedded iframe should show**, in the order they override one another:

| | what it carries | when to use it |
| --- | --- | --- |
| `#uri=…&view=…` | one file at one view | a map or a browser at a place, as above |
| `?config=<url>` | a saved `.metacooler.json` config | a composed figure — tracks, colours, marks |
| `#session=…` | a whole session, deflated into the link | what **Share** produces; no bucket needed |

**For a paper, pin the build.** Every push is archived, so
`…/metacooler.js/v/<commit>/?embed=1#…` renders the same picture in five years, whatever the site
does next. `versions.json` lists what is published.

## Using the metacooler.js analysis CLI

Fourteen of the sixteen analysis tasks can be executed programatically through the CLI, over as many files as you like, with the same parameters and producing the same results as the Analysis panel interactively. This can be used in a pipeline or a script. The two exceptions are `metaplot` and `trackcorr`, which read a bigWig: the reader for one lives in the annotations worker and nowhere else, which is a layering rule this repository enforces (see below). `tasks` says so on their rows, and running one is refused before any file is opened rather than after. 

To install the CLI, run the following commands in a terminal:

```bash
git clone js2264/metacooler.js
cd metacooler.js
npm install
npm run build:cli && npm link
```

This will install the `metacooler-run` command globally. You can then run the following command to see the available tasks and their parameters:

```bash
metacooler-run tasks

## coverage
##     Coverage and marginals
##       --total (default true)  Total coverage
##       --fraction (default false)  Cis fraction
##       --cis (default false)  Cis coverage
##       --trans (default false)  Trans coverage
##       --balance (default false)  Use balancing weights
## 
## expected
##     Contact probability P(s)
##       --scope (default "contig")  Scope
##       --region  Sequence
##       --quantity (default "density")  Quantity
##       --factor (default 1.1)  Log bins per step
##       --minSeparation (default 0)  Minimum separation
##       --derivative (default true)  Also plot the log-log slope
##       --balance (default false)  Use balancing weights
## 
## fourc
##     4C profile from an anchor
##       --anchor  Anchor
##       --normalise (default "none")  Normalisation
##       --cis (default true)  Cis only
##       --balance (default false)  Use balancing weights
## 
## insulation
##     Diamond insulation
##       --window (default 10)  Window
##       --scales (default 1)  Scales
##       --region  Sequence
##       --ignoreDiags (default 2)  Diagonals to ignore
##       --minValid (default 0.5)  Minimum coverage of the diamond
##       --balance (default false)  Use balancing weights
##       --call (default true)  Call boundaries from the minima
##       --prominence (default 0.2)  Minimum prominence
##       --spacing (default 0)  Minimum spacing
## 
## compartments
##     Compartments (eigenvectors)
##       --sequences  Sequences
##       --contacts (default "cis")  Contacts
##       --ignoreDiags (default 2)  Diagonals to ignore
##       --components (default 1)  Components
##       --phaseFeatures  Phase by gene density
##       --phaseSequence  Phase by GC content
##       --minR (default 0.1)  Least convincing correlation
##       --saddle (default true)  Also draw the saddle
##       --quantiles (default 50)  Quantile groups
##       --balance (default false)  Use balancing weights
## 
## cid
##     Domains (CIDs)
##       --window (default 10000)  Window
##       --region  Sequence
##       --prominence (default 0.2)  Minimum prominence
##       --minSize (default 20000)  Smallest domain
##       --aggregate (default true)  Aggregate the boundaries that were called
##       --apaWindow (default 20)  Pileup half-width
##       --strata (default 2)  Strength groups
##       --balance (default false)  Use balancing weights
## 
## chromosight
##     Pattern detection
##       --pattern (default "loops")  Pattern
##       --sequences  Sequences
##       --thresholds (default "preset")  Thresholds
##       --pearson (default 0.3)  Score threshold
##       --minDist (default 20000)  Nearest to the diagonal
##       --maxDist (default 2000000)  Furthest from the diagonal
##       --minSeparation (default 5000)  Nearest two calls may be
##       --iterations (default 1)  Refinement passes
##       --maxPercUndetected (default 50)  Most undetectable pixels a window may hold
##       --maxPercZero (default 10)  Most empty pixels a window may hold
##       --nMads (default 5)  Detectability cut
##       --maxQvalue (default 1)  Report down to a q-value of
##       --balance (default false)  Use balancing weights
## 
## motif
##     Find a sequence
##       --sequence  Reference
##       --pattern  Sequence
##       --bothStrands (default true)  Both strands
##       --limit (default 500000)  Most sites
## 
## metaplot
##     Metaplot over a feature set
##       metaplot reads a track (--tracks); the bigWig reader lives in the annotations worker and not in this shell. Run it in the app.
## 
## apa
##     Aggregate peak analysis
##       --anchors (default "pairs")  Anchors
##       --pairs  Pairs
##       --features  Features
##       --mode (default "fixed")  Mode
##       --window (default 12)  Half-width
##       --grid (default 51)  Grid
##       --flankFraction (default 0.5)  Flank
##       --norm (default "matched")  Normalisation
##       --csPattern (default "loops")  Template
##       --controls (default 5)  Controls per pair
##       --minShift (default 100000)  Smallest shift
##       --maxShift (default 1000000)  Largest shift
##       --seed (default 1)  Seed
##       --rankBy  Rank by
##       --subset (default "all")  Then
##       --count (default 500)  N
##       --groups (default 4)  Groups
##       --balance (default false)  Use balancing weights
## 
## trackcorr
##     Track correlation
##       trackcorr reads a track (--tracks); the bigWig reader lives in the annotations worker and not in this shell. Run it in the app.
## 
## overlap
##     Interval set overlap
##       --a  First set
##       --b  Second set
##       --minFraction (default 0.000001)  Least of a feature covered
## 
## magqc
##     MAG contact QC
##       --balance (default false)  Use balancing weights
##       --network (default true)  Also build the inter-MAG matrix
## 
## magnetwork
##     Inter-MAG network
##       --normalise (default "coverage")  Edge weight
##       --minWeight (default 0)  Least edge worth listing
##       --maxEdges (default 500)  Edges to list
## 
## magpurity
##     MAG purity and contamination
##       --balance (default false)  Use balancing weights
##       --minContacts (default 10)  Least contact before judging a contig
##       --flagAbove (default 0.5)  Flag above this outside fraction
## 
## magsplit
##     Split-MAG detection
##       --balance (default false)  Use balancing weights
##       --minContigs (default 4)  Least contigs before judging a MAG
##       --flagBelow (default 0.1)  Flag below this cross-block ratio
```

Every task takes as many files as you like, and writes its results where `--out` points:

```bash
metacooler-run insulation *.mcool --window chrII --out results/
metacooler-run chromosight sample.cool --pattern borders --balance --out results/
metacooler-run apa sample.cool --pairs loops.bedpe --norm chromosight --balance

# Two of the tasks that run beside the tracks rather than on the map. A motif
# search reads the reference `--sequence` names and writes both halves: the
# sites as a BED-shaped table, and their density on the open map's bin grid.
metacooler-run motif sample.cool --sequence ref.fa.gz --pattern GGTCANNNTGACC --out results/
metacooler-run overlap sample.cool --features peaks.bed --features boundaries.bed --a peaks.bed --b boundaries.bed

# A .pairs is binned first, at a resolution you name — the shell's answer to
# the browser's dialog. `--pairs` above is a BEDPE of features; the contact
# list is the positional argument.
metacooler-run coverage Hum53.pairs.gz --bin-size 5000 --rungs 4

metacooler-run replay workspace.metacooler.json --over 'data/*.hic'
```

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
  browse/        a place read as a tree: one interface, a directory backend and a
                 bucket one, and the name-routing both of them show rows by
  s3/            SigV4, the bucket scopes, and ListObjectsV2 as a folder listing
  worker/        message protocol; the worker owns all I/O
  render/        canvas heatmap, matplotlib LUTs, colour scale, colourbar, the
                 diagonal blend for two files, the 1D browser's ruler and arcs
  state/         ViewState and its URL-hash serialisation
  ui/            file picker, genomes/contigs tables, genome/pair/region views,
                 the 1D browser, its vector-PDF page, errors
  annotations/   the tracks and annotations layer: parsers, store, and their own worker
  analysis/      the sixteen tasks (§18): descriptors, pure kernels, a worker of its
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
| M6 | bigWig tracks | **done, and wider than the milestone** — `src/annotations/` reads bigWig (`@gmod/bbi` v10), bedGraph/wig, GTF/GFF, BED/narrowPeak/broadPeak/BED12, BEDPE, FASTA and BAM in a worker of their own; `src/render/` draws them as lanes on any of the map’s four edges and as overlays on it; three sidebar cards drive them. Offered on every container (§8.5) |
| M7 | cool / mcool | **done** — opened natively, not as a synthesised one-genome metacool: a cooler's `/chroms` is the contig table, `genomes` is `null`, and its chromosomes are the landing view. Genome-wide is a first-class view whenever the size estimate says this machine can hold it (a yeast genome at 1 kb is 12,100 bins and opens in one read); balancing from `/bins/weight` is wired to a toggle. An `.mcool` root is refused by name and the app opens its finest resolution |
| M8 | Catalog, deploy, benchmarks | **partly** — a GitHub Pages workflow builds and publishes the app (`docs/deploy.md`); no `scripts/make_catalog.py` and no benchmarks |
| — | Sessions, comparison, 1D browser | **done** — tabs with a worker each (§5.6); a second cooler in the lower-left triangle, split on the matrix diagonal (§5.7); and a genome browser that needs no map at all, entered from a `chrom.sizes`, a bigWig, a bigBed, a FASTA, a BAM or a feature file (§5.8) |
| — | Metadata annotations (§8.12) | **done** — the columns a file already carries about its own genomes, sequences and bins, discovered from its `/genomes`, `/contigs` and `/bins` tables and drawn as lanes beside the map: bars for a measurement, runs of colour for a set of labels. Indexed by the map's own cells rather than by base pairs, so a MAG's completeness draws on a genome × genome overview where no other lane can — and offered only where its own table is no finer than the axis. The one annotation that never needed the §8.5 gate lifted, since a column of a file's own tables *is* the map's axis and has nothing to be matched against |
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

**A remote `.scool` is the one open that asks a question first.** Everything else here is a bounded
read, and where a read is expensive the cost was foreseeable from the file's own numbers. A
container's *cell names* are not: they live in HDF5 link storage that every writer interleaves with
the cells' own data, so listing them is about a thousand reads of ~500 bytes each, spread across the
whole object. No chunk size wins — anything large enough to coalesce them fetches the file, anything
small enough to avoid that needs a round trip each — so the reader is asked which to pay rather than
being surprised by either. A local copy is never asked, because seeking on disk is free.

**A HiC-Pro pair is read whole, because there is no other way to read it.** Every other format here
is reachable by a bounded read — HDF5 through range requests, a bigWig by zoom level, a `.hic` by the
blocks its rectangle covers. A HiC-Pro matrix is a list of pixels as text with nothing saying where in
the file any of them is, so a region cannot be reached without reading everything before it. It is
read once rather than per view, which is the best available answer and not a good one; the limit is
the pixel count, around 100 million comfortably. Above that, convert.

**Its `.biases` file is not read, and that is deliberate.** HiC-Pro's biases normalise the *raw*
matrix, while its `iced/` matrix is the already-normalised one. Offering the first as a weight column
would let somebody normalise twice and get a plausible-looking map. Open the `iced/` matrix to see
normalised counts; that is what it is for.

**Analysis tasks run on the map, not on the cell set.** The sixteen tasks operate on whatever is
drawn, so they run on a single cell and on a small sum of them. They are not *aware* of cells: there
is no per-cell batch mode, and no task that reports a distribution across a library. That is a real
gap rather than a decision against it — it is simply not built.

**Annotations are for one assembly at a time, and every container has one.** Gene models, tracks,
peak sets, loop calls and hand-drawn marks are offered on a cooler, on a `.metacool`, and on a genome
opened with no map at all. They used to be *absent* on a metacool, on the grounds that a metagenome's
axis is contigs from thousands of independently assembled organisms — but the premise was wrong about
the files people have: a metagenomic Hi-C dataset is *one* co-assembly, so `/contigs` is one
namespace and a bigWig over it is keyed on exactly those names. What a metagenome needed was not a
gate but an honest overlap report, in **MAGs** rather than in sequence counts, since `794 of 20,566`
is arithmetically true and reads exactly like a file that failed to match. See SPECS §8.5.

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
— a PNG, a PDF, a BED of hand-drawn marks, a saved workspace — and a bigWig is one more of them: new
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

- **P(s)** is two curves off one accumulator and both are goldened. The **expected** value — the
  mean contact per pair of bins at a separation, which observed/expected and the pileups divide by —
  equals cooltools' `expected_cis` cell for cell, once cooltools is told not to mask the first two
  offsets; the mirrored dense block doubles both the sum and the count, and the mean is what
  survives. The curve the panel **plots** is the probability density, and it equals
  `HiContacts::distanceLaw()`'s `norm_p` — same break positions, same values — against that
  package's own pipeline run in R by `scripts/hicontacts_ps.R`.
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
