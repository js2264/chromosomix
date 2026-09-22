# metacooler-viewer

A unified genome browser for `.*cool`, `.scool`, `.hic`, `.pairs`, HiC-Pro, and other similar formats, 
and other genome-wide data formats like bigWig, bedGraph, GTF, FASTA, `.2bit`, BAM, VCF, barChart, 
genePred, bedMethyl and UCSC's formats. 
The browser is a single-page application that runs entirely in the browser, with no 
server-side processing or data upload.

## Main features 

- Support for all genomic data types: 
  - Supports 1D genomic formats: bigWig, bigBed, BED, bedGraph, wig, GTF/GFF3, FASTA (+`.fai`), `.2bit`, BAM, VCF, barChart/bigBarChart, genePred/refFlat/bigGenePred, bedMethyl/bigMethyl, chrom.sizes, ...
  - Supports 2D genomic formats: `.*cool`, `.hic`, HiC-Pro, `pairs(.gz)`, ..., with resolution ladder and on-the-fly balancing. Also supports interaction formats: BEDPE, and UCSC's `interact`/`bigInteract` and `longrange`/longTabix — drawn as arcs over the contact map and as their own lane in the 1D browser.
  - Supports 3D genomic formats: WashU's g3d (text or binary), `.3dg`, and `bed3d`, drawn in 3D and synchronized with the maps and tracks view. 

- Dedicated browser panels: 
  - Aesthetics panel: to customize scales, color map, normalization, track layout, grouping, ...
  - Annotations panel, supporting linear tracks, 1D and 2D manual annotations, bookmarks and synthetic annotations.
  - Analysis panel, with exportable results: 
    - for 1D analysis tasks: metaplots, track correlation, interval overlap with a shuffle null, FRiP over a feature set, ...
    - for 2D analysis tasks: P(s), scalogram, diamond insulation, directionality index, HiC score, coverage, cis/trans per chromosome, virtual 4C, compartments annotation and saddle plot, loops and borders detection, APA, loop ranking, ...
    - for 3D analysis tasks: build a 3D model from the contact map, compare a 3D model with the contact map, and turn a 3D model into tracks.
    - for comparing what is on screen: HiCRep reproducibility across the maps in a deck, stratum by stratum and pooled.
    - for single cells: per-cell contact QC over an `.scool`, with the cell-cycle phasing scatter feeding back into the Cells table.

- Virtual file system: The browser runs entirely in the client, with no server-side processing or data upload. It uses a virtual file system to access local files, remote files, and cloud storage: 
  - Cloud-based file access: Open files directly from any object store that serves byte ranges with CORS (e.g. S3, Cloudflare R2, Google Cloud Storage, or any HTTP server that supports range requests), from Dropbox and Google Drive share links, and private Google Drive folder or Dropbox.
  - Stores: several pre-configured remote data stores are available, including IGV's genomes, 4DN open data, ENCODE, or any UCSC track hub with a `hub.txt` file. The user can also setup their own store by providing a structured JSON file describing the store and its data.

- Serverless: There is no upload, no required preprocessing step, no backend of any kind. The viewer is static files, and reads data directly from standard genome-wide formats. 

- CLI-based analysis: The same analysis tasks available in the Analysis panel can be run from a command line with `metacooler-run`, with the same parameters and producing the same results. A bottom Console panel in the genome browser records every action and reports the corresponding `metacooler-run` command.

## Philosophy

1. **No backend or install of any kind.** No tile server, no specific process on a host, no accounts. The viewer is static files; the data are objects on a bucket, or a file on your disk. This is what makes the app free to run and free to archive.

1. **Nothing is uploaded.** A local file is handed to an air-gapped worker by reference and read in place through the Emscripten filesystem. Nothing crosses the network, which is why there is no account system, no storage, no hosting cost and nothing to review for GDPR. You can open unpublished patient-derived genomic data on a laptop with the network cable out.

1. **No pre-parsing of genomic files is required.** Contact maps and 1D genomic files are read in bounded reads, and the rest is pure canvas transforms with **zero** further I/O. That is the central difference from HiGlass, which needs a tile server, a tile cache and a tile compositor to stream contact maps. 

## Using metacooler.js

### Use it from a web browser

Go to [`chromatlas.app`](https://chromatlas.app) to open the viewer in a web browser. The app runs entirely in the browser, with no server-side processing or data upload.

### Install as a PWA (Progressive Web App)

Go to [`chromatlas.app`](https://chromatlas.app) and: 

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

Every release produces a single `index.html` (roughly 12Mb). It has
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

## Using the metacooler.js analysis CLI

Over two dozen analysis tasks can be executed programatically through the CLI, with the same parameters and producing the same results as the Analysis panel interactively. This can be used in a pipeline or a script. To install the CLI, run the following commands in a terminal:

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
## cistrans
##     Cis and trans per sequence
##       --sequences  Sequences
##       --normalise (default "enrichment")  Off-diagonal value
##       --minContacts (default 10)  Least contact worth listing
##       --maxEdges (default 500)  Pairs to list
##       --matrix (default true)  Also draw the square
##       --balance (default false)  Use balancing weights
## 
## cellqc
##     Per-cell contact QC
##       --cells (default "all")  Cells
##       --nearFrom (default 23000)  Near band, from
##       --nearTo (default 2000000)  Near band, to
##       --mitoticTo (default 12000000)  Mitotic band, to
##       --balance (default false)  Use balancing weights
## 
## expected
##     Contact probability P(s)
##       --scope (default "contig")  Scope
##       --sequences  Sequences
##       --quantity (default "density")  Quantity
##       --factor (default 1.1)  Log bins per step
##       --minSeparation (default 0)  Minimum separation
##       --derivative (default true)  Also plot the log-log slope
##       --stranded (default false)  Also the four orientations
##       --pairsUri  From this .pairs
##       --balance (default false)  Use balancing weights
## 
## scalogram
##     Scalogram
##       --quantiles (default "standard")  Quantiles
##       --reach (default 0)  Look out to
##       --sequences  Sequences
##       --ignoreDiags (default 1)  Diagonals to ignore
##       --minValid (default 0.5)  Minimum coverage of the distribution
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
##       --sequences  Sequences
##       --ignoreDiags (default 2)  Diagonals to ignore
##       --minValid (default 0.5)  Minimum coverage of the diamond
##       --balance (default false)  Use balancing weights
##       --call (default true)  Call boundaries from the minima
##       --prominence (default 0.2)  Minimum prominence
##       --spacing (default 0)  Minimum spacing
##       --domains (default true)  Also the domains between them
## 
## di
##     Directionality index
##       --window (default 50)  Window
##       --sequences  Sequences
##       --ignoreDiags (default 0)  Diagonals to ignore
##       --minValid (default 0.5)  Minimum coverage of each side
##       --balance (default false)  Use balancing weights
##       --call (default true)  Call borders from the sign flips
##       --prominence (default 10)  Minimum prominence
##       --spacing (default 0)  Minimum spacing
##       --domains (default true)  Also the domains between them
## 
## hicscore
##     HiC score
##       --diagonals (default 3)  Diagonals
##       --sequences  Sequences
##       --ignoreDiags (default 0)  Diagonals to ignore
##       --minValid (default 0.5)  Minimum coverage of the line
##       --balance (default false)  Use balancing weights
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
## hicrep
##     Reproducibility (HiCRep)
##       --against <file>  The other maps to compare with; repeat per map
##       --sequences  Sequences
##       --maxDistance (default 5000000)  Furthest separation compared
##       --smooth (default 1)  Smoothing half-width
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
##       --tracks  Tracks
##       --features  Features
##       --mode (default "reference")  Mode
##       --at (default "start")  Anchor on
##       --flank (default 2000)  Flank
##       --step (default 50)  Resolution
##       --body (default 100)  Body columns
##       --stranded (default true)  Respect strand
##       --rankBy  Rank by
##       --subset (default "all")  Then
##       --count (default 500)  N
##       --groups (default 4)  Groups
##       --zscore (default false)  Z-score tracks first
##       --average (default "mean")  Average
##       --band (default "bootstrap")  Band
##       --iterations (default 200)  Bootstrap draws
##       --seed (default 1)  Seed
##       --heatmap (default true)  Also draw the per-feature heatmap
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
##       --minShiftScale (default 1)  Smallest shift
##       --maxShiftScale (default 3)  Largest shift
##       --seed (default 1)  Seed
##       --minSep (default 20000)  Nearest two features may be
##       --maxSep (default 2000000)  Furthest two features may be
##       --byDistance (default 0)  Split by separation into
##       --rankBy  Rank by
##       --subset (default "all")  Then
##       --count (default 500)  N
##       --groups (default 4)  Groups
##       --balance (default false)  Use balancing weights
## 
## trackcorr
##     Track correlation
##       --tracks  Tracks
##       --over (default "bins")  Compare over
##       --binsize (default 100)  Bin size
##       --features  Features
##       --method (default "spearman")  Method
## 
## frip
##     Fraction of signal in features
##       --tracks  Tracks
##       --features  Features
##       --resolution (default 0)  Read features at
##       --perFeature (default false)  Also score every feature
## 
## overlap
##     Interval set overlap
##       --a  First set
##       --b  Second set
##       --minFraction (default 0.000001)  Least of a feature covered
##       --shuffle (default false)  Test against shuffled placements
##       --shuffleWhich (default "a")  Set that moves
##       --iterations (default 1000)  Shuffles
##       --seed (default 1)  Seed
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

Every task writes its results where `--out` points:

```bash
metacooler-run insulation *.mcool --window chrII --out results/
metacooler-run chromosight sample.cool --pattern borders --balance --out results/
metacooler-run apa sample.cool --pairs loops.bedpe --norm chromosight --balance

# The domain pileup: a set of TADs — the span from one insulation boundary to
# the next — every one of them stretched to the same width, with half a domain
# of padding each side. The distance-matched control is shifted by a multiple of
# the window, so it never overlaps the domain it is the denominator of.
metacooler-run apa sample.cool --features domains.bed --anchors features \
  --mode scaled --grid 48 --flankFraction 0.5 --balance --out results/

# Two of the tasks that run beside the tracks rather than on the map. A motif
# search reads the reference `--sequence` names and writes both halves: the
# sites as a BED-shaped table, and their density on the open map's bin grid.
metacooler-run motif sample.cool --sequence ref.fa.gz --pattern GGTCANNNTGACC --out results/
metacooler-run overlap sample.cool --features peaks.bed --features boundaries.bed --a peaks.bed --b boundaries.bed

# The tasks that read tracks take them as --tracks: a bigWig, a bedGraph, a
# wig, or a FASTA read as GC content. Repeat the flag or separate with commas.
metacooler-run metaplot sample.cool --tracks ATAC.bw --features peaks.narrowPeak --flank 2000 --out results/
metacooler-run frip sample.cool --tracks ATAC.bw,MNase.bw --features peaks.narrowPeak
metacooler-run trackcorr sample.cool --tracks ATAC.bw --tracks MNase.bw --over features --features peaks.bed

# ...and with no contact map at all, over the assembly the tracks declare —
# what a 1D browser session runs.
metacooler-run metaplot --tracks ATAC.bw --features peaks.narrowPeak --out results/

# Reproducibility compares the file with every map --against names.
metacooler-run hicrep rep1.mcool::resolutions/5000 --against rep2.mcool::resolutions/5000 --maxDistance 2000000

# Compartments phased by GC content read the reference under --sequence.
metacooler-run compartments sample.cool --sequence ref.fa.gz --phaseSequence ref.fa.gz

# What the session set from the picture, as flags: the score column a
# .metacool is drawn from, the sequences declared circular, the cells of an
# .scool that were ticked. The console writes them whenever they differ from
# the defaults (count, none, every cell).
metacooler-run insulation sample.metacool --value balanced_by_depth --circular pCEN,p2u
metacooler-run cellqc cells.scool --cell c01,c02,c07 --cells selected

# A .pairs is binned first, at a resolution you name — the shell's answer to
# the browser's dialog. `--pairs` above is a BEDPE of features; the contact
# list is the positional argument.
metacooler-run coverage Hum53.pairs.gz --bin-size 5000 --rungs 4

metacooler-run replay workspace.metacooler.json --over 'data/*.hic'
```

### Recovering the commands you ran

You do not have to write those lines from memory. The browser app has a **console** and every analysis run lands in it as the `metacooler-run` command that repeats it, written the moment the run happens rather than when you look at the result. 

The log is kept in your own browser for seven days or five hundred lines, whichever comes first. Nothing is uploaded; it is listed in **Stored data** with everything else this app keeps, and **Forget everything** drops it.

## Licence

MIT.
