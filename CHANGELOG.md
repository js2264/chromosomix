# Changelog

Notable changes to the viewer, newest first. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[semantic versioning](https://semver.org/) — for an application that means the **format and URL
contract** rather than a code API: a major bump is a `.metacool` the previous version could open and
this one cannot, or a `#`-hash link that no longer resolves to the same view.

The deployed site at <https://js2264.github.io/metacooler.js/> is built from `main` on every push, so
it can be ahead of the newest entry here. Its exact build is in **About → version**, and in the
`/Producer` field of any PDF it exports.

## [Unreleased]

### Added

- **Find a sequence** — a new analysis task. Choose a loaded reference, type a
  motif, and every place it occurs comes back as two lanes. The pattern is
  IUPAC — `GGTCANNNTGACC`, `GATC`, `TTAGGG` — spaces are ignored, and both
  strands are searched unless you say otherwise; a palindrome is reported once
  rather than twice, because searching both strands of `GAATTC` would otherwise
  count every site again and a reader totting up a lane would get double the
  answer with nothing on screen to explain it.

  **Two lanes, not one, and that is the point.** A set of sites answers two
  questions and no single picture answers both: *where exactly is it*, which is
  an interval per site — clickable, strand-carrying, exportable as BED, and an
  eligible input to overlap, the metaplot and APA like any other interval set
  (§18.3) — and *how dense is it here*, which is sites per bin and is the only
  one of the two that means anything at chromosome scale. The first is a picket
  fence when you zoom out; the second is a bar chart of ones when you zoom in.

  Two decisions inside it are worth stating because they are the ones that
  would be wrong by default. An `N` in the *reference* does not satisfy a
  pattern that names a base: an assembly gap is a base nobody knows, not a base
  that is any of four, and matching it would turn every gap into a solid bar of
  fictional hits — most of what you would see on a draft genome. And an empty
  bin in the density lane is a **zero**, never a gap: `NaN` in a per-bin vector
  draws as a hole, and "there is no site here" is the answer, not missing data.

  It is a registered task rather than a card of its own, which is what earns it
  the parameter form, a recipe that travels in the session, provenance on both
  outputs, a place in the deck's all-maps overlay, and **Recompute** on a
  reload — none of which a bespoke card would have had, and all of which every
  other task already has. `venue: 'annotations'`, because the residues are in
  that worker and nowhere else: a genome is parsed into it and deliberately
  never shipped out whole, so searching anywhere else would mean hauling
  megabytes across the boundary or stitching thirty windowed reads together at
  the seams. A run declines a pattern that is not IUPAC before it starts, with
  the character it could not read named.

  It works in a **genome-browser session** as well as over a map, which is the
  session a reader who came in through a FASTA is actually in. That took
  fixing something older: a session with no contact map reported its bin size
  as `0`, a placeholder that was safe only while nothing producing a per-bin
  result could be run without a matrix. A task answering from the sequence
  broke that assumption, and a zero bin size gives every contig zero bins — a
  lane that is permanently *empty* rather than one that is visibly wrong,
  which is the failure nothing reports. A mapless session is now given a
  browsing grid chosen from the assembly's own length; it is a resolution to
  draw at and never a claim that anything was measured at it, so the tasks
  that genuinely need a matrix go on saying they are waiting for one.

- **A fold button on every panel header.** Each of the five columns now carries a
  chevron beside its shortcut chip, pointing the way that column travels — left
  for the three on the left, right for the two on the right. The affordance
  existed when a panel was *folded* (the rotated spine tab, which points the
  other way because it offers to open) and was missing when it was open, so the
  only way to close a column was a button in the header bar that does not look
  like it belongs to it. It goes through the same `fold` every other entry point
  does, so the remembered state, the relayout and the settle all happen once.

- **Shift-click ticks a range in the Tracks card.** Ticking the first ten of
  thirty tracks was ten clicks on an eleven-pixel box, which is the arithmetic
  that makes a batch action cost more than doing the ten by hand. Click one box,
  shift-click another, and every row between the two takes the state the clicked
  box is moving to — the gesture every file list has. The anchor is remembered as
  a row's **id** and resolved to a position at click time, because the rows are
  drag-reorderable and the card's list is not the store's: an index cached at the
  first click is a lie the moment anything moves.

- **Z-score the tracks first, on the metaplot.** A new option under *Summary*,
  off by default. Two tracks in different units — a CPM bigWig and a log2 ratio —
  plotted on one axis compare nothing; standardising each by its own mean and SD
  before the metric puts them on one scale. The statistics are taken per **track**
  and shared across that track's ranking groups, which is the part that is easy
  to get wrong: standardising each group separately would re-centre every one of
  them on zero and erase the ranking the reader split them by. A constant track
  is centred and not divided, so nothing comes back as ±∞, and gaps stay gaps.
  The heatmap shows the standardised values too, so the two halves of one figure
  cannot disagree, and the y axis is relabelled rather than left claiming a unit
  the numbers no longer have.

- **The viewer is published to npm**, as a built directory rather than as
  something to import — so a page can embed a copy that depends on nobody's
  hosting, including ours:

  ```html
  <iframe src="https://cdn.jsdelivr.net/npm/metacooler-viewer@0.11.0/dist/index.html?embed=1&config=…"></iframe>
  ```

  ```bash
  npm pack metacooler-viewer && tar xf metacooler-viewer-*.tgz && cp -r package/dist /var/www/viewer/
  ```

  A sixth invocation of the same bundler (`vite.package.config.ts`), and the one
  built for a path it does not know. Everything else this repository emits is
  served from somewhere decided in advance — the site root, `/v/<commit>/`, an
  asar, a disk — and bakes absolute asset URLs accordingly. A tarball is
  unpacked wherever somebody puts it, so its base is `./` and one published
  version serves all of them. The rule that comes with that is the mounter's:
  the URL has to end in a slash, or name `index.html`.

  Two things follow from a copy not knowing where it is, and both are enforced
  rather than assumed (`IS_PORTABLE`): it registers **no service worker**, since
  a copy mounted under a path it does not own must not claim a scope there — on
  a registry CDN that scope covers other people's packages — and it asks for
  **no version manifest**, since `versions.json` lives at a site root a vendored
  copy has no way to find. Before those guards, every vendored copy would have
  made two doomed requests: a 404 for a `sw.js` this build does not emit, and a
  cross-origin fetch for a manifest belonging to somebody else's server.

  `files` is `dist/` and `dist-cli/`, which is the whole of what stands between
  a publish and 250 MB of demo data, and which makes `npx metacooler-run` work
  against a published version with no clone. `prepack` builds and
  `check-package-build.mjs` then refuses the result if it is wrong — a tarball
  packed over a *site* build would carry absolute asset URLs that 404 on every
  mount but the site root, and unlike everything else here a published version
  cannot be corrected.

  `private: true` is gone with its comment. The argument it made — an
  application, not a library — is still true and is not what publishing changes:
  what a registry is wanted for here is hosting nobody has to trust, not
  dependency resolution. Specified at SPECS §22.

- **A `LICENSE` file**, with the MIT text the manifest has always declared. It
  was missing, which matters most at the moment a package is published: npm
  shows the licence of a package it can find one for, and a tarball that
  declares MIT without carrying it is asking to be taken on trust.

- **`.pairs` files open, at a resolution you choose.** A 4DN pairs file — plain,
  gzipped or bgzipped, with a `.px2` beside it or without one — is now an
  accepted input, and it is the first one the app **imports** rather than opens.
  Everything else in §3 is a matrix in a container; a pairs file is a list of
  contacts, and there is no grid in it. So the first open is refused, a dialog
  asks for a base resolution and a number of ladder rungs, and the file is read
  once. After that it is a map like any other: the same views, the same deck,
  the same turn, the same fourteen analysis tasks, none of which learns the
  container exists.

  **The grid could not be guessed**, and that is why there is a dialog rather
  than a default. A bin table inferred from the largest coordinate observed
  would differ between two subsamples of the same library — the one way of being
  wrong that survives every check downstream and makes two files silently
  incomparable.

  **The ladder is nearly free**, so it is offered rather than rationed: the base
  rung costs a pass over the records, and every rung above it is derived from
  that table, which is smaller than the record stream by the ratio of records to
  stored pixels — thirteen to one on `demo/yeast/`. The rungs are spelled the
  way an `.mcool`'s resolutions are, which wires them into the resolution
  picker, the refine ladder and a deck descending to its lead's rung with no
  code in any of them.

  **The shape of the data is what makes this the right design.** On this
  repository's own demo files, yeast Micro-C is 179 M records and 13.7 M stored
  pixels at 1 kb; the mock community is 10.9 M records and 7.1 M pixels. The
  input is gigabytes and the output is tens of megabytes — so the file is paid
  for once, at open, and every view afterwards costs no I/O at all.
  `demo/ecoli/SRR19500734.pairs.gz` — 238 MB, 17.7 M records — imports in about
  forty seconds.

  **What decides that time is the file's BGZF framing rather than this code**,
  and it is worth knowing because it can be changed. A deflate block costs about
  the same to start whether it holds 1 KB or 64 KB, so a finely framed file pays
  that fixed cost tens of thousands of times over: measured on the same 1.39 M
  records, **0.69 M records/s** at the 64 KiB blocks `bgzip` writes and
  **0.12 M records/s** at the ~1.4 KB blocks that E. coli file has. Re-blocking
  it (`bgzip -d < f.pairs.gz | bgzip > g.pairs.gz`) is worth about 5×.

  An imported map is a *fuller* citizen than a `.hic`: because the file was
  read, the per-bin pixel index is a by-product rather than a whole-file scan,
  so `binOffsets()` answers where a `.hic`'s refuses and `nnz` is a real number.

  What it is not is a `.metacool`. `#chromsize:` has no concept of a genome, so
  an imported map is a cooler-class citizen (§9) — chromosomes table, no genomes
  table, the four metagenome tasks absent rather than disabled.

- Switching resolution on an imported map no longer re-reads the file. The
  rungs are spelled as an `.mcool`'s resolutions — which is what wires them
  into the picker, the hash and the refine ladder for free — so a switch
  arrives as an ordinary open carrying no binning, and the ordinary path
  would drop the ladder and ask for a bin size that had already been given.

- **`metacooler-run` takes a `.pairs` too**, with `--bin-size` and `--rungs`
  standing in for the dialog the browser shows. Everything after the open is
  the same code, which is the whole point of the CLI: a number computed in a
  batch and a number computed by clicking come out of one implementation. Note
  the older `--pairs` flag is a BEDPE of *features* for a pileup — a contact
  list is the positional argument, and the usage now says so.

- **The `.mcool` is written back out, and downloads when it is ready.** Every
  rung, as a real cooler: `chroms`, `bins`, `pixels`, `indexes`, cooler's own
  format attributes, and the pairs preamble carried verbatim in `metadata`
  beside the record count and whatever the import skipped, clamped or had to
  merge. Raw counts and no weights — `generated-by` says `unbalanced`, and
  `cooler balance` is the answer. It runs beside the open map rather than in
  front of it, because the reader has already waited once and what they are
  waiting for now is a file rather than a picture.

  This required narrowing a stated non-feature, and it is narrowed in the open
  at SPECS §18.9 rather than stepped around. Writing a matrix *derived from an
  opened map* is still refused, for the reason that clause gave: provenance,
  balancing and the bin table would be choices this app makes on the reader's
  behalf and then seals into a file that outlives the session. A file binned
  from a `.pairs` answers all three from its input — the bin table from
  `#chromsize:` and a size the reader picked, provenance from the header, and no
  balancing at all — and what is written is *what is on screen*, off the arrays
  the map is drawn from, so there is no second computation to disagree with the
  first.

  Checked two ways, because a round trip alone would only prove the reader and
  the writer agree — which is exactly what they did about `.hic` endianness: the
  file is read back through this app's own reader **and** compared cell for cell
  against an independent binning of the same records written the slow obvious
  way. One structural difference from `cooler cload` is stated rather than left
  to be found: `bins/chrom` is int32 codes rather than an HDF5 enum, because
  h5wasm exposes no enum construction. Everything numeric is identical.

- **The viewer, inside somebody else's page.** `?embed=1` mounts the same web
  build with no window around it — no header, no tab strip, no status bar — so
  it can be the figure in a portal, a lab site, a course page or a paper's
  supplementary material. It is an `<iframe>` and a URL: no backend, no package
  to install, and no header for the host page to set.

  That last one is why this is possible at all. Cross-origin isolation
  (`COOP`/`COEP`) has to be arranged by the *hosting* page and almost never is,
  which is the usual reason a wasm application cannot be embedded. This viewer
  has never needed it — h5wasm 0.10.x is single-threaded with the binary inlined
  — so the two prerequisites that *are* hard were already met: every view state
  is in the hash, and every push is archived at `…/v/<commit>/`, so an embed in a
  2026 paper still renders in 2031.

  **Three ways to say what to show**, in the order they override one another:
  `#s=` (a whole session deflated into the link, what **Share** already
  produced), `#uri=…` (one file at one view, what a navigation leaves behind),
  and the new `?config=<url>` — a published `.metacooler.json` named in the
  address, fetched, signed where a bucket entry covers it, and resolved against
  its own URL, through the road `Session.openConfigUrl` already took for the
  picker's URL box. `?config=` is the pointer form of what `#s=` carries as a
  payload: editable after the embed is published, of no length, and
  self-contained enough that the folder can be copied to another bucket.

  **And a `postMessage` channel**, so an embed is not only a picture: `ready`
  and `state` out, `where` and `navigate` in. A `navigate` is a *patch* over
  what is on screen — `{ locus: … }` moves the browser without the page knowing
  what else is in the state — and it is serialised and parsed back through
  §5.5's own reader rather than believed, because an object from another origin
  is exactly as untrusted as a hand-edited link. The frame answers only the
  window that framed it, only after that window has spoken, and only at the
  origin it spoke from: a reader can open *their own* file in an embed, and the
  URL that follows is not the host's to learn unless it asked to be told.

  **One bar, and two of the five columns.** Chrome-less is not featureless: the
  bar carries the mark and the name — a link out to this same view in the full
  application, in a new tab — the file's own breadcrumb, and on the right the
  Annotations and Aesthetics toggles beside **About**, which is where a figure
  in somebody else's page says what it is, that nothing is uploaded, and which
  build drew it. Those two columns stay because they are controls over the
  *picture*; Files, General and Analysis are about the window. They arrive
  folded, standing as named spines on either edge — a column is open until
  somebody folds it, and a frame that honoured that came up with five open
  columns and thirty pixels of map between them — and they neither read nor
  write the fold and width kept for the full app, so a reader who opens a panel
  inside an embedded figure does not find the application rearranged the next
  time they go to it.

  Specified at SPECS §21, with a picture of a real one and the worked example in
  the README.

- **A progress bar on the two opens that are worth watching, with a way out.**
  Almost every read here is bounded and finishes before anyone could want news
  of it. Two are not: a HiC-Pro pair is read whole and parsed at open (§3.9),
  and an `.scool` over the network pays its listing cost up front (§3.8) — and
  a spinner in front of either gives a reader no way to tell a slow connection
  from a hung one, and no way to stop.

  So the loading screen now talks back. It stays a spinner until the worker has
  something to say, and from the first word it is a labelled bar and a
  **cancel**: bytes while a file is coming across, pixels while it is parsed —
  two sweeps with a denominator each, rather than one bar sliding between two
  and appearing to go backwards. Cancelling is not a failure and does not look
  like one: it stops the download mid-stream and goes back to the picker, the
  way dismissing the gate does. A 258 MB pair reads in about four seconds, and
  the bar spends three of them on the download.

  The `.scool` listing is the one wait that cannot be measured *while* it
  happens — it is a single call into HDF5 that issues a thousand small reads and
  returns when it has them, so the thread is not free to say anything until it
  already has the answer. What it can say is which wait it is, before it starts:
  an indeterminate bar under the name of the phase.

- **A cell sum says how far it has got.** Summing a cell set is the one read in
  this application that is linear in something other than the picture: the same
  window that draws instantly over one cell is four thousand small reads over a
  whole file, and the veil in front of the map said `loading…` for all of it.
  It now counts cells — `summing 1,204 of 3,882 cells…` — in every map view, and
  the whole-file view's own bar names the unit it is counting rather than
  calling three hundred cells three hundred pixels.

- **HiC-Pro's `.matrix` + `_abs.bed` pair, as one contact map.** The output of
  the pipeline most published Hi-C was processed with, and it opens as what it
  is: the BED is the coordinate system, the matrix is the pixels, and between
  them they are an ordinary map — the chromosome table, every region, the
  analysis panel, tracks, export, the deck. All four `MATRIX_FORMAT` variants
  read, `iced/` matrices included.

  **The bin file is found three ways, because it is not optional.** A `.tbi` is
  an optimisation and a `.bai` is a format's only bounded read; an `_abs.bed` is
  the matrix's *coordinate system*, so without it there is not a slower map but
  no map. So it is paired when both are dropped together, handed over when the
  matrix is picked out of a connected folder, and probed for beside a URL where
  HiC-Pro writes it — `raw/` and `iced/` share one bed per resolution, so the
  `_iced` matrices are tried against the raw directory's too. A URL whose bin
  file is somewhere unguessable can name it: `<matrix>#bins=<url>`. A matrix
  with none of the three is refused by name, and the refusal lists all three.

  **Read whole once, and then it is a cooler.** This is the one format here that
  cannot be indexed: the rows are text of variable width, so byte offset and bin
  id have no relation, and `asis` says outright they need not be sorted. So the
  matrix is parsed at open — byte by byte, never a string per line, at a measured
  6.8 M pixels/s — and a counting sort by `bin1` produces the sorted triplets and
  the cumulative index together. After that every read is bounded and in memory,
  and panning costs nothing.

  The sort behind that is a **radix sort — two stable counting passes, by
  column then by row — and not a sort per row band**, which is what it was
  first. Bands are wide: a row of a 100 kb human matrix has thousands of
  non-zero columns, and sorting each on its own is quadratic in that width. On a
  211 MB file it took 59 seconds where the radix sort takes 3.7, and the parse
  itself runs at 100 MB/s — the sort must not be what decides the wait. The
  second pass's bucket boundaries *are* the cumulative `bin1_offset`, so the
  index falls out of the sort rather than being built after it.

  **Which is why there is no `HicProStore`.** A `.hic` cannot answer `pixels/*`
  or `indexes/bin1_offset` and needs a pixel store of its own; this container
  was read whole by necessity, so it serves those datasets honestly and
  `CoolerStore` reads them unchanged. The pixel path for a HiC-Pro map is the
  cooler path, byte for byte.

  **A mirror and a repeat are not the same duplicate.** Two rows can land on one
  cell and they mean opposite things: `(a, b)` and `(b, a)` is one contact
  stated twice, which `MATRIX_FORMAT=complete` writes and which must be
  *dropped* — adding it doubles every off-diagonal cell and leaves the diagonal
  alone, giving a picture that still looks entirely like a contact map. Two rows
  on the same side are more evidence, and are *summed*. Once both have been
  folded onto the upper triangle they are indistinguishable, so the side each
  row was stored on is carried as far as the collapse.

  Not read, and both deliberate: fragment-level maps (`GENOME_FRAGMENT`), since
  a fragment grid is variable bins under another name — refused with the config
  key that produced it; and the `.biases` file, since those biases normalise the
  *raw* matrix while the `iced/` one is already normalised, and offering them as
  a weight column would let somebody normalise twice.

- **A second load gate, on bytes rather than on the network.** Past 200 MB of
  matrix the reader is told what the read costs — the size, the pixel count it
  works out to, and that it is paid once rather than per view, which is the part
  that turns a bad number into an acceptable one. It shares a module with the
  `.scool` gate below because the two are the same shape; they differ in that an
  `.scool` offers two readings and this offers one, and that an `.scool`'s cost
  is round trips so a local file is never asked, where this one's is parsing and
  memory and a local file pays in full. The panel also names the way out for a
  map too fine to hold: `cooler load -f coo` turns the same two files into a
  `.cool` that opens in a handful of requests at any size.

- **`.scool` — single-cell coolers, per cell and summed.** The container from
  [Wolff *et al.* 2021](https://academic.oup.com/bioinformatics/article/37/14/2053/5948994):
  one cooler per cell over one shared bin space. It opens as what it is. A
  **Cells** table is the landing view — every cell in the file, with the `nnz`
  and contact total its own attributes record, sortable and filterable like the
  genomes table beside it — a click opens one cell's map, and ticking any number
  of them **adds them together**. Tick all of them and that is the pseudo-bulk.

  **Both layouts, and neither is the special case.** The standard `/cells`
  container `cooler.create_scool` writes, and the flat one HiCMatrix and
  scHiCExplorer produced before the format was standardised in cooler 0.8.11 —
  cells at the file root, no shared tables, and a root that announces nothing.
  The second is the majority of what exists (every published `.scool` predating
  2021 is one), so it is detected by elimination and tested at every step
  alongside the first.

  **Summing needs no arithmetic, and that is the whole design.** Every cell
  indexes the same bins, so a bin id means the same thing in all of them; and
  the dense scatter was already additive per pixel, because a bounded rectangle
  may arrive in several chunks. A store that hands one callback each selected
  cell's chunks in turn therefore *is* their sum — no summing code, no
  intermediate matrix, a peak footprint of one chunk. The same falls out twice
  more: `nnz` is a total over the set, and a sum of cumulative indexes is the
  cumulative index of the sum, so the density proxy, the band planner and the
  selection read all work over a cell set without knowing one exists.

  **The set is a property of the file, not of the view.** Chosen cells stay
  chosen through a chromosome and back out, they show in the breadcrumb in every
  view — a map summed from one cell and one summed from four thousand are
  different experiments and that must not be inferrable only from the picture —
  and they travel in the link as `cells=`, with `*` for all of them, because
  four thousand names is not a URL. Balancing sums the raw counts and applies
  the file's *shared* `/bins/weight` once to the result, which is cooler's own
  definition applied to the pseudo-bulk; it is offered only where such a column
  exists. One cell is addressable on its own as `file.scool::/cells/<name>` and
  is an ordinary cooler there, weights included.

- **A gate before a remote `.scool` is read, with both costs on the buttons.**
  The first and only open in this viewer that asks a question, and the reason is
  worth stating because it is a property of HDF5 rather than of the format: a
  container's cell *names* live in the group's link storage, which the library
  allocates as members are added — immediately after each cell's pixels, for
  every writer there is. The index of the file is interleaved with its data
  rather than gathered anywhere.

  Measured on the 3,882-cell Nagano 2017 file: listing the cells is **1,015
  reads averaging 512 bytes, spread uniformly across all 327 MB**. Not a quirk
  of that writer — a container written by `cooler.create_scool` behaves
  identically, and a synthetic 800-cell 50 MB one touches all 48 of its megabyte
  blocks. So no chunk size wins: the reads are ~500 bytes about 320 KB apart, so
  anything large enough to coalesce them fetches the whole file and anything
  small enough to avoid that needs a round trip each. Rather than pick one
  silently, the reader is offered both with the numbers on them — one download,
  or ~1,000 small requests for ~5% of the bytes — and told that a local copy
  costs neither. **A local file is never asked**: the question is about round
  trips, and a file on disk seeks for free.

  The consolation is that the listing is the only cost. Every cell's attributes
  sit in metadata the listing already brought across — measured at *zero*
  additional chunks on both files — so the cells table's columns are free once
  the names are paid for.

- **A despeckle whose window sizes itself, in the `smooth` picker.** One new
  setting, `adaptive`, beside the fixed `3 × 3`, `5 × 5` and `7 × 7`. Each cell's
  window grows until it covers enough evidence to average, so it stays narrow
  where the counts are thick and widens where they thin out. Carried in the link
  as `smooth=a50`, and written into the colourbar caption as
  `counts · smoothed adaptively`.

  **Why a fixed window was never going to work away from the diagonal.** The
  precision of a box mean depends on the *counts* it covers, not on the cells it
  covers. Near the diagonal a `7 × 7` box holds thousands of contacts and its mean
  is steady; at 300 kb separation on the same map those 48 cells are almost all
  zero, so the mean is a handful of counts divided by 48 — still noise — and
  widening the box does not help, because what is in it grows in proportion to
  nearly nothing. On a yeast map at 500 bp the coefficient of variation between
  200 and 800 bins of separation is **6.8 raw, 1.1 at `7 × 7`, and 0.41
  adaptive**.

  **This is serpentine's criterion, not serpentine's algorithm.**
  [Serpentine](https://doi.org/10.1093/bioinformatics/btaa249) (Baudry *et al.*,
  *Bioinformatics* 2020) is where the idea of holding the counts constant instead
  of the window comes from. Its own method grows *regions* and averages each,
  which makes the result a partition — the right shape for a differential
  analysis, and the wrong one for a viewer, because the partition is global and
  stochastic, so panning by one bin redraws every boundary and the map visibly
  reshuffles under the reader. Here the windows overlap and no partition is
  formed, so a cell reads the same wherever it sits in the viewport.

  The width is set by the block's **as-read** values while the mean is taken over
  whatever the derivation has made of them — serpentine's own separation, and what
  makes the setting work under the O/E at all, since observed-over-expected is
  near 1 everywhere by construction and a window sized on it would be the same
  size everywhere. The target is a multiple of the block's mean rather than an
  absolute count, because `score` may have put balanced values in the cells.

  **Picking it turns the O/E on**, exactly as clicking the toggle would, and the
  `log2` scale, the symmetric range and the diverging ramp all follow from the
  neutral of 1 that gives the result. That is the picture the setting is for: on
  raw counts all it can denoise is the distance decay that was never in question.
  Turning the O/E off again is left to the reader.

  The window is floored at `3 × 3` and capped at a radius of 192. Blocks are
  capped at **16 M cells** — the 4096² raster cap, so in practice it is available
  on anything the viewer draws. The cumulative tables are built for a **band of
  rows** at a time rather than for the block, so about 128 MB is resident whatever
  the block's size; without that a 16 M block would allocate over half a gigabyte
  on the thread drawing frames. Time is roughly linear: **173 ms at 841², 328 ms
  at 1,200², 867 ms at 4 M and 3.9 s at 16 M**. That last is a real freeze and the
  honest price of the cap being where it is; if it ever needs fixing the answer is
  the analysis thread rather than a lower cap. Above the cap the fixed `3 × 3` is
  used and the refusal is said **twice** — in the export caption, and in the view
  note under the heading, because a caption nobody reads until they export is no
  use to somebody looking at the screen.
- **VCF opens as a lane of variants.** Drop a `.vcf`, or a `.vcf.gz` with its
  `.tbi`, and the calls draw as boxes over the reference bases each record is
  about — with the symbolic ones at their real size, read out of `INFO/END` and
  `INFO/SVLEN`, because `<DEL>` writes a single `N` in REF whatever the deletion's
  length and a forty-kilobase event drawn as a one-pixel tick is a wrong answer
  that looks like an answer.

  It was already being read, wrongly. The feature sniffer has no "none of mine"
  answer — its last line is `return 'bed'` — and the row walker strips every `#`
  line, so a VCF reached it as a nameless eight-column table, was parsed as a
  BED, and was refused with *"all 7 lines failed the contig, start, end test that
  every BED-like format begins with"*: a message naming a format the reader never
  handed over.

  **A substitution is drawn in the colour of the base it substitutes to.** Over
  one locus with a FASTA and a BAM open, a heterozygous A>G now reads as one
  column in inks that agree — the sequence row writes a green `A`, the pile puts
  orange `G` marks through half its reads, the depth row's mark rises to half,
  and the variant row draws an orange box saying somebody called it. A record with
  no single base behind it — an insertion, a deletion, a structural variant,
  several ALTs at once — takes the grey an `N` is already drawn in, which already
  means *no single-base answer*. What separates an insertion from a deletion is
  extent, which is exact: a forty-kilobase deletion is a forty-kilobase box.

  A single base gets three pixels so it can be seen and clicked, and a lane stops
  resolving individuals the moment they are closer together than that — which is
  the rule that keeps a dense stretch from merging into one solid bar in
  whichever ink was drawn last. Collapsed, it says how many are there instead.

  A VCF also **says what genome it is on, exactly**: its `##contig` lines are a
  `chrom.sizes` written inside the file, so a dropped VCF opens a browser over its
  real chromosomes rather than reporting each one as ending at its last variant.
  Reading part of a bgzipped one costs nothing new — it takes the same tabix road
  a bgzipped GTF does.

  The **genotype columns are not drawn**, and the lane says so: *"1,284 variants ·
  2,504 samples not drawn"*. A matrix of variants × samples is a second
  application's worth of picture for a question a contact map is not asking, and
  a reader who brought a thousand-genome file should be told what they are looking
  at rather than left to infer it.

- **Alignment files open as two lanes.** Drop a `.bam` with its `.bai` or `.csi`
  beside it — or point at one by URL — and it lands as *two* rows over the one
  file: its **depth**, drawn like any other track (on any of the map's four
  edges, in the 1D browser, with limits, an autoscale group, the ceiling drag,
  the readout and the exported figure, because it goes through the one funnel
  every lane's values already come out of), and the **reads** themselves, in
  packed rows, once the view is narrow enough for a read to be more than a few
  pixels. A `.bam` can also *start* a browser session on its own, since its
  `@SQ` table is every sequence and its exact length.

  Two rows rather than two bands of one lane, because they are two pictures with
  nothing in common — a curve against a value axis, and a stack of rectangles.
  Each is resized, reordered, hidden and **closed** on its own, so a reader who
  wants the depth without the pile closes the pile and keeps the link they had.
  Behind them is one open file and one parsed index, and the filters that decide
  *which reads count* — the mapping-quality floor and the duplicate switch — are
  written through to both, because a floor on the pile and not on the depth
  above it is two pictures of two different files under one name.

  The pile lives only in the 1D browser, and that is geometry rather than
  policy: beside a heatmap the axis is an axis of matrix bins, where the finest
  unit is a bin and not a base, so there is nothing for a read to be drawn *on*.
  Too far out for a read to be wider than its own ink, or a lane dragged too
  short to hold a row, and it says *zoom in* rather than drawing a smear — the
  depth over the same reads is the lane beside it, and is drawn at every zoom.

  A read is a rectangle only when nothing happened to it, and the exceptions are
  what anyone is looking at: a deletion is a rule through a gap because the read
  spans it and says it is absent, a spliced gap is a thinner rule because the
  read says nothing about what it skipped, an insertion is a tick between two
  bases with no width of its own, a soft clip is drawn faintly outside the
  aligned extent, and a mismatch is a coloured column — from `=`/`X` where the
  aligner wrote them, from `MD` where it did not, and from a FASTA already open
  in this session where neither is there. The lane says which of the three it
  used, or that it had nothing to compare against, rather than drawing an
  agreement it did not check.

  **A variant is coloured on both rows, where a FASTA is open.** In the pile it
  is the mismatch mark it always was, one coloured column per read. On the depth
  row it is the share of each position that disagrees with the reference, drawn
  from the baseline up — so a heterozygous site is a mark half the height of the
  curve over it, and a homozygous one fills it. Above a fifth of the depth only,
  because under that every pileup is speckled with sequencing error; and only
  once a pixel is a handful of bases, because at a kilobase to the pixel the
  mark would be the genome's background mismatch rate drawn everywhere.

  The mark is drawn in a colour that is deliberately none of the four bases. It
  shipped as the sequence palette's own T, which put one red in one column under
  two opposite claims — *the reads disagree here* on the depth, and *this read
  has a T here* in the pile — so a reader studying a T>C site would have read
  the same ink two ways an inch apart.

  It costs no request: the residues come from a FASTA already open in the same
  worker, and a FASTA dropped *after* the BAM refreshes both lanes without a pan.
  It is not a variant call — substitutions and short deletions against whatever
  is loaded, with no base-quality filter, no strand-bias test and no score.

  **The controls are the pile's, not a track's.** Colour by strand, by pair, by
  insert size, by where the mate went, or by mapping quality, with a key under
  the picker naming every category. It colours; it does not *group* — the rows
  are packed by position, so the categories are interleaved down the pile rather
  than banded, and a band per category is not built. Beside it the pair layout
  and the split-read switch, which are the pile's alone; and on **both** rows the
  mapping-quality floor and the duplicate switch, which are about which reads
  count. All of it is stored with the session.

  Four of the five reach the worker on the request that needs them; the layout
  is the one the worker never reads, so changing it redraws what is already in
  hand rather than fetching a window again.

  **A pair is drawn as a pair.** Both ends of a template on one row, joined by a
  dotted thread across the part that was not sequenced — with `fragments` and
  `reads` beside it in the card for a reader who wants the fragment as one bar,
  or a single-ended library packed record by record. The old switch drew a solid
  thread and packed by position alone, so at any real depth the two ends landed
  on different rows and the thread ran towards a mate that was not there. A change made while the
  previous window is still decoding replaces it — the test is against the
  *running request's* controls, never against the drawn window's, which between
  a change and the first landing is permanently the old one.

  **Split reads are drawn and never counted.** A supplementary alignment is a
  further piece of one molecule the aligner had to split across a breakpoint, so
  drawing it is how a reader sees the split and counting it would report one
  fragment as two. The split is what holds that: the depth is its own row on its
  own road, and the switch is not even in the key its samples are cached under,
  so turning it on costs the depth nothing at all. It is outlined rather than
  faded — faded already means "soft clip" here — and it is never joined to its
  primary as though it were a mate.

  **A click on a read opens a card and fetches nothing.** The flags in words
  with the raw number beside them, the CIGAR, the clips, where the mate went,
  the insert size, the category it was coloured as. Every field is already in
  the pile the lane drew, which is why it answers at once and why it cannot
  disagree with the rectangle that was clicked — and the fields a BAM uses to
  mean "not recorded" are shown as that rather than as numbers.

  **This is the one format allowed to require a companion file, and that took an
  argument rather than a line of code.** SPECS §13 listed required companion
  files among the explicit non-features, and §1 said C1 and C3 together mean the
  app can never require one. The scope of that rule is now written down: it
  protects the *contact map's* opening path, which is what makes the
  no-preprocessing claim true, and it was never a claim about every byte the app
  reads. A BAM has no whole-file fallback that respects §12 at all — it is read
  by region and the index is the only thing that makes reading by region bounded
  — so the narrow rule replacing it is stated positively at §8.13: a format whose
  index is its only bounded read may refuse without one, and the refusal names
  the command. Two do: `samtools index` for a file with no index beside it, and
  `samtools sort` for one that is not in coordinate order, because a name-sorted
  file handed to a region query answers with whatever was in those blocks, which
  is worse than refusing because it looks like an answer.

  **Above what it can afford, the lane draws nothing and says why.** There is no
  summary layer in a BAM, so depth over a window is a full read of the reads
  under it, and a window can be legitimately unanswerable. The forecast is made
  from the index alone, so a window too deep to draw is refused at zero data
  requests rather than discovered part-way through a fetch. Drawing the BAI
  linear index's byte density there instead was considered and refused: it is
  compressed bytes per 16 kb rather than depth, wrong wherever read length
  varies, and absent entirely on CSI — it would be the first quantitative lane
  here that means something other than what it says.

  Three decisions inside the depth itself, each a place a viewer can quietly
  disagree with `samtools` and never say so. A CIGAR `N` is **not** covered — it
  is reference the read is aligned across rather than over, and counting it draws
  an RNA-seq gene as a solid block. Secondary and supplementary alignments are
  excluded, since they are one molecule reported twice and they cluster exactly
  where the number is read most carefully. Duplicates are **kept** unless asked
  otherwise, because marking them is a pipeline's decision and hiding them
  silently would disagree with every other reading of the same file.

  The reader is written here, with no new runtime dependency, for the reason
  `hic/format.ts` and `annotations/tabix.ts` both give at length. `@gmod/bam`
  is a devDependency and reads the fixtures alongside it, exactly as `hic-straw`
  reads the `.hic` ones — and the first thing it caught was a record prefix off
  by four bytes in this repo's reader *and* its fixture builder at once, which
  is precisely the mutual misunderstanding a round trip cannot see.

- **Tabs can be called something.** A tab is labelled by its file, which is the
  right default and a poor name for the work: four tabs reading
  `matrix_1000.mcool` off four runs are four identical labels whose only
  distinguishing part is the one they all share. Double-click a tab — or press
  <kbd>F2</kbd>, or find *Rename this session* in the palette — and type. Enter
  commits, Escape abandons, and an **empty box hands the tab back to its file
  name**, which is what makes a rename undoable.

  The name is part of the *session* rather than of the window, so it travels in
  the saved workspace, in the durable record and in a share link: a workspace of
  six tabs whose names did not come back is six tabs a reader has to open one at
  a time to tell apart. It is kept against the file, so it survives a change of
  resolution and a redirect into an entry of a collection, and opening a
  *different* file in the tab hands the label back — replacing the file is
  replacing the work. A tab with nothing open cannot be named, and the strip does
  not offer the gesture there rather than accepting a name it would have nowhere
  to keep.

  The tooltip leads with the URI it has always led with, because a named tab is a
  tab whose file is no longer on screen anywhere else.

- **A saved workspace now carries four things it used to leave behind.** Each was
  invisible in the same way — the file opened, the tabs came back, and one
  decision the reader had made was quietly the importing window's instead. Every
  one of them is a decision that takes minutes to make and a moment to lose.

  **Which columns were folded, and how wide they were.** A fold is a preference
  and lives beside the theme, which is exactly why it has to travel: a window
  that restores twelve tracks into an Annotations column the sender had dragged
  to 520 pixels, and puts it back at the default with Analysis unfolded over it,
  has restored the tracks and not the arrangement. All five columns, the Files
  panel included. A file that says nothing about a column leaves it alone.

  **How each companion of a deck was drawn** — its transform, its ramp, its clip,
  the score it reads instead of the deck's, and whether its chain was open. The
  deck's own doctrine is that the view is shared and the presentation is not, and
  a deck of four replicates each clipped to its own depth is precisely what a
  deck is *arranged* for; restoring it onto the lead's one clip is a legal deck,
  a plausible-looking one, and not the figure that was saved. Keyed by the file
  each map was showing, never by its slot — a slot id is minted per deck and
  names nothing tomorrow — which is the same key the parked lanes already use.
  One consequence worth stating: one file open twice in one deck has one look,
  and comes back on whichever of the two clips was set last.

  **What the session's own map says about a track.** Every other map's lane was
  written down and the lead's was not, so the two things a lane can say that a
  track cannot — *I am not on this map* and *my range here is different* — were
  sayable about every map in a deck except the one every session has. Both were
  losable in one gesture: taking a track off the lead is one press of its last
  lit edge, and every analysis result computed against a starred companion is
  placed there and taken off the lead. A deck of four then came back with the
  fourth's tracks stacked on the first as well.

  **The overlay toggles, on the road that had never applied them.** See below.

- **Companions' scales are remembered across a reload, not only across a save.**
  The same record the workspace carries is this session's own memory, written on
  every change rather than on a save — so a reload, the durable restore after a
  browser restart, and an exported file all describe the same deck. Nudging four
  companions' clips and closing the window used to lose all four, because a clip
  is not a navigation and nothing on the state road ever fired.

- **`Expected (cooltools)` beside the density on P(s).** A *Quantity* choice on
  the contact-probability task. The default is unchanged — the probability
  density, `HiContacts::distanceLaw()`'s `norm_p` — and the other setting plots
  contacts at a separation over the **bin pairs that could have held one**,
  which is what `cooltools expected-cis` reports and what a scaling exponent is
  compared against −1 or −1.5 as.

  They differ by exactly one denominator: `density / expected = pairs(s) /
  constant`. The pair count is flat while the separation is short against the
  sequences and falls to zero at the longest one, so on the yeast demo the two
  are within 1 % below 10 kb, 13 % apart at 100 kb and a factor of fifty apart
  at 1.2 Mb — and on a mammalian map they agree over everything anybody fits.

  Verified end to end rather than by construction: pooled genome-wide over the
  yeast demo, `--quantity expected` reproduces `cooltools.expected_cis` to 4e-6,
  which is the printing precision of the TSV. The quantity is cooltools'; the
  bins are the task's own `factor`, so 1.2589 matches `logbin_expected`'s ten to
  the decade. What O/E and the pileups divide by is untouched — they reach the
  same numbers through `expectedAt`, never through the panel.

- **Four text boxes on every curve, one per axis bound.** `x` from/to and `y`
  from/to, beside the `log x` / `log y` toggles. Empty means "fit the data", so
  clearing all four is how you get back to the whole curve; a marquee fills them
  in, and typing in them is how two figures are set to the same window for a
  figure panel rather than dragged towards it.

- **`expected` in the score picker: the denominator of O/E, drawn.** Every cell
  replaced by the mean of the block at that bin separation, with one scalar
  between each pair of sequences — a banded triangle fading from the diagonal
  and nothing else in it. It is in the picker rather than beside the `O/E`
  toggle because it answers what the numbers *are*, not what they are compared
  to, and it overrides that toggle rather than composing with it: O/E of the
  baseline is 1 wherever it is anything, so the toggle greys and its tooltip
  says why.

  The reason to look at it is that an O/E is only as trustworthy as its
  denominator. At long separations the curve is a mean over few cells and it
  moves, so a ratio that swings out there is swinging in the model rather than
  in the biology — and until now there was no way to see which.

  Drawn on a sequential ramp with no neutral, because a mean of counts is
  count-like; measured after whichever normalisation is in force, like the ratio
  it comes out of. Its id in a link is `baseline`, not `expected`, so a file
  that carries a `/pixels/expected` column of its own still reaches it — that
  column now reads `expected (column)` in the list, which is the only way two
  entries could have carried one word.

- **Pattern detection, and it is chromosight.** A fifteenth task on the map card:
  loops, borders, hairpins, centromeres and stripes, found by correlating a
  template against a map detrended by its own distance law, with the smears
  suppressed and a Benjamini-Hochberg q-value on every call. It is a port of
  [chromosight](https://github.com/koszullab/chromosight) rather than a caller of
  this app's own invention, and the difference is the whole reason it exists —
  §18.9 refused the second and gave a reason that the first answers: a background
  model and false-discovery control, both of them the published method's.

  **It agrees with that package rather than resembling it.** On
  `demo/yeast/Yeast_microC_G2M_1kb.cool` at the loops preset, `chromosight detect`
  and this task both call **1,100 loops** — the same 1,100, with scores agreeing
  to 5e-7. `test/golden/analysis/chromosight.json` is built by running the package
  itself and compares five stages separately: the undetectable bins, the detrended
  map, the correlation map, every call with its score, p-value and q-value, and
  the pileup. A single end-to-end check would have said "different loops"; these
  say which of five things moved.

  Four outputs, and they are different in kind on purpose. The **loop set** is a
  bedpe — a BED for the patterns that live on the diagonal — offered to the
  Annotations panel, so a call lands on the map it was called from before the
  reader has to decide whether to believe it. The **pileup** is every window it
  found, on chromosight's own fixed 0–2 seismic scale, which is what lets it be
  laid beside a published figure. The **spectrum** is the distribution of the
  scores behind that pileup: a smooth shoulder running down to the threshold says
  the calling stopped where the threshold was rather than where the pattern did,
  and no list of coordinates ever says that. And a table of the strongest calls.

  The pattern is a parameter rather than five tasks, and every threshold under
  the picker follows the picker — upstream tuned `pearson`, the scan distance and
  the two window-quality percentages *per template*, so a form that baked one
  preset's numbers into a box would report borders at twice the threshold
  chromosight uses. **Set them myself** takes them over, and says so in the
  provenance.

- **APA has a fourth normalisation, and it is `chromosight quantify`.** The same
  anchors and the same averaging as the other three, with the control moved: the
  map is detrended by its own distance law *before* any window is cut, so a cell
  is observed-over-expected at that separation on that sequence — which is what
  chromosight's pileups are, drawn on the same fixed scale. Three things follow
  and none of them is a detail: the window is the **template's** size rather than
  the reader's half-width, because the score under the picture is a correlation
  against those cells; the scan distance is the **loop set's own reach**, which is
  what `cmd_quantify` sets it to; and **every anchor comes back**, scored or not.
  It reports the per-anchor Pearson correlation, its p-value and its q-value
  beside the pileup, and the same score spectrum the detector draws — which is the
  half of the answer a pileup cannot carry, since two sets with the same mean
  window can be a hundred good loops and four hundred coordinates of which fifty
  are loops.

  Checked the same way: over the demo loop table, this and `chromosight quantify`
  produce the same 1,506 scores and the same pileup, and
  `test/golden/analysis/chromosight_quantify.json` is that package's output.

- **`seismic`, in the colormap picker.** matplotlib's own five stops, here
  because `pileup_plot` draws with it. A matrix output can now also fix its
  colour range rather than fitting one to the data — used by exactly the two
  pileups above, for the reason a fitted scale cannot serve: a pileup running
  from 0.98 to 1.02 and one running from 0 to 4 would otherwise be the same
  picture in the same colours, and the difference between them is the result.

- **A contact map can be called something.** A map is labelled by its file, which
  is the right default and a poor name for the work: two conditions dropped in to
  be compared are `mat_G1.mcool::1000` and `mat_G2M.mcool::1000`, and every one
  of those characters is on the picture, in the readout under the pointer and in
  the exported figure — where the two words that would tell a reader what they
  are looking at are `G1` and `G2M`. Four replicates in a deck are four labels
  differing in a digit. Click a map's name on the **Contact maps** card, or on a
  deck cell's heading, and type. Enter commits, Escape abandons, and an **empty
  box hands the map back to its file name**, which is what makes a rename
  undoable — the Tracks card's own control in both places, so a reader who has
  learned the gesture on a track has learned it here.

  The name is used everywhere the map is named: the card that lists it, the
  heading over its cell, the two bands of a turned comparison, the readout and
  the tooltip, the derived label on a ratio, and the caption on an exported
  figure. It is kept against the *file*, so it survives a change of resolution,
  and it travels in the workspace, in the durable record and in a share link
  beside the tab's own name — a link carrying only the names of maps a recipient
  could open, since the address of a local one is a filename off the sender's own
  disk. One consequence, which the deck's saved looks already had: one file open
  twice in a session has one name.

- **The turned view of a comparison shows both files.** A split map is the first
  file above the matrix diagonal and the second below it, and turning it kept
  only the upper triangle — so the second file, the entire reason the picture is
  split, disappeared the moment the reader turned it. It is now drawn as a
  **second band mirrored beneath the first**, the two meeting at one shared
  genomic axis: the same position is the same column in both, so they are read
  against each other at every place without the eye having to reflect one of them
  through a diagonal first. The distance up the side runs outwards from the axis
  in both directions, both bands are named on the picture, and a pointer in the
  lower band reads the lower band's file. The pair is pinned by its **middle**,
  so a band cut deeper than its box — which is what a zoom in leaves — is clipped
  equally from both and the two files stay the same depth, where an edge would
  take the whole surplus off one of them. A ratio or a difference stays one band,
  its two triangles being the same numbers twice.

- **A map of several chromosomes now carries coordinates.** A whole genome, or a
  selection of chromosomes, had the contig names and nothing else: an axis of
  several sequences has no single coordinate system, so it drew none of the ticks
  that assume one. It is now ruled **one chromosome at a time**, each measured
  from its own first base, with the boundaries the axis already draws saying where
  one ruler stops and the next begins — which is the question a reader is asking
  of a whole-genome map as much as of a single chromosome. The long chromosomes
  carry a position each and the short ones carry their name and nothing more,
  which is the rule the names themselves are already elided by, and a metagenome's
  thousands of pixel-wide contigs carry none.

### Fixed

- **Every published demo failed to open.** The picker offered three sessions and
  each one answered a click with *not a workspace*: `App.openWorkspaceFile` reads
  `kind: "metacooler.workspace"` and refuses anything else, and the copies on the
  bucket are still written in the older single-session shape. The mock-community
  entry was a 404 on top of that — the bucket had moved that dataset under
  `demo/metagenomics/` and `ui/examples.ts` went on naming the old prefix.

  The catalogue is now **four** sessions, ordered as an argument rather than by
  dataset: one map with its tracks, then the same assembly with no map at all,
  then two maps side by side — a `.cool` and a Juicer `.hic`, locked together, at
  the one window the two assemblies agree about to the base — and the metagenome
  last, because it is the file this viewer exists for and the one that needs the
  other three to be legible. `demo/` on disk is laid out the way the bucket is,
  so publishing is a small JSON sync rather than a second copy of 49 MB.

  Note that the fix is only half in this repository: the bucket has to be
  re-synced with `scripts/publish-demo.sh` before the site sees any of it.

- **Sequence lengths inferred from a feature file were inflated by up to 85%.**
  Open a browser on a GTF, a BED or a narrowPeak — a file that carries no
  lengths — and each sequence was rounded up to *one significant figure*, a step
  equal to the value's own order of magnitude. Yeast IV (1.53 Mb) and VII
  (1.09 Mb) therefore both came out as exactly 2.00 Mb, 441 kb apart and
  indistinguishable; the genome total read 31% high; every chromosome ended in a
  long blank pannable margin; and the bar chart in the Sequences card was drawn
  to the wrong shape. The step jumped discontinuously at each power of ten, so
  the error was worst just above one.

  The margin the rounding was written for is kept — a browser opened on a peak
  set should not appear to *end* at the last peak — at two orders of magnitude
  less: three significant figures, always strictly past the last feature, about
  a half-percent instead of a third. Yeast now totals 12.11 Mb against a true
  12.07, where it read 15.99.

  Two things the interface claimed and the code did not do are now true as well.
  The browser's summary no longer says a sequence ends at its last feature, which
  it never did; and dropping a **bigWig** really does replace inferred lengths
  with real ones, as the Genome card has always offered — along with a bigBed, a
  BAM, a FASTA or a VCF that declares its contigs, any of which knows the answer
  exactly. It is adopted *as well as* loading the file as a track, never instead
  of it, and it can only ever replace a guess: an assembly that already knows its
  lengths is never overwritten. This works from the Tracks card's own file button
  as well as from a drop, which is one gesture two inches from the other.

- **Hiding a curve recoloured the others.** The legend filtered the hidden series
  out and the renderer then coloured by position in what was left, so hiding the
  first of three moved the second onto its colour and the third onto the second's
  — every curve, its confidence band and its legend swatch, all shifting one step
  up the palette at once. Nothing said so, and it went into the PNG and the PDF.
  The most visible face of it was alt-click *isolate*, which hides all but one
  series and therefore always drew whichever you isolated in the first palette
  colour. Colours are now settled against the full list before anything is
  hidden. Affected P(s), the P(s) slope, the metaplot and the all-maps deck
  overlay — every figure that draws more than one curve.

- **The share dialog was clipped, cramped, and made you press a button.** Its
  body asked for a width 4 rem greater than the panel containing it, and that
  panel is `overflow: hidden` — so the right-hand edge, which is exactly where
  the copy and shorten buttons live, was cut off with no way to scroll to it. It
  also had no padding at all, so the text sat against the border. The link is now
  a box that scrolls by wheel and by drag rather than a field only a caret can
  move through, the copy control is the icon alone, and **the link is put on the
  clipboard the moment it is generated**, with a notification saying so — and
  again when the shortener replaces it, since that is what you will paste. Where
  the browser refuses the clipboard, which is every insecure origin, nothing
  claims success: the link is selected and a sentence says to copy it.

- **The show/hide tooltip control was missing from the 1D browser.** The matrix's
  Tracks card builds its overlay row from the list of track options; the
  browser's spelled six of them out by hand and `tooltip` was not among them. The
  flag was honoured — the browser reads it on every hover — but reachable only
  from the `p` shortcut or the command palette, never from the column the rest of
  the switches are in.

- **An incomplete `.pairs` file is now said to be incomplete.** A truncated
  BGZF — a cancelled upload, an interrupted `bgzip`, a partial copy — imported
  without complaint and drew a map of whatever had arrived. Every number in
  that map is true of the records that were there, which is exactly the
  problem: nothing on screen distinguishes *this library has no contacts on
  chromosome XIII* from *this file stops before chromosome XIII*.

  A BGZF file marks its own end with an empty member, so the two states are
  distinguishable and now are: a file that ends mid-member or without that
  marker is reported as incomplete, alongside any sequences that have nothing
  on their own diagonal — the visible form of the same fact. Both are carried
  into the written `.mcool` as well, since a cooler binned from an incomplete
  file is itself incomplete and will outlive the window that knew.

  Found on `demo/yeast/CH128.pairs.gz`, which is cut off after chromosome XII
  and silently produced a map with four empty chromosomes.

- **A bgzipped `.pairs.gz` failed to open in the browser** with `Junk found
  after end of compressed data.` BGZF is a concatenation of gzip members, and
  the specification says a decoder walks them — Node's does, and that is where
  it was verified. **Chromium's does not**: `DecompressionStream('gzip')` stops
  after the first member and throws. Because BGZF's end-of-file marker is
  itself an empty second member, this was true of *every* bgzipped file, not
  only a large one; the fixtures that passed were plain single-member gzip,
  which is the one shape that works either way.

  Members are now decompressed one at a time, which is what the format is. That
  turned out to cost nothing: taking the writer and reader off the
  `DecompressionStream` directly, rather than through a `Blob` and a `Response`,
  runs at 260 MB/s against the `Blob` form's 34 MB/s — so
  `annotations/tabix.ts`, which reads `.tbi` and GTF spans the slow way, now
  shares the fast one.

- **A Choose-files button in a framed page no longer does nothing at all.**
  Anybody could already put this site in an `<iframe>`, and in a cross-origin one
  the File System Access pickers are *present and rejecting*: `typeof
  window.showOpenFilePicker` answers `'function'` and the call fails with a
  `SecurityError`. Every capability gate here tested the `typeof`, and
  `chooseFiles` swallows a rejection because that is what a cancelled dialog
  looks like — so the button opened nothing and reported nothing, which is the
  one outcome worse than not offering it. `handlesSupported`,
  `directoriesSupported`, `directoryPickerSupported` and `chooseFiles` now ask
  whether this window's top-level document is on another origin, and a frame that
  is takes the fallbacks Firefox and Safari have always taken: an `<input
  type="file">` for files, the snapshot shape for a directory. Dropping was never
  affected. A **same-origin** frame is deliberately not caught, since the pickers
  work there.

- **Every analysis task failed on a HiC-Pro map** with `error - name not
  defined!` — HDF5's own words, for a `.matrix` that is not HDF5 at all. The two
  threads that mount a contact map had drifted apart: the reader worker grew the
  HiC-Pro road (two text files, read whole, no HDF5 anywhere) and the analysis
  worker, which mounts the same file a second time so a long task cannot block a
  pan, went on calling `MetaCooler.open` directly. The map was drawn and
  perfectly fine; the task said the file was broken.

  The fix is one road rather than a second branch. `worker/open.ts` now holds the
  knowledge of *how many ways there are into a map*, and the reader worker, the
  analysis worker and the `metacooler-run` CLI all go through it — so the CLI,
  which had the same defect and no one had hit it yet, is fixed by the same
  change rather than by remembering to.

- **A task on a selection of cells measured every cell in the file.** Because
  the analysis worker mounts the file itself, it never learned that an `.scool`
  had a selection: it opened the pseudo-bulk, so two cells ticked and four
  thousand gave the same answer with nothing on screen to say so — silently
  wrong numbers, which is worse than the error above. The ticked set now travels
  with the target, and the worker's mount is keyed on it as well as on the file,
  because re-ticking is a new map at the same URI and a cache on the name alone
  would answer the second question with the first one's cells.

- **A HiC-Pro matrix parsed nineteen times slower than it reads**, and only
  ever in the application: 35 seconds for a 258 MB file where the same code
  measured 1.8. The scan shared its integer reader with the bin-file parser, and
  V8 will not optimise a function whose inline caches are still moving —
  `--trace-opt-verbose` says `delaying optimization of scanSlice, IC changed`,
  once per tick, forever — so having read a bin file first left the scan running
  interpreted from the first byte to the last. It reads its own digits now.

  The reason it was invisible is worth recording: the bins are parsed *before*
  the matrix in the application and never before it in a test, so every timing
  taken of this file was of the fast path. The fix carries the measurement and
  the reason beside it, because re-sharing the helper would restore the slow
  path silently.

  Two things fell out of inlining the scan, both of which the old scanner had
  wrong and nothing had noticed: an exponent written with its sign (`1e+2`, what
  `%g` and numpy print) stopped at the `+` and quietly kept the mantissa, so the
  pixel was 1 rather than 100; and a negative fractional value (`-0.5`) asked
  its integer part which way it went, got `-0`, and came out positive.

- **A diagonal pixel was counting as both triangles**, so the `MATRIX_FORMAT`
  a HiC-Pro file turned out to be written with was reported as `mixed` for
  every real file — every real file has a diagonal. Caught against HiCExplorer's
  own HiC-Pro test pair, which is upper-triangular and was labelled `mixed`;
  the comparison is now strict, and a file of nothing but its diagonal reports
  the default it would have been written as.

- **A URL fragment is not part of a file name.** `<matrix>#bins=<url>` ends in
  `.bed`, so the name test sent the *matrix* through the genome door and drew
  its bin file as a feature track. Both places that take a name off a URL — the
  router and the worker — now drop the query string and the fragment, which the
  first was already half doing for presigned bucket URLs.

- **Answering the `.scool` gate with *small pieces* asked the same question
  again, forever.** Two causes, both worth naming. The retained remote source
  was keyed on the URL alone, so re-opening with the reader's answer handed back
  the mount built for the other reading and discarded the answer; and the gate
  itself only knew about the source, which is still remote after that choice —
  choosing *download it whole* passed only incidentally, because that source
  stops being remote. The reading is now part of a mount's identity, and the
  agreement is passed explicitly rather than inferred.

- **`2 << 30` is not two gigabytes.** The shift operators coerce to signed
  32-bit, so the whole-object download limit evaluated to −2,147,483,648 and
  refused every file, including a 114 kB one, with "more than a browser tab can
  hold in memory". Found by driving the built app in a browser rather than by a
  test, which is the kind of arithmetic no unit test was ever going to be
  pointed at.

- **A bgzipped file with no index is read to its end, not to the end of its
  first block.** `bgzip` writes a gzip member per block — roughly one per 64 KiB
  — and the whole-file road handed all of them to a single `gzip` decompressor,
  which is only correct on a platform that carries on past the first member's
  end. The Compression Streams spec does not promise that; it says trailing data
  after a stream ends is a `TypeError`. So on a runtime that reads it that way,
  every `.vcf.gz`, `.gtf.gz` and `.fa.gz` without a `.tbi` beside it was refused
  outright with *"Trailing junk found after the end of the compressed stream"* —
  and a runtime that stopped quietly at the first member instead would have been
  worse, drawing the opening blockful and calling it the file.

  It now walks the blocks, which is the road the indexed path and every BAM
  already took, and asks nothing of the platform beyond `deflate-raw`. A plain
  `.gz` is one member and not BGZF, so it still goes the way it did.

- **A file and its index dropped together are now actually paired.** The loader
  has always paired a `.tbi` with the file it indexes, and `Session.dropped` —
  which decides what a single file *is* — could only ever be asked about one
  file at a time, so every caller looped it over the batch and the loader was
  handed one file at a time. A plain drop of a bgzipped GTF and its `.tbi` onto
  the window therefore read the GTF whole and drew the index as a refused row.
  The pairing rule now lives in one function that both roads go through.

- **A re-opened local track keeps its index.** A grant was remembered for the
  file and not for the sidecar, so a reload re-attached the `.gz` and lost the
  `.tbi`, quietly going back to reading the whole file. Changing resolution did
  the same thing by a different route: `carry` rebuilt the source without it.
  The index now lives on the source rather than beside it, so every road that
  carries a source forward carries the index too.

- **A derived track is no longer restored as a file that never existed.** It is
  computed from two other rows and holds no bytes and no recipe the stored shape
  can carry, so it fell through to `{ kind: 'local' }` and came back as a
  detached local row under the derived track's label, offering to re-open a file
  that has never been on any disk. It is not persisted now, which is the smaller
  wrong until there is a stored shape that can name an operation and its
  operands.

- **A BAM's chromosomes are no longer described as guesses.** Its `@SQ` table
  carries a length per reference, so the lengths are exact — but the assembly
  was reported with origin `features`, which is what `lengthsAreExact` reads,
  so the Genome card said they were *inferred from the features* and that each
  sequence ended at its last read. It has its own origin now, and the card says
  *from the BAM's @SQ header*.

- **The three places that list what this app opens now mention BAM.** The
  landing page, the Tracks card and — the one worth spelling out — the landing
  page's note that a file dropped with its index beside it is one track and not
  two.

- **The README no longer states a rule SPECS overturned.** It said in two
  places that annotations were *absent* on a `.metacool` — once in prose and
  once in the milestone table, where the Metadata card was still described as
  the only annotation such a file gets. §8.5 replaced that gate with an honest
  overlap report in MAGs some time ago.

- **`metacooler-run apa --window 8` set the half-width and then died.** The CLI
  reserves `--window` for the framing locus, and `apa` declares a parameter of
  the same name — a half-width in bins. `paramsFor` already gives a task's own
  parameters the flag where the two collide, but the framing read it anyway, so
  the run set the half-width correctly and then failed with *"Unknown sequence
  label: 8"*. One name, one meaning, decided by whether the task claims it.

- **A second map to compare against was lost on a change of resolution**, and
  silently: the first map is a complete picture on its own, so nothing on screen
  said the other one had gone, and the reader had to find and open it again at
  every zoom level. A comparison belongs to the file it is a comparison *of*, so
  opening another file puts it down — and a change of rung went through the same
  door, though it is not a change of subject. The second file now comes across,
  moved to **its own rung at the new bin size**: it has a ladder of its own, so
  `rep2.mcool::/resolutions/1000` beside a 1 kb map is `…/5000` beside a 5 kb
  one, looked up in that file's own entries. The reading carries with it — the
  operation, the depth match, and whether the triangle was hidden. A file with no
  rung at the new bin size cannot be compared there, two bin sizes in one square
  being a pixel that means one thing above the diagonal and another below it, and
  it is put down with the reason on the Contact maps card.

- **Opening a saved workspace ignored the overlay toggles it carried.** Every tab
  in the file has always recorded them — the dividers, the breaks, the labels,
  the ticks, the crosshair, the tooltip — and the one road that could not apply
  them was the road a workspace actually arrives on. A dropped single session and
  a pasted share link went through `Session.openConfig`, which applies them; a
  workspace file and the offer after a browser restart go through the shell,
  which did not. So a figure saved with the dividers on and the crosshair off
  came back with whatever the importing window happened to be set to, silently,
  and looking exactly like the toggles had not been saved. The tab that ends up
  in front now decides, which is what a window-level preference carried per tab
  can honestly mean.

- **P(s) is smooth again: the density is divided by the separation a bin covers,
  not by the width of the break.** The curve had developed a sawtooth of a factor
  of two through the 10–30 kb decade, which buried the cohesin shoulder the
  derivative is read for.

  It is an aliasing artefact and `HiContacts::distanceLaw()` has it too. That
  break table is `unique(round(1.1^n))` in base pairs and was built for a *pairs*
  file, where a distance is continuous and the counts in a break really are
  spread over its whole width. A contact matrix is not like that: its separations
  sit on a lattice of `binsize`, and near 10 kb the breaks are about a kilobase
  wide — so on a 1 kb map one break holds two lattice points and the next holds
  one. Dividing both by their nominal widths makes the first almost twice as
  dense as the second, bin after bin. On the yeast demo the log-log slope of that
  curve moves by **0.83 between neighbouring points** and swings between +1.7 and
  −2.9; the shoulder it hides is a change of about **0.26**, so the artefact was
  an order of magnitude bigger than the feature.

  Dividing by `offsets × binsize` is the same quantity — a share of all cis
  contacts, per base pair — estimated on the lattice the data are actually on. It
  moves the slope by **0.087** between neighbours, and it agrees with the nominal
  width wherever a break is wide enough to hold several offsets, which is
  everywhere past about 50 kb at 1 kb bins. HiContacts says as much itself: its
  matrix branch prints *"the P(s) curve will be an approximation"* and its pairs
  branch does not.

  The golden now compares the **numerator** — the contacts in each break, break
  for break — against HiContacts exactly, which is where a real disagreement
  would show, and a new test asserts both roughness figures from the golden's own
  numbers so the sawtooth cannot come back unnoticed.

- **The CLI can use a loop set again.** `--pairs loops.bedpe` parsed the file,
  filed it under its *file name*, and then set the task's parameter to a *path*;
  every task that takes a feature or pair set looked under its own parameter key,
  found nothing, and reported "the set chosen is no longer loaded" about a file it
  had just read. `TaskInputs` is keyed by parameter key — `analysis/job.ts` has a
  whole paragraph about not indexing it any other way — and the CLI was the one
  venue that had no store to allocate ids in, so it invented a second convention
  and lost. Both work now: the name a reader typed still names the input, and the
  parameter key is an alias for it.

### Changed

- **The adaptive filter runs on the analysis thread above 1 M cells.** It reads
  the block twice — once to measure every cell against its neighbourhood and once
  to average the capped field — and at the cell cap that is 7.4 s, which on the
  thread drawing frames is a frozen window rather than a hitch. Below the limit it
  is still done inline, which is the better trade there: 78 ms on a 353² view, and
  no flash of an unsmoothed map on the way to a smoothed one.

  `deriveBlock` runs the pipeline to the point the smoothing would happen, hands
  the caller the arrays it would have used, and carries on with the **unsmoothed**
  field; the panel starts a job and derives again when the answer lands, at which
  point the step is a lookup. The correlation's arrangement, for the correlation's
  reason. While it waits **the caption says `counts`, not `smoothed`** — a figure
  exported mid-wait must not claim a filter it does not have — the wait shows on
  the veil, a superseded job is cancelled, and a late answer to a superseded
  question is dropped rather than cached.

  Two callers never defer and compute inline at whatever it costs, because the
  alternative is not doing it at all: a panel with no analysis thread behind it,
  and **either file of a compared pair**, where two blocks would need two jobs and
  a half-finished pair would put a smoothed map over an unsmoothed one and call
  the result a ratio. The fixed radii never defer at any size — one incremental
  pass is not worth a round trip.

  The job is not interruptible partway through, unlike the correlation's, and that
  is deliberate: the filter's passes are banded over rows and there is no
  consistent state to stop at inside one. The cancel is checked before the work as
  well as after, so a job cancelled while queued never starts and only the one
  already running is wasted.

- **The adaptive window no longer turns one hot cell into a rectangle.** Reported
  from a yeast microC map at 500 bp: saturated hard-edged blocks, each with an
  isolated bright pixel at its centre and its edges lined up with discarded-bin
  stripes. Two causes, both ours. A mean has no defence against a single extreme
  value — and it had one until the centre went back into the kernel, which fixed
  the hollow squares and removed the only outlier rejection there was. And a box
  kernel's impulse response *is* a box, so the cell raised every window that could
  reach it by the same amount and none of the next ones along. Measured: one cell
  at 400× its neighbourhood produced a **20 × 20 bin block peaking at 5.3** in
  `log2` O/E, on a scale clipping at 0.84.

  **A cap on leverage, before the averaging.** Not a multiple of the local mean,
  which is the obvious rule and is wrong for this data: away from the diagonal the
  map is Poisson-sparse, so a window's mean is 0.05 while its occupied cells hold
  1, and every honest count is already twenty times the local mean. No fixed
  multiple both spares those and controls a spike — a tight one biases the
  sparsest part of the map downward, which is the part the filter is for. What the
  artefact is, is leverage: a cell shifts the mean of every window reaching it by
  `(value − mean) / n`. So the cap is written on that — no cell may add more than
  half again to the mean of a window its own size — and it scales itself, tight in
  a 3 × 3 near the diagonal and two hundredfold in a sparse 21 × 21. The mean is
  taken **without the cell itself**, which is the one thing the zero-centre kernel
  had right: excluding the centre is correct for deciding whether a cell is an
  outlier and wrong for estimating what to draw there. The two passes do one each.

  **And a shoulder on the kernel.** The mean is now taken over three nested
  windows — `r/2`, `r`, `3r/2` — and averaged, so the weights step down instead of
  falling off a cliff: the outer shell carries about 8% of the weight the centre
  does. The radii are chosen so this costs nothing in noise, an effective sample of
  3.90·r² against the plain box's 4·r² — the same estimate over half again as much
  ground.

  With both, a synthetic spike of 2000× no longer reaches the clip and the O/E's
  mean stays at 1.00 in every separation band, so no bias was traded for the
  improvement. The cost is a second read of the block: 78 ms at 353², 300 ms at
  841², 1.5 s at 4 M and 7.4 s at 16 M, about double what it was.

  **This reduces the artefact rather than removing it, and on real data it is
  still visible.** The cap bounds a flagged cell's damage by construction — the
  rule permits it to inflate its window by half, which is `log2 0.58` on a scale
  clipping at 0.84 — and two stricter answers were tried and dropped: trimming the
  flagged cell out of the sum and the divisor, and replacing it with the mean of
  its eight neighbours. Both looked better on synthetic spikes and neither removed
  the artefact reproducibly on a real map, which says the detector rather than the
  response is what still needs work. The synthetic used to develop this evidently
  does not reproduce whatever the real one is.

- **The adaptive window may now grow to radius 192, up from 64.** At 64 it ran
  into the cap beyond about 200 bins of separation on a yeast map at 500 bp, so
  the cap rather than the target was choosing the width for exactly the cells
  with the least data. The search is binary, so this costs one more trial radius
  per cell and nothing else.
- **The despeckle now runs before the O/E division, and divides by a baseline
  averaged over the same windows.** Both halves of this were needed to make the
  `smooth` picker do anything visible on an O/E map, which is the picture most
  readers of a sparse map are looking at.

  `observedOverExpected` draws a cell where nothing was observed as paper rather
  than as the strongest depletion on the ramp, and away from the diagonal *most*
  cells are that cell — **98%** of them at 200 bins out on a yeast map at 500 bp.
  Computing the O/E first therefore handed the filter a field that was almost
  entirely `NaN`, which no despeckle will touch, so every setting from `3 × 3` to
  `7 × 7` drew the same picture: a scatter of the 2% of cells that happened to
  catch a contact, at a mean of **45× expectation**, over a blank field.

  Smoothed first, a zero cell with contacts around it is never blanked. That 98%
  falls to **83% at `3 × 3`, 38% at `7 × 7` and 0% under every adaptive setting**,
  and the mean of the band comes back to **1.00**.

  The baseline is averaged over the same windows because dividing a smoothed map
  by an unsmoothed curve is biased: near the diagonal the decay is steep, so a
  window spanning it averages cells whose baselines differ several-fold and the
  ratio reads **24–32% enriched** at radii 3 to 7 — an artefact of the filter and
  of nothing in the file. Matched, the bias sits in both halves and cancels. The
  curve itself is still estimated from the *unsmoothed* block, which is the half
  of the old ordering worth keeping: fitting it to pre-averaged cells would let
  each cell's neighbours count twice toward the baseline it is compared against.

- **The despeckle keeps the cell's own value.** The kernel was `terra::focal`
  with a zero centre weight, on the argument that a cell disagreeing with all
  eight of its neighbours is evidence about the neighbourhood rather than about
  itself. That is right about rejecting outliers and wrong about a sparse map,
  where a lone contact is not an outlier but the only measurement there is: the
  zero-centre kernel replaced it with the mean of the eight zeros around it while
  spreading it into those eight, so **every isolated count rendered as a hollow
  square with a hole where the contact was**, and away from the diagonal most of
  the picture was made of those.

  It was also the wrong estimator for what the filter now feeds — a local rate
  that the O/E divides — since discarding the one cell being estimated at is both
  biased and needlessly noisy. Despeckling survives the change in all but the
  narrowest window: a wild pixel is diluted to a ninth of its excess at `3 × 3`, a
  twenty-fifth at `5 × 5`, and to a few hundredths at the widths the adaptive
  settings reach. What is lost is the guarantee that a single wild cell is
  annihilated rather than suppressed; what is bought is that a single *real* cell
  is no longer annihilated either.

- **Zooming a curve is a rectangle now, and it keeps working.** Dragging across a
  P(s), a slope or any other drawer curve selects a window on **both** axes
  rather than only on the abscissa, and the marquee is drawn as the rectangle it
  selects. A drag that is deliberately flat still means what it looks like: an
  axis is only taken when the pointer travelled at least eight pixels along it,
  so a horizontal sweep is still a band and a mis-click is still a click.

  **And the marquee comes back.** It lived in the plot body, and the rebuild
  after the first zoom replaced that body's children — so the first drag worked
  and every drag after it selected an invisible rectangle, which read as the
  gesture having broken. Double-click still resets, now to the window the figure
  opened on rather than to the full extent.

  The zoom is also no longer a clip of the series arrays. The window travels on
  the output as `xDomain`/`yDomain` and the axes are drawn to it, which is what
  makes a window in y expressible at all — a point above the top of the frame is
  part of the line that leaves it, not a gap in the data — and the series are
  clipped to the frame in the PDF exactly as on screen.

- **P(s) and its slope open on 4 kb – 1 Mb.** Past the ligation artefacts at one
  end and inside the shortest chromosome at the other. The full extent was a bad
  picture of a good curve: the first break holds the diagonal and the first
  off-diagonal — two thirds of every cis contact on a 1 kb map — at a separation
  of 1 bp, so a log axis over all of it spent a third of its width on one point
  and squashed the decades anybody reads into the right-hand quarter. It is a
  default and not a limit: the marquee, the boxes and a double-click all move
  it. The ordinate follows, because an automatic y axis now fits what is inside
  the x window rather than the whole series.

- **APA has no Quality settings.** *Most anchors to use* and *Minimum coverage of
  a window* are gone, not defaulted: every anchor is piled up and every window is
  summed. Both were quietly a change of subject rather than a budget — a cap
  makes the figure a pileup of whichever anchors sorted first, and a coverage
  floor drops exactly the windows in sparse regions, which are the ones a weak
  pileup is weak because of. Two runs could then differ because they had thrown
  away different windows, with nothing on the figure saying so. The accumulator
  counts per cell, so a half-empty window contributes what it has and no more.

- **APA's half-width defaults to 12 bins**, down from 25, and the note about the
  classic APA square is off the control.

- **P(s) is now the quantity HiContacts means by it.** The contact-probability
  task plots the **probability density** — contacts at a separation over all cis
  contacts, then over the width of the separation bin in base pairs — which is
  `HiContacts::distanceLaw()`'s `norm_p`. It used to plot the mean contact per
  *pair of bins*, which is `cooltools expected-cis`. Both are called P(s); they
  agree in shape at short range and part company as the separation approaches
  the length of a chromosome, where the pair count is heading for zero and the
  contact total is not, so an exponent read off the tail of one is not an
  exponent of the other. **This changes the numbers every existing P(s) figure
  was drawn from**, and the ordinate now says `Contact probability density
  (per bp)` to make that visible.

  The expected curve itself is unchanged and is still what observed/expected,
  the compartment chain and the pileups divide by — it just never was the curve
  on screen, and now it is not pretending to be.

  **It reproduces that package rather than resembling it.** The separation is
  HiContacts' gap distance — two bins *k* apart are `(k − 1)·binsize` apart
  there, so the diagonal and the first off-diagonal share the first break — and
  the bins are its break table, which turns out to be exactly
  `unique(round(1.1^n))` and is regenerated from the task's own factor rather
  than tabulated. `test/golden/analysis/hicontacts_ps.json` is built by running
  HiContacts' own pipeline in R (`scripts/hicontacts_ps.R`, the first golden
  whose dependency is a program rather than a Python module), and every break
  position and density matches to 2e-6 on four chromosomes and on the four
  pooled.

## [0.11.0] - 2026-08-14

### Changed

- **`f` folds the Files panel, and the track-fill overlay has no shortcut.** The
  single-letter space was down to `q` and `z` when a fifth panel arrived, and
  neither is a letter anyone reaches for a list of files. Between a column — one
  of five, in the row of marks at the top of every window, whose four siblings
  are `b`, `a`, `m` and `j` — and one of eleven overlay toggles whose button is
  on screen beside the picture it changes, the letter belongs to the column. The
  fill toggle is untouched and still in the command palette; it is one keystroke
  that is gone.

- **Save writes the whole window, and the file is now called a workspace.** The
  disk button in the top bar used to write the tab in front of you, which made it
  the third button on that row doing something a reader could reasonably have
  expected of the other two. It now writes **every open tab in one file** — each
  with its view, its tracks, its marks, its bookmarks, its ticked sequences, its
  table filters and its analysis recipes — and records which one was in front.
  Dropping it back opens all of them.

  The pair of buttons now states a real difference rather than two words for one
  thing:

  > **Share this session as a link** — the tab you are looking at.
  > **Save this workspace as a file** — every tab, with everything in it.

  A link stays one tab on purpose. The advice line already warns past about eight
  thousand characters and a single session with eight tracks is a few thousand,
  so a link carrying six tabs would open by telling the reader not to use it.
  What is new is that both roads carry the *same format* — a link is a workspace
  of one — so there is one parser, one version gate and no way for the two to
  drift apart.

  **A dropped workspace is added, never substituted.** Six open tabs are not
  closed by a drop; they were the reader's, and there is no undo. The one place
  that does replace a window is the offer on the first screen after a browser
  restart, which has asked first. A window showing nothing but the picker gives
  that tab up, and a file with more tabs than the window can hold says how many
  it left rather than dropping them in silence.

  **The file format is a clean break, and old `.metacooler.json` files stop
  opening.** They are a tab where the reader now has a window, and carrying both
  shapes would mean two readers to keep in step for the sake of files that are a
  few weeks old and a re-save away from being current. Saving again from this
  build is the whole of the fix. The published example datasets and the CLI's
  `replay` moved with it — `replay` takes a workspace and re-runs the tab that
  was in front, or the one `--tab <n>` names.

  `GLOSSARY.md` moved with it too. It had *session file* as one of the senses of
  **session** and gave the saved file to `SessionConfig`; there is no such thing
  any more, so **workspace file** is now its own entry and a config is what one
  holds. The glossary's own rule — where it and the code disagree, the code is
  right and the glossary is a bug — is the reason that is part of this change
  rather than a follow-up.

- **On a turned map the guide becomes a vertical line while a stretch is being
  chosen.** At rest the guide under the pointer is a pair of 45° rays, and that
  is the honest answer to *what is this cell*: a turned map's two directions are
  not its two axes, so the cells sharing a place with the contact under the
  pointer are a ray rather than a column. It is the wrong answer the moment the
  next press names an **interval** instead — Shift held, Option held, or a form
  waiting to be pointed at — because then the reader is not choosing a contact,
  and the mark that says where an interval starts is the edge it starts on. So
  the rays collapse to one vertical line at the pointer's own column, and the
  tracks beside the map drop back to a single hairline under it rather than
  marking the two anchors of a contact nobody is selecting. It answers the
  modifier rather than the movement, so pressing Shift over a stationary hand
  changes the guide immediately.

- **Windows installers are temporarily not built.** The `--win` leg of the
  release workflow is commented out, so releases carry the macOS and Linux
  installers and no `.exe`. Nothing about the target changed — `npx
  electron-builder --win` still works from a clone — and the leg is left in
  place, commented, so restoring it is uncommenting three lines. `fail-fast:
  false` meant the other legs never depended on it, and `collect` attaches
  whatever artifacts exist. `docs/desktop.md` and the release body say so, and
  both point Windows readers at the standalone HTML page, which needs no
  installer anywhere.

- **A folded column leaves a tab rather than nothing.** Folding one used to take
  it out of the layout entirely, which left the four marks up in the header as the
  only sign it existed — and a mark in the window furniture says neither which
  column is folded nor what is in it. A folded column now keeps a strip of itself
  with a **tab** standing on the bottom of it, carrying the panel's mark, its
  name, the key that opens it and a chevron pointing the way it will open. The
  tab is turned a quarter-turn anticlockwise, so the name reads bottom-to-top up
  the side of the window like the spine of a book — which is what buys it the room
  to be named at all: a strip wide enough for "General" written upright would be a
  column, and what a folded column has to cost is a strip.

  They **nest**, and it costs no arithmetic: the four columns are already ordered
  outermost-first from each edge, and a folded strip sits exactly where its column
  would. Two folded panels on the left are two tabs side by side at the edge of
  the screen; open General and the Annotations tab moves out to stand against
  it, while General's own tab always stands at the screen edge. The right side is
  the mirror — Analysis at the edge, Aesthetics against it. Nothing is measured,
  so no tab can be left stranded behind an expanded column. A panel with *nothing
  to show* still leaves altogether: a tab is an invitation, and one that opens an
  empty column is worse than the column's absence.

- **The panel buttons come after the name in the header, and the strapline is
  gone.** Four unlabelled marks used to open the row, so a reader identified them
  before reaching the thing that says what they are looking at. They are now a
  group set off from the title by a rule, and the line that explained the app to
  somebody who had already opened it has given them its room.

- **General is marked `file-cog`** rather than a fold arrow. Its three siblings
  are already marked by what they hold — `layers` for the annotation stack,
  `chart-spline` for the picture's controls, `beaker` for what can be computed —
  and an arrow said only "this panel folds", which is true of all four of them.
  What is behind this one is the file and what can be read off it.

- **A Shift-drag now opens the stretch it named on the diagonal.** The gesture
  names a band of one axis and zooms to it; the axis nobody dragged took the same
  zoom and kept whatever centre it happened to have. So the same drag over the
  same stretch of chromosome I landed on a different picture depending on where
  the view had been panned to — that stretch against a megabase somewhere else —
  and nothing on screen said which. What a reader dragging a band out of a
  contact map means is *this stretch, against itself*, so the other axis is now
  centred on the same stretch and what comes back is the on-diagonal square.

  Unchanged where the block has no diagonal to open, which is a `chrI × chrII`
  panel: there the other axis keeps its centre, since pulling it to a bin the
  block does not contain would only jam it against an edge.

### Fixed

- **A ratio drew "present here, absent there" in the colour that means the
  opposite.** `x / 0` is `Infinity`, and it is a real reading — the strongest
  statement a ratio can make in the numerator's favour. The raster tested the
  pooled value with `Number.isFinite` and sent everything that failed to the
  **bottom** of the ramp. That is right for `-Infinity`, which is what `0 / x`
  becomes on `log2`, and it is exactly backwards for `+Infinity`: the cells where
  the first file has contacts and the second has none were painted the second
  file's colour.

  The two arms are the same size — on an *E. coli* pair at 5 kb, 7.7% of cells
  each — so **half of every saturated cell in the picture carried the wrong
  sign**, and the half that was wrong was the half worth looking at. It could
  only be caught at the pointer, where two adjacent cells reading `0.001 · 0` and
  `0 · 0.001` were the same shade of dark blue.

- **A ratio of two balanced maps was silently rescaled, and the rescale ate the
  finding.** `ratio` and `difference` forced the depth match on and hid its
  tickbox, on the grounds that two libraries of different depth differ by a
  scalar and a ratio *is* that scalar everywhere. True of raw counts. Not true of
  balanced ones: ICE puts every bin's marginal at 1, so two balanced matrices
  arrive on one normalisation with nothing left to correct — on the pair above,
  the two marginals agree to 0.2%.

  Matching them again was not a no-op, because `matchGain` does not measure
  depth. It measures the 99th percentile, and the 99th percentile of a Hi-C map
  is made entirely of near-diagonal cells — which is where two conditions differ.
  It returned **1.478** and shifted every cell of the ratio by **−0.56 in
  `log2`**, a quarter of the ±1 range such a map is drawn on: a near-diagonal
  band that another tool puts at +0.60 came out at +0.04, white instead of red,
  and the same comparison made anywhere else disagreed with the viewer. It also
  moved with the viewport, since the gain is measured on the block that was read
  — the same cell reported a different ratio at different zooms.

  Depth matching is now **off by default on balanced values** and on as before
  for raw counts, and the tickbox is offered under all three operations instead
  of being hidden under two of them.

- **The hover readout printed most of a balanced map as `0`.** `fmt.num` rounded
  to three decimal places, and a balanced cell is a fraction — at 5 kb on a
  bacterial genome the typical value is a few times `1e-4`. Two cells three-fold
  apart printed the same string, so a reader checking a ratio against the counts
  under it was shown a pair that could not have produced it. Values below a
  thousandth now keep three *significant* digits, and below `1e-7` an exponent.

- **Two metagenomes selected together hung the tab.** A file with a genome layer
  has no deck for a second one to join (§16.8), and the fallback for that case
  was written as "open it as this session's map" but implemented by calling the
  dropped-file router — which had since learned to send a map back to the
  companion path that was calling it. The pair recursed until the stack ran out,
  in the one place where the fallback was meant to be the calm one. Found while
  giving the header's new add button the same rule to follow.

- **A shared link carried three things it promised not to.** Two comments in the
  codebase already stated the rule — a session's `compare` field says "a shared
  link still cannot" carry a local second file, and the deck's own module says
  spelling a companion's name into a link "would post a private filename to a
  stranger, which `shareLink.ts` already refuses to do". Neither was true. A link
  carried the local compared file, the deck's local companions, and (once
  sessions began recording it) the size and modification time of the sender's own
  file.

  Worse than useless to a recipient: those names are bare filenames, and opening
  one goes through a grant store keyed on the bare name whose guard compares only
  the name — so somebody who had ever granted their own `rep2.cool` would have
  opened **their** file in the sender's slot, with every label on screen
  agreeing. The redaction now happens inside the encoder rather than at its call
  site, so a second caller cannot forget it, and the test asserts against the
  encoded payload rather than the decoded object: the point is that the name
  never leaves the machine, not that the far end ignores it.

  A **local track is kept**, and the rule that decides all of it is now written
  down in both places: a private name is stripped only where the structure
  survives without it. A dropped companion costs a label — the `~` placeholder
  keeps the slot, the count and the order — while a dropped track costs the row.

### Added

- **Connect a folder, and browse it in a panel — a directory on this machine, or
  a bucket, read the same way.** Every door to a file this app had asked *which
  file* once and then closed: the picker, the header's `+`, the browse button
  beside a URL box. That is the right shape for opening one thing and the wrong
  shape for the way people actually work with a directory of data, which is to
  open one, look, open the next, and keep going for an afternoon. Files on a
  bucket could only be added one at a time, and a folder on the disk could not be
  browsed at all.

  A **Connect** button now sits beside the `+` in the header — a plug, because
  what it attaches is a *place* rather than a file — and what it fills is a fifth
  side panel, **Files**, folded with `f`. Inside it: the folders you have
  connected, and the tree of whichever one you are in, with crumbs and a filter.
  Every file row loads into the tab you are in when you click it or press the
  `→` at its end, and every file row can be **dragged** — onto the map's edge
  rectangles for a lane in that stack, onto a companion for a track on that map,
  onto the Tracks card, onto the page. A dragged row carries a folder and a path
  rather than bytes; the file behind it is fetched at the drop, once.

  **A local folder and a bucket are one thing to everything above the byte
  layer.** `browse/folder.ts` is the whole interface — given a path, the
  sub-folders and the files; given a file, how to open it — and the two backends
  are the entire difference between them. It is one column, one tree, one set of
  crumbs, and one filter, over both.

  What a local folder means depends on the browser, and the row says which you
  got. In Chrome, Edge and the desktop app it is a real connection: this browser
  keeps permission to *list the folder and read what is in it* — not the files
  themselves, and nothing is uploaded or copied — so it is still there after a
  reload, and it picks up a file a pipeline wrote into it five minutes ago.
  Firefox and Safari have no such thing; there the folder is a **snapshot**
  taken when you connect it, marked *this visit* on its row, gone after a reload.
  Offering it in two browsers and not the other two would have taken a working
  gesture away to avoid writing one sentence.

  A connected folder is a wider grant than a chosen file, so it is listed in
  **About → what is stored** beside the files you have allowed, disconnectable
  one at a time and swept by *forget everything*. Nothing about §11 changes: a
  local folder is read in place by code on your own machine, a bucket is read by
  your browser from the bucket, and there is no server in between because there
  is no server.

- **A public bucket needs nothing but its link.** A bucket entry used to demand
  six fields, five of which are a key — so a reader with a URL out of a paper met
  a form that read as *you need an AWS account for this*. Public is now the
  default and it is one field; a key is behind a switch. Everything under a
  keyless prefix is listed and read unsigned, which is what public data always
  took.

  One thing to know before pointing it at a bucket: **listing needs
  `s3:ListBucket` granted to everyone in the bucket policy**, which is a
  different grant from the `s3:GetObject` that makes files downloadable, and most
  published buckets grant the second and not the first. A public bucket that
  refuses to be listed is an ordinary configuration rather than a fault, there is
  nothing an app with no backend can do about it, and the message says which of
  the two grants is missing and that files under the prefix still open by URL.
  `docs/hosting.md` has the policy to paste. Browsing a public prefix needs *no*
  CORS change: an unsigned listing is a simple request, so it is never
  preflighted, and the policy that serves public downloads already answers it.

  The dialog behind *private buckets…* is now just **Buckets**, since it lists
  both kinds, and its add form is the one the Connect dialog uses — one
  implementation, so the two cannot come to disagree about what a valid entry is.

- **`correlation`, a new entry in the score picker: the square replaced by the
  Pearson correlation between its rows.** Two bins correlate when they contact
  the rest of the sequence in the same pattern, so the checkerboard this draws
  *is* the A/B compartments — and it is drawn through the same
  `correlationMatrix` and the same `usableBins` the Compartments task solves for
  its eigenvector, not a second implementation "for display" that would agree
  with the first until it did not.

  **It is one entry rather than three controls**, and it belongs in that list for
  the reason O/E is kept out of it. O/E is excluded because it *composes* — the
  standard pipeline is O/E of balanced counts, and folding it in would make
  `balanced` and `O/E` mutually exclusive for no reason but the control. The
  correlation composes with nothing: the cell no longer holds a contact at all,
  it holds a coefficient between −1 and 1 for a pair of bins' whole rows, and the
  pipeline that produces the compartments is fixed at balanced → O/E →
  correlate. So the entry carries all three steps and the reader picks one thing;
  a control per step would be three controls with exactly one legal combination.
  Offered only on a file that carries weights, since a correlation of unbalanced
  O/E is a correlation of the coverage bias — which is per-bin, and therefore
  looks exactly like a compartment. The caption names every step that was
  applied.

  **A dropped bin comes back as a gap**, not as a zero. A zeroed row asserts that
  its bin is uncorrelated with everything, which is a strong and false claim; on
  a map it would be a stripe of definite colour across the checkerboard. The
  scope line says how many were dropped, because a blank row and a sparse corner
  look the same.

  It is the one **cubic** step in the viewer, so it runs on the analysis thread
  — its own client, not the drawer's, so a correlation never queues behind
  somebody's insulation pass — reports a percentage, and is cancelled by picking
  another score. Measured at 32 ms for 232 bins, 232 ms for 464 and 2.8 s for
  929, so the map caps at 1,500 a side.

  Where it cannot be drawn — a second file open under `ratio`, a `contig_A ×
  contig_B` block whose rows and columns are not the same bins, or a square past
  the cap — the map falls back to the O/E underneath it and **the caption says
  so**. That is deliberate: the O/E is a real picture and looks like one, so
  nothing else on screen would betray that it is not what was asked for, and the
  caption is the only part that survives an export.

- **A despeckle, in the `smooth` picker beside the transform.** Each cell
  replaced by the mean of the cells around it with **its own value left out** —
  `terra::focal` with a zero centre weight, which is the filter Hi-C figures are
  usually made with. Off, `3 × 3`, `5 × 5`, `7 × 7`; carried in the link, and
  written into the colourbar caption (`counts · smoothed 3 × 3`), because a
  smoothed map otherwise looks exactly like a map.

  Leaving the centre out is what makes it a despeckle rather than a blur: a cell
  that disagrees with all eight of its neighbours is evidence about the
  neighbourhood and not about itself, and a filter that kept a ninth of its own
  value would carry a wild pixel into the result at a ninth strength instead of
  removing it.

  **It is applied per file, before two files are combined**, which is what makes
  it useful on a ratio rather than merely cosmetic. Smoothing the ratio would
  have to average the `Infinity` and `0` that `x / 0` and `0 / x` produce, and one
  infinite cell poisons every window it falls in; smoothing the inputs makes
  those cells finite *before* the division, because a zero cell with contacts
  around it is no longer zero. On the *E. coli* pair at 5 kb it takes the
  saturated cells of the ratio from **15.3% to none at all** at `3 × 3`, while
  the 0.43% that are genuinely unbalanced bins stay blank.

  Two departures from the R original, both about edges. The divisor is the number
  of cells that contributed rather than the fixed `(2r+1)² - 1`, because here the
  boundary is the *viewport* and the alternative is a dark frame that moves when
  the map is panned; and a `NaN` cell keeps none, because filling it from its
  neighbours paints a measurement over the one place the map is saying it has
  none.

  Cost is flat in the radius — a separable running window rather than `(2r+1)²`
  reads per cell — so `7 × 7` is no dearer than `3 × 3`.

- **A blue–white–red diverging ramp, `BuWtRd`.** Higher contrast than `RdBu_r`
  and with more of its range spent away from the centre, which suits a sparse
  ratio map: most cells sit near neutral, so a ramp that stays pale through the
  first third of each arm spends its colour where there is least to say. Its
  white is anchored to the **middle** of the scale rather than to the fifth of
  its eight stops — spread evenly that would land at `4/7`, and a map of two
  identical files would have come out faintly blue everywhere.

- **A button that adds a file to the tab you are in.** Dropping a file on the
  page has always *added* rather than replaced — a second cooler comes up beside
  the first, a bigWig joins the tracks, a `chrom.sizes` answers a browser's
  guessed lengths — and that is the behaviour the whole content area has taken
  since decks existed. What it never had was a button. Every click-sized door to
  a file went the other way: the file crumb, the brand, *Open a different file*
  and a new tab all replace what is open. So the commonest thing a reader wants
  to do with a second file was reachable only by dragging one in from a window,
  and the controls that looked like they would do it did the one thing that
  loses work.

  The header now carries it, past a divider of its own after the four panel
  buttons: a file with a `+` on it, in every view, opening the picker over what
  is on screen. It is the same picker the file crumb opens — the drop area that
  also takes a click, the URL box, the way into a private bucket — with the
  published catalogue left out, because every entry on that list is a whole
  *session* and offering it here would be offering to throw the tab away from
  the one control whose promise is that it will not. The mark is a *file* with a
  plus rather than the bare `+` one row below it in the tab strip, since that
  one adds a tab and this one adds a file to the tab you are in.

  A URL typed into it takes the routing a dropped file takes, which it could not
  before: a map goes into the deck beside the one that is open, anything else
  goes to the tracks, and a bucket-browsed file carries its own key there. On an
  empty tab the distinction does not exist — there is nothing to add to — so it
  opens instead, exactly as the landing page does, rather than taking a lone
  bigWig and finding no track list to put it in.

- **The picker now says which file it wants back, not just its name.** A session
  saved from a local file names it by its bare filename, and `rep1.cool` is a
  name a reader may well have several of — so the note asking for it now carries
  the size and the modification date the session was made with. That is the
  difference between finding the right file and finding *a* file with the right
  name.

  And when a file arrives whose **name matches but whose bytes do not**, the app
  says so once and opens anyway. That is either the same file re-run through a
  pipeline — legitimate, and worth knowing, because the numbers on screen are
  then not the numbers in the figure — or somebody else's file of the same name.
  The two are indistinguishable from inside the app and one of them is a thing
  people do on purpose, so it is a remark and never a refusal.

  Saying it needed a third way to speak. The shell had a modal, which takes the
  keyboard and demands an answer, and the error view, which replaces what is on
  screen; both are far too loud for *"this opened, and here is something you may
  want to know"*. Notes now appear as a dismissible row under the tab strip,
  where the restore offer already lives.

- **Closing the browser no longer ends the session — it offers it back.** The tab
  strip has always lived in `sessionStorage`, which is a deliberate rule and not
  an oversight: a set of open files is a train of thought, it belongs to the
  window it was opened in, and closing the tab is meant to end it. That rule is
  unchanged, and `sessionStorage` still wins whenever it is present — a reload
  reads it and never looks anywhere else. What is new is an answer for the one
  case it cannot cover, because the storage is gone with the window: the browser
  was closed.

  Alongside it there is now a durable record — every tab, its file, its tracks
  with their colours and limits, its marks, bookmarks, ticked sequences, table
  filters and analysis recipes — written to IndexedDB on a debounce and flushed
  when the page goes away. On the first screen of a browser that was closed with
  work in it, a row above the picker says what was open and when, and offers to
  bring it back.

  **Offered, never applied**, and that is two decisions rather than one. Silently
  reopening six files a week later reverses the decision the reader made by
  closing them; and on a shared machine it would put somebody's unpublished
  figure on screen for whoever sat down next, which is the reader §11 is written
  for. *Start fresh* is a real answer and it deletes the record rather than
  hiding the note, because an offer that returns tomorrow having been declined
  today is not an offer.

  The record holds no file contents and never will. A local file still comes back
  detached, exactly as it does from a reload, so this stage changes nothing about
  what is read or copied — §11 and §12 are untouched, and every browser gets it,
  not only the ones with a file-handle API.

  Two traps are worth recording, because both failed silently and both were
  found by driving the real application rather than by reading the code.

  A restored tab is *primed* — it holds a view state and has read nothing — and a
  config is built by reading that tab's session memory, which after a browser
  restart is empty. So the first click would have gathered eight empty configs
  and written them over the good record. The workspace is therefore applied into
  memory *before* the first tab is primed, which is also the order `applyConfig`
  already required for its own reason.

  And **a window with nothing open is two different facts.** After the reader
  closes their last tab it means *forget this*; at startup it means *nothing has
  been restored yet* — and acting on the second deletes the record while the read
  that would have offered it back is still in flight. A race, resolving
  differently on a warm cache than a cold one, so the workspace disappeared on
  some loads and not others with nothing in the console either way. The rule is
  now a pure function with a test rather than three conditions in the shell.

  A third thing that had to change for any of it to be true: the record follows
  the **workspace**, not the view state. Loading a track, placing a mark and
  saving a bookmark are most of what a session *is* and none of them navigate, so
  a record written at the last navigation came back missing everything the reader
  had done since.

- **A local file you have already opened reopens itself after a reload.** In
  Chromium and in the desktop build, dropping or choosing a file now also hands
  the page a `FileSystemFileHandle` — a *capability*, not a path and not a copy —
  and that is what is kept. A reload, a restored tab or a reopened workspace
  resolves the grant and reads the same file, with no drag and, while the browser
  session lasts, no prompt.

  Nothing about how the file is read changes: what comes back is the same `File`
  object a drop produces, read a slice at a time by the same `LocalFileSource` as
  before. No bytes are stored, nothing is uploaded and nothing is duplicated on
  disk, so §11 and §12 stand exactly as written. Firefox and Safari have no such
  grant to give, and there a local file comes back detached as it always has.

  **The tracks come back too**, which is the larger half of what a reload used to
  cost: a map is one drop and the bigWigs beside it are eight. A restored track
  with a grant behind it says *reopening…* and fills itself in, keeping its id —
  so it does not jump to the bottom of the card — along with its colour, its
  limits, its height and its edge. They resolve in parallel rather than one after
  another, and a grant that turns out to be spent puts the row back exactly where
  it used to land, with the *re-open this file* button that has always been the
  way back.

  Two things this deliberately does **not** do. It does not put local file names
  into the URL hash: this browser being able to reopen `rep1.cool` says nothing
  about anybody else's, so the shareability test the hash is gated on is
  unchanged, and a link still carries only what a recipient can act on. And it
  does not ask for permission on the boot path, because a permission request
  without a user gesture resolves without ever showing a dialog — the reader is
  asked when they click, and never by a page that is merely loading.

  A grant is keyed by the file rather than by the tab, so two tabs on one file
  share it and one `.mcool` at five resolutions is one grant. The row also
  records the file's name, size and modification time, because a local file's URI
  is its bare name and two `rep1.cool` from two directories would otherwise
  collide: a name that no longer matches is refused outright rather than opened,
  since showing the wrong file with every label on screen agreeing is worse than
  asking for it again. A file that has merely *changed* is not refused — a re-run
  pipeline overwriting a file somebody is reading is a legitimate thing to do.

- **The deck and the comparison come back too, and the tracks land on the right
  panels.** These were the two files a reload lost most quietly. A local
  companion is destroyed at *serialisation* — `maps` writes `~` for one — and a
  local second file was never in the hash at all, so neither could even be
  refused: by the time anything could ask, the name was gone.

  Neither is fixed by changing the hash, and that is the design. The `~` is a
  promise to a **recipient** (§16.6): it keeps the count and the order, so a
  shared deck arrives with a drop rectangle where the sender's file was rather
  than silently one map short. Putting a filename there instead would post a
  private name to a stranger and leave their deck trying to *fetch* it. So the
  names live beside the hash, in the session's own memory, as private as the
  files they name — which means a plain reload restores them as well as a
  remembered workspace does.

  A stale note can only ever degrade to today's behaviour: a remembered cell that
  now holds a published map is left alone, and one past the end of a deck that
  has since shrunk is dropped. A companion whose file cannot be re-opened comes
  back as a cell that **names it**, rather than as the link's "a map was here" —
  which is true of a stranger's deck and misleading about a file on your own
  disk.

  And **where a track was drawn is remembered with it**. Until now a restored
  deck put every track back on the first map, however carefully they had been
  arranged across the panels. What is stored is keyed by the *file* each
  companion was showing rather than by its panel id, because panel ids are minted
  per deck and one written down today names nothing tomorrow — so it is seeded
  into the same parking mechanism that already hands a lane back when a map
  reopens its file. Where the companions do not come back, the tracks park onto
  the lead exactly as they always have.

- **A screen that says what this browser is remembering, and a button that ends
  it.** Reachable from the command palette. It lists the durable workspace, the
  per-window entries, the preferences, and — named outright rather than counted —
  any bucket access keys, which are stored in plain text and which a reader
  deciding what to clear on a borrowed machine should not have to press the
  button to discover.

  *Forget everything* means everything: both web storages and both IndexedDB
  stores, swept by one rule over the prefix every key this app writes shares.
  A rule rather than a list of names, because a list only covers the keys
  somebody remembered to add to it — and a sweep that quietly missed one while
  telling the reader it had cleared everything would be worse than no button at
  all. A test reads every `setItem` in `src/` and holds the rule to it.

- **Recentre on the diagonal**, a button in Aesthetics → Map between the turn and
  `O/E`. It slides the view onto the nearest on-diagonal window at the zoom it is
  already at — the perpendicular foot of the picture's own centre on the line the
  two axes name the same bin, which is the least it has to move — without
  touching the region or the resolution.

  Every gesture that lands off the diagonal takes several more of the same
  gestures to come back from, and none of them can be asked for directly: a pan
  is relative, a box is where the hand drew it, and a wheel zoom is around the
  pointer. There is no drag that says *here, but on the diagonal*. Greyed where
  the block has no diagonal — the trans corner of two chromosomes — and while the
  map is turned, where the picture already is one.

- **Rectangles, in the Manual annotations card.** The card drew two of the three
  things people put on a contact map by hand: a line says *this coordinate* and
  an arrowhead says *this cell*, and there was no way at all to say *this block
  of contacts* — which is the mark a domain, a corner peak and a pair of loci
  worth boxing all want. The workaround was four lines making a box out of
  crosshairs, which is four marks to move and four to delete.

  A rectangle is **two intervals**, one per axis, rather than an interval and a
  shape. That is what makes on- and off-diagonal the same mark and any ratio
  expressible: `I:120000-180000` against itself is a domain, two short stretches
  a megabase apart is a corner peak, and a short stretch against a long one is a
  locus against a whole arm — a thing no square could have said. Typed with the
  second box left empty means *the same stretch on both axes*, the same courtesy
  the arrowhead form does for a cell on the diagonal.

  **Drawn with a drag**, which is the gesture a hand already makes for a box:
  press at one corner, let go at the other, with the map's own marquee and its
  coordinate chips showing what is about to exist. The marquee follows the hand
  on both axes — a *selection* is squared because it resolves to one range, and a
  mark does not — and it snaps out to the edges of the cells the two ends are in,
  which is what commits. Holding Shift locks the box to the diagonal, so a domain
  is one gesture. The mode stays on afterwards, as the other two do, because
  marking up a figure is several marks — and a click while the map is waiting for
  a drag places nothing rather than navigating away from the picture being drawn
  on.

  **On a turned map the box is off the diagonal if that is where it was drawn.**
  Both ends of the drag are taken back to the square the band was rotated out of,
  exactly as a click is, so pressing over one contact and releasing over another
  names the rectangle those two contacts span — the one thing a band selection
  there cannot say, since a selection over a turned map is always a stretch of
  the genome against itself. Shift there collapses each end onto its own midpoint
  rather than snapping the pointer, which gives the on-diagonal square through
  the two places the drag ran between. And what is drawn while the hand moves is
  the mark itself, through the code that will draw it for good: a rectangle of
  rows against columns leans at 45° on a turned map and folds where it crosses
  the diagonal, so a rubber band would be a box drawn around a shape that is not
  one.

  Which gesture a form asks for is now part of what it hands the map: the two
  marks that name a place take clicks, the one that names an extent takes drags.
  A plain drag draws the box rather than panning, because a reader who has just
  pressed a button that says *draw on map* is going to drag on the map, and
  asking for a modifier on top of an armed mode with a lit button and a changed
  cursor is asking twice.

  On a **turned** map a box is drawn as the contacts it names rather than as its
  own outline, which is the same rule every other mark there follows: off the
  diagonal that is a parallelogram leaning at 45°, and on it that is exactly the
  triangle a BED domain gets, because an on-diagonal box *is* a domain drawn by
  hand. A box drawn across the diagonal has an image on each side of it; where
  they genuinely fall apart — a locus against a whole arm turns into two stripes
  leaning opposite ways — both are drawn, and where one falls inside the other,
  which is every box drawn near the diagonal, only the outer one is, since a
  second outline in there is the edge of nothing.

  Boxes are anchored in the **lane stacks** the way loops already were, a
  triangle per edge on each axis: a domain boxed on the map puts its two
  boundaries under the tracks, in the coordinate the tracks are drawn in, which
  is where the comparison is actually made. They go out with the loops as
  **BEDPE**, whose six coordinate columns are exactly a pair of intervals — the
  row is the box rather than a summary of it — and they are carried in a session
  file and in per-file session memory like every other mark.

- **bigWigs, gene models and interval sets on a metagenome.** §8.5 gated every
  annotation card on the file having no genome layer, so a `.metacool` had no
  Tracks card, no drop zones and no way to draw a coverage track beside the map
  it was computed from. The argument was that a metacool's axis is contigs from
  thousands of independently assembled organisms, so a file keyed on contig
  names either coincides or misleads.

  The premise was wrong about the files people have. A metagenomic Hi-C dataset
  is **one co-assembly** binned into MAGs afterwards: the names in `/contigs`
  are one namespace — on the reference file, 20,566 sequences with 20,566
  distinct names — and a bigWig over that assembly is keyed on exactly those
  names, in the (contig, start, end) coordinates every other lane here is drawn
  in. The naming ladder (§5.9) was already inert on opaque assembler ids, which
  is what makes the rename safe on a metagenome in the first place.

  So the whole column is offered on every container. What a metagenome needed
  instead of a gate was an honest **report**: a track over a co-assembly covers
  the organisms it was made about, and the sequence counts state that as `794 of
  20,566`, which is arithmetically true and reads exactly like a file that
  failed to match. Where the map has genomes the sentence now counts them —
  *794 of 20,566 sequences, in 4 of 48 genomes: metator_00001_00000, …* — and
  says it as a note rather than a warning, because partial coverage is the
  expected shape of a track here. `__unbinned__` is not among them (§7.4). The
  two real faults keep their voice: no overlap at all, and a cross-convention
  match whose lengths disagree.

  Measured rather than assumed, on the 48-MAG reference file with a bigWig
  written over four of its MAGs: the whole-metagenome picture costs the track
  **three range requests**, because the sample cache asks once per view and bbi
  answers two thousand regions out of one zoom level. No cap was needed.

- **A band dragged across several sequences no longer names a region that does
  not exist.** The reading took the sequence's *name* from where the hand went
  down and the *end* from where it came up — one contig's name against another
  contig's coordinate — which on a whole-metagenome view, where a cell is a
  contig or two and any real drag crosses boundaries, produced things like
  `NODE_…:1-260,000` for a 200 kb sequence. The range parser refused it:
  *Genomic region out of bounds*. So the 4C anchor could not be picked on the
  picture it is most naturally picked on, and the same gesture put an unusable
  string on the clipboard. A band is now clamped to the sequence it began in,
  and never runs past the end of it.

- **4C on a metagenome reads the whole community, and asks one question.** A
  MAG's contacts with everything else in the tube are the reading a metagenomic
  map exists for, and the task was giving back the other one: a profile
  restricted to the anchor's own assembly, with the rest of the file left as
  gaps — one organism pictured as though it had been sequenced on its own. So on
  a `.metacool` the run is now always the whole-file pass, cis and trans
  together, across every contig.

  *Cis only* and *Normalisation* are gone from the form **there, and only
  there**. On a cooler both are real questions and both are unchanged: a
  chromosome is a self-contained thing, cis is the commonest reading and the
  bounded one, and that chromosome's own P(s) is the curve to divide by. On a
  metacool neither survives contact with the file — an anchor is one MAG among
  hundreds, and a decay accumulated from one assembly's contigs is not an
  expectation for contact *between* assemblies, so the ratio would carry two
  meanings in one track.

  The runner settles both keys itself on such a file rather than trusting what a
  stored session or a form filled in on a cooler left behind, and the estimate
  prices the pass it will actually make instead of the four range requests the
  absent toggle would have implied. The arithmetic of both switches is untouched
  and still goldened; what varies by file is which of it is offered. A stored
  session carrying a key for a control the form no longer has at all is dropped
  when the form resolves its defaults.

- **A metagenome is read by genome, and now the gestures agree.** Four things
  on a `.metacool` said otherwise.

  **A click on the whole-file map.** Its three levels are one picture at three
  depths and are labelled and divided by genome at all of them, but only two of
  them resolved a *click* that way: `contig × contig` and `genome × genome`
  opened a MAG's own map on the diagonal and the pair off it, while `bin × bin`
  — the default, the level a reader lands on — opened a region view of the two
  `NODE_` contigs under the pointer. All three now dispatch on one rule, so the
  same gesture means the same thing at every depth (§7.3).

  **The 4C task on those pictures.** The runner has always accepted a whole
  genome as an anchor — cis then means the MAG rather than whichever contig the
  first bin fell in — and three things upstream of it disagreed. The estimate
  refused the name with *this file has no sequence called…*; the locus box
  suggested twenty thousand contigs and no MAG; and at genome level the form
  *invented* a default, reading an axis of 48 genome slots as 48 bins and
  offering `NODE_17248_len_278011:1-48,000` — a real window of the file's first
  sequence, chosen by nobody, ready to run. All three are fixed, and **Pick on
  map** now works there too: a drag on an axis of genomes names the genome,
  which is the only thing it can honestly name (§8.9).

  **The Contact maps card and the deck.** Neither has ever worked on a metacool
  — `compareRefusal` says so, and §16's whole premise is a coordinate system two
  panels share, which two independent assemblies have not — but the card was
  still the first thing in the Annotations column and the `+` edges were still
  on the map. A control whose only function on this file is to invite a gesture
  and then explain that it does not work is worse than no control: both are
  absent now, along with the "add a map" command and the deck a shared `maps=`
  link would have built (§8.5).

- **The map's own metadata, as lanes beside it.** Every file this viewer opens
  carries tables about its own units — a `.metacool`'s `/genomes` with
  completeness, redundancy and GC content in it, its `/contigs` with the MGE
  calls and bin ids the annotator joined on, every cooler's `/bins` with the
  weight it was balanced with — and until now all of it was readable only as a
  table, one row at a time, in a view that is not the picture.

  A new **Metadata annotations** card, between the tracks and the marks, lists
  what the open file carries and draws any of it beside the map. The columns are
  discovered rather than declared, so a file with a column this app has never
  heard of offers it like any other. A row is an ordinary annotation from the
  moment it is added: same colour picker, same rename, same height, same limits,
  same four edges, same multi-map placement, same reorder, same tooltip, same
  figure, same session memory — because it joins the store a dropped bigWig
  joins, which is the argument §18.5 already made for computed tracks.

  **The ink follows the data.** A quantitative column is bars against a value
  axis; a qualitative one is runs of colour with the category written into the
  runs wide enough to hold it, from a fixed colour-vision-safe palette — the
  colours belong to the categories, not to the lane, because they have to mean
  the same thing in the lane above the map and the one down its side. Which of
  the two a column is comes from what is in it, so a cluster id written as small
  integers is a set of labels rather than a barplot of the numbering.

  **What is offered is what the view can show.** One cell of a genome × genome
  overview is a whole MAG and one cell of a bin × bin view is a bin, so a genome
  column draws on all three levels and a bin weight draws on one. A coarser
  column is broadcast down, which invents nothing; a finer one is refused
  upward, because rolling bins into a MAG means choosing a statistic nobody
  asked for and then drawing it in the same ink as a number the file wrote. The
  drop-down lists the ones this view cannot show **disabled, with the reason**,
  and a lane whose view has since coarsened says so in its row rather than
  vanishing.

  **A metacool has an annotations column for the first time.** §8.5's gate is
  about *files* — a bigWig keyed on contig names from thousands of independently
  assembled organisms either coincides or misleads — and it never covered a
  column of the map's own tables, which cannot be matched to the wrong sequence
  because the names are the map's. So a metagenome now gets this card, and only
  this card.

  `/bins` stays bounded, as §3.3 requires: what is read when a file opens is the
  column *names and dtypes*, and a column is then read over the bins the picture
  covers, widened by half so panning costs nothing. A window too large to read
  at once is refused in the row, with the number.

  Giving a metacool a store had one consequence worth naming: the analysis
  drawer decides where a computed result goes by asking whether there is
  somewhere to put it, and "a store exists" is not the same question as "a lane
  can draw". A profile's values live in the annotations worker, which a metacool
  still has none of, so the question is now the second one — profiles stay in
  the drawer that drew them, and a called interval set, whose coordinates are on
  the entry itself, becomes an overlay on the map (§18.5).

  Each column exports as a TSV at **its own** granularity — one row per genome,
  sequence or bin, under `#` lines naming the file, the table and the column —
  because a lane is drawn at whatever level the view is, and checking a bar
  against the file means having the rows the file wrote.

- **Every box that takes a file URL now has a `browse…` beside it.** The bucket
  browser existed and was reachable from one place: the picker's *private
  buckets…* dialog, the screen for typing secret keys into. So a reader with a
  map open and four bigWigs on a private prefix had to go back to the landing
  page, open a credentials form, scroll past an access key to the folder view
  underneath it, and pick a file — which then opened as a *map*, because that
  dialog belongs to the picker and the picker opens maps. The way to load them
  as tracks was to copy four URLs out of the AWS console.

  The folder view is now a component and the four URL boxes all offer it: the
  picker's *open a remote file*, the Tracks card's fold, the Contact maps card's
  fold, and the deck's add row. Each opens the same listing and does its own
  thing with what comes back — a track stays a track, a map added to the deck
  lands in the next empty cell the reader left. The credentials dialog keeps it
  inline, where it still doubles as the check that a key just typed works.

  **A picked file is opened with the key that listed it**, rather than by the
  lookup at the worker boundary. That lookup resolves the same key today, since
  a listed URL is under its scope's prefix by construction — but two scopes may
  overlap, longest-prefix wins between them, and a file reached *through* one
  key should not open under the other.

  There is a filter over a listing, and it is a filter rather than a search:
  `ListObjectsV2` matches a key prefix and never a substring, so what it narrows
  is the level on screen. The line under the list says how many of how many are
  showing, because the failure worth designing against is a reader reading three
  rows out of twelve as a folder holding three files. Truncation outranks it: a
  prefix past a thousand keys is the one case where the list is not the folder.

- **A second map can be opened by URL, from the deck itself.** The boxes existed
  — a file chooser, a URL field and an `add` — and nothing on screen opened
  them: the row was revealed by the command palette alone. So a reader with a
  published cooler and a deck in front of them had a drop rectangle for a local
  file and no way at all to name a remote one, which is the road §11 exists for.
  The deck's bar now opens with **add a map…**, and every empty cell carries its
  own folded *or open one by URL* under the drop hint — with a `browse…` beside
  it, like every other box in the app that takes a file URL. Typed there it
  fills *that* cell rather than the first empty one, which matters in a 2 × 2
  with three gaps. The box lives inside the drop zone rather than under it, so
  an empty cell stays exactly the size of the map it stands in for.

  It is the half that makes a shared deck repairable. A link carries a local
  companion as `~` (§16.6), so the recipient meets a cell they could previously
  only fill from their own disk — and the deck they mended could not be sent on.

- **Each map of a deck can be read as its own quantity.** A companion was built
  with no score picker, on the argument that the score is one of the things a
  deck *shares*. That is right about the default and wrong about the choice:
  four replicates should be one quantity unless somebody says otherwise, and
  "unless somebody says otherwise" needs a control to say it with. Two ordinary
  cases had none — a companion carrying a `/pixels` column its lead has not got,
  and a pair a reader wants at two normalisations — and both ended at a picker
  that does not exist.

  So the corner menu on each map now holds a **score**, built from *that* file's
  own columns, starting on whatever the deck resolved. Picking one takes that
  panel off the shared answer and leaves every other panel where it was; the
  clip goes back to auto with it, because a clip is a pair of numbers in one
  score's units and a balanced matrix is fractions where counts are integers.
  A panel nobody has touched follows the deck exactly as before, and its picker
  follows too — the lead's own control, a link and the back button all move the
  shared score, and a dropdown left on the previous answer is a control lying
  about the map it sits on.

- **Pointing at a track is answered on every map on screen.** The deck already
  echoed a pointer on a *map* to its neighbours (§16.3) and had nothing at all
  for a pointer on a **track**, which is half the gesture: a hand moving along
  one profile asking "what is here" is asking it of every profile in the deck.
  Now the stacks that measure the same axis get a tick at that place, and each
  map gets the small form of the guide the panel under the pointer is drawing
  across itself.

  On a turned map that mark is deliberately **not** the little cross the cell
  echo leaves. A place is not a contact: the contacts it is in leave the
  diagonal along two 45° rays rather than along an axis, so a cross there would
  be two arms pointing at nothing — the horizontal one running through contacts
  between two *other* places, the vertical one through a column that is only a
  midpoint. The mark is the first few pixels of that V, standing on the diagonal
  under the position being pointed at. A square map keeps the cross, where its
  two axes really are the two directions the place is an anchor along.

- **`chr1`, `1`, `01`, `I` and `NC_000001.11` are one chromosome.** Two files of
  the same genome disagree about its names more often than they agree — UCSC
  writes `chr1`, Ensembl writes `1`, a yeast cooler writes `chrI` and the
  `chrom.sizes` beside it writes `01` — and until now every one of those was a
  *different sequence* to this viewer. A `.hic` off 4DN put beside a `.cool` out
  of a local pipeline gave a blank rectangle under a bar claiming the deck was
  one navigation, and the only fix was to go and rewrite one of the files.

  So a deck of files that spell their chromosomes differently is now one deck,
  a track is renamed into the map's vocabulary as it loads, the locus box takes
  whichever spelling you have in your hand, and two coolers of one assembly are
  no longer refused the blended square for the `chr` in front of one of them.

  **The rule is that it never silently matches two different sequences**, and
  everything else follows from it. `length` vetoes rather than persuades: two
  sequences of equal length are not the same sequence, so nothing is ever
  matched *because* the lengths agree, and a match whose two lengths disagree is
  reported rather than taken — hg19's `chrM` and hg38's `chrM` are one name and
  two sequences, two bases apart. A name whose shape is not recognised is
  matched by its spelling and nothing else, which is what makes this safe on a
  metagenome: `NODE_1_length_338947_cov_15.4` is an opaque id from an
  independently assembled organism, and two of them agree by coincidence (§8.5).

  **`X` is the hard one, and the list settles it.** `X` is the tenth chromosome
  of *S. cerevisiae* and the sex chromosome of everything else, and the string
  cannot tell you which — so the decision is made from the whole file: one that
  also holds `IX` and `XI` is counting in Roman, and its `X` is ten; one whose
  numerals stop at `V` is *C. elegans*, and has no chromosome ten to confuse it
  with. Which is also why the reading travels: a companion panel is told how the
  lead counts, because a name cannot carry that and a guess would draw
  chromosome ten under the label `X`.

  Every match says which rule reached it — the `chr` prefix, leading zeros,
  Roman numerals, an organelle spelled another way, the accession — and a panel
  that answered a name it does not itself write prints both spellings under its
  heading. A rename that is invisible is the one way this can be quietly wrong.

  And a good deal is deliberately **not** equated. `2L` is not `2` — a
  *Drosophila* arm is its own sequence — which is the same rule that keeps
  wheat's `1A`, `1B` and `1D` apart. `_random`, `_alt` and `_fix` stay, because
  a patch is not the chromosome it patches. `LG1` keeps its `LG`. `C`, `D` and
  `M` are not Roman numerals here, because no genome has a hundredth chromosome
  and `chrM` needs to stay the mitochondrion. Genome and MAG names are never
  matched at all.

  Two ranges of per-species knowledge are hard-coded and both are arithmetic:
  human's `NC_000001`–`NC_000024` and mouse's `NC_000067`–`NC_000087`. There is
  no alias table to download, no assembly to declare and no network call — the
  three constraints (§1) rule all three out, and a rule that works on a genome
  nobody has published is worth more than a table of the ones somebody has.

  `parseMetacoolerRange` stays a faithful port of `metacooler.ops.range`: the
  conventions are consulted **after** both namespaces have been asked literally
  and the answer would otherwise have been `unknown-label`, so every string a
  file does carry resolves exactly as it did, and a session of one file cannot
  tell any of this exists. SPECS §5.9.

- **`metacooler-run`: the Analysis panel, from a shell.** Fourteen tasks, every
  one of them goldened against cooltools, coolpuppy, pyBigWig and numpy — and
  reachable only by clicking. The moment somebody has two hundred files rather
  than one, clicking stops being the interface and they leave for cooltools,
  which is the right tool and a *different set of definitions*, so the numbers in
  the figure and the numbers in the table stop being the same numbers.

  So: the same kernels, the same writers, the same `#` provenance header. Not a
  port — `RUNNERS` is imported and the job handed to it is built exactly as the
  analysis worker builds one, so a TSV produced in a batch and a TSV produced by
  clicking are byte-identical given the same inputs. If the two ever disagree,
  one of them is wrong and there is a golden that says which.

  ```
  metacooler-run tasks
  metacooler-run insulation *.mcool --window chrII --out results/
  metacooler-run replay session.metacooler.json --over 'data/*.hic'
  ```

  **`replay` is the half that matters.** It takes the session file the Save
  button and the Share link already produce, and re-runs the analyses recorded in
  it — with the parameters recorded in it — over any number of other files. That
  closes a loop the app was missing at both ends: parameters get chosen the way
  parameters should be, by looking at a picture and adjusting until it is right,
  and then applied to the other hundred and ninety-nine with no retyping. A
  transcription error in a batch of two hundred is two hundred wrong numbers that
  look right.

  Built by `npm run build:cli` — a fourth invocation of the same bundler over the
  same source, never an edit to the first. Node needs no loader for it and the
  CLI needs no dependency beyond the app's own.

  Three refusals, each for a reason. **No remote files**: the reader uses
  synchronous range requests, which exist in a worker and not in Node, and `curl`
  is better at the missing half than anything this could contain. **An unknown
  `--flag` is an error**, never ignored — a typo in a script that runs for an
  hour must not quietly use the default. And **a task's own parameters win over
  the CLI's flags** where the names collide, which is `--balance` on six tasks:
  reserving the name first would have set the framing and left the task at its
  default, which is exactly the failure the unknown-flag error exists to prevent.
  The framing's window is `--window` rather than `--region` for the same reason —
  two tasks already have a `region` parameter meaning *which sequence*.

- **A deck's results stop overwriting each other, and become one figure.** Three
  things, and the first was a defect rather than a gap.

  `runAll` has computed one result per panel since the deck existed, and the
  runner stored them keyed by **task alone** — so the fourth library overwrote
  the third overwrote the second. What a batch of four left behind was four
  synthetic tracks and *one* plot: the tracks were filed per map and the figures
  were not. The same map also serves as the composite cache (§18.2), and a recipe
  is params plus framing, and **a batch shares one framing across every target**
  — it is taken once, when Run is pressed. So the reuse test could not see that
  cached eigenvectors were measured on a different file, and a saddle run over a
  deck drew panel B's compartments out of panel A's numbers. Silently, and only
  for the composites. Results are keyed by map and task now, which fixes both.

  With four results to show, the drawer grew **tabs**: one per map, arrows either
  side, and `all maps` last. Both navigations, because they answer different
  questions — a reader checking whether panel three looks like panel two presses
  *next* repeatedly without aiming, and a reader who wants the fourth library
  clicks its name.

  `all maps` is the **overlay**: every map's curves on one set of axes, the
  series named by the map. This is not §18.9's refused differential and the
  distinction is exact: that declined a *subtraction*, on the grounds it is a
  worse version of a picture the app can already make. Four P(s) curves on one
  axis is not a subtraction, derives nothing, and is a picture the app could not
  make — the single most-drawn figure in the literature and the reason people
  leave a browser. The machinery was all here and unconnected: `CurveOutput` has
  been multi-series with a legend and band drawing since it was written.

  A matrix and a table stay per map, and the tab **says which** rather than
  showing three of a task's five outputs and letting the reader assume that is
  all there are. A pileup averaged over four libraries would be a fifth thing
  nobody asked for.

- **The figures answer questions now.** Log toggles per axis, a series picker
  (alt-click a chip to isolate it), a hover readout, a drag across the plot to
  zoom an x range, double-click to reset — and, for a pileup or a saddle, its
  colour range and colormap.

  No chart library, and no second renderer. The whole technique is that **an
  interactive figure is a plain figure of a derived output**: a log axis is a
  `CurveOutput` with `xScale: 'log'` handed to the same `drawCurve`, a hidden
  series is one with fewer entries, a zoom is one whose series are clipped to the
  dragged range. So the PNG is still a redraw and the PDF is still true vector —
  and, the property worth the most, **the export is what is on screen**. A reader
  who zooms into the first decade of a P(s) and presses PDF gets that picture,
  at vector resolution, with its axes relabelled for the range it shows. A canvas
  transform would have given them the whole curve behind a clipping rectangle.

- **Share: the whole session as a link.** §5.5 says the URL carries what is being
  looked at and the session *file* says the rest; both stay true, and neither
  serves the case between them — somebody wants to send a colleague what they are
  looking at, right now. A link carries none of the work, and a file has to be
  attached, downloaded and dropped, by which time the moment has gone.

  So the session — the view, the tracks with their colours and limits, the marks,
  the bookmarks — is deflated and base64url-encoded into the **fragment**. That
  choice is the privacy property, not an implementation detail: a fragment is
  never sent on navigation, so what somebody is looking at never reaches the host
  serving the page. Nothing holds the link, so it cannot expire, cannot be taken
  down, works offline and works in the desktop build.

  What it costs is length, and length is the cheapest of those to give up — a few
  hundred characters for a view, a few thousand for a workspace. The dialog says
  the number when it gets large rather than guessing on the reader's behalf: they
  know where they are about to paste it and the app does not.

  **A third-party shortener is offered beside it, never instead of it**, and is
  named in the button rather than hidden behind a verb, because it breaks two of
  those properties: the link starts depending on somebody else's service, and the
  address of the file being viewed leaves the browser. It is refused outright for
  a session over a local file — the long link is still worth having there, the
  recipient getting the tracks and the marks and being asked for the file, but
  shortening it would post a filename to a stranger in exchange for nothing. If
  the service cannot be reached the long link is untouched and stays on screen.

- **bedGraph and wig open as tracks**, which closes an asymmetry that was
  invisible and slightly embarrassing: the app *wrote* bedGraph — every analysis
  result offers the button — and could not read one back. A four-column bedGraph
  is BED-shaped, the sniffer knew three formats, and the value column landed in
  `name`, so the file came back as a lane of featureless grey boxes with no
  signal in it. Silently, which is the worst of the three ways that could have
  gone.

  A bedGraph *is* a bigWig written out, so it becomes the same kind of thing:
  values held in the annotations worker and sampled per view, which is what gives
  it a range, a ceiling, an autoscale, a colour chip and the ⌘-scroll without one
  line of new interface. What it cannot borrow is the bigWig's on-disk zoom
  levels, so the summary for a window — mean, min and max, the mean weighted by
  covered bases rather than by interval count — is computed when the window is
  asked for. wig arrives with it, both step styles, its 1-based inclusive
  coordinates converted at the parser.

  The new sniffer runs *before* the feature sniffer and is deliberately the
  stricter of the two: exactly four columns, numeric on every row it inspects, or
  a declaration line saying so. A rule loose enough to capture a real BED4 would
  turn every peak set into a signal track of NaN, which is a worse bug than the
  one being fixed, so the suite tests the refusals as hard as the acceptances.

- **A tabix sidecar makes a feature file a bounded read.** Every other read here
  already was — HDF5 through range requests, a bigWig by zoom level, a `.hic` by
  the blocks its rectangle covers — and then a GTF was downloaded whole. The demo
  file is 9.5 MB; GENCODE is five times that.

  Where a `.gz` is BGZF and a `.tbi` is beside it — dropped alongside, or at the
  conventional `<url>.tbi` — only the byte spans holding the sequences this map is
  about are fetched. Against a map of one chromosome that is about a twentieth of
  GENCODE. BGZF and the index are read here rather than depended on, for the
  reason `hic/format.ts` gives at length: the byte layer, its LRU, its request
  accounting and its S3 signature belong to `ByteSource`, and a parser that
  fetches for itself sits outside all three.

  **The fallbacks are the feature.** A plain GTF still works, a bgzipped one with
  no index still works, and an index that is absent, corrupt, truncated or for
  another assembly falls back to the whole-file read rather than refusing the
  track — an index that can prevent a file from opening is worse than no index. A
  sidecar is only asked for when the file is a `.gz`; a span set covering more
  than four fifths of the file is abandoned as no saving; and sequence names are
  matched through the `chr` prefix in both directions, because Ensembl writes `1`
  where UCSC writes `chr1` and reading the whole file over that would be the
  index quietly not working.

  One thing worth knowing before touching it: the fetch has to over-ask by up to
  64 KiB, because a span ends at the *start* of the last block holding a record
  and a block's length is not knowable without reading its header. The decode is
  bounded separately. Without that, a one-sequence read on a densely packed file
  hands back the several sequences that happened to follow it — which the suite
  caught, and which reads as the index working.

- **`.hic` files open, and nothing downstream can tell.** Versions 7, 8 and 9,
  local and remote, at every base-pair resolution the file carries. This is where
  the published record is: most mammalian Hi-C on 4DN, ENCODE and GEO is
  distributed as `.hic` and as nothing else, and until now this viewer could not
  be pointed at any of it.

  It costs no constraint. A `.hic` is block-indexed with a master index at a known
  offset, so a region is a bounded range read through the same `ByteSource` as
  everything else — the same 1 MiB LRU, the same §12 request accounting, the same
  S3 signature for a private bucket. **A block is not a tile**: nothing is
  composited, nothing is cached to be assembled, and a read hands up one whole
  bounded matrix in COO exactly as a cooler's does. If anything the format suits
  §2 better than HDF5 does, its index being two-dimensional — so the off-diagonal
  rectangle this application exists to draw costs the blocks it covers rather than
  a whole row band across the genome.

  The integration is two modules and a seam rather than a second reader.
  `hic/handle.ts` answers the questions a cooler's HDF5 groups answer — a chrom
  table, an offset array, root attributes, a weight column — and
  `metacooler/store.ts` draws a `PixelStore` seam at the *operation* rather than at
  the dataset, because the one thing a `.hic` genuinely cannot pretend to have is a
  globally sorted pixel table. Above those two, `MetaCooler` is unchanged and every
  `layout.kind === 'metacool'` branch in the application falls the right way
  untouched. The resolution ladder is spelled `file.hic::/resolutions/5000`, so the
  entry picker, the URL hash, the refine ladder and a deck descending to its lead's
  rung all work with no code of their own.

  Three translations, each argued in `SPECS.md` §3.6: the synthetic `All`
  chromosome is dropped by name (never by index — the master index is keyed on the
  file's own numbering); normalisation vectors become `bins/weight`, reciprocated
  into cooler's multiply-by convention, with the chosen one named in the info panel
  rather than implied; and fragment-resolution matrices are excluded, because a
  fragment grid is variable bins under another name and §3.3 excludes those from
  the whole application.

  **Checked three ways**, and the third is the one that earned its place.
  Fixtures whose contents are known exactly, across every encoding the format
  allows — v7/v8/v9, short and float values, short and int positions,
  list-of-rows and dense blocks, grid and diagonal block numbering. Then
  `hic-straw`, the reference implementation, as a devDependency oracle over all
  of them. Then `MetaCooler` itself, asserting the ordinary cooler surface answers
  identically. The oracle immediately found what a self-consistent reader and
  writer cannot: they had agreed with each other that the format is big-endian,
  and it is little-endian. It also caught a v9 straddle clause that silently lost
  every near-diagonal block while leaving the distant ones correct — a map with
  rectangular holes exactly where the signal is.

- **Bookmarks: places worth coming back to**, in a card under the hand-drawn
  marks. A bookmark is a **region and a bin size**, and carrying the second one
  separately is the point — on a contact map *where* and *how closely* are two
  questions, a loop found at 1 kb is not visible at 20 kb, and coordinates without
  the grain give back a picture the note was never made against. Nothing else is
  in one: not the zoom, not the colour scale, not which way the map was turned.
  Those are how the picture happened to be drawn, and a bookmark that restored
  them would be a saved screenshot rather than a saved place.

  **Going to one opens the whole sequence, standing on the location** — and that
  is not what typing `chrI:1,200,000-1,260,000` into the region box does. That
  *cuts a block* at those coordinates, so the edges of the picture are the edges
  of the data and panning off them shows paper. A saved place opens `chrI` and
  puts the location in a new `focus` key, which is a window over a block read
  whole: the first thing anybody does on arriving somewhere — look at what is
  either side of it — works. It lands on the diagonal, because a locus is one
  coordinate and a contact map takes two, and both presentations are served from
  the same window: a square map takes it on both axes, a turned one along the
  genomic axis with the other following. Arriving at a second place on the same
  chromosome is a *zoom* rather than a navigation, so walking a list of forty
  peaks costs one read of the chromosome and not forty.

  `focus` is in the hash, so **a bookmark is a link**. It is a one-shot initial
  condition rather than a live position — pan and zoom are deliberately not
  shareable state, and a URL that rewrote itself on every wheel notch would make
  the back button a scrollback — so the link goes on naming the place it was made
  for however far its recipient then wanders.

  **Three ways in, because they are three moments.** A `bookmark` button beside
  `go` on the title line saves the window on screen, for the place you have just
  found and do not want to retype; the round trip to a sidebar to copy coordinates
  you are already looking at was the whole cost of not having it. The card takes
  **typed coordinates**, in every spelling this app's own readout and tooltips
  produce — separators, `kb`/`Mb`, `..` from an IGV or Ensembl URL, and a bare
  position for a loop anchor. And it imports **BED**, which is what anybody who
  has called peaks or loops already has in hand: the first three columns and the
  name, so a narrowPeak, a BEDPE's first mate and a headed table from R all
  import without a format question being asked. It says how many arrived and how
  many lines had nothing in them, because an import that silently keeps four rows
  out of forty has told the reader nothing.

  Every refusal is **said**: a coordinate that will not parse, a picture that is
  not at one place, a file with no regions in it, a place already saved. All four
  are a press that would otherwise appear to do nothing — including pressing
  `bookmark` twice, which is what anybody does when they cannot remember whether
  the first press worked, and which answers "that place is already bookmarked"
  rather than growing a second identical row.

  They are kept in per-file session memory beside the marks, so they survive a
  change of resolution, a switch of view, a deck opening and closing, and a
  reload; and they are carried in an **exported session**, because a list of loci
  walked one after another is work, and it is the one part of a workspace a
  recipient can act on without the bytes.

- **A square map is resized by dragging any of its four edges**, as a band has
  been by three of its own. The handles are the same bars, faint until they are
  approached and lit under the hand, and a **double-click on any of them** — or
  `Home` with one focused, since they answer the keyboard too — gives back as much
  room as there is.

  It is **one number, and every edge sets it**. A band has a width and a depth
  because it is *cut* to fill them; a square block has no shape to choose, so a
  box of any other shape is paper down two sides of the picture. The two ends move
  it at twice the hand, because the box is centred in its column and the edge under
  the pointer has to stay under it; the top and bottom move it at once, and the
  picture grows downward from the stack above it rather than floating in a
  reserved column with its tracks detached.

  The size is a **preference about the window**, like the band's box and the theme:
  it is remembered in `localStorage`, it is shared by every map on screen so a deck
  stays one shape, and it survives the navigation that rebuilds the panel — which
  is the gesture anybody who has just sized a map is about to make. It is clamped
  to the room rather than stored as what was drawn, so a size chosen in a tall
  window comes back in full when that window comes back, and a narrower one draws
  as much of it as fits. It works in a **deck** too, from any panel: the number is
  shared, so one drag resizes every map on screen and they stay comparable.

- **The whole viewer as one HTML file you double-click.** `npm run
  build:standalone` emits a single `dist-standalone/index.html` — every script,
  stylesheet, worker and icon inlined, h5wasm included — and it is attached to
  every release as `metacooler-viewer-<tag>.html`, so nobody has to build it.
  No server, no install, no npm, no clone. Put it on a USB stick or in an
  attachment; the reader opens it and drops a file on it.

  Three situations the site, the PWA and the installers between them do not
  cover: an **air-gapped or HPC machine** with no route to the website, a
  **reviewer** who will not install an unsigned binary, and a **laptop holding
  unpublished patient-derived data** whose owner would rather not take anybody's
  word about what leaves it. Nothing is uploaded from any build of this app, and
  §11 has said so from the start — but this is the build where that is not a
  claim. There is no origin to upload *to*.

  **Four things a `file://` page cannot do**, each measured in Chromium before a
  line of the config was written, and each absolute rather than degraded: it
  cannot construct a module worker, cannot fetch a sibling `.js`, cannot reach
  the network at all, and cannot register a service worker. So the workers are
  classic ones over blob URLs (`?worker&inline`, `worker.format: 'iife'`), the
  whole graph is one chunk (`inlineDynamicImports`), and the interface is honest
  about the third: remote URLs, the published examples and the version picker
  are **absent** in this build rather than present and failing. The fourth needed
  no change — `pwa.ts` already treats a refused registration as "this page has
  no cache".

  The one thing that turned out not to be a problem is the largest: h5wasm ships
  its wasm base64-inlined in its own JavaScript, so there is no `.wasm` to fetch
  and nothing to work around. It is also why the file is about 11 MB, four fifths
  of it that runtime, appearing twice because two workers need it and a `file://`
  page has no shared chunk to give them. It gzips to about a fifth of that in
  transit; on open it is roughly a second of parsing with no HTTP cache behind
  it.

  `scripts/standalone-shape.mjs` states the shape as rules the build enforces and
  a test holds, because **every one of these failures is silent**: a page that
  kept a `<script src>` paints its shell and then stops, and one that kept the
  module worker format looks completely normal until a file is dropped on it.
  One file, within a size band, no external reference, no root-absolute path, no
  `{type:"module"}` worker. `scripts/smoke-standalone.mjs` then drives a real
  Chromium at a real `file://` URL and opens a real `.hic` through a real worker,
  because every one of those rules can pass on a page that does not run.

- **A saved tab records which file it was made from.** Name, size and
  modification time, for a local file. It reads as bookkeeping and it closes a
  real hole: a tab names its file by URI, that URI is the bare filename for a
  local file, and opening one goes through a grant store keyed on exactly that
  name. So a workspace received from a colleague and naming `rep1.cool` opened
  **this** browser's `rep1.cool` — somebody else's data under the sender's marks,
  bookmarks and colour limits, with nothing on screen disagreeing.

  It informs and never vetoes. A re-run pipeline overwriting a file somebody is
  reading is a legitimate thing to do, and the app cannot tell that from a
  different file on another machine — so a mismatch is said once and the session
  opens. Absent for a remote file, whose identity is its URL, and stripped from
  shared links, where it would be metadata about a private disk.

- **A saved file from a newer build was read as though it were current.** The
  format carries a version, and `CONFIG_VERSION`'s own docstring says the number
  is bumped only when a field **changes meaning** — so the single situation it
  exists for was the one situation nothing acted on. A file whose `vmin` meant a
  percentile would have been drawn as a log10 value, with every label on screen
  agreeing.

  It is now refused, and there is deliberately no *open anyway*: a version bump
  cannot say which field moved, so the button would be an offer to be silently
  wrong. When a bump does happen the honest fix is a migration on that line
  rather than a way past it, and the comment says so.

  Refusing needed a **reason** rather than a `null`, because two of the three
  sentences a reader used to get were false. A file from a newer build landed
  them on "is a JSON file but not a saved workspace", and a *link* from one on "may
  have been cut short in transit" — both sending somebody to inspect the file, or
  their network, when what is actually wrong is the build they are holding. All
  three roads now say the same true thing, naming both format numbers and the
  build the file came from:

  > `figure3.metacooler.json` was saved by a newer version of the viewer —
  > (meta)cooler 9.9.9, in workspace format 2. This build reads format 1. Update
  > the viewer, or ask for the session to be saved again from this one.

  A shared link also now separates *did not survive the journey* from *arrived
  intact and this build will not read it*. Only the first is the link's fault,
  and telling a recipient the second was truncated sends them back to the sender
  for a fresh copy that will fail identically.

- **A workspace published beside its data broke the moment it named a deck.**
  `resolveConfig` points a tab's relative file names at wherever the file it came
  in was found — that is what makes `demo/yeast/` a folder anyone can copy to a
  bucket, to a colleague's bucket, or to a laptop. It resolved the map, the
  compared file and the tracks, and it had never been taught the three fields a
  tab grew when decks, lanes and local companions started travelling. So a
  published workspace naming a companion `rep2.cool` handed the deck a bare name,
  which was fetched **against the site root** — a 404 on the website, and
  `app://viewer/rep2.cool` in the desktop build. It read as a broken panel rather
  than as an unresolved name.

  `state.maps` now resolves through the deck's own parser rather than a second
  `|` splitter written beside it: the rule that a raw pipe separates and a `%7C`
  inside a member is data lives in one place, and a second copy of it fails by
  resolving to a *different number of maps* than were written.

  `lanes[].uri` resolves through the **same** call, and that pairing is
  load-bearing. A lane names the *file* its companion was showing and is matched
  by string equality, so resolving one and not the other would put every placed
  track back on the first map — a perfectly legal lane, drawn without complaint,
  and not where the sender put it. The test asserts the two against each other
  rather than against a literal, so it cannot pass with both halves wrong.

  **Two fields are now dropped rather than resolved**, and that is the more
  interesting half. A local compared file and a deck's local companions are bare
  filenames from the sender's own disk. Left alone they reach the grant lookup,
  which is keyed on the bare name and whose guard compares only the name — so a
  recipient who had ever granted their own `rep2.cool` would open **their** file
  in the sender's slot, with every label on screen agreeing with them. Resolving
  them instead would mint a URL for a file that was never published. Dropping
  them costs only a label: the `~` placeholder still holds the slot, so the
  count, the order and the drop rectangle all survive.

  A *local track* is kept, and the rule that decides both is now written down: a
  private name is stripped only where the structure survives without it. A
  dropped companion costs a label; a dropped track costs the row, and a recipient
  silently receiving seven tracks where eight were sent is the exact failure the
  placeholder exists to prevent.

- **Which score the cells were drawn from did not survive a link, a reload or the
  back button.** `score` has been in `KEY_ORDER` since the field existed, so
  every hash the app wrote carried it — and `parseViewState` never read it back.
  The round trip `state/ViewState.ts` requires of itself in its own header was
  broken for exactly one of its twenty-two keys, and silently, because what a
  dropped `score` lands on is `count`: a legal picture of the same region, in the
  same colours, with nothing on screen saying the quantity had changed.

  Three things it cost, none of which looked like the same bug. A shared link
  naming `balanced` or `ICE` opened on raw counts for the recipient. A restored
  tab did the same, because the tab strip stores that very string
  (`app/sessions.ts`). And the back button did it *within* a session: `readHash`
  re-parses on every popstate and compares by serialising, so it saw a
  difference, adopted the parsed state, and redrew a different quantity — press
  Back after a bookmark and the map changed meaning.

  The parser now reads it, as an open string like `colormap` rather than against
  a closed list, because which `/pixels` columns exist is a fact about the file
  and not about this build; an id this file has no column for is repaired by
  `scoreFor`, exactly as a link naming a missing genome is. The round-trip test
  gained the case, and a second one that would have caught this on the day it
  was written: a state with **every** key set at once. Each of the twelve cases
  there is a picture somebody looks at, which is why none of them covered a key
  no case happened to use.

- **An exported session forgot how its deck was arranged.** `deck:starred` and
  `deck:columns` are per-file session memory like the ticked sequences and the
  table filters beside them, and they were the two scopes `buildConfig` walked
  straight past. `state.maps` says which maps a session holds, so those came
  back; the arrangement around them did not. A deck of six exported at three
  columns reopened at whatever the importing window computed for itself, and the
  Analysis column reopened pointed at the lead rather than at the map the sender
  had starred — both silently, because both are legal decks.

  Nothing is validated on the way in, deliberately: `PanelDeck` already refuses a
  column count it cannot use and already moves a star naming a slot it did not
  build back onto the lead. A second copy of those rules in the config reader
  would be a second place to keep them in step.

- **Shift stopped sticking the readout to the diagonal as soon as the pointer
  moved.** Shift is the map's on-diagonal modifier — a Shift-drag names a stretch
  and opens it there — and holding it snaps the crosshair and the coordinates
  onto the diagonal so the reader can see which stretch that would be. Pressing
  the key snapped them; the first pixel of movement put them back, because the
  key press asked for Shift and the pointer move asked for Option-with-Shift.
  That is the one shape of bug a reader cannot report: it worked until they
  moved. Both now ask the same question, and a key event reconstructs the state
  of the modifier it did not carry rather than assuming it is up.

- **A turned map's card went on describing a cell while the pointer was naming a
  place.** With a modifier down the crosshair stands up as a single vertical line
  — the edge a band would begin on — and the card beside it still printed the two
  loci under the pointer and the distance between them, which is a fact about the
  cell and not about what the next drag would select. Held, the readout now names
  the position along the bottom and nothing else: the midpoint of the pair, which
  is what a turned column stands over and the same number the ruler is printing.
  Let go, it is a card about a cell again.

- **An arrowhead sat on a corner of the very cell it pointed at.** The glyph is
  stood off along its own 45° axis, which puts it four pixels from the mark's
  anchor — and the anchor is the cell's *centre*, so the gap cleared the centre
  and not the corner. At any zoom where a bin is a handful of pixels, the tip
  covered the last row and column of the cell the reader was being asked to look
  at, which is the one thing an overlay here is not allowed to do. The whole
  glyph now stands a further pixel out, square to the axes: right and up in the
  upper triangle, left and down in the lower. Turned, where it stands straight
  over the dot, the extra pixel is vertical only — a sideways nudge there is a
  nudge to a different separation, and so to a different pair of loci.

- **Publishing the demos switched private buckets off, and the error blamed the
  wrong setting.** An S3 CORS policy is bucket-wide — the rules have no prefix
  condition — and `put-bucket-cors` replaces the whole document rather than
  adding to it. `scripts/publish-demo.sh` wrote one rule, correct for public
  data and naming `Range` in `AllowedHeaders`, so every run wiped whatever
  allowed signed requests: from then on the landing page and every pasted demo
  URL worked exactly as before, and no private prefix could be read or browsed
  from any origin. The policy now carries both rules, and the verify step
  preflights the signed headers rather than only the unsigned read — the check
  that would have caught this, and the one nothing above it can, since every
  other call it makes is answered by the public rule.

  The message shown when the preflight fails sent the reader somewhere else
  entirely: it said the policy had to name the page in `AllowedOrigins` because
  `*` "is not enough for a credentialed request". A credentialed request is one
  carrying cookies or a client certificate; this app sets `Authorization` from
  script, sends no cookies, and a wildcard origin answers its preflight
  perfectly well. So the advice was to narrow a list that was not the problem,
  which changes nothing and leaves the one wrong line — `AllowedHeaders`,
  missing `Authorization`, `x-amz-date` and `x-amz-content-sha256` — in place.
  It now names that line, and says that a bucket serving the demos correctly is
  expected to fail this way. `docs/hosting.md` carried the same claim and no
  longer does.

- **A batch ran on fewer maps than its own button counted.** *Run on all N maps*
  over a freshly opened deck ran on the ones that happened to be ready and left
  the rest behind — and said nothing, because a result that never arrives looks
  exactly like a task that had nothing to report. Pressing again worked, which
  made a question about timing look like a question about the file.

  A companion opens to *draw a picture*: the two tables an analysis needs are a
  further pair of reads it makes only when it is starred or batched, so an
  eight-panel deck does not fetch sixteen tables to show eight rectangles. The
  batch took the list of maps that could answer *at that instant*. It now waits
  for the ones still opening — every panel at once, since these are two small
  reads against workers that already exist — and the button counts every cell in
  the grid rather than only the ready ones, because every cell is going to be
  run on. A panel that genuinely cannot answer is still left out, and its own
  note already says why.

- **Dragging a lane on a companion moved the first map's lane instead.** The
  handle on a track's lane is dragged onto another edge to move it there, and on
  a companion it moved the wrong picture: the track jumped to the edge on the
  **lead**, and the map the hand was actually over was left exactly as it was.

  One call was doing two jobs. `place` writes the *track's default placement*,
  which is what the row in the Tracks card shows and what a session with no deck
  means — and the lead's lane follows it, because that control is the lead's.
  Every gesture went through it, including the ones made on a picture that is
  not the lead. Now they go through a call that takes the map they were made on:
  the drag, the drop of a row onto an edge, the lane's own right-click menu and
  the location control all move *that* map's lane, and the axis still turns on
  the way across so the lane arrives reading the same way up as its neighbours —
  as a lane override on a companion, which is exactly why `flip` is one of the
  two fields a lane may differ on.

  It bit computed tracks hardest, because a computed track opens on the left and
  wanting it under the map is the first thing anybody does with one.

- **Closing a deck left a companion's tracks drawn nowhere.** Putting the grid
  down is a statement about layout, and the two things a reader means by it are
  that the extra pictures should go and that the work they did on them should
  not. A coverage track computed on the third replicate simply disappeared —
  still imported, still in the list, drawn on no map — which reads as the close
  having deleted it.

  A departing map's lanes now come to the **lead**, at the edge they were on,
  and the reader gets them back where they were the moment a map opens that file
  again. Keyed on the **file**, never on the map: a map id is a slot minted per
  deck and a deck closed and reopened mints new ones, so the id a lane was
  parked under would never be seen again — what a reader means by "that map" is
  the file it was showing. A track the reader had deliberately put on *both* the
  lead and a companion is not rearranged: the lead's lane is not going anywhere,
  and moving it to wherever the departing copy sat would be the close changing
  something nobody asked it to.

- **The score sat last in a companion's corner menu and first in the Map card.**
  The same five fields in two orders, on two maps of one deck. It leads both
  now, which is where it belongs: what the numbers *are* is the question the
  transform, the ramp and the clip all answer about.

- **A computed track had no way to say which map it belongs to.** §18.5's whole
  claim is that a per-bin result *is* a track — same colour chip, same name,
  same limits, same four edges — and the Synthetic card was the counter-example:
  it carried the colour, the name, the eye and the exports, and nothing at all
  about where the lane is drawn. The Tracks card's own location control is now
  on those rows too, from one module rather than two, so a computed lane and a
  loaded one are moved by one gesture: four edges, a row per map once a deck has
  more than one, and *every map* / *no map* beside them.

- **A task run across a deck skipped the file that spells its chromosomes
  differently.** Three `.cool` files and a `.hic` beside them, Run pressed on
  compartments: three tracks and three sets of A/B intervals came back, and the
  `.hic` produced nothing at all.

  A batch (§18.2) runs *one* set of parameters against every panel, and those
  parameters were filled in against the **starred** map — so the ticked sequence
  list is that map's spellings, a typed region is, and a loaded BED was renamed
  into the session's on the way in. The worker then matched them by string.
  `MetaCooler.contigId` is a faithful port of cooler's own lookup and knows only
  what the file writes, so on the panel that writes `1` where the others write
  `chr1` every name matched nothing, and the run ended on *none of the ticked
  sequences has any bins in it* — true, and not the reason.

  Names that arrive from outside the file now go through the same door §5.9
  gives every other holder of a name list: the literal answer first, the
  conventions only where that would otherwise be a refusal, and the naming
  context of the list the name *came out of* carried with it — a ticked list is
  the source file's own spellings, so it is what says whether its numerals are
  Roman. Compartments, insulation, P(s) and APA all read through it, so a
  region, a ticked sequence and a BED anchor each resolve on every panel of a
  deck.

  **And a short run now says why it was short.** A sequence a file has not got
  is not an error — a deck holds different assemblies on purpose — but the ones
  that were left out are named, and a run that matched nothing says so and lists
  what the file does have, rather than reporting a clean result over nothing.
  The one thing still refused is a bare `X` with no list behind it: it is the
  sex chromosome far more often than it is the tenth, and only the list it was
  written in can say which.

- **Picking a locus for 4C zoomed the map out from under the pointer.** *Pick on
  map* is a mode: while it is armed a plain drag names a stretch of genome for
  the form that asked, and nothing else. It zoomed as well, every time, and the
  reason is an ordering. The mode disarms itself the moment it has an answer —
  one pick per arming — and it disarms by calling straight back into the map to
  say the next drag zooms again. The map then consulted that setting on the line
  *after* it reported the band, so what it read was the mode the gesture had
  just left. The reading is now taken before the report, which is the rule the
  same gesture on a lane stack was already following.

- **A turned map's echo marked a place no track has anything at.** Hovering one
  map of a deck leaves a tick in the tracks beside every other map, and under a
  turn that tick was drawn at the column the echoed cell sits in — which is the
  *midpoint* between the two places the contact is between, and a coordinate the
  profile below has nothing at. It is two ticks now, one per anchor, and one
  where the two are the same place, which is exactly what the panel under the
  pointer was already doing with its own crosshair.

- **The desktop app's header carried a broken image, in every release that had
  one.** `publicDir` is off for that target — deliberately, and it is one of the
  two guards that no dataset reaches the installer — so the one file from
  `public/` the renderer actually asks for, `icon-192.png`, was never emitted and
  `markUrl()` resolved to nothing.

  The pinned build had hit this first and solved it privately, with a nine-line
  plugin inside its own config; the desktop config was written afterwards by
  somebody who had no way to know there was a problem to solve. So the plugin is
  now `scripts/shell-icon.mjs` and both configs call it — the same argument
  `pwa-tags.mjs` makes for itself in its own docstring, arrived at from the other
  direction. The next config to switch `publicDir` off inherits the fix rather
  than the bug.

  Emitted rather than inlined as a data URI, which is what the standalone target
  does: the desktop renderer has no size pressure, `img-src 'self'` already
  covers it, and there is still exactly one drawing of the mark.

- **Hand-drawn marks were lost on a change of resolution.** Placing two marks on
  a map at 2 kb and picking 5 kb in the breadcrumb drew an unmarked map, in a
  single view and in a deck alike — and lost them in the worst way, invisibly:
  the marks stayed in storage under the old level's own key, so they came back if
  the reader went back to 2 kb and stayed gone if they did not, which reads as the
  app deciding at random whether to keep your work.

  A session's memory of a file — the marks, the ticked sequences, a table's
  filters, how a group of tracks is scaled — hung on the URI it was *opened at*,
  and for an `.mcool` that URI names an entry: `…/Ecoli.mcool::resolutions/2000`.
  Changing resolution reopens the file at another entry, so it asked a key nothing
  had ever been written under. It is now keyed on the **file**, the path before
  `::` — the definition `reopeningSameFile` already uses, and the reason a change
  of resolution carries every field of the view state across. Everything under that
  key is the same kind of fact: a mark is a contig and a base pair (§8.1), a ticked
  sequence is a name, a filter is a phrase about rows, and none of them means
  anything different at another bin size. Two tabs on one file stay two workspaces,
  because the session id is the other half of the key. Tracks were the exception
  that hid the size of this — they are handed across the reopen live rather than
  recalled — which is why it surfaced as "my annotations are gone" and not as
  everything at once.

- **A deck of square maps drew them at whatever size their canvases happened to
  be left at, with air between them.** Two maps at 1 kb came up as 182-pixel
  pictures in 430-pixel cells; changing resolution in the breadcrumb moved them to
  320 and still never reached the cell; and turning the map and back was the only
  thing that settled it — which is the shape of the report that named this bug.

  A map's box sits in a grid track sized from its own contents, because a map has
  to be able to give width back to the lane stacks beside it. Inside a deck its
  width was `min(100%, …)`, and a percentage with no definite containing block
  falls back to intrinsic sizing — which for a box whose only child is a canvas
  means *the canvas's own pixel size*, a number derived from that same box a frame
  earlier. A change of resolution is a new canvas, so the circle settled somewhere
  new; a turn writes lengths, so it broke the circle. Both the lead's rule and the
  companions' fallback are now the size the panel measured, and
  `test/unit/deck-plot-css.test.ts` keeps them numbers — the same fault had already
  been fixed once for a turned companion's height.

- **A turned map now takes the room it is given, whenever the room changes.** A
  band's rectangle is the one picture in this app whose size is a number the panel
  computes rather than a length the stylesheet sets, and only some of the roads
  into it redrew that number. So the band kept the width of the window it was
  first drawn in: folding two columns handed it three hundred pixels it never
  took, pressing the turn toggle drew it to a room measured before the fold, and a
  window resized around it left it where it was. All four roads — the shell folding
  a column, the view's own resize observer for a window or a new lane, a turn
  arriving or leaving, and a deck relaying out — now end in one place that
  re-measures the room and redraws the box, and the band's depth follows on the
  next frame as it always did. A width the reader *dragged* is still theirs: it is
  clamped to the room rather than grown into it, and a double-click on the handle
  gives back "as much as there is room for".

- **The band on a long chromosome aliased while scrolling into it.** Pooling caps
  each axis on its own, which is right for a genome pair — the two axes are two
  different sequences, and halving the short one to suit the long one loses
  detail nothing asked for. On a **turned** band the two axes are one measure: the
  rotation is isometric, so a raster pixel four cells across and two up is drawn
  as a rectangle where the geometry promises a square. E. coli at 1 kb turned is
  9,281 × 4,039, which pooled to 4 × 2 — and then every decision downstream had
  one answer for two scales. At the crossover the x axis was *magnified through a
  blur* while y was still point-sampled; past it, nearest neighbour laid cells
  down two device pixels wide and one tall. Against structure that runs at 45°
  that is a cross-hatch of smeared diagonals over the whole band, which is what a
  reader saw as aliasing at the very zooms they had scrolled in to look closely.

  A turned band now pools with **one stride on both axes**, so its raster pixels
  are square in matrix space, the filter question has one answer, and the pyramid
  level is the right one for both directions. It costs no memory (E. coli's band
  is 4.2 M pixels where it was 4.7 M) and no detail worth having: the axis that
  loses resolution is the one that was already being drawn at three cells per
  device pixel, and zooming in re-reads the window at a finer grid anyway.

- **Marks could not be placed by pointing at a turned map, which is every map a
  region view opens.** `pick on map` collected nothing and the right-click *Mark
  this point* menu did not open at all — silently, both of them, because a click
  that places nothing looks exactly like a click that missed. Typing coordinates
  worked and the marks drew correctly once they existed, so the feature looked
  broken in the one presentation it is most useful in.

  One conversion is behind both gestures: a cell into the pair of loci a mark
  names, one per axis, which is what lets a single click serve a line, a
  crosshair and a loop. It read the loci off the axes the *picture* is drawn
  against, and on a turned map the row axis of that pair is deliberately absent —
  y there is distance from the diagonal, which is not a place, and x is counted
  in half bins. The cell is now taken back to the square it was rotated out of
  and read against that block's own two axes, which is what the tooltip, the
  readout and the region-opening selection have always done. Clicking a dot in
  the band therefore marks the loop it *is*: the two ends of the contact, 10 kb
  apart at ten rows up, rather than nothing at all.

- **The three track tasks failed with "nothing is open" in a session that has
  no contact map.** A metaplot, a track correlation and an interval overlap read
  the loaded tracks and never touch a matrix (§18.3) — the 1D browser session is
  exactly where a reader has the bigWigs and not the map, and the panel is
  offered there deliberately. Everything on the way was ready for it: the context
  is built without a file, the framing falls back to one over the tracks. The
  last line still assuming a matrix was the *target* a result is filed under,
  which came from the open file and so from nothing at all.

  It now comes from the genome the tracks were loaded against, and a target with
  no file behind it is no longer a broken target: a chain that mounts nothing
  does not need something to mount. A map task that reaches one refuses in its
  own words — *Diamond insulation reads a contact map, and this session is
  browsing a genome without one* — instead of the queue's old "nothing is open"
  for a session with a genome and nine tracks in it.

- **The map aliased near the diagonal on screen while the exported figure did
  not.** A canvas filter is one bilinear tap: it reads a 2 × 2 neighbourhood per
  destination pixel, which is a filter down to a halving and a fiction past it.
  A whole chromosome at 1 kb is a 3,000-pixel raster drawn into 460, so seven
  cells of every eight were never read — and on a turned map, whose lattice is
  half a bin and shifts parity row by row, what beat against the pixel grid was a
  moiré of diagonal stripes across the band. The export was spared because 300
  dpi is three times the density: the same tap had a fifth of the work to do.

  The view now keeps **halved copies** of the raster and samples the one nearest
  the size it is drawing, so the filter is never asked to reduce by more than a
  half — which is the one reduction it does honestly. Levels are built on demand
  and dropped with the raster: a region view drawn a pixel per bin builds none,
  and no level is ever built for a frame that does not ask for it. Magnified
  pictures are untouched, still nearest-neighbour, still crisp to the bin.

## [0.10.0] - 2026-08-11

### Added

- **Zooming sharpens the picture.** A block larger than the screen has arrived
  coarsened since pooling landed — a whole yeast genome at 1 kb is drawn at
  3.0 kb cells, and the note under it said so honestly and told you the remedy
  was to open something smaller. That was true and it was not the interaction
  anybody has in their hands. A zoom that **settles** past what the block can
  show now reads that window again at the grid the picture could show: on the
  demo yeast cooler, 3.0 kb becomes 1.0 kb on one bounded read, and on a file
  that size the read comes out of the chunk cache without touching the network.

  It changes one clause of SPECS §2 and leaves three standing, which is the whole
  design. There is still no tile server, nothing is cut into tiles, and no
  picture is ever assembled out of parts: what is drawn is always exactly one
  bounded block. **A gesture still costs nothing** — the read goes out after the
  window stops moving, never during it, and neither the renderer nor the panel
  holds a reader to issue it with. It **terminates**, because there is no grid
  below the file's own bins: one step for a whole yeast genome, three for a human
  chromosome at 5 kb, and *none at all for a MAG*, whose block already is the
  finest data in the file — §2's own case is untouched. And it is **bounded by
  the view**: a zoom can never widen past the domain the view was entered on, so
  it cannot become the full pixel scan §7.3 gates.

  Zooming back **out** is served the same way and is usually free: two or three
  whole blocks are kept, so leaving what a fine one covers falls back to a coarse
  one still in hand. The colour range is measured from the widest of them and
  does not move while you zoom in — coarse cells are sums of bins, so a finer
  block holds smaller numbers, and re-measuring would re-brighten the map for
  somebody who changed nothing but the magnification.

  It refines under an O/E map, under two files blended on the diagonal, under a
  45° turn, and in every panel of a deck independently — the last of those
  because the navigation lock's currency was always base pairs, so five maps at
  five resolutions were already in step. The one picture that does not refine is
  the genome × genome overview, whose axes are sequences rather than positions:
  a cell there *is* a contig, and there is nothing finer to go to.

  The moment it happens is **shown**, not hidden. Crossing the edge of what the
  block can show freezes the map — no pan, no zoom — and puts a spinner in the
  corner of the plot until the new grid lands, so the picture is exactly where
  you left it when it sharpens and the change is one you can watch happen.
  Escape calls the read off and gives the map back, so no file can lock it.
  Panning to the edge of the block reads the next stretch **at the same
  resolution**: panning is a change of place, not of scale, and getting that
  wrong hands a reader back a four-times coarser map for dragging left.

  The key in the corner now names the cell size, on its own line, and in
  exported figures too. It is the one thing about a refining map that the pixels
  cannot tell you.

  **Off by default**, because a zoom that reads is a zoom that can wait and §2's
  promise has always been that it does not. The switch is the first of the three
  on the map's `picture` row — three bars, coarse at the top, fine at the bottom
  — beside the 45° turn and the O/E baseline, and **Read finer data as you zoom**
  in the command palette does the same thing. Off is exactly the old behaviour.
  The note under a pooled map now ends
  `· zoom in to sharpen` or `· open a smaller block to sharpen` depending on
  which. `MULTIRES-ZOOM.md` is the study this came out of, with a closing section
  on where the built thing differs from the plan.

- **The resolution ladder drives the zoom (§3.4, §9).** "Wire the entries to the
  zoom control" has been in the spec since the first draft and in README's own
  list of gaps as *inferred but not driven*. A zoom now reads from the
  coarsest rung of an `.mcool` or `.mmetacool` whose bins still fill a cell — and
  never one finer than the level you opened, which is a choice the zoom does not
  get to overrule:
  fewer stored pixels for the same picture, and — the reason that matters — a
  balanced map that was **balanced at that resolution** rather than summed, which
  is what `zoomify --balance` produces and what the reader has been calling "the
  real answer" in a comment since pooling landed.

  The rungs a zoom touches are opened beside the one that is open, over the same
  mounted bytes, bounded at three and released with the session; a navigation
  still closes the map, because a navigation means the last place is finished
  with. Bin indices are not comparable between levels — five chromosomes of the
  demo `.mcool` have one fewer 2 kb bin than the division says — so windows cross
  through base pairs, per contig, with a whole sequence converting to its whole
  self at either end. None of it is required: a plain `.metacool` has no ladder
  and the zoom reads the open map, which is §3.4's own rule for what a ladder is
  allowed to be.

- **A 4C profile can be divided by P(s).** A slice of a Hi-C map is mostly P(s):
  contact falls by orders of magnitude with distance, so a raw 4C profile's shape
  is dominated by *how far away* each bin is rather than by whether anything is
  happening there — a clean triangle with the anchor at its apex, on which the
  loops somebody ran the task to find are bumps visible near the anchor and
  invisible a megabase out. The task now offers a **Normalisation** choice: none,
  which stays the default because the raw profile is what a bigWig of a 4C
  experiment holds, or **by P(s)**, which reports observed over expected at each
  separation.

  The decay is taken from **the anchor's own sequence**, accumulated from the
  square the task is already reading, rather than from the P(s) task's
  genome-wide curve: a small chromosome divided by the average behaviour of the
  large ones comes out with a slope that is a property of the set rather than of
  the locus. Bins in trans are divided by the mean of what the anchor reaches off
  its own sequence, since "separation" means nothing between chromosomes.

- **Synthetic tracks survive a change of resolution.** Switching an `.mcool` from
  1 kb to 5 kb is not opening a different file — it is the same data at a
  different bin size — and everything a reader can see already treated it that
  way: the view carries across, and so does every dropped track. The one thing
  that did not was the output of an analysis. Run compartments genome-wide, wait
  the four minutes, change level to look at the same region more closely, and the
  Synthetic tracks card was empty: numbers the tab was still holding, dropped for
  no reason other than which object held them.

  They now come across live, as the rows the reader left — the colour, the name,
  the edge, the autoscale group, whether it was hidden — with the values still
  behind them and the exports still on them. **Unrescaled**, which is the honest
  thing and not a shortcut: a profile is one number per bin, its bins were 1 kb,
  and the row goes on saying so in its provenance line. Re-binning it to 5 kb
  would be inventing an insulation score no window ever produced. What makes that
  work is that a computed vector has always carried its own grid — the same
  reason a bigWig at one resolution draws correctly over a map at another.

  Called interval sets — insulation boundaries, CID domains, A/B compartments —
  come across the same way, with their features and their **Save as BED**. A row
  that was already waiting for a **Recompute** stays waiting for one rather than
  being promoted to a lane with nothing in it. And this is for a change of
  resolution *only*: opening a different file still leaves the analysis behind,
  because a computed row is an answer about the file being closed.

- **The Chromosomes table gets the browser's bar, and you can drag out a
  window.** The table is where a reader of a cooler lands, and the only way out
  of it into a *window* was to type one — a row click opens a whole chromosome,
  and a quarter of a gigabase is a large read taken to reach a small one. The box
  that narrowed it asked for `chrIV:1200000-1210000`, which is a coordinate
  somebody is usually looking *for* rather than one they already have.

  So the header is now the 1D browser's own: the same locus box, with the same
  gene search behind it — by name or by accession, from whichever annotation the
  star picks — the same **go**, the same switch through to the tracks, and the
  same **ruler**. Dragging across a chromosome's band opens that window, which is
  the gesture the picture was missing; a press that does not travel opens the
  whole sequence under it, and `*` opens the whole genome as it does in the
  browser.

  The strip answers a pointer the way the browser's own does: a **hairline**
  follows it and the cursor is a **caret**. A band is fifty pixels of shading
  with a name in the middle, so without a line there is no way to see where in it
  a drag would start — on a chromosome an inch wide, a megabase of ambiguity —
  and the caret says the gesture names a stretch rather than moving an edge. The
  head above it is the bar and nothing else: the title and its sentence of prose
  are what a view needs when the reader has to be told where they are, and the
  breadcrumb, the ruler and the summary line all say it better.

  A band being dragged out **looks exactly like one in the browser**, from the
  same implementation: the wash, both edges as hairlines, and three chips — where
  the drag started, where the pointer is, and how much lies between. Those
  numbers are what makes a marquee aimable, and more so here than in the browser,
  since this ruler is the whole assembly at all times and the nearest tick can be
  tens of megabases from the edge being aimed at. They are this bar's own
  coordinates — 0-based, clamped to the sequence the press landed in — so the
  chips read as what the release is about to open rather than as wherever the
  pointer happens to be. The canvas floats over the table to make room for them
  instead of pushing it down, so nothing moves when a drag begins.

  **Escape** drops the band without opening anything, as it does on the map and
  in the browser, and the release that follows — the hand is still on the button
  — does not finish the gesture that was just abandoned.

  Three things about the drag are decided rather than incidental. It **clamps to
  the sequence the press landed in**: a region names one contig, and a hand that
  overshoots chromosome III's right-hand edge has still said what it meant.
  A movement under six pixels is a **click, not a forty-base window**. And what
  it emits is 0-based half-open with no thousands separators — what
  `metacooler/range.ts` reads and what pastes into other tools — while the same
  drag in the browser writes 1-based inclusive, because that is what the
  browser's own box takes.

  **No zoom buttons and no track fitting**, unlike the browser's bar: this ruler
  is the whole assembly and stays that way, so a zoom control would imply a
  picture that can be somewhere other than where it is, and the fit buttons are
  about a stack of tracks that is not on screen. A `.metacool`'s contig list gets
  the plain box it always had — a hundred thousand contigs from four thousand
  independently assembled organisms is a texture rather than a picture, with no
  band wide enough to hold a name or to aim at.

- **The test suite can open a DOM.** Everything here ran under Node, which is
  right for the arithmetic — a range query, an axis, a bin conversion, the shape
  of a view state — and left the other half of the application, which is cards,
  panels and dialogs, asserted by reading the source. A file now opts in with a
  `// @vitest-environment jsdom` docblock and calls `setUpDom()`; the ninety
  files that do not need a DOM go on paying nothing for one. jsdom has no 2D
  context and none is faked: `getContext` answers `null` quietly, which every
  figure in this app already handles because a real browser can refuse one too,
  and a test that wants to know what was *drawn* runs the figure's own `draw`
  into a `VectorPage` — the same call the PDF export makes, and a real
  implementation of the drawing subset rather than a mock of one. The first
  three suites cover the work above: the Sequences card's ticks against a shared
  selection, the feature card's leading two lines, and where a profile goes on a
  file with no annotation layer.

### Changed

- **Run a task on every map in the deck.** The star answers *this* picture; a
  deck of four replicates is usually open because they are being compared, and
  the comparison is four insulation tracks rather than one. **run on all N maps**
  sits beside Run whenever there is more than one map, and is hidden when there
  is not — a control offering to do something to a set of one is a control a
  reader has to work out.

  One job per map, **queued rather than started together**: the worker mounts one
  file at a time, and five h5wasm instances with five dense blocks live at once
  is the moment a tab can least afford it. Each result is filed against the map
  it was measured from, so a batch leaves a row per panel rather than five rows
  on the lead. The panel row says which map and how far through — the percentage
  is one map's progress, and a reader watching it reach 100 four times with no
  idea there are five would read the fifth as a stall. Stop stops the batch where
  it has reached: the maps already measured keep their results, the rest are
  never sent.

  A job now carries the file it runs against rather than asking the session at
  dispatch, which is what makes any of this possible — and it retires a failure
  the old shape had to invent, *the open file changed while this job was queued*,
  since there is no longer a moving answer for a job to disagree with.

- **A star says which map an analysis runs against.** A deck of four replicates
  is usually opened to measure *one* of them, and until now the Analysis column
  could only ever read the session's own file — so the answer was to close the
  deck, open the replicate as the session, run the task, and put the deck back.
  Every panel now carries a star, exactly one is filled, and the filled one is
  the map every task is priced against, framed by, run on, and files its results
  into.

  **It is not the lead, and that is the whole design.** The lead is what the
  session *is of* — the breadcrumb, the tables, the tracks, the second-file split
  all name it — and it does not move (§16.9): making a star change it would
  rewrite half the furniture to run a P(s), and a region valid in one assembly is
  not a place in the next. So the star is a second, smaller idea. It starts on
  the lead, it goes back to the lead the moment the map it named leaves or the
  deck closes, and it is remembered per file like the deck's own column count.

  A starred companion reads its `/contigs` and `/genomes` when the star lands on
  it and not before: those two tables are what a *task* needs and a picture does
  not, so an eight-panel deck fetches sixteen of them only if a reader stars
  eight maps in turn. And what a task produces goes to the map it was measured
  from — an insulation track computed from the third replicate is a track about
  the third replicate, and drawing it beside a map whose numbers it is not is the
  one way this could have been quietly wrong.

- **A deck grows as far as the machine will carry it.** The limit was six, and
  six was a judgement about how many maps are useful rather than about what the
  tab can do — the wrong kind of limit on a grid a reader draws. A row of eight
  replicates, a 4 × 4 of a community's MAGs, a column down one chromosome: each
  is a legitimate figure and none of them fits in six. The real limit was never
  that number. Every panel's share of this tab's memory is already this tab's
  budget divided by the panel count, so the *reads* get smaller as the deck grows
  and refuse when a share will not do — a limit in bytes on the machine in front
  of the reader, which is the only honest one. What is left is a backstop at 64,
  an 8 × 8 grid, so that a hand-edited hash asking for ten thousand cells is
  refused before ten thousand workers are started.

- **Closing a deck no longer deletes the tracks that were on it.** A deck put
  down is a statement about layout and never about what the reader has imported,
  and the deletion was uneven in a way that read as a bug: a track they had
  *also* put on the lead survived, and one they had only ever put on a companion
  did not — so opening four replicates, giving each its own bigWig and closing
  the deck lost three imports to a gesture about how many pictures are on screen.
  The lanes on the departing maps still go with them; the tracks stay on the
  Annotations panel, drawn nowhere, which is a state the model has always had and
  is one tick from being on the lead.

- **Manual marks can be placed on any map in a deck, not only on the lead.** They
  were always *drawn* on all of them — the marks live in one store every panel
  reads from — and only the gesture was the session's own panel, which made the
  feature look broken in the layout it is most useful in: a domain boundary drawn
  across four replicates is the thing a deck is for. Every map on screen is armed
  now, as **one** mode rather than five: whichever picture the reader places on,
  whichever one they press Escape over, and the card putting its button back all
  end it everywhere. Armed on five panels and disarmed on one would leave four
  maps swallowing clicks the reader meant as navigation.

- **Escape puts the analysis drawer down.** It was the one overlay in the
  application that did not answer the key, on the argument that a modal's Escape
  destroys what the reader is reading — true of a modal, and not of this. Closing
  the drawer is the ✕, and the ✕ has always left everything running: the run
  continues, the panel row goes on reporting it, and re-opening the task brings
  back the form and the figures. Two things still outrank it, which is what keeps
  it a dismissal rather than a mode: an event something else has already handled
  (a marquee on the map, a caret in the legend, a search box's hit list), and a
  caret in one of the drawer's own fields — a half-typed anchor abandoned with
  Escape means that box, not the panel around it.

- **The map card reads outward from the axis.** Coverage and the marginals — what
  every bin *has* — then P(s), how contact falls away from it; then 4C, one
  locus's slice of that decay; then insulation, the domains it resolves into;
  then the compartments those domains sit in. Each is a question the one before
  it makes it sensible to ask, which the old order (P(s), coverage, insulation,
  4C, … compartments) did not read as.

- **The Aesthetics panel is marked by a plot rather than by a chevron.** Its two
  siblings are marked by what they hold — `layers` for the annotation stack, a
  beaker for what can be computed — while this one carried a left-pointing panel
  arrow that said only *this folds*, which all three do and which the arrow's
  direction already showed.

- **A hand over a band on the Chromosomes bar.** The strip carries two gestures
  and the cursor is what tells them apart before either happens: a press picks
  the sequence under it, so the pointer is a hand there, and the caret comes back
  the moment the hand starts travelling, because naming a window is what
  selecting text does.

- **A deck's two shared settings are presses, not switches, and the first map's
  resolution takes the deck with it.**

  Changing the first map's resolution — from the breadcrumb's own picker, from a
  link, or from the deck's bar — now moves every companion to that resolution.
  A reader who changes the rung means the deck rather than one cell of it: the
  whole claim a deck makes is that its pictures are of one place and can be read
  against each other, and half of them at 1 kb beside the rest at 10 kb is a
  claim it is no longer making.

  A file that has **not got** that level stays exactly where it is and says so
  under its own map, naming what it does have. The nearest rung would have kept
  every panel doing *something*, which is the wrong kind of helpful: it answers
  "put these on one resolution" with a deck at two and says nothing about it.

  **fix all scales** and **fix all resolutions** are now bordered action buttons
  rather than switches, first in the bar, ahead of the chain. A switch here made
  a promise it could not keep — left on, every later nudge of any panel's clip
  either had to be undone or left the deck claiming a shared scale it no longer
  had. A press says something that stays true: *these are all on that one's
  numbers now*, and the very next nudge is honestly the reader's own again. Both
  read from the **starred** map, which is the map every other "all of them" in
  this app is measured from, and both move the first map too when the star is
  elsewhere. Maps that could not follow a resolution are named in the deck's own
  line.

  The switch these replace read `one scale` / `own scales` — two phrases of the
  same length in the same shade, so the only way to read the setting was to know
  the phrasing, and the only way to learn what pressing it did was to press it.

- **Run says which map it will measure.** Beside one map `run` is a complete
  sentence; beside five it is dangerously incomplete — the reader has one map
  starred and four not, the difference between them is a small filled star in
  each heading, and a button saying only `run` gives them nothing to check that
  against before spending a minute of compute. On a deck it now reads **run on
  ★**, carrying the deck's own mark rather than the file's name: a name is longer
  than the button and would resize it every time the star moved, and the mark is
  what the reader is already reading the deck by. The name goes in the tooltip.

- **The adaptive-resolution switch is hidden for now.** The preference itself is
  untouched — global, honoured by every panel, and still reachable — it is simply
  not in the map's control row.

- **The turn control is a swap, not a light.** Its mark is the picture the next
  press produces: a square map offers a triangle, a turned one offers a square.
  Lighting it as well said both things at once — a turned map showed a square in
  accent blue, which reads as "square is on" beside a band along a diagonal. The
  neighbouring toggles keep one mark and change their state, so the tint is the
  only thing that can carry it there; here the mark already does.

- **`run on all maps` is drawn as the button it is.** It sat beside `run` in the
  quiet, borderless form, which reads as an afterthought or a link rather than
  as the other half of a choice.

- **Dropping a contact map adds it to the deck instead of replacing what is
  open.** It was the one route in this app where a drop destroyed something: a
  track dropped on a map is added to it, a `chrom.sizes` dropped on a browser
  replaces the lengths and keeps everything else, and a cooler dropped on a map
  threw away the file, the tracks placed on it, the window and the colour scale
  — for a gesture that everywhere else means *and this too*. Now it opens beside
  what is there, which is what the `+` edges and the deck's URL box already did
  one file at a time, so the three ways of reaching a second map agree.

  **Several at once populate a whole deck**, which is what selecting four
  replicates and dropping them meant. The landing page took the second map as a
  *blend* — the lower-left triangle of one square — and discarded the third
  onwards without a word; both halves of that were wrong. The blend is the
  strongest claim two files can make and is gated accordingly (one grid, so one
  bin size, so one chromosome list), so the commonest two-cooler drop met a
  refusal where a deck would simply have worked, and a gesture that loses two of
  four files reads as the application dropping them. The blend is still one
  click away on the compare card, which is where a claim that strong belongs.

  Where there is nothing open to put them beside, the first map still opens the
  session — that is an empty seat being filled, not a replacement — and the rest
  become its companions. Replacing the open file is now the deliberate gesture it
  should always have been: the picker, `Open file…`, or a new tab.

- **Two turned maps in a deck cut their bands to different depths.** A band
  reaches as far from the diagonal as its own box has rows for (§17.2), which is
  the right rule for one map and cannot work for several: a grid lays its cells
  out over more than one frame, so two panels asking their own boxes at their own
  moments get two answers and neither is wrong — and the depth is only ever
  *grown*, so nothing brought them back together. Pressing `+` beside a turned
  map halved the first map's width, which asked for a shallower band that it
  refused to shrink to, while the companion arriving beside it cut a fresh one
  from the narrower cell. The result was two visibly different bands, the lock
  refusing to move them together, and a refusal blaming the two files'
  *resolutions* for what was a layout race — a claim about their data, made out
  of a timing accident, and curable only by turning the deck off and on again.
  The deck now shares the **distance**, in base pairs, exactly as its navigation
  lock shares the window and for the same reason: each panel converts through its
  own bin size, so panels of unequal resolution reach the same place rather than
  the same number of bins.

- **An empty cell of a deck was drawn square whatever it stood next to.** A
  contact map is square and a turned one is not — it is a band along its
  diagonal, a fraction of the height of the square it was cut from — so pressing
  `+` beside a turned map produced a card several times taller than the picture
  it was offering to stand beside. A grid row is as tall as its tallest cell, so
  that card set the height of the row and every map in it was pushed to the foot
  of a rectangle of air. The deck already measures the lead's plot and pushes the
  number down rather than letting each panel derive one; it now measures both
  sides of it, and the empty card is the size of the maps beside it whatever
  shape they are.

- **Half of this application is cards, panels and dialogs, and it is tested
  now.** The jsdom scaffolding landed with the Sequences card; what it was
  reaching was seven files. `VirtualTable` — which is under both tables, and so
  under where a reader of a metagenome spends most of their time — had none at
  all, and every one of its behaviours was asserted by reading it. Twelve more
  DOM files cover the table (filters, the sort cycle, the header box that speaks
  for what the filters left rather than for the file, keyboard walking, what
  virtualisation actually builds, what it remembers, and what it must forget),
  the genomes table's two structural spec rules, the one search box four views
  share, the modal and the context menu and every way each of them closes, the
  small shared controls with `ui/dom.ts` underneath them, the ruler's clip, the
  analysis parameter memory end to end, the breadcrumb, the error view, the info
  panel's §7.4 statistic and the two controls a colour scale is set from. Five of
  the fixes above were found by writing them.

- **Dead code taken out.** Nine exported symbols with no caller anywhere in the
  repository, plus `VirtualTable.setRows`, which was a public method nothing
  called and which cleared the selection without telling the toolbar that reads
  it. `magBalance` is the one worth naming: it says "params helper shared by the
  runners" and the runners have always read the parameter themselves.
  `mergeParams` went with the drawer's own parameter scope, which is what it
  existed to serve. Out with `setRows` goes the sort cache's `source` field,
  which existed only to be invalidated by it.

- **Non-ASCII names are not supported, and are no longer tested as though they
  were.** `/contigs` *is* cooler's `/chroms`, and cooler decodes every column of
  it with an ASCII `.astype("U")`, so metacooler refuses to write a non-ASCII
  `/contigs` or `/genomes` name at all — `check_ascii_names` before the first
  write and `schema.validate` after the last. Two fixtures here had exactly that
  shape, and the cost of keeping them had already come due: `make_fixtures.py`
  could no longer build them, so `npm run fixtures` stopped after two of eleven
  files and the full `npm test` was unrunnable from a fresh clone. One of the two
  also had no Python oracle at all — the reference implementation cannot open it
  — and the *partial golden* the whole toolchain carried existed for that one
  file: a `coverage` field, a `golden: 'partial'` branch in `make_golden.py`, a
  `python_open` failure record, a `full` flag on every golden map and a `full:
  true` filter at three call sites. Fixtures, goldens, manifest rows, the
  suites that read them and that machinery are all gone; the generator now lets
  a fixture Python cannot open raise, because that is a broken fixture rather
  than a documented limitation.

  **What is kept is the decode.** An extra `/genomes` column may still hold an
  accented taxonomy — legal metadata cooler never sees — so `decodeFixedStrings`
  is now tested directly, over bytes, for the three things that go wrong: a
  multi-byte character read back as itself rather than as mojibake, NUL padding
  stripped, and a record sized in bytes rather than in characters. No fixture is
  needed to hold them, which is the point.

- **The goldens were built from fixtures that are no longer there.** Eight of
  the eleven had moved — `npm run fixtures` rebuilds both halves, and the
  fixtures a current metacooler writes are not byte-identical to the ones the
  committed oracles were made from. Almost everything still matched, which is
  what made it dangerous: what did not was whatever the two versions happened to
  disagree about — a root attribute stored as `int32` in one and `int64` in the
  other — and it surfaced as one deep object comparison failing in the middle of
  an otherwise green suite, which reads as a bug in the reader and is not one.
  The goldens are regenerated, so the two halves are one set; the only
  substantive change in them is `floatcount.metacool`'s `bin-size`, now recorded
  as the `int64` the file actually holds. And the skew is now checked before any
  comparison is made: the manifest already records the byte size of every fixture
  as it went in, so a fixture that has moved is named, with the command that
  fixes it.

- **Three docblocks in `metacooler/aggregate.ts` had drifted off their
  functions.** The paragraphs describing `aggregateMatrix` and `sparseAggregator`
  were stacked above `coarsenGrouping`, which has its own; the two exported
  functions they belong to had none where they are. Moved, unchanged.

- **The pooled read's own test asserted an invariant the rule does not have.**
  `pooling.test.ts` required `contigsPerCell === 1` for every whole-file pooled
  read, which was true of the *old* two-regime rule and is not true of the
  capacity rule that replaced it: a sequence shorter than a cell shares one with
  the neighbours it is beside, so `ladder.mmetacool::entries/4000` — which holds
  two single-bin contigs of one genome side by side — reports two at a stride of
  two, correctly. The assertion is now that the read used the grouping `poolBins`
  built, which is what it actually owes the caller. `npm test` was red on `main`
  because of it; the cell-for-cell comparison against the dense oracle beside it
  was passing throughout.

- **The analysis panel stopped asking questions it can answer itself.** A
  parameter is a question the reader is entitled to a different answer to;
  everything with one right answer per file belongs to the file. Going through
  the catalogue on that rule took a control off nearly every task.

  **Balancing is the case that settles it.** "Use balancing weights" was a
  tickbox on six tasks, off by default on five of them, and it is the one
  setting in the panel where the wrong answer produces a figure that looks
  entirely reasonable — an unbalanced P(s), insulation track or 4C profile is a
  plausible shape, and nothing in the picture says which one was asked for. A
  reader who opened a balanced file answered the question by opening it. It is
  now derived from the file's weights and shown nowhere, on P(s), diamond
  insulation, 4C, compartments and APA. It is still a parameter in every other
  sense, so the runners are unchanged and an exported TSV still says what the
  numbers were computed with — and on the four MAG tasks too, which share the
  panel with them and would otherwise be one tickbox among nine rows that no
  longer have one. **Coverage keeps its tickbox**, because there it is a
  diagnostic rather than a choice: a balanced file should have a flat total, so
  one that does not is a file whose weights do not fit it.

  **Distances are asked for in bins.** P(s)'s minimum separation and diamond
  insulation's window and call spacing were typed in base pairs and immediately
  divided by the bin size. The near-diagonal is a fact about the grid rather than
  about the genome, and the same typed number meant three bins at one resolution
  and one at the next — so they are counts now, and the diamond's default (10
  bins) is exactly what `10 × binsize` used to resolve to.

  **A whole-sequence picker starts on every sequence.** It was seeded from the
  map's framing, which silently narrowed P(s), insulation and compartments to
  whichever chromosome happened to be on screen and then reported the result as
  though the reader had chosen it. Empty is an answer for those controls — it is
  the entry the list itself offers first — so it is left alone. A *locus* box is
  the opposite case and still starts where the map is: 4C's anchor is a place.

  **P(s) draws every sequence.** The *Sequences to draw* box kept the largest N
  and said how many it had dropped, which turned "how does contact fall with
  distance, on each of my sequences" into a question about a number nobody had a
  reason to pick. All the curves are computed and all are drawn; what is capped
  is the *legend*, at three lines with a `+N more`, by the drawer that has to fit
  it.

  **Compartments takes a set of sequences** rather than refusing until one is
  named — see the entry below. Its *Quality* section is gone: the balancing
  tickbox is derived, and the minimum row coverage is a threshold below which a
  row is noise rather than a knob that changes an answer.

  **Coverage starts with the total marginal alone**, which is what the task is
  opened for; the cis fraction is a second lane arriving unasked. **Track
  correlation** bins at 100 bp rather than 10 kb — 10 kb windows smear a
  promoter-width peak into its neighbourhood before the arithmetic starts — and
  no longer prints "1 bin at 10.0 kb" beside the box, a caption measured against
  a contact map this task does not read and need not have open.

  **Domains (CIDs) is withheld from the panel.** Everything it does is reachable:
  diamond insulation calls the same boundaries from the same diamond and exports
  them as a BED, and the pileup over those calls is what APA does over any
  interval set. The descriptor is left whole, so bringing the row back is one
  line.

- **Compartments correlates several chromosomes at once, cis and trans.** It
  took one sequence, and before that it refused until one was named, on the
  argument that compartments are a property of one chromosome. That argument is
  about the *expectation* — which really is per chromosome and stays per
  chromosome — and it does not carry to the correlation: two chromosomes in the
  same compartment **touch each other in trans**, and a square holding those
  trans blocks is where a genome-wide eigenvector's signal actually comes from.
  So the control is now a list of tick boxes with **All** and **None** beside
  it, every sequence is ticked to begin with, and what comes back is one E1 over
  all of them rather than one per chromosome. Ticking a single sequence gives
  the per-chromosome answer as the degenerate case of the same arithmetic.

  The two denominators are the whole of the difference and are kept apart: a
  **cis** cell is divided by its own sequence's decay at that separation — never
  a pooled curve, which would divide a small chromosome by the average behaviour
  of the large ones and read as a gradient along the eigenvector — while a
  **trans** cell has no separation at all, so it is divided by the mean of its
  own pair's block, per pair rather than one global trans mean.

  **And which halves it reads is a control:** *cis only* — the default — *cis and
  trans*, or *trans only*. These are three computations rather than one with a
  filter over it. **Cis only** changes the *shape* of the run: one correlation
  per sequence rather than one across them, because a single square with its
  trans blocks removed correlates to a block-diagonal matrix whose leading
  eigenvector lives entirely on one chromosome and is zero on the rest — a
  genome-wide cis run done that way returns one chromosome's compartments and
  fifteen flat lines, which is wrong in a way that looks like data. It is the
  default because it is what people mean by "the compartment track", and because
  it is far the cheapest of the three: the correlation is cubic, so sixteen
  squares of 1,500 bins is a fraction of one of 24,000. It is priced against the
  largest sequence and gated per sequence, which makes it the one mode that still
  runs at a resolution the other two are refused at — and their refusal says so.
  **Trans only** is the other standard call: the cis blocks carry a near-diagonal
  that dominates every row, and leaving them out makes the eigenvector a
  statement about which sequences share a nuclear compartment and nothing else.
  It needs two sequences by definition and says so.

  What it reads is the coalesced runs of what was ticked, so everything ticked
  is a single read of the whole file rather than 136 rectangles, and a scattered
  subset pays a rectangle per pair of runs instead of reading the gaps between
  them. The bin-count gate now counts the *whole* ticked set — a yeast genome is
  12,100 bins at 1 kb and 1,210 at 10 kb — and the refusal says to untick some or
  open the file coarser. The correlation is cubic in the bin count and now says
  so beside the megabytes, reports progress from inside its own loop, and can be
  cancelled there.

- **`ignore_diags`, on compartments and on insulation.** cooltools' setting,
  spelled the same way and meaning the same thing: `0` counts every cell, `1`
  drops the main diagonal, `2` drops it and the two beside it — `|col − row| < n`
  — and **2 is the default**, which is cooltools' default and what the numbers a
  reader compares against were computed with.

  It is not a tidiness knob. The near-diagonal is where self-ligation and
  unligated fragments end up; those cells are the largest in the matrix and the
  least structural. In a **compartment** run a row's correlation with its
  neighbours is carried disproportionately by the two or three cells nearest the
  diagonal, which say only that the bins are adjacent — and every chromosome's
  rows agree about that, so it enters the eigenvector as a component that is
  really a picture of the diagonal. In an **insulation** run the diamond never
  touches the main diagonal, so what the setting trims is its *inner corner*; at
  a small window that corner can be most of the sum, and a track carried by it is
  a picture of how deep the near-diagonal is rather than of what crosses the bin.
  The diamond's coverage threshold is measured against the cells it is allowed to
  count, so raising the cut does not quietly raise the bar a bin has to clear.

  Trans cells have no separation for a diagonal to be measured from, so they are
  never affected — and the control is hidden under *trans only*, where there is
  nothing for it to do.

- **A/B compartments come out as segments, not only as an eigenvector.** E1 is a
  number per bin and the thing that gets cited is the interval — *this arm is A,
  that half-megabase is B* — and getting from one to the other meant exporting
  the bigWig and thresholding it in another tool. It is one comparison against
  zero, and this app can make it without the ambiguity a downstream threshold
  introduces, because it knows which bins were excluded and does not have to
  guess whether a gap is a zero. So a run now produces an overlay of A and B
  runs beside the track, with the mean of E1 over each run as its score, exported
  as a BED like every other called interval set. A gap in the usable bins ends a
  run rather than being bridged: a segment drawn across bins that took no part in
  the calculation would be asserting a compartment where nothing was measured.

- **Pick on map is one gesture.** The 4C anchor was picked with a Shift-drag,
  which is a held modifier on top of a mode that already has a lit button and a
  changed cursor — asking twice. While it is armed an ordinary drag names the
  band, a tap names the bin under the pointer, and neither zooms, pans, nor
  navigates: the only thing the gesture does is answer the question the form
  asked. It still disarms after one pick and on Escape.

- **A saddle is a square.** The two cell sizes of a matrix figure were computed
  independently, each filling its own axis, so the aspect of a saddle or a
  correlation heatmap was decided by how wide the drawer had been dragged. That
  is a picture whose shape carries no information and reads as one whose shape
  does — a saddle is read by comparing its two corners, and a corner stretched
  40% along one axis looks stronger than the one opposite it. Cells are square
  now, so an `n × n` matrix comes out square in any panel and a non-square one
  keeps its own aspect exactly.

- **The Sequences card is how a cooler's map picks its chromosomes.** The card
  the 1D browser has always had — every sequence, its length, a bar for the
  shape of the assembly and a tick box beside each — is now in the **General**
  column whenever a cooler is open, and beside a map the ticks are the picture:
  none is the whole genome, one is that chromosome's block, several are those
  chromosomes against each other. It replaces the **Chromosome** card, which sat
  in the same place describing the one sequence the breadcrumb already named,
  from a table the reader can open in full, and offered no way to change it.

  The binding runs both ways, which is the whole of the design. A tick
  navigates; a navigation re-ticks — so the breadcrumb, the Chromosomes table,
  the back button and a pasted link all move the boxes with the picture, and the
  card can never say "showing 1 of 16" over a whole-genome map. A table view is
  the one thing that leaves the ticks alone rather than clearing them: nothing
  is drawn there to disagree with, and clearing would throw away a selection
  being made on the way to the map. Ticking is also order-free — the axis comes
  out in the file's order however the boxes were clicked, rather than in the
  order they were clicked in.

  The **Chromosomes table** is untouched, and it is still where columns are
  sorted, filtered and read; what moved is only the picking. A `.metacool` keeps
  its **Contig** card and its genomes table: there the unit is the genome, and a
  picker with a hundred thousand tick boxes in it is not a picker.

- **The virtual 4C lane is gone, and Shift-drag is a zoom.** Shift-dragging on a
  map used to conjure a strip beside it summing that band of the matrix. Every
  part of that the **4C task** now does better: it reads the pixel table rather
  than whatever block happened to be loaded, it produces a track with a row on a
  card and a bigWig to export, and it carries a provenance line saying what it
  is. A dimmer second copy of the same answer, appearing without being asked for
  and redrawing itself on every pan, is worth removing even when it works — and
  the two disagreed at every level but the finest.

  What replaces it is the gesture the picture was missing. **Shift-drag names a
  band of one axis and zooms to it**, on the map, on the track lanes beside it,
  and in the 1D browser — one conversion from pixels to bins behind all three, so
  a stretch dragged out next to the map is the stretch the map goes to. The axis
  follows the hand, so a drag a few degrees off vertical still means what it
  plainly meant, and the axis nobody dragged keeps its centre.

  **And every one of these gestures copies what it framed.** Shift-drag writes
  `chrIV:500001-510000`: no thousands separators, a plain hyphen, 1-based
  inclusive — the difference between a string that pastes into samtools,
  bedtools, IGV and this app's own locus boxes and one that only looks right.
  Option-drag, which selects a box, writes both axes as
  `chrI:1-10000|chrII:40001-50000`, rows then columns, each half exactly what
  that stretch would produce on its own.

  Nothing else about lanes changed, because the lane was never the point: the
  `viewpoint` kind and card are gone from the store, and the four edges, the
  drag-to-another-edge, the tooltip and the exported figure are the code they
  already were.

- A shared link carries the two new readings, because both are part of what is
  being looked at rather than how it is shaded: `oe` for the baseline and `op`
  for the comparison. The normalisation needed no key of its own — it is a
  `score`, and resolves through the same list the picker is built from, so a hash
  naming one this build cannot serve lands on counts rather than on a read that
  cannot be answered.

- Adding or closing a map no longer rebuilds the one beside it. `maps` names what
  is on screen *beside* this view, and the deck reconciles itself from it before
  the render path decides anything — so the lead has nothing to be rebuilt for.
  Left out of that list, every press of `+` cost a worker round trip and threw
  away the reader's pan and zoom for a change that happened in another panel;
  drawing a 2 × 2 deck paid it four times, and on a gated whole-genome map (§7.3)
  each one would have put the pixel scan back behind its button.

- **The turn and O/E are toggles, side by side, in one row of the Map card.** They
  are the two controls that change *what picture this is* — one the geometry, one
  the units — as against the score and the clip, which change what a number is
  worth, and the overlays, which change what is drawn over it. They were an icon
  button that looked identical before and after it had been pressed, and a
  tickbox beside it that made the same kind of setting look like a different kind
  of thing. Both are now lit the way every overlay toggle is. The turn's mark is
  **the shape it will give you** — a triangle while the map is square, a square
  once it is turned — rather than a mark for the state it is in, which is the one
  reading that needs a second glance at the picture to interpret. O/E's mark is
  the two letters, because a ratio has no shape and the nearest drawn thing is a
  division sign that would say "divide" without saying by what.

- **No drawn pointer where a guide line is already pointing.** The crosshair is
  the better instrument of the two — it is drawn at the cell the app has actually
  resolved, it runs the width and height of the picture, and it continues into
  every track — while the arrowhead beside it is a second, blunter mark for the
  same position, sitting on top of the pixel it names. So it goes, exactly where
  the line comes: on the map while the crosshair is on and the pointer is over a
  cell, in the 1D browser while it is on and the pointer is on the axis rather
  than in the name column, and on a lane stack always, since a lane answers a
  pointer with a hairline whatever the preference says. The transient cursors
  stay — the closed hand while panning, the crosshair while a selection is about
  to be drawn — because those say what is *happening*, which no guide line does.

- **The deck's bar reads from the left**, with the one control that ends the deck
  at the far right. The spacer used to sit second, which split a row of one kind
  of thing into a chain on the left and three controls floated against the
  right-hand edge — on a wide window, a screen apart, so reading the bar meant
  looking in two places and which half a control was in said nothing about what
  it did.

- **The README no longer says balancing is unavailable.** It has been built since
  0.2 — `/bins/weight`, two bounded slices for the bins on screen, `raw · wᵢ · wⱼ`,
  and a control that became the score picker in 0.9 — and the paragraph claiming
  otherwise had outlived the divergence it described by seven releases. Since
  every analysis task wants balanced input, a stale line saying it cannot be had
  was one misreading away from someone concluding these numbers are computed on
  raw counts. The layering rule above it is corrected in the same way: no
  *coordinate* ever comes from `/bins`, which is what §3.3 says and what
  `bins-guard.test.ts` proves, and the weight column is the one bounded exception.

- **"No write access" now says what it always meant.** The viewer has produced
  files since 0.2 — PNG and PDF, then a saved session, then a BED of hand-drawn
  marks in 0.5 — and a bigWig is one more of them: new bytes handed to the
  browser as a download, needing no server, touching nothing that was opened. The
  non-feature is *editing an input*, never *authoring an output*, and SPECS §13
  says so now rather than leaving a reader to reconcile the two. Which is also
  why there is still no writing of `.cool`, `.mcool` or `.metacool` — h5wasm
  could create one, so that is a decision and not a limitation.

### Fixed

- **`fix all scales` carried the ramp across the deck and left every range
  where it was.** A panel has two colour scales and the press read the wrong
  one: `scale()` reports what the *reader* has set, and `NaN` on a bound is how
  it spells *nobody has* — which is the state of every map whose clip has never
  been nudged, and so of nearly every map. The transform and the colormap
  travelled, the two `NaN`s were dropped on the way out, and each panel kept its
  own auto range, which made the button look inert. It now reads what the
  rasteriser resolved — §7.1's auto rule, run once per read, and the same pair of
  numbers printed under the map's own key — so pressing it pins every other map
  to the numbers the starred one is actually drawing with.

- **A batch measured every map from the first map's pixels, on the one
  chromosome that was in view.** A task that can run off the block already on
  screen is handed it rather than reading the file again, and whether that block
  still describes the job is checked by comparing extents and a bin size —
  which, in a deck, is exactly what every panel has in common. So "run on all
  maps" lent one panel's pixels to all five jobs and five maps came back with
  one map's answer.

  Only for the region that happened to be in view, which is the worst shape a
  bug of this kind can have: everywhere else there is no block to lend, so every
  other chromosome was read per file and correct, and the numbers agreed with
  themselves everywhere a reader would think to check. The block is now lent
  only to the job about the map it is a picture of — the starred one — and every
  other job in the batch reads its own file, which is what the worker's second
  mount has always been for.

- **A companion drew none of the tracks placed on it, and a reopen collected
  them all onto the first map.** Two faults with one shape, and between them
  they made a deck's annotations look like they had never worked.

  The session builds a **new** `AnnotationStore` on every open — a change of
  resolution, a re-drop of the file, a link into another entry — and the lead's
  view is rebuilt around it while a companion's is not. So from the first
  resolution change a companion was subscribed to a store nobody writes to any
  more: every track placed on it afterwards, computed or dropped, went into the
  live store and was drawn nowhere. A companion's map is now rebuilt when the
  store under it is replaced, which costs a construction and no read — the block
  is already in hand.

  And carrying a track across that reopen carried the *import* without its
  *lanes*. `AnnotationStore.begin` places everything it is handed on the lead,
  which is what importing means and is exactly wrong for a row that is coming
  back, so a deck of four maps each with its own bigWig came back with all four
  stacked on the first one — and a track that had only ever been on a companion
  arrived on a map it had never been on. The lanes are snapshotted with the rows
  and reconciled back onto them, the lead's placement included or removed as the
  snapshot says.

- **A batch over several maps produced one track, not several.** The id a
  computed track gets is derived from the output so that a second run replaces
  its own numbers instead of stacking a lane beside them — and it named the
  output alone, with no mention of the map. So "run on all maps" over five
  replicates made five coverage tracks under one id: each one replaced the row
  before it, and each placement moved the single surviving lane onto the next
  panel and off the last. What came back was one track, on the fifth map, and
  four maps with nothing drawn on them, which reads as the batch having failed
  rather than as five results landing on top of each other. Ids are now scoped
  to the map, and a row from a companion carries that map's name in its label so
  five rows are not five identical `coverage`s. The first map keeps the bare id
  it has always had — a restored session and every `Recompute` on a row written
  before decks existed resolve through it.

- **A companion's band was drawn forty pixels tall beside a first map four
  hundred tall.** A turned map's box is a pair of numbers fitted per panel
  against how much room that panel measures itself to have, and a companion is
  built *already turned* — so the measurement happens before its plot has been
  laid out, `max-height` resolves to nothing, and the fit bottoms out on its own
  minimum. A square map never showed it, because a square's height follows its
  width through `aspect-ratio` and the width was already being pushed down.

- **How far through a batch a task is has its own pill**, beside the percentage
  rather than in front of the sentence under it. The percentage is one map's
  progress and reaches 100 once per map; a reader watching the fourth of five
  fill and reset had nothing to tell a batch from a stall.

- **A map added to a deck opened at its own zoom rather than at the deck's.**
  The navigation lock learns where the deck is looking from a panel *reporting*
  a window, and a panel reports when it draws. The first map of a deck was drawn
  long before there was a deck — nothing was listening while the reader zoomed
  into a locus and went looking for a second file — so at the moment the deck
  came into existence the lock knew nothing, and the companion that arrived was
  caught up to nothing: a whole contig beside a lead showing 40 kb of it, under
  a bar saying the two are one navigation. It usually looked right, which is why
  it survived: re-parenting the first map into the grid resizes it, a resize is
  a redraw and a redraw is a report, so the window generally arrived a frame
  after the deck was built and a frame before the companion's bytes came off the
  network. A deck that lines up because the network is slower than a relayout is
  not a deck that lines up. The deck now *seeds* the lock from the first map's
  present window whenever it is about to catch a panel up to it — on a
  companion settling, on a panel being put back on the lead, and on the first
  map itself being put back in step. Seeding moves nobody and never overwrites
  a window a panel has actually reported, so a reader's own choice still
  outranks it, and it records no debt, so the next real gesture still drives the
  deck. The same gap opened after every navigation, where the lock is cleared
  on purpose and a small companion could finish reading before the first map had
  drawn the new block.

- **The star could be left on a map that was not in the deck.** It is remembered
  per file, and a companion's internal id comes from a counter that climbs for
  the life of the tab — so a reader who starred a companion, closed the deck and
  opened another one restored an id this deck would never mint. It was
  reconciled only where a slot *departed*: a link naming fewer maps, a cell
  closed, the deck closed. A deck built by "add a map" reaches none of those, so
  the star sat on a panel that had never existed — no star filled anywhere, the
  first map's own star offering to make it the target it already was, and every
  task's result adopted onto a map with no panel to draw it. The star is now
  reconciled wherever the list of cells changes, arrivals included.

- **A track placed on a companion outlived the companion.** `keepMaps` says of
  itself that it is reconciled against the deck rather than driven by an event,
  because "doing it once per render cannot go stale" — and it was reached from
  exactly one place, the deck's own close. So closing *one* map out of four, or
  following a link that named fewer maps than the deck held, left that map's
  lanes in the store bound to an id nothing would mint again: invisible, because
  the placement control lists the maps that exist and a lane on one that does
  not has no row to be unticked from, and still counted by everything that asks
  a track how many maps it is on. It now runs wherever the grid is repainted,
  and it is keyed on the cells rather than on the pictures in them, so a
  companion that is still reading — or one whose current view is a table, and
  therefore momentarily has no map — keeps its placements.

- **A local companion was offered by its internal id.** The list of maps a track
  can be drawn on fell back to the deck's own name for a slot for anything that
  was not a *remote* file, which is every file a reader drags in: the placement
  control offered `p3` as the map to draw a bigWig on, in a list where every
  other row said what it was. It now names every companion by the URI that
  panel is actually reading, which also fixes the neighbouring case — a map that
  descended into an entry of a collection is listed as `rep2.mcool::1000`,
  the rung on screen, rather than as the collection it was dropped as.

- **Changing a starred companion's resolution did not change what a task read.**
  The facts an analysis needs are fetched once and held, which is right for a
  panel whose address never moves and wrong for the one control that moves it:
  picking `::5000` on the starred map ran the next task against `::1000` and
  captioned the result with the rung on screen. The cache is dropped with the
  other two the entry picker invalidates, and the deck re-reads it where the
  panel it happened to is the starred one.

- **Smaller things in the deck.** A companion's star named the file it was
  dropped as rather than the entry it descended into. A deck of one map — the
  state a reader meets first, because "add a map" builds the deck and shows its
  bar before a file has been chosen — said "1 maps". A map dropped on a cell
  index out of range repainted the grid and rewrote the hash with the list it
  already had, behind an identity check that could never fire.

- **The ruler drew into a box shorter than the one it had been given.** Both
  callers size their canvas with `rulerHeightFor(scale)` — the sequence band is a
  fixed target and the coordinate row under it is a line of text that has to grow
  with the text — and `drawRuler` clipped to `RULER_HEIGHT`, which is that height
  at a scale of one. Nothing runs at a scale of one: the default is 1.35, for the
  reason `ui/textScale.ts` gives, so the bottom of every tick label in the 1D
  browser and on the Chromosomes table's bar was shaved off for everyone who had
  never touched the control, and further for everyone who had turned it up. The
  height travels with the frame now, and the clip is the strip the table was
  actually pushed down by.

- **A 4C profile *with trans*, divided by P(s), was two quantities on one axis.**
  The trans half was divided by the mean of what the anchor reaches off its own
  sequence, and the cis half was left as raw counts — on the stated grounds that
  the decay had already been divided out of it, which is true on the cis-only
  path and was never true on this one, where nothing had read a square at all. So
  a track labelled `O/E` held ratios near 1 across fifteen chromosomes and a
  band sum in the thousands on the sixteenth, which reads as the strongest signal
  in the file and is a unit error. The anchor's own sequence is now normalised by
  its own decay on both paths — one on-diagonal square against a pass that is
  already touching half the pixels in the file, and only when the ratio was asked
  for. The curve is also accumulated through `ExpectedAccumulator.addBlock` rather
  than through a loop written beside it, which is the one that files a cell under
  the separation its *absolute* bins imply and cannot read a block down the wrong
  stride. The square is read from `count` rather than borrowed from the view's
  block, which `usableBlock` vouches for the resolution and the balancing of and
  not for the column: a map drawn from `expected` would otherwise have put the
  two quantities back in one track by a second route.

- **An exported session carried every task's parameters and put none of them
  back.** `analysis/memory.ts` keeps them in one scope, `analysis:params`, and its
  docstring says exactly why: `SessionConfig` gathers a session by reading a
  **fixed list** of scopes, which is what makes an exported config provably the
  same thing a reload would restore, and a scope named after a task id cannot be
  on that list. The Analysis drawer had grown one per task anyway — it read and
  wrote `analysis:<task id>` while the workspace wrote `analysis:params` on Run —
  so the two halves of §18.2 were persisting to different places and the config's
  `analysis` block was written, exported, imported and never read. One scope now,
  through the one module that owns it; the drawer keeps its own key-by-key
  validation, which is the part that knows what shape a parameter is meant to be.

- **Every dialog opened with the caret on its close button.** A selector list
  answers in document order and the ✕ is in the header, so "the first focusable
  in the panel" was always Close: Enter dismissed the dialog instead of
  submitting it, and reaching the box you opened it for meant tabbing past the
  one control that throws the work away. The caret goes to the body's first
  enabled control, and to the panel's only if the body has none.

- **A numeric table filter refused a negative exponent.** The pattern had no `-`
  past the first character, so `1e-5` did not parse and `>1e-5` compiled to
  nothing — which leaves the column *unfiltered* rather than saying anything, on
  exactly the column (a density) a reader writes that way.

- **Cancelling a task did nothing on exactly the tasks worth cancelling.** A
  cancel arrives as a *message*, and a message is delivered in a task of its own
  — so a runner that never returns to the worker's event loop never receives one,
  and `throwIfCancelled` asked a thousand times about a cancel still sitting in
  the queue. `await` does not help: an already-resolved promise schedules a
  microtask, and the microtask queue drains inside the task that scheduled it.
  The *reads* yield between windows and have always been stoppable; the
  **compute** did not — a cubic correlation, a diamond over every bin of every
  sequence, a pileup over ten thousand windows — so those ran to completion and
  delivered a result to a reader who had asked them to stop. Every one of them
  now breathes at the top of its outer loop, and the correlation's row hook is
  awaited so that stopping it is possible at all. The track venue still has no
  cancel channel, which is stated in its own docstring and unchanged.

- **A companion `.mcool` was handed to an analysis at its root.** A collection is
  opened at the root, refused and re-opened one rung down, and it is that
  descended address the panel actually shows — but the star recorded the URI the
  panel was *built* with, so starring one asked the worker for the collection and
  got `mcool-root` back: the refusal a reader was never meant to see, arriving
  from a task rather than from a picture.

- **A companion accused the files of disagreeing while the lead was still
  reading.** A panel with no block yet answers "1 × 1 cells", and one cell times
  a bin size is a span — so a companion that settled first was told *this block
  spans 16.6 Mb × 16.6 Mb where the first map spans 1.0 kb × 1.0 kb. The same
  name resolved against different sequences*, which is one bin of the lead's
  binsize dressed up as a measurement and then blamed on the assemblies. Neither
  panel is compared until both have a block, and the note is re-asked when the
  lead reports, so a real disagreement is still said — once there is something to
  say it about.

- **Insulation counted cells a cut had already taken away.** A diamond of
  half-width `w` spans separations `1 … 2w − 1`, and `ignoreDiags` drops
  everything below its value — so the cells it leaves are bounded by the
  diamond's *span*, not by its width. The count capped the ignored triangle at
  `w(w + 1) / 2` and stopped there, which is right up to `w + 1` and wrong past
  it. `minValid` is a fraction of that count, so the error did not stop at
  bookkeeping: between `w + 1` and `2w` the threshold was measured against cells
  that could never be counted and bins with a perfectly good diamond scored
  `NaN`, and at `2w` and above *every* bin did — the lane came back empty, with
  nothing said, which is indistinguishable from a file with no contacts in it.
  The cells are counted over the span now, and a window a cut has emptied is
  named: a note where some scales survive, a refusal naming the arithmetic where
  none do.

- **A compartment square a cut had emptied was drawn rather than refused.** The
  same control, with no upper bound, on a task whose sequences can be shorter
  than the number typed into it: every cell becomes a gap, every correlation is
  undefined, `correlationMatrix` fills the matrix with the zeros it reads *no
  evidence* as, and the leading eigenvector of that is a shape with no data
  behind it. It now says which square, and how many bins were in it.

- **The keyboard opened rows the filters were hiding.** A table keeps the row
  under the cursor so that Enter opens it and the space bar ticks it, and a
  filter that took that row away cleared only its *position*. The row itself
  stayed, so Enter navigated to something no longer on screen and the space bar
  ticked it into a selection the reader could not see — a keypress aimed at the
  list in front of them, answered with one that is not.

- **An emptied colour-clip box set the bound to zero.** A `type="number"` input
  reports `''` both for a cleared box and for anything the browser refused to
  parse, and `Number('')` is `0`: clearing a bound *set* one. On a `log10` map,
  whose values live entirely below zero, clearing the high box clipped the whole
  picture at 1. Refused now, like any other value that does not parse — and the
  refusal is *visible*, which it was not: `change` fires on Enter without moving
  the focus, and the repaint that was supposed to snap the box back leaves a
  focused box alone, so the number the reader typed stayed on screen looking as
  though it had been taken.

- **A pooled read drew the wrong column.** `SpanScanOptions` had no `value`, so
  every pooled, rolled-up and selection read walked `pixels/count` whatever the
  request asked for, while the dense path honoured the choice — one view showing
  two different quantities, decided by whether the block happened to cross the
  pooling threshold, with nothing said. It is threaded now, in the one place both
  paths meet. Latent since pooling landed; urgent once the resolution started
  moving with the zoom, because a quantity that changes as you magnify is not a
  picture of anything.

- **`bin × bin` in the whole-genome view.** The overview offered two levels and
  both put one cell per *unit*: a contig cell sums a rectangle of
  `length × length`, and a metagenome's contigs span several orders of magnitude,
  so the axis spends its width on the shortest sequences and its colour range on
  the longest. On the 48-MAG mock community that is 62% of the axis given to
  contigs under 5 kb holding 4% of the sequence, one badly-assembled MAG taking
  28% of it for 4.5% of the assembly, and a third of the diagonal coming out
  empty — a haze where the readable picture was one click away in the genomes
  table, as "select every row". That picture is now the third entry in the same
  picker. It is the pooled whole-file read the app already made, so the map, the
  resolution and the counts are identical to the selection's, down to the
  `4,057 × 4,057 bins · effective resolution: 50.0 kb`; what is new is that it is
  reachable from where the question is asked. `level` carries it in the hash like
  the other two, and the picker is one control shown at whichever level is
  mounted, so there is always a way back.

  It is also the **default**, which makes the other two changes obligatory rather
  than nice. Landing on a level means it must not read anything on its own: the
  gate is now unconditional there — the scan view's sentence, the cost, and the
  button — instead of appearing only above ten million stored pixels, since a
  threshold makes the rule hold on large files and lapse on small ones. And
  landing there means it has to be read the way the other two are, so the axis is
  labelled and divided by **genome** rather than by contig, with a label click
  opening that genome; 2,082 contig hairlines over 48 blocks were a grey wash over
  the structure the view exists to show. `contig × contig` stays one click away —
  "does this bin hold together" is a question only it answers — and where a
  catalog advertises a sidecar edge list the default still gives way to
  `genome × genome`, which is a small download rather than a pass over the file.

  A map of a *chosen* set of sequences is untouched: its axis names what was
  ticked. So is a plain cooler, which has no genomes and keeps its own view kind,
  its own level control and its `nnz` threshold.

- **A sideways scroll slides along the map.** Two fingers across a trackpad mean
  "along the genome" in every browser there is, and already did over this app's
  own 1D tracks; over a map they did nothing, because the handler stood aside so
  the platform's back-and-forward swipe would work there as it does over the rest
  of a page. That is the wrong trade over the one element a reader navigates *by*
  sliding — and the swipe still works everywhere outside the picture. Over a lane
  stack it means the same thing, since a stack is drawn on the map's own axis.

- **`v` cycles three pictures instead of toggling two:** the map and its tracks,
  the tracks alone, the map alone, and home. Nothing is hidden, moved or
  restyled on the way round — the map alone is the stacks drawing no lanes for as
  long as it lasts — so three presses come back to the arrangement you spent ten
  minutes on. The button offers the *next* stop rather than naming the current
  one, because it is a control and not a status light.

- **`[` and `]` step between sequences in the 1D browser**, as they already did
  on a map. It was the one view where the plainest thing anybody does with a
  genome had to be typed into the locus box.

- **A track's floor shows the resize cursor.** The double arrow every application
  uses for exactly that gesture, and the one the map's own box handles already
  showed — the drawn rule stays, since it is what says which lane the border
  belongs to, and the cursor is what says it can be dragged.

- **The O/E toggle survives a navigation**, as the turn now does. Both are how a
  reader is *reading* maps rather than facts about the block, and looking
  somewhere else is not a request to stop reading that way.

- **A map with a diagonal opens turned.** The band along a genomic axis with its
  tracks under it is what a contact map is *for* at this scale, and what every
  published figure of one looks like; the square is the special view — wanted for
  the far corners and for reading a comparison across the diagonal — so it is
  what a reader asks for rather than what they are given. The box opens as wide
  as the panel allows and a quarter as tall. Only the "no" is written to the
  link, so an ordinary view's hash stays short, and a block with no diagonal
  draws square without recording anything — a metagenome you passed through can
  no longer switch the turn off for every map after it. And the setting now
  survives a navigation, as the deck and the second file already did: dragging a
  box on the map to open a region, or clicking through Chromosomes to another
  sequence, used to come back square, which is exactly the gesture a turned map
  is for.

- **The map turns 45°.** A contact map is symmetric about its diagonal and the
  diagonal is where all the signal is, so a square map spends most of its area on
  empty corners and draws the part anybody reads as a thin band across the
  middle. Turned, that band is the whole picture: a domain is a triangle standing
  on the axis, a loop is a dot at the height of its own span, and the x axis
  becomes genomic position — the same axis a track is drawn against, so a profile
  under the map lines up with the *picture* rather than with one edge of it. A
  true rotation, so a base pair up the side is the same length as one along the
  bottom and the plot can be measured with one ruler; a half-bin lattice, each
  source cell filling two adjacent columns, so what the renderer gets is an
  ordinary uniform matrix and pan, zoom, pooling, clip, colourbar and export are
  the code they always were. Offered only where the block has a diagonal — one
  sequence against itself, at bin level — and greyed rather than hidden where it
  does not, so the answer to "can this viewer do that" is *yes, from a map*.
  Shared by a whole deck, like the derivations, because a bar claiming one
  navigation over a band and four squares is not a comparison.

- **A ruler up the side of a turned map, in distance.** The axis that is the
  whole reason to turn the picture was the one axis with no numbers on it: the
  row ruler was switched off under a turn, since labelling a distance with
  coordinates would name places that are not there. It is the same affine line
  and the same 1–2–5 ladder as every other ruler, with a negative gradient —
  separation grows towards the top of the picture while a row index grows towards
  the bottom. The tick *spacing* could not be shared: the default is the width of
  a base-pair label, and a band a hundred pixels tall fits one tick at it.

- **A turned map is a rectangle of a size you choose, and the zoom fills it.**
  Drag the top edge for its height and either end for its width; neither moves
  when the map is zoomed. What the zoom changes is what is *inside* the box —
  more or less genome across, more or less distance up — which is also the honest
  reading, since a shorter stretch of genome has shorter distances above it.
  Fitted like any other matrix, as it was at first, a band's height was `depth ×
  zoom` and zooming in grew it until it filled the panel: at which point the
  picture is a square map again with the far corners the turn exists to throw
  away back on screen. The box opens at a third of its own width — enough band
  for a domain to be a triangle rather than a smear, short enough that the
  picture still reads as one strip along the genome; both ends widen it about its
  middle, so the edge under the pointer stays under it; arrow keys move an edge
  by a tenth of the box, Shift by a half, and a double-click puts the default
  back. What bounds it is the room the *panel* has, measured against the panel
  and not against the grid the box sits in — that grid is sized by its contents,
  so a ceiling read from there follows the box down, and every drag inwards
  lowered the limit to wherever the edge had just got to: the width could be
  given away and never taken back. The map and its tracks are centred as a group
  in the room a square map would have taken, so flipping does not resize the
  panel and a track added below re-centres the map above it.

- **The guides on a turned map are a pair of rays, not a cross.** Hold one end of
  a contact still and let the separation grow and the contact walks *diagonally*
  across the picture, so the lines that say which two places this is leave the
  pointer at 45°: a pointer on the map gets an X centred on the contact, which
  near the axis reads as a V and near the top of the band as a ∧, because the
  band is all that fits of one. A pointer on a track gets a V standing on the
  axis under it — the reader is naming one place, and the contacts that place is
  in are the two rays leaving it, both ways along the genome. And a pointer on
  the map now puts *two* hairlines in every track, one under each end of the
  contact: the column it is over is the midpoint of the two, and no track has
  anything at it. On the diagonal the two ends are one place and there is one
  line.

- **Marks on a turned map, placed by the loci they name.** Every overlay used to
  bail out where there was no row axis, so a reader's own marks vanished when they
  pressed the toggle and came back when they pressed it again. A line stays a line
  at the same place on the genome, joining up with the same line in the lane below
  it — including one drawn as horizontal, whose axis is gone but whose locus is
  not. A domain becomes a triangle standing on the axis, a loop one dot at the
  height of its own span, an arrowhead a glyph standing over that dot with its tip
  pointing back at it. A call further out than the band shows is not drawn at all:
  that is outside the data, not off the edge of the picture.

- **Every track in one stack below a turned map**, whichever edge it was put on,
  and once even if it was on two. A presentation of the placement rather than a
  rewrite of it, so everything is back where it came from the moment the turn is
  switched off — a track that returned on the bottom edge because it happened to
  be turned when the button was pressed would be the picture editing the reader's
  settings behind them.

- **A track goes on any edge of any map in a deck**, from one list. A track is
  the import and the style true of it everywhere; a lane is one placement of it,
  carrying four edge booleans and almost nothing else. A lane given no patch of
  its own cannot drift from its track, which is what makes *put it on every map*
  different from *copy it* — recolour the row and every copy moves. One press
  sends a track to every map at the edges it is already on, and one takes it off
  all of them while leaving it in the list, with its settings, ready to put back.

- **The session's heading leaves the deck's first cell.** The title, the locus
  box, the back link and the block summary answer *what am I looking at*, which
  is one question however many pictures are on screen, so a deck hoists them
  above its grid — and cell 0 becomes a cell like the others, holding a map and
  its file name. Inside, they made the first cell a head taller than the rest
  and the first map was drawn smaller than the maps it was there to be compared
  with. The deck's count rides on the end of that summary now, `113 × 113 bins ·
  … · 3 maps`, rather than in a bar of controls.

- **A deck's bar holds only what is shared**: the master chain, one scale for
  all, how many maps across, and one figure of the whole deck at 300 dpi. Adding
  a map is the `+` on an edge and rearranging is the grip, so neither is a button
  there — a bar that repeats what the pictures already offer is a second place to
  look for the same thing.

- **Maps are rearranged by dragging them.** Every companion has a grip before its
  name; taking hold of one shows the deck's tiling, and dropping a map on a cell
  exchanges the two. `◀` `▶` could only ever say *one place along a list*, which
  describes a 2 × 2 poorly: moving the bottom-left map to the top-right was three
  presses, each shuffling everything in between. The lead has a name like every
  other cell and no grip — the first map is always the lead.

- **A companion's scale controls are on its picture**, in a menu that opens
  upward from a button in the map's bottom-left corner: the score, the baseline,
  the transform, the ramp and the clip, and nothing else. What was there was a
  `colour and export` fold *under* the map, which pushed every other panel of the
  deck down by the height of whatever was open in it.

- - **A deck is drawn before it is filled** (§16.9). A `+` down the right-hand edge
  of the map and another along the bottom. Pressing one opens a *cell* rather
  than a map: what comes back is the arrangement asked for, with the reader's own
  map in the first of it and every other cell standing empty as its own drop
  target. Drop a cooler on one, click it to choose a file, or type a URL in the
  bar — in any order, or never.

  This is the feature's first entry point a reader can find. The first companion
  used to be reachable only through the command palette, so nothing on screen
  said the viewer could put several maps side by side at all — and the one
  gesture anybody would try, dropping a second cooler on the map, means *load a
  track* here.

  **Cells before maps** is the design and not an ordering. Adding maps one at a
  time makes the arrangement a consequence of the order the files arrived in, and
  the arrangement is exactly what somebody assembling a figure is composing: two
  conditions across and two timepoints down is a statement about an experiment,
  and reaching it by dropping four files into a row and then pressing `◀` twice
  is repairing a layout rather than drawing one.

  The shape is a rectangle filled in reading order, and a press adds a whole edge
  — a column beside, a row below. One extra cell on the right of a two-row grid
  cannot be expressed without pushing every map after it one place along, and a
  press must never move a map that has already been placed. The column count a
  `+` sets overrides the three layout presets, because the two answer different
  questions and a deck that reflowed into a row the moment a map was closed would
  not be an arrangement at all.

  An empty cell is a real cell: it takes a slot in `maps`, travels through a link
  as the same `~` a local companion uses, counts towards the six-panel ceiling,
  and moves and closes like any other. It does *not* count towards the memory
  budget — an empty card has no worker and no block, and dividing the allowance
  by it would read the two maps of a 2 × 2 deck at a quarter each while half went
  to rectangles. A file dropped on an edge opens the cell that edge names and
  fills it in one movement.

  Adding the column is a *splice* and not an append, one cell into the end of
  each row. The grid is one flat list in `repeat(n, …)`, so a cell's position is
  derived from its index and the column count and raising the count re-maps
  every index at once — appending turns a 2 × 2 into a three-wide row with the
  fourth map stranded underneath, which is precisely the rearrangement the whole
  gesture exists to avoid.

- **N maps side by side, navigating together** (§16). Several contact maps on
  screen at once, each with its own file, its own reader worker and its own
  colour scale, all showing the same place. Addable, removable, reorderable,
  laid out as a row, a column or a near-square grid, and carried in one hash key
  so a deck of four remote files is a link.

  The viewer already had two answers to "two files" and this is a third because
  neither generalises. A **tab** is a whole second session and only one is on
  screen, so it answers *open* rather than *compare*. The **lower-left triangle**
  is two files in one square, which is the strongest comparison available and is
  why it is gated on a matching bin size and a matching chromosome list. Both are
  untouched, and a session may hold a blended square *and* a deck: they are
  different claims about the files, and both can be true of one screen.

  **The view is shared and the presentation is not.** Which region, which level,
  which score, which balancing — that is what is being looked at, and four files
  at four regions are four unrelated pictures that happen to be adjacent. The
  clip is per panel and has to be: `vmax` is a number of contacts, and two
  libraries at different depths do not have the same one, so one clip across a
  deck draws the shallower file as an empty rectangle. **One scale** is offered
  for the case where the reader knows the files are comparable, off by default
  because it is the stronger claim — the same argument the two-file split settles
  with *match depth*, reached from the other side.

  **The lock's currency is base pairs, not matrix cells**, and that is the whole
  of why panels can be locked where triangles cannot. A 1 kb file and a 5 kb file
  both answer `chrI:20,000-80,000` and the answers are 60 cells and 12; a lock in
  cells moves the coarse panel five times too far and would have to be gated on a
  matching bin size, which is exactly the refusal side-by-side panels do not need.
  Conversion rounds outward, so a coarse panel shows at least what was asked for
  and never less; and a window running off the end of a shorter block is slid
  back inside it keeping its span, rather than truncated to the overlap, because
  answering a 40 kb view with a one-bin view is a different zoom in a deck whose
  whole promise is that the panels show the same thing.

  There is one owner and panels never speak to each other: with N panels each
  echoing to N−1 others there are N² conversations and no frame in which the deck
  is in one state. The feedback loop is guarded three ways, because an echo has
  three shapes — the synchronous one, the one frame later from a panel that had
  to slide (which otherwise makes "pan past the end of the short one" mean "you
  cannot pan past the end of the short one"), and the one that arrives later at
  the same window seen through a coarser grid. Without the last, a
  two-resolution deck drifts a cell per frame until it hits a wall.

  **A companion is asked for its block by name**, so a file that has no `chrI` is
  refused by `parse_metacooler_range`'s own error listing its own sequences. The
  one gate that does exist compares the *blocks* rather than the files: two panels
  that resolved one name to spans of different length resolved it against
  different sequences, and one window would be two places. A panel the gate
  refuses is still drawn, still readable and still exportable — only the lock is
  off, and it says so in a line under its own heading rather than only in a
  tooltip on a 14 px chain, because a still map reads as data.

  **A local map keeps its slot in a link.** `uri2` omits a local second file,
  which is right when there is one slot; with several, omission moves everything
  after it one place left and a deck of three arrives as a deck of two with
  nothing saying a map is missing. It is written as `~`, and the recipient gets a
  drop rectangle where the sender's file was. The separator is `|` rather than the
  comma the other lists use: a comma is legal in a URI, so `maps=a,b` would
  resolve — to two maps that are neither of the ones that were sent — the first
  time somebody published `sample,rep1.cool`.

  **N panels cannot silently blow the memory budget.** `checkBrowserDenseSize` was
  written for one block and has no idea how many are about to be live, so the
  deck divides one panel's allowance between all of them: a deck can never cost
  more than the single map it replaced, and every map added shrinks every panel's
  share, which is what refuses an over-large deck by arithmetic rather than by a
  guessed limit. Six panels is the ceiling above that, for the reason twelve
  sessions is one.

  The three side panels are untouched. The deck's controls ride above its own
  grid and each panel's colour and export cards ride inside that panel, which is
  both the plainest statement of what is shared and what is not, and the only
  placement that works on a file with a genome layer — where the Annotations
  column does not exist at all (§8.5), and which is exactly the kind of file a
  deck is most useful for.

- **Values the file does not contain.** A cooler stores counts and, if somebody
  ran `cooler balance`, one weight per bin. Everything a reader wants beyond that
  is arithmetic over numbers already on screen, and none of it needs a companion
  file, a preprocessing step or a server — so the constraints that shape this
  viewer permit all of it.

  **Normalisation** joins the score picker: `VC`, `VC √` and `ICE`, computed from
  the block. They are in that list rather than beside it because a reader
  choosing between `balanced` and `ICE` is choosing between two answers to one
  question — whose balancing, the file's or ours — and because `balanced` is only
  offered on a file somebody balanced, so a reader of an ordinary file previously
  had one entry, no control drawn at all, and no answer to "can I see this
  normalised".

  **Observed over expected** gets a toggle of its own, because it answers
  "compared to what" rather than "what number is in the cell", and it composes
  with every entry in that list — `O/E` of balanced counts is the standard
  reading, and folding it into the same dropdown would have made the two mutually
  exclusive for no reason but the shape of the control. Contact frequency falls
  by two to three orders of magnitude from the diagonal outwards; that decay is
  the strongest signal in any Hi-C map and the one nobody is looking for, and
  dividing it out is what makes the departures from it the picture.

  **The comparison becomes a three-way**: `split`, `ratio`, `difference`. The
  split answers "what do these two look like"; past a certain similarity the eye
  cannot get "where do they differ" out of two triangles at all, and the other
  two draw that directly, with every cell where the files agree at the neutral
  colour. Depth matching is forced on for both and its checkbox hidden — a ratio
  of two libraries at different depth *is* that scalar everywhere, a flat wash
  with the structure invisible, so there the depth is a nuisance parameter with
  no reading rather than a choice worth offering.

  Juicer's `KR` is deliberately not a fourth normalisation. It and iterative
  correction solve the same problem and converge to the same weights; KR is a
  faster solver for it, and at this scale the fixed point converges in
  milliseconds, so it would buy a name in a menu and nothing anyone could see. A
  file balanced with `KR` elsewhere and read here under `ICE` shows the same map.

- **A colour scale that can express a middle.** A ratio is not a quantity with a
  bright end but one with a neutral point, and three things had to change
  together for that to be drawable — doing fewer would have produced a plausible
  picture of the wrong thing. `log2` joins the transform list, so twice and half
  sit the same distance either side of neutral; the auto range becomes symmetric
  about it, so the colour meaning "these agree" is the middle of the ramp rather
  than an arbitrary point in it; and `RdBu_r` is the first diverging colormap,
  red for more. The panel takes the transform, the colormap and the clip when a
  derivation is switched on and gives all three back when it is switched off,
  because a `vmax` of 8 is a sensible ceiling on `log1p` counts and nonsense on
  `log2` of a ratio.

  Pooling changed with them. A contact map is pooled by its brightest cell,
  because its signal *is* the bright cell; a ratio pooled that way shows only the
  arm above neutral, so every region where the second file is the stronger one
  would have vanished at fit zoom — half of what a difference map is for.

- **One lane made out of two.** The same three operations for the tracks: a
  ratio, a log ratio or a difference of two bigWigs, from the batch bar when the
  selection is a pair. Two profiles drawn as two lanes are read by eye, one
  against the other, and the eye is bad at it — a small consistent difference is
  invisible under the large shared shape.

  Combined on the **common refinement** of the two interval lists rather than on
  a grid. Two bigWigs' intervals do not line up, and evaluating both onto a
  uniform grid is one line and wrong exactly where it matters: a boundary falling
  inside a cell is smeared across it, so a sharp edge in a control track becomes
  a ramp and the ratio against it develops a spike at the position being asked
  about. Cutting at every boundary of either input is exact and costs at most as
  many intervals as the two inputs together. A derived lane fetches nothing of
  its own — both operands go through the ordinary sample cache — so it inherits
  the pan-and-zoom-free rule from the two it is made of, and removing an operand
  takes it with them.

- **Each companion picks its own resolution, from the `::1000` beside its name.**
  A deck lands an `.mcool` on the lead's bin size (§3.4), which is the right
  guess and only a guess: two files rarely have the same ladder, and the rung
  that makes a comparison legible is not always the one that matches a number.
  The entry is a picker now rather than a fact — the same control the breadcrumb
  gives the session's own file, in the only place a companion has for one, which
  is its heading. The choice is written into that panel's own address, so it
  survives every navigation, every change of chromosome and the link: the map
  reopens at the rung the reader chose, not at the one the deck guessed. Hidden
  on a plain cooler and on a one-rung collection, where the control could not be
  used.

- **A deck closes from its own bar**, with the × at the right-hand end of it —
  and it takes the tracks that were only there for the companions with it. A
  bigWig dropped on a companion's edge is an import into the session's one track
  list, so closing the maps it was drawn on used to leave it loaded, invisible,
  and holding a row that said it was drawn nowhere. A track that is *also* on
  the first map is a different thing — it is being read against a picture that is
  staying — so it keeps its lane there and loses only the companions'. Nothing
  touches the first map, which is the session's own view: closing the deck leaves
  exactly what closing the last companion one at a time would.

- **⌘C copies the whole deck**, laid out as it is on screen, at the same 300 dpi
  the deck's save uses. The key meant "copy the figure" and copied the lead —
  one cell out of six, on a screen showing six, which is the answer to a question
  nobody asked. There is only ever one picture in front of the reader, so there
  is one command: with a deck up it is the deck, and without one it is the map it
  always was.

- **Analysis, in the browser.** A fourth panel, outermost on the right (`j`), lists what can be
  computed from what is open, and clicking a row opens a drawer to run it in.
  Fourteen tasks: contact probability P(s) with its log–log slope, coverage and
  marginals, diamond insulation with boundary calls, a virtual 4C profile,
  compartments with their correlation matrix, eigenvectors and saddle, metaplots
  over feature sets, aggregate peak analysis, chromosome interaction domains,
  a track correlation matrix, interval-set overlap and Jaccard, and four that
  only a metagenome has — per-MAG contact QC, contig purity and contamination
  calls, split-MAG detection, and the inter-MAG contact network.

  Everything about them is a parameter, because the useful version of any of
  these is the one run three ways: insulation over a doubling ladder of window
  widths rather than one, an APA normalised against distance-matched shifted
  controls *or* against observed/expected *or* not at all, a metaplot in fixed
  windows or over scaled regions, a 4C anchor with cis-only or trans included.
  Every parameter is one entry in a task's descriptor, and one renderer draws
  them all — a new task is a descriptor and a function, not a form.

  What it is *not* is a modal. The drawer is a peer of the map: it takes width
  from it rather than covering it, drags to any width you like, and the map keeps
  drawing at that width. A plot you are reading and the region it came from are
  worth having on screen together.

- **A job never blocks the view.** The analysis runs in a fourth worker with a
  mount of its own, so a whole-file scan over tens of millions of pixels — P(s)
  on a 26 MB MetaTOR output, say — leaves pan, zoom and navigation exactly as
  responsive as they were. The reader worker is not asked for anything while a
  job is running, and a job started from one view survives moving to another:
  the **framing is an input, captured when you press the button**, and is
  reported back in the result's provenance rather than tracking wherever you
  wandered to since. Progress and cancel are on every scan, the same way §7.3's
  overview has always had them.

- **The panel shows the whole catalogue, and says what each task is waiting
  for.** A task used to vanish when its input was not loaded — APA with no loop
  set, the metaplot with no bigWig — on the argument that a disabled row is a
  promise the file cannot keep. That argument is right about a metagenome task on
  a plain cooler, where nothing the reader does next produces a `/genomes` table.
  It is wrong about a task that is one drag-and-drop away: hiding APA does not
  spare anybody a broken promise, it teaches them the application does not do
  aggregate peak analysis.

  So there are three answers now instead of two. **Absent** where nothing the
  reader can do would help. **Waiting** — listed, dimmed, with a line saying what
  to load — where something would. **Ready**. A greyed row carrying an
  instruction is not an unkept promise; it is the menu.

- **The Analysis panel exists without a contact map.** Metaplot, track
  correlation and interval overlap read only the loaded tracks, and a 1D browser
  session is exactly where a reader has the tracks and not the matrix — so the
  column was being taken away from the people who could use three of its tasks.
  There the map tasks are greyed on *open a contact map*, the track tasks run,
  the analysis worker is never mounted because nothing asks it for a pixel, and a
  result's provenance names the assembly rather than a block.

- **A 4C anchor is picked on the map.** Reading coordinates off a picture in order
  to type them back in beside it is asking twice, so the Anchor box carries a
  **Pick on map** button: press it, Shift-drag along either axis, and the box
  fills. An *arm* rather than a mode left on — one drag answers it and the button
  goes out, so a reader who wanted one anchor does not find their next three
  attempts to zoom quietly redefining it. Escape is the way out, and it works from
  wherever the focus happens to be, since the button that armed it is across the
  window from the plot.

  What is written into the parameter is the resolved locus, never a "from the map"
  sentinel — so the record of a run names the place it was a reading of, which is
  the whole of what the provenance is for. The box stays editable throughout: a
  picked locus is a starting point for a typed correction rather than a
  replacement for one.

- **Results come back as tracks.** A task that produces one value per bin —
  insulation, 4C, coverage, an eigenvector — lands in the Annotations panel as a
  **synthetic track**, and from there it is indistinguishable from a bigWig you
  loaded: it has a colour chip, an editable range, autoscale, a height, a place
  in the stack, a group, and it can be dragged to any of the four edges. It is
  the same store and the same renderer, so nothing about lanes had to learn what
  a computed track is.

  A task that produces *intervals* — insulation's boundaries, CID's domains —
  lands there too, as an **overlay** on the map it was called from, with the same
  colour, shape and opacity controls any dropped BED gets. Running the task again
  replaces that row rather than adding another, because the second run is the one
  you wanted. And it exports as **BED** (or BEDPE for a paired set), through the
  same writer the hand-drawn marks use — one opinion about half-open ends in this
  repository, not two — so a called boundary set goes into bedtools, into IGV, and
  back into this app as an overlay. That last is the property the test asserts;
  the text is only how it gets there.

- **A bigWig writer, in this repository.** Header, zoom levels, total summary,
  chromosome B+ tree, data sections and R-tree index, written byte by byte, with
  `CompressionStream('deflate')` doing the zlib framing the format wants — no
  dependency, no `bedGraphToBigWig` step, no server. Any per-bin result exports
  as a bigWig that IGV, deepTools and pyBigWig open, and the ones that are not
  per-bin export as bedGraph, BED, or TSV. Plots export as PNG and as **true
  vector PDF**, through the same `VectorPage` the 1D browser has used since 0.6.

  Its tests read every file back with `@gmod/bbi` — the same library the app
  reads other people's bigWigs with — and then walk the B+ tree byte by byte at
  depth 3, because no reader in existence compares an internal node's keys
  against its subtree and a wrong key is invisible until somebody else's tool
  opens the file.

- **Compartments can be phased by GC content**, not only by a gene model. Which
  end of an eigenvector is "A" is arbitrary until something outside the matrix
  decides, and a FASTA is the signal available when no annotation is — so
  choosing one now fixes the sign, and the drawer says which signal did it and
  how convincingly.

  How it gets there is the interesting part. The residues live in the
  annotations worker and are megabytes; the task runs in the analysis worker.
  Rather than give one parameter a third venue, the main thread asks the
  annotations worker for a *sample* at the file's own bin size — the same
  request its GC lane is already drawn from — and ships one number per bin with
  the job. `run/compartments.ts` never learns a FASTA was involved. The same
  path resolves a chosen bigWig, which had been declared since the first
  milestone and never implemented.

- **`coolwarm`**, matplotlib's diverging blue–white–red, for the signed things:
  an eigenvector, a log ratio, an observed/expected matrix. Deliberately *not*
  added to the colour-vision-safe list — a diverging red/blue ramp is exactly
  what deuteranopia collapses, and the picker should keep saying so.

- **Goldens for the analysis, against four other tools.** Eight of them, built by
  `npm run fixtures:analysis` from the demo micro-C map with **cooltools**,
  **coolpuppy**, **pyBigWig** and **numpy**, and committed. Each carries two
  oracles: this repo's own definition recomputed in numpy, compared to equality,
  and the other tool's number under *its* definition, compared to whatever
  relation actually holds.

  Three of those relations turned out to be exact and are asserted as such. P(s)
  equals `expected_cis` cell for cell. Coverage satisfies
  `cooltools_cis == ours + diagonal` — cooltools sums the pixel table by both
  ends so a diagonal pixel counts twice, and this repo counts it once on purpose,
  which the identity now proves rather than asserts. APA equals coolpuppy's
  pileup once the loops whose window would cross the main diagonal are left out.

  **Insulation is not one of them**, and that is recorded rather than smoothed
  over: cooltools' diamond is offset by a row, drops two diagonals, divides by a
  count instead of summing, normalises by a median instead of a mean, and masks
  near dropped bins. Both definitions are published; what is left between them is
  a correlation of 0.61–0.85 on budding yeast at 1 kb, which has little domain
  structure. The golden records the measured figure per chromosome and window and
  the test asserts it has not degraded, which is a true statement where an
  equality would have been a false one.

- **`TASKS_PLAN.md`**, and **SPECS §18**. The plan is the build document; §18 is
  the specification the source cites, and it now carries the ten analysis rows of
  §12's budget table, the first of which is the one that mattered most: *any
  analysis task, effect on the view — 0 dropped frames, 0 blocked reader
  requests*.

- **Analysis outputs name your tracks, not `a1, a2, a3`.** A task is handed the
  *ids* of the entries it reads — that is the right thing internally, since an id
  is stable across a rename and a label is not — and then wrote those ids into
  what it produced. So a track-correlation heatmap came back with axes reading
  `a1, a2, a3`, a table whose rows were the same, and a metaplot whose series
  were too: a figure nobody can read, about tracks the reader had named. The
  runner now sends the labels alongside the ids, and every output uses them.

- **An analysis on a `.metacool` keeps its numbers.** A per-bin result is a lane
  rather than a picture (§18.5), and on a cooler that is exactly right: it
  becomes a row on the Synthetic tracks card and inherits colour, limits, edges,
  the tooltip and the 1D browser by being the same object a bigWig is. A
  metacool carries no annotations at all (§8.5), so it has no such card — and
  three of the tasks offered on one produce per-bin vectors: **coverage and
  marginals**, described in §18.8 as the cheapest useful thing in the catalogue
  and the one most worth having under the map; **diamond insulation**, which is
  `READY` there; and **MAG purity's** per-contig track, advertised as "exported
  as a BED and as a per-contig track". All three were priced, run, reported as
  finished — and then dropped, under a sentence telling the reader they were on
  a card that is not on screen.

  The drawer now draws the profile itself on that layout, bucketed to the width
  it has with a min–max band so a spike inside a bucket shows as a band reaching
  up to it rather than being sampled away — which matters, because a marginal is
  read to find exactly those. Beside it are the exports the row would have
  carried: **bigWig and bedGraph**, written by the same writers the card's export
  row calls, plus the TSV, PNG and vector PDF every figure there has. §18.7's
  headline — bigWig for a signal, bedGraph, BED, TSV, PNG and vector PDF — is
  now true on both layouts rather than on one. A called interval set still has no
  picture to be drawn as, so it keeps its sentence; what it no longer does is
  claim to be on a panel that does not exist, and it says plainly that the BED
  beside it is the way to take the coordinates.

- **A gene model shows the gene's name, and its accession beside it.** Half the
  GFF3 world does not spell anything the way GTF does: a VEuPathDB or PlasmoDB
  annotation writes `ID` and `Name` where Ensembl writes `gene_id` and
  `gene_name`, and types its genes with the Sequence Ontology's specific terms —
  `protein_coding_gene`, `ncRNA_gene`, `pseudogene` — rather than the bare
  `gene`. Every one of those was a place the parser looked for something and
  found nothing, so a *P. falciparum* annotation was drawn as 6,193 systematic
  ids with its 2,578 symbols sitting unread two lines up in the file. The gene
  line is now recognised whatever it is called, registered under both the
  identifiers a child can name it by — GFF3's `ID` and GTF's `gene_id`, which
  one file mixes freely — and the symbol reaches the transcripts drawn under it.

  The same pass fixed a quieter one. `transcript` and `mRNA` were the only lines
  read as transcripts, so an `ncRNA`, a `tRNA` or a `pseudogenic_transcript` was
  read as somebody's *child* and filed under its `Parent`, which is the gene,
  while its own exons were filed under theirs, which is it: two glyphs for one
  transcript, the second a nameless box with no exons in it. That file drew 402
  of them.

  **The name and the accession are now two facts, and both are kept.** The map
  and the browser draw the symbol, because a label inside an eight-pixel box has
  room for one thing. The card a click opens leads with both — `gene name:
  LipL1`, `gene ID: PF3D7_1314600` — above the coordinates, because a reader
  clicking one of the sixty genes called `VAR` is very often clicking it *for*
  the accession. The hover readout carries both. And the **search box answers to
  either**: `LipL1` out of a paper and `PF3D7_1314600` out of a supplementary
  table find the same gene, which on an annotation whose symbols repeat sixty
  times is the only way to ask for one of them. A gene the file identifies but
  never names is still drawn as its accession, and is printed once rather than
  twice under two labels.

- **A track turned off stays off when the resolution changes.** Whether a row is
  drawn is a setting like its colour and its height, and it was the one that did
  not come back: the door a row returns through is the same one a new row arrives
  by, and a new row is drawn. On an `.mcool` that is not a rare event — the same
  file at another resolution is a fresh open with the tracks restored around it —
  so changing the resolution quietly undid a reader's "not this one", by way of a
  menu about something else entirely.

- **The 1D browser's ruler gains digits as it is zoomed.** Two decimals of a
  megabase is ten kilobases, so a window narrower than that on a chromosome
  measured in megabases wrote the same number under every tick — an axis reading
  `4.60 Mb` four times over, under a picture zoomed in to answer exactly the
  question it was there for. The ruler now passes the gap between its own ticks
  to the formatter, which picks a unit two decimals can tell them apart in and
  steps down rather than growing a third: `4.6 Mb`, `4605 kb`, `4601520 bp`. The
  map's own rulers go through the same call and gain the same digits.

- **A derivation over a turned map is drawn at the depth the band has.** Turning
  a map and then switching on O/E painted the near-diagonal half of the band a
  solid navy block. The band is re-cut behind the picture as the zoom moves, so
  it is not always as deep as the box would cut it now — and a derivation is
  swapped in as *new numbers in the same grid*, so one computed at the box's
  depth arrived at a grid of another and was read with the wrong stride: every
  row a different separation from the one it was drawn at, and a tail of memory
  nothing wrote beneath them, which colours as a solid block of the scale's
  floor. The swap now asks for the grid that is there, and the renderer treats a
  length that does not fit as the reshape it is rather than drawing it.

- **Zooming a turned map is a zoom again, not a stall.** On a whole chromosome
  at a fine resolution every wheel notch blocked the main thread for about a
  second: twelve notches drew 48 frames, twelve of them over 50 ms and the worst
  over 1.3 s. Three things, in order of what they cost. The **colour scale** was
  re-measured on every re-cut — a pooling and a percentile selection over the
  whole square block, four fifths of the total, spent proving the colours were
  the colours they already were; the block a band is cut from does not change
  when the cut does, so the measurement now survives the reshape. The band is
  re-cut **only when it is too shallow**, since a band deeper than the box is the
  same picture — it stands on the box's floor either way and the extra rows are
  clipped off the top — so zooming *in* costs nothing at all; and when it is too
  shallow it is cut twice as deep as asked, so a zoom out is one rotation rather
  than one per notch. And the rotation itself no longer blanks the whole band
  before filling it: only the two corner triangles are empty, so the pass that
  emptied them is over those instead of over the largest array a turned map
  allocates. The same twelve notches now draw 229 frames, none of them over
  50 ms, and zooming back out is the same.

- **A turned band keeps its size across a navigation.** The box was a field on
  the panel, and the panel is rebuilt on every navigation — so a change of
  resolution, a click on another chromosome or a zoom into a region put the band
  back at its default, which is to say the reader lost it the first time they
  went to look at something in it. It is a store now, like the 4C anchor and for
  the same reason, shared by every map of a deck and remembered between sessions.
  What is stored is what the hand dragged; each panel fits it to the room it has
  on the way out, so a box shaped beside a wide map is still the box beside a
  narrow one and a window made small and wide again comes back to the size the
  reader chose.

- **There is a pointer again where the guide lines are.** Hiding the hardware
  pointer entirely left nothing to follow between frames — the lines are at the
  position the app has *resolved*, and the hand is somewhere they have not got to
  yet. It is a small open cross now: four short arms around a hole, so the pixel
  it is about stays visible through the middle, and drawn a little heavier than
  the hairlines it stands among, since a pointer that reads as one of the guides
  is a pointer that has to be hunted for. The arrowhead is still the resting
  cursor everywhere the guides are off, and the transient cursors are untouched.

- **A turned map's ruler is measured in the same place as its readout.** The
  column axis under a turn counts in half bins, and the halving was applied to
  where the *block starts* as well as to the step — so the ruler sat half of the
  block's own offset into the contig behind the picture drawn on it. On a window
  opening 120 bins into a chromosome every tick read 60 kb short, and the tooltip
  disagreed with the axis beneath the very cell it was describing. Only the step
  is a cell size; where the block starts is a distance in whole bins, as it is for
  everything else that reads it.

- **The top edge of a turned band follows the hand that drags it.** Screen y grows
  downward and the box does not, so dragging the top edge towards the top of the
  panel — which is the whole gesture for "taller" — made the band shorter.

- **The maps in a deck line up again when they carry different tracks.** The room
  a stack takes was reserved from the *lead's* geometry, on companions assumed to
  have none of their own — so a strip above one map and none above another drew
  the same window at two heights. Every panel now leaves room for the deepest
  stack on each edge across the whole deck and pads out the difference. Asked of
  every panel at the moment it is used, not accumulated as they report: they
  announce in whatever order they finish reading, and a running maximum is a
  maximum over whoever has spoken so far, which on the first pass reserved
  nothing at all.

- **The location control reads.** A label column and four edge buttons cannot
  share a sidebar row, so `bottom` came out as `bottc` — the single thing the
  segmented control was laid out to avoid — and beside a deck both map names came
  out as the shared `Ecoli.mcool…` prefix, truncated at exactly the point where
  they stop being the same file. The field turns on its side.

- **A deck survives the navigations of the file it is beside.** Every navigation
  builds a fresh state, which is right for the region and the level and wrong for
  the two keys that name what is on screen *beside* the view — so clicking
  Chromosomes and then a contig came back with the deck gone and its workers
  released. `maps` and `uri2` are now carried across a navigation within one
  file, by path, so changing the resolution keeps the deck and opening a
  different file does not.

- **An `.mcool` can be a companion.** A collection is not a map at its root, so
  it opened as an error about `::` syntax the reader never typed, in the
  rectangle where their map should have been. A companion now descends into an
  entry the way the compare card and the picker already do, preferring the lead's
  bin size, and publishes what it opened so the link names the map rather than
  the collection.

- **A companion knows it is balanced.** Under `log10` a balanced cell is
  negative, and the automatic range keeps negatives only when it is told the
  matrix is balanced — so a companion built without the flag drew a blank
  rectangle from a range of `[0, ~0]` over data that was perfectly good, with a
  key calling the numbers counts. The score's own resolution had the same shape
  of bug one level up: read straight from the state it answered `count` for a
  map whose picker said `balanced`, because the default is a fact about the file
  and is nowhere in the hash.

- **A new companion opens on the lead's score and clip.** The score is shared as
  a *resolved* choice rather than as the hash key that named it: a balanced file
  opens balanced and that default is nowhere in the URL, so two panels each
  applying their own put a balanced lead beside a companion drawing raw counts.
  A panel that has to fall back to counts — no weight column — keeps the ramp and
  finds its own bounds, since a clip measured in balanced units would draw it
  black.

- **The maps in a deck line up to the pixel, tracks or no tracks.** The room the
  lead's lane stacks take is reserved on every panel beside it and every picture
  is pushed to the foot of its cell, so a map inset by a stack no longer stands
  beside one that is not.

- **The `+` along the bottom of a map is above the fold.** It comes out of the
  plot's own vertical budget now; on a map sized to the window it needed a scroll
  to reach, which is a poor place for the one gesture that says this viewer can
  show two maps.

- **The 45° turn reaches every map in a deck.** A companion was never handed the
  setting, so flipping a deck put the lead on its diagonal and left the maps
  beside it square — under a bar still saying one navigation. The turn joins the
  derivations as something the deck shares and a companion applies without
  offering a second copy of the control.

- **The turn's own control is a switch rather than a latch.** It read whether the
  map was turned from the presentation object captured when the panel was built,
  and the session replaces that object on every render — so the button asked for
  a flip that was already on, could never ask for it to come off, and never lit
  up to say the map was turned.

- **Two turned maps in a deck show the same window.** The navigation lock was
  told the square block's bin size and column count while being reported the
  turned band's window. A rotated cell is half a bin and the band is `2n − 1`
  columns wide, so a whole-band view came back as twice the base pairs it covers
  and was clamped to half the columns at the other end: every turned panel drew
  half of what the panel beside it was drawing.

- **A cooler dropped on a deck's empty cell is not also imported.** The content
  area's own file handler took the same drop, so one gesture opened the companion
  the reader aimed at *and* loaded the file over the lead. The deck's cells and
  its `+` edges now answer for themselves, as the landing page's drop zone and
  the map's lane edges already did — and the exemption is tested with
  `instanceof Element` rather than `HTMLElement`, since an inline `<svg>` is
  neither, and the `+` glyph is the most obvious pixel on an edge to aim at.

- **A refusal to lock a turned deck says what is actually wrong with it.** Two
  files at different resolutions turn to different depths, because the depth is
  a fraction of each block rounded to a whole bin — a real reason not to share a
  row window, and nothing to do with the sequences. The panel used to borrow the
  wording for two files that resolved one name against different sequences,
  which is a claim a reader may act on.

- **A view mounted without the `+` edges is no longer pinned by them.** The
  session keeps one frame for its whole life and it holds the last view it
  framed, so opening a genomes table left a destroyed heatmap's canvas
  referenced until the reader navigated back to a map.

- **A turned band stands on the tracks it is read against.** A band is a fraction
  of the block deep and twice it wide, so at anything short of a close zoom it
  fitted the panel's height several times over — and it was centred there, which
  is the square map's rule and the wrong one here: a rectangle floating half way
  up its panel with a stripe of paper between its diagonal and the profiles the
  whole turn exists to line it up with. A band now fills the box it is drawn in
  (see the box, above), so its diagonal is on that box's own floor at every zoom
  — the ceiling for the mirrored half of a comparison — and there is no vertical
  pan to lose it with, a band dragged off its own diagonal having lost the axis
  it is measured from.

- **The tooltip's coordinates on a turned map.** The two sequence names and the
  distance were mapped back through the rotation and the pair of positions under
  them was not, so the card named the right sequence, the right separation, and a
  pair of coordinates belonging to neither: a turned cell's row is a *separation*
  and its column is half a bin, and read as block indices they land half way
  along the picture. Clicking a cell went the same way, and now goes through the
  same inverse.

- **Both drags on a turned map.** Up the side of a band is distance from the
  diagonal, which bounds no window — so a marquee committed a box over rows the
  block does not have, and a mostly-vertical 4C drag asked for a band of
  separations and resolved to nothing at all, silently, because the axis it named
  is `null` under a turn. Both gestures now use the axis that has coordinates,
  which is the only honest reading left. A selection is a full-height band over a
  stretch of the genome and opens the square it cuts out — the on-diagonal
  window, without the reader having to hold anything down for it — and a 4C drag
  names that stretch however the hand travelled. The diagonal lock goes with
  them: on a turned map the diagonal is the bottom edge of the picture, so
  snapping a corner to it would be snapping to the frame.

- **Turning the map no longer changes its colours.** The automatic range is a
  property of the block that was read — that is already the rule for a square
  map, where neither a pan nor a zoom re-measures it — and a band broke it by
  being a *crop*: it keeps the near-diagonal separations and drops the rest, and
  the ones it drops are where the extremes live. On an O/E map the effect was
  dramatic, the range being the 99th percentile of the departure from neutral and
  the far separations being where a small count over a small expectation produces
  the largest departures there are: turning the map roughly halved its range, and
  dragging the depth handle moved it again on every pixel. The band is now scaled
  by the block it was cut from, so the turn is what it claims to be — a change of
  geometry and nothing else. (Not, as it looks, the square counting both of its
  triangles: a percentile does not care how many times each value appears, so
  that costs nothing and there was nothing to halve. And §7.1 pins the square's
  rule to `metacooler show`'s to the bit, so the two could only ever be made to
  agree in this direction.)

- **The O/E reading in the tooltip on a turned map.** It indexed the band with
  the square's row stride, so the multiple under the pointer was a real number
  from a real cell and not from the cell being pointed at.

- **O/E leaves an unobserved cell as paper.** Zero over anything is zero, and on
  a scale centred at 1 that is the far end of the ramp — so an O/E map of a
  sparse block came out as a wall of "maximally depleted" over every empty pixel,
  which is the loudest possible statement of the one thing the file does not say.
  Nothing seen is what paper means on every other map this viewer draws. An
  infinite ratio goes the same way, being a fact about a baseline too small to
  divide by rather than a measurement; a negative one stays, because an extra
  `/pixels` column may legitimately hold negative numbers and blanking those
  would be this rule deciding what a file is allowed to contain.

## [0.9.0] - 2026-08-07

### Added

- **Four edges, and a 4C profile that is a lane on any of them.** A track can be
  drawn above the map and down its left side as well as below it and beside it,
  and the four stacks are peers: the same drop rectangles, the same handle to
  reorder or move a lane, the same border to drag it taller, the same hairline,
  tooltip, group bars, loop anchors and exported figure. The row's **location**
  control now offers all four, and a lane's right-click menu offers them too —
  as words, beside a new item that says which way the signal grows.

  Which way it grows is the one thing that is not a coordinate, and the two axes
  answer it differently. A **horizontal** lane grows up the page wherever it is:
  every browser ever built draws coverage rising from a floor under a ruler, and
  a profile above a contact map hanging from its ceiling is one a reader has to
  mirror in their head before they can compare it with the one below. A
  **vertical** lane has no such convention, so the corner decides and it grows
  towards the matrix. Exactly one edge therefore turns a lane on arrival, which
  is what it was when there were only two — bottom and right behave exactly as
  before, and moving a lane between two edges turns it again precisely when that
  answer changes, so a reader who deliberately hung a track from its ceiling
  keeps that decision through the move.

  What made this affordable is that `render/lane.ts` is still the only module
  that knows which of *along* and *across* is x. **Across now always runs
  outward, away from the map**, which above the map and to its left is the canvas
  direction reversed — so "the far border", "the end the handle hangs off" and
  "where the baseline is" stay one answer each rather than becoming four. The two
  new stacks cost a coordinate conversion, not a second renderer.

  **The virtual 4C profile is now one of these lanes**, and that is the point of
  the change rather than a consequence of it. It was a strip of its own with a
  canvas of its own, which meant it had none of what a lane has: no name you can
  type, no limits you can type, no autoscale, no ceiling drag, no floor to drag,
  no colour, no handle, no readout, no place in the stack. It is now a synthetic
  entry in the same store every track lives in, so it has all of them, from the
  one implementation — and can be dragged to any edge like anything else.

  Moved to the left or right of the map it answers a **different question**, not a
  rotated one: a strip above or below the map sums a band of rows and answers per
  column, and a strip beside it sums a band of columns and answers per row. Same
  anchor, same block, the transpose. Off the diagonal that may have an answer on
  one axis and none on the other, and the lane says which.

  It also **marks where its anchor is on its own axis**, as a short bar — the
  same glyph a group of tracks is marked with — in a gutter it keeps clear off
  its floor, which is the one end of a lane the signal never reaches, so the mark
  sits under the line rather than in it. The band being summed is on the *other*
  axis and so is nowhere in the picture; this is the fact a reader keeps asking
  for instead, because on a map read about its diagonal it is where the
  self-contact peak ought to be. The room comes out of the lane's own height
  rather than being added to it, and it is kept whether or not an anchor is set,
  so the line does not jump under the hand that has just drawn one.

  It carries no file, so it is on no card, is never written to session storage,
  and is not drawn in the 1D browser. It is also the only lane that draws where
  there is no coordinate system at all — a contig-level or whole-genome block —
  because its numbers come from the block on screen rather than from a fetch;
  there it says, in the lane, that an anchor cannot be named at this level, which
  is a better answer than the "not in this view" it used to give and than the
  instruction for a gesture that does nothing there.

  Switching it off **hides** the lane rather than removing it, so the colour,
  height, axis and edge a reader chose survive being turned off and on — and on
  a file that carries no annotations at all the lane belongs to the *file* rather
  than to the view, so it survives opening a chromosome as well.

  The empty lane's instruction is a control and stays on screen: an exported
  figure gets the outline, so an empty strip reads as a lane with nothing in it,
  and not a sentence addressed to somebody with a map in front of them.

- **Private buckets.** **Open a file → private buckets…** takes a URL prefix, a
  region and an access key, and everything under that prefix is then read with
  a Signature Version 4 signature on every request — the map, its tracks, a
  published session in the same folder. Everything else, the public demos
  included, stays unsigned. The dialog also *browses* a prefix: one
  `ListObjectsV2` per level, folders and files as rows, click to open. That is
  the half a URL box cannot do, since nobody remembers the key of a `.mcool`
  inside `collections/hum53/2026-03-run2/`.

  The scope is a **prefix, not a bucket**, so a bucket whose `demo/` is public
  and whose `collections/` is not works as one bucket. Signing the public half
  would add a CORS preflight to every read for nothing, and would fail outright
  against a key scoped the way `docs/hosting.md` says to scope it. Matching is
  longest-prefix, so a per-project key can sit inside a general lab key.

  **The signer computes SHA-256 itself** (`src/s3/sha256.ts`) rather than using
  `crypto.subtle`, and that is a requirement rather than a preference: the
  reader's hot path is a *synchronous* `XMLHttpRequest`, because Emscripten's
  stream `read` op is synchronous, so there is no `await` between HDF5 asking
  for bytes and the request going out — and every `crypto.subtle` method returns
  a promise. Presigned URLs were the alternative and are worse here: scoped to
  one method, so the `HEAD` probe needs its own, and they expire while a tab is
  open. The hashing is checked against `node:crypto` at every length across the
  padding boundary, against AWS's published vectors, and against a second
  implementation for whole requests.

  Credentials are looked up **once, at the worker boundary**, so the dozen
  places that build a remote source — the URL box, the compare card, a resolved
  session config, a restored track row — know nothing about keys, and a key
  added mid-session applies to the next request rather than the next reload. The
  worker holds no credential store and gets only the one key the URL it was
  handed needs.

  The key is in `localStorage` and readable by any script on the origin. There
  is no arrangement in which it is not — the app has no backend by construction,
  which is the same property that makes a dropped file never leave the machine
  — so what bounds it is the key's own permissions. The dialog says so, and
  `docs/hosting.md` has the two-action IAM policy and the CORS policy a
  credentialed preflight needs.


- **The example list is a shelf of sessions.** Every entry in the landing
  page's dropdown is now a `.metacooler.json` published beside the data it
  names, and nothing else — three of them, in `demo/`. A `.cool` in a
  dropdown can only ever offer what dropping that `.cool` offers: a map at its
  landing view, with nothing beside it. What a first-time reader should meet is
  the application doing its job, and that has been writable as a file since the
  export button shipped, so it is written as one.

  **Mock microbial community** opens the 1/2/4 kb ladder at its finest level,
  on the genomes table with the largest MAG first. **Yeast micro-C** opens the
  balanced 1 kb map at `IV:1.0–1.4 Mb` with the gene model along *both* edges,
  ATAC and its peak calls under the map, Pol II over input and its peaks beside
  it, and 1,506 loop calls drawn on it. **Yeast chromatin and transcription**
  opens the same assembly with no contact map at all: nine lanes over chromosome
  IV, MNase and ATAC in one group on pinned axes, the two RNA strands sharing
  one axis with the reverse strand read downwards, and the strain's own sequence
  as GC content above them all.

  The sequence is published with them: `S288c_syn40-XIII.fa`, the map's sixteen
  sequences residue for residue — `III` at 315,525 and `XIII-syn40` at 964,431,
  no `Mito` — so the lane is the genome the map is of rather than the reference
  it was lifted from. Both yeast sessions draw it, on both edges beside the map.
  It is deliberately *not* in the "load the tracks published with this map"
  button: a FASTA is read whole and held whole, and twelve megabytes of residues
  arriving from a button labelled that way would be a surprise.

- **A session can be opened by URL.** A `.json` in the picker's URL box, or in
  the list, is fetched, parsed and applied — the published counterpart of
  dropping one, and the same code after the first line. Which is what makes a
  session something you can *link to* rather than only send.

- **A published session names its files relatively.** An exported session names
  the absolute URLs the tab it came from was reading; one that ships *with* its
  data cannot, because the same directory is served from `/` in dev, `/<repo>/`
  on Pages and a third origin in the desktop build. Relative names are now
  resolved against the session's own URL on the way in, the way an `<img src>`
  in a page is, so one directory of sessions works in all three. An exported
  session is untouched by it, and a file may mix the two.

- **A track's name is edited where it is drawn.** The label pass measured every
  name and forgot it, exactly as it once did the value range; it hands the boxes
  back now, and a press on one opens a caret over it — in the 1D browser and
  beside the map, one editor for both. A name commits to the one track it names,
  unlike the range, which commits to every track in the lane because a lane draws
  one axis.

- **A map is a thing you can put down.** Compare becomes **Contact maps**, at the
  top of the Annotations column, with one row per open map wearing the same
  mark-name-eye-× head a track's row wears. The eye on the first map hides the
  matrix — which *is* the 1D genome browser, the same tracks against the same
  genome with the picture taken out — and the file stays open behind it, so the
  trip back costs one press. The eye on the second takes the lower-left triangle
  away without putting its reader down. `V` does the same from anywhere, as does
  an icon-and-word button on the title line beside the search box. The window
  comes across: hiding a map opens the browser where the map was looking, and
  showing it again restores the parked view exactly, down to the colour clip.

  The one-way door has left the File card, where it was the only way out of the
  matrix: it is the × beside the name now, next to the eye it is not. A browser
  started from a track gets the card too, with an empty slot to drop a map on.

- **The box beside a map finds genes.** It only ever spoke coordinates, so typing
  `GAL4` navigated to `region=GAL4` and came back with "unknown label" — on a
  whole-genome map of a mammal, which is three pixels per chromosome arm and is
  precisely where naming a gene is the only way to get anywhere. The scan is the
  browser's, shared, and it returns *numbers*: the browser writes 1-based loci
  and a map reads 0-based half-open regions.

- **Coordinates on a 2D drag.** A marquee on the map drew a shaded square and
  nothing else. It writes both ends and the width now, on both axes — a square in
  pixels is two different spans in base pairs the moment the axes are two
  sequences — each chip outside its own edge so it never covers what it measures.
  On the diagonal the two axes say the same thing and it is said once. The chips
  and the region that opens come from one derivation, so they cannot disagree.

- **The line under a map says what window it is showing.** `3,786 × 3,786 bins ·
  effective resolution: 600 bp` is two facts about the block and none about the
  picture. It carries `Pf3D7_05_v3:1,001-24,600 · 23.6 kb` now, in the browser's
  own words and grammar, updated in the same frame the map is drawn in.

- **One text size for every picture.** A pair of presses in both Plot cards
  scales every canvas font in the app together — track names, value ranges,
  ruler coordinates, gene names, block labels, colourbar ticks, export captions —
  and every line height, click box and label band that was measured against one.
  A multiplier rather than a size, because the sixteen sizes written down across
  the app were each chosen against the thing they sit on.

- **Shrink, next to stretch.** Stretch answers "use the space I have"; shrink
  answers "give it back, to the size I already chose for one of these" — the
  shortest lane on screen rather than the floor. All tracks at once, and within a
  group beside the button that levels a group to its tallest.

- **A name column with a width of its own.** Its edge is draggable, and a double
  click hands it back to the names. A name too long for a pinned column wraps to a
  second line, breaking where the writer said a part ends, and is cut in the
  middle — `Yeast_…-input` — when even two lines will not hold it, because the
  ends of an experiment's name are where the information is.

- **The Aesthetics column is four cards, named after what they draw on.** *View*
  is **Map** and holds everything that touches the matrix — the transform, the
  colourmap, the clip, the refit, and the four overlays that spent a release
  under a label at the foot of a card about the tracks. *Plot* is **Tracks** and
  holds the lanes and nothing else. **Export** is its own card at the top of the
  column, because saving a figure is not a property of the picture: it is what a
  reader does once everything else is where they want it.

- **⌘C copies the plot.** The figure as a PNG on the clipboard, at the Export
  card's resolution, from the system copy chord or from the button beside the
  save — in the browser and beside a map. It stands down when the keystroke is
  really about text: with a selection live or the caret in a box, ⌘C is still the
  browser's.

- **Shift with the zoom modifier pins the marquee to the diagonal.** The press
  snaps to the nearest bin *on* the diagonal and the far corner stays on it, so
  the box a reader draws over a domain is square about the diagonal by
  construction rather than by a steady hand. The diagonal is where the two axes
  name the same bin, so an off-diagonal panel gets no false one.

- **Clicking a feature opens its card.** Names, position, length, strand, score,
  the GTF attributes the parser kept — gene id, biotype, source — the coding span
  and the exons, in a panel that stays open and can be copied out of. The same
  card in the browser and in a map's lanes, for the same gesture on the same
  gene. Zooming to the feature is still there, as a button inside it.

- **The text on every picture starts at 135%**, and the track outline starts on.
  Both are the sizes and marks the renderers were written against, moved to what
  a contact map read at a desk actually needs; both are one press from where they
  were, and the identity is still a rung on the ladder.

- **Track height and transparency are steppers**, the shape text size already
  had: a box between two chevrons, a pixel a press for the height and five per
  cent for the transparency. Text size and transparency share a line, being one
  question asked twice.

- **Shift over the map reads the diagonal.** Held while hovering, the readout
  snaps onto the nearest bin *on* the diagonal — the same line the Shift-locked
  marquee draws along — so a reader can see where on it they are before pressing
  the button. It answers the question a hand over a contact map is usually
  asking anyway: contact at this locus with itself is the reference every
  off-diagonal cell is read against, and at a fitted whole-genome view finding
  that line by eye is a two-pixel target.

- **Escape abandons a drag**, on the map and in the browser. A marquee is
  committed on release and a release cannot be taken back, so the only way out
  of a box drawn in the wrong place used to be letting it open somewhere and
  navigating back. A pan is rewound rather than merely stopped: a pan that ends
  where the reader changed their mind is the pan happening anyway.

- **The 4C anchor is drawn in whichever direction the hand went.** A band of rows
  and a band of columns name the same stretch of a map read about its diagonal,
  so insisting on a vertical drag was insisting on a gesture rather than on an
  answer — and a drag that came out a few degrees the wrong side of vertical gave
  a one-bin anchor with no hint why. The band on screen follows the same test, so
  what is drawn is what is taken, and on a rectangular block each direction is
  resolved through its own axis rather than through the rows.

- **The 4C strip comes out of the map's height budget.** It is furniture above
  the map in exactly the sense a track stack is furniture below it, and without
  saying so the map kept its size, the strip was added on top, and the tracks
  under the pair went below the fold. `--lane-top` joins `--lane-bottom` in the
  plot's `clamp`, so turning the strip on shrinks the map by the strip's height
  wherever height is what is binding.

- **A virtual 4C profile above the map.** A 4C experiment fixes one locus and
  asks what it touches; a contact map already holds the answer for every locus at
  once, and pulling one out is arithmetic a reader can do by eye and cannot do
  accurately. Turn the strip on from the Map card, Shift-drag a band of rows on
  the picture, and the lane above it draws the sum of every column over that
  band.

  Computed from the block already on screen and never from a fresh read, which
  is what makes it honest as well as free: the line is a summary of the pixels
  above it, at the same pooling, from the same score column, with the same
  balancing. A separately-read profile could disagree with the picture it is
  drawn over, and would, at every level but the finest.

  The strip is a canvas of its own in the panel's grid, exactly as wide as the
  map's and drawn through the map's own column scale — so a peak sits under the
  column it came from by construction rather than by arrangement. It draws
  through `drawTrack`, so it looks like the tracks beside it because it is one,
  and the fill, the outline and the floor follow the same overlay toggles. Shown
  and empty until an anchor is drawn, because that empty box is the only place a
  reader is certainly looking at the moment they need to be told the gesture.

  The anchor is kept as a **locus**, not as bins or block rows: pan, zoom, change
  resolution and it still names the same stretch of the same sequence. Panned
  away from, the lane says so rather than drawing a profile of whatever is at
  those row numbers now.

- **A score picker where the balanced tickbox was.** One dropdown in the Map
  card naming what the cells *are*: `counts`, `balanced` where the file carries
  weights, and then every further value column the file's own `/pixels` group
  holds, under its own name. cooler fixes three columns and lets a file carry
  more — an expected value, a second normalisation, a per-pixel significance —
  and a viewer that assumed `count` could not draw any of them, so a file that
  had gone to the trouble of storing one had no way of saying so. Present on
  metacools too, where before there was no control at all.

  The choice is one control because it is one question, though balancing is a
  transform and the others are columns: a tickbox beside a dropdown would be
  splitting "what am I looking at" across two places. `balance` stays in the
  view state exactly as it was, so every link written before this exists still
  resolves; `score` carries the rest.

- **The hover card can be put away.** A `tooltip` toggle beside the crosshair, in
  both Aesthetics rows and over one store, so pressing either moves both. The
  two things a reader does with a contact map want opposite answers: reading it
  is the card's whole reason to exist, and *looking* at it — framing a figure,
  showing it to somebody — is a thing the card is directly in the way of. The
  status line under the window carries the same reading and covers nothing, so
  turning it off costs a hover no information.

- **The crosshair is offered in both Aesthetics rows.** It is the one preference
  genuinely about both pictures — one pointer, guide lines through the matrix and
  through every lane — so it is in **Map** and in **Tracks**, one key over one
  store, and pressing either moves both.

- **Select everything the filters left, from the filter row.** The tables' "select
  all" button has gone, and a tick box sits in the gutter of the filter row
  instead — directly above the column of row checkboxes, on the line the filter
  boxes are on. It was already the filtered set the old button acted on, but it
  sat in the toolbar three controls away from the rows, with nothing about it
  saying which rows it meant; a reader who had filtered to six of sixteen read
  the words "select all" and could not tell from the toolbar which they had got.
  The box says it by where it is, and shows a third state — part-ticked — when
  some of what is showing is selected. Pressing it when everything showing is
  ticked unticks it. Rows a filter is hiding are left alone in both directions;
  "clear", renamed **clear selection**, is the one that empties everything.

- **A locus box on the two table views.** The landing screen of a cooler is its
  chromosome table and of a metacool its genome table, and both offered exactly
  two doors: a whole sequence by clicking its row, or the whole file from the
  toolbar. A reader who knew the ten kilobases they wanted had to open the
  chromosome around them and narrow from there — a large read taken to reach a
  small one, and the box that would have taken them straight there only appeared
  once they had paid for it. Both tables now carry the box, `/` opens it, and
  `chrIV:1,200,000-1,210,000` goes to a ten-bin block without the chromosome
  ever being read. The read path needed nothing: `readDenseMatrix` has always
  bounded a query by `bin1_offset`, so ten bins have always cost ten bins' worth
  of pixels — what was missing was somewhere to ask from.

- **Stretch and shrink are a mirrored pair.** `unfold-vertical` against
  `fold-vertical`, everywhere the two sit together: two arrows apart and two
  arrows together, which is what the pair actually does. The old mark was a
  different glyph that had to be read rather than seen.

### Changed

- **A track dragged out of the Tracks card onto an edge turns its axis**, which a
  track dragged there by the handle on its own picture has always done. The two
  gestures mean the same thing and now take the same road; the card's own
  location control has always taken it.

- **The demo datasets moved to S3, and the app got 14× lighter.** The five
  published maps and eleven track resources are no longer copied into the
  bundle out of `public/demo/`; they live on the lab bucket at
  `https://rsglab-data.s3.eu-west-3.amazonaws.com/demo/`, one folder per
  dataset, uploaded by `scripts/publish-demo.sh`. A `npm run build` is **19 MB
  instead of ~265 MB**, and 12 MB of what is left is the source map.

  Size was the smaller half of it. Same-origin hosting waived the CORS
  requirements of §11 and failed a different one: GitHub Pages gzips
  `application/octet-stream`, which is what it served every `.metacool` and
  `.mcool` as, and a `Range` over a compressed body addresses the octets of the
  *compressed* stream. Every demo therefore opened through the whole-object
  fallback — the probe saw `Content-Encoding`, refused the ranged path, and the
  worker downloaded the entire file into memory. The landing page was
  demonstrating the escape hatch rather than the reader. S3 does not compress
  that type, so the demos now take the bounded-range path: the one a reader's
  own bucket will take. What comes back is the CORS half — a preflight, and
  `Content-Length` and `Content-Range` exposed to JavaScript — which
  `publish-demo.sh` configures and then verifies with hosting.md's three `curl`
  calls before it reports success.

  **No `.metacooler.json` changed a line.** The names inside a published
  session are relative and are resolved against the session's own URL, so
  moving the folder moved the session with it — which is the property that made
  the whole change three edits instead of thirty, and the reason a dataset
  folder stays something you can copy to another bucket.

  The datasets stay checked out in the repository, under `demo/`, because that
  directory is both what the sync uploads and what
  `test/unit/demo-examples.test.ts` reads: disk and bucket are one tree, so a
  renamed file is a red CI run rather than a landing page where every choice
  404s. They are in git history either way — removing them from the tree would
  not shrink a clone.

  Two build configs lost a special case with it. The desktop build no longer
  needs `__DEMO_BASE__` pointed at the website (and no longer trips over the
  Pages 301 that carries no `Access-Control-Allow-Origin`), and the archived
  pinned build no longer points its examples back at the site root. Both now
  read the same URLs the web build does.

- **The 1D browser's crosshair and readout follow the pointer below the tracks
  too.** The canvas used to stop at the foot of the last lane, so the space under
  the stack belonged to the column rather than to the plot and the pointer moved
  over it silently — which is a lot of dead surface on a view with two tracks in
  a tall window. The canvas now reaches the foot of the column, and pointing
  anywhere in it names a coordinate and reads every track at it, exactly as
  pointing at a track does.

  **Not before the axis begins.** The strip at the left is the handles' margin
  and, when it is on, the track names' column, and neither is a position: the
  crosshair stops at the axis and the readout says nothing there, rather than
  naming a base pair while the arrowhead is on a word. That was true of the
  readout already and is now true of the line as well.

  **Only what follows the pointer goes down there.** The sequence boundaries and
  the name column's own edge stop with the tracks: a boundary is a mark *on* the
  tracks, and a rule carrying it through a screen's worth of blank space is a
  divider between two things that are not there.

  Only on screen. A figure is a picture of the tracks, and blank paper under them
  is not part of it, so an exported one is unchanged.

### Fixed

- **The last lane of a stack shows the rule on its resize border**, which it
  never has. The rule is drawn a pixel *outside* the lane, in the gap before the
  next one — and the last lane has no gap, because its far edge is the canvas's
  own end: the whole two-pixel stroke landed outside the canvas and was clipped
  away. The drag went on working perfectly, which is the worst of the two
  failures, because a gesture that is never announced is one a reader finds by
  accident or not at all. It is now held inside the canvas by its own half-width,
  which costs every other lane nothing since they are nowhere near either end.

- **A marquee dragged off the map stays alive.** The gesture is followed on the
  window until the button comes up, with every position clamped into the plot, so
  a corner taken past the edge of the data stops at the edge instead of taking
  the whole selection with it — and what is opened on release is the box that was
  drawn rather than wherever the pointer happened to be.

- **The browser's tooltip stays on screen.** It was clamped to the *stage*, which
  on a stack of a dozen tracks is several screens tall, so a value read near the
  foot of the window went under the edge of it. It is flipped and clamped against
  the window now, and its size is measured once a frame rather than on every
  pointer move.

- **A session naming a collection at its root kept its workspace.** A workspace
  is stored under the *file's* key, and an `.mmetacool` or `.mcool` addressed at
  its root does not stay under the URI it was asked for — it redirects onto one
  of its entries (§3.4). The tracks, groups and ticked sequences were written
  under the root's key and read back under the entry's, so the map arrived
  correctly and alone.

- **The Open-a-file dialog opens what the landing page opens.** It mounts the
  same picker with the same example list, and handed its answer to a different
  door — so an entry from the list arrived there as a file to open, and a
  published session was reported as a JSON file that is not a cooler.

- **The genomic distance across a cell came back.** Anything larger than the
  picture is read on a coarser grid, and a coarsened run carries no arithmetic
  origin past its first — so the "N apart" line had gone quiet on exactly the
  views that are always pooled. It is measured from the same function the two
  coordinates above it come from. `AxisGroup` gains `unitBin`, an identity rather
  than an origin, which is what a rectangular region view needs to know its two
  axes are the same contig.

- **Tracks no longer come back doubled after a reload.** Ids are minted from one
  on every page load and a restore re-introduces the previous load's, so the first
  file dropped afterwards was handed an id a restored row was already wearing —
  and two rows under one id move and die together, which is why deleting one of
  the twins deleted both. Ids handed in are reserved, a row begun twice replaces
  itself in its own slot, a duplicate already in storage is dropped on the way
  out, and a file dropped back onto a row this session put down re-attaches it
  instead of starting a second one from the defaults.

- **Feature names sit below their features beside the map**, as they already did
  in the browser. `labelBandOf` still refuses the band on a row too short to hold
  both, so a lane dragged down puts the names back inside the wide features.

## [0.8.0] - 2026-08-06

### Added

- **The tracks beside a map are the tracks in the browser.** Everything the 1D
  browser had grown and the heatmap's lanes had not, ported across — and ported
  by *moving* the implementation rather than copying it, so there is now one of
  each rather than two that agree today.

  On the lane itself: a **colour chip** before every track name, which is a
  click-to-recolour target on screen and a colour key in the exported figure —
  four lanes used to carry four names in one neutral grey. The **value range is
  editable where it is drawn**: a caret opens in the number itself, Enter
  commits, Escape leaves it, an inverted pair is refused in place, and the
  untouched end comes from the axis on screen rather than from the file's
  whole-genome extent. An **autoscale button** sits after the range, lit while
  the axis is the data's own. **⌘-scroll** (Alt elsewhere) over a lane moves that
  lane's ceiling, stepping from the range currently resolved rather than from a
  stored `[0, 1]` nobody chose.

  In the Aesthetics column: the **Groups card**, which existed only in the
  browser — beside a map a group could be *made* and then never inspected,
  undone or drawn differently. It lists each group's members with their colours,
  hides them together, takes one back out, levels them to their tallest, and
  carries the two mode toggles. **Overlay** now works beside the map: a group can
  collapse into one lane, its members blended, with a column of coloured names
  and one range under them. So does **scale each** — the setting was stored,
  honoured in the browser and silently ignored beside the map, which is the
  stored value and the picture disagreeing. A **stretch** button and a **track
  height** box join the Plot card, and `H` works in a map session.

  And in the picture, a **bar marking each run of lanes that share an axis**.
  A group was honoured numerically the moment it was made and drawn nowhere, so
  two tracks on one axis and two that happen to agree looked identical.

- **Drag a track's body to set its ceiling.** Press in a lane and move across it
  — up and down below the map, left and right beside it — and the value axis
  follows the hand. While the drag is under way the area **stays where it was**,
  faded, as the record of the range being left behind; only the top line moves.
  One trace lifting off its own shadow says what a number changing in a corner
  could not. Nothing is written until you let go, which is what lets the shadow
  stand still. Which screen direction means *more* is asked of the lane rather
  than assumed: it is opposite on the two edges and reversed again by a flip.

- **A track outline.** One toggle in either Plot card (`I`) draws a hairline
  along the top of every track, in the plot's ink rather than in the track's own
  colour. The boundary between an area's ink and the paper is the only part of
  it carrying information, and in its own colour it is the one edge that does not
  stand out — four stacked areas become four legible shapes.

- **`Reds` in the colormap picker** — ColorBrewer's sequential red, anchored at
  paper white rather than at its own lowest stop. That stop is `#FFF5F0`, a pale
  pink, and most of a Hi-C matrix is empty: on matplotlib's ramp the map is a
  sheet of faint pink with the data on it, and the eye reads the tint as signal
  until it works out that it is everywhere. The two agree from a ninth of the way
  up, so what differs from `metacooler show --cmap Reds` is the floor rather than
  the hue.

### Changed

- **A track moved to the right of the map turns round.** Below the map a lane
  grows *up*, towards the matrix; beside it the same track grew *away* from it,
  so a figure with both stacks disagreed with itself about which way was more.
  Moving a track between the two edges now flips its axis, and a file dropped on
  the right edge arrives already turned. A **toggle**, not an assignment: a
  reader who deliberately hung a bottom track from its ceiling gets that back
  when it comes home.

- **A right-hand lane's name is off its own ink.** The caption was pinned to the
  edge nearest the map, which on that stack is where the signal grows from; it
  now goes to whichever end of the lane the baseline is not at, which is the rule
  the bottom stack always followed. A flipped track's name moves with it — and
  keeps its caret, which it used to lose.

### Fixed

- **A lane dragged by its handle beside the map landed on the wrong slot.** The
  drop position was a *drawn-lane* index handed to a reorder that indexes the
  card's whole list, so with any track hidden, still loading, or on the other
  edge the lane landed a slot early and the last slot could not be reached at
  all. Every drag now resolves its target by identity, and fires once per slot
  crossed rather than once per pointer move.

- **A cancelled lane drag no longer commits it.** `pointercancel` was bound to
  the same handler as a release, so a drag the system interrupted over a lit
  edge rectangle still moved the track to that edge.

- **One floor for a lane's height instead of three.** Fourteen pixels in the
  browser, twelve in the panel and ten in the lane stack, so a lane dragged to
  eleven was legal on one surface and rounded on another. Twelve everywhere; a
  lane below it comes back a pixel or two taller on the next reload.

## [0.7.0] - 2026-08-06

### Fixed

- **Picking the newest build did nothing, on the one page where it mattered.**
  Reported from the deployed site: the menu showed `0.6.0` selected with
  `0.6.1` marked *latest*, and choosing `0.6.1` reloaded quickly and changed
  nothing at all.

  Every part of that was working as built. A visitor at the site root is served
  by their service worker, whose cache was a build old — which is the design,
  since an update installs and *waits* for consent rather than swapping code
  under a half-read file. The picker sent them to the site root. The worker
  answered that navigation from the same cache. Nothing in the round trip ever
  asked the network for anything, so it would have done that for ever.

  The newest build is now **taken** rather than navigated to: check for an
  update now, take what is waiting by the same `skip-waiting` handshake the
  update bar uses, and only if the shell is known stale and nothing is waiting,
  drop the worker and reload. The first path replaces the cache rather than
  dropping it, and so keeps offline.

  The state is no longer silent either. When the running build is not the one
  the root publishes, the dialog now says which build is on screen, which one
  the site has, and that an ordinary reload will not fetch it — the absence of
  that sentence is what made this hard to read from the outside.

  This cannot rescue a page that is *already* stuck, since that page is running
  the code without the fix. The update bar is the way out of one, as it always
  was.

- **A drawn pixel no longer straddles two sequences.** A metagenome view was
  reducing the same picture three times over, and two of the three did not know
  where the contigs were: the read summed bins into contig-snapped cells, the
  renderer then pooled *those* into raster pixels flat and two at a time, and the
  browser filtered the result down to the screen. On a 4,882-contig genome each
  drawn pixel therefore held two different contigs and was coloured by the
  brighter of their two diagonals, so pairs of sequences that never touched were
  drawn as one solid block on the diagonal — with the boundary hairline running
  through the middle of it, because the separators were the one layer still drawn
  at the true positions.

  There is now one rule and one place that keeps it: a cell is a run of bins
  inside one sequence, or a run of *whole* sequences, never part of one plus
  something else. `partitionAxis` builds every grid in the app against a cap it
  never exceeds, so the grid the reader builds is the grid the renderer draws and
  nothing pools a second time. `POOLED_CELL_LIMIT` — the 1,024 cells of slack
  that guaranteed the second pooling for any axis between 4,096 and 5,120 cells —
  is gone, and so is `flatBinPooling`, which above 5,120 contigs was mixing whole
  sequences together *in the data* rather than only in the picture.

- **Where sequences outnumber pixels, cells hold whole sequences and say so.** An
  axis of 4,882 contigs cannot give each one a cell in a 4,096-pixel picture, and
  the old answer was to pretend otherwise. Now such a cell is a named set of whole
  sequences, summed, kept inside one genome — the rule the metagenome overview
  already applied to its slots, for the same reason and for the further one that a
  cell belonging to exactly one genome is a cell that can be clicked through. The
  summary states it in the unit the cells actually are: `2 contigs per cell,
  summed`, rather than a base-pair width that no longer means anything.

- **The genome view plans its grid instead of asking for whatever fits.** It sent
  no resolution at all, so a genome of thousands of contigs arrived as a dense
  block that the renderer coarsened on arrival — the path the report above came
  through — and a mammalian chromosome at 10 kb was refused outright for being
  larger than one typed array. The reader now plans any block that begins on a
  contig boundary and reports the plan it used, which is where the view reads its
  resolution from. A region starting mid-contig is left alone: its coordinate
  origin has no cell in a coarse grid, and moving it silently is worse than
  refusing by size.

### Changed

- **The line under a map says two things and stops.** How large the picture is
  and what one cell of it is worth — `4,046 × 4,046 bins · **effective
  resolution: 3.0 kb**` — from one function all four views share, so they cannot
  drift apart on the same fact. Gone from it: `matched chromosome XV ·` and
  `XV × XV ·`, which the title above already says; `bins 28,911–34,679` and
  `contacts between the two regions`, which nobody reads; and `· balanced`,
  which is the colourbar's to say, in the units it is drawn in, beside the
  numbers it applies to.

  The count is the **cells**, and they are called bins, because a cell of the
  picture *is* a bin of the effective resolution: `4,046 × 4,046` at `3.0 kb`
  multiplies out to the 12.1 Mb on screen. Counting the file's own bins would
  put `5,769 bins` beside `200 bp` for a 577 kb chromosome — two numbers on one
  line describing something twice its size. Above one sequence per cell there is
  no bin to speak of, and they are cells again.

- **A cell is a capacity of bins, not a count of sequences.** The first version
  of this had two rules, and the second was wrong: past the point where an
  assembly's sequences outnumbered the cells, *every* cell took a fixed number of
  whole sequences — so a contig of four bins was crushed into half a cell beside
  a contig of one, while the picture had room to draw all four. One rule now: a
  cell holds at most `k` bins and never part of one sequence beside anything
  else. A sequence longer than `k` keeps cells of its own, cut at its own start;
  only the ones too small to fill a cell share. On a 6,174-contig genome at 10 kb
  that is 3,100 cells of 20 kb, with the four-bin contig drawn as two cells and
  the one-bin contigs two to a cell — where before it was one cell for both, and
  the four-bin contig had lost its inside.

- **A group is one sequence, however many cells it spans.** The first cut of the
  membership list walked a group's cells and named the sequence in each, so a
  contig longer than the capacity — which has several cells of its own — was
  listed once per cell: its name appeared twice in the sequence list, its cell
  described itself as holding two sequences, and the bin count was suppressed
  because the cell looked shared. Members are the *distinct* sequences now.

- **The sequence list counts a sequence's own bins.** It was showing
  `end - start`, which counts the **cells** a sequence is drawn in — so a contig
  of two bins read "1 bins" the moment the capacity reached two. It comes from
  the sequence's own length now, which is the number that does not move when the
  picture is coarsened.

- **A shared cell says what is in it.** It used to be labelled with the first
  sequence and nothing else, so the readout named one of two and gave it a
  coordinate inside a cell that is not only its (`Contig_184898`, `0 bp × 0 bp`),
  and the sequence list beside the map listed one contig in two. The readout now
  names them — `Contig_184898 + Contig_321167` — and the list is built from what
  the cells *hold* rather than from what they are labelled with, so every
  sequence is there and every one of them opens.

- **The metagenome's own views join the rest.** Three of them were reducing a
  second time behind the reader:

  - the **whole-metagenome overview** capped its axis at 16,384 units where the
    renderer draws 4,096, so the last two steps were taken flat and blind to the
    genome boundaries `poolUnits` had just snapped to — sixteen genome pairs to a
    pixel, the pointer resolving one of them. The cap is the raster's width now.
    It was a *memory* bound, and memory was never what binds a picture four
    thousand pixels wide;
  - the **contig-level roll-up** had no bound at all: one cell per contig, so a
    genome of 4,882 contigs was a 190 MB accumulator for a 4,096-pixel picture,
    pooled two contigs to a pixel on arrival. It is coarsened where it is built
    now, by the same partition the bin grid uses, inside one genome;
  - the **genome-pair view** stated no resolution at all, and can be pooled like
    any other block.

  All four metacool views — genomes, genome, genome pair, region — and the
  overview now draw the same line, from the same function.

- **The overview says it once.** Under the map it used to add "7,748 contigs are
  more than are readable at once, so each row sums about 2 consecutive contigs,
  never across a genome boundary. Every one is included." — which is the summary's
  `2 contigs per cell, summed` at length, and dates from when the same view threw
  98% of the contigs away and had to promise it no longer did. The line says it;
  the paragraph is gone. So is `· full scan`: where the numbers came from is not
  a property of the picture, and the gate above asked before the scan ran.

- **A selection is the same axis, scattered.** It was the last path on the old
  rule: a cell opened at every ticked sequence, so the axis could not fall below
  the number of them however coarse the bins were made. Past the cap the renderer
  pooled what arrived, flat and blind to the sequences — and far past it, `select
  all` on a large metagenome asked for an accumulator of `cells²` that the machine
  refused, where the previous release had at least said "Select fewer sequences".
  It takes the range's capacity now, so a large sequence keeps its own cells among
  small ones, shared cells name what they hold, and ticking twenty thousand
  contigs is a picture.

- **A selection reads only the sequences it asked for.** Pixels are sorted by
  `bin1`, so every pixel a selection wants lies in the row band of one of its own
  sequences, and `bin1_offset` — already in memory — says where each band is in
  two lookups. Bands are merged where the gap is smaller than the byte source's
  own chunk and walked as one operation, with one progress count. Four MAGs out
  of two thousand used to cost a pass over every stored pixel in the file.

- **`__unbinned__` is out of the whole-file view.** It is not a genome and is
  shown nowhere else (§7.4) — absent from the tables, unselectable, excluded from
  the overview — but the whole-file map read `[0, nBins)` and drew it. On a
  1.9 M-bin metagenome that is 56% of the bins: a band across the picture, and,
  being among the drawn pixels, the thing setting the auto `vmax` for everything
  else. Under `genome-then-length` it is one contiguous range at index 0, so
  leaving it out is a range rather than a gap.

### Known

- **A pooled balanced block is an approximation, and now says nothing about it.**
  Summing balanced values is not balancing at a coarser resolution — the marginals
  of a `k`-bin cell are `k` times a fine bin's, which is why `cooler zoomify
  --balance` re-balances every level from raw counts rather than summing the level
  below. A second cost is quieter: a filtered bin carries a `NaN` weight, the
  dense read multiplies it through so the whole row draws transparent (§6.4, "a
  blank row is an unbalanced row"), and a pooled read drops `NaN` contributions
  instead, so that row returns as an ordinary number. The whole-file view has done
  this since pooling was added; the views above now do it too, because the
  alternative — keeping balanced blocks dense — refuses a mammalian chromosome
  outright and draws everything else through a contig-blind raster. Balancing at
  the read's own resolution, and taking a coarser rung of a laddered `.mcool`
  where one exists, are the real answers and are not attempted here.

- **A coarse cell belongs to the sequence, not to the question.** The grid falls
  at `contigStart + m·k` whatever range was asked for, and a request is widened to
  those edges rather than starting its own grid at its own left edge. So a base
  pair lands in the same cell, holding the same sum, in every view of it, and a
  region of a chromosome now behaves exactly as the chromosome does: one
  coordinate under one pixel, showing the sum beneath it. It also gives the first
  cell a place in the contig's own coordinates — a block opening 320 kb in used to
  call its first cell 0 bp — which is what let the restriction go that kept
  mid-contig regions on the dense path. At most `k − 1` bins are added at each
  end, and the range reported is the range drawn.

- **The reader plans the grid exactly rather than from a bound.**
  `poolPlan`'s `n / (cap − contigs)` is what a *caller* needs, having to name a
  resolution before anything is read. The reader has the contig extents in hand,
  so it searches for the smallest grid that fits — which at a bin count just over
  a multiple of the cap is a whole step finer than the bound allows.

- **Selections larger than the picture are drawn rather than refused.** "This
  selection is 6,000 cells per axis … Select fewer sequences" is a strange thing
  to say to someone who has just ticked *select all*. The axis is named sequences
  either way; only how many share a cell was ever in question, and that is a
  number the summary can state.

- **The summary counts the assembly, not the pooling.** An axis run is one cell's
  name, so counting runs counts cells — and a 4,882-contig genome was reported as
  "across 2,441 contigs" the moment its cells held two apiece.

- **Filtering is decided in the pixels it happens in.** `imageSmoothingEnabled`
  was tested in CSS pixels while the image was placed in device pixels, so on a
  2x display everything between one and two raster pixels per device pixel was
  *magnified* through a bilinear filter — the one combination with nothing to
  recommend it. The same slip applied to every export, where the DPI scale takes
  the place of the device ratio, so a 300 dpi figure was asked the screen's
  question.

## [0.6.1] - 2026-08-05

### Added

- **A dropdown that runs another commit.** The site is built from `main` on
  every push and has only ever served the newest of those builds, which is fine
  until a figure comes out different from one made last month. Every deploy now
  also publishes a copy of itself at `…/v/<commit>/`, keeps the recent ones
  beside it, and lists them in `versions.json`; **About → version** offers them
  as a menu directly under the build stamp it continues.

  Picking one is a navigation and not a swap — the two builds are different
  documents, and pretending otherwise would mean shipping a loader whose job is
  to run code from another commit. What travels is what is written down: the
  query string, the hash and the `sessionStorage` tab strip, so a link and a
  view survive the move. A file opened from local disk does not, for the reason
  it does not survive a reload either, and the hint says so rather than letting
  it be discovered. An archived build says what it is in a corner bar, with one
  button back to the newest.

  What is kept is the **last 20 pushes** — the debugging window; past fifty the
  answer is a bisect rather than a menu — and **every tagged commit, for ever**,
  which is the archive proper and the reason to cut a release even though every
  push is already live. A released number is something people cite in a methods
  section, and one that answers 404 two months later is worse than never having
  offered it.

  A release also gets a **permanent address of its own**, `…/v/v0.5.1/`, which
  is a one-kilobyte redirect to the commit rather than a second copy of it. That
  is the URL worth writing down: a commit URL is equally permanent and says
  nothing to a reader. It carries the query and the hash across, so a citation
  can name a *view* of a release and not only the build, and the About dialog
  offers it whenever the build in front of you is one. Tags are read with
  `git ls-remote --tags` — asking the server for its ref names costs a few
  kilobytes, where fetching tags into a depth-1 checkout would drag down an
  object per tag in a repository carrying 250 MB of demo data.

  Kept alongside that is **the oldest build of each `package.json` version**,
  which is the same rule for a release whose tag was pushed after its commit.
  The *oldest* is deliberate and the obvious alternative is wrong: `npm version`
  bumps the version and tags that commit, so every push until the next bump
  reports the same number — keeping the newest would keep a build that calls
  itself `0.6.0`, is labelled `0.6.0` in the menu, and is not `v0.6.0`. That is
  worse than keeping nothing, because it is wrong rather than absent.

  An archived copy leaves out the demo data, the source maps, the manifest and
  the service worker (`vite.pinned.config.ts`), which is ~5 MB against a build's
  19 MB and is what makes keeping twenty affordable inside a 1 GB Pages site.
  Deliberately **not** installable: a dock icon must not open a version
  somebody pinned once to check a figure. None of it exists in the desktop
  build, where an installer is versioned by being an installer.

  Each of those four properties is asserted after the build rather than trusted
  (`scripts/check-pinned-build.mjs`), because each fails quietly and *late*: an
  archived build is the artifact nobody opens for months, so a wrong base is a
  blank page found in November, and a `publicDir` left on exhausts the site's
  budget several deploys after the change that caused it.

## [0.6.0] - 2026-08-05

### Added

- **Tabs, and a real session behind each one.** Several files open at once, each
  with its own reader worker, its own annotation worker, its own stores and its
  own DOM. Switching a tab in re-parents that DOM rather than rebuilding it, so
  a map comes back with its pixels, its zoom and its scroll exactly as they
  were and without a single byte re-read — which is what a tab has to be for it
  to be worth having over a second browser window.

  The address bar names **the active tab and nothing else**, which is what was
  asked for and also the only coherent answer: a hash is one view state, and
  writing several would make every link a description of somebody else's
  workspace and make the back button walk a history that interleaves three
  files. The rest of the strip lives in `sessionStorage` beside the annotations
  (§8.6), and a restored tab is *named* rather than opened — the label and the
  view state come back, the worker does not, and clicking is what reads the
  file. Eight remembered tabs therefore cost eight labels. One that named a
  local file comes back to the picker with the explanation a pasted local-file
  link has always given, because no browser re-reads a dropped file without a
  gesture.

  Two tabs on one file now share nothing: the per-session memory is keyed on the
  session as well as the URI, so the second view starts with no tracks, no
  filters and no marks rather than adopting the first one's.

- **A second cooler in the lower-left triangle.** A contact matrix is symmetric,
  so half of every square on screen is a mirror of the other half and carries no
  information at all. That is the room this uses: the second file fills it, the
  picture stops being symmetric, and a broken symmetry is read far faster than
  two maps side by side.

  The split is the **matrix** diagonal, not the viewport's, which is what makes
  panning off the diagonal need no rule of its own — the far corner of a trans
  block is entirely above the line and shows the first file alone, and its
  transpose shows the second. Zoom, selection and every other gesture are
  untouched, because the merge happens once per read and hands the renderer an
  ordinary block.

  Dropped on a card in the Annotations column, where everything else that is
  laid over a map already lives. Refused *by name*: a metacool (§8.5's argument,
  applied to a whole matrix), a different bin size (one grid cannot be two
  resolutions), or a chromosome list differing in count, order, spelling or
  length (every coordinate is an index into one such list). An `.mcool` dropped
  at its root opens its finest resolution, as it does on the picker.

  GENERAL becomes File 1 and File 2, each with the mark of its own triangle and
  a close button: closing the second returns to one map, closing the first
  promotes the second, so either is reversible and what remains is an ordinary
  one-file map. `uri2` is in the hash, so a comparison is a link.

  One scale by default, because the same colour meaning the same count is the
  stronger claim. **Match depth** scales the second file so its 99th percentile
  meets the first's — the same order statistic §7.1 picks `vmax` with — for the
  case that motivates it: two libraries of different depth, where the shallower
  is otherwise a pale triangle telling you only that it was sequenced less. Two
  colourbars then read the same colours in each file's own counts, and the
  tooltip and the status line carry both numbers at every cell.

- **A genome browser that needs no contact map.** Until now a bigWig could only
  be looked at beside a cooler of the same assembly, and that was never a
  property of the tracks — it was a property of the coordinate model, which
  started from a matrix and had no way to describe a genome that was not one.

  So there is a second starting point. A `chrom.sizes`, a bigWig, a bigBed or a
  feature file declares the assembly — outright in the first three cases, and as
  a lower bound in the fourth, which is marked as inferred wherever the genome
  is described — and the axis becomes the whole genome laid end to end at one
  unit per base pair. Everything drawn on it is drawn by the code that draws the
  lanes beside a heatmap, through the same `LocusAxis` §8.4 already made the
  only one: a track cannot be at two positions because only one thing knows
  where a base pair is.

  The gestures are the map's, deliberately. A drag pans, Option-drag selects a
  range to zoom into, the wheel zooms about the pointer, a double click fits, a
  lane's border resizes it and its body reorders the stack — every one of them
  the gesture that already meant that. The one that is the browser's own is
  ⌘-scroll over a lane, which moves *that* track's ceiling from whatever it is
  currently resolved to; it is the adjustment a genome browser is asked for
  constantly and a map has no analogue for it.

  With it: a locus box that accepts `chrI:1,000-20,000`, a bare sequence name or
  `*`, and shows back exactly what it would accept; a feature search over every
  loaded gene model and peak set; click a gene to zoom to it and a sequence name
  to go there; a ruler that draws sequence bands zoomed out and base pairs
  zoomed in, because at those two extremes they are different questions; arcs
  for a BEDPE, which is what a loop call looks like in one dimension; range and
  group editors on each lane, revealed by pointing at it; autoscale groups that
  stack or share a single lane; and PDF/PNG export redrawn at the export scale.

  The two shapes of browser are one session. Drop a `.cool` anywhere on the
  tracks and the tab becomes its map, tracks and all; close the map from the
  File card and it falls back to a browser on the cooler's own `/chroms`, with
  the same tracks still loaded. A file whose name says nothing is opened as a
  map and, if that fails, identified by its bytes and re-routed rather than
  reported as broken.

- **bigBed is read.** Whole, and parsed as the BED it holds, so a bigBed12 draws
  its exons exactly as the text file would — one parser, one set of rules, one
  place where BED's quirks live. Not windowed, because a `FeatureSet` lives on
  the main thread precisely so that a pan redraws with no round trip (§8.4). A
  file past a million intervals is cut off and says so.

- **The 1D browser exports a vector PDF**, and it is the drawing rather than a
  photograph of it. Nothing in that view is a raster — every mark is a
  rectangle, a polyline or a word — so a 300 dpi image of it is a figure nobody
  can restyle, recolour or scale, in a file fifty times the size of the drawing
  it contains. The page is produced by handing the *same* renderers a context
  that emits PDF operators instead of pixels, so there is no second drawing of
  the view to keep in step: `render/features.ts`, `render/tracks.ts`,
  `render/lane.ts` and `render/browser.ts` do not know which one they are
  talking to. Text is Helvetica, one of the fourteen fonts every reader has, so
  nothing is embedded; the halo behind each track name survives as PDF's own
  stroked text mode; and the content stream is deflated, which on a whole-genome
  gene model is the difference between a twelve-megabyte figure and a
  seven-hundred-kilobyte one. A vector page has no resolution, so the DPI
  control is disabled while it is chosen rather than quietly ignored. The
  heatmap's PDF is unchanged and stays a raster, because a contact map *is* one.

- **The tracks answer to a hand, and the panel answers to a list.** Rows
  reorder by their grip or by the arrow keys, and a lane reorders by dragging
  its body; a tick box on each row opens a batch bar that puts several tracks in
  one autoscale group, gives them one colour, one height, or removes them
  together — six tracks from one experiment were six trips through six rows. A
  colour swatch sits beside each name and *is* the colour input, so changing a
  track's colour is one click rather than a menu. Every track's name is larger
  and its controls smaller: colour, limits, a ceiling slider and its group, laid
  out under the name where a reader is already looking, revealed by pointing at
  the lane and drawn over the top of it rather than across its data.

- **A drag on the ruler zooms, with no modifier.** The coordinate strip is where
  a reader points to say "this much", and it is the one gesture whose meaning
  its position already settles — so spending a keystroke on it bought nothing.
  Option-drag still selects on the tracks themselves, where a drag means pan.

- **Fit every track into the space there is**, in the proportions they are
  already in rather than equally: a reader who gave the gene model three times
  the height of a coverage track meant it, and "fit" is a request about the
  stack running off the bottom of the window. Equal heights is the other thing,
  and the Groups card still offers it per group.

- **A file dropped anywhere in the middle of the window is imported.** The drop
  zones in the Annotations column say what each kind of file becomes and are
  still there, but a reader with a bigWig in hand and a browser on screen means
  one thing by dropping it, and asking them to find the right box first is a
  step that answers a question nobody had.

- **Gene names sit under the features**, in a band of their own, so a name never
  covers the exon structure it belongs to; below the height where that band
  would leave no room for a glyph they go back inside, which is what a lane
  dragged very short should do.

- **Aesthetics can turn every word off.** One toggle hides track names, value
  ranges and feature names together, leaving the ink — which is what a figure
  destined for a caption usually wants, and what a screenshot of six tracks
  usually does not. Shared with the heatmap's own panel and the command palette,
  so all three agree.

- **Chromosome boundaries are drawn**, as a full-height rule between sequences,
  and the ruler bands alternate by the sequence's position in the assembly
  rather than by its position on screen — so a boundary does not change shade
  when a pan brings a new sequence into view.

- **The tabs are shaped like tabs**, with tilted sides, the active one raised
  and lit along its top edge, and the pointer is the same black-filled arrowhead
  over the tracks that it is over the map. The × appears on the tab under the
  pointer and on no other — including the active one, which used to be an
  exception — and it lost the bordered box that was most of what the corner of a
  tab showed. One session is a title rather than a tab: the strip stays, because
  the way to a second session is the button on it, but a lone trapezoid with an
  accent bar is machinery announcing a choice nobody has been offered.

- **Every sequence in the genome, with its length, under the Genome card.** The
  first question a genome browser is asked, and until now the only answer was a
  count. Each row is a click that goes there, which is also the fastest way to
  navigate — a chromosome *is* a locus, and the locus box is for the case where
  you already know the coordinate. The bar behind each row is its length against
  the longest, which costs a gradient and turns a column of numbers into the
  shape of an assembly: sixteen bars in a staircase is a yeast, one bar with a
  thousand slivers under it is a draft. A filter appears above a dozen
  sequences, and at most three hundred rows are built at once, because forty
  thousand scaffolds is a second of layout for a list nobody scrolled to the end
  of.

- **A track's range is under its name, and you can type in it.** Two changes
  that are one change. A number at the far end of a lane from the name it
  belongs to has to be paired up by eye every time, and with four tracks stacked
  that is four crossings of the window — so it moved under the name. And a
  number that is under its name is a number you can put a caret in: hovering
  either end gives a text cursor, and clicking opens a box exactly where the
  number was drawn, so nothing moves when it becomes editable. Typing a bound
  turns autoscale off, because that is what typing a bound means. The two boxes
  that used to live in the lane's hover row are gone with it — the range is
  edited where it is read now, and what is left there is `auto`, the ceiling
  slider, the colour and the group.

- **A toggle for the shading under a track's line.** The pale envelope that says
  what a zoomed-out mean hid, and the fill an area track carries: one switch,
  because they are one thing to the eye. Both are *context* for the line, and
  context is the first thing to go when three tracks share a lane or a figure is
  going into a caption. Shared with the heatmap's own panel and the command
  palette, like the track-text toggle beside it.

- **The Plot card is marks rather than sentences.** Fit across, fit down, words
  on or off, shading on or off — four things a reader does over and over while
  reading, in a row of four icons instead of a column of full-width buttons
  spelling each of them out. The same two fit marks are on the toolbar above the
  tracks, because they are the same two actions. And the export controls are one
  line again: a vector page has no resolution, so the resolution is *absent*
  exactly when the long format name needs the width.

- **Memory and CPU on the status bar**, after what has been read and whether the
  file checks out. Per *browser tab* rather than per session, because the memory
  a gene model holds and the core a scan is burning are shared by every tab in
  the window.

  Both are weaker than what a task manager shows, and the tooltips say so
  outright. A page cannot see its own process — a precise figure would read
  across origins — so memory is the JavaScript heap and its ceiling where that
  is all Chromium offers, and the whole-agent measurement where a build is
  cross-origin isolated. CPU has no API at all, so it is measured from the
  inside: every thread in the tab times its own event loop, and the share of the
  last three seconds they could not answer in, summed against the machine's
  cores, is the number. Work too brief to delay anything never appears, so the
  reading is a floor rather than an estimate. The workers report their own, which
  is the point — a whole-genome scan pins a worker for minutes while the main
  thread sits idle.

- **Drop a file on the map itself to make it a track**, on the edge you aim at:
  a strip along its bottom for the horizontal stack, one down its side for the
  vertical one. Two rectangles appear while a drag carrying files is over it and
  are inert the rest of the time, because the map's own gestures — pan, the
  Option-drag selection, the click that opens a cell — live in the same pixels.
  What the file *is* is still decided by its bytes (§8.3): a `.cool` aimed at
  the bottom of the map is a map, not a track drawn along the bottom.

- **`/` puts the caret in the box, in every view.** It was the genome browser's
  alone, so the same key that found a gene did nothing the moment a `.cool` was
  dropped in the same tab. Each view now answers it with its own box: the region
  box on a region, the filter above a table, and a new one in the heading of the
  whole-genome, genome, pair and scan views — which is also the only way to
  leave those pictures by typing rather than by aiming, and a genome of one
  metagenome's four thousand is a quarter of a pixel to aim at. The key is
  printed in the box and steps out of the way when the caret arrives.

- **Every shortcut is on the button that performs it.** Tooltips name their key
  — the panel folds, the theme, the tab strip, both Plot cards, every overlay
  toggle, the breadcrumb's landing views — and the two `whole genome →` buttons
  and the breadcrumb menu print theirs as a badge. The bindings come from two
  tables (`ui/commands.ts` and `ui/plotOptions.ts`) that the key handler, the
  palette, the shortcuts dialog and every one of those tooltips now share, and a
  test asserts no two actions claim the same key.

- **A mark before every card title** in the three panels, so a column of five
  cards is recognised by shape before it is read.

- **A height for every track, and the button that gives it to them**, in the
  browser's Plot card beside the stretch mark. Stretching answers "use the space
  I have"; this answers "I know what a track should look like" — ninety pixels
  is where a yeast ATAC track starts showing the shape of a promoter — and it is
  also the way *out* of a stretch, which on a tall screen with two tracks leaves
  two four-hundred-pixel lanes and nothing to bring them down with. The box is a
  number and nothing happens as it is typed; Enter and the button are the
  instruction, so it keeps what you last applied and the next file is one press
  away from it.

- **Drag a track onto the other edge of the map to move it there.** The two
  rectangles that take a dropped file take a *loaded* track as well: pick a row
  up by its grip in the Tracks card, and both rectangles appear the moment it is
  over the map — drop on one and the track is drawn there instead.

  The gesture is on the row rather than on the lane's *body*, and that is the
  second attempt. Dragging the body is what a reader reaches for and there is no
  room for it there: a lane already answers three drags — its border resizes,
  along the axis pans, across reorders — so a fourth had to be read out of one
  of them, and the trip from the bottom stack to the right-hand rectangle is
  mostly sideways, which is a bottom lane's *pan*. It worked from one stack and
  fought the other. The row carries no such freight, and it is where the track's
  other settings are. (The lane got the gesture back in the end, on a handle of
  its own — see below.)

  A row now has a grip beside a map even when it is the only one, since there it
  has something to do besides reorder. The drag carries its own MIME type, so
  the rectangles can tell it from a dropped file and from a dragged word while
  the drag is still in the air, and the whole content area no longer lights up
  for it. It is the same state as the `location` setting on the row, because it
  is the same field.

- **`S` saves the plot.** Whichever view is mounted exports itself — the map or
  the browser — in the format and at the resolution its own Plot card is set to,
  because a shortcut that saved something other than the button beside it would
  be a second export to keep in step. It is one letter from `⌘S`, which saves
  the *session*, and that is the pairing: two things a reader means by "save
  this", told apart by the modifier. Stretching the tracks moves to `H`, for
  height.

- **`location`, in the row's settings, rather than `B`/`R` tick boxes on its
  head.** Two buttons with the words on them — `bottom` and `right`, and not a
  choice between each other, since a track can be on both — drawn as one
  segmented control below `height`. The initials were standing furniture in
  six-point type between a track's name and its eye, for a decision taken once
  per track and now also takeable by dragging the lane itself. The last edge a
  track is on cannot be switched off: a lane on neither edge is drawn nowhere
  while still calling itself visible, and the eye beside the name is what hides
  a track.

- **The drop zone is what lights up**, not the card around it. A card that asks
  for a file still takes one anywhere on it — a reader whose pointer is over the
  eighth row when they let go meant to load it — but what reacts is the dashed
  box, which is the element already drawn as the target. The whole card going
  blue around an inert rectangle said the rectangle was not the one. Tracks,
  Compare and the browser's Contact map card all behave this way now, and a
  *row* dragged within the Tracks card lights nothing, because a drag carrying
  no files is a reorder.

- **Plot before Groups** in the browser's Aesthetics column. Plot acts on this
  picture and is there whatever the file is; Groups is empty until a reader has
  made one, and a column that opens with an empty card reads as a column with
  nothing in it. The browser's toolbar also gives up its autoscale button, which
  was the sixth control in a row that then wrapped, orphaning one button on a
  line of its own — it is in the Plot card, on `Y`, where the height box is.

- **A track lands under the map, not beside it.** The bottom edge is where a
  track is read — under a ruler, left to right — and a coverage profile turned
  on its side has to be read with your head tilted. The right-hand stack is
  still there and is now something you choose: the `B`/`R` boxes on the row, or
  the edge you drop the file on.

- **`S` stretches the tracks** to fill the height, all of them to one height,
  which is the thing a reader reaches for several times a session. Autoscale,
  which had `S`, is now `Y` — the axis it acts on — and works beside a map as
  well as under a browser, since they are the same tracks in the same store.

- **The status bar is one line, always.** It is the bottom edge every view is
  measured against, and it grew a second line exactly when the pointer was over
  a stack of tracks — when the reader is least interested in it. So `read` is
  bytes and keeps the request count in the panel it already opens on hover,
  `memory` is bytes and keeps the share of the ceiling there too, and the
  coordinate readout is the item that gives way, being the one thing here that
  is re-said a moment later.

- **The standing `read in place · nothing is sent` line is gone from the bar.**
  The claim is not: the picker states it where a file is about to be opened, and
  About states it in full. It was a sentence you finish reading once, permanently
  occupying a corner of a bar whose other three items are numbers that change.

- **The shortcuts dialog has no Help group**, so the two gesture tables — what a
  drag, a wheel and a double click do on a map, against what they do on the
  tracks — sit side by side, which is how they are read. `⌘/` was the only bound
  command in Help and is now beside the palette in App, where it belongs. Both
  tables also gained the gestures they had been missing: the lane resize, the
  edge drops, and dropping a file on the browser's tracks.

- **The Compare card and the browser's Contact map card wear the Tracks card's
  load zone** — a thin unshaded box with a bold line and a quiet one, then the
  URL behind a fold. All three ask the reader for a file, and three shaded
  variations of one gesture in one column read as three applications. The
  Contact map card can now take a URL, which it could not before.

- **One box in the browser's toolbar**, not two. `chrIV:1,000-2,000`, `chrIV`
  and `GAL4` are three spellings of "where do I want to be", and asking which of
  two boxes each spelling belonged in was a taxonomy the reader had to learn in
  order to type a word. Coordinates win when the text is coordinates; anything
  else falls to the list of names under the box. Clicking it selects what is
  there, because what is there is where you already are, and `/` still lands in
  it.

- **Loading a track is at the top of the Tracks card**, rather than in a card of
  its own below it. The two questions are asked of the same thing, and with
  eight tracks loaded the way to load a ninth was to scroll past the eight.

- The app was one object holding a worker, a store, a file and a view, and it
  bound itself to the address bar in its constructor. It is now `app/Session.ts`
  — a file and the views of it — and `app/App.ts` — the window around them —
  with `main.ts` as three lines of bootstrap. `ViewStore` stops owning the hash,
  because there is one address bar and there may be six stores.

- The sample cache that keeps pan and zoom free of I/O moved out of
  `AnnotationLanes` into `annotations/samples.ts`. Two widgets need that rule now
  and its arithmetic — the padded window, the power-of-two bucket, keeping the
  old data on screen until the new data lands — is fiddly enough that two copies
  would drift.

- A `chrom.sizes` dropped on a browser whose lengths were *inferred* replaces
  them, and replaces only them: the URI, the session memory and every loaded
  track stay exactly as they were, because the genome did not change — only what
  is known about it. A `samtools faidx` `.fai` counts as one, decided by its
  name, which is the tiebreak `sniffFormat` already uses for the two cases its
  columns cannot settle.

- The colour swatch beside a track's name in the Annotations panel appears when
  the row is pointed at or has the focus, like the drag handle it sits next to.
  A column of coloured squares down the panel is a second legend for something
  the picture already says where it matters — the lane is drawn in that colour,
  and where two share a lane so is each name. It keeps its space while it is
  invisible, so reaching for it is one movement rather than a hunt.

- **Every lane has a grip, in both views.** Six dots beside the track's own
  name — the same glyph the Tracks card puts at the head of every row, because
  it is the same gesture on the same thing. Dragging it moves the track through
  the stack; beside a map, dragging it out onto either rectangle draws the track
  on that edge instead. Reordering a track was something you could only do to
  the picture from the *list* beside it, or by learning that a drag across a
  lane means one thing and along it means another.

  It is a fourth *surface* rather than a fourth reading of one, which is what
  makes it possible at all: a press that starts on the handle is not ambiguous
  in any direction, so it can mean "move this track" everywhere the pointer
  goes, and the three drags the lane's body already answers keep their pixels
  untouched. Drawn on the canvas rather than laid over it, for the reason every
  affordance here is: the pointer is an arrowhead pointing at a base pair, and a
  handle that lived in the cursor would not exist until you were on it. It takes
  the open hand as its cursor — the one thing the arrowhead cannot say — and is
  never on a saved figure, because what a reader points at is not part of the
  picture.

  **It is the only way to move a track.** The lane's body used to reorder as
  well, by reading the direction of the first movement — along the axis a pan,
  across it a reorder. Two meanings for one surface is a rule you have to know
  before your first drag does what you meant, and it was paid for on every pan
  that wandered a few pixels off the horizontal: the track jumped a slot,
  because a gesture that has to be performed *carefully* had been asked for.
  With a surface of its own for moving, the body goes back to meaning one thing.

  It hangs **outside** its lane, in the margin just before the data starts, and
  that is what lets every lane show one at all times. Inside, it had to be paid
  for twice: a slot cut out of the front of each label, which moved every track
  name along, and a glyph that could only appear on hover — because a permanent
  one would have been sitting on the signal. Outside, it costs the picture
  nothing, so the names went back against the start of their own track and the
  handles stopped being something to discover. Each one is on its name's line
  and keeps its distance from it, wherever the layout put that name: at the top
  over the data, centred in a column, down at the floor on a flipped track. The
  faint one is a handle; the solid one is the lane the pointer is on.

  The 1D browser keeps a thirteen-pixel strip at its left for them, since
  outside its first lane is off the edge of the canvas otherwise. Beside a map
  no strip is needed — the plot's own margin is where they go. Which end of a
  lane that is depends on which way the lane reads: the left of a bottom lane,
  and the *bottom* of a right-hand one, which turns a quarter turn and reads
  upward from there. A handle at the far end of a track from its own name is a
  handle belonging to nothing in particular.

  A grip drag raises the **other** edge's rectangle and only that one. A track
  taken out of the bottom stack cannot be moved to the bottom — it is already
  there — so offering it that target is offering a gesture with no outcome, and
  a rectangle that lights under the pointer and then does nothing when you let
  go reads as the drag having failed. The rectangle that is not offered is not a
  drop target either, decided in one place, so what lights up and what lands
  cannot disagree. A file dragged in from the desktop still gets both, since it
  is on neither edge yet.

  The right-hand stack makes its own room. Its handles hang past the end of the
  data, where the space available is whatever the heatmap left under its plot —
  a couple of pixels in a view with no column labels — so rather than back the
  handle into the signal, the stack adds the few pixels it is short to the end
  of its own canvas. After the data, so no coordinate moves and the map is not
  touched, and only when the margin is not already enough.

- **Loop anchors moved off the last track.** The triangle that says "this
  coordinate" was drawn over the last seven pixels of the last lane in the
  stack — on a coverage track that is the busiest part of it, and on a full one
  the mark is invisible. It now has a band of its own past the stack, on both
  edges, which is the only place a glyph about the axis can go without being ink
  on somebody's data. The band is nine pixels and exists only while a loop is
  marked, so a session that never places one keeps those pixels for the map.

- **The map's two drop rectangles moved inside the map, and became strips.**
  They covered the bottom quarter and the right fifth of the whole plot area —
  which is where the lane stacks are — so a track dragged towards the end of its
  own stack met a drop target instead of the gap it was aiming for, and the last
  slot in the order could not be reached at all. Inside the map they overlap
  nothing that can be dragged, and they still name the edge they stand for: the
  bottom of the picture means below it, the right of the picture means beside
  it.

  Narrow, too, and **centred on the edge they name**: thirty pixels thick, four
  fifths of the map long, each in the middle of its own side. A quarter of the
  map's height and a fifth of its width is a lot of a picture to cover in order
  to say "this edge", and at that size the two rectangles hid the corner of the
  matrix a reader is usually aiming past on the way to them. Centring at four
  fifths is also what keeps them apart — each stops a tenth of the map short of
  the corner they share — so a drop in the corner lands on neither, which is the
  honest answer to a gesture aimed between two targets. Down the side the label
  turns the same quarter turn as the track names in the stack it is naming. All three
  gestures that aim at them — a file from the desktop, a row from the Tracks
  card, a lane by its handle — now arm them, and while a lane is being carried
  the tooltip stays down rather than following the pointer across the map with a
  reading from where the drag started.

### Fixed

- **The service worker would have answered a pinned URL with the newest build.**
  It is registered at the site root, so every archived build's address is inside
  its scope, and its navigation handler answered *everything* in scope from the
  precached shell — the right URL, the wrong code, and no symptom to notice it
  by. Navigations under `<scope>v/` now go to the network untouched.

  A worker only updates when a page it controls is loaded, so the fix cannot
  reach a reader who is already carrying an older one — and that reader is
  exactly who follows a pinned link. `recoverPinnedNavigation()` catches the
  case from the page itself: a document built for the site root, at an address
  under the archive prefix, is a pair of facts that cannot both be true of a
  correctly served page. It unregisters and reloads, once per tab, because the
  second attempt at that would be a reload loop.

- **A cooler rendered nothing.** `MatrixPanel`'s new edge-drop watcher read
  `this.el` from the constructor, where it does not exist yet, so the panel threw
  on the way up — for every file that *has* annotations, which is every cooler,
  while a `.metacool` (which has none, §8.5) was unaffected. Clicking a contig or
  opening the whole-genome view produced no map at all. The listeners go on the
  grid instead, which exists by then and is the honest scope anyway: it holds the
  map, its lanes and the two zones, while `this.el` reaches the colourbar and the
  header, where a drag means nothing.

  It survived a type check, 697 unit tests and a code read, because none of them
  run the constructor. What catches this class of defect is opening the app, so
  the working file now gets opened: a genuine `.cool` built by the public cooler
  API, served over range requests, driven through the contigs table, the
  whole-genome view, a region, and a browser session with a track in it.

- **The labels overlay could not be toggled in a genome browser session.** `L`
  was bound twice — the overlay, and "go to a locus" — and the command list is
  searched in order, so in a browser the locus box always won. The browser has
  one box that is both a locus bar and a search field, and it now has one key
  for it (`/`), which is the key every other view answers too.

- The icon generator dropped every SVG attribute whose name contained a digit,
  so every `<line>` was emitted with no coordinates and drew nothing. It had
  been latent because no icon used one; the magnifiers added here came out as
  bare circles.

- A lane's hover controls took presses while they were invisible. `opacity: 0`
  hides a control but does not stop it being clicked, so every track carried a
  band across it — three hundred pixels wide and thirty tall — where a drag
  started on a `<select>` and the view silently refused to pan. They are now
  transparent to the pointer until the lane they belong to is the one being
  pointed at, and the pointer moving onto them no longer counts as leaving the
  view: without that the row goes untouchable, the pointer lands back on the
  canvas, the row is revealed again, and the control under the hand is never
  there long enough to be clicked.

- "Fit tracks to the space" measured the element it was about to resize, which
  is sized by its own contents — so it compared the tracks against themselves,
  found them already fitted, and did nothing at all. It now measures the column
  the view was mounted in, walking past the `display: contents` wrapper that
  gives a session's panels to the shell's grid and reports every rectangle as
  zero.

- Every control that appears on hover — a tab's ×, a track's colour swatch — is
  now inert while it is invisible, and shown outright where there is no pointer
  to hover with (`@media (hover: none)`). Both halves matter: `opacity: 0` hides
  a button and does not stop it taking a click, and a control revealed by
  pointing is a control that appears never on a touch screen. Each appears with
  no transition and fades only on the way out, so there is no moment in which
  one is clickable and barely drawn.

- Moving the caret from one lane's limit straight to another's kept the first
  number. The press that lands on a second limit is handled on `pointerdown` and
  calls `preventDefault`, so it never produces the focus change that would have
  committed the first — and the editor was being *cancelled* on the way out. The
  natural gesture for setting the same bound on two tracks was therefore the one
  gesture that silently threw the first value away, while clicking anywhere else
  on the canvas committed it.

- With the words switched off, the lane's two limit boxes were seeded once and
  never refreshed, and committing either one wrote *both* — so typing a floor
  republished whatever ceiling the row happened to be built with, silently
  undoing a zoom or a drag of the ceiling slider. Each box now commits its own
  bound and takes the other from the axis on screen, exactly as the drawn range
  does, and the untouched box follows the lane it is beside.

- Choosing PNG collapsed the export row: the resolution select inherits
  `width: 100%` from the controls card, and a `flex-basis: auto` resolves to it,
  so a control that must not shrink claimed the whole line — crushing the format
  select to nothing and pushing Save off the card.

- A click in the Sequences card now moves the view directly rather than through
  the view state. A patch that serialises to what is already stored is dropped
  without notifying, so clicking the sequence the hash already named could do
  nothing at all.

- `fmt.int` groups digits in the *viewer's* locale, and half of Europe groups
  them with a space WinAnsi has no byte for — so a figure exported in French
  read `7?071 in view`, every grouped number corrupted by the app's own
  formatter, in the one place nobody would look for a locale bug. Those spaces
  now fold onto the non-breaking space WinAnsi does have.

- Ticking a track did not open the batch bar until the focus left the list. The
  rebuild is deferred while a control in the list is being edited — a colour
  picker closes and a half-typed name is lost otherwise — and a checkbox was
  being counted as one, which deferred the very rebuild the tick was asking
  for. It commits on the click that focuses it, so there is nothing to protect;
  the focus is put back on the same box afterwards, so a second tick needs no
  second aim.

## [0.5.1] - 2026-08-04

### Fixed

- Fixed unit tests that errored on Github runners without fixtures.

## [0.5.0] - 2026-08-04

### Added

- **Right-click the map to mark the cell under the pointer.** Vertical line,
  horizontal line, crosshair, loop — each row showing the coordinate it would
  use, so what is about to be marked is visible before it is — and copy
  coordinates. The two ways in that existed were typing a coordinate you already
  know and arming a mode and clicking; neither answers "this one, the one I am
  pointing at".

- **Lanes beside the map are draggable, and carry their own menu.** The border
  resizes a track, the body reorders the stack, and dragging *along* the axis
  still pans the map — which it has to, since that is what dragging a track has
  always done. The direction of the first movement tells the three apart, so
  nothing needs a modifier key and no gesture was given up for another. A right
  click on a lane offers its colour, its range, hide and remove: the two
  controls a reader beside the map actually reaches for, where the track is
  rather than across the window in a card.

- **Hand-drawn lines are continued into the lanes.** A vertical rule is a column
  and is drawn under the map; a horizontal one is a row and is drawn beside it;
  a crosshair is both. Loop anchors are small triangles on each stack's outer
  edge, pointing back at the map. A mark called out on the matrix is a
  coordinate, and the tracks beside it are what a coordinate is usually being
  compared against — the marks were on the map alone, which is where the
  comparison could not be made.

- **Tick any number of genomes or sequences and see them as one map.** Each on
  the diagonal and every block between them off it — the picture the pair view
  showed for exactly two, without the two diagonals that make an off-diagonal
  block readable. Both tables carry checkboxes now, with "select all" over
  whatever the filters leave visible (filter to completeness above 90, then take
  all of them) and "clear"; the button names two and counts more, because
  `MAG_7 × MAG_12 →` is worth more than a number and four names are longer than
  a button.

  It is a view state — `view=selection&genomes=a,b,c`, or `regions=` for
  sequences — so a selection is a link, a history entry and a back button, and
  `genomes=a,b` is precisely what `view=pair` used to be. The pair view stays
  where it is: the overview's cross-genome clicks lead there and so do links
  already sent.

  The read is the whole-file scan with most of the file left out. A selection is
  scattered through the pixels, so there is no shorter span to walk — the gate
  says so, and the progress bar and cancel are the ones the whole-genome read
  just gained. The axis is built from the selection in *file* order rather than
  the order it was ticked in, because a matrix whose rows jump about is a
  picture of the clicking; it is pooled against its own size, so four MAGs are
  drawn at four MAGs' resolution however large the file they came from is; and a
  genome resolves to its contigs, so ticking four MAGs and ticking their contigs
  are the same map. Checked on every fixture against the same oracle the pooled
  read uses: a scattered selection equals the dense block rolled up over the
  same grouping, cell for cell.

- **The app says what it is on the way in.** The mark — the same drawing as the
  favicon, the install prompt and the dock icon — is now a masthead on the
  landing page: mark and name on one line, centred, spanning 80% of the drop
  zone below them, with the tagline under and 20 px of air above. Both are
  scaled by one `clamp`ed font size, so the pair stays one thing from a phone to
  a wide window. In the header
  it sits at 26 px before the name, sharing its centre — the brand row was
  baseline-aligned, and an image's baseline is its bottom edge, so the mark hung
  visibly high against the words. The first screen used to open on an
  instruction, which made it a dialog rather than a page. It is read from the
  192 px file `npm run icons:app` already writes, not a fifth copy of the shapes.

- **"whole genome →" in the genomes and chromosomes tables.** The whole-file view
  was reachable from the chevron beside the root crumb and nowhere else, which is
  a corner of the window to find something the table in front of you is the
  question about. The metacool gets its scan, the cooler its map; the button is
  absent on a metacool's per-genome contigs table, where "the whole file" is not
  what is being asked.

- **The cooler's whole-genome read has a progress bar and a cancel**, the same
  two the whole-metagenome scan has always had — it is the same pass over every
  pixel of the same file, and the difference was in the plumbing rather than in
  the wait. What made it possible is the reader walking a span *asynchronously*:
  a cancel arrives as a message, and a synchronous loop never lets the message
  queue run however many microtasks it awaits, so a read that could take twenty
  seconds could not be called off and could not say how far along it was. The
  contig roll-up is watched the same way, since it walks the same pixels.

- **Hand-drawn marks can be saved.** The Manual annotations card grows the export
  row the Aesthetics panel has — a format, and a Save — writing lines as BED and
  loops as BEDPE, one base wide and half-open. Both come back through this app's
  own sniffer and parsers as an overlay on the map, which is the property
  `manual-export.test.ts` checks rather than the text; and both are what bedtools
  reads, because a coordinate someone chose outlives the session they chose it
  in. Nothing to write is a disabled button rather than an empty file.

- **The whole-genome view of a cooler is read at the resolution it is drawn at,
  and there is no longer a file size that defeats it.** It used to ask for one
  cell per file bin, which at 24,228 bins is 2.3 GB of values in one array — and
  a browser serves at most 2 GiB in one, whatever the machine has, so a whole
  yeast genome at 500 bp was offered, computed for several seconds, and then
  refused. The picture it was refused for was one nothing could have shown: the
  renderer pools any raster to 4,096 px per axis, so those 24,228 rows were
  always going to be drawn as about 4,000 pixels.

  So the pooling moved to the read. Every `stride` consecutive bins of a
  chromosome are summed into one cell, in the worker, straight from the stored
  pixels — the block that arrives is the one that was always going to be drawn.
  Yeast at 500 bp is 4,047 cells and 66 MB instead of 24,228 and 2.3 GB; at
  200 bp, where the dense block would have been 14.7 GB, it is the same 66 MB.
  A human cooler at 10 kb, 381.9 GB dense, is 67 MB and 760 kb cells. The read
  is bounded by construction at every bin size a file can have.

  **What arrives is an ordinary block one bin size up**, not a new kind of
  object: the stride restarts at every chromosome, so a cell is `stride` bins of
  one sequence and a run of cells is that sequence. The panel is told the coarser
  bin size and every coordinate, tick, tooltip, region box and figure caption is
  then right without knowing pooling happened — a box drawn on the 3 kb overview
  still opens that region at the file's own 500 bp. It is the relationship an
  `.mcool`'s 5 kb level has to its 1 kb level, computed on the way through rather
  than stored, and the sums are identical to `metacooler aggregate` over the same
  squares (`pooling.test.ts` checks every fixture, cell for cell, against the
  dense read rolled up by the existing folded aggregation).

  What the view still costs is the pass over the stored pixels, which is what it
  always cost, and that is now what it asks about: above ten million pixels the
  map waits behind a button that states how many there are and what resolution
  they will be summed into. Below it nothing is asked. The whole-metagenome scan
  is gated for that same reason, and the two views now behave alike down to the
  wording.

- **Both whole-file views are kept across navigation.** They are the expensive
  reads, so the shell holds whichever one it built, keyed on what was read (uri,
  level, balance): leaving one for a chromosome and coming back returns to the
  picture rather than to the gate. Changing the level or the balance is a
  different read, so that one is rebuilt and the old block released rather than
  left in memory unread.

### Removed

- **Captions on hand-drawn marks.** A text box under every mark, for a sentence
  the figure already makes. Gone from the card, from the model and from the
  drawing — and with it the label helper, the halo it needed and the type size it
  was written at.

### Fixed

- **A right-click on the map no longer navigates.** `mousedown` fires for every
  button, and the map's press/release pair had no guard, so a right-press was
  answered as a click on release: right-clicking a whole-genome view opened
  whatever cell was under the pointer, and the menu the press was for arrived
  over the view it had just left. The primary button only, now — and the same
  guard on the side panels' drag handle, where a right-press armed a resize the
  browser's own menu then sat on top of.

- **Both ends of a loop are marked on both 1D axes.** A loop is a statement
  about two loci, and a reader looking at the tracks under one end of it is
  asking what is at the other. Drawing the row anchor only beside the map and
  the column anchor only under it answered half of that on each edge, and
  neither half where the comparison is made.

- **The masthead's mark sits on the word's centre line.** Centring the two boxes
  left it visibly high: a line box carries the font's ascent and descent, so the
  ink of a word sits below the middle of its box while a square's ink is its
  box. Measured on the rendered pixels — 10.5 px of offset at a 97.6 px font —
  and corrected in `em`, so it holds at every size the `clamp` produces.

- **A block too large for one typed array says which limit it hit.** A browser
  serves at most 2 GiB in a single `Float32Array` whatever the machine has:
  measured in Chrome on a 16 GB Mac, 2,140,000,000 bytes is served, `2**31 - 4`
  is not, and four separate 1 GB arrays live side by side. It is a limit on one
  array, not on the tab, and the refusal used to blame "this machine".

  It is now checked ahead of the memory budget and cannot be overridden by a
  confirmation, because there is nothing to override; the message names the
  largest square block that can be made (about 23,170 × 23,170 bins) and the ways
  through. The whole-genome view no longer reaches it at all — it reads pooled —
  so what it governs now is a region, a genome or a pair.

  A test asserted that yeast at 500 bp loads densely, and was passing, because it
  exercised the *estimate* and the estimate never tried to allocate anything.

- **The Annotations panel scrolls as a whole, not card by card.** Twelve little
  scrollbars where the reader wanted one. `overflow-x: auto` was set on the cards
  so a wide one could scroll sideways inside a narrow column — but a box with
  `overflow-x: auto` and `overflow-y: visible` is not a thing CSS has: the
  visible half computes to `auto`, so every card was a scroll container in both
  directions, and a flex item shrinks by default, so each one was squeezed and
  scrolled inside itself the moment the panel was full. `flex: 0 0 auto` on the
  cards is the whole fix. `.side` keeps the opposite behaviour deliberately: a
  view's sidebar fills the column so its contig list can scroll where it is.

- **Less white between a key and its value in the File card.** The key column was
  a fixed 9rem, set when values were elided and had to start at a predictable
  place. They run to their full width now, so there is nothing to line up with,
  and the column takes what its longest key needs.

- **More room before any of that.** The memory budget is now half of what the
  device claims rather than a third, and the assumed memory where the browser
  says nothing — Firefox and Safari, on every machine — is 8 GiB rather than 4.
  A 20,000-bin block, 1.9 GB, was refused outright on both of those engines and
  now loads. Guessing high costs nothing since the allocation itself is caught
  and translated; guessing low was costing pictures the machine could draw.

- **The whole-metagenome view is a view state, not a mode the shell holds.** It
  was the only landing view of a file with no link, no history entry and no back
  button — pick it and the URL did not move, so it could not be shared, and
  reloading landed on the genomes table. It is `view=overview` now, a peer of
  the two tables it shares the root menu with, and everything that follows from
  that follows: the level and the colour scale are in the hash like every other
  view's, the back button leaves it, and the plot re-measures when a side panel
  is dragged — which, being mounted outside the shell's own view slot, it did
  not.

- **The three panels resize — which, despite 0.4.0, is the first time.** The
  drag handle, the remembered width and the double-click reset all shipped, and
  none of them could be reached: the handle was a sticky flex item at the end of
  a column that was already full, so it was laid out *below* the fold, and
  `sticky` only holds an element that scrolling would carry away — it never
  pulls one up into view. The negative margin meant to cancel its height could
  not, because a percentage margin resolves against the containing block's
  width whatever axis it is on. So the strip was real, painted, and permanently
  out of sight.

  It is now positioned against the column, and the column no longer scrolls:
  its body does. The heading staying put while the cards move under it is the
  same change seen from the front.

### Changed

- **Saving a figure is one row: resolution, format, Save.** It was a DPI
  dropdown, then a line of two buttons labelled `PNG` and `PDF`, two rows
  further down — which made the choice of file into the action itself and left
  the resolution stranded above the thing it applied to. Now the row reads the
  way the sentence does: 300 dpi, PDF, Save. Both defaults are unchanged; PDF
  simply stops being the second button and becomes the one that is already
  chosen.

- **Cards in General scroll sideways rather than eliding or wrapping.** A URI
  cut off at `Hum66.met…` and a genome name broken across three lines are the
  same failure: this panel is where you go to read the identity of what is on
  screen, and an identity you cannot read whole is not one. Keys and values now
  keep to a single line and the card scrolls under them. Hovering still gives
  the full text, for the reader who would rather not.

## [0.4.1] - 2026-08-04

### Changed

- **A real app icon, dark, everywhere an icon appears.** The mark is the thing
  the viewer draws — a block-diagonal contact map, three genomes on the
  diagonal and two long-range contacts off it — on a macOS-style plate. It
  replaces the flat blue square with two white blocks, and it is now one
  drawing rather than two: `scripts/make-app-icons.py` renders the browser tab
  favicon, the install prompt's 192 and 512, a new `apple-touch-icon.png` for
  the iOS home screen, and the 1024 square electron-builder derives every
  macOS, Windows and Linux icon from. The favicon is written into `index.html`
  by the same script, from the same constants, so the tab icon and the dock
  icon cannot drift apart the way the two hand-kept drawings could.

  The dark variant is the one that ships at every size. The light one is still
  drawn, into an ignored `out/`, so the mark exists in both values — but
  nothing in the build reads it.

  The plate's edge is now a ring band — the difference of two squircles, filled
  with a vertical gradient — rather than a stroked outline clipped back to the
  silhouette. The old way drew the border at full strength and then threw most
  of it away in the compositing, against a mask whose own edge is antialiased,
  which is why the light plate had a border only in the sense that something
  was there. Each variant now names a `rim` and a `bevel`: the light plate gets
  a warm dark hairline with a white highlight inside it, the dark plate the
  white hairline it already had, crisper.

- **The Linux window carries the icon too.** electron-builder installs the
  launcher entry and the hicolor ladder, but the window itself is drawn from
  what the process declares, so the taskbar and the alt-tab switcher showed the
  default Electron icon. `build/icon.png` now ships beside the asar as an extra
  resource and `BrowserWindow` names it. No change on macOS or Windows, where
  the bundle and the `.exe` already answer that question.

### Removed

- `scripts/make-app-icons.mjs`, superseded by `scripts/make-app-icons.py`. It
  wrote the same three files, so leaving it would have meant one `npm run
  icons:app` away from silently reinstating the old mark. `icons:app` now runs
  the Python script and takes `METACOOLER_PYTHON` the way `fixtures` does; it
  needs `pillow` and `numpy`, and the icons it draws stay committed, so no
  clone and no CI runner has to have either.

## [0.4.0] - 2026-08-04

### Added

- **Three named panels — General, Annotations, Aesthetics — all foldable and all
  resizable.** They had grown into three unrelated things: a sidebar with a fold
  button, a column added beside it with a fold button copied from it, and a
  controls column with no button and no name at all. They are the same object, so
  they are now one; what differs is a name, a side and a default width. Drag a
  panel's inner edge to resize it, double-click the edge to reset it, and both
  the width and the fold are remembered. <kbd>b</kbd>, <kbd>a</kbd> and
  <kbd>m</kbd> fold them. A card too wide for the column it is in scrolls inside
  it rather than spilling out of it.

- **The tracks pan and zoom the map.** A lane is a picture of the same window the
  map shows, drawn through the same scales, so dragging one and dragging the map
  are the same gesture on the same data — and a track you could read but not move
  was an exception a reader had to discover. Dragging a bottom lane scrolls the
  columns, dragging a right lane scrolls the rows, and a wheel over either zooms
  exactly as a wheel over the map does. The lanes carry the map's arrowhead
  cursor for the same reason.

- **An annotations panel of its own**, between the file sidebar and the map. The
  three annotation cards used to live in the file sidebar, folded in under the
  record card, and shared its scroll box: a growing list of tracks bought its
  height by pushing the file's own identity off the top of the screen, and
  folding the sidebar to get the room back took the annotations with it. They
  are now a column with its own fold (a `layers` button beside the sidebar's, or
  <kbd>a</kbd>) and its own scroll. The two left columns are ordered outward from
  the map by how often they are touched.

- **The colour and the name are edited where they are shown.** Clicking the
  swatch in a row opens the colour picker; clicking the name edits it in place.
  Both were fields behind the settings disclosure, which made the two commonest
  changes to an annotation among the most expensive. They are no longer offered
  in the settings, because they are no longer hidden.

- **Rows can be reordered**, by dragging the grip or by focusing it and pressing
  the arrow keys. The order is the order the lanes are stacked in beside the map,
  so this replaces removing three tracks and dropping them again in the order you
  wanted.

- **One hairline, and every value at once, when you point at a track.** Hovering
  a lane draws a single line — not a crosshair — across the lane stack and the
  map, at the position under the pointer, and the tooltip reads out *every* value
  track on that edge at that position rather than only the lane being pointed at.
  The lane the pointer is in is marked. A gene or peak under the pointer is
  described underneath.

- **Placing marks by clicking the map is a mode**, not a single shot. "Pick on
  map" stays on and becomes **Done**; every click places a mark until Done or
  <kbd>Esc</kbd>. Marking up a figure is eight gestures, not one, and the trip
  back to the sidebar between each was the whole cost of the feature.

- **Autoscale groups are a picker.** A group is only a group once two tracks are
  in it, so the second track has to be given the *same* name as the first — and
  the free-text box gave no way to find out what that was. A misremembered name
  raised nothing; it quietly made a group of one. The list is now the memory, and
  `new group…` is where a name is coined.

### Changed

- **The centre column stays light in the dark theme.** A contact map is a
  *figure*: its colormaps are built for ink on white, its labels and frame are
  drawn in the greys `ops/show.py` uses, and what leaves as a PNG or a PDF is
  light whatever the screen was. Letting the theme through meant the picture on
  screen was not the picture exported — and the halo behind every label, which is
  the page background, turned black behind dark grey text on a white plot.
  Everything around it — header, panels, status bar — is dark as before.

- **The lane tooltip names the position, not the lane.** The lane is the one the
  pointer is on, which the pointer already says and the marked row repeats; the
  heading is now the coordinate alone. Values read `name: number`.

- **The `auto` limit is a button**, bordered while it is on, rather than a tick
  box — and typing either bound turns it off, which is the only thing typing a
  bound can mean. The tick box was a third control on a row that already held two
  number boxes, and it took the width that made them overflow their card.

- **The annotation cards have lost their subtitles.** Each drop area under the
  heading already says what it takes and how it is drawn.

- **A new annotation is drawn on the right edge**, not the bottom. The bottom
  already carries the coordinate axis, the block labels and the colourbar
  caption, and a stack of tracks there pushes the map up the page; the space
  beside it is empty in every view. Both tick boxes still work as before.

- **Lane height is typed in pixels**, with the drawing style beside it, in place
  of a slider. A slider is for a quantity with no natural unit, and this one has
  the most natural unit there is.

- **Track limits are trimmed** the way the colour clip's boxes already were, and
  capped at three decimals. A bigWig header stores `float32`, so the faithful
  seed for a limit was `0.03999999910593033`.

- **Loop calls are ringed once**, on the upper side of the diagonal, instead of
  on both. The matrix is symmetric, so ringing both said the same thing twice —
  and on a set of any size the second ring was a few hundred circles the reader
  has to check against the diagonal to know they are not a second set. A view
  whose two axes are different blocks still shows the one placement it can.

- **A track's summary no longer counts the file's zoom levels.** That is a fact
  about how the bigWig was built rather than about what is in it, and it pushed
  the value range — the number a reader can act on — onto a second line.

### Removed

- **The per-track `linear`/`log2` scaling option.** It was a dropdown whose
  effect on a lane forty pixels tall was hard to read and easy to forget having
  set, and it put a lane on a different value axis from the one beside it, which
  is the opposite of what the autoscale group next to it is for. A ratio that
  wants a log axis is better written that way by the tool that made the bigWig,
  where the axis label can say so. A stored session that had `log2` set comes
  back linear.

### Fixed

- **The colourbar no longer disappears when tracks are shown.** Assigning
  `canvas.width` clears a canvas, and the legend's redraw was guarded on the
  colour *scale* having changed — which a resize does not change. Adding a track
  was enough to trigger it: the lanes relayout the plot, the resize observer
  fires, the bar is cleared, the guard says the scale is the same, and the legend
  is gone for as long as the view lasts. The invariant now lives inside `resize`,
  where a third caller cannot forget it.

- **A right-hand lane stack no longer overflows the column it is in.** The map's
  height budget accounted for the tracks stacked *under* it but its width
  accounted for nothing stacked *beside* it, so nine tracks on the right edge ran
  out under the view controls — where the far half of the stack was not merely
  off-screen but could not be hovered at all. Unreachable before this release
  because the bottom edge was the default; the default is now the right one.

## [0.3.0] - 2026-08-04

### Added

- **Tracks and annotations, on cool and mcool files.** Three cards in the left
  sidebar, and everything they draw. See [SPECS §8](SPECS.md#8-tracks-and-annotations).

  **Linear annotations** takes one GTF or GFF gene model, any number of bigWig
  tracks, and any number of BED-like segment files (BED 3–12, narrowPeak,
  broadPeak). Each is drawn beside the map on the bottom edge, the right edge or
  both, with its own colour, height, style (line, area or bars), value scaling
  (linear or log2), and limits — auto, which rescales to what is on screen, or a
  pair of numbers. Tracks that share an autoscale **group** resolve to one range
  over everything they show, which is the only way two of them can be compared
  by eye.

  **Map overlays** takes BED-like files as marks on the diagonal — a box for an
  extent, a mark across the diagonal for a point call, which is the only shape
  that survives being zoomed out — and BEDPE-like files as circles off it. A
  headed table with `chrom1/start1/end1/chrom2/start2/end2` counts as BEDPE,
  because that is what loop callers actually emit.

  **Manual annotations** takes vertical, horizontal and crossed lines, and
  arrowheads on or off the diagonal. Both are entered as coordinates or placed
  by clicking the plot, and both are stored in base pairs, so they survive a
  zoom, a pan and a change of resolution in an `.mcool`.

  Nothing drawn on the map fills the pixel it is about: loops are open circles,
  domains are outlines, and the arrowhead sits *outside* the cell it points at,
  on the far side from the diagonal — mirrored below it, so a mark placed while
  reading the upper triangle never points into the map from the lower one.

  Everything stays locked to the matrix because it is drawn through the matrix's
  own coordinate scales; nothing here computes a second mapping. Panning and
  zooming perform **no I/O**, as they already did for the map: a track fetches a
  window half again as wide as the view at a resolution rounded to a power of
  two, and everything inside that redraws from memory. Zooming out averages
  through bigWig's own zoom levels, and a feature lane with more features than
  pixels switches to a density profile rather than painting a solid bar. Hovering
  a lane names the feature or reads out the value; the crosshair continues from
  the map into every lane; exported PNGs and PDFs carry the lanes, redrawn at
  the export resolution.

  Contig names are checked on load and the overlap is always reported, in both
  directions — a GTF using `chrI` against a map using `I` is the most likely
  support question there is, and it presents as a broken feature rather than as
  two files disagreeing.

  Restricted to cool and mcool. On a `.metacool` the cards are **absent**, not
  disabled: a metagenome's axis is contigs from thousands of independently
  assembled organisms, so a file keyed on contig names either coincides with it
  or misleads.

- **One click loads the ten tracks published beside the yeast micro-C map.**
  Gene models, MNase, ATAC, Pol II ChIP-over-input, stranded RNA-seq, shotgun
  coverage, two peak sets and the loop calls — all on that map's own assembly.
  Offered only when the map itself came from a URL, never for a local file that
  happens to share the name.

- **The tooltip says how far apart a contact is.** Hover an off-diagonal cell
  within one chromosome or contig and it now reports the genomic distance
  between its two ends, which is the number a Hi-C map is actually read by. It
  is deliberately absent where there is no answer rather than shown as a large
  one: a trans cell has no distance along a sequence, and on the diagonal it is
  zero.
- **The tooltip names the genome, in the whole-genome view of a metacool.**
  It led with the contig, which on a metagenome is the finer half of the answer
  and rarely the one you want first. The genome now leads and the contig sits
  under it; a cell between two genomes names both. The picture underneath is
  unchanged — the separators are still the contigs.

- **A fifth example: a yeast micro-C map at one resolution.**
  `Yeast_microC_G2M_1kb.cool` — 16 chromosomes of synthetic yeast, 1 kb bins,
  179 M contacts, balanced. It is the first single-resolution cooler in the
  picker, so it is also the choice that lands somewhere with no resolution
  ladder to pick from.
- **Ten track resources published beside it**: MNase, ATAC, Pol II
  ChIP-over-input and stranded RNA-seq coverage, shotgun coverage, ATAC and Pol
  II peak calls, gene models, and the loop calls made on that map. They are not
  in the picker; the annotation cards above are what reads them. All ten are on
  the map's own assembly rather than on R64 — same 16 contig names, same
  lengths, no coordinate off the end of a chromosome — which is the property to
  check before republishing any of them. See
  [docs/deploy.md](docs/deploy.md#the-track-resources).

- **Works offline, and installs.** After one visit the app runs with no network at all — reload
  included — and browsers offer to install it as a standalone window. The app is cached; the data
  never is, and requests for it reach the network untouched. A new build is offered as a reload
  rather than swapped in underneath you.

- **A desktop application, for machines that cannot reach the website.** The same
  bundle packaged with Electron: a `.dmg` and a `.zip` for macOS (Apple Silicon and
  Intel), an NSIS installer for Windows, an AppImage and a `.deb` for Linux. It is a
  delivery channel and not a second feature set — it opens exactly the files the web
  build opens, in exactly the same way, with the same reader and the same privacy
  claim, and it never writes anything back. There is no auto-update: a new version is
  a new download. The first releases are **unsigned**, so macOS and Windows will each
  warn once before running it; [docs/desktop.md](docs/desktop.md) gives both warnings
  verbatim with the exact click that gets past them. The web app is unchanged — same
  URL, same build, nothing to install.

  It has a native menu, and one capability the web app cannot have: it asks
  remote hosts not to compress. `Accept-Encoding` is a forbidden header name in
  a page, so a `.metacool` served with `Content-Encoding: gzip` — which is what
  GitHub Pages does — is refused by the website with no way around it. The
  desktop build sets the header from outside the page, so the same file on the
  same host opens.

- **The footer states the privacy claim, which it had been promising to.** The
  dismissable notice on the picker says the footer keeps the same statement, and
  `StatusBar` asserted it in its own documentation, but nothing rendered it — so
  dismissing the notice removed the claim from the app. The statement is also
  reworded, in both targets, from "leaves your browser" to "leaves this machine":
  the first is false in a window that is not a browser, and the second is true in
  both.

### Changed

- **A selection opens a region instead of zooming.** Option-drag draws a square —
  it always resolved to one, so drawing a rectangle promised something it would
  not give — and releasing it opens what the square covers: the chromosome or
  contig the drag began in, ending at the edge of the box or of the sequence,
  whichever comes first. On the whole-metagenome view, where no smaller region
  exists, it opens the genome. Zoom is still the wheel, the keys and pinch.
- **Two fingers sideways go back and forward** over the heatmap, as they already
  did everywhere else on the page.
- **A selection in the trans corner opens the intersection**, not one of the two
  sequences: the rectangle between two chromosomes, or the genome pair. On the
  diagonal it is still one region.
- **Switching resolution in an `.mcool` keeps the view** you were in — the same
  genome, contig and range at the new bin size — instead of returning to the
  landing table. The colour clip is not carried, because it is in counts and
  counts scale with the bin.
- **A pooled picture says so.** Above 4,096 bins on an axis the raster is pooled,
  one pixel per block of bins carrying the strongest value under it; the summary
  now reads "drawn 4 × 4 bins to a pixel" and explains why the crosshair reports
  several coordinates inside one square, and why zooming does not sharpen it.

### Fixed

- `w` opens the whole-genome view again. The repaint short-circuit could not tell "nothing changed"
  from "show me the other picture of the same thing", and swallowed it.

## [0.2.0] - 2026-08-03

The first numbered release: everything below was built under `0.1.0`, which was never cut.

### Added

- **Opening files.** Drag and drop a local `.metacool`, `.mmetacool`, `.cool` or `.mcool` — read in
  place through the Emscripten filesystem, never uploaded — or a URL, read over HTTP range requests.
  The published demo datasets are offered as examples. A collection opens at one of its entries and
  offers the rest; an `.mcool` resolution ladder is a dropdown in the breadcrumb.
- **Tables.** A sortable, filterable genomes table as the landing view, with every metadata column
  the file carries and the free `bin1_offset` density proxy; the same for contigs. Filters, search
  and sort are remembered per file and per table.
- **Views.** One genome; the rectangular block between two genomes; a region, or the rectangle
  between two contigs; a cooler's whole genome; and the gated whole-metagenome overview, computed by
  one pass over every pixel or read from a sidecar edge list.
- **The heatmap.** Pan, drag-to-zoom on a modifier, wheel zoom, touch gestures, keyboard pan and
  zoom, a crosshair, a hover tooltip and a coordinate readout. `metacooler show`'s colour rule
  (`log1p`, 99th percentile) with typed clip bounds, a colormap picker including colour-vision-safe
  ramps, and balanced counts where the file carries weights.
- **Axis furniture.** Block names in the gutters, boundary ticks outside the plot, base-pair ticks on
  an axis with a single coordinate system, and dividers over the data. Each toggles independently.
- **Export.** PNG and PDF at 96–600 dpi, re-rendered rather than screen-grabbed, captioned with the
  file, genome, framed range, bin size, scale and time, and named with a timestamp.
- **The shell.** A file-info sidebar with a card for the row behind the current heatmap, a command
  palette, a keyboard-shortcut dialog, a light/dark/system theme, a status bar reporting bytes read,
  and an opt-in deep validation of the open file.
- **Deployment.** A static bundle published to GitHub Pages on every push to `main`, with the base
  path resolved at build time.

### Changed

- The whole-metagenome overview opens at contig level, marks genome blocks, and answers a click with
  the genome or the genome pair rather than a single contig.
- Axis labels appear as soon as fewer than fifty blocks are *in view*, so zooming brings out the
  names of a 20,000-contig map; contigs over 50 kb are labelled whatever the count. Clicking a label
  opens what it names.
- The view's controls are a column of the shell, scrolling on their own beside the plot.
- Reading, rendering and sorting were reworked for large files: a windowed pixel read, a pooled
  raster, memoised bin→unit maps, and sorting once per column rather than once per keystroke.

### Fixed

- A region no longer reaches into the next chromosome on a file whose bin table is not
  `binnify(chromsizes, binsize)` — five yeast chromosomes at 2 kb, where the extra bin also cost the
  view its base-pair ticks.
- A press no longer scrolls the canvas out from under the pointer, which made clicks near a genome
  boundary open the neighbour.
- Toggling labels no longer crops a fitted view.

## [0.1.0] - unreleased

The version the package carried while the viewer was being built. Never tagged and never deployed
under that name; its history is in the commit log.
