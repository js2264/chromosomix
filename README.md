# metacooler-viewer

A unified genome browser for `.*cool`, `.hic`, HiC-Pro, and other similar formats, 
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
| `#s=…` | a whole session, deflated into the link | what **Share** produces; no bucket needed |

**For a paper, pin the build.** Every push is archived, so
`…/metacooler.js/v/<commit>/?embed=1#…` renders the same picture in five years, whatever the site
does next. `versions.json` lists what is published.

## Using the metacooler.js analysis CLI

The fifteen analysis tasks can be executed programatically through the CLI, over as many files as you like, with the same parameters and producing the same results as the Analysis panel interactively. This can be used in a pipeline or a script. 

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
##       --seed (default 1)  Seed
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

## Licence

MIT.
