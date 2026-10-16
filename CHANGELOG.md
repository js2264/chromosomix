# Changelog

Notable changes to the viewer, newest first. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[semantic versioning](https://semver.org/) — for an application that means the **format and URL
contract** rather than a code API: a major bump is a `.metacool` the previous version could open and
this one cannot, or a `#`-hash link that no longer resolves to the same view.

The deployed site at <https://chromosomix.app/> is built from `main` on every push, so
it can be ahead of the newest entry here. Its exact build is in **About → version**, and in the
`/Producer` field of any PDF it exports.

## [Unreleased]

### Added

- **Tab goes on to the next field of its kind (§26.8).** In any field edited in place, Tab now takes
  what was typed, as Enter does, and puts the caret in the next field of the same kind — Shift+Tab
  the one before — and past the last lets it go: a track's name to the next track's, down the
  browser's lanes and through every stack round a map; a range's bottom to its top and on to the next
  track's bottom; a colour key's low end to its high end, and on a deck to the next map's key; a deck
  cell's heading to the next cell's; a row's name on the Tracks, Metadata, Structures or Contact maps
  card to the next row's; a tab's name to the next tab's; a mark's last box to the next mark's row;
  a sequence's name on the editing stage to the next sequence's; the 3D key's bottom to its top. A
  value a field refuses keeps the caret, as Enter does. Tab used to jump to whatever button came next
  in the page — and on the editing stage it threw the typed name away. On the way, a colour key's
  end opened and left as it was no longer fixes the bound at the number it showed.

- **The installed app keeps its folders, and a saved workspace finds its files in them again
  (§20.6).** In the desktop app — or the site installed as an app — a connected folder is kept
  across restarts, and a workspace saved there records which folder each of its local files was in
  and where: reopened, it opens the map and its tracks from the folder with nobody asked for a file,
  and on another machine its note names the folder to connect, with a button that does. The desktop
  app now lets its own page re-read what the user chose, and nothing else.

- **The tracks' names beside the map, in its corners (§8.8).** Each stack's names now stand in the
  corner that follows it clockwise — left of the tracks under the map, below the ones on its right,
  above the ones on its left, right of the ones above it — instead of over the start of each track,
  where a name and its range covered the first stretch of the signal. A short name sits in the margin
  beside the map's own labels and a long one runs out over the corner, which grows to fit (wrapping a
  name past 150 px); the range sits under its name, and a press on either still opens its caret, a
  right click the lane's menu. Figures saved from the map carry them where the screen does.

- **Each cell of the deck can be on a sequence of its own (§16.3).** Every map's heading now says
  which sequence it shows, as a quiet picker beside its name: pick `V` on one cell and that map
  leaves the chain and reads the whole of V at its own resolution while the others stay on IV — its
  window is remembered with the map, and the `×` on it puts the map back on the others' window. On
  the first map the picker goes where the locus box would, and every map following it goes along.

- **A scalogram's lane reads in distances (§18.12).** Its range said `0 – 16.7`, the logarithms of
  the reach, and its floor sat at one base pair, so the lower half of the lane was a band no value
  could reach. It now says `1 kb – 104 kb`, starts at the power of ten below its data, and carries an
  axis of its own: a faint dashed rule at 10 kb, 100 kb, 1 Mb… with the distance written at the
  lane's far end, stepping round the names rather than through them — beside a map, in the browser
  and in a saved figure. Any `log2` lane gets the rules and the floor; one whose values are lengths
  gets them in kb and Mb.

- **A box over the Analysis column narrows the task list (§18.1).** `filter 25 tasks…`: every word
  typed must be in a task's title, its blurb, its card's heading or its other names — each task now
  carries the words a reader looks for it by, *TAD* for insulation and the directionality index,
  *pileup* for APA, *A/B* and *eigenvector* for the compartments, *decay* for P(s). A card with
  nothing left goes, nothing left at all is said, Escape gives the list back and Enter opens the
  first task left that can run.

- **Every step back, as a list, from a chevron beside the header's back button (§5.5).** It names
  each step behind the one on screen — the window, a block of two, the whole genome, a table — with
  the resolution, the O/E or the comparison it set beside it and the file where that is another one,
  and a row goes straight there, as that many presses of back would. The app keeps a record of the
  entries it writes, which the browser does not list, in the window's own storage, so the list
  survives a reload.

- **Two windows typed in a locus box open the block between them (§5.4, §26.1).**
  `chr1:1,000-2,000 chr2:3,000-4,000`, or the same with ` x `, `|` or `×` between, opens chr1 against
  chr2 — rows, then columns — in the region view's box, the whole genome's and the Chromosomes
  table's; everything after the first window used to be dropped without a word. On a block of two
  windows the box shows both, `IV:1,000,001-1,200,000 × V:1-200,000`, where it showed the rows alone
  and Enter on it threw the columns away.

- **A row of the Files column dropped on *Load a map into the lower triangle* is the second map in
  the square (§5.7, §20.5).** The Contact maps card's slot took only a file from the desktop: a row
  dragged out of a connected folder lit it and fell in for nothing. The row's file is read at the
  drop, through its folder, with the credential the folder lists with and the name a Drive or a
  Dropbox gives it; on a session with no map it is the first map. The slot no longer lights for the
  card's own grips or for text dragged across it.

- **The validation and the timings are published with every release, at
  <https://chromosomix.app/validation/> and <https://chromosomix.app/timings/> (§18.10).** A new
  workflow, `.github/workflows/notebooks.yml`, installs every reference on a fresh runner at the
  versions the notebooks were written against — `notebooks/requirements.txt` and
  `requirements-yapc.txt` pin them — renders both notebooks and publishes them beside the app, each
  with its tables beside it: every command, every verdict and every timed run. It runs when a
  release is published, attaching both pages, every verdict and every timed run to the release as
  well, and on demand, with the number of timed runs and whether to publish; every run keeps what it
  rendered as an artifact, even when the timings fail. Each page opens on when it was rendered, from
  which version, commit and release, by which run, on what machine, and closes on how long it took,
  and the two link to each other. The service worker leaves both addresses to the network, as it
  does archived builds, so a visitor who has installed the app reaches the page rather than the app
  — once their copy has taken this version's update; until then, an older worker answers there with
  the app.

- **`chromosomix boost` writes Boost-HiC's map of each sequence (§6.5).** The map an oversample
  draws a sequence's new contacts from, which nothing showed: each sequence's stored counts, the
  square an oversample hands Boost-HiC, through the same port, written as Boost-HiC's `main.py`
  writes its own — the bins its outlier filter keeps and the boosted map over them, in SCN units, one
  square TSV a sequence. `--sequences` names some and `--alpha` another exponent; a sequence past
  3,000 bins is refused by name, as an oversample refuses it. Over three mouse chromosomes at 100 kb
  it keeps the same bins as Boost-HiC's Python and agrees with it within 5 × 10⁻¹⁰, ten times faster
  on chr1.

- **Copy beside PNG and PDF on every task's figure (§18.13).** It puts the figure's PNG — the same
  300 dpi redraw the PNG button saves — on the clipboard, to paste into a slide or a message without
  a file in between, and says in the corner what was copied and at what size.
- **The lab's store opens the Chromosomix paper, five tabs, a panel each (§24.2, §24.3).** *The
  Chromosomix paper* replaces *Chromosomix, Fig. 1* under Papers. Fig. 1c is 4DN's mouse ES-cell
  Hi-C at five scales side by side, each map at its own rung and on its own window — the genome at
  2.5 Mb, chromosome 3 as the correlation of its observed/expected at 250 kb with E1 and A/B under
  it, chr3:27–37 Mb at 10 kb with its insulation and borders, the *Sox2* locus as observed/expected at
  5 kb with its genes, CTCF and loops, and *Sox2* with its control region at 2 kb with H3K27ac and
  H3K4me3 — and under each map the model the figure inferred at that scale, coloured by a track.
  Fig. 1d is chr3:32–36 Mb at 10 kb with its insulation, borders, CTCF and genes, beside chromosome
  3's model coloured by CTCF. Fig. 2a is *C. necator*'s first chromosome, its origin in the middle,
  over the decay along the diagonal and then along both arms; Fig. 2b the *B. subtilis* wild type,
  ΔparAB and six times after ParB is induced; Fig. 2c *P. aeruginosa* WT, SMC-ScpAB– and MksBEF– as
  the correlation along both arms, with each strain's E1 under its map and the wild type's RNA-seq
  (PAK at T0, GEO GSE76513, drawn to 30 CPM) under its own. A deck keeps one look a map, so a panel
  that reads one map several ways opens on one of them and the map's score picker has the rest. The
  files are one folder, `demo/store/chromosomix_paper/`, a subfolder an organism, the bacterial maps
  and the RNA-seq copied there from where the lab keeps them so the card names none of those places;
  `scripts/make_rsg_store.py derive` computes the three E1 tracks with `chromosomix compartments`, as
  the zoo does. The bucket needs `scripts/publish-store.sh` again.

- **A model coloured by a track can run from white to the track's colour, and its key's ends can be
  typed into (§25.5).** *White to the track's colour* joins the colour-scale picker under a track,
  so a model coloured by H3K27ac is drawn in its lane's orange. A click on either end of the key's
  range puts a caret in it, as on a lane; the number is written to the lane's limits, so the lane
  follows, and an arrow beside the range puts the track back on autoscale.

- **Find a motif searches a genome too large to hold, and searches the sequences ticked (§8.8,
  §18.8).** A FASTA opened by its `.fai` — a mouse or human genome — or a `.2bit` was refused by the
  search for not being held in memory; it is now read by range sixteen megabases at a time, each
  piece scanned and let go, with an overlap one base short of the motif so a site across a seam is
  found once, and the sites are the ones a search of the whole file finds. The form takes the
  sequences to search as tick boxes, all of them to begin with; fewer are named in the lane
  (*GATC on chr1*) and get rows of their own. Over a reference read by range the line beside
  **Run** prices the read — every base of the ticked sequences, in bytes, and over a network in
  requests — and a Stop is seen between two pieces.

- **The `chromosomix` command opens a `--sequence` by its index (§23.1, §8.21).** A FASTA with its
  `.fai` beside it, or a `.2bit`, is read by range as the browser reads it, so a mammalian reference
  is a reference from a shell: Node's `readFile` refuses a file past 2 GiB, which was every plain
  mouse or human FASTA. One past it with no index is refused by a sentence naming `samtools faidx`.

- **Marks hidden and shown, one or all of them, on every map, track and model at once (§8.1).**
  Each row of the Manual annotations card has an eye, as a track's row does, and the list a heading,
  `MARKS`, with how many are hidden and one eye for all of them over the rows' eyes; `A` is that eye
  from the keyboard, and the palette's *Manual annotations* switch. A hidden mark leaves the map
  (square or turned), the lanes and their anchors, the 1D browser, a tracks cell and the 3D model —
  its bead, its chord, its colouring — and figures, and stays on the card to be shown again. Hiding
  every mark and showing them again brings back exactly what was drawn: a mark hidden from its own
  row stays hidden. A double-click on an eye shows that mark alone, and a second brings the rest
  back. Every right-click menu — the map's, a lane's, the 1D browser's and the model's — names the
  marks under the pointer, *Hide this line* and the like, measured on the ink as it is drawn, and
  offers *Hide every mark* or *Show the marks*. Hidden marks are kept with the session, a link and a
  reopen at another resolution, and the card's BED and BEDPE still carry them.

- **Inter-arm alignment draws what its detrending leaves, and the two decays it divides by
  (§18.8).** The profile after detrend — the same cells over the decay along both arms — is a curve
  beside the measurement's, the two opening on one ordinate so a flat control reads as flat; and a
  log–log figure gives the two expectations, the ordinary decay along the diagonal and the decay
  along both arms within an arm and across them from the secondary diagonal, log-binned as P(s)'s
  expected curve is (task version 7).

- **A table's names can be a scatter's abscissa, and the scatter its least-squares line (§18.13).**
  A text column whose cells write numbers — the all-maps table's `Map`, where the maps are
  `+parB 15 min`, `+parB 30 min` — is offered as the abscissa, each row at the first number in its
  name and a name with none left out; *least squares* draws the fitted line, named in the legend by
  its equation, r² and n, so the slope of a time course goes out in its PNG and PDF. The line is
  fitted to the points in the abscissa's window and refitted as it moves, so a box drawn across the
  points that are under way fits those alone.

- **Half a window upstream and downstream, beside `go` on a region (§5.4).** Two arrows straight
  after the locus box's `go` move the window half its own width along the sequence, re-read as a
  navigation, so a reader at a locus can walk the chromosome without retyping it. They slide in to
  stop at an end and grey once there, on the whole sequence and on a block of two sequences, and name
  the window they would open in their tooltips.

- **Back and forward in the header (§5.5).** The browser's own back and forward as two buttons, past
  a divider after the four panels' toggles, greyed where the browser says there is nowhere to go.

- **A model's PDF is lit, as its PNG is (§25.7).** Every bead is a shaded sphere, a PDF radial
  shading from a highlight to a shadowed rim, and the tube and the sticks are drawn band by band
  from the rim in shadow to a highlight on the side the screen's key light comes from, so the
  fibre reads as a solid on paper rather than as flat ribbons. Still paths and shadings and nothing
  else, smooth at any zoom; the fog fades the shading with the rest. The file is larger for it.

- **Every colour swatch opens one picker of the app's own, hex first, with the colours last picked
  (§26.6).** The six digits are the box, ready to type or paste into; the square and the hue bar
  can be dragged across without the picker closing — the platform's closed after the first step,
  because the card under it was rebuilt — and the lane follows the drag. Under them, the last
  sixteen colours picked anywhere in the app, one click each; an eyedropper where the browser has
  one.

- **A bar under the 1D browser's tracks makes them all taller or shorter together, each in
  proportion (§5.8).** The deck cell's height bar in look, under the last track: dragged, every
  track's height is scaled by one factor, so their sizes relative to each other stay as they were;
  Escape mid-drag puts them back, a double click fits the whole stack to the window, and the arrow
  keys step it. Only in the 1D browser on its own — not beside a map, nor in a deck. The canvas now
  gives its height back when the tracks are made shorter, and *Stretch the tracks* (`h`) fills the
  window rather than a canvas a tall stack had grown.

- **The map says how to zoom into a region while the pointer is over it (§8.9).** Under the key in
  its top-right corner — or in the corner itself with the legend off — a line or two of plain text:
  *Alt + drag to zoom into a region* and *Shift + Alt + drag to zoom along the diagonal*, or ⌥ and ⇧
  on a Mac. One line under the diagonal lock, which already pins the box, *a stretch* on a turned
  map, and no Shift line on a block the diagonal does not cross. Gone when the pointer leaves, never
  in an export, and not on a touch screen. The 1D browser says *Alt + drag to zoom into a stretch, or
  drag along the ruler* under its ruler.

- **Base modifications from a BAM's `MM`/`ML` tags (§8.13, §8.20).** A pile lane's *colour by* offers
  *base modification*: the reads are drawn grey and each 5mC, 5hmC, 6mA or other call sits at its own
  base, red where modified and blue where not, as opaque as the caller was sure — for the code chosen
  from the ones the file's reads carry, at a probability threshold the reader sets. A hover on a call
  names its code, probability and base, and a read's card counts its calls. The depth row can draw the
  **percentage modified** instead, base by base, from the same reads under the same filters: a
  bedMethyl made in the browser. Reverse-strand reads are counted on their sequence as read, `.` and
  `?` modes are told apart, two codes on one base, ChEBI codes and the `N` wildcard are read, and
  calls in soft clips and insertions are dropped. A simulated nanopore BAM over yeast chrIV is in
  `demo/yeast/` to try it on.

- **Every called set is drawn on the map and as a lane (§18.7, §8.1, §8.16).** Peaks, insulation's
  boundaries and domains, the DI's borders and domains, A/B compartments, Pattern detection's borders,
  origins, sites, flagged contigs and MAGs used to arrive as an overlay on the map only — beside a map a
  peak set could not be read against the coverage it was called on. Each now arrives as two rows of the
  Tracks card, linked: the overlay, and a lane of segments placed directly under the row it is read
  against — the peaks under their bigWig, the A/B segments under E1, the boundaries under the
  insulation track. Each row's settings and the drawer carry **on the map** and **as a lane**, which are
  the two rows' eyes and are remembered as they are (§8.6). A loop set's lane is its anchors, and starts
  off; with no map — the 1D browser — the lane comes alone. Segments carry a name — `A`/`B`,
  `peak_12`, `domain_3`, `boundary_40` — into the BED, and a lane can be coloured by its **name**
  column, which a compartment lane is from the start.

- **The stage's corner dot plot zooms, grows, and answers the map — a dev feature (§27.3).** The wheel
  zooms it about the pointer, a drag moves it and a double click shows it whole, as the dot plot's own
  view does, the lines sharp at any zoom; a grip at its lower-left corner sizes it, kept on the map
  and remembered with the file. Hovering a contig's name on a pieces bar, or its row on the sequences
  card, lights its lines in the plot and dims the rest; hovering a line in the plot lights its contig
  on the map — dashed on the diagonal, bracketed on both bars, its name in the accent.

- **A FASTA's six reading frames, in any of NCBI's genetic codes (§8.8).** *Reading frames* in a
  sequence row's settings draws six rows under its residues — `+1`, `+2`, `+3` over `−1`, `−2`, `−3`,
  anchored to the sequence's first base so they do not move with the window — each codon a shaded box
  with its amino acid in it, starts green and stops red; further out the starts and stops alone as
  ticks, to 24 bases a pixel. The code beside it offers every NCBI translation table, so a
  Mycoplasma's frames can be read in table 4, where `TGA` is tryptophan and not a stop. A hover over
  a row names the codon and what it codes for; both settings are remembered with the row.

- **A 3D model coloured by a BED's names, A red and B blue (§25.5, §8.16).** Every feature set with a
  name column — a BED4 or wider, a bigBed, a task's segments — is offered under the model's *colour by*
  as *· names*: each bead takes the name that overlaps it most, so a compartment call colours the
  model A and B, and a bead under no feature stays grey. The key lists each name with a swatch that
  is a colour picker; the colour is kept on the set's row with the session, so it is that name's
  colour on every model coloured by the set and on the set's own lane, which can now be coloured by
  *name* too. Exactly `A` and `B` start red and blue, anything else on the categorical palette by
  base pairs covered; past twenty-three names the rest are one `other` the key counts.

- **Every map drawn to one number of contacts (§6.5).** A box labelled *contacts* ends the
  breadcrumb, showing the map's own total in grey — the `sum` of `cooler info`, 179,175,551 for the
  yeast micro-C. A total typed into it — `10M`, `23,000,000`, `2.5e7` — draws every map of the tab
  to that many contacts, **the whole file, not the window on screen**: subsampled where a map holds
  more, exactly as `cooltools random-sample --count N --exact` does (a uniform subset of `N`
  contacts, drawn a sequence at a time from a census of the map rather than held whole), and
  oversampled where it holds fewer, through a port of Boost-HiC (Carron et al. 2019): every stored
  contact kept, and `N − T` more drawn from the boosted map within each sequence and from the file's
  own pixels between them. Every picture, pooled read and task reads the drawn map, balanced values
  stay on the file's scale, and the total is in the link (`contacts=`) and survives a navigation. A
  task's framing and its console command say it (`--contacts N`, which `chromosomix` takes with
  the same parser and the same seed), and so does an exported figure's caption:
  `subsampled to 10,000,000 contacts (of 179,175,551)`. With two maps or more on screen — a deck,
  or a second file under the diagonal — two chevrons follow the box: down draws every map to the
  shallowest one's total, up to the deepest one's. A `.hic`'s total is counted rather than taken
  from its header, which counts each contact off a chromosome's diagonal twice. Refused by name: a
  total that is not a whole number, counts that are not contacts, a `square` file, an `.scool`, and
  an oversample of a sequence past 3,000 bins — Boost-HiC's Floyd–Warshall, run here as a
  WebAssembly SIMD kernel, is cubic in them — with *read as stored* offered where the map was.

  The count stays out of the way of what is being looked at: it reads nothing until what a view
  asked for has been answered, and between pairs it waits until no view has read for a quarter of a
  second, as the first open's circularity check does; each pair's record is read only as far as the
  coarsest rung and each block as exactly its bytes. On a 5 GB `.hic` it costs under 1 MB and the
  Chromosomes table is up in 5 s; a chromosome clicked while a 1 GB `.hic` is still being counted is
  on screen in under 4 s, under a veil that says *loading*, not *counting contacts*.

- **A file's first open proposes which sequences are circular (§8.15).** Each of the fifty longest
  sequences is read at its two ends and its corner, and scored as the contacts across the junction
  over the contacts along the diagonal at the same separation — about one on a circle, about zero on
  a line. At 0.2 or above the Chromosomes table's box is ticked and a banner says so; the box's
  tooltip quotes the score. Once per file, and it only ever adds a tick, so an untick stands. A
  map opened over a 1D browser is marked on the Sequences card too, which read the tracks' file.
  A shell asks the same with `chromosomix circular <map>`: every sequence's length, score and
  verdict as a table, the names to hand each later run of a batch as `--circular`.

  Each sequence is measured at the coarsest rung that still gives it a hundred bins, so on a large
  file the check reads a few megabytes rather than the finest rung's index and weights.

- **Declared origins (§8.15).** A sequence's replication origin is kept per file like its circle,
  shown 1-based in a column of the Chromosomes table, carried in a workspace and in a run's
  framing, and written as `--origin NAME:POS` on a `chromosomix` line. It is typed into the
  column as well as set by the task, and a task never overwrites one a reader brought. Every
  sequence has one: its first base, shown greyed, until another is set — so `arms` and every task
  that reads the arms read from it rather than refusing.

- **Base composition, a 1D task (§18.8).** GC content, GC skew, AT skew and the cumulative GC skew
  of a loaded FASTA, as lanes that export as bigWig, bedGraph and TSV. Its bin size is the open
  map's resolution unless changed, and 10 kb in a 1D browser, where a FASTA alone is enough to run
  it.

- **Origin and terminus, a 1D task (§18.8).** The turning points of the cumulative GC skew, the
  terminus chosen as Bacchus chooses it — nearer the matS cluster, else farther from the parS
  cluster, else lower in Hi-C coverage — with the sites found by the motif search. It leaves the
  `ori` and `ter` loci and the parS and matS sites as BED-exportable sets, the coverage smoothed by
  a cubic spline and the ori/ter ratio read off it, and declares the origin it found.

- **`ori` and `arms` on the map (§7.5, §8.15).** On a circle with an origin, `ori` frames the whole
  of it with the origin in the middle, so the secondary diagonal is the square's antidiagonal; it
  stays lit while the origin is in the middle of the view, and pressed again goes back to the
  sequence from its first base. `arms`
  divides by the decay along both of a bacterial chromosome's arms rather than along the diagonal
  alone — the X its aligned arms draw on an O/E map, and on its correlation, is divided out and its
  compartments are left. The key reads `arm O/E`; a link carries it as `arms=`.

  Either press keeps what the cells are — the score picker's choice and the balancing with it —
  rather than starting again from the file's own score.

  Every map of a deck takes them: a companion reads the session's circles and origins for its own
  sequence of the same name, so `ori` frames each map across the junction; `arms` is each map's own,
  as its O/E is — set for every map from the first map's card while nothing is starred, and for one
  map from its own card while it is — and a starred companion's card carries `ori`, which frames the
  whole deck.

- **Both diagonals of a bacterial chromosome's expected, from the score picker (§7.5, §8.15).** On a
  view of one sequence declared circular the picker offers `arm decay`, right under `expected`: the
  baseline taken along the two arms, drawn — the main diagonal's decay down each arm and the inter-arm
  decay either side of the secondary diagonal through the origin, the X a figure of a bacterial map is
  about, where `expected` has the main diagonal alone and averages the secondary one into it. It is
  the picture `expected` draws with `arms` on, made one choice: read along the arms whether or not
  `arms` is on, at its window or 50 bins, so `arms` greys while it is drawn, as the O/E does. Offered
  on a deck's companions too, and offered or withdrawn as a circle is ticked or unticked, without a
  rebuild. The key says `Arm decay`, the caption `expected along the arms`, and a link carries
  `score=armbaseline`.

- **Inter-arm alignment, a 2D task (§18.8).** How strongly a chromosome's two arms touch, as the
  secondary diagonal's enrichment over the distance decay: a curve against distance from the origin,
  a track along the chromosome, and a table of each sequence's enrichment, enrichment after detrend
  and reach, one row per sequence — folds over expected, the enrichment read from the origin out to
  the reach: 3.1× on *P. aeruginosa* PAK,
  1.2× on *E. coli*, whose arms are not aligned. The reach runs until the enrichment is a fifth of
  its peak on `log2`, near where the alignment ends, rather than half of it, which sat in the middle
  of the fall: a time course of ParB induced in *B. subtilis* reads 930 kb at 15 minutes and 1.9 Mb
  at 45, where half the peak read 600 kb and 1.5 Mb (task version 6).

  The enrichment after detrend is the same cells over the decay along both arms — the expectation
  the map's arms and Compartments divide by — read over the same stretch: a control, near 1× where
  that detrending works (0.93–0.97× on PAK). *window along the arms* (`--armWindow` in a shell;
  50 bins) sets it.

- **Compartments along both arms, and a table of their components (§18.8).** An *expected* choice,
  *decay along both arms*; phasing by **a track** as well as by a gene model or GC content; and a
  components table of each one's eigenvalue, its share of the contacts, and its r with the phasing
  signal as drawn. E1 is the largest eigenvalue's component, always: the phasing signal signs each
  component and chooses none, so the GC content of the compartments E1 calls can be compared without
  comparing GC content with itself.

  Its *of contacts* column is the share of the map's departure from expected that each component's
  checkerboard carries — the same measure under either method, adding up across components
  (`contacts` in a TSV); under the correlation the matrix's own *variance* stands beside it.

- **Chromosome ideograms, from UCSC's cytoBand (§8.22).** A `cytoBand` or `cytoBandIdeo` is a lane of
  its own kind: each chromosome in view drawn as one outline — rounded telomeres, a waist at the
  centromere, a narrowed stalk — with its Giemsa bands inside it in their stains' colours, the same in
  both themes: `gneg` to `gpos100` from white to near-black, the centromere red, `gvar` hatched. The
  bands are on the lane's own axis, so zoomed out the lane is the karyotype and zoomed in it is the
  bands under the window, each named inside itself where it fits, with the window's bands in ISCN
  under the lane's name (`Xq28`, `Xq27.3 – q28`). A yeast CEN of 118 bases is widened to six pixels so
  it can be seen. The card shows the stains as a key; a click on a band opens it by its ISCN name,
  with its position, length and stain. A band's stain is also its score — `gneg` 0, `gposN` N — so
  *Signal by group* can split a track over light and dark bands. **A cytoBand declares the genome**:
  its bands tile every chromosome, so the file alone opens a browser at exact lengths (`lengths: the
  cytoBand's bands` on the Genome card), and one that does not tile gives the lower bound any feature
  file does. Beside a map on any edge, in the browser, and read by the `chromosomix` command.

- **Bands in the locus box (§8.22).** Typing a band's ISCN name — `Xq13`, `chr8q24` — lists the bands
  of every loaded ideogram that start with it, under the gene model's hits, and Enter opens one, padded
  as a gene is. A karyotype never becomes the set the gene search reads, however early it was loaded.

- **RNA-seq splice junctions, drawn as sashimi arcs (§8.23).** STAR's `SJ.out.tab`, the two-block
  BED12 that regtools, TopHat and Portcullis write, and leafcutter's `.junc` are read as one lane of
  **introns**, each an arc from one exon's end to the next's start, as tall as its read count and
  labelled with it at its apex. A file with junctions on both strands splits the lane: forward arcs
  rise from the middle, reverse arcs hang from it. The arcs are measured against the lane's
  **limits** — a typed pair holds across windows and lanes, so two samples compare on one axis, and
  its floor is the minimum junction coverage; under `auto` the axis is fitted to the junctions in view
  and the caption says so (`20 junctions · to 23 reads`). An intron too narrow to be an arc is a
  spike, so a whole chromosome is a map of where splicing is. A click on an arc opens the junction:
  intron, intron length, strand, reads, and STAR's multi-mapped reads, motif, whether the GTF knew it
  and its longest overhang — each of which the colour picker offers, so *colour by annotated* shows
  the novel junctions. The ceiling drag, ⌘-scroll, right-click range and batch box's limits all reach
  the lane. STAR's table is recognised by its columns; a BED is read as junctions where its name, a
  `track` line or its `JUNC…` names say so.

- **A spliced BAM's depth draws its own arcs (§8.23).** The introns an alignment file's reads skip are
  counted on the pass that counts its depth, under the same MAPQ floor and duplicate switch, and drawn
  over the curve with their counts — a sashimi plot with no junction file at all. The depth row's card
  has `junction arcs` and `from N reads` (two by default); on by default, and a DNA library's lane is
  unchanged, since its reads skip nothing. Long CIGARs are read from the `CG` tag; the strand is `XS`,
  or minimap2's `ts`. Counted per record, as regtools counts, where STAR's table counts a pair once.

- **A human RNA-seq demo, and a yeast karyotype and junctions (§8.22, §8.23).** *Splicing on human
  chrX* opens the 1D browser from UCSC's hg19 cytoBand alone, at RPL10 in Xq28: the ideogram, the
  Ensembl chrX genes, a Geuvadis sample's reads as depth with their arcs, and two samples' STAR
  junctions (GBR and YRI) on one typed axis of 1 to 400 reads. The store lists all its files — four
  samples' `SJ.out.tab`s from a one-pass STAR run, the BAM, and the regtools BED of the same sample —
  and the yeast set gains `Yeast_cytobands.txt` (arms, the CEN elements found in the demo FASTA, and
  the rDNA as a stalk) and STAR's junctions for nf-core's chromosome I subset, EFB1's intron among
  them. `scripts/make_ideogram_junction_demo.py` writes them and records where each came from.

- **A feature lane's rows can be expanded, squished or collapsed (§8.16).** Expanded is the rows with
  names under them, as before; squished packs many thin rows with no names, so a crowded stretch shows
  every overlapping feature; collapsed puts everything in one row across the lane. In the card, as
  `rows`, and in the lane's right-click menu, which now also carries the strand points as a switch —
  both ticked where they are in force — and, opened on a feature, that feature: its card, its name
  and position to copy, and in the 1D browser a zoom that frames it.

- **A `points` style for tracks (§8.8).** A dot per value and nothing between them — a Manhattan
  plot's picture, for p-values, sparse scores and anything whose outliers are the reading. From each
  pixel's mean like the other styles, so the same limits, groups and flip apply; one dot per run of
  equal values, so a zoomed-in bin is one point at its middle. In the style picker of every track, in
  the batch box, beside the map, in the 1D browser and in figures.

- **A 1D browser has a Chromosomes table (§5.8).** The trail's root picks between it and the
  whole genome. Circles are ticked and origins typed there with no map open, and a map opened over
  the browser takes them for its sequences of the same names.

- **A mark is edited in its row (§8.1).** A press on a mark's place on the Manual annotations card
  turns it into the adding form's boxes (and a line's axis); Enter moves the mark in place, keeping
  its colour and its position in the list, and Escape leaves it.

- **Manual annotations can be imported (§8.1).** The card had a way out and no way back in: an
  *Import* section above *Export* now takes a BED or BEDPE — clicked, or dropped anywhere on the
  card. A BED row is a line on the axis its name column says; a BEDPE row is an arrowhead when both
  anchors are one base wide and a rectangle otherwise, so the card's own exports round-trip. Marks
  already on the map are not added twice, and a line under the zone says what each file gave.

- **Peak calling, a 1D task (§18.8, §18.9).** yapc (Jänes et al. 2018) ported: a peak is where a
  coverage track's smoothed second derivative turns negative — where the signal curves down — found by
  its shape rather than its height, so it needs no background model of normalised signal and splits
  two summits on one shoulder. Choose a replicate and IDR (Boley's `idr` 2.0.3, the implementation
  ENCODE uses) tests every peak against it, keeping those at or below one of yapc's six thresholds;
  with one track the peaks are ranked by curvature, the run says no test was made, and a violin of
  every candidate's curvature shows where the two populations part. Out come the peaks with their
  summits (BED on export), a table per sequence, the six thresholds with the peaks each keeps, and a
  row per peak on request. Reads every base in windows of 256 kb, so a genome is never held whole,
  with no map needed, and runs from `chromosomix peaks --signal … [--replicate …]`. Held to
  yapc's and IDR's own output on the demo data, region for region and cut for cut
  (`npm run fixtures:analysis -- --only yapc yapc_idr idr`, in the environment its script describes).

- **Signal by group, a 1D task (§18.8).** Any track compared between groups of the genome: a
  feature set's intervals split by name, strand or score (A against B on a compartment call, with
  the rest of the genome as a group), or a track's bins cut by sign or into quantiles. Per group a
  summary and a violin; between groups Mann–Whitney and Kruskal–Wallis with effect sizes and
  q-values; a row per feature on request. Runs with no map, and from the `chromosomix` command.

  P and q are written in scientific notation where four places would print a zero, in the drawer and
  in an exported TSV alike (`6.5319e-22`).

- **Compartments by cooltools' method, by default, as well as Lieberman-Aiden's (§18.8).** A
  *method* dropdown, **cooltools** by default — observed/expected itself, clipped at its 99.9th
  percentile, less one, its gaps read as expected, and each eigenvector scaled by √|λ| — or
  **Lieberman-Aiden 2009**, the correlation of observed/expected decomposed, which is what every
  earlier version computed. cooltools' agrees with `cooltools.eigs_cis` to |r| = 1.000 on the zoo's
  maps, and skips the correlation, so a fine map takes seconds rather than minutes. A run by the
  correlation says so in its label. `chromosomix compartments --method correlation`;
  `scripts/dbz-store.sh` takes `COMPARTMENTS_METHOD`, the DBZ notebook `METHOD`.

- **A `.pairs` for P(s)'s four orientations is dropped on the form, or chosen through it (§18.8).**
  Under *four orientations* the drawer asked for the file by address alone, so a reader with the
  `.pairs` on their disk had to host it somewhere first — or drop it on the app, which *opens* it, as
  a map, behind the binning dialog. The *.pairs file* row is now the Tracks card's drop area, and
  pressing it opens the file picker; it takes a row dragged out of the Files column as well, and keeps
  the drop for itself. The file is read in the analysis worker for its records alone — nothing is
  binned and no map changes — and its name is what the run records and what `chromosomix
  --pairsUri` is written with. The address box stays under the area for a file that is not on this
  computer, and replaces a dropped file when one is typed; a word that is not an address is refused
  under it rather than failing the run. A file is kept for the session, across the drawer's tasks,
  and a name recalled after a reload, whose file is gone, empties the area rather than reaching the
  worker.

- **Find a motif allows mismatches (§18.8)**, up to four, and says so in the set's name.

- **The 4C task can leave the anchor out (§18.8).** *Exclude anchor region* empties the anchor's own
  bins and one either side, so the diagonal's spike no longer sets the scale the rest of the profile
  is read on.

- **Run on every map, the tables come together too (§18.7).** The `all maps` tab drew the curves of
  every map on one axis and sent the tables back to the per-map tabs; it now shows each table as one:
  every map's rows in the deck's order, under a first column naming the map. Inter-arm alignment run
  over eight libraries is one table of eight maps' enrichments, sortable and exportable, rather than
  eight tabs to copy a row out of. A reproducibility run already compares every map with every other,
  so its matrix, tables and lines are shown once, from the run that compared the most maps, where the
  overlay drew each pair twice under the names of the two runs that computed it. The tab's TSV — the
  tables' and the overlays' — carries every map's provenance, one block per map above the numbers.

- **With no map starred, no task runs (§18.1).** The Analysis column says so once, above its cards —
  *no map is starred, so no task can run* — greys every row with that sentence in its tooltip, and
  the drawer's Run and *run on all* refuse with it. Starring a map puts them back.

- **A second way to build a model, and it is now the default: pastis-NB (§25.6).** *Model from the
  map* gains a **method** control offering the two positions the literature actually takes on what a
  contact count *is*. **ShRec3D**, which is what the task did before and still does when picked,
  reads a count as a *measurement of a distance*, `c^(−1/α)`, fills in the pairs the map never
  counted so the matrix is complete, and places the beads by classical scaling and weighted SMACOF.
  **pastis-NB** (Varoquaux, Ay, Noble & Vert 2014; Varoquaux, Noble & Vert 2023) reads a count as a
  *count* — negative binomial, with a mean of `β·d^(−α)` — and returns the model that makes the
  counts most probable.

  **Two things follow, and they are why it is the default.** A **zero becomes evidence** rather than
  a problem: `0^(−1/α)` is infinite, so ShRec3D has to either drop such a pair or invent a distance
  for it, and the invention is the one step of that pipeline that is a guess. Under a likelihood a
  zero is a reading — *probably far*, and past a point indifferent to how far, which is exactly what
  a pair a shallow experiment missed should say — so **nothing is filled in at all**. On a simulated
  map that is three-quarters zeros, the classical start orders the pairs at ρ = 0.22 and the
  likelihood brings the same beads to **ρ = 0.92**. And a **count's precision is in the likelihood
  itself**, so a pair seen ten thousand times holds its beads ten thousand times as firmly with
  nothing weighted by hand — which is why **weight pairs by** is hidden under this method rather
  than being asked twice.

  **It reads the raw counts, and the balancing goes into the mean.** Not a preference — a necessity,
  and the one thing about this that is easy to get quietly wrong. A balanced value is a count times
  two weights, and *overdispersion is a statement about a count*: `variance > mean` compares a
  squared quantity with a linear one, so scaling the data scales the two sides differently and a
  balanced map is **never** found overdispersed, whatever it actually is. Handed balanced values the
  negative binomial would silently collapse back into a Poisson, on nearly every real file. So the
  counts stay raw and the weights go where pastis puts them — into the mean, `μ = β·bᵢ·bⱼ·d^(−α)`
  with `bᵢ = 1/wᵢ`. The coverage is still corrected; it is corrected in the mean rather than in the
  data, and the run says so in a note and in the table. A bin the balancer rejected is left out, as
  the balanced view of the same map leaves it out. The reported Spearman ρ is taken against
  `raw/(bᵢbⱼ)` — which *is* the balanced value — so it stays the number *Model versus map* would
  give and does not score the model on coverage it was right to remove.

  **The dispersion is fitted from your map, per genomic separation**, by the method of moments over
  log-spaced separation bins — pastis-NB's one claim over pastis-PM2 being that overdispersion is
  not one number for a map but grows as the counts thin out with distance. The whole of the negative
  binomial over the Poisson turns out to be a single factor: the pull on a pair is the Poisson's own
  `μ − c`, **shrunk by `r/(r + μ)`**. Where a map shows no overdispersion the run says so in as many
  words — *none: these counts are Poisson, so this is pastis-PM2* — rather than implying a parameter
  it did not measure. On a helix whose far counts were corrupted, the fitted dispersion holds the
  near diagonal about **twice as well** as a flat Poisson does.

  **The fit table now names the method** and reports what that method has to report: for pastis-NB,
  the mean's law, how many zeros were used as evidence, the dispersion near the diagonal and far
  from it, the MDS start, the likelihood steps and evaluations, why the optimiser stopped, the final
  `−log L` and the fitted `β`. Both methods still end with Spearman's ρ against the counts.

  **The cost, said before you press Run.** The estimate prices the method you picked: a likelihood
  evaluation is about 2.3 SMACOF passes' worth, and a step is a line search of just over one
  evaluation, so pastis-NB is roughly half again the wall clock of ShRec3D for the same step count.
  Memory is unchanged — **two `n × n` matrices either way**, because the likelihood adds vectors and
  not squares: L-BFGS at depth eight keeps twenty vectors of `3n + 1` doubles, six megabytes beside
  a twelve-thousand-bead gigabyte, where a full quasi-Newton method's Hessian at that size would be
  thirty terabytes. The whole addition is **9.7 kB minified, 3.5 kB gzipped**, in the chunk the
  analysis panel already loads.

  **Mechanics.** `structure/negbinom.ts` is the model — dispersion, objective, gradient, fit — and
  `structure/lbfgs.ts` is a limited-memory BFGS with a strong-Wolfe line search (Nocedal & Wright
  3.5/3.6), the optimiser pastis itself reaches for through SciPy. Both are pure over arrays, and
  both are generators: the likelihood yields between **evaluations** rather than between steps,
  because a line search is several passes over the pairs and each is as long as a SMACOF step, so
  the bar moves and a cancel always has somewhere to land. pastis-NB is started from the MDS model
  ShRec3D would have given — sixty SMACOF steps, fixed, since it has only to land in the right
  basin — which is pastis' own initialisation, so the new method stands on the old one rather than
  replacing it. `α` stays the reader's control under both, and is not fitted, so a model made here
  and a model made by either published tool mean the same thing by it. What is refused is named in
  §25.8: no restarts, no alternation between dispersion and structure, no physical unit.

- **A structure gets a cell of its own (§25.3).** The deck held one structure cell, so showing a
  second model destroyed the picture of the first — which made two models something a reader could
  only compare by swapping back and forth, and made a reconstruction landing wipe out the model it
  was to be judged against, the commonest way to lose a picture in this application. A model that
  arrives, dropped or computed, now opens a cell **beside** whatever was there; the eye on each
  Structures row opens a cell for that row, or closes every cell drawing it, and leaves the others
  standing; and a cell falling back to a model picks the first no sibling is already drawing, so a
  deck restored with two structure cells does not draw one picture twice. A Structures row dropped
  on a cell swaps that cell's model in place, which is the other question: the eye is a model asking
  for a cell, the drop a cell being given a model.

  Models that arrive together — two files dropped at once, a batch of runs — open a cell each.

- **One model in as many cells as you like, each a view of its own (§25.3).** A structure row could
  be drawn in one cell and one only — the link dropped a second `3d`, and the eye and the drag both
  refused a model already on screen — on the reasoning that two cells of one row are one picture
  drawn twice. They are not: a cell has its **own camera, its own height and its own turn** — the
  mirrors and the planted axes are the model's, shared by every cell drawing it — so two cells of
  one model are two views of it, which is the ordinary way anybody looks at a fold. The eye still
  means *is this model on screen*; the row's **grip dropped on the cell that is to hold it** is how
  a second view is asked for. What each cell remembers is now remembered under its **seat** — its
  place among the structure cells.

- **A star on each structure cell (§25.3).** The Aesthetics column holds one *3D structure* card and
  a deck may hold several models, so the card follows a cell the reader names. It was whichever cell
  was built first — which a reader with two models discovers by dragging a slider and watching the
  *other* picture change, and which left the second model's settings unreachable altogether. The
  same glyph and the same radio behaviour the maps' star has, and its own star rather than theirs: a
  starred map is the file an analysis runs against, a starred cell is the picture this column's
  settings are for. It appears only where there is a choice to make, follows the cells when the
  starred one is closed, and is not taken by a cell that opens — a model arriving should not move a
  control out from under the reader using it.

- **Turn together (§25.3).** A link on the *camera* row: every cell with it lit shares the camera's
  two angles, so one drag turns them all. **Only the angles travel** — each cell keeps its own
  centre, zoom and projection — which is what makes two synced cells two views rather than one view
  drawn twice. Pressed on, a cell leads and the others come round to it.

- **In the frame of (§25.5).** A select beside *compare with*, naming another model: this model is
  turned into **that one's frame**, over the beads the two share and by the same superposition, and
  **the other is not drawn**. The two are one question asked twice — *where do these differ* wants
  both on screen, *is this the same fold* wants them in one frame — and one control doing both put a
  second model in the picture of everybody who only wanted the first. Two cells each in the frame of
  one row, turning together, are two models in one frame showing the same face of each.

- **Mirrors on the frame row (§25.5).** A reconstruction from contacts is fixed **only up to
  reflection**: a model and its mirror image explain the same counts equally well, so two models of
  one map routinely come out in opposite hands and no rotation will ever bring one onto the other.
  Two toggles reflect the model across the screen or up it. The reflection is applied to the **built
  coordinates**, so picking, measuring, the labels and the vector export all follow it — a mirror at
  the camera would flip the picture and leave the numbers under it describing a model nobody is
  looking at — and it is applied **before** any fit, since mirroring is what makes the fit possible
  and fitting first would reflect the answer instead of the question.

- **Replant the axes (§25.5).** The centre's arms carry a frame the reader plants: *replant*, on the
  *camera* row, lays them along **this view** — x across the screen, y up it, z out of it — so every
  turn after that is read against the view they were planted in, which is the question anybody asks
  of a gizmo. **Neither the model nor the centre moves**; only the frame they are read against.
  ⌘-click replants as it re-centres, because a centre put somewhere new is a reader saying *read the
  model from here*.

- **A legend in the cell's corner (§25.3).** One row per control — the key on the left, what it does
  on the right — with the live row lit: *drag* turn, *scroll* zoom, *⇧* move, *⌘* centre, *space*
  fog, and a sticky mode at the top while it runs. It was one chip naming the current gesture, which
  told a reader who already knew the keys which key they were holding and everybody else nothing:
  that Shift moves the model, that ⌘ puts the centre somewhere and that Space and the wheel are the
  fog were facts discoverable only by pressing things. **In a small cell it is the live row alone**,
  the rest coming back while the pointer is on the picture: five rows of keys over a cell 330 pixels
  wide is a caption taking the corner of the thing it captions, and the moment the keys are wanted
  is the moment the hand is already there. Asked of the cell through a container query, since the
  same cell is 330 pixels four across and thirteen hundred in the enlarged viewer.

- **The structure cell is resized by a bar under it (§25.3).** Dragged, nudged with the arrow keys,
  double-clicked to give the height back to the row, and remembered per seat. A model has no axis to
  line up with the map's, so it is the one cell whose height is nobody's business but the reader's:
  a deck one across put the model in a 16 rem band under a map that could be shrunk to a thumbnail,
  and nothing done to either of them gave the model any more room.

- **The enlarged 3D viewer carries the three settings the Map card owns (§25.3, §26.3).** `legend`,
  `crosshair` and `tooltip` are preferences about every picture in the app, and the card that offers
  them is in the column *behind* the dialog while a model is enlarged — so the one switch for the
  key the reader was looking at was the one they could not reach. They appear as a *shared* row on
  the card carrying whatever no other card in the column offers: all three while the model is
  enlarged, none beside a map, and the key alone beside the 1D browser. The cell also *hears* them
  change now: turning the key off on the Map card used to leave the model's key drawn until
  something else happened to repaint the cell.

- **A yellow bead on every telomere (§25.5).** A toggle under *overlays* in the 3D structure card
  marks both ends of every chain and claims no more: a chain of one bead gets one mark, and a chain
  that opens with a gap is marked at the first bead that is somewhere. Drawn through the same
  channel a reader's own mark is, so the beads are the same size under every drawing and every
  colouring, and the vector export carries them without a second road.

- **A grip on every Structures row, and an empty cell that takes one (§25.3).** With several models
  loaded, the row's own button always meant *the* structure cell, wherever it happened to be.
  Dragging a row into an empty cell of the deck now says where as well as which, and the cell
  becomes a structure cell drawing that model. The drag carries the row under a type of this
  application's own, so an empty cell can tell a model from a file while the drag is still in the
  air; its hint offers both.

  A row dropped on a structure cell that already holds a model is drawn in that cell.

- **The colour scale is the reader's (§25.5).** A picker under *colour by* lists every colormap the
  application carries. *The colouring's own* — the default — keeps the existing rule, that a track's
  beads take the lane's colormap and contacts take the map's, so a bead and the picture beside it
  cannot disagree at the same value; choosing one overrides both. Offered only for a ramp, since a
  colouring by sequence or haplotype is levels and has no scale to change.

- **A key for *colour by manual annotations* (§25.5).** A row per mark, named as the Manual
  annotations card names it: its swatch recolours the mark itself — on the card and every map too —
  a click takes it off the model's colouring and a double-click shows it alone.

- **The Contact maps card lists every map, each with an eye and a grip (§16.9).** Every map has a
  row — the first map, the compared one, and each companion under its cell's name. A companion's eye
  closes its cell and keeps the map on the card, dimmed; pressed again it opens the map in a cell —
  the Structures card's eye, for maps — and its × lets it go. Every row has a grip: dragged onto a
  cell it exchanges a companion with that cell, and a hidden map's, the first map's or the compared
  map's row dropped on an empty cell or a `+` edge opens that file there.

- **Maps are reordered on the Contact maps card (§16.9).** The card lists the maps in the grid's
  order — the first map where its cell stands, no longer always first — and a row dragged up or down
  it moves the map's cell: let go above another map's row it goes before it, below it after it, and
  the arrow keys on a focused grip move it a map at a time. The maps are re-dealt among the seats maps
  stand in, so tracks cells, models and empty cells stay put. Run on all maps, a task works through
  the maps in the grid's order, and its tabs, overlays and tables follow it.

- **No map need be starred, and no structure (§16.5, §25.3).** A filled star is no longer a dead
  button: pressed, it leaves none filled. With no map starred the Aesthetics column's *Map* card
  sets **every map of the deck at once** — it says *every map — all N* under its title, in the warn
  colour, and a change there is copied onto every companion one moved setting at a time, so picking
  a ramp does not flatten each map's clip onto the first one's; *match all scales* and *match all
  resolutions* are greyed, there being nothing to match to. With no structure cell starred the *3D
  structure* card sets every structure cell at once, camera presses and the turntable included, and
  leaves out the rows that are about one cell's own picture (*compare with*, *in the frame of*, the
  measurements, the export). *None* lasts as long as the deck; the next deck starts starred on its
  first map.

- **An empty cell takes a track or a structure as readily as a map (§16.9).** A cell drawn with a `+`
  read *drop a map here*; it reads *drop a map, a track or a structure*, and does what it says: a row
  dragged from the Tracks card opens a tracks cell there drawing it (and keeps it on the maps it was
  on), a track file opens a tracks cell and is loaded onto it, a structure file or a row of the
  Structures card opens its model, and a map opens as a map. A row out of the Files panel is routed
  the same way, by the name of its file. The deck's count says `2 maps · 1 empty cell` rather than
  `2 of 3 maps`, and the `+` edge's note names all three.

- **Rows of the Tracks and Structures cards open a cell on a `+` edge (§16.9).** A track's row opens a
  tracks cell drawing it, in the cell nearest the edge; a model's row opens its model there and moves
  it, the cell it was in left empty where it stood.

- **A lane dragged by its grip moves to another map, or into a cell of its own (§16.9).** Let go on a
  rectangle round another map — they light up on every map while a lane is carried — it is drawn on
  that edge of that map; on a `+` edge, a tracks cell opens there drawing it; on an empty cell, the
  cell becomes the 1D browser of it; on a tracks cell, that cell draws it. Each is a move: the lane
  leaves the map it came from.

  The lane is one edge's: a track drawn along two sides of a map keeps the other when one is carried
  away, and a lane moved between two of one map's sides leaves a third side's lane where it is.

  A lane in a tracks cell is carried out of it the same way — to a map's side, a `+`, an empty cell
  or another tracks cell.

- **The first cell of a deck moves and closes like any other (§16.9).** Its heading has a grip, and
  dropping it on another cell exchanges the two, as every cell's grip does; another cell's grip, or a
  companion's row of the Contact maps card, dropped on it does the same. Its × takes it off the
  screen while another cell is beside it — parked out of sight rather than closed, so the other maps
  go on following it and the locus box above the grid still steers the deck — and its eye on the
  Contact maps card, or `show …` in the deck's bar, puts it back where it stood. Where it stands and
  whether it is hidden are remembered with the column count and travel in a saved workspace.

- **A tracks cell has the structure cell's height bar (§25.3).** Drag the bar under the stack to make
  the cell taller or shorter, nudge it with the arrow keys, double-click it to fit the row again; each
  tracks cell keeps its height across a reload.

- **Structure and tracks cells are renamed from their heading (§25.3).** A name typed into a
  structure cell's heading renames its model, on the Structures card and everywhere else it is named;
  a tracks cell's heading renames the cell alone — its name in the location control, remembered per
  cell across a reload — and no track on it. Emptied, a tracks cell's box goes back to its default,
  and a model's keeps the name it had. A tracks cell nobody named is headed as the location control
  lists it, `tracks 2` and `tracks 3` after the first, where every one of them said `tracks`.

- **A companion off the lead reads its own window (§16.3).** A box drawn on it with Option held
  re-reads that window for that map — as finely as its rung and its share of the budget allow —
  rather than magnifying the block it already held, so one file in three cells can be a whole
  chromosome, a 35 Mb stretch and 6 Mb at three real resolutions. The window is a pill in the cell's
  heading with *widen 3×* and an ×; it is remembered with the map's looks and dropped when the chain
  is relinked. On a companion still on the lead the box navigates the whole deck, as it does on the
  first map.

- **Which maps an overlay is drawn on, from its row (§8.1).** A loop set, a BED of borders or a
  set a task called was drawn on every map of a deck: the loops called on one of six maps were
  circled on all six, and a batch of insulation over five drew five sets of boundaries on each. An
  overlay is placed per map now, as a track is, and in a deck its row has a *maps* field in the shape
  of a track's *location*: a line per contact map with one mark, lit where the overlay is drawn,
  then *every map*, *no map* and *on N of M*. The batch box has it for several ticked overlays,
  hatched where they differ. Imported, an overlay is on the session's own map, as a track is; a set
  a task called is on the map it was called from, which the drawer already said it was. A session
  saved before this brings its overlays back on its own map, one press of *every map* from where
  they were.

- **The middle of a map is a drop target: *on this map* (§8.1).** A fifth rectangle, lit with the
  four strips at a map's edges while a file or a Tracks card row is dragged, and alone while an
  overlay's row is. A file dropped there opens onto that map only — a loop set on its face, a track
  on its usual edge — where a file dropped in the middle of a deck's third map used to land on the
  first; a row dropped there is drawn on that map as well as wherever it already was. An overlay's
  row let go on one of the strips is taken the same way.

- **Space recentres the map on its diagonal (§8.9).** The recentre button's press, from anywhere the
  keyboard is not a focused button's, tickbox's or field's; it is in the shortcuts dialog, the
  palette and the button's tooltip.

- **⌘ + two-finger scroll slides a map up and down (§7.2).** Sideways already slid it and up and
  down zoomed, so moving the map up the screen needed a drag with the button held; with ⌘ held the
  wheel slides on both axes. A pinch (Ctrl-wheel) stays the zoom, and ⌘-scroll over a lane still
  sets that lane's ceiling. The shortcuts dialog says so, and no longer claims a sideways swipe over
  the map goes back a page.

- **The DNA Bacterial Zoo, a shipped store (§24.2, §24.3).** A tile between the lab's figures and
  IGV's genomes: the lab's Hi-C maps of bacteria, one card a species, whose button opens the map with
  three of its tracks under it — the HiC score, insulation, and E1 read along both arms from the
  replication origin — and nothing else, declaring the circles and origins they were computed with;
  the fold holds the map, its reference and every track, 3D model included. A session
  `make_store.py` writes places a model it is given as a structure row with `maps: 3d`, rather than
  dropping it. The store is not the Stores workflow's to write: `scripts/dbz-store.sh` runs the
  suite over every map straight into the folder that is published — framing each first by the
  junction test and, where a reference is found beside it, by its base composition and its origin —
  and `scripts/DBZ_store.py index` lists that folder in place; `notebooks/dbz-chromosome-figures.qmd`,
  rendered with Quarto, draws one figure per species from the same `chromosomix` commands and
  tabulates the numbers behind them, each with its test. It lives beside its data on the lab's
  bucket, so until it is uploaded the tile says that, not *run the workflow*. Its mark is drawn by the
  script that draws RSG's, over a bacterial map — a circle whose far corners are warm, with the X of
  its zipped arms.

- **A store can ask to be drawn as cards (§24.1, §24.2).** Three optional keys on a store file:
  `group` names the field its rows belong to, `headline` the fields a group repeats, and
  `"layout": "cards"` draws one card per group the way IGV's genomes are — the group's session as
  the card's button, its headline fields and track count as chips, every other row under the
  card's fold, named without the card's own name. A store read by URL was always a flat faceted
  list, which is the wrong shape for a shelf of seventy organisms with nineteen files each.
  Without `layout` a `group` folds the list under a heading per group. `make_store.py check`
  refuses a layout the viewer does not know, cards with no group, and a group no row has.

- **Copy this, on the right-click menus (§7.2).** On the map, on a lane beside it, on a lane of the 1D
  browser, and on a 3D model (a right click that does not drag): the one object under the pointer
  onto the clipboard as a PNG, as it is drawn on screen — the map's cells with no axis, key, frame,
  overlay or pointer; the track alone with no name, range, handle or hairline; the model with no
  centre, key or buttons. The corner says how big it was, or why the browser would not take it. The
  map's menu now opens on any file, marks or not.

- **Every card moves by its heading, within a panel and between panels (§26.6).** Drag a card's
  heading — the strip that folds it on a press — and it lifts off the column, with a dashed slot
  where it will land; drop it anywhere in any open side panel. ⌥↑ / ⌥↓ on the heading's chevron move
  it a place without the pointer. The arrangement is kept through every navigation, tab switch and
  reload, and the command palette's *Put every card back in its own panel* undoes it.

- **A *caption* switch on the Export card (§7.2).** On by default. Off, a saved figure carries no
  caption under it (the region, file, bins, score, colour range and date) and ends at its lowest
  track. Shared by the map's card and the 1D browser's, remembered, and followed by the deck's
  figure.

- **Dev features: a switch in *About* that shows what is still being built (§29).** A feature can
  now live on `main` — specified, tested and deployed like any other — and be **invisible** to a reader
  until they turn *dev features* on, under the version in *About*: no row, task, command, example or
  clause in a sentence gives it away, and the switch is the only trace. It is a preference kept in this
  browser, off by default, never on in an embed, and turning it reloads the window, keeping its tabs,
  so that nothing built under one answer survives into the other. The registry is one file
  (`state/devFeatures.ts`) whose names are a type, so making a feature public is deleting its line and
  letting the compiler name the gates it leaves behind. The command line has no switch and shows
  everything. The slider it is drawn as is the one toggle in the app with a knob, lit by the same rule
  as every other (§26.3).

- **A metagenome's General column lists its genomes, and a genome's contigs, with ticks — a dev
  feature (§5.8).** The Sequences card a cooler is steered from now has a metacool counterpart: over
  the whole metagenome, a pair or a selection it lists the **Genomes**, and ticking any number draws
  them together; inside a genome it lists that genome's **Contigs**, and ticking several draws them
  against each other, with `↑ genomes` to step back out. The genome view's own contig list in the
  Aesthetics column is gone, since this one does what it did and more.

- **Two sequences against each other — a dot plot, a dev feature (§28).** A task in the Analysis
  panel's 1D card sets one FASTA or `.2bit` of the session against another, or against itself: the
  exact 19-mers the two share, sampled to two million a set (one in about seven bases of a yeast),
  and the streaks they make along a diagonal — a reordering between two assemblies the line that
  jumps, an inversion the one that turns blue. Between two sets the streaks are kept one to one,
  each stretch at its best place and the grid a repeat family's copies draw with each other left
  out; *every one* keeps them. The figure takes the drawer's width, with each sequence's name beside
  its stretch along the axis, cut short with an ellipsis where it does not fit; the streaks come out
  as a table and as pairs. It reads no map, and says so where the drawer names what a result was run
  on. On the long-read assembly of the yeast whose chromosome XVI carries the *M. mycoides* genome,
  against the genome it was built to be, it draws the fused chromosome's four stretches as the
  contigs that make them, in several seconds. `chromosomix dotplot --sequence a.fa --sequence
  b.fa --x a.fa --y b.fa` runs the same. Not yet: a view of its own in the link, with the maps'
  tracks on its edges.

- **The dot plot is a view you can move through — a dev feature (§28.2).** On screen its streaks are drawn
  as lines, sharp at any zoom, in a square plot at one scale on both axes: the wheel zooms about the
  pointer, a drag or a sideways scroll moves it, a double click shows both sets whole, and the line under
  it names the streak the pointer is on — both loci, its way round and its anchors — which a press keeps
  named. The PNG and PDF buttons draw the window on screen.

- **A stage that edits the reference, in manual mode — a dev feature (§27).** With *dev features*
  on, the heading says *reference · as in the file* before the resolution; pressing it, or *Edit the
  reference* in the palette, opens the whole map on a stage of its own, read once at up to 16,384
  cells a side and one byte a cell (12,118 for the yeast micro-C at 1 kb), with a pieces bar along
  its top and left in each original sequence's hue and the map's lanes beside it. A drag along the
  diagonal selects a stretch, snapping to every junction and sequence edge; `I` turns it, `C` cuts,
  `S` splits, *delete* sets it aside with a reason, and dragging its square moves it — the map and
  its lanes redrawn through the edit under the hand, ⌥ copying, `I` turning it on the way, a whole
  sequence dropped on another's end with ⇧ held joining the two. A drag off the diagonal boxes two
  stretches, with what two stretches admit. Every act is a step in a history with undo and redo,
  kept with the file, carried in a saved workspace, and counted in the heading — *edited · 2 steps*,
  with an arrow back to the file. The stage is closed by its × only: Escape lets go of the drag or
  the selection.

  Its sidebar is cards, bordered and raised as the panels' are — *selection*, *sequences*,
  *history*, *suggestions*, *export* and *picture* — with the suggestions first in review and auto
  mode.

  As the read starts it says what it reads — *reading the whole map for the stage: 13,735,472 stored
  pixels at 1 kb* — and how many bins a cell pools on a shallow map.

- **The session drawn through the edit of the reference — a dev feature (§27.7).** Closing the stage
  on an edit now redraws the whole session through it: the file is opened again as the edited
  assembly — `IV_e1` in the heading, the Chromosomes table, every view and every task — with the
  window carried to where its place went, and the tracks, features and marks fetched where the file
  has them and drawn where the edit puts them, a turned stretch's signal mirrored and its bases
  complemented. A mark drawn on the edited map or tracks is kept in the file's coordinates, so it
  survives the next edit and a revert; a task's result is stale once the edit changes; the heading's
  arrow puts the file back the same way. The edit is read under the reader, so the file is untouched
  and a view costs the rows it shows — from a `.hic`, only the blocks it needs. Not yet: a deck's
  companions, and the command line, whose line for such a task says it measures the file as it is.

- **Suggestions drawn over the map on the stage that edits the reference — a dev feature (§27.5,
  §27.6).** The stage now says where it thinks the reference is wrong, on the picture the reader is
  judging it by. Its own method measures the file's contact law and trans level in the pass that
  reads the picture, finds the junctions the map refuses along the diagonal and the corners where
  two ends meet off it, and weighs every split, turn, move and join as a trade of junctions —
  adjacency asked against the window's own level, so telomeres and centromeres clustering never read
  as one. Each suggestion is drawn in the accent: a diamond where it cuts, with ticks on the pieces
  bars, a corner where two ends belong together, a number, and on hover what it would do — a turning
  arrow over a turned stretch, an arrow from a moved one to where it goes. Its label stands on a
  rail beside the map at the height of what it concerns, lit with its marks and its row in the list;
  the pointer snaps to its points and, in the plane, to its corners, and the readout names them. `Y`
  takes it as a step the history marks *suggested*, `N` turns it down; *review* works through them
  best first, `Space` held showing the map as it would be, and every answer re-ranks the rest and is
  kept with the file; *auto* applies every one at 50% or more, each a step marked *auto*. The yeast
  micro-C draws none as it is; a stretch turned by hand draws one, to turn it back, at 98%. Not yet:
  the evidence beyond the map other than the assembly's own sequence.

  They are counted in the reader's worker after every edit and answer, so dragging, zooming and
  answering are never held up by them; auto mode waits for each count, and until the first is in the
  card says it is weighing.

  What the answers taught — the weights, the count, what was turned down — is kept with the file and
  carried in a saved workspace and a shared link; on a metagenome so is each genome's edit and its
  learning.

- **The edit of the reference written out, and read back — a dev feature (§27.8).** The stage has an
  *export* card: the edited assembly as an **AGP 2.1** (the steps in its header, each gap typed
  `scaffold` with `proximity_ligation` as its evidence), a **chrom.sizes**, a Juicebox
  **`.assembly`** for JBAT, 3D-DNA and YaHS, and a **liftOver chain** from the original coordinates
  to the edited ones — each through the save dialog, named after the map, the file itself never
  touched. A stretch set aside as unplaced is written as a sequence of its own; debris, contaminants
  and haplotigs are left out and named in the AGP's comments. *Lay out from an AGP or .assembly…*
  reads either back — another tool's scaffolds, or this app's own — as one step of the history,
  undone as any step is; a file of another assembly is refused, naming the sequence the map does not
  have. And the session lifted through the edit: the **FASTA** of the edited assembly from the
  session's own FASTA or `.2bit`, turned pieces reverse-complemented; the **map** as an `.mcool`,
  coarsest rung first within 60 million pixels, raw counts in the edited bins; and any **track** — a
  signal as bigWig, features as BED, pairs as BEDPE — with what lay on a stretch set aside counted
  rather than silently lost.

- **Suggestions that scaffold a real long-read assembly — a dev feature (§27.5, §27.11).** Whether
  two contigs meet is now weighed at the picture's own resolution — the pass that reads the stage's
  picture keeps every pair of cells between sequence ends — by a score that fits the gap the assembly
  left between them and how much of the contact law survived beside it, walking past the cells the
  balancer emptied at their ends; an end has one neighbour, so a join whose ends each have a better
  offer counts less; and the centromeres that cluster are found from the map, so a join of two
  chromosomes' telomeres — two centromeres in one sequence — is never offered at even odds. On a yeast
  whose chromosome XVI carries the *Mycoplasma mycoides* genome, assembled from long reads into 32
  contigs, the stage now offers the join at the fused chromosome's working centromere, chromosome XII
  across its rDNA and XV whole, and auto mode rebuilds the fused chromosome, yeast, myco, yeast, myco,
  in the order and orientation the strain was built to have. A suggestion says the gap it fitted
  (`a gap of about 8 kb`), `an end with a better offer` and `two centromeres`.

- **The assembly's own sequence beside the map, when the stage suggests — a dev feature (§27.5).**
  Where the session holds the assembly's FASTA or `.2bit`, the stage reads it once: the ends of every
  sequence for telomeric repeats — `TTAGGG` and its plant, insect and ciliate kin on either strand,
  and a budding yeast's irregular `TG₁₋₃` — and every base of a genome up to 100 Mb for gaps of `N`. A
  suggestion that would bury a telomere — a join, the turn of a chromosome's end, a chromosome moved
  into another — counts against itself and says `a telomere`; a break beside a gap is
  placed at the gap, to the base, and says `at a gap of N`; and the side panel says what was read. On
  the yeast whose chromosome XVI carries the *M. mycoides* genome, auto mode now completes the fused
  chromosome from telomere to telomere. A join across a gap the map measured writes it (`128,000 N
  between`) rather than the stage's own hundred, and the AGP writes a join's hundred as a gap of
  unknown size, `U`.

- **The stage on one genome of a metagenome — a dev feature (§27.10).** On a `.metacool`, *Edit a
  genome* asks which — the file's genomes longest first, each with its size, its contigs and whether it
  has been edited, and a filter — or takes the one in view, and opens the stage on that genome's
  contigs alone: only their rows are read, and the suggestions, the auto mode and every export are that
  genome's, named after it (`Mock_microbial_community.metator_00009_00000.edited.agp`). Each genome's
  edit is kept apart from the others'. On a shallow map the stage now pools its picture until every row
  holds enough to see — a genome of the mock community is drawn at 11 kb rather than white at 1 kb —
  and the suggestions weigh what a raw map's thinly covered cells and a pooled picture's part-cells
  hold for what it is, count the contacts a suggestion rests on, and say `few contacts` where there
  are few: on the mock community they offer scaffolding joins, and no longer the rearrangements two
  reads of chance had lit at near certainty. Past 64 contigs, the ends weighed for a join are those
  that touch, not only those a corner pairs. A *genome* card reads every contact of the file and says
  how much of the genome's stay in it, which of its contigs meet another genome more — **send** one
  there — and which contigs of other genomes, or of none, meet it most — **bring** one in; both are
  steps to undo, the AGP carries where a contig was sent, and *contig → MAG* writes the binning every
  genome's edit makes of the file's contigs, in the two columns DAS_Tool, anvi'o and `metacooler
  create` take.

- **The session through an edit gives the file's place beside its own, and keeps bookmarks where the
  file has them — a dev feature (§27.7).** On a map drawn through an edit, the readout names each
  place with where it was in the file, as the stage's does — `IV_e1:1,159,001 ← IV:1,241,000, turned`
  — or says it is in a gap. A bookmark taken there is kept as the same view of the file, and going back
  to it after the edit changed, or was put back, lands wherever the file's stretch now is; one whose
  place was set aside says so. A shared link carries the edit, and the share dialog says it does: a
  recipient with nothing kept opens the map drawn through it.

- **The stage's pieces bars are handles — a dev feature (§27.3, §27.4).** A press on a piece of the
  bar along the map's top or left selects it; a drag moves it, the map rearranged under the hand as
  a drag of its square does, and a whole sequence dropped on another's end with ⇧ held joins the
  two; a double click turns a piece; and the readout over a bar names the piece and the stretch of
  the file it is.

- **A suggestion's ends are dragged to adjust it, in review — a dev feature (§27.6).** The ends of the
  suggestion review is on take the pointer: a turn's or a move's stretch begun or ended elsewhere, a
  split's point moved, snapped as everything on the stage is, with its outline, its words and its row
  following the hand, and taken as adjusted. Its `adjusted` chip puts the ends back where the method
  found them.

- **Name, order and start the stage's sequences — a dev feature (§27.3, §27.4).** A sequence is renamed
  from its pencil on the sequences card, or a double click — the fused chromosome of the reassembly
  auto mode rebuilds is *chrXVI_Mmmyco* in its AGP, not *contig_39_e1* — and keeps the name through
  later edits; *longest first* orders the assembly in one step; and `O` starts a circle at the
  pointer, as the menu's *start the circle here* does.

- **The stage closer than its picture's cell — a dev feature (§27.9).** Zoomed in past two pixels a
  cell, the window on screen is read again from a finer rung, through the edit, in the reader's
  worker, and painted on the picture's own colour scale: the yeast assembly's 10 kb picture shows
  its 1 kb map where the reader looks. Never finer than the map is deep enough to show, so a shallow
  genome of a metagenome keeps its pooled cells. The picture card says when it is shown, and offers
  the picture's size — 16,384 cells a side down to 2,048 — for a faster read of a large map.

- **The stage places a suggestion finer than its picture's cell — a dev feature (§27.5).** Each
  point a suggestion puts inside a sequence — where it splits, a turned or moved stretch's ends,
  where a move puts it — is placed again at the map's finer rungs, down to the finest it is deep
  enough for, by one small read around it through the edit: the cut there the map least supports.
  The list says each as it comes in, *refined at 1 kb*, and auto mode takes each as placed. On the
  demo scrambled at breakpoints between its 16 kb cells, every point of what the 16 kb picture
  suggests is put back at 1 kb — the turn's and the move's to the base, the split within a kilobase.

- **The stage reorders without joining — a dev feature (§27.4).** A piece pressed again selects its
  whole sequence, a stitched one whole, as a press on the sequence's name on a pieces bar does; **↑
  ↓** — or *earlier* and *later* on the selection's card — move a whole sequence one place in the
  order, or a piece among its sequence's pieces, and join nothing; and each row of the sequences
  card has a **grip** that drags the sequence to another place in the order. A stretch let go
  between two sequences is set there as a sequence of its own; joining is ⇧ held on the drop.

- **A dot plot in the stage's corner, redrawn through every edit — a dev feature (§27.3).** With another
  reference loaded beside the file's own sequence — the theoretical genome a strain was built to be —
  the stage draws the assembly against it in the map's corner, and after every step the lines move
  with the pieces they fall in: auto mode on the chrXVI–mycoides reassembly brings the fused
  chromosome's scattered contigs into one line. The streaks are found once, by the dot plot task, and
  only moved after that; the one under the pointer is named in the readout and a press frames it on
  the map. Folds away to a button, remembered.

- **A stretch set aside can be put back — a dev feature (§27.4).** Each row of the set-aside list on
  the stage's sequences card has *put back*: one step, undone like any other, that returns the piece
  as a sequence of its own, last, as the file reads it, selected and framed to be moved into place.

### Changed

- **A browser tab keeps a connected folder for the visit only (§20.6).** It was kept across
  reloads in Chromium tabs too; a tab is a page on whatever machine opened it, so only the installed
  app keeps folders now, and the connect button and the Files row say *this visit* in a tab.

- **The metaplot's per-feature heatmap is one smooth picture (§18.13).** It was a chart of one
  rectangle per cell below twenty thousand cells — seams between them, a border lit under the
  pointer, a card naming the cell — and a grid of filled rectangles above. It is now coloured once and
  drawn as one image across the whole box, neighbouring rows averaged where there are more than two
  thousand, smoothed as it is stretched, with no frame and nothing answering the pointer; its PDF holds
  it as one image the viewer interpolates, and its settings offer no tooltip switch.

- **The key has its ramp back, short, between its two numbers (§7.1).** `-4.18 ▬ -1.05`: a bar 48
  pixels long drawn through the colormap, as a gradient on screen and band by band in a PNG and a
  PDF, where the key had two squares for the ramp's two ends. On the default ramp, which runs white,
  yellow, red and black, the two ends could not say which of the four a cell halfway up is.

- **The lines between chromosomes are a little heavier (§7.1).** The dividers (`d`) were drawn at
  `metacooler show`'s 0.5 and 1 or one device pixel, whichever was larger — half a pixel on a 2×
  screen, a hairline in a 300 dpi PNG and, inconsistently, a whole one in the PDF. They are now 1.5
  CSS pixels between sequences and 2 between genomes or selection blocks, on screen, in a PNG and in
  the PDF alike, in the CLI's two greys, and each is centred on the pixel grid by its own width so it
  stays crisp rather than smudged across three pixels.

- **An aggregate peak analysis over a loop set leaves out the loops nearest the diagonal (§18.8).**
  *Nearest loop*, a new setting under Separation, is coolpuppy's `mindist`: a loop whose two
  anchors' centres are nearer than that many bins is not piled up. It is five bins by default, and 0
  piles up every loop, which is what it did before. coolpuppy's own default, `mindist='auto'`, is
  twice the half-width and two, where a window stops reaching the two diagonals left out. On the
  yeast demo's 1,506 loops at the default ±21 kb window, five bins leaves out none and coolpuppy's
  floor 959. The run says how many loops it left out and how near they were; at coolpuppy's floor it
  keeps the same 142 of the demo map's first 200 loops as coolpuppy, cell for cell.

- **APA opens on observed / expected, and its form shows only the cards that apply (§18.2, §18.8).**
  The normalisation starts on observed / expected rather than on distance-matched controls. The
  Control card, whose every setting belongs to the distance-matched control, is not drawn under any
  other normalisation, and the Ranking card, whose settings belong to a feature set, is not drawn for
  a loop set or every pair — where *N* and *groups* used to stay on screen for having been chosen on a
  feature set. In every task's form, a card none of whose controls apply is not drawn.

- **Track correlation leaves a window any of its tracks lacks out of every pair, as deepTools does
  (§18.8).** It was left out of that pair alone, so each coefficient was over windows of its own: on
  chr19, two mouse ATAC-seq replicates beside a Hi-C insulation score — which has no value where the
  map is too sparse to give one — read ρ = 0.59 at 100 bp where deepTools' `plotCorrelation` reads
  0.54 from the same windows. Every coefficient is now over the windows every track has a value for,
  the replicates read 0.54 as deepTools does, and the run says how many windows it left out;
  *compared*, beside *units* under the matrix, says how many are left.

- **The validation notebook holds ten more analyses to their references, and its timings are a
  notebook of their own (§18.10).** `notebooks/validation.qmd` adds coverage and virtual 4C against
  cooltools, pileups — raw, over the expected and over distance-matched controls, off the diagonal
  and on it — against coolpuppy, the pileup's chromosight score against `chromosight quantify`,
  Boost-HiC against its own Python, the metaplot against deepTools, interval overlap and its
  shuffled null against bedtools, base composition against bioframe and Biopython, the motif search
  against seqkit, and the track correlation against pyBigWig's exact window means and against
  deepTools, on 4DN's mouse Hi-C, ATAC-seq and insulation score, UCSC's mm10 and RefSeq genes, and
  GEO's yeast Micro-C, each fetched from where it was published. Where the reference draws at
  random, the two are compared as distributions, against the reference's own spread from seed to
  seed. It writes every command to
  `notebooks/work/validation/commands.json`, and the new `notebooks/timing.qmd` runs them again,
  round robin, writing every run (CPU and wall-clock seconds, peak memory, the machine and the
  versions) to one tidy table, `notebooks/work/validation/timings.tsv`, from which its tables and
  figures are drawn. It times one seed of the controls, one virtual 4C viewpoint, Boost-HiC on chr1,
  and APA raw and over controls but not over the expected, and sums a side's commands where it takes
  several: deepTools' `computeMatrix` and `plotProfile` against one metaplot.

- **Electron 43.2.0 → 43.7.9 (§15).** Past GHSA-gr2m-v5gq-v685, GHSA-j84w-jfhq-vhvj,
  GHSA-qmv3-fv6v-rmhq and GHSA-9qh4-3jw8-366w, four high advisories against the version 0.13.0
  shipped on. Still pinned exactly, for the reason `package.json` gives.

- **A chart's tooltip is the app's own, and spells a coordinate as the axes do (§18.13).** Every
  chart has a formatter now, written in classes rather than the library's `style=` markup, which a
  strict policy refuses — `VII`, `84.3 kb`, `2.24e-7`, as the ticks under it read.

- **The site moves to its own domain, <https://chromosomix.app/>.** `public/CNAME` names it, so the
  deploy builds for the root and a pull request's preview is announced at `chromosomix.app/pr/<n>/`;
  the README, the package's `homepage` — which the desktop and single-file builds read the generated
  stores from — the docs and the publishing scripts name it, and `scripts/publish-demo.sh` adds it to
  the origins the bucket allows to make signed requests. `docs/deploy.md` lists the four settings
  outside the repository the move needs — DNS, the Pages custom domain and its certificate, the
  Google and Dropbox registrations, the bucket's CORS — and the two things it cannot carry: a
  browser's storage, which stays with the old address, and an installed copy, whose service worker
  keeps serving its last build there.

- **The DNA Bacterial Zoo is a dev feature (§24.3, §29).** It is published with the multi-genome
  format, when the metacooler project is: with the switch in *About* off, *Connect to a data store*
  has no tile for it. The lab's store says it holds bacterial data, which its paper card now does.

- **The app is chromosomix (§1, §23, §29.5).** It was metacooler.js, with the mark *(meta)cooler* —
  named after metacooler, the Python CLI that writes `.metacool` files, which is a separate project
  and whose format is a dev feature here (§29). The header, the landing page, the tab's title, the
  install prompt, the desktop app's window and menu, and the producer a PDF, a workspace and an
  exported edit record say **chromosomix**, and every name the app gives its own things moves with
  it. None of the old spellings is read any more:
  - **The command line is `chromosomix`, the app's own name**, where it was `metacooler-run`
    (`dist-cli/chromosomix.mjs`, `npx chromosomix`), and the console writes its lines under that
    name. Every table, BED, bed3d and console script the app or the command writes heads itself
    `# chromosomix`, then the build: the version and the commit from the app, the version and
    `cli` from the command.
  - **A workspace is `workspace-<stamp>.chromosomix.json`, of `kind: "chromosomix.workspace"`, and a
    store is `kind: "chromosomix.store"`.** A workspace, a store, a session file or a `#session=`
    link written before is refused as not one. The demo workspaces are
    `demo/**/*.chromosomix.json`, so the lab's bucket needs `scripts/publish-demo.sh` and
    `scripts/publish-store.sh` again (the store's paper card is *The Chromosomix paper*, in
    `chromosomix_paper/`). The DNA Bacterial Zoo needs `scripts/DBZ_store.py index` over its folder and
    a sync, and its index is now `dbz/store.chromosomix.json`, beside the `store.json` the build before
    the rename reads, so it can be published while the site still runs that build. The 4DN and ENCODE
    shelves need a run of the stores workflow.
  - **What the browser keeps is under `chromosomix:`**, and in the IndexedDB database
    `chromosomix`: the theme, the columns, connected folders and buckets, recent colours and every
    other remembered setting start afresh.
  - **An embedding page hears `chromosomix:ready` and `chromosomix:state`, and sends
    `chromosomix:where` and `chromosomix:navigate` (§21.4).** A drag between the app's surfaces
    carries `application/x-chromosomix-*`, and the desktop bridge is `window.chromosomixDesktop`.
  - **The package is `chromosomix`**, the desktop app `chromosomix.app` (`io.github.js2264.chromosomix`),
    the single file `chromosomix-<tag>.html`, and the site and repository
    `js2264.github.io/chromosomix/` and `github.com/js2264/chromosomix`.

  *metacooler* keeps its own meaning: the Python CLI and API (`metacooler create`, `metacooler show`),
  the `metacooler-format` attributes a `.metacool` carries, and the reader that mirrors that API name
  for name, `MetaCooler` (§6). `METACOOLER_PYTHON` still names the interpreter the fixtures are built
  with.

- **A called set is one row, and its display says where it is drawn (§18.7, §18.8).** Insulation's
  boundaries and domains — and every other set a task calls: DI's borders and domains, peaks, A/B
  segments, sites, origins, flagged contigs, loops — arrived as two rows each, an overlay on the map
  and a lane beside it, with a switch on each and both on: one insulation run put five rows on the
  Tracks card for three results and drew every boundary twice, on the map as a box one bin wide and as
  a tick beside it. Each set is now one row whose **display** — a dropdown at the head of its settings
  and under its name in the drawer — is a **1D track** or a **map overlay**, never both. On the map a
  set of places has a **look**, a second dropdown beside the display: a **point** on the diagonal, or
  a **short diagonal marker** across it, ringed in the page's colour so it reads on the darkest row; a
  set of extents is drawn as the **corners** of the squares it claims along the diagonal — top edge
  and right edge, once, on the upper side — where it was the whole square drawn on both sides of the
  line it is symmetric about; on a turned map a corner is the two sides of a triangle on the axis. Each
  task says where a set opens: insulation lands as three rows, the score, the boundaries as segments
  one bin wide under it, and the domains as corners on the map; DI the same; peaks and A/B segments
  open as tracks under the lane they were called from, loops and the dot plot's streaks on the map. A
  set run again keeps its display, its look and its edges; the 1D browser draws every called set as a
  track and offers no display; a loop set's 1D track is its anchors and it still leaves as its BEDPE.
  A session saved with the two rows comes back as the one, a track where its lane was on.

- **A mark's row on the 3D key hides the mark itself (§25.5).** Under *colour by manual annotations*
  a click on a mark's name hid it from that model's colouring alone and left it on every map; it is
  now the mark's own eye on the card — the mark goes from the model, the maps and the tracks
  together, and the card's eye goes dark with it — and a double-click shows it alone everywhere. A
  model saved with marks taken off its colouring opens coloured by every drawn mark.

- **The RSG lab data store is new, and in two sections (§24.2, §24.3).** *Demo*: a yeast micro-C
  map at 1.6 kb with the sequence, genes, RNA-seq as a chart per gene, ATAC, MNase, shotgun, SNPs
  in sixteen samples and its loops; the same tracks with no map, at 5.5 kb with the six reading
  frames; Hi-C, micro-C and PCP of one locus in a deck of three, MNase and the genes under each;
  splicing on human chrX; and Gibcus et al. 2018's mitotic Hi-C time course in three tabs of decks.
  *Papers*: the session behind this viewer's Fig. 1 — 4DN's mouse ES-cell Hi-C at *Sox2* with
  CTCF, H3K27ac and H3K4me3, its insulation and its 3D model — and Meneu et al. 2025's
  *M. mycoides* and *M. pneumoniae* chromosomes in yeast, with MNase, RNA-seq, Pol II and Scc1. The
  yeast is R64 throughout: nothing in the store, the shelf beside its map or the paste boxes'
  examples names the old demo's synthetic chromosome XIII. The files live in one folder on the
  bucket, `demo/store/`, listed with their sources in `demo/store/MANIFEST.tsv`, written by
  `scripts/make_rsg_store.py` and published by `scripts/publish-store.sh`.

- **The link, the save button and the console moved next to back and forward (§5.5, §23).** They
  follow the two history buttons in the group after the panels, and the right of the header holds
  only theme, shortcuts, source and about. The command bar's sentence is cut short on one line rather
  than broken over two where the left side needs the room, and below 60rem the header's last group
  wraps under the first instead of running under the bar.

- **A whole chromosome is read and drawn one bin to a pixel up to 16,384 bins a side (§7.2, §9).**
  The raster's cap goes from 4,096 to 16,384, so yeast chromosome IV at 100 bp — 15,320 bins — opens
  whole at 100 bp and a zoom reaches single bins without another read, where it was drawn at 400 bp.
  How wide a window is read at its own bins is the memory guard's call, so a smaller machine reads a
  smaller square and pools the rest rather than refusing. To afford it, a block's memory budget is
  three quarters of what the device reports instead of half (6.4 GB on a machine reporting 8), and the
  raster is costed at 12 B a pixel instead of 16 — the auto-range buffer it also charged is never live
  beside the others. It costs time and memory: chromosome IV opens in about 45 s and 2.9 GB where it
  took 9 s and 235 MB. A chromosome that used to be pooled and read from a coarser rung of a ladder is
  now read at the open one, so mouse chr1 at 25 kb takes the open rung's 4.3 s instead of 1.3 s, for a
  picture twice as fine on each axis, and the whole yeast genome of a 100 bp ladder is its 2 kb rung
  read whole (6,064 bins, 2 kb) where it was that rung pooled to 4 kb. A pooled read — a whole genome
  no rung brings under the cap, a metagenome, the overview — keeps its 4,096 cells, and so do the
  correlation and smoothing; smoothing on a block past 16 M cells falls back to its floor and says so.

- **Space locks the map onto its diagonal, and a second press lets go (§7.2, §8.9).** It used to put
  the view back on the diagonal once — *Recentre on the diagonal* — and every pan, box and zoom after
  it landed a little off the line again. Now it slides the view onto the diagonal at the zoom it is
  at and keeps it there: a drag moves it along the line by as much of the drag as points that way, a
  zoom (wheel, pinch, Page Up and Page Down) is about the point of the line nearest the pointer, the
  arrows walk along it, a sideways scroll slides down it, and an Option-drag draws its box on the
  diagonal as Option and Shift do. **Unlocked, a sideways scroll is the columns alone**, where it
  always followed the diagonal. The button beside the turn is the lock's toggle, lit while it holds;
  the palette and the shortcuts dialog call it *Diagonal lock* and show its state. It is every map's,
  so a deck moves as one, it holds the next sequence stepped to, and the browser remembers it, as it
  does *Refine on zoom*.

- **`<` and `>` step to the neighbouring sequence, and the letters are where they read (§5.5, §5.6,
  §7.2, §8.10, §26.6).** The sequence steps were `[` and `]`, which a French keyboard types with
  AltGr — never a shortcut here — and a French Mac with ⇧⌥. `<` and `>` step on every layout: over
  the comma and the full stop on American and British QWERTY, so `,` and `.` step without Shift, and
  bare and shifted on the key of their own that AZERTY and most European keyboards have beside the
  left Shift — on a French or German Mac that key no longer folds Files when there is no sequence to
  step to, and the Files badge no longer prints it. **Control with them is the tab beside this one**
  (it was ⌘[ and ⌘]), Control on a Mac too, from a box being typed into as well. `e` is the O/E
  toggle, the breaks overlay moves to `m`, `f` is the track fill's again, and `b` bookmarks the view,
  as the button beside `go` does. **`0` refits from anywhere in the window** — *Fit the view*, the 1D
  browser's whole genome — rather than only once the map had been clicked, and by its place, so
  AZERTY's bare `à` does; Home still refits the focused map. **Page Up and Page Down zoom the focused
  map** about its centre, a wheel notch a press. **`?` opens the shortcuts dialog** (it was ⌘/ or
  Ctrl+/). A key a focused picture has already answered is no longer the window's too: a dot plot's
  canvas zooming on `+` stepped the map's resolution with it. The desktop menu shows `<`, `>` and `?`.

- **The digit row folds the side columns, in the order they stand, and `−` / `+` step the resolution
  (§5.5, §26.6).** The key left of `1` folds Files, then `1` General, `2` Annotations, `3` Aesthetics
  and `4` Analysis — left to right as the columns are on screen, where they were `f` `b` `a` `m` `j`.
  The row is matched by where the keys are, with or without Shift or Caps Lock, so AZERTY's bare `&`
  `é` `"` `'` are `1` to `4` and its `²` is the key left of `1`; on a Mac, whose ISO keyboards report
  that key differently, the key beside the left Shift folds Files as well. The Files badge prints what
  the keyboard has there — `²`, `@` on a French Mac, a backtick on QWERTY — from Chromium's layout map
  or from the reader's own keystrokes, and its tooltips say *the key left of 1*. `−` and `+` are
  *Coarser resolution* and *Finer resolution*: the resolution bar's stops walked one at a time from
  the lit one, onto a rung the reader added as onto the file's own, stopping at both ends, and in a
  deck every map follows. Either half of each key does (`_`, `=`), so neither needs Shift, and an
  AZERTY PC's minus is still the minus under Shift or Caps Lock, where it types a `6`. The map's canvas
  no longer zooms on `+` and `−` — it had the focus after any press on it, so one keystroke would have
  zoomed and re-read the map together — and nor does a deck's tracks cell; the wheel, a pinch and the
  boxes zoom, and the 1D browser keeps its 3× pair on the two keys. **The console moves to Control and
  the key left of `1`** (ctrl-` on QWERTY, Control on a Mac too), since the key alone is Files'. The
  desktop menu shows `1` for the General panel.

- **The validation notebook reads public data only, each file by its accession (§18.10).** Mouse
  Hi-C 4DNFIOZ1TRUS and three chicken maps (4DNFIH8L6WON, 4DNFITBCUX56, 4DNFIIML46E5) from 4DN, yeast
  Micro-C GSE151553 from GEO, two mouse ATAC-seq replicates (4DNFIIY4QW2D, 4DNFITBRHVZE) from 4DN, and
  UCSC's mm10 for GC phasing. Peak calling runs yapc's whole pipeline, IDR included, on the two
  replicates (chr19); HiCRep is held to `hicrep` alone; the 3D model runs its default 150 steps;
  compartments leave chrY out of the comparison. The times table gives each `chromosomix` command
  as a fold faster than its reference, and the text the mean of those folds. The prose is cut to what
  a reader of the results needs. Its reference scripts are files of their own in `notebooks/scripts/`,
  rather than strings it wrote out at render time.

- **A place visited again is drawn from memory (§2, §7.2, §12).** Going back to a chromosome, a
  window or a whole genome already seen on the same map read it again — every pixel decompressed and
  pooled again, and whatever another read had pushed out of the source's cache fetched again — for
  an answer that could not differ: on the lab's mouse `progenitors.mcool` at 10 kb, chr1 → chr2 →
  chr1 took 3.6 s the second time, and a window of chr1 and back to the chromosome 3.7 s, with every
  byte in memory. The reader's answers are now kept on the page, by question and by the map the
  worker holds, each with its pooled picture, and the same place comes back in under 0.4 s with no
  request; a place asked for again while its first read is under way waits for that read rather than
  starting a second. Coolers and `.hic` alike — the same walk's returns on a 940 MB chicken `.hic`
  took 1.7 s and 3.1 s and take 0.3 — in a single map, every cell of a deck and a comparison's
  second file, under one budget for the page: a sixteenth of the memory the device reports, 512 MiB
  where it says nothing, a gibibyte at most. `scripts/ui-revisit.mjs` drives the walk and prints the
  table. A resolution left and come back to finds its answers again; a total drawn to, a cell set
  and a failed open start afresh. The colouring writes each pixel as one word rather than four bytes
  — the same bytes — and takes a third less time for it. A window seen for the first time is still a
  read: it is drawn at a finer grid than the chromosome it was cut from, so nothing kept can draw
  it.

- **A map opens square, and the turn is a reading you ask for (§17.2).** The default was the other
  way round, on the argument that a band along a genomic axis is what a contact map is *for* — which
  is true of the figure and wrong about the arrival. The only blocks that can turn are single
  sequences, so every map the default reached was a chromosome a reader had just clicked on, and the
  picture changed shape as they got there. `flip` absent now means square, `flip=true` means turned,
  and both older spellings still parse. So a link from 0.13.0 with no `flip` in it — every link to a
  turned map, turned being the default then — now opens square; `flip=1` keeps one turned.

- **`.metacool` and `.mmetacool` are a dev feature (§3.2, §29.3).** With the switch off, both are
  refused as files this viewer does not read — in the sentence any unknown HDF5 file gets, which
  names neither — rather than a `.metacool` opening as the cooler of twenty thousand contigs it also
  is. The refusals a plain file can meet (an unknown HDF5, a gzip, no HDF5 signature, variable bins)
  stop naming the format and its commands; *About* describes the viewer without it; the lab's store
  drops the mock community's figure and its two files; and the genomes table, the genome views and
  the metagenome tasks go with it, since only such a file reaches them. The page's description and
  the install prompt's no longer name it. A `.metacool` 0.13.0 opened,
  or a link to one, now opens only in a browser with the switch on.

- **The `chromosomix` command reads a map balanced by default (§23.1).** Wherever the file carries
  weights, as the app does — the framing and every task's *use balancing weights* alike — and
  `--no-balance` reads the raw counts. `--balance` is refused with a pointer, since it asked for the
  default and a command that forgot it ran on raw counts under a framing line that said *balanced*;
  coverage keeps its own `--balance`, off by default. A copied command says `--no-balance` for an
  unbalanced run and nothing for a balanced one.

- **A file with several resolutions opens a third of the way up them, not at its finest (§3.6, §9).**
  An `.mcool` addressed at its root, a `.hic` named with no resolution and a zoomify ladder in an
  `.mmetacool` land on the third of six or seven rungs — the second of four or five, the finest of one
  or two — so a 5 GB 4DN map comes up at 25 kb rather than 1 kb, where every read is the largest the
  file has and the first chromosome asked for was the longest wait. The finest level is one pick away
  in the resolution list, and once picked it is the floor of every zoom as before; a comparison or a
  deck that asks for a bin size still gets it.

- **The map's level is in the General column (§7.3).** One `level` select at the head of the
  Sequences / Genomes / Contigs card replaces the Map card's `level` (genome, pair, a cooler's whole
  genome) and the metagenome's separate `Level` card.

- **A sideways scroll slides a map along its diagonal (§7)**, rows and columns together, as the
  reference editor's stage (a dev feature, new in this release) does: the diagonal stays put and the
  picture moves down the genome under it, where the columns alone carried it off the side of the
  picture within a screen. Over a turned band, and over two stretches that share no bins, it still
  slides along the columns.

- **A line on a turned map is the V its place makes (§17.4).** A line from the Manual annotations
  card was drawn straight up a turned map, as it is on the square, and a column of a turned picture is
  not a place: it crossed contacts between two other places the whole height of the band. It is drawn
  now as the two 45° rays of contacts its place anchors, standing on the axis at its position — the
  same V a pointer on a track draws there — and carries on straight down the lanes from the V's apex.
  One V per band of a mirrored pair; a horizontal line is the same V, and now continues down the lanes
  too; and a place just off the side of the picture still draws the arm that reaches into it. A bead
  hovered in the structure cell is echoed on a turned map as the same V, dashed, where it was a dashed
  line straight up the band (§25.4).

- **The map's correlation reaches 4,096 bins a side, and takes seconds there (§7.5).** Any square
  block the map can read can now be correlated, where it was capped at 1,500 bins: a whole bacterial
  genome at 1 kb, a human chromosome at 50 kb. All the pairs are one matrix product in WebAssembly,
  shared across the cores — from picking the score to the picture, a thousand bins in under half a
  second, 2,048 in under one and 4,096 in about two and a half, in Chromium on four cores. The
  Compartments task's correlation is the same arithmetic and as much faster.

- **The map's correlation counts an empty pixel as zero contacts (§7.5).** It left them out, as the
  O/E picture draws them, so it correlated each pair of rows over the cells both happened to have — not
  the matrix the Compartments task solves, though its note said so, and on a sparse map several times
  slower. The picture under the veil still draws them as paper.

- **Picking a score computed from the block reads nothing (§7.5).** `VC`, `ICE`, the baseline and the
  correlation repaint the map, where picking one re-read the whole block first; only another column
  of the file, or balancing, is a new read.

- **The pointer over a map with the crosshair on is a ring (§5.8).** Lucide's `locate`, twenty
  pixels square (the arrowhead's size) and centred on the hand, replaces the small open cross, and
  the guide lines stop at the ends of its ticks rather than running through it, so the cell under
  the pointer and its neighbours stay clear inside it; the gap follows the hand inside a zoomed-in
  cell. Over a lane or the 1D browser the small cross gives way to the arrowhead, beside the
  hairline with its tip on it, so the reader's own line can be told from another surface's pointer
  echoed as the same line; and with the crosshair off all three show the arrowhead.

- **A turned map reports the window a square map reports (§17.1).** `400 × 400 bins · 1.0 kb` was
  printed beside `IV:1,000,001-1,399,500 · 399.5 kb`, which is an arithmetic a reader checks and does
  not get: the rotated lattice counts in half bins, so the last half bin had no column to be measured
  to. Every window the view reports — the line under the picture, the framing an analysis runs on, a
  bookmark, what the 1D browser opens at — is on the file's own bin edges now.

- **The resolution row has no dead slider.** A one-rung `.cool` — the commonest file a lab opens —
  drew a greyed slider beside its single `1 kb` stop, which is §8.5's absent-not-disabled rule broken
  on the row every reader looks at. The row reads `resolution 1 kb +`, and the slider arrives with
  the second rung. `F` is gated the same way: it folded a Files column that does not exist until a
  folder is connected.

- **The whole genome of a laddered file is drawn from a coarse rung instead of asking to download the
  file (§9).** On a 5 GB `.mcool` at 25 kb, *whole genome* was a gate — "reads every stored pixel of
  the file, 5.0 GB downloaded" — beside a button to reopen the file at 500 kb. It now reads the
  coarsest rung whose bins fit a drawn cell and draws: 5 s after landing over the network, 4 s for a
  1 GB file on disk, and a zoom inside it still refines to the rung that is open.

- **Past nine rungs the resolution row is a dropdown of every rung**, beside the word, in the
  ladder's own order. It was a slider and one chip: between them they said how many rungs there were
  and which one was being read, and named the rest only to a reader who hovered the slider — so the
  control that saved the room was also the one that hid the ladder.

- **The analysis tasks are four cards, cut by dimension (§18.8).** *2D tasks*, *3D tasks*, *1D tasks*
  and *Metagenome*, each with the frame, mark and fold every other card in every other column has,
  where there was one flat list under three headings. The cut is **by the dimension the question is
  about** rather than by the file it reads: aggregate peak analysis sits with the matrix it piles up
  rather than with the loop set that says where, and metaplot with the track it averages rather than
  with the features it averages over. Metagenome stays a group of its own because its four tasks are
  not about a dimension — a MAG is a bin of an assembly — and its card is absent on a file with no
  genomes, as any card whose every task is absent now is. Within a card the task that *makes* the
  thing the others read comes first, so **model from the map** opens the 3D card: a reader with no
  structure loaded has exactly one thing to do in it, and it was the third row.

- **P(s) asks for no file on a map binned from a `.pairs` (§18.8).** The import counts the four
  orientations in its own pass (§3.7), and the run already took them from there when the address box
  was left empty — but the box was on the form all the same, under a hint about leaving it empty, and
  read as the one thing the curves were waiting for. On such a map *four orientations* is now the only
  question, and the price beside **Run** says where they come from: *The four orientations were
  counted as CG002…pairs.gz was binned.* Where the file had no strand columns, or the map was opened as
  a matrix, the drop area is there and the price says it needs one. A refusal about the map — no
  sequence ticked — is no longer skipped when a `.pairs` is named.

- **The tasks are called *Compartments* and *Reproducibility* (§18.8).** The words in brackets,
  *eigenvectors* and *HiCRep*, named a method where every other title in the column names what is
  measured, and §18 already called the two tasks so; `chromosomix --help` lists them the same.

- **Diamond insulation is cooltools' own, to the pixel (§18.8).** A bin's score is the mean of the
  valid cells of the square cornered on its diagonal pixel, over the median of its sequence, in log2 —
  `cooltools.insulation`'s `log2_insulation_score` — and its boundaries are cooltools' prominences,
  read over the bins whose diamond holds at least *diamond coverage to call* of the fullest one's
  cells. It was a sum over a window half a bin along, against the sequence's mean, and agreed with
  cooltools only where the window was whole: r = 0.98 there, 0.82 beside a dropped bin, on mouse at
  10 kb. The two ends of a sequence and the edges of a dropped row are now scored from what their
  diamond holds, where they were gaps, and a sequence shorter than twice the window is scored rather
  than refused; the coverage setting, which blanked those bins, now only keeps them out of the calls,
  and sits under *Boundaries*. Held to cooltools' table bin for bin on the demo map
  (`npm run fixtures:analysis -- --only insulation`).

- **An optional input is filled only from what the reader loaded (§18.2).** The two loci an origin
  call leaves were the first interval set on the list and phased every compartment call after it; a
  computed set is chosen now and never assumed. The compartments' phasing track and the origin
  call's coverage start on none.

- **The help text under an analysis control says something, or it is gone (§26.4).** Every parameter
  in the catalogue carried a hint and a good many of them restated the label, described a default the
  control was already showing, or repeated the box's own tooltip a line lower down — *every one,
  unless you say otherwise* under a column of tick boxes with every box ticked, *the places to average
  over* under a control labelled **features**. Eight of those are deleted. A third of the rest had
  grown a second or third sentence, which is a paragraph beside a control in a column whose **Run**
  button it pushes down, and those are one sentence again; a toggle may still add what its *off* state
  does, which is the one exception the rule has ever had. What is kept is what a reader cannot get
  from the control: what a number does to the result, what a unit means, what an empty answer means,
  what a mode refuses. A test now holds the one-sentence rule, which was written down and nothing
  enforced.

- **Every matrix setting is a number of bins, or of diagonals — never kb or Mb (§18.2).** A scan
  band, a shift, a stratum, a near-diagonal trim and the separation between two anchors are all
  counts of the file's own cells: the runner's first act on a length in base pairs was to divide it by
  the bin size, so the reader was doing arithmetic the run then undid, and the same typed number meant
  different things on two rungs of one `.mcool`. The scalogram's *look out to*, the APA's two control
  shifts and its separation range, pattern detection's three scan distances and reproducibility's
  furthest separation now ask in bins, with their defaults translated: a 100 kb control shift, which
  cleared a 43-bin pileup window at 1 kb and sat *inside* it at 10 kb, is 50 bins and clears it at
  every resolution. **The `n bins at 1 kb` caption under those boxes is gone** with the boxes it was
  for, and what a run came to in base pairs is said once by the run itself, about the file open. Two
  things did not move: a **1D track's** flank, sampling step or window is a length of genome and is
  still asked in base pairs — track correlation's is no longer called a *bin size* either — and a
  plot's own axes, including the `.scool` phasing plot's published band edges, stay in kb and Mb.

- **One shape for *which sequences to run on*, and it is the tick boxes (§18.2).** Nine analysis
  tasks asked that question and they asked it two ways: four with a column of tick boxes, five —
  P(s), the scalogram, insulation, the directionality index and the HiC score — with a dropdown whose
  first option read *every sequence*. A reader met both shapes in one column, a row apart, for one
  question. The five moved onto the tick boxes, which is the answer the dropdown could not give:
  **these three sequences**, where a select could only offer every one or exactly one. Every one of
  them starts with every box ticked, so a genome-wide run is still what pressing **Run** does; one
  ticked box is the run a named sequence used to give, bin for bin; and pressing **none** now says so
  rather than quietly reading the whole file. On the command line the flag is `--sequences I,IV`
  where it was `--region IV`, and a sequence a file has not got is named in the run's notes instead
  of being dropped. What stays a locus box is what a list of names cannot answer: the 4C anchor, the
  structure tasks' *distance to*, and the reconstruction's own box.

- **The analysis framing line says one thing once (§18.4).** It read `1.0 kb bins · balanced ·
  balanced` on every file with weights, because the balance flag and the score picker's label are the
  same word — a stutter in the string that is copied into every provenance record and TSV header, and
  that reads as two normalisations having been applied. And the window in it is the display form, so
  the drawer's *will run on*, the figure's caption and the map's own summary now agree character for
  character rather than differing by a base.

- **A waiting analysis group says what it needs once, not once per row (§18.1).** Ten of the sixteen
  tasks read the matrix, so a 1D browser session drew ten rows under ON THE MAP each carrying the
  identical *Open a contact map — this one reads the matrix itself.* — a column twice as tall as its
  content, in which the one gate that differed (APA's loop set) was the hardest line in it to find.
  When every waiting row of a group is waiting on the same thing the sentence is printed once, under
  the heading; rows whose sentences differ keep their own; and every greyed row carries its reason in
  its tooltip either way. The sentences also take one shape now — *Open a contact map.*, *Load a
  structure (g3d, .3dg or bed3d).*, *Load a FASTA to search.* — where there were five phrasings, one
  of them not a sentence, and one of which told a Dip-C reader holding a `.3dg` that their file would
  not do.

- **The analysis drawer's form looks like the cards it opens over (§18.2).** Every field label and
  every select option in every task was Title-case while every label on the three panels beside it
  was lowercase, so the drawer read as a different application bolted to the side of this one. All of
  them are lowercase now, and a label is one to three words in one column down the form, so
  *minimum separation* and *log bins per step* stop breaking into two lines. **A number keeps its
  unit on its line**: the box filled the whole control column and dropped *bins* underneath itself,
  which is how a reader comes to type base pairs into a box that wanted bins. **A single on/off
  button shares its label's row** instead of floating on a line of its own under a hint that was
  aligned with the label rather than with it.

- ***pick on map* sits next to the locus box, which is what §18.1 always said it did.** The wrapper
  holding the box and the button was `display: contents`, which dissolved it into a two-column grid —
  so the button wrapped onto the next row and landed in the label column, flush under *distance to*
  and reading as a form action of its own. It is also spelled the way the Manual annotations card
  spells it, since it is the same gesture.

- **A run's cost line is a price and nothing else (§18.6).** Every scan ended *progress is reported as
  it goes and it can be cancelled at any point* — eighteen copies of a promise the progress bar and
  the cancel button beside it make by existing, filling the one line a reader checks before spending
  compute with reassurance instead of a figure. It now says what will be read, and the sentence no
  longer ends in a full stop that the appended request count followed with a middle dot.

- ***cancel* is a bordered button beside *run*, and so are the exports (§18.1, §18.7).** The control
  that stops a forty-second scan was borderless grey text at the far end of a row of prose, in the
  weight this app uses for a link; `TSV`, `bed3d`, `PNG`, `PDF`, *copy provenance* and *copy CLI
  command* were the same, so the buttons that get a result out of the application read as captions.

- **Where a result went is one sentence for the run (§18.7).** Spatial tracks makes three lanes, and
  three lanes were three dashed boxes each repeating the same thirty words — *is one value per bin, so
  it is a lane rather than a picture…* — with a lone TSV under each. It is now one line saying where
  they went and one row per output: its name and its exports. The 3D model's note no longer opens by
  telling you that the thing called *3D model* is a 3D model.

- **A result line reads `computed in 16 ms at 20:49:46`.** It used to print the ISO instant with its
  milliseconds and its `Z` in the middle of a sentence, which reads as machine output that has leaked;
  that exact stamp is what *copy provenance* beside it writes, and is now the line's tooltip.

- **The running line is the step, not the task's name again.** *Contact probability P(s) — Reading
  pixels* was two thirds a repeat of the heading directly above it, and pushed the one new word to the
  end. A one-step job now says `reading pixels`; a chain still names its step, where the step is news.

- **A figure's `log x` is a button when it is off (§18.13).** It was borderless, so an unlit axis
  toggle was plain grey text beside a dropdown — a label, as far as the eye is concerned, in exactly
  the state where a reader needs to see that there is something to press. The figure settings' tick
  boxes are now the same `on`/`off` button the form and the lane settings use, so one figure's
  booleans have one shape, and *Fit*, *Reset*, *Show all* and *Colours* are lowercase like every other
  button — the last of them now reading *reset colours*, which is what pressing it does.

- **A figure's column heads are aligned with their columns and have names.** A `<th>` centres itself,
  so every head sat over the middle of a column of left-aligned cells; and the *Model from the map*
  table's first head was blank, which made it a sort button whose tooltip read *Sort by* and whose
  column had to be inferred from its rows. A weighted stress reads `0.0399` rather than `3.994e-2`
  beside a Spearman ρ of `0.881`.

- ***Find a sequence* is *Find a motif*.** A sequence is a chromosome or a contig everywhere else in
  this application, so a task called *Find a sequence* with a field called *Sequence* read as "jump to
  chrIV" — which is the locus box's job. The field is *motif*; the reference it searches is
  *reference*.

- **Cis and trans per sequence draws its fractions (§18.8).** The number the first table of every
  Hi-C paper quotes was the one output of that task with nothing to look at: a column of
  three-decimal numbers under a square of sequence pairs, so a reader asking *is any sequence
  behaving unlike the rest* had to scan a list of `0.99`s for the one that was not — which on a
  four-thousand-contig metagenome nobody does. There is now a bar per sequence, in the file's own
  order, and a *bars per sequence* setting saying whether it stands for the cis fraction, the trans
  fraction, or both stacked into the full bar the two make. Fractions and not counts, because a bar
  of raw contacts is a picture of how long each sequence is; the ordinate reads in per cent (§26.2)
  while the numbers stay fractions; a sequence with no contact at all is a gap rather than a zero;
  and the export row beneath it is every other figure's, with the TSV naming each sequence in its
  first column rather than printing the index its bar stands at.

- **Compartments measure a circle's decay the short way round (§8.15).** A sequence declared
  circular is divided by its decay measured the short way round; the task is version 3.

- **A feature's box is edged like a coverage track's top (§8.16).** With the *track outline*
  preference on — the default — every block of a BED, a peak set, a gene or a call is drawn with the
  hairline in the plot's ink that runs along the top of a coverage track: beside the map, in the 1D
  browser and in a saved figure. Blocks that abut, a pale colour and an untranslated end against its
  coding span now read as shapes. A block under four pixels either way keeps its colour unedged, and
  the one switch turns the rule off on the tracks and the boxes together.

- **A track to the left of a map grows away from it (§8.9).** Left-hand lanes grew towards the matrix,
  pointing a profile's peaks into the map where the same track above it points them away; they now
  mirror the top stack across the diagonal, as the right-hand stack mirrors the bottom one. A file
  dropped there, a computed track (which opens on the left) and a row placed there all start that
  way; a lane saved before keeps its direction. A track placed on a map it was not on starts as the
  lanes on that edge start where it crosses the diagonal — rather than growing into the map beside
  lanes that grew away, or hanging upside down in a tracks cell — and keeps its own reading on an edge
  that reads like its own. A track moved by two presses of its location marks — the new edge on, the
  old one off — is turned as one moved in one.

- **A track's location is four marks on its map's line (§8.1).** The four words — top, right,
  bottom, left — are four marks of the map with one edge drawn solid, beside the label with one map,
  and at the end of each map's own line in a deck, where the words took a line of their own under
  every name. The same in the box that edits ticked tracks together.

- **Features are rounded blocks that end in a point, and grow with their lane (§8.16).** A stranded
  feature's direction is the point on the block it ends in — a transcript's last exon — and nothing
  else: the chevrons through long boxes and along introns are gone. Corners are rounded a little, and
  a block takes its whole row up to 22 pixels, so a taller lane draws thicker genes where they used to
  stop at nine and thirteen. Variants stay square.

- **The crosshair toggle reaches the tracks beside a map (§5.8).** Their own hairline under the
  pointer, and the line it carries across the map, were drawn whatever the toggle said, so turning
  the crosshair off took it off the map and left it on every track; a deck's tracks cell went on
  following the map's pointer the same way.

- **Ticked tracks are edited together (§8.1).** The box two ticks open carries a row's settings —
  colour, height, style, scale, flip, limits, group, location, and opacity for overlays — showing what
  the ticked rows share and *mixed* where they differ, and writing a pick to every ticked row it
  applies to (a style picked over a gene model and two bigWigs lands on the two bigWigs). Limits take
  both bounds; *auto* keeps each row's own pair. *same height* is the height box now, and *hide* turns
  to *show* when every ticked row is hidden.

- **Synthetic tracks are rows of the Tracks card (§18.5).** What a task computed — a profile, a
  called set — and a comparison of two tracks are listed with the loaded tracks, marked `*` after the
  name as a resolution the file does not store is, with the task that made them on the summary line
  and the provenance in the mark's tooltip. They take every control a loaded track takes: height,
  style, scale, flip, limits, group, edges, and a tick box into the batch. Their exports and framing
  are in their settings, and a row that came back from a reload offers *recompute* where a file's
  row offers to re-open it. The *Synthetic tracks* card is gone.

- **A search hit names the gene, not the window it opens.** `NTH1 (YDR001C) · IV:449,655` was the
  start of a *padded* window — a quarter of the gene's length before the gene begins, and a base off
  the locus box the click then filled. It is the feature's own span now, in both the map's list and
  the browser's, which is the number a reader copies into a primer tool or a paper.

- **A track's name is no longer pushed under an ellipsis by a star.** The outline star stood on every
  feature row and took the width `ATAC peaks` needed, so the two rows a reader has to tell apart read
  `ATAC` and `ATAC p…`. It appears on hover or focus; the filled one, which says which set the search
  reads, never hides.

  The row's marks are tighter too, so the name keeps its room whether the star shows or not.

- **Ticking two tracks shows the bar that acts on them.** It was rendered under the rows, which on a
  list of seven put it off the bottom of the column — so ticking boxes visibly did nothing and the
  ticks read as highlighting. It is above the rows.

- **Peak sets, BED files, loop sets and structure lanes open at 24 px rather than 16.** At sixteen the
  lane's own name was drawn through the calls it named and had no click target at all, because the
  rule that keeps a label clear of the resize border cannot be met in that height.

- **Numbers on a track row are grouped, and a value range is written with an en dash.** A bigWig
  reaching 1599 wrote `0.16 to 1599` two rows under `12,110,231 bp`.

- **A lane's limits are the colour clip's control (§8.8).** Two boxes, the `⇅` mark every autoscale in
  the app wears — unavailable while there is nothing to go back to — and a line reading *auto · 0 –
  84.5*. The lit `auto` word it replaces meant one column carried two drawings of *let the data set
  the range*, lit when on in one and greyed when on in the other. The clip's own row now says which
  units each of its two numbers is in: `clip (log10)` over the boxes, and the score's word after the
  caption's pair.

- **The Groups card's empty state is two sentences.** It was an eleven-line essay on the theory of
  shared limits, in a card with no control in it, pointing at a bar two panels away as "below them".
  Its two mode buttons are toggles now, lit when the group is in that state: `unlink` offering to
  unlink told a reader nothing about whether the group *was* linked, and the picture — two axes that
  happen to agree — cannot say either.

- **The track-height box says what the tracks are.** It read `90` over lanes that were plainly 46 px
  tall, because it kept the last number it had applied while stretch, shrink, a group's levelling and
  a drag on a lane's border all changed the heights behind it — so a press of *down* from 90 made a
  46-pixel track taller. It reads the lanes now, blank where they disagree, and a press starts from
  their middle height. Both halves of the pair beside it say they are percentages.

- **The 1D browser's bar zooms in the map's own four steps.** It had two unlabelled magnifiers at
  1.8×, beside a region bar carrying `⊖10× ⊖3× ⊕3× ⊕10×` on the same screen: a reader who had learnt
  that one press is 3× on the map got something unpredictable on the tracks, and the zoom-out stayed
  live with the whole genome already on screen. The four buttons are `RegionView`'s own, each greys
  itself when there is nowhere in its direction to go, and the `−` / `+` keys drive the 3× pair. The
  three lane-height marks have left the bar — they are the same three the Tracks card draws a few
  inches away, and the map's bar never carried them.

- **A tracks cell of the deck is its axis and its lanes (§25.3).** Its locus box, zoom steps and summary
  line are gone: where to look is asked in the lead's bar above the grid, and the cell still pans and
  zooms in place.

- **The General column's File card follows the star (§16.5).** It describes the starred map's file,
  named under its heading with the star as the Map card is, where it went on describing the first map
  whatever was starred.

- **A file dropped on a `+` lands at the near end of the edge (§16.9).** Below a short last row it
  went into the hole the press squared up, a row above the one the reader aimed at.

- **The first map's eye on the Contact maps card closes its cell in a deck (§16.9).** As every other
  map's eye does. It put the map down for the 1D browser, which in a deck also took every companion
  map away with it; outside a deck it still does that.

- **A deck beside the 1D browser exports the browser too (§25.3).** The deck's figure left a gap where
  the tracks stood, and the browser's Export card saved the tracks alone however much stood beside
  them; the card now saves the deck's figure, as a map's does. The bar no longer offers to match maps'
  scales and resolutions in a deck that cannot hold a map, and no longer counts the browser as a map.

- **Closing a contact map in the deck hides it (§16.9, §16.5).** The × on a map's own cell, and
  *close deck*, used to drop the map from the session; it now stays on the Contact maps card with its
  eye dark, and the eye opens it in a cell again — the card's × is where a map is let go. The cell
  closes only where the map was all it held: one with tracks drawn in it stays as a tracks cell
  showing them, instead of parking them on the first map.

- **The Aesthetics column's *Map* card is the starred map's (§16.5).** Starring a companion puts
  *its* card in the column, in the first map's place, and a setting changed there changes that map
  and no other; starring the first map puts its own back. A line under the card's title names the
  map it sets, with its star. The turn is the one row that still reaches every map, because the lock
  needs every map drawn one way, and it is on every map's card for that reason.

- **A companion's O/E and smoothing are its own, as its score already was (§16.2).** They were
  shared with the first map and offered on its card alone, so a companion could pick its own score
  in its corner menu but not its own baseline or smoothing. Each map now opens on the first map's
  and keeps its own from then on, remembered with its clip in the session, the workspace and the
  durable record. The first map's are still the ones in the link.

- **The Contact maps card asks for a second map only once there is a first.** With no map open it
  drew two identical rectangles, the lower one offering a *second map* to fill *the lower-left
  triangle* — of nothing — and both opened the same file the same way. The zone is also named for
  what it does, *Load a map into the lower triangle*, so it is not mistaken for the deck's companion
  cell, which is what HiCRep and the deck bar mean by a second map.

- **The deck's bar says what its controls do (§16.5).** *fix all scales* and *fix all resolutions*
  read as repairs to a Juicebox or HiGlass user and are now **match all scales** / **match all
  resolutions**, the verb this app already uses for the one-off act of putting one picture on
  another's footing; their tooltips are a sentence each instead of a paragraph ending in a spec
  citation. *add a map…* is **add a cell…**, because the row it opens also holds the 3D structure
  and a stack of tracks — and the tracks cell had no other road on screen, hidden behind a button
  promising a map. In that row, *3D structure* and *tracks* lead with the verb their neighbours do:
  **add a 3D structure** and **add a tracks cell**. The × that closed the whole deck is a bordered
  **close deck**: it was the same bare mark a cell's own close is, a finger's width above it, and
  one of the two takes every companion map and the tracks loaded for them.

- **The first map's chain moved from the bar to the first map's own heading (§16.5).** Taking one
  cell off the shared navigation is a statement about that cell, and every companion's chain has
  always sat on it; the lead's sat in the bar, where the same glyph at two heights read as a lock
  over the whole deck. The three chains — the lead's, a map's and the tracks cell's — now say the
  same two sentences and are drawn the same way, lit while a cell is following and plain while it is
  not, where a cell moving on its own used to have its chain greyed like a control you cannot press.

- **The deck's `N across` picker says *cells* rather than *maps*,** since it lays out the structure
  and tracks cells too, and no longer prints the backticks it was written with.

- **The `+` edges say what the cell they open can hold.** Beside the 1D browser they promised
  "drop a cooler on one", which is the one thing a deck with no map to follow has to refuse.

- **An exported 3D model is framed by its cell's edge (§25.7).** A thin rule round the model's
  picture, the weight and colour of the map's plot border, in the deck's figure, the card's PNG and
  PDF and the clipboard — so a model zoomed past its cell reads as framed rather than floating with
  one side sliced off.

- **The *3D structure* card names the starred cell, as the *Map* card names the starred map
  (§25.3).** `★ Yeast_structure` under its title, where the card had a *model* dropdown; the line
  reads *every structure — all N* while nothing is starred, and is absent on a deck of one model.
  Which model a cell draws is chosen from the Structures card: its eye, or its row dropped on the
  cell.

- **The 3D colourings are named for what they measure, and the model's own five lead the list
  (§25.5).** *sequence*, *linear position along the sequence*, *manual annotations* (was *your
  marks*, also under *loops as chords*), *spatial distance to pinned bin* and *contacts with pinned
  bin*, then haplotype, the file's columns, tracks and feature sets. The *score column* colouring is
  gone; a session stored with it opens coloured by sequence.

- **A named `.g3d`, `.3dg` or `.bed3d` is not sniffed at all (§25.2).** The two content tests exist
  to tell a structure from a BED whose columns happen to be numbers, and a file that names its
  format has been told apart already — by the reader who named it. A name used to be spared the
  *fractional* test but not the *chain* test, so a model whose beads are a scatter rather than a
  walk — a randomised control, a draw from a null, a fragment set nobody has folded — fell through
  to BED and opened as a lane of boxes whose end is a coordinate in space. The row had already been
  sent to the Structures card by the same name, so the row and its payload disagreed about what had
  been loaded.

  The name is read before a single row and settles the format: a named file that turns out not to be
  a structure is refused as one, in its format's words and on the card its name sent it to; and the
  name is read past any directories with a `?query` or `#fragment` cut off, so a model published at
  a URL is as named as one on disk.

- **A Structures row has one control for being drawn.** The eye and a *show in the deck* button did
  the same thing, and while the cell was drawing the row the button relabelled itself *shown in the
  deck* and went on showing — so pressing the lit one, which is what anybody would do to un-show,
  did nothing. The eye shows and hides. Its `bed3d` now sits after the word *export*, like the
  Metadata card's TSV.

- **The 3D structure card is laid out like the cards above it (§25.3).** Nothing on it is unlabelled
  any more. A grid rule had been pushing the third control of a row onto a second line *in the label
  column*, so the chords' set appeared as a bare `none` under a toggle stretched across the whole
  card, and the fog's depth as a slider with no name at all: `loops as chords` is now label, toggle
  and set on one line. **Every slider prints the number it is at**: a bead radius you cannot read is
  a figure you cannot reproduce in a second session or write into a methods section. The rows are in
  one order, each choice before the thing that modifies it: *outside window* now precedes the ghost
  opacity, which is greyed with its reason while nothing is being ghosted. The homologue picker is
  *haplotype* and the marks row is *overlays*, which is what the Map and Tracks cards call the same
  row; both used to read *show*. The chords' toggle is absent while the set is `none`, where it was
  lit with nothing to show.

  A select sits on one line with its label wherever the card is wide enough to read the value, and
  drops the label above it only below about 15 rem — asked of the card through a container query,
  since it is drawn both in the Aesthetics column and in the enlarged dialog's sidebar. A slider
  that only shapes what a toggle or a select arms shares that control's row: *fog* carries its
  depth, *outside window* its opacity. *Overlays* sits beside *drawn as*.

- **The model saves through the app's one export row (§25.7).** It was two quiet words, `PNG PDF`, at
  a fixed 300 dpi — the third export idiom on one screen, and the only one with no resolution in it,
  so a reader who had chosen 600 dpi in the Export card above got 300 from here and nothing said so.
  It is now `[resolution] [format] [⭳] [⧉]` like the map's and the browser's, with a line under it
  saying what was written, and the model goes to the clipboard as readily as a map does. The camera
  and frame rows are bordered buttons for the same reason: a grey word beside a bordered toggle reads
  as a caption for it, and nobody knew `side` could be pressed.

- **Five corner buttons on the structure cell, each with its own mark (§25.3).** *Frame the window*
  wears the refit mark the Map card uses and *enlarge* a distinct one, where two corner-bracket
  glyphs sat side by side and were told apart only by hovering them. The keys those buttons and the
  card's camera row print are the keys that are actually bound: `(f)` on a card beside a deck was
  offering a letter that folds the Files panel. The mode badge in its corner has lost the border
  that made a readout look like a button nobody could press.

- **The modes on a structure cell have no letters (§25.4), which is what the contract always said.**
  `e`, `o` and `m` armed them while the model was enlarged — over a model, which is exactly where a
  bare letter gets pressed by accident — and each of the three belonged to something else, so the
  shortcuts dialog printed two rows for one key.

- **A structure and its lanes are named with a reader's coordinates (§25.6, §26.1).** *3D model ·
  IV:1000001-1400000* sat one line above the framing's *IV:1,000,000-1,400,000* — the one string on
  the Structures card with no separators in it — and *Distance to IV:1000001-1400000* named a 400 kb
  stretch as though the distance were to a point. It is *Distance to the centre of
  IV:1,000,001-1,400,000* now, which is what the code measures.

- **The centre of rotation is shown by default, and it is a gizmo rather than a cross (§25.5).** A
  ball at the camera's target with three arms out of it — one per axis, a **head** on the positive
  end and a short stub on the negative, in the colours every 3D tool uses. It is where every drag
  turns about and where ⌘-click puts the next one, so a reader who cannot see it is turning the
  model about a point they have to infer from the motion; and six half-lines crossing in a dot said
  neither which way an axis went nor which end was the centre. A session stored before this opens
  with it on, which is what the stored-style reader had to be taught: `axes` was read as *on only if
  the file says so*, and the default arriving as its opposite for every reader who has been here
  before is the one way a default change reaches nobody.

- **The ghost opacity starts at 0.1 rather than 0.15 (§25.3).** What is outside the window should be
  a trace of where the rest of the genome went, not a second picture competing with the one being
  read.

- **Ghosting is a transparency now, not a pale colour (§25.5).** A ghosted bead — one outside the
  deck's window, or clicked away in the key — was its own colour *mixed towards the page*, which on
  a white page reads as washed-out rather than faint, left the geometry fully opaque so it still hid
  whatever was behind it, and at an opacity of **0** left a page-coloured bead punching a hole in the
  model rather than getting out of the way. It is real alpha now: the hue is kept, what is behind
  shows through, and 0 is **gone**. The 2D painter always did it this way, so a model on screen and
  the same model in an exported PDF no longer disagree about what ghosting means.

- **The model turns without limit (§25.5).** A drag used to stop dead a hair short of the poles, so
  turning a globule over to see its far side ran into a wall halfway through the gesture. Both
  angles now wrap: the model goes over the top and keeps going. The clamp was a turntable's
  convention for keeping a horizon level, and a structure has no horizon; nothing in the arithmetic
  needed it, the camera's frame being orthonormal at every elevation.

- **A link that names a genome on a file with none lands on the file's chromosomes (§9).** `view=genome`
  and `view=pair` on a cooler, a `.hic` or a `.pairs` used to end on a refusal about genomes; a region or
  a selection carrying a genome name now opens as the same view without it. And a locus that names no
  sequence of such a file is refused as *not a sequence of this file*, listing its sequences, where it
  listed an empty `Genomes: []` first — `ops/range.py`'s sentence is kept word for word for the files
  that have genomes, which are the only ones it was written for. The desktop build's *Go* menu says
  *Landing table* and *Previous / Next sequence*, words true on every file.

- **A map opened with its tracks is drawn first, and laid out once (§8.6).** The tracks' rows are
  seated at once and their files read once the map's first block is drawn (at most four seconds
  later), as is the circularity measurement; they used to share the map's first read with a 12 MB
  FASTA and a 10 MB gene model, so on a 25 Mbit/s line the demo session's map came 6.7 s after its
  view mounted and now comes in 2.5 s. The lane stacks keep room for rows still reading, so the map
  is no longer shrunk and re-fitted when the sequence lane lands last, and download progress
  reaches a row four times a second rather than twenty.

- **A folder is *connected*, on every screen that offers one.** The landing page said *Mount a local
  or remote folder*, the dialog it opened was titled *Open a local/remote folder*, and every button
  and every sentence about the result said *connect* — three verbs for one act, one of them jargon
  found nowhere else in the app. The heading, the dialog's title and the Connect dialog's four panes
  now use one word each: a file is opened, a folder is connected (§20, §24.2).

  So does the Files column's own button, and the sentences pointing a reader at it name it in quotes
  rather than in Markdown asterisks.

- **A sign-in this site cannot make no longer offers a button on the first screen.** *sign in to
  Dropbox…* stood on the landing page of sites built without a Dropbox app key, and answered the
  press with a greyed button and the name of an environment variable; Drive had the same hole. The
  landing row now reads the registration as well as the build, so it offers the sign-ins that can
  happen — while the Connect dialog keeps every tile, because a reader who went looking for Drive is
  owed the sentence saying why it is not there (§24.2).

- **The panes of the Connect dialog are headed by the tile you pressed** — *This machine*, *A
  bucket*, *Google Drive*, *Dropbox* — and their buttons say *sign in to*, in the words the landing
  page used one press earlier. The bucket form's button says *connect this bucket* rather than
  *save*, which promised a stored setting where what happens is the listing you came for.

- **Where connected places are listed is named by its own name.** Three sentences in the Connect
  dialog sent a reader to *About → what is stored*, which the About dialog has never had; the screen
  they meant is *What this browser is remembering*, in the palette's Help group.

- **A store row's provenance is readable.** The chip carrying an accession and a DOI is clipped at
  the card's width, and its tooltip said what the chip was — *Where the data came from* — rather
  than what it held, so a reader who came to cite the dataset had nowhere to read the rest of it.

- **Both doors in the store row are dashed.** The dashed border is the row's one cue that a tile asks
  for an address rather than opening a catalogue, and *Connect to a UCSC hub* — the door a reader is
  most likely to arrive at holding a URL — did not have it.

- **A shipped store that has not been generated says so, however the host answers.** A fork whose
  Stores workflow has not run got the 404 wording from one host and, from a dev server or any host
  that serves a page for a missing file, a red three-line diagnosis about JSON and sign-in walls
  instead. A store file at an address you typed still names the address, because there it is the one
  thing you can act on.

- **The interface has one grammar, and SPECS.md §26 states it.** A deep audit of every reader-facing
  surface found the same kinds of drift in twenty places at once — not bugs in any one panel, but
  disagreements *between* panels, which is the one class of defect no reviewer of one file can catch.
  Six locus boxes asked for the same thing in five phrasings; five different looks said "this is on";
  bytes were spelled three ways; the two views of one genome disagreed about whether a coordinate is
  0-based. §26 is now the contract for what the surfaces share — coordinates, units, toggles, words,
  colour, shapes — and this release brings the shared machinery into line with it.

- **Coordinates a reader sees are 1-based inclusive everywhere, and a locus box accepts what it
  shows (§26.1).** `formatPosition`, `regionLabel`, `windowLabel` and `typedLocusToRegion` join
  `formatLocus` in `genome/assembly.ts` as the only place a coordinate is formatted or read, and the
  round trip is a test: pressing Enter on the value a box is already showing cannot move the view by
  a base. What is typed now also takes the spellings other browsers write — an en dash, Ensembl's
  `..`, `kb` and `Mb` — because a reader arrives by pasting.

  That includes the 1D browser's box and the tables', two of which said in so many words that
  coordinates were *0-based and half-open, as in cooler*; the region in a link is unchanged, so a
  shared view still means what it meant.

- **A locus on the command line is 1-based and inclusive, as every box in the app reads one (§26.1,
  §23.1).** `chromosomix --window`, every locus a task takes (`--anchor`, `--region`, `--locus`)
  and a locus a workspace recorded that `replay` runs again are read as the display form and every
  spelling of it, digits grouped or not — `--window IV:1,000,001-1,400,000` — and the console and
  *copy CLI command* write `--window` that way, so a line copied out of the console names the window
  the breadcrumb did. They were read as cooler reads them, 0-based and as written, and the console
  wrote its windows in that grammar to match: right in a shell, and a base away from every other
  locus on the screen. **This changes what an existing script means.** A script's
  `--window IV:1000000-1400000`, written for the old reading, now starts one base earlier, at the
  base `IV:1,000,000` names — on a bin edge, one bin earlier; add one to its start to keep the old
  window, and the same goes for a locus flag. The framing line a run records prints its window in the
  display form, `--help` says how loci are read, and `--origin` was 1-based already.

- **Bookmarks, the genome view's locus box and the analysis form's locus boxes read and print
  coordinates 1-based (§8.10, §5.2, §18.2).** The Bookmarks card printed a saved place 0-based and
  read what was typed the same way, so a bookmark of the window on screen read a base earlier than
  the breadcrumb it was saved under, and a locus pasted from IGV was saved a base to the right; it
  prints the display form now, reads the typed one, and a row's own text typed back is the place it
  holds. The genome view's box worded its offer itself, had no `go`, and handed what was typed to the
  region reader as written; it is every other locus box now. The analysis form's boxes — 4C's anchor,
  *Spatial tracks*' *distance to*, the two model tasks' sequences — were the one place in the app a
  locus was read as cooler's grammar, so their own seed from the framing and anything pasted into
  them named a window a base later than it said, and a pick off the map had to be shifted by a base
  to make up for it. They hold the typed form wherever a run is kept — the form, its provenance, the
  console's command, a workspace — and become cooler's grammar only where a job is handed to its
  runner; a pick is written `IV:1,000,001-1,010,000`, and a 4C lane and a model are named that way. A
  run saved before this whose anchor was picked off the map starts one base (on a bin edge, one bin)
  earlier when it is run again.

- **Every other coordinate a reader reads or types is 1-based and grouped as en-US too (§8.1,
  §26.1).** The Manual annotations card's rows and boxes printed and read a mark's stored number,
  0-based, and the map's *Copy coordinates* put it on the clipboard that way under menu rows that
  named the same cell 1-based; the whole-metagenome view's box read a contig's coordinates as
  written; and an APA's *Per anchor* table named an unnamed anchor by its 0-based start. The map's
  tooltip, a dragged box's ends, a read's mate, a gene's exons, a bead's tooltip in the 3D cell, the
  Chromosomes table's origin column and `fmt.pos` now group a coordinate with commas in every
  locale, where a German browser showed `1.162.001` beside a breadcrumb grouped with commas, and
  refused an origin typed the way its own box had just written one. A range that does not parse
  says how a locus is read, rather than calling it *cooler syntax*. A map's saved figure is named
  after the window its caption prints, `IV_1000001-1400000-<stamp>.pdf`, where it was named after
  the link's 0-based string, a base off the caption inside it; and a file named after a locus drops
  the grouping rather than turning each comma into an underscore (`ui/export.ts`).

- **An analysis table prints a start 1-based and saves it 0-based (§18.7).** FRiP's and Group
  signal's *Per feature*, chromosight's patterns and the dot plot's streaks printed their starts
  0-based, the one place a coordinate on screen still did; Peaks' row per peak held its start and
  summit 1-based, so the TSV saved from it, which this app reads as BED's (§8.3), put every peak a
  base to the right when it was dropped back on a map. Each now holds the start as its TSV does and
  prints it 1-based, every start and end in them is grouped as en-US where some printed ungrouped
  and some in the reader's locale, the filter finds the base printed, and the TSV's columns line
  marks the column `(0-based)`. A Peaks TSV saved before this has 1-based starts.

- **Every export asks where to save, in a dialog opened in Downloads (§26.6).** Figures, decks,
  structures, bigWigs, bedGraphs, tables, marks, the console's script, a workspace and an `.mcool`
  used to land straight in the browser's downloads folder under the app's name; the platform's *Save
  as* now opens first, in Downloads with that name ready to change, and the card says the name it was
  saved under. The dialog opens before the file is made, so a long export (an `.mcool`, a genome's
  bigWig) still gets one, and a cancel skips the work. Browsers without the dialog (Firefox, Safari)
  keep the plain download.

- **Metadata annotations sits under Manual annotations, and it and Bookmarks start folded (§8.1).**
  The Annotations column reads Contact maps, Tracks, Structures, Manual annotations, Metadata
  annotations, Bookmarks; the last two are headings until pressed. Saving a view from the button
  beside `go` opens the Bookmarks card, so the row it adds is seen.

- **The caption under a saved figure is quieter (§7.2).** The region was written at 15 px and
  semibold in the page's ink, the largest type on the figure; it is now 11 px, and the provenance
  under it 10 px, both in the axis labels' grey. The 1D browser's one-line caption matches.

- **One spelling of every quantity, reachable from a worker (§26.2).** `src/units.ts` holds it, and
  the four duplicate byte-and-duration formatters that had grown in the console, the pairs dialog,
  the lane labels and the annotations worker are gone. **Byte counts are now decimal**, in thousands:
  the 18.1 MB file your browser is downloading is called `18.1 MB` here too, where it used to read
  `17.3 MB`.

- **A toggle that is off is no longer greyed (§26.3).** Dimming is how this app draws a control you
  *cannot* use, so an eye, a lock or a panel fold that dimmed itself when off was saying "unavailable"
  in the one vocabulary a reader had already learned. Off is now drawn plain and on is lit, one rule
  in the stylesheet draws every toggle in the application from the ARIA state it already carried, and
  a test refuses a second look. Two toggles in the 3D panel that were lit nowhere at all now light.

- **A price is no longer red.** The cost beside a scan was drawn in the refusal colour, which in this
  app means "this did not happen". Cost is a fact about what is being offered, and reads as one.

- **Menus, toasts, tooltips, the modal, the feature card and the console carry the theme's shadow.**
  Ten floating surfaces each wrote their own ink-black `box-shadow`, none of which changed with the
  theme — so on the dark theme they sat flat against the page with a 1 px border to lift them.

- **The shortcuts dialog and the command palette are two printings of one registry.** Same group
  order, same greying of what cannot act, and the gesture tables print *your* platform's modifier
  instead of `⌥ / Alt` for you to choose from — which is also how they were able to disagree about
  the one gesture that genuinely differs between platforms. The palette no longer offers to open the
  palette. A toggle command — an overlay, a panel's fold, a structure setting — is titled by its
  noun in the palette, the shortcuts dialog and the 3D cell, and wears its state as a chip, rather
  than being named for an outcome the eye reads as a state.

- **Small-print captions and the borders you have to see now meet contrast.** `--text-faint` on white
  was 4.19:1 under an 11.5 px caption, and `--border-strong` — the dashed drop target, a `kbd`'s edge,
  a tick on a scale — was 1.94:1 against a 3:1 bar.

- **The About dialog is titled *About this viewer*, and says what this viewer opens.** The title was
  the brand, which the dialog's own style shouts in capitals — *(META)COOLER* — where the mark is
  written *(meta)cooler* everywhere else; and its first sentence spoke only of contact maps, while
  the contract says About is where a reader holding a bigWig and no map is told the application is
  for them too. It now names the tracks, genomes and 3D models, with or without a map (§24.2).

- **The keyboard sheet fits its content.** The key groups flow into columns instead of each taking a
  grid row, so App's two rows no longer sit beside File's seven with a hand's width of nothing under
  them, and the dialog is wide enough for three columns — which is what kept the two gesture tables,
  the part a reader new to a genome browser needs most, from starting exactly at the bottom edge.

  A command row is three columns — key, thing and state — so a title stays on one line and the state
  chips stand in a column of their own.

- **In the command palette, a key sits on its command's line and a description on its own.** The
  badge was centred against the whole row, so `Ctrl+S` was level with the second line of its
  paragraph and `F2` half way down a seven-line one; and a short description sat beside its title
  while a long one dropped beneath, which gave one list two row shapes. Typing a word you can see on
  screen now finds the command that carries it: *folder* ranks *Connect a local or remote folder*
  first rather than *Fold or show the General panel*, and *fold* no longer matches *Copy this plot to
  the clipboard* through the F of FILE.

- **The console's *output* box is a *provenance* toggle.** Beside a column of commands, *output*
  named the one thing it does not show — what the runs produced — and its meaning was a four-line
  tooltip; it is now called what it prints, and drawn as a toggle rather than a ticked box (§23.3).
  *copy*, *save* and *clear* are bordered buttons like everything else in a bar: three borderless
  words beside a panel's title read as headings, and *clear* is the one of them that destroys
  something.

- **A corner note no longer covers the status bar.** The note that says a link was copied was
  anchored to the window's own bottom-right, which is where the memory figure a reader watches
  during a large open lives. Its progress note opens on *starting…*, the one spelling of that state
  (§26.7), where it wrote *Starting…* beside two views writing the other.

- **The share dialog answers in the dialog.** It copied the link the moment it opened and said so in
  a corner note nine hundred pixels away, in different words from the ones its own copy button
  produces; both now write one sentence under the box.

- **In dark mode the invited button in a dialog is legible.** *add*, *build the map*, *connect this
  folder* and the store drawer's count pill set white text on the dark theme's pale accent, which is
  2.59:1; they take the `--on-accent` token, at 7.1:1.

- **Button labels are lowercase in the dialogs too** — *add*, *build the map*, *restore*, *dismiss*,
  *forget everything*, *zoom to it*, *additional settings* — which is how every other button in the
  application spells itself (§26.4).

- **No Markdown reaches an error screen.** A dozen lines of advice carried backticks into the DOM,
  so a screen explaining that a file is broken printed them and looked broken itself; the commands
  are named bare, as the gate over a .scool already named them. The advice on an unexpected failure
  points *up* at the message it is about rather than down at the buttons, and the line that sent a
  reader to *the file info panel* names Binning QC in the General column, which is what the screen
  calls it.

- **Less prose in front of a one-number form.** The *add a resolution* dialog bracketed its box with
  two paragraphs, one of them about `cooler zoomify --balance`; the caveat §3.4 requires is one
  sentence, and the arithmetic is already on the verdict line under the box. The console's empty
  panel, the share dialog's opening sentence (which had no verb) and the Connect dialog's privacy
  note are each shorter by a clause that was arguing rather than saying.

- **Binning QC and the stored metadata are cards, and the metadata no longer changes shape with the
  file.** Binning QC was a bare heading — argued once as "plain, like Reads and Validation", both of
  which have since moved to the status bar — and the stored metadata was an uppercase iconed heading
  when a file held none and a small `▶ Metadata` disclosure when it held some, so its *absence* was
  announced more loudly than its presence and a reader switching between two files watched that
  strip change its typography rather than fill and empty. Both are cards now, headed and folded like
  every other block in every column (§26.6), with the JSON folded away by default.

- **A long value in the Genome card wraps instead of being cut off.** The card was meant to scroll
  sideways; what a reader actually saw was `http://127.0.0.1:5` and `inferred from the feat` chopped
  at the card's edge with no ellipsis and no scrollbar drawn, which reads as a rendering fault
  rather than as a long path.

- **The Genome minimap and the locus bar name the same window.** The strip wrote the 0-based
  half-open range it thinks in, so the same window appeared twice on one screen with starts a base
  apart — under a tooltip insisting they were the same numbers. It writes the display form now, and
  its note is the gesture alone: the sequence count and the assembly's length are the first two rows
  of the card directly above it.

- **The marks you draw leave through the same export row as everything else**, minus the resolution
  and the clipboard, because a BED is not a picture. Its options are named for the marks they write —
  *arrowheads & rectangles (BEDPE)*, which is what the sub-heads above them say, rather than *loops &
  boxes*, which named the loops track two cards up.

- **The row that says which axis is which can be read.** The Arrowheads and Rectangles boxes put the
  axis in brackets after a full locus — `I:340000 (columns)` — and in half a 288-pixel column the
  brackets were the part that got cut, so the one word telling a reader which box was rows and which
  was columns was the one word they could not see. It goes in front now: `columns I:340,000`.

  Each axis box is as wide as the example it offers and takes a line of its own rather than half of
  one.

- **One word for one thing, in the left column.** A track is a *track* in the Tracks card's tooltips
  rather than an *annotation*; the empty autoscale group is *no group* in a row as well as in the
  batch bar; the card-wide fader is *opacity* from 10 to 100, as the per-row slider has always been,
  instead of *transparency* from 0 to 90 — which had a reader subtracting to check that two controls
  over one value agreed. Every track row counts *sequences*, the word the FASTA row, the Sequences
  card and the minimap use, rather than *contigs* over a file whose breadcrumb says Chromosomes.

  Its box keeps room for `100`, and it sits beside *text size* where the column has room for both
  and stacks where it has not.

- **The three drop zones in the Annotations column say the same thing in the same shape.** Each names
  its formats and then says *Drop one here, or click to choose*: the Tracks zone said neither that
  nor six of the formats it reads, so a reader holding a bedGraph or a 2bit was told this viewer would
  not take it, and the Structures zone said four things where its neighbours said one.

- **Smaller wording.** The Sequences card says `4 of 16 ticked · show the whole genome`, since
  *showing 4 of 16* under a list of nine visible rows is read as a count of the rows. A model's
  provenance line no longer reads `balanced · balanced`. The Metadata annotations card explains the
  level rule only where the level actually refuses a column. The lane's autoscale glyph carries one
  clause instead of a two-sentence lesson in a gesture said twice elsewhere.

- **The map's heading and its locus box print the locus a reader reads (§5.4).** They showed the
  region string the state carries — `IV:1000000-1400000` — directly above a summary line reading
  `IV:1,000,001-1,399,500`, so one screen named one window at two starts a base apart and copying a
  coordinate from the line into the box moved the picture by a base. Both now print
  `IV:1,000,001-1,400,000`, as the 1D browser's box and the tracks cell's already did, and the box
  converts what you type on the way in — so pressing Enter on what it is showing changes nothing, and
  a locus pasted from IGV, UCSC or a methods section lands on the bases it names. The box also asks
  for what it takes in the one phrasing every locus box uses, and carries its own `go`.

- **The readout under the pointer on a map is 1-based, like everything else (§8.9).** Hovering a bin
  said `IV:1,162,000` while a drag from the same pixel said `1,162,001`, which is the app disagreeing
  with itself by a base on the one number a reader writes down. The parts of that line are joined by
  ` · `, as the 1D browser's are in the same slot; three spaces read as a separator on a wide window
  and as nothing at all on a narrow one. The right-click menu's coordinates carry their thousands
  separators, and its second item is an **arrowhead** — the word the card that keeps it uses, where
  *Loop* sent a reader looking under a heading called Arrowheads.

- **The Map, Tracks and Export cards arrive with the picture (§16.5).** Behind the whole-genome gate
  they used to stand over an empty canvas, clip and all, so a reader nudged a clip, pressed the turn,
  saw nothing happen and concluded the card was broken. The **overlays** row now holds only the marks
  that light: the refit is an action, and as the one unlit mark in a row of seven lit ones it read as
  an overlay that was off — pressed, it threw the reader's pan away. The crosshair and the hover card,
  which are about both pictures, are offered once per column rather than in both rows lit together.

- **The map's PDF says it is vector, and asks for no resolution (§7.2).** The browser's option has
  always read `PDF (vector)`; the map's read `PDF`, and a biologist who saved one for a figure and
  opened it in Illustrator expecting paths had been told which they were getting by one card and
  nothing at all by the other. It is the same kind of page: the cells one lossless image, and every
  axis, lane, key and caption round them paths and text. So the resolution goes while PDF is chosen,
  as it does beside the browser — the copy's tooltip naming the one its PNG takes — and the PDF's file
  name stops carrying a `-300dpi` it never had.

- **The deck's PDF is a drawing (§16.5).** Each cell is drawn on the page as its own PDF draws it —
  a map's cells the one image of that map, its axes, lanes, key and caption round them paths and
  text; the tracks, the browser as lead and a 3D model paths and text throughout — laid out by the
  one composition the PNG is, so the two files cannot disagree about where a cell stands. It was the
  300 dpi PNG on a page: six panels' axes and track names as pixels, in the one file meant to be
  restyled. Its name no longer carries a resolution.

- **A 3D model's PDF is paths, the tube included (§25.7).** The tube — the representation a model
  opens in — left as the raster the GPU drew, on the argument that a lit surface is no path, so most
  models were a picture of pixels in the one file meant to be a drawing. It is now a stroke per bead
  along the GPU's own curve, a darker rim under a lighter core, and the page holds what the PNG does,
  from the same numbers: a gap's dashes whatever the model is drawn as, the centre of rotation, the
  ruler's ticks, the depth slab, the fog and the cell's own colours. The words on the model are one
  function for both files, so the PNG gains the ruler's labels, the bookmarks and the measurements'
  distances the cell shows, and the PDF's distances are in the file's units rather than the model's
  normalised ones. The format reads `PDF (vector)`, and the resolution goes while it is chosen.

- **A chart's colour bar keeps its ramp in a saved figure (§18.13).** The replay that writes a chart
  into a PDF or a PNG flattened every gradient to its middle stop, and a matrix chart's continuous
  colour bar is one: every exported pileup, saddle plot and cis/trans square had a key of one orange
  rectangle beside a picture in a hundred colours. A linear gradient is drawn as a hundred bands of
  its own colours now, clipped to the shape it fills.

- **The dark theme reaches the landing page, the tables and the gates (§16.5).** A contact map is a
  figure and stays light whatever the screen is, which is why the centre column pinned the light
  palette — but *every* view is mounted in that column, so a reader who chose dark got the page they
  open every session, the Genomes and Chromosomes tables they scroll, the whole-genome gate and the
  error view as a white sheet inside a dark frame, with a dark About dialog floating over it. The pin
  now follows the picture: a map, a browser stage or a deck's grid keeps it, and a drop zone and a
  table of chromosome lengths do not.

- **The theme button changes the page on the first press.** The cycle was `system → light → dark`,
  so on a light machine — which is most of them — the first press selected *light*, repainted
  nothing, and left a sun icon that read as a claim the page was already light. It now goes to the
  opposite of what the machine is doing first, the same as the machine second, and back to following
  it third; the one silent step is the last one, where the monitor icon coming back says what
  happened. A screen reader hears the state, which it never did: the button's accessible name was the
  constant "colour theme".

- **The reader's word for a tab is *tab*, everywhere (§5.6).** The strip said *New session*, the
  palette said *Close this session* over a hint that said "tab", and the Share dialog was headed
  *Share this session* over a body that said "everything in this tab". Three words for the thing in
  front of you, of which two are never shown anywhere else. *Workspace* survives as the every-tab
  file, said as *Save every tab as a file*.

  That includes a store row's two verbs, the selection tray's and the Files panel's; IGV's own noun
  stays IGV's — *IGV published no session for this genome*.

  *add a cell…* no longer offers "the session's 3D structure".

- **The 1D genome browser has a breadcrumb (§5.5, §5.8).** `genome › Whole genome › IV ›
  1,000,001-1,400,000`, in the slot the map's trail uses — so the row no longer appears and vanishes
  as the map's eye is pressed, and "up" from a chromosome is one click in both views. On a map the
  last crumb is now the window alone under the sequence's own crumb, instead of repeating the
  sequence name in a row that already had it and above a heading and a box printing the same string.

- **The brand no longer empties the tab you press it from.** *chromosomix* is the way home and reads
  as one, and it called the picker over the open session: the file let go of, the annotation worker
  stopped, a two-map deck and a comparison destroyed, with no confirmation and — for a dropped local
  file — no way back (§11, §21.3). It opens the picker in a **new tab**; a tab that is already empty
  goes straight there, since an empty tab is the picker.

- **The status bar's numbers are the tab you are looking at.** Switching tabs never refreshed it, so
  a new empty tab showed the previous file's `READ 24.2 MB` under a landing page. The two items that
  are about a file — the byte counter and the validation check — are now **absent** while no file is
  open, rather than a dash that never fills in and a button that silently does nothing; validation
  says *never run* (§26.7) and the offer to scan every pixel is in the panel that opens on hover
  instead of in a second tooltip behind it.

- **One bin size, one spelling.** The crumb said `1 kb` while the map's title said `1.0 kb`, the File
  card said `1,000 bp`, the whole-genome gate said "cells of about 3.0 kb" and a structure row said
  `1 kb` two lines above `1.0 kb bins`. Every bin size now goes through `resolutionLabel`, and
  `fmt.bp`'s decimal stays where it belongs — on a measured span. The two hand-rolled byte
  formatters left in the metagenome download refusal and the dense-array refusal — one of them
  counting in 1024s under an `MB` label — are `fmt.bytes` like everything else.

- **A palette hint is one line, and it is not a footnote.** *Rename this tab* ran to five lines with
  the file name in Markdown backticks that nothing renders, *Save this workspace* pointed at "the
  link button beside it" — a header button that is beside nothing in that list — and six hints cited
  section numbers of a document the app never links. The fold hints also explained the wrong refusal:
  *Fold or show the Annotations panel* said "a metacool carries no annotations" on an empty landing
  page, and said it again, undimmed, on a `.cool` whose Annotations column was on screen. Each hint
  is now computed from the state it is about.

- **The zoom steps stop at a circle's ends, as at a line's (§5.4, §8.15).** Pressed outward near the
  end of a declared circle they wrapped past the origin — one press from `chr:10,001-30,000` came
  back as `chr:2,990,001-50,000`, the picture split at the junction — which made them a third way
  across the origin beside `ori` and a window typed across it, and the one a reader took without
  asking. They slide the window in at the end as on a line; a window already across the origin still
  widens and narrows about its own middle.

- **A sideways scroll slides along the diagonal on every cis block (§7.2).** A block of two
  stretches of one chromosome — what an Option-drag off the diagonal opens — slid its columns alone,
  as a trans block does, so a band one distance from the diagonal walked out from under the pointer.
  Rows and columns move together wherever both axes are one sequence, which keeps that band where it
  is; trans blocks, pictures above bin level and turned maps slide as they did.

- **Refinement is a palette command, and the palette now says so (§2).** The hint sent a reader to
  "the first button on a map's picture row", where they found the turn and turned their map instead:
  the button was pulled a release ago, because the preference is one setting for the whole window.

- **"Not this time" is gone.** A refusal dialog now names its subject in the title — *Nothing to
  share*, *Nothing to save*, *Too many tabs* — and is answered before the paragraph under it has been
  read.

- **SPECS.md, the glossary and the README say what the code does.** Every section of the
  specification was read against the source it governs and corrected where the code had moved on —
  defaults, labels, keys, refusals, cross-references, and what is built and what is not — and
  GLOSSARY.md gained the words this release brought: *circular*, *origin* and *arms*, *drawn to a
  total*, *eye* and *grip*, *ideogram*, *splice junction*, *the stage*, *the console* and more. The
  README lists the command line's thirty-one tasks as `chromosomix tasks` prints them, the stores
  this build ships, and the desktop builds a release attaches.

- **The unassigned statistic states both of its numbers whole.** It read `unassigned: 12,818 contigs /
  9.3% of bins` — a count of one thing beside a percentage of another — and then a paragraph under it
  gave the other half of each, so a metagenomics reader assembled either quantity from two sentences
  in two units. One line now: `unassigned: 12,818 contigs (62.3%) · 17,178 bins (9.3%)`, with one
  clause under it saying what it is.

- **The File card no longer counts a genome the table under it does not list.** It said `genomes 49`
  a hand's width above a genomes table reading `48 rows`, because `__unbinned__` occupies a genome
  index and is not a genome (§7.4). The QC line is the one place it is counted.

- **A column of numbers has one decimal count.** The Genomes table printed `0.99`, `1`, `1.1`, `1.07`
  down one column of quality scores, so the figures did not stand under one another and `1` read as a
  different kind of value from `0.99`. Each numeric column is measured once and every cell in it
  prints to the same width.

### Removed

- **Match depth, on a map with a second file under the diagonal (§5.7).** The switch scaled the
  second file's counts so its 99th percentile met the first's: it matched the picture, and left the
  number under the pointer and every task at each file's own depth. The chevrons after the
  breadcrumb's *contacts* box match the files themselves (§6.5). A ratio or a difference of raw
  counts, which the switch was on for by default, is now of the counts as drawn: across two depths,
  draw both files to one total first. Sessions that stored the switch open without it.

- **Panning round a circular chromosome (§8.15).** A pan past the end of a declared circle no
  longer reads its way round to the beginning: it stops at the sequence's end, as on a line — and
  so does a zoom step pressed outward near an end, which wrapped past the origin (§5.4). `ori` is
  the way across the origin — it frames the whole circle with the origin in the middle — and that
  frame, or a window typed across the origin, is zoomed and refined inside but not slid past. The
  slide read a block per stretch of drag with the map frozen while each landed, and left no edge
  to tell how far round the reader had come.

- **The *size by* setting (§25.3).** A track whose value at each bead set the bead's size, as a
  second channel beside the colour. The channel is gone with the control: every bead is the bead
  radius.

- **The contact chords, and their threshold (§25.5).** The map's row through a pinned bead was drawn
  as cylinders from it to every bead above a threshold, under a *pin contacts* toggle. *Colour by
  contacts with pinned bin* says the same thing in the representation the model is already in, and a
  cage of coloured cylinders over a globule was a second answer to a question the first had
  answered. The colouring stays.

- **The accent bar down a shown Structures row (§25.3, §26.3).** The lit eye already says which
  models are drawn, and a second way of saying it in the row's left gutter is a second look for one
  state.

- **The companion's corner menu (§16.5).** The button in a companion's bottom-left corner and the
  menu of score, transform, ramp and clip it opened are gone: the map's *Map* card, shown in the
  Aesthetics column while it is starred, holds those and the rest.

- **`Ctrl+W` / `⌘W` no longer closes a tab.** It is the browser's chord for closing the window, and a
  reader who missed by one key lost the session rather than a tab. The command stays in the palette.

- **The About dialog no longer ends with a sentence about a list it does not have.** A site that
  publishes no build manifest drew *This deployment does not publish a list of past builds.* under a
  picker that was not there; the row takes itself away instead. A pinned build keeps its note, where
  the missing list is a reader stranded in an old commit and the button beside it is the way back.

- **One sentence of advice on an unknown locus is gone.** *Genome and contig namespaces can collide;
  when they do, the genome wins* describes the parser rather than the reader's situation, and a name
  that collides never reaches that refusal.

### Fixed

- **A box is washed over the tracks beside a map, as it is in the 1D browser (§8.1).** A stretch
  highlighted in the browser — a rectangle drawn on the tracks — showed there as a wash over every
  track and on the map as the square on its diagonal, but beside the map it turned into two small
  arrowheads under the tracks. The tracks beside a map now carry the same wash, over every lane of
  every stack, both stretches of a box off the diagonal, and in the saved figure; the arrowheads under
  the tracks are a loop's alone, and a right-click anywhere inside a wash offers to hide its box.

- **Every task measures a resolution you added, as the map draws it (§3.4, §18.4).** With the map at
  `3 kb*` — the file's 1 kb bins summed three at a time — a task still read the 1 kb rung underneath,
  so an insulation track or a P(s) came out at 1 kb under a picture at 3. The analysis worker now
  reads the map summed to the resolution on screen: counts exactly, as the rung the file would store
  (a 1 kb rung summed to 4 kb reads as the file's own 4 kb, pixel for pixel), and weights by the
  harmonic mean of the bins' weights. The drawer says `3 kb* bins`, a result goes out of date when you
  step off the resolution, and the console's command carries `--coarsen 3000`, which `chromosomix`
  now takes too.

- **Every export is on white in the dark theme too (§7.2, §16.5).** A map's PNG and PDF, a deck's,
  a copied map, lane or track, and the box behind an exported key were laid on the page's own colour,
  so in the dark theme they came out on near-black under ink chosen for white; and a task's figure
  enlarged into the stage dialog, which follows the theme, exported dark from there. Every picture
  that leaves the app is now laid on white and redrawn in the light palette's ink, wherever the figure
  was mounted when the button was pressed.

- **Split after a ratio is drawn on the counts' own scale again (§7.5).** A ratio takes the
  transform, the ramp and the clip — `log2` and the diverging ramp — and was to give them back when
  switched off, but a change of comparison rebuilds the map, and the panel that would have given them
  back was the one torn down: the split after a ratio stayed on `log2` and blue to red, and so did a
  map whose second triangle was hidden under a ratio. What a derivation took over is now carried to
  the map built in its place, so ratio → split and ratio → difference → split end on the scale before
  the ratio, `log10` and the default ramp on a balanced cooler; a ratio reached by a link, a reload or
  Back gives back the file's defaults. Closing the first file of a comparison and *swap sides* carry
  the scale from before the ratio too.

- **APA's track aggregates stay unticked once unticked (§18.2, §18.8).** With every track unticked,
  the next run ticked the starred one back on: the drawer hands the form its context around a run, and
  an empty list read as one nobody had answered. A list nobody has touched still opens on the starred
  track; one the reader emptied is kept empty.

- **Track correlation's windows are their exact means, and a mammalian genome at 100 bp fits in
  memory (§18.8).** A window's value was taken from whatever zoom level its size selected for
  drawing, and each record weighted by its whole width rather than by how much of the window it
  covers: a 17 kb record laid whole over a 10 kb window. On 4DN's two mouse ATAC-seq replicates at
  10 kb that gave r = 0.808 where the windows' own means give 0.884. Every track is now read at its
  own resolution, a megabase at a time, and each record weighted by its overlap — pyBigWig's
  `stats(…, exact=True)` — so the two replicates read 0.884, and on chr19 they and a Hi-C insulation
  score agree with pyBigWig's exact means and SciPy to 5 × 10⁻⁷ at 100 bp, 1 kb and 10 kb, by both
  methods. A window was also an object each and a sequence one request: a single 61 Mb chromosome
  at 100 bp was killed for memory, and the whole mouse genome at 100 bp now takes three minutes and
  2.3 GB.

- **An aggregate peak analysis is now coolpuppy's pileup wherever a window reaches the diagonal,
  and its observed / expected normalisation is coolpuppy's (§18.8).** A loop window that crossed the
  diagonal took the cells below it from the map read whole — contacts it already held above,
  mirrored — where coolpuppy cuts from the upper triangle and leaves them out: on 4DN's mouse Hi-C at
  10 kb, with chromosight's 2,515 loops, the two pileups were up to ten per cent apart in the cells
  nearest the diagonal. Those cells are left out now, and so are the main diagonal and the one beside
  it, as coolpuppy leaves them out by default — *diagonals left out*, a new setting, 2 to begin with
  and 0 for every diagonal. A pileup on the diagonal keeps its whole window but for those diagonals,
  which is coolpuppy's local pileup, and its P2LL — whose centre there is mostly the diagonal — falls
  with them: from 60 to 15 over the yeast demo's ATAC peaks. Observed / expected was wrong off the
  diagonal: it divided the finished pileup by an expected looked up at each cell's distance from the
  pileup's centre, taken from the windows' own cells, and put the centre of that loop set at 0.2
  where coolpuppy puts it at 2.9. Each window is now divided, cell by cell, by its own sequence's
  expected at the cell's own diagonal — cooltools' `balanced.avg`, read as a band as deep as the
  farthest window — before the mean. That is the pileup's normalisation alone: the map's own O/E
  (§7.5) is computed as it was. Raw, over the expected and on the diagonal, every cell agrees
  with coolpuppy's to 5 × 10⁻⁶, the same cells left as gaps; a new golden, `apa_diagonal`, holds the
  task's own runner to it on the demo map's loops, the 55 of 200 that reach the diagonal included.

- **A track named to `chromosomix` is no longer read whole to learn what it is (§23.1).** Every file
  under `--tracks` was read into memory to look at its first four bytes before a bigWig or a `.2bit`
  was opened by range: a second a gigabyte before any run began, and a refusal for any file past
  2 GiB, Node's ceiling for one read. Four bytes are read now. A metaplot over a 957 MB ATAC-seq
  bigWig went from 15 s to 11, with the same numbers.

- **Signing in to Dropbox opens the Files column on it (§24.9).** The folder list hears about a
  bucket from the form that saves it and about a Drive folder from the pane that adds it, and
  nothing told it about a Dropbox sign-in — so the Files column, which exists only while a place is
  connected, never appeared: *browse my Dropbox* closed the dialog on the landing page with no error,
  and a sign-out from the dialog left a dead row behind. The sign-in and the sign-out are now passed
  on (`browse/dropbox.ts`). An expiry is not: the click that finds one says *sign in to Dropbox* in
  the column, and the column stays to show it. The first live sign-in, on chromosomix.app, found
  this.

- **Desktop: bigWig lanes draw (§15).** The bigWig reader fetches its own inflate wasm from a `data:`
  URL inside the annotations worker, and the desktop's policy, which reaches its workers, refused it —
  inside the worker, so nothing in the page said so — and every bigWig lane stayed on *fetching…*.
  `connect-src` admits `data:`, which has no server behind it, and the site's policy stays its mirror.

- **A workspace, link, `?config=`, embed message or saved tab naming an unknown view or transform
  opens (§5.5, §5.6, §21.1).** The address was read by an allow-list and everything else was not: a
  state arriving as an object — a workspace, a share link, a `?config=` file, an embed's `navigate`,
  the durable record of a tab — was cast as it came, so `view: 'banana'` sat on *Opening…* for ever
  and `transform: 'banana'` threw on the first paint. Every one of them is now read by the hash's own
  reader, which keeps what it knows and drops the rest; the twelve demo workspaces restore key for
  key.

- **Desktop: a chart's tooltip is styled (§15, §18.13).** The desktop's policy refused the chart
  library's `style=` markup on every hover — seven hundred refusals over one P(s) — and left a box of
  bare text with its colour swatches gone.

- **A `.hic` block larger than the block cache is handed back and not kept (§3.6).** The eviction
  skipped the block just stored, so one oversize block stayed over the 48 MiB budget until the next
  was decoded.

- **A read stored without its bases (`*`) shows no mismatches it does not have (§8.13).** The
  mismatch walk compared the bytes after an empty sequence — its tags — with the reference as though
  they were bases; it now walks an aligned operation only as far as the read has bases.

- **`chromosomix` reads its command line by what each command takes (§23.1).** A flag took the word
  after it as its value unless that word began with `--`, so `coverage a.cool --no-balance b.hic`
  ran over `a.cool` alone with exit 0, `coverage --quiet a.cool` refused itself for want of a file,
  and `--out --quiet` wrote into a directory called `true`. A task's on-or-off parameters and the
  command's own `--quiet`, `--no-balance` and `--help` take nothing after them now — `--stranded=false`
  or `--no-stranded` turns one off — a flag that takes a value is refused without one, and a flag a
  command does not take is refused for `replay` and `circular` as for a task. `--stranded false`, the
  old way to turn one off, is refused with what to write instead. `replay` reads the files after the
  workspace as it reads those after `--over`, so `--over data/*.hic` replays every file rather than
  the first alone.

- **Every compartments line the console writes runs in a shell (§23.1).** `--contacts` is both the
  total a map is drawn to (§6.5) and Compartments' own choice of contacts, and the console writes
  both — `--contacts cis --contacts 10000000` — so the shell read `cis` as a total and refused the
  line. A word among the task's options is the task's and any other the total's, so both are read
  from one line, and a word that is neither is refused naming the two.

- **A value no form could hold is refused before any file is opened (§23.1).** `expected --quantity
  expectd` ran the density and wrote `# param quantity: expectd` above the table, `--factor=` ran at
  nought and `--rungs abc` built one rung. Choices are checked against the task's options, switches
  and numbers against what they can be, and what a replayed workspace recorded the same way — exit 2,
  with the values there are.

- **Each input of one command is written under a name of its own (§23.1).** `coverage
  HCT116.rep1.cool HCT116.rep2.cool` wrote `HCT116.coverage.*` twice, the second run's files over the
  first's, with exit 0. One input's outputs are named as they always were; two that would share a
  name keep more of theirs (`HCT116.rep1`), then their directories (`dirA_sample`), then a number,
  and nothing one command writes is written over by it.

- **A remote file is fetched first, as the README said (§23.1, §23.3).** An http or https address
  went to `stat` as a path. A map, an `--against`, a `--sequence` with its `.fai`, `--tracks`,
  `--features`, `--pairs`, a `.pairs` for P(s)'s orientations and a replayed workspace are downloaded
  whole into `$TMPDIR`, with their progress on stderr, and removed when the command ends; the
  framing, the provenance and the outputs' names are the address's. The console's note on a remote
  file says what the line costs rather than that a shell cannot read it.

- **A figure's PDF strokes what it fills (§7.2, §18.13).** The PDF page let go of a path at the first
  operator that painted it, where a canvas keeps it until `beginPath`, so a shape filled and then
  stroked printed as its fill and a stroke of nothing: every exported box plot lost its outline,
  whiskers and median, the reader's arrowheads came out as white halos with nothing inside, and a bar
  track's outline and the 1D browser's chips lost their borders. The page now keeps the path and
  writes it in front of every fill, stroke and clip, `fillRect` and `strokeRect` leave it alone, and
  each cell of a deck's figure starts on an empty one.

- **A place left before it was drawn is never drawn, and a colour changed while a region opened no
  longer leaves the previous view on screen (§5.5).** Every change of view starts a render nobody
  waits for, and two ran side by side whenever the reader was quicker than the file. A colour change
  arriving while a region still waited on its contigs table repainted the view being replaced and
  called itself mounted, and the region's own mount, overtaken, never drew — so the address named the
  region over the old picture. A second render of the same state, which a remount, a tab coming back
  and a closed comparison all start, ran to the end beside the first. Each render now calls off the
  one before it, which stops at its next step, and a repaint waits for the view it would paint to have
  finished mounting.

- **The golden job compares the reader with Python on every run, with or without metacooler.**
  It installed `metacooler` from PyPI, where there is no such package, and its fixture script
  defaulted to one cluster path, so it built no fixture on any run and reported green with a
  warning. Its public half now needs no credential:
  - the four published demo maps — a `.metacool` and an `.mmetacool` metacooler wrote, a yeast
    `.cool`, an E. coli `.mcool` — are fetched from the lab's bucket (`npm run fixtures:demo`) and
    read against oracles the public `cooler` package recorded (`npm run fixtures:demo-golden`,
    rebuilt on every run to prove it still reads them the same);
  - the `.scool`, HiC-Pro, `.pairs` and binary `.g3d` fixtures, which `cooler` and `g3dtools` alone
    can write, are built and their eight suites run.

  The full suite over `make_fixtures.py`'s output runs when the `METACOOLER_REPO_TOKEN` secret can
  read metacooler's repository, whose `tests/data` the script now finds through `--data`,
  `$METACOOLER_TEST_DATA` or a checkout beside this one. Every install, fetch and build step may
  still fail without failing the build, and the job's summary names what did not run. The demo maps
  also run in the always-on job, copied from `demo/`. The metacool goldens are rebuilt from
  metacooler's current `devel`, which records QC statistics the old ones did not.

- **The request budgets run on every push, and the one that had gone red is green (§12).** The
  fixture-free run excluded all of `test/budgets/`, though only `requests.test.ts` needs fixtures,
  and the BAM budget had been failing unseen since the annotations worker began reporting progress
  under the request's own id: the test took that report for the answer. HiC-Pro's suite, which no
  CI run had built the fixture for, still expected h5wasm's own words for a text file the open path
  now refuses by name (`not-hdf5`).

- **An archived build survives the site moving (§21).** Every build on the archive branch carries
  the base it was built for in each asset URL, so the day the site's base changes every one of them,
  the releases included, would be a blank page at its new address. The deploy now rewrites each
  archived build and preview whose base is not the site's, once (`scripts/archive-rebase.mjs`, its
  rules held by `test/unit/archive-base.test.ts`); on every other deploy it finds nothing to do.
  Run against the thirty builds and one preview on the branch today, it moved all of them to `/`, and
  each opened there with no failed request.

- **An area is shaded down to zero, not to the bottom of the axis (§18.13).** The mark *area*, and
  *fill under* on a line, filled every series down to the axis's lowest edge, so a profile dipping
  below zero was shaded from its peaks to the bottom of the picture and the parts below zero were
  lost in the fill. It now stops at zero, shading up to it where the line is below; on a log axis,
  which has no zero, it still fills to the axis's edge.
- **One end of a figure's window typed takes effect on its own (§18.13).** On an axis still fitting
  the data, `x from` or `to` waited for the other end, so a number typed into either sat in its box
  while the picture stayed on the whole of the data — and so did the second, since the window was
  still empty when it was typed. The end not typed is now the data's own on that side.
- **A tab with maps beside two or more 3D models keeps its maps when it is restored (§25.3).** The
  watch that opens a cell for every model that arrives began at the store's first change, which in a
  restore is the first row back, so every model after it opened a cell; publishing those cells wrote
  them over the maps the link was putting back, and a workspace tab of five maps and five models came
  back as five models. The models a restore brings back are now noted before the first of them lands.

- **Structure cells built together draw the models in the order the session lists them (§25.3).**
  Each cell of a deck rebuilt from a link fell to the first model, its neighbours not being in the
  deck yet, and the next change to the store moved each one along: the models came back a seat to the
  left, the first in the last cell.

- **A lane's *colour by* picker stays inside the card.** A select is as wide as its longest option,
  and a set whose rows carry a long column — insulation's domains name *weaker boundary prominence* —
  pushed the picker a few pixels past the Tracks card's edge.

- **A workspace opened from its address puts the first map where it was saved (§16.9).** A published
  figure or a `?config=` link whose deck had its first map moved, hidden or unchained opened with it
  back in the first cell, on screen and chained: resolving the workspace's names rebuilt the deck
  from its other fields and dropped the lead's. A dropped workspace file was not affected. The
  store's Hi-C, micro-C and PCP deck now reads in that order, micro-C second.

- **A workspace's tracks come back under the companions they were drawn under (§16.6).** Restoring
  the tracks wrote the session's lanes, none yet, over the record of where they were drawn before it
  was read, and a lane whose map opened before its track had been read was dropped: a deck with
  MNase under each of three maps opened with every companion bare and MNase on the first map only.

- **A table's scatter has an axes card (§18.13).** Its scales, windows and names, the columns'
  names (`number in Map`) as placeholders, so a time course's axes can say what they are.

- **A figure's window wider than its data is the window drawn (§18.13).** The chart's zoom clamped
  a window to what was drawn, so a range typed past the data — or a figure opened on another's
  ordinate — came out as the data's own; the axis is now stretched to the window on the side it
  reaches past. And an end of a window is labelled only when it is a round number, so a box drawn
  by hand no longer prints its edge, `8.00215`, over the tick beside it.

- **A table drawn as a chart keeps its mark and legend when its title or type size changes
  (§18.13).** An update in place handed the chart the table's own style, so its points became a
  line and a fitted line's legend moved to the side.

- **A figure's tick labels no longer print over each other (§18.13).** Only an axis of names was
  thinned; a distance axis spelled `300.0 kb`, `600.0 kb` ran each label into the next once the type
  size was raised for print.

- **A hidden series stays hidden with a figure's legend off (§18.13).** The chart hides a series
  through its legend's selection, and a legend switched off carried none, so every series hidden in
  the settings was drawn again, on screen and in the PNG and PDF.

- **A figure's PNG and PDF leave its hidden series out of the legend (§18.13).** On screen a hidden
  series keeps its greyed entry, the control that brings it back; an export carried that grey name
  beside no line.

- **The circularity check reads each sequence where the file puts it (§8.15).** It placed each
  sequence by `ceil(length / bin size)`, and a level that floors its sequences' last part-bins has
  one bin fewer for every sequence that does not end on a bin, so each sequence after the first was
  read a bin further out for each one before it. On the yeast and *M. pneumoniae* demo at 2 kb the
  mitochondrion was read five bins out, its tail and corner from the next sequence, and
  `chromosomix circular` failed on the file, its last sequence running past the end of the map.
  Seven of thirty-two maps tried have levels written that way. Each sequence is now read at the
  extent the reader gives it.

- **A linear chromosome read with few bins is no longer read as circular (§8.15).** A map opened
  at a coarse resolution was measured there, and with a few dozen bins a line's two ends are too
  near each other for the junction test: contacts flatten out across a chromosome's territory,
  and a yeast chromosome's telomeres are held together. The mouse progenitors map opened at
  2.56 Mb ticked chr9, chr11, chr12, chr15, chr19 and chrY, and the yeast demo `.hic` opened at
  16 kb its chromosome I, at 0.92. A sequence is now measured only where it has fifty bins at the
  rung read — over thirty-two maps no linear chromosome read with more was ticked — and a smaller
  circle read coarsely is left undecided, for the reader to tick: the yeast mitochondrion of the
  yeast and *M. pneumoniae* demo at its landing rung (43 bins at 2 kb), *E. coli* opened at
  100 kb, and in `chromosomix circular` at the zoo's 4 kb, a plasmid under 200 kb.

- **A linear chromosome is no longer read as circular on one stray read (§8.15).** The junction
  test took the median of three separations, and where the balancer had dropped an end it was the
  median of one: chrY of the demo store's mouse progenitors map, opened at 10 kb and measured at
  640 kb, scored 0.41 on a single read pair joining its first bin to the last one kept, beside an
  end with nothing on its own diagonal, and the map opened under *chrY reads as circular*. A
  separation now counts only where the junction has a cell and the diagonal has contacts at both
  ends, and a score needs two of the three; with fewer the sequence is left undecided, and
  `chromosomix circular` leaves its row empty. Over thirty-two maps the rule changes no
  bacterial chromosome's or plasmid's verdict at any rung.

- **A tab's note goes with its file (§5.6).** The bar under the tabs said what a tab had found out
  about its file and stayed until dismissed, so a link that moved a tab from the mouse map to a
  chicken `.hic` left *chrY reads as circular* over a genome with no chrY. A tab's note now goes
  when the tab opens another file, goes back to the picker or closes, and waits while another tab
  is in front; another resolution of the same file keeps it, and the window's own notes stay.

- **Both notebooks render again against this checkout's `chromosomix` command (§18.8, §18.10,
  §23.1).** The DBZ figures read the inter-arm table's log2 `score`, which has since become its
  *enrichment*, a fold, with *enrichment after detrend* beside it, and E1's share from a column
  cooltools' method now writes as *of contacts*; and they handed compartments `--contacts cis`,
  which a shell reads as the number of contacts to draw the map to, and refuses. Their check on the
  secondary diagonal is the task's reading again — each distance's mean, in log2, from the origin
  out to the reach — and lands on the table's two folds to the three decimals they are written to.
  The validation notebook took one from the peak list's starts and summits, which are written
  0-based now as yapc writes them, and read the BED's `#` line as a peak, so no region matched
  yapc's.

- **A bedMethyl lane names `e`, `g` and `b` as the SAM spec does (§8.20).** They were called 4mC,
  8oxoG and 4hmC; SAMtags §1.7 has them as 5fU, 5hmU and 5caU (8oxoG is `o`, and 4mC is ChEBI
  21839, with no letter). The lane now reads its names from the table a BAM's `MM` tag is read by, so
  the two never name one code two ways.

- **The 1D ruler keeps its end labels whole (§5.8).** Each tick label was centred on its tick, so
  one on a window's first or last base hung half off the strip: a deck's tracks cell over
  `IV:1,000,001-1,400,000` read `Mb` and `1.4`, and the browser over a whole sequence `bp`. The label
  is nudged back inside, as the heatmap's axis already nudged its own, and where that brings it
  against its neighbour the inner one is left out rather than written over.

- **The last lane on each edge of a map keeps its whole name (§8.8).** A name is written at the
  reader's text size across a lane of the height they gave it, and at the default size the 14-pixel
  peak lanes the yeast demo opens with are five pixels too thin for it: past the last lane that was
  the edge of the canvas, which cut the chip and the descenders off *Pol II peaks* and *ATAC peaks*
  on screen and in every PNG and PDF saved from the map. The stack now leaves room past its last
  lane for whatever the name reaches beyond it, and draws a loop's anchors past that room rather
  than into the name; a stack whose last lane holds its name, or that writes none, is unchanged.

- **A window inside one chromosome of a `.hic` reads its own blocks, not the chromosome's (§3.6).** An
  off-diagonal rectangle — a corner, two loci a chromosome apart — unioned its two axes into one span,
  so it read the whole square between them: six bins by six at a chromosome's corner was every block
  of that chromosome, 15 MB at 25 kb on a 4DN map. Each axis now keeps its own window, and the blocks
  below the diagonal are reached through their transpose as they always were.

- **A remote `.mcool` reads a chromosome in far fewer round trips (§6.1, §12).** HDF5 reads the pixel
  columns a chunk at a time, and each 1 MiB miss was its own request: 63 in a row for chr1 of a 5 GB
  file. A region read chunk after chunk now fetches ahead, up to 16 MiB, while scattered reads — an
  open, an index — still fetch only what they ask for: 34 requests, and the picture 15 s after landing
  where it was 24 s, measured through a slow proxy.

- **A first open no longer waits for the HDF5 runtime to load (§6.1).** The reader's worker, which
  compiles h5wasm the moment it exists, was only made once a file was opened; it is now made while
  the picker is on screen, and a 1 GB `.mcool` dropped on a fresh tab lands in 0.3 s where it took 3.2.

- **A whole chromosome of a laddered map is first drawn from the rung that is its picture's grid
  (§9, §12).** A window wider than the picture's cells was summed out of every pixel of the open
  rung — chr1 at 25 kb into a 50 kb picture — where the file stores the 50 kb rung. Its first read
  now comes from the rung that is that grid, the same cells from a quarter of the pixels, balanced
  at their own resolution, and a zoom still refines to the open rung: on a 1 GB `.hic` from S3
  (4DNFIYUR29KO), chr1 reads in 1.3 s where it took 4.3.

- **A whole-genome picture of a `.hic` reads a fiftieth of what it did (§3.6, §12).** The walk
  across its chromosome pairs read every pair's matrix record whole — the block index of every
  resolution — and pulled a megabyte around each kilobyte block. It now reads each record only as
  far as the rung it draws and each block as exactly its bytes, with four pairs in flight: on the 5
  GB 4DN map of mouse granule neurons (4DNFI916JQ1Y), 5.7 MiB where it was 289 MiB.

- **Two remote-file refusals stopped saying their own advice twice.** The byte-range and
  transit-compression errors each explained, in the pink diagnosis box, the two things the advice
  list directly underneath them was about to explain again in different words. The diagnosis keeps
  what only it knows — which host, which URL, what came back instead of a 206 — and the advice keeps
  the remedy, which now also names GEO and SRA.

- **Nine HTTP header names in the range-source's refusals were wrapped in backticks**, which reach a
  reader as backticks (§26.4). They are named in quotes, like every other literal the app mentions
  in prose.

- **A resolution the reader added is drawn like one the file stores.** It carried a dashed border
  whether or not it was current, so four added rungs were four outlined chips beside one stored rung
  with no outline at all, and each reserved fourteen pixels for a × that only appeared under the
  pointer. Now: no border until it is the rung being read, a dotted one where a stored rung's is
  solid, and a × at zero width that the hovered rung grows to hold, pushing the rungs after it along.
  The × also lost the bordered button box it had been wearing — `.btn` comes later in the stylesheet
  than the rule that had always asked for no border.

- **The map's bar names its window twice, not three times.** The region view printed the locus as its
  own heading, again in the summary line directly under it, and a third time in the box at the top
  right — `IV:1,000,001-1,400,000` three times on one bar, all the same string. The summary's own
  contribution is the *span*, which is the one thing the heading does not say, so that is what it
  prints. It drops the locus only where the heading says exactly the same thing: a genome pair, a
  `contig × contig` block and a multi-sequence frame each say something the heading cannot, and are
  printed whole.

- **Both whole-genome gates ask the same question with the same words and the same button.** One said
  `compute overview` — a word that appeared nowhere else — under a toolbar button reading *whole
  genome*, and priced the read in bytes while its sibling priced it in stored pixels. Both now state
  both figures, and a remote file past the scan limit is *warned about* on both, in the warning colour
  rather than the colour of a refusal, with the download offered under it.

- **The key stands down on a picture narrower than it is.** At three cells across, the lead of a deck
  — the map every other cell is compared against — had a 14 rem legend over a 175 px plot.

- **A workspace brings its circles, origins and added resolutions back in (§3.4, §8.15).** Saving one
  wrote all three and opening it dropped them: the tab reader walked past the fields, so an origin
  typed on the Chromosomes table, a circle unticked by the reader, a 10 kb rung added to a 4 kb file,
  and the declarations a store's published session makes, reached nobody — and the first open then
  measured its own circles over the author's.

- **A task reads a declared circle as a circle (§8.15).** The declarations reached the drawer's header
  and not the framing a run was given, so a sequence ticked on the Chromosomes table was measured as
  a line by every task run from the app — and by a track task run where no map is on screen, which
  read an origin at the first base as split between the two ends. The run's framing carries the
  circles and the origins now, including the one made over the tracks, and a cached result is reused
  only under the same declarations.

- **The inter-MAG network's *per bin pair* weighs an edge by the two MAGs' sizes (§18.8).** It fell
  through to the raw contacts, so choosing it changed nothing in the ranked table; it is now the
  contacts over the product of the two MAGs' bin counts. *Per coverage* is computed as it was — the
  contacts over the geometric mean of the two MAGs' intra-MAG contacts — and its hint, which said
  the product of their totals, now says that.

- **Cis and trans per sequence and Reproducibility refuse a run with nothing ticked (§18.2).** Both
  read an empty list as every sequence, so pressing **none** ran the whole file — the one thing
  nothing ticked must not become — and the note the cis/trans runner promised for it was never
  reached. The estimate refuses in the words every other task uses; a run that arrives with an empty
  list anyway says so before it reads a pixel or mounts a second map, and a ticked name the file has
  not got is named rather than dropped.

- **Roadmap's tile names WashU when the hub is not there (§24.2, §24.10).** A 404 or a page of HTML
  from VizHub was read as a shipped store not published yet, and the sentence sent a maintainer to
  run the Stores workflow, which has never written that file. It now says the hub is WashU's,
  published on its VizHub, the way the DNA Bacterial Zoo says what publishes it.

- **A share link carries the names of maps read from `gs://` (§16.10).** The map names kept their
  own copy of the test for which files a recipient can open, written before `gs:` joined it, so a
  link sent the map, its lanes and its companions and stripped the name the reader had given each.
  Every field of a link keyed on a file now asks the one test.

- **A bedMethyl opens clipped to 0–100 (§8.20).** It opened on the autoscale like any other track —
  a methylation lane drawn over whatever 12–94 % the window held — and the 0–100 the file reports
  only filled the limits boxes once the reader had left auto. A bedMethyl loaded now opens on 0–100
  under either name it arrives by; a restored one keeps the axis its reader gave it.

- **Opening a soft-masked `.2bit` no longer reads its mask blocks (§8.21).** Each record's header was
  fetched through to the end of its mask arrays, which the reader then steps over and never reads —
  chr1's eight megabytes of offsets on hg38, and tens of megabytes across the genome, on open. A
  header is read as far as the mask count and no further: one 8 KB read, or for a sequence whose
  gaps outrun it, a second just long enough for them.

- **A folder offers a `.barChart`, a `.bigBarChart` and a cytoBand named in the plural (§8.17, §8.22,
  §20.5).** The name router did not know the first two and matched only `cytoBand` and
  `cytoBandIdeo`, so the Files column drew all three dimmed — the yeast demo's own
  `Yeast_cytobands.txt` among them — while the loader read every one.

- **The IGV store publishes each genome's cytoBand (§24.3).** IGV names a genome's karyotype beside
  its sequence, and the generator dropped it as an ideogram this viewer does not draw, which stopped
  being true with §8.22. It is now a row filed under `cytoband` — the two IGV names `.bed` included
  — the first track on its genome's shelf, and an ideogram lane in its session. The generator's own
  description lists its five front ends, `dnazoo` among them, and no longer says the refgene tracks
  are skipped.

- **A model's bed3d from the Structures card says when it was made (§25.7).** The card's button wrote
  the model's name and framing and left the date off, where the drawer's button and `chromosomix`
  write the run's. It now asks the analysis workspace, which holds the run; a model loaded from a
  file was not made here and still carries no date.

- **The `chromosomix` command reads a genePred, an interact, a longrange, a GTF and a VCF as the app
  does (§8.18, §8.19, §23.1).** `--features` asked four of the loader's sniffers and read everything
  else as a BED: a genePred, a GTF and a VCF came out as no features at all, an interact as one box
  over both anchors or a bedpe of the wrong columns, a longrange as a BED4 whose names were its
  arcs. It now runs the loader's own sniffers and parsers in its order, and `--pairs` reads an
  interact or a longrange as well as a bedpe.

- **A plain Run on a map binned from a `.pairs` is no longer refused (§3.7, §18.3).** The analysis
  worker opens the map for itself, and a contact list opened without the grid the reader chose is
  refused with *choose a bin size* — which is what every task pressed on such a map said, P(s)
  included, because the target a plain Run builds carried the ticked cells and the drawn total but
  not the binning, nor the orientation curves the import had counted. *Run on all maps* built its
  targets elsewhere and carried both, so it worked, which made the failure look like one about the
  file.

- **P(s) by pair orientation has no notches and no gaps (§18.8).** All four curves fell by half
  together every 0.9 of a decade — at 200 bp, 1.6 kb, 12 kb, 98 kb and 730 kb on a *Lachancea
  kluyveri* library — because the drawing axis was built on its own at *log bins per step* over counts
  kept at 1.05: every twenty-second drawn bin held one counted bin and was divided by the width of
  two. Every drawn edge is now a counted edge and each point is divided by the width it covers, which
  is the correction the matrix's own curve already makes (§18.10); within 60 bp–1 Mb no point on that
  library stands more than 6 % off its neighbours, where the notches were 50 %. And a bin with no
  record, which a filtered library has plenty of at short range, broke the line: a run of sparse bins
  is now pooled into points of at least sixteen records, each over the whole stretch it spans, while
  a bin that holds sixteen on its own is never widened — so the curves start where the records do,
  unbroken, and a real spike, `−−` at 36 bp on the same library, stays one. The detached source a
  named `.pairs` was read through is also closed after its pass, where it was left mounted.

- **What a task makes of a map is called what the map is called (§16.10).** A map renamed on the
  Contact maps card or its heading kept its file's name in everything a task made of it: the drawer's
  tabs, the all-maps legend (`Bsubtilis_dparAB^mapped_PY79^NT9IOH.mcool::10000`, for a map called
  `dparAB`), the lanes and models a run adds, and a reproducibility run, which also called its own map
  *This map*. They take the map's name now, and the tabs and the all-maps figures follow a later
  rename. A track or a model was already named by the name it had when a run was made; a task's form
  open over the rename now lists it under the new one too.

- **A plain Run on a starred companion is that map's (§18.1).** It was filed under the first map —
  its tab, its lanes and its name were the first map's — and the Run button never said which map it
  would measure. In a batch with a companion starred, the first map's run was lent the companion's
  pixels for the region on screen, and came back with the companion's numbers. The button now says
  *run on ★*, naming the starred map in its tooltip.

- **Reproducibility is offered as soon as a deck has a second map (§18.1, §18.8).** It waited, greyed
  with *open a second map beside this one*, over a deck of two, until a batch or a star had made the
  other map read the tables an analysis needs. A map counts once its file has opened, the first map
  included when the star is on another; the column is asked again whenever a map of the deck opens,
  moves to another rung or closes; and a run waits for the other maps' tables, as *run on all maps*
  does, so the first one finds them.

- **Reproducibility gives hicrep's coefficient (§18.8).** The diagonals were pooled by the
  variance of their smoothed counts, which let the few nearest the main one — the largest counts and
  the highest correlation — carry the answer, and put the SCC a few tenths above hicrep's and
  hicreppy's on the same maps: 0.90 against 0.51 on chicken chr1, G2 against 60 min. They are now
  weighted as HiCRep weights them, `(n + 1)/12` for a diagonal of `n` positions, over the positions
  where either map has a contact, from the first diagonal out, on the upper triangle with the diagonal
  and everything past the furthest stratum set to zero before the smoothing — `hicrep` 0.2.6's
  arithmetic, which the unit tests hold the kernel to at twelve decimals. How far the comparison runs
  is now part of the answer, as hicrep's `dBPMax` is.

- **Stop reaches a task in the annotations worker (§18.3).** A metaplot, a FRiP or a track
  correlation ran to its end whatever was pressed, because the worker handed every task there a
  cancel check that always answered *no* and the runner never sent it a cancel; only the answer was
  refused when it came. A task now stops at its next read of a track, and a peak call between its
  windows and IDR's rounds. A motif scan, one pass with no read in it, still runs to its end, and the
  Stop button's tooltip says which.

- **A violin stays inside its figure (§18.13).** A violin's density runs past its sample, and where
  the ordinate was set — by the task or by typing its bounds — the tail was drawn on below the axis,
  through the names of the groups; it is cut at the plot's edge now. And a figure of boxes or violins,
  which names its series under the axis rather than in a legend, no longer keeps the legend's strip
  empty down its right side.

- **A task run again draws its new values at once (§18.5).** A re-run replaces its own tracks under
  the same ids, and every lane beside the map, in the 1D browser and on a model went on drawing the
  previous run's numbers, under the new run's name, until a pan or a zoom refetched them — so
  compartments run again by the other method looked unchanged. The row now carries a revision the run
  bumps, and each lane asks again when that changes.

- **The figure settings' `to` is set like the labels around it (§18.13).** Under `x from`, `y from`
  and a heatmap's `scale`, the word was drawn at the body's size, larger than every other label in
  the card.

- **A box that takes several sequences accepts a locus written the way the app writes one.** Its
  grammar is comma-separated and a plain split read `IV:1,000,001-1,400,000` as four regions, so a
  locus copied out of the heading above the box came back *Expected HYPHEN token missing*.
  `splitRegionList` knows a thousands comma from a separator — a digit on the left, exactly three on
  the right — so `I, II` and `1,2` are still two regions each.

- **An analysis form's locus box is grouped, like every other box that shows a coordinate.** It
  opened with `IV:1000001-1400000` directly under a line reading `IV:1,000,001-1,400,000 · 1 kb
  bins`: two spellings of one window, in the one place a reader is about to edit the number.

  The box is wide enough for the grouped locus it opens with, with *pick on map* beside it.

- **A figure's axes no longer print runs of zeros.** A P(s) ordinate climbed `0.001`, `0.0001`,
  `0.00001`, `0.000001`, `0.0000001` and the log-log slope beside it reached eight zeros — at which
  point a reader cannot tell one tick from the next without counting, which is the whole of what an
  axis is for. The ordinate had no formatter at all. It has one now, and on a log axis every tick is
  a decade and reads as one; an abscissa in base pairs takes the app's own span units, so a P(s)
  reaching a megabase reads `1.00 Mb` rather than `1,000,000`.

- **A run's clock is twenty-four hour, in every locale.** It read *computed in 776 ms at
  03:29:24 PM* — eight characters of which three were punctuation and a word, on the same line as a
  duration, and two runs an hour apart in the afternoon and the small hours sorted the same. The
  separators stay the reader's locale's; the hour cycle does not, because that is a fact about what
  the number is for (§26.2).

- **An anchor picked off the map now names the bins that were dragged.** *pick on map* wrote the
  locus in the form made for a clipboard — 1-based inclusive, which is what samtools and bedtools
  take — and the analysis runners read that parameter with cooler's grammar, 0-based half-open. So a
  drag that framed bins 230 to 1042 reached the runner naming bin 231 onwards: one bin along from
  the stretch the reader had just pointed at, with nothing on screen to say so. A 4C profile is read
  off its anchor, so the shift moved the peak. The box's own tooltip no longer claims to take "the
  same thing the locus boxes take" either (§18.2).

- **Hints that told you to empty a dropdown.** *Leave empty for every sequence in the file* sat
  beside a select whose first option reads *every sequence* on five tasks: an instruction for a text
  box that has not existed for some time, naming a gesture the control cannot take. The *Model from
  the map* form's three paragraph-long hints are one line each, with the three weighting cases on
  the options themselves, and its example no longer names `chrIV` on a file whose sequences are
  `I`…`XVI`. The heading *FROM THE RECORDS* — the parser's word for a `.pairs` file's rows — is
  *From the .pairs file*, over the `.pairs file` it asks for.

- **The map's *autoscale every track* reaches a barChart's and a junction lane's axis (§8.17,
  §8.23).** It set `auto` on the lanes drawn as a profile only, so a barChart with a typed pair kept it
  beside a map after the button that says *every track* — while the browser's own button, the ceiling
  drag and the ⌘-scroll all moved it. It now asks what they ask: whether the lane has an axis a reader
  can move.

- **A genePred that opened the browser says what it holds.** A feature file asked for the genome's
  lengths is parsed once and kept, and the row it then loaded into came back through the generic
  path, reading `N features` rather than the genePred's own line. Every format with a sentence of its
  own now gets it on that road too.

- **A lane's name too long for two lines of the browser's name column no longer runs out over the
  lane (§8.8).** A name with no break that left both halves inside the column was cut to the width of
  two lines and drawn on one, so `Geuvadis_chrX_GBR…188428.junctions`, dropped under its own name,
  ran across the first arcs of the file it named. It is cut to what two lines hold and broken there,
  or cut to one line where even that will not break.

- **A feature's card is headed with its name as the file wrote it.** The heading was uppercased
  like a dialog's category, so a band's card read `XQ28` — a long arm called `Q` — and a mouse gene's
  read as the human one's symbol. A card headed by a name now keeps its case; one headed by what the
  feature is (*Feature*, *Splice junction*) keeps the dialog's style.

- **The Tracks card's height box shows three digits.** It reserved its spinner's room at a width
  where that was most of the box, so a lane of 100 px or more read `10(`. It is typed, like the limit
  boxes beside it, and the arrow keys still step it.

- **A BED12 or bigBed of transcripts draws its exons (§8.16).** The glyph followed the lane's kind, and
  a BED is a `segments` lane, so a gene set in BED12 came out as one plain box per gene: its blocks
  and its thick span were read and never drawn. Every feature is now drawn by its own structure, so
  the same gene draws the same blocks from a GTF, a genePred and a BED12.

- **A GTF's coding span reaches its stop codon (§8.16).** The stop codon is a row of its own in
  Ensembl's GTFs, outside the last CDS row, and was left out — so every coding gene drew three bases
  short of its stop, and differently from the same gene in a genePred or BED12. The demo's genePred
  is regenerated the same way. A GFF3 transcript written as CDS and UTR rows with no `exon` rows now
  draws its exons and introns rather than one box.

- **A track's edge button lights on the press that sets it.** Moving a track to another edge of the
  first map announced the move before it made it, so the row went on showing the old edge — and the
  session remembered it — until something else changed.

- **The sequence bar's tooltip names the asterisk its placeholder offers.** The prose explained a
  sequence name, coordinates and a gene name, and stopped short of the fourth thing the box takes.

- **A sequence track's length is spelled the way the Genome card spells it.** The row read
  `16 sequences · 12,110,231 bp` while the card two columns to its left called the same number
  `12.11 Mb` (§26.2).

- **The readout under the pointer names the base.** At 47 bases per pixel the browser's status line
  read `IV:1.27 Mb` — two decimals of a megabase, so the number did not change across a fifth of the
  window — and a lane's tooltip beside the map said `IV:1.18 Mb` over 1 kb bins while the matrix
  tooltip a pixel above said the base. One rule now, on all three.

- **A track's value axis no longer depends on how wide its lane is.** The same ATAC track over the
  same 400 kb read `0 – 111` on a wide lane and `0 – 36.9` in a deck cell, so two cells of one deck —
  and the two stacks of one map — disagreed about the same file. Autoscale resolves over the values
  the file states in the window, and a lane narrower than a thousand pixels is sampled as though it
  were that wide, so the numbers behind two pictures of one window are the same numbers.

- **A lane's label no longer sits on the lane's own data.** Beside a map the block is drawn over the
  track, and a halo around each glyph was the whole of the protection: on a 16-pixel peak lane
  `ATAC peaks` came out with orange bars through every letter, `230 features in view` lay across the
  density block it was describing, and the GC lane's `0 – 1` ran along the trace it measures. The
  block now sits on a plate, a name too long for its lane is cut in the middle rather than clipped by
  it — a track called `Distance to IV:1000000` was drawn as `Distance to IV:100000` — a lane name is
  set in the weight the browser sets it in, and a fixed `0 – 1` axis keeps its range beside the name.

- **A gene name that is not in the file is never drawn.** `MSW1` came out as `SW1`, `HEH2` as `HE`
  and `MUS81` as `US81`, cut by the lane's edge and every one of them a plausible yeast symbol. Names
  are kept inside the lane, and a name may overhang its own feature four times over rather than
  without limit: a 46-character peak name written under a 3-pixel peak spanned a dozen unlabelled
  neighbours and read as the label for all of them.

- **A gene track stops vanishing into a grey bar when you open a side panel.** The collapse to a
  density profile was measured against one row of the lane, so a stranded gene set that packs into a
  band per strand was declared undrawable at half the genes it can draw: 230 yeast genes drew as named
  boxes at one width and as a solid block at another.

- **The single-file build has no store drawer, and nothing that opens one (§19, §24.2).** It built
  the drawer as any window does: a button in the header, the backslash and *Stores* in the palette,
  each opening catalogues of addresses that a page with no network cannot read, and a `?store=` link
  that went and tried. The drawer is not built there now, and the palette leaves the row out rather
  than greying it, since no state of that build opens a store.

- **An embed's landing page is *Load files* alone (§21.2).** It offered the store tiles and the row
  of places to connect, and a frame builds neither the drawer a tile opens nor the Files column a
  place is connected into: a tile did nothing when pressed, and a folder chosen was connected into a
  column nobody could see. Its palette greys the same rows — *Connect a folder*, and the folds of
  the three columns it does not mount — which were live over nothing.

- **The 1D browser's track-height box reads its lanes, as the map's does (§8.8).** It was built
  without them, so it went on showing the last number it had applied — `90` over a stack the same
  box beside the map called 46 — and a press of *down* made a 46-pixel track taller, which is what
  the box beside the map had just stopped doing.

- **A first map moving on its own stays so across a reload (§16.6).** A companion's chain has always
  been kept with its look, per file; the first map's was kept nowhere, and came back closed on every
  build of the deck — a reload, a restored workspace — so the map the reader had taken off the deck
  carried every other map with it on its first pan. It is kept beside the first map's place, and a
  saved workspace carries it.

- **Closing the map keeps the Manual annotations card in the browser it falls back to (§5.8,
  §8.1).** The column that road built held the tracks and left the marks card out, though a browser
  opened fresh has it: the marks drawn on the map stayed in the session with no card to see, place
  or remove one by.

- **A sequence on the stage can be given its own name back — a dev feature (§27.3).** The rename box
  refused every name of the file's own, to the sequence that is that original whole as well — which
  the step allows, and which the refusal's own words, *for that sequence whole and no other*, said
  it did. It asks the step's rule now, and refuses the name to anything else.

- **Review frames the next suggestion once one is answered — a dev feature (§27.6).** After `Y` or
  `N` the next best became the one review was on without the map going to it, so the line under the
  toolbar named a suggestion that was not on screen; `→` and `←` framed theirs, and an answer now
  does too.

- **The stage reads the file's own sequence, whatever was loaded first — a dev feature (§27.5,
  §27.8).** The evidence of the ends and gaps and the edited FASTA took the first sequence track that
  was ready, which with a theoretical genome loaded before the assembly's own FASTA meant telomeres
  looked for in the wrong set and an edited sequence written as `N`. Both now choose as the corner
  dot plot does — the set naming the most of the map's sequences — through one helper.

- **A tracks cell marks both ends of the map's cell under the pointer (§25.4).** It drew one hairline,
  at the first of the two anchors, where the lanes beside the map mark both.

- **A narrow deck cell's lanes no longer paint over the next cell (§16.5).** Three or four across,
  the first map's side stacks were wider than its cell and were drawn over the neighbouring cell's
  heading and locus box. The map now gives way down to 10rem inside a deck, the rest of the cell
  scrolls sideways, and the scroll opens with the map in the middle.

- **The Export card's save and copy include a deck's structure and tracks cells (§16.5).** With the
  first map beside a 3D model and no second map, the card wrote the map alone; it writes the deck's
  whole figure whenever any other cell has a picture, as the bar's own save does.

- **The deck's `· N maps` lost its bullet** whenever the count was written before the first block
  had filled the summary in front of it; the separator follows the summary now.

- **A companion drew the normalisation its own score named (§16.2).** A companion reading `VC`, `ICE`
  or the correlation took the normalisation from the *first* map's score, so it was labelled one
  thing and drawn as another; it reads it off its own score now.

- **Dropping several local coolers no longer gives a row of empty cells (§16.6).** Each opened a
  live panel and then, a frame later, every one of them was replaced by a vacancy reading *this cell
  held that file and it could not be re-opened* — about files the deck still had in hand. The hash
  can say no more than `~` about a local map, and what a `~` was resolved against was the stored
  record, re-opened through a filesystem grant; a file that arrived by **drag and drop** may have no
  grant — outside Chromium the browser hands over a `File` rather than a handle, and nothing can ask
  for one afterwards. A cell the deck is already holding is now the first answer for its own index,
  and the record answers for the rest.

  Nor when tracks come with them: eight coolers, a GTF and a FASTA dropped on a new tab open eight
  maps, because a render of a state the view has since moved past no longer touches the deck
  (§16.11).

- **A structure file dropped on an empty window opens as its model (§25.3).** A lone bed3d or g3d
  opened the 1D browser of the genome its beads name, with nothing on it and the model nowhere on
  screen; the model now opens in its own cell, filling the view, with the empty tracks hidden behind
  it — `show the 1D browser` in the deck's bar brings them back.

- **The Structures card's eye follows the deck (§25.3).** A structure cell closed from its heading left
  its row's eye lit, and a model dropped on a `+` or an empty cell left it dark, until the eye itself
  was pressed.

- **A reconstruction no longer destroys the model before it (§25.6).** *Model from the map* landed
  on the id of its task and removed the row that had it, which is right for boundaries or domains —
  running insulation again with a wider window means the reader wants the *new* ones — and wrong for
  a model: two models of one map are the comparison §25.3 is built for, and a model is not stored
  anywhere else, so a second run left nothing to compare and no way back. **Two runs of one map** —
  two framings of it, or its two methods — are exactly the comparison somebody makes a second model
  for. A run now takes the next free id in the series and the label carries the same `(2)`, since
  two rows under one name are two rows nobody can tell apart in the picker or in *compare with*.

- **A mark outside the window is ghosted like the bead it sits on (§25.5).** Telomeres, the reader's
  own marked places and the genomic ruler's ticks were drawn at full strength whatever the model was
  doing, so a window of one chromosome was read against a constellation of solid yellow telomeres
  nowhere near it — the brightest thing in a picture of somewhere else. The vector export had it
  right from the start, so the screen and the exported PDF disagreed about the same model.

- **A model with a bin the solver could not place is a structure again (§25.2).** A solver writes
  `nan` in all three coordinate columns for a bin it was given nothing to place — a repeat, a gap in
  the assembly, a bin nothing mapped to — and the sniffer read the first such row as *this file is
  not a structure* and gave up on the whole of it. A 1,683-bead pastis-NB model of a mycoplasma
  genome has 33 of them and the first is thirty-one rows in, so **both** files it was written as
  fell through to the BED family: the `.g3d` landed on the Structures card by name and then failed
  with *all 1,683 lines failed the "contig, start, end" test that every BED-like format begins
  with* — a refusal naming a format the reader never handed over — and the `.bed3d` beside it, whose
  third column really is an integer end, was **drawn as a track**: a lane of 1,683 boxes whose name
  is an x coordinate. A bead with no place is now passed over by the sniffer and dropped by the
  parser, as a bead nowhere always was, and the model opens at the beads that have places. A file
  where *every* bead is unplaced says that in those words, rather than in the sentence naming the
  columns — its columns are fine. A coordinate that is neither a number nor one of the spellings of
  *nowhere* (`nan`, `NA`, `inf`, `None`, `.`, empty) still says the file is not a structure, which
  is what keeps a BED6 out.

- **A pair the map never counted is the pale end of the ramp, not the dark one (§25.5).** Colouring
  a model by *contacts with the pinned bead* put every uncounted pair at the **top** of the scale, so
  the darkest beads in a virtual 4C were exactly the ones with no contact at all. `log10`'s clamp
  folds a zero to `0`, which is numpy's and right on a map whose scale starts there — but the scale
  here is the map's *transformed* range, and a balanced map's runs from about −3.6 to about 0.

- **A ghosted chromosome's dashes are ghosted too (§25.5).** The dashed run of ink across every gap
  in a chain was flat ink at full opacity, so a model faded almost to nothing still carried a cage
  of black dashes over it — which read as the one thing being *shown*. A gap is a fact about a
  chain, so it fades with the chain, and a gap spanning the edge of the window thins into the ghost
  as a stick does.

- **A marked bead is the colour you gave it, not black (§25.4).** Every bead drawn for one of the
  reader's own 1D annotations came out black on screen, whatever colour the Manual annotations card
  showed beside it — and the same mark exported to PDF came out right, because the 2D painter takes
  a colour as a colour. The sphere's material asked for **vertex** colours as well as the instance
  colour it actually uses; `USE_COLOR`'s shader multiplies in a `color` attribute a plain sphere has
  not got, a missing attribute reads as `(0, 0, 0)`, and the instance colour was multiplied into that
  zero. (`defaultAttributeValues` would have supplied a white one, but three defines it only on
  `ShaderMaterial`.) Dropping the flag is the whole fix; the colour has always come from the card.

- **The 3D card's `colour by` no longer reads `displacement from the cor…`.** The option did not fit
  the column even as a full-width block; the `compare with` row directly above it names the model,
  so the option says `displacement` and the key's caption with it. A caption that does have to be
  long — *displacement — choose a model to compare with* — wraps now instead of being cut mid-word.

- **The filter box over the IGV genomes is absent until there is something to narrow.** It stood
  above the red banner of a store that had failed to load, offering a box to type into with nothing
  behind it.

- **A store that has not been published yet says so in the singular and the plural.** The message
  interpolated the store's name in front of *is not generated yet*, and half the built-in names are
  noun phrases of the wrong number — so IGV's read *IGV genome sessions is not generated yet*.

- **A store that could not be read no longer draws a toolbar over the empty room.** A search box, a
  *clear filters* and a list/matrix pair stood above the red banner, offering to search nothing,
  clear nothing and arrange nothing (§8.5).

- **The landing page's privacy note ends where everything above it ends.** Its 80-character measure
  was on the bordered box rather than on the prose inside it, so the last thing on the page stopped
  two hundred pixels short of the eight store tiles — with an accent bar down its edge making the
  ragged end unmissable. The sentence keeps its measure.

- **The `chromosomix` command reads a model back in as a structure.** A bed3d or text g3d under
  `--features` is the structure *Spatial tracks* and *Model versus map* read, so a model the shell
  wrote can be read as tracks in the same batch; it was read as a BED and refused as *not a
  structure*.

- **The `chromosomix` command names what it reads from a reference after the file.** *GC content ·
  PAK.fa* and *Origin and terminus · PAK.fa*, as the app names them after its entry; a reference
  named with `--sequence` had no label, and every output read from one said *reference*.

- **An analysis run that was never asked which sequences reads every one of them.** Unanswered and
  *none ticked* were one value, and on the command line only the first of them exists: `chromosomix
  compartments sample.cool` — the README's own example — refused itself with *tick at least one
  sequence*, naming a control a shell has not got. Unanswered is now the whole file, which is the
  genome-wide compartment call that task exists for, and an empty list is still a reader who pressed
  **none** and is still refused.

- **`chromosomix reconstruct3d` writes the model rather than an empty BED (§25.7).** A model is
  an interval set whose rows carry three coordinates each, and the shell wrote every interval set as
  a BED6 — so a reconstruction run over a batch came out as `chrom start end region_1 0 .` per bin,
  which is the assembly handed back with the one thing the run computed dropped for want of a column
  to put it in, beside a TSV whose every row was blank after the coordinates. Nothing said so: the
  files were there, the names were right, and the numbers were not in either of them. §25.7 has said
  since there were models that **a model leaves as a bed3d**, and the export road a computed row
  shares with called intervals is the shell's road too — so `--out` now writes `chrom start end x y
  z` through the drawer's own writer, the haplotype column where there is one, and the file reads
  straight back into this app and into `g3dtools`.

- **Closing the share dialog before its link is ready no longer copies the link.** The copy that
  follows the link's arrival went ahead for a dialog already dismissed, writing over whatever the reader
  had put on the clipboard since.

- **A full circle is drawn in a vector figure.** The PDF page flattened an arc of exactly one turn to
  a path of zero length, so a loop drawn as a ring on screen was missing from the saved figure.

- **A view's heading no longer changes shape as it zooms (§5.4, §26.6).** The title bar wrapped or
  unwrapped whenever a press lengthened or shortened its title, and the summary under it could run
  to three lines on a pair of loci — so the map jumped a line up or down under a zoom. The heading's
  shape is now decided by its width alone (one line, the toolbar under the title, the steps under
  the box); the title and the summary are one line each, ellipsised with their whole text as a
  tooltip.

- **A label and its dropdown share a line in the panel cards (§26.6).** The Map card held `score`
  above its select and `smooth`, `transform` and `colours` beside theirs — two shapes for one kind of
  question. The label column was the cause, not the row: at 6.5rem a dropdown had 67 pixels, which
  cut `adaptive` in `smooth` and left `correlation` no chance; at 4.6rem, the width of the longest
  label in those cards, every option fits beside its label.

- **The `/` badge sits in the middle of the box it is in.** With no `top` an absolutely positioned
  child keeps its static position, which in that flex row is the top of the line, so the badge was
  four pixels high of centre and wedged three pixels from the border.

- **Recentre-to-diagonal is one stroke along the diagonal.** It was `move-diagonal-2`, the same line
  with an arrowhead on each end: the heads read as *drag along here*, which is not what the button
  does, and at 15 px they were most of the ink.

- **Seven marks in a card's row are a block, not six and an orphan.** The Map card's overlays fit
  one line until the panel had enough in it to want a scrollbar, which takes the fifteen pixels the
  seventh was living on — and a lone icon under six reads as a different kind of control. Seven or
  more now sit four across.

- **The side columns give way before the picture does.** Four columns come to about 1,180 pixels at
  their own widths, and the centre could be squeezed to nothing: on a 1366-wide laptop with all four
  open the map was 140 pixels and the locus box 85, showing `IV:1,00` of the reader's own position.
  The columns now shrink to their minimum widths and the picture keeps a floor of 18rem, which keeps
  the picture 288 pixels wide at 1366 instead of 140.

  Otherwise a column keeps the width it was given: nothing the centre holds — a summary that grows
  with a zoom, the Genomes table — narrows it.

- **Aesthetics' and General's minimum widths are what their own cards need.** At 200 pixels the two
  clip limits read `-4.1` and the `transform` and `colours` selects cut `log10` and `default`, and
  the File card left its values about forty pixels. Both are 240 now, and the clip pair has a floor
  of its own.

- **A dialog headed with a file's name no longer uppercases it.** The enlarged 3D cell read
  `YEAST_STRUCTURE` over a card, a tab and a Structures row all reading `Yeast_structure`, and the
  `.pairs` binning dialog did the same to the file it names. A heading that is a category is still
  uppercased; one that is a name keeps the file's own spelling.

- **An empty console no longer offers copy, save and clear.** The first two wrote a file with nothing
  in it and the third forgot nothing. §26.3's rule cuts both ways: a control with nothing to act on
  is dimmed.

- **A locus box's placeholder is cut to the box, clause by clause, rather than clipped mid-word.**
  `I:1,000-20,000, a sequence, a genome, or a gene` wants 458 pixels and the browser's bar at 1366 is
  336 of them, so the box showed `I:1,000-20,000, a sequence, a ge` — an input clips a placeholder
  with no ellipsis and reports no overflow, so nothing on screen said a list had been cut, and what
  was cut was the clause a reader had not already guessed. `fitPlaceholder` measures the sentence and
  drops whole clauses off the end until it fits, keeping the example, and puts the offer in full in
  the box's tooltip. Re-measured when the box changes size, so widening a panel gives the rest of the
  sentence back.

- **A locus is written with a hyphen everywhere, including the places the audit did not reach.**
  The 3D panel's four readouts, a read's row on a lane, a feature card's span, its exons and its
  coding stretch, and the read card's position each spelled the window by hand with an en dash — this
  app's mark for a range of *values* — so a locus wore the punctuation of a quantity. All of them go
  through `formatLocus` now, which is the one writer §26.1 names, and the hand-rolled `+1` beside each
  of them is gone with them.

- **A copy button you could not see could still be clicked.** The console's per-row copy sits at
  `opacity: 0` until its row is hovered, but `opacity` hides a button without disarming it — so the
  last twenty pixels of every resting row were a live target, and a reader dragging to select a line
  could land on it. Inert while invisible now, which is the rule the tab's own × already followed.

- **Six hints that were two sentences are one.** A rule under a track and the reason it is there are
  one thought, not two; so are a bounded read and the gate on it, and a `⌘C` that yields to a text
  selection. §26.4 now also says which two lines are *not* that hint and are not held to it — a
  toggle may add what its off state does, and an empty state teaches the gesture that fills it —
  because both are facts a control cannot show, and pretending otherwise was going to cost the app
  eleven useful clauses.

- **The File card folds, like every other card in every column.** It and its pair in compare mode
  were the only two headings in the app built by hand rather than by the shared one, so the General
  column had three cards of which two folded and one did not (§26.6).

- **A locus box's example comes from the file you have open.** It said `chrI:1,000-20,000` over a
  yeast genome whose sequences are called `I…XVI`, and promised *a gene* whether or not an annotation
  was loaded to look one up in. The Genomes, Chromosomes, whole-genome and pair boxes have gained the
  `go` the other four always had, and the whole-genome view's placeholder no longer ends mid-word at
  the clause that says a gene name works.

  It never offers `__unbinned__`, the first row of a metacool's contig table, which §7.4 refuses to
  draw.

  A map's own box takes its example from the sequence it is showing, and falls back to the view's
  noun only where the view's name carries no coordinates, as a whole genome's does.

- **The landing tables read as one family.** The four columns a `.metacool` guarantees are labelled in
  the app's own words rather than as `n_contigs` and `n_bins`, with the file's identifier in the
  header's tooltip; the density column is `non-zero pixels (proxy)`, which is what the File card
  beside it calls the same number; one ticked row is named on the button rather than counted;
  `clear filters` greys itself when there is nothing to clear, as `clear selection` beside it always
  did; a filter box says `filter` and a toggle column's filter is a named control rather than a
  second bare checkbox meaning something else; and the Cells heading no longer repeats the row count
  two lines above it.

- **The Chromosomes table says *chromosome* throughout.** Its filter box asked for contig names and
  its empty state named contigs, under a heading — and a breadcrumb, and a File card — reading
  *Chromosomes*.

- **A heading in a right-aligned table column keeps its beginning.** `estimated completeness` read
  `ed completeness` and `weighted r` read `hted r`: `text-overflow` cannot reach the text inside a
  flex container, so the words were pushed out of the box from the left — and the heading is the only
  place a MAG metric is named.

- **A short table is as tall as its rows.** Sixteen chromosomes drew their bordered box to the bottom
  of the window with two hundred pixels of nothing under the last row, which reads as rows that
  failed to load.

- **The opacity stepper's up-chevron is back on its own line.** In half a side column the `∨ box ∧`
  row wrapped after the box and left the arrow orphaned underneath — on the Tracks card, in every
  screenshot.

- **The map's bar keeps its toolbar together.** The locus box, `go`, the four zoom steps and the
  bookmark are one group, so they drop to the next line in order instead of the zoom steps breaking
  away under the title — which gave one bar three shapes at three window widths, with §5.4's "four
  buttons beside the box" beside nothing.

- **A two-letter chromosome crumb is not elided.** In an embed's bar every crumb could shrink, so the
  shortest gave way first and `IV` became `I…` — a different chromosome to a yeast biologist, spelled
  with an ellipsis wider than the word it replaced. Only the file's own crumb yields now.

- **A tab shows its file's name.** The only tab on an empty strip was cut at `Yeast_microC_G2M_1kb…`
  while the crumb below printed the same name whole; the ellipsis was the bold weight of being active
  crossing a 12 rem cap.

- **A value that runs past the File card's edge shows a scrollbar.** `uri http://127.0.0.1:5` reads
  as a value that stopped rather than one that continues; the card has always scrolled, and now it
  says so. The `lengths` row is short enough to fit either way — `bigWig header`, `inferred (rounded
  up)` — and the sentence explaining it is said once instead of four times on one screen (§5.8).

- **The genome minimap no longer says "on the diagonal" in a session with no map.** A link to a file
  that could not be opened left the map's view in the store while a browser over the remembered
  genome was what got mounted, so the card highlighted the first kilobase of `IV` and described it in
  contact-map words. Which mode it is now comes from the session rather than from the link.

- **The loading screen keeps the file's name, and shows one meter.** `Opening Yeast_G2M.scool…`
  became `downloading — 1.2 MB of 18.1 MB` and then `reading pixels — 1,204 of 14,769,558`: a
  sentence with the file in it turning into a lowercase fragment halfway through a minute-long open,
  in a window that may have two of them going. The phase is a line under the bar, and the spinner
  goes when the bar arrives instead of turning beside it with both announcing themselves as progress.

- **The right-click menu answers the keyboard.** Arrow keys walk its rows, Home and End reach the
  ends, the first row takes focus when it opens and closing hands focus back. The breadcrumb's table
  menu closes on Escape, which every other transient surface in the app already did.

- **The three read-only status items open their panels from the keyboard.** They were plain `div`s,
  so the `:focus-visible` rule written for them could never fire and the request-and-byte breakdown
  a reader on a metered bucket watches was reachable by pointer only. A screen reader now gets the
  rows, too.

- **Tab reaching the clip values on a map's key is visible.** Focus and hover drew the same dotted
  hairline in the palest grey the sheet has, over the heatmap; focus takes the accent underline the
  box itself draws once it opens.

- **A structure key of sixteen sequences goes in two columns**, instead of a translucent list to be
  scrolled to reach `XVI`. **The spinner beside a running task is a ring with a track**, not a ring
  with a hole, which at any still frame drew a capital `C` in front of the sentence.

- **The Chromosomes table's *circular* tooltip says what a tick does now (§8.15).** It promised a
  map that slides past the sequence's end and back on at its beginning — removed this release — and
  that every cis analysis measures separation the short way round. It names `ori` as the way across
  the origin, the tasks that read a circle, and the two that do not: chromosight and the
  observed/expected map.

- **The shortcuts dialog's map gestures are the ones the map answers (§7.2, §8.9, §16.9).** Two
  fingers sideways slide *along the diagonal*, not *the map left and right*; a lane is resized by
  its far edge, not its inner one; a file is taken on any of the map's four edges, not only below or
  right of it; and a lane's grip reaches a tracks cell too. Shift-drag, the map's own zoom in one
  dimension, and a drag across a lane, which moves its ceiling, were not listed at all.

- **A ladder dropped at its root is said to open on its landing rung (§9).** The refusal's advice
  read *drop the file again and the finest one opens*; it opens a third of the way up from the
  finest, whose reads are the largest the file has.

- **A turned companion that does not follow says why (§16.4).** *Each map opens on a fraction of its
  own block and rounds that to a whole bin* was how bands were cut before the deck cut every
  companion to the first map's reach. The refusal says the one way two bands can still disagree:
  this map's block does not hold that much.

- **A Tracks card row's grip says where it can be let go (§16.9).** Its tooltip offered *the map's
  bottom or right edge*; a row is taken on any edge of any map, a `+` and an empty cell, the last
  two opening a tracks cell drawing it.

- **The page's title and the install prompt's name say nothing of a dev feature (§29.5).** Both read
  *(meta)cooler — (multi-genome) cool files, in the browser*, with the multi-genome format off by
  default; the words in brackets are gone, and a test reads both files for them.

- **The stores' toggle and the palette's *Stores* name no list to go stale (§24.2).** Both named the
  lab's data, IGV's genomes, 4DN and ENCODE while seven stores ship; they say *every data store this
  viewer ships with, and any you connected*, and the drawer's own tiles are the list.

- **The tab strip's rename box is announced as *Tab name* (§5.6)**, the reader's word, where a
  screen reader was told *Session name*, a word the strip never shows.

- **A public bucket is listed as an address, not as a key (§20.3).** The stored-data screen called
  every bucket scope *Bucket keys — access keys for private buckets*, so a reader who had connected
  one public prefix was told a credential was on the disk. A scope with no key is *Buckets you
  connected*, named; *Bucket keys* is there only where part of a key is.

- **A console row's mark names its state in §26.7's words.** *finished* is *done*, and *the window
  closed while this was running* is *interrupted*, the status §23.5 gives a run whose window went
  away.

- **A refused bucket listing is plain text (§26.4).** The 403 and CORS messages wrapped
  `s3:ListBucket`, `s3:GetObject`, `AllowedHeaders` and the headers they name in Markdown backticks,
  which nothing renders in the Files column or the Connect dialog.

- **The standalone build calls its folder door *connect a folder* everywhere (§19, §20).** Its
  landing page did, over the one place it reaches; the Files column's button and the palette's
  command still offered *a local or remote folder*, with a bucket, a Drive folder and a Dropbox in
  their hints, in a build with no remote half.

- **A variant lane's right-click menu has the point switch its card has (§8.16).** The menu left
  *Point the way each runs* off a call set's lane while the card kept it on, so the two surfaces
  answered one question two ways.

- **A dot plot's *Customise this figure* keeps its zoom (§28.2).** The column offered the matrix's
  Colour card, whose picks changed nothing on the red and blue lines and rebuilt the view at the
  whole; it holds the Text card alone, and a title set there leaves the view where it was.

- **A thirteenth resolution is refused in the dialog that asks for it (§3.4).** A file takes twelve
  added; the thirteenth closed the dialog and added nothing, with nothing said. The dialog says so
  as it opens, and names the way out — take one off the ladder.

- **The File card names the normalisation a `.hic` is balanced with (§3.6).** The reader chose the
  file's best vector — SCALE, then KR, then the coverage ones — and showed the choice nowhere,
  though the section said the info panel names it. A *normalisation* row does, and says *none at
  this resolution* where the rung open has no vector.

- **ENCODE's shard choice stays on screen when every ticked shard failed (§24.2).** The rail went
  with the toolbar, so a reader who ticked a shard the workflow has not written was left a red line
  and no checkbox to pick another; the sentence takes the rows' place and the two groups stay beside
  it.

- **A tab on the picker has no *read* or *validation* on the status bar (§6.3).** The picker starts
  its reader before a file is chosen, and a tab switched back to handed the bar that worker: both
  items came back, a counter of nothing and a check that failed when pressed. A tab hands the bar
  its reader only while a file is open in it.

- **Pattern detection's price, and the chromosight pileup's, say a band is read (§18.6, §18.8).**
  Both lines priced *one dense square* per sequence — mouse chr1 at 5 kb was one read and 6,114 MB —
  after both runs had moved to reading each sequence along its diagonal. Pattern detection's line
  counts the strips that read the band and the widest band held at a time, 376 requests and 65 MB
  there; the pileup's band reaches as far as its loop set does, which is not known until the run
  reads the set, so its line says so in words and names no figure rather than the square's.

- **Compartments' *sequences* hint is true under every *contacts* setting (§18.8).** It said *one
  correlation over all of them, cis and trans*, which is what *cis and trans* and *trans only* do —
  and the default, *cis only*, is one correlation per sequence. It names both, by the options' own
  labels.

- **A UCSC hub that cannot be read sends the reader to a *connected* folder (§24.10, §26.4).** The
  sentence a `*.ucsc.edu` host adds to the CORS failure ended *opening it from a mounted folder*,
  the one place left using the word every other screen gave up for *connected* (§24.2).

- **The palette's *Annotations panel* row is live on a metacool (§8.5, §26.6).** It stayed greyed
  there with *Absent on a metacool, which carries no annotations* — a sentence from the release the
  cards were gated off a file with a genome layer — beside a column that came up on a metacool with
  every other file's cards. The row is under the column's own gate now, whether the session put any
  cards in it.

- **Two more lines say what the screen shows.** The whole-metagenome view's remote-scan gate set
  its `metacooler network` command in backticks, which a hint does not carry (§26.4); it is set as
  code. The clip boxes' tooltip read their units off *the colourbar*, a word the app does not use
  for the key in the map's corner.

- **The palette's door survives a half-width window.** Below 60 rem the search bar was hidden
  outright, which left `⌘P` — and every command with no button of its own — with nothing on screen
  to name it. It keeps its badge and loses its sentence.

- **`3 problem(s)`** is `3 problems`, and a validation that is running says `running`.

- **The whole metagenome no longer dies with *Array buffer allocation failed* at bin level (§7.3).**
  The bin-level block was summed into a full-square `Float64` and copied to `Float32`, about 200 MB
  at its peak against the contig level's 134 MB for the same raster, so on a tab short of memory the
  default level failed where the others worked. It now sums the upper triangle and finishes straight
  into `Float32`, which is what the other levels cost. And if the tab still cannot allocate it, the
  view falls back to `contig × contig` (a cooler's `chromosome × chromosome`), starts that read
  without asking again, and greys out `bin × bin` with a line saying why.

- **A metagenome's whole-file view is the *Whole metagenome*.** Its crumb, heading, gate and
  compute button said *whole genome*, which is a cooler's view, while the command palette already
  said *Whole metagenome*. The genomes table's button reads `whole metagenome →` too.

- **A table says where the file's own columns end.** A MAG-QC table joined into a metacool brings its
  own `Length` and `Contigs`, so the header read `name length contigs bins Length GC-content …` —
  identical numbers under two capitalisations, with no way to tell which one a sort was using. The
  first joined column now carries a rule down its side and each joined header a tooltip saying so,
  which is the header's half of the record card's *joined in with the file*.

- **A record card no longer says every number twice with nothing to say why.** On a metagenome the
  Genome card read `length 7,310,635 bp`, then fifteen rows later `Length 7,310,635` — and
  `n_contigs 2,153` then `Contigs 2,153` — because `/genomes` guarantees three columns and the
  file's creator had joined a MAG-QC table in beside them. Both sets stay, for the reason §5.1 keeps
  them in the table, with one quiet line between them headed *joined in with the file*.

- **The pair view opens either genome by name.** There was one door, labelled `open rows genome →`,
  which is not a phrase and did not say which of the two it opened.


### Security

- **Every web build carries a Content-Security-Policy (§11, §21, §22).** The site, each pinned build
  and the package write one policy into `index.html` as a `<meta>`: scripts and styles from the page's
  own origin and Google sign-in's documented sources, no inline script and no `style=`, connections to
  `https:`, the loopback and `data:`, and no `frame-ancestors`, so an embed stays frameable. The build
  fails if its page holds anything the policy would refuse. A script injected through a name in a
  file would have run with the reader's S3 key in reach; it would be refused now.

- **The single file carries a policy computed over itself (§19).** It names the hash of each inline
  script and stylesheet, and reaches no host: `connect-src` admits only `data:` — where the bigWig
  reader keeps its own wasm — and the blob workers inherit the policy.

- **A chart's tooltip shows a file's names as text (§18.13).** A sequence, sample or series name was
  written into the tooltip as HTML, which the chart library parses on every hover, so a file with a
  sequence called `<img src=x onerror=…>` ran its script when the pointer crossed a Cis/trans or
  track-correlation cell. Every formatter now escapes what it prints, through one helper — the names,
  the numbers and a series' colour, which a workspace file carries as surely as a name.

- **A binary file is held to its own size, whatever its counts claim (§10, §12).** A `.hic`, a
  BAM's BAI or CSI, a `.2bit` and a binary g3d with its MessagePack header were read on the strength
  of the counts and lengths they declare, so a truncated download, a flipped bit or a hostile file
  sized a typed array, a read or a loop: a sixteen-byte `.hic` block declaring fifty million records
  allocated 572 MiB, one negative vector length in a footer read 341 MiB of a 256 MiB file, and a
  twenty-four-byte `.csi` declaring a depth near a million would hold the annotations worker for some
  twenty minutes a query. Each count is now refused — naming the format, the field and the value —
  unless it is a count, under the format's own maximum and small enough for the bytes left to hold
  it, and an offset and length must name bytes inside the file. Over 1,140 seeded corruptions of
  files the repository's own writers produce, no reader reads more than four times its file, makes
  an array past 30 KB or takes a tenth of a second.

- **Every inflate stops at a cap (§10, §12).** A `.hic` block, a g3d model, a gzipped or bgzipped
  text file, a BGZF span, a `.pairs` stream, a whole file the command line keeps and a share link were
  each inflated to the end before anything looked at the size. The decompressor is now fed 64 KiB at
  a time and stopped as soon as its output passes a cap in proportion to what went in — sixty-four
  times for a `.hic` or g3d block, where `straw` allows ten — a BGZF member is held to the format's
  own 64 KiB and text to 2^29 bytes, and a line of a plain-gzip `.pairs` past 64 MiB is refused.

## [0.13.0] - 2026-09-20

### Added

- **A box drawn over any chart is a zoom; a double click undoes it (§18.13).** Hold ⌘ — or Ctrl,
  which is the same key on the other two platforms — and drag a marquee over a figure, and the axes
  come back holding what was inside it. **Which axes it sets is read off the shape of the drag**,
  with no mode to be in and nothing to choose first: a flick across the picture sets the abscissa
  and leaves the ordinate alone, a flick down it sets the ordinate, and a box sets both. The rule is
  a share of the axis rather than a count of pixels, so it reads the same in a folded drawer and in
  a full window, and a press that went nowhere is a click. **A double click inside the plot puts
  both axes back** to the windows a control last set — the numbers a reader typed, or the whole of
  the data where they typed none. The wheel still zooms one axis at a time, which is the right
  gesture for following a curve along; this is the one for *arriving* somewhere, which used to take
  a scroll and a pan on each axis, overshooting at every notch.

- **A result matrix is an interactive heatmap (§18.13).** A saddle, a pileup, a cis/trans square and
  a track-correlation heatmap are now drawn by the same chart every curve is: the cells hover and
  name themselves, the colour bar's handles clip the scale instead of captioning it, and the
  marquee and the wheel work on them as they do everywhere else. The colours are still this
  application's own tables and the scale is still the painter's rule, so a saddle in the drawer and
  a saddle in a paper are the same picture. **Contact maps are untouched** — a raster of millions of
  cells is not a thing a heatmap series could ever be — and so is any result matrix above twenty
  thousand cells, where half a million rectangles in an SVG would be a picture nobody can point at.

  **The cells stay square where both axes are the same quantity**, whatever the reader did to the
  drawer, because a saddle is read by comparing its two corners and a corner stretched 40% along one
  axis looks stronger than the one opposite it.

- **The metaplot's per-feature heatmap takes the whole width of the card (§18.13).** Its rows are a
  *list* — one feature per row, strongest first — and nothing is compared across a diagonal it does
  not have, so square cells only made it a ribbon a fifth of the card wide with white on either
  side. It now fills the card under the profile it shares an abscissa with, the way every metaplot
  tool draws it, **with that abscissa numbered** so the two pictures can be lined up at all. Its
  colours are **clipped at the 99th percentile** rather than fitted to the extremes: one feature
  under an amplification, or a single bin of pile-up artefact, used to take the whole scale and draw
  every other row at the bottom colour — a flat block with a colour bar running to thirteen hundred.
  Cells above the clip keep the end colour, so an extreme row is still visibly extreme.

- **Every figure a task produces is now restylable, and the PDF is still a drawing (§18.13).** A
  slim strip over each plot carries the controls reached for constantly — the mark, the two log
  axes, the legend, *Fit* — and one button beside it opens the figure **in the same dialog the 3D
  model opens in**: the picture at the size of the window, every control in a resizable column
  beside it. There are new marks to choose from (line, area, step, points, bars; histogram, box and
  violin as summaries of the ordinate), per-series colours and visibility, typed axis windows, and
  a title and type size that go into the export. A **table** is now a view rather than a printing —
  filter it, sort it, choose its columns, or draw one numeric column as a distribution or against
  another as a scatter. All of it is **remembered per file, per task and per output**, beside the
  parameters the task was run with, and carried in an exported session.

  **Contact maps are drawn exactly as they were**, by the same rasteriser: a contact map is a
  raster of up to sixteen million cells with its own gestures and its own export path. A task's
  *result* matrix is a chart now — see below.

  The **PDF export is still a true vector page** — paths and text, restylable and scalable, not a
  photograph. The chart library is asked for SVG rather than for a canvas, and the same picture is
  replayed onto whatever context the export hands over, so the screen, the PNG and the PDF are one
  drawing rather than three. The library itself arrives in a chunk of its own when the first figure
  is built, so a reader who never runs an analysis never downloads it.

- **A 3D structure viewer, as a full view of the app (§25.3–25.5).** A chromatin model — WashU's g3d
  (the text `g3dtools` takes, or the binary container written here), a `.3dg`, or `bed3d` (the same
  file with an end column) — becomes a row of the **Structures** card (under Tracks) and a cell of
  the deck; a `.g3d` can be dropped on either card, since the loader files it as a structure either
  way. three.js loads only when a structure cell first opens (a 552 kB chunk, 140 kB gzipped). Its
  settings sit on a **3D structure** card of the Aesthetics panel, right after the Map card, shared
  with the enlarge dialog's sidebar: **size by** a track, a **depth slab** into a dense model (the
  fog is tied to it — measured from the centre of rotation, so it actually clips, rather than from
  the camera), a **genomic ruler** along each chain, camera presets, a turntable, and the cell's
  actions as palette commands (`f`, `a`, `1`–`3`, `l`, `r`). Drawn-as is three combining icon toggles
  (beads, sticks, tube); every chain gap is always a dashed run of ink and the *gaps* option is gone; the cell is
  always orthographic and lit, so those two options are gone too; fog, chords, names and centre are
  icon toggles; one **ghost opacity** slider (0.15 default) covers what is outside the window or
  ghosted from the key, and *outside the window: show* draws a whole genome in colour while the maps
  look at one window of it. A stored style still reads back, the old representation becoming the
  three toggles.

  **Colour by** sequence — the key is a control: click ghosts a sequence, double-click shows it
  alone, the swatch is a colour picker — haplotype, position, the file's own columns, a loaded
  track, a feature set, the reader's marks, distance to the pinned bead, or **contacts from the
  pin**, the map's own row through it drawn as chords above a threshold on the map's colour scale.
  **Compare with** superposes another structure by a similarity fit over the beads the two share,
  reports the RMSD, and *colour by displacement* shows where they differ. Hover links every surface:
  a pointer on a map lights the beads at both ends and joins them (or, with the span modifier held,
  lights one bead); a pointer on a bead marks every map and tracks cell; a card under the pointer
  names the bead's sequence and coordinate; the pointer **snaps to the nearest bead within 14 px**
  with a cross cursor while it is aiming; the eye on a Structures row opens and closes the model's
  cell in the deck. **Marks** are three modes, a button and a key each — *mark a bead* (`e`), *mark a
  loop* (`o`), *measure* (`m`) — replacing a click-counter that had to guess which was meant: a mark
  is the bead again at twice the radius in the mark's colour, a measurement a drag between two beads
  with the model holding still, and **select mode** turns clicks into manual marks the same way on a
  map (two beads an arrowhead, offered as chords under *your marks*). The black lines over the model
  — a gap's dashes, a loop's chord — are half the tube's radius. A badge in the cell's corner says
  what a drag or click does; single-letter keys are bound only while the model is enlarged, so they
  no longer steal `f`/`a` from the Files/Annotations panels when a model sits beside a map. The
  enlarge dialog's sidebar is dragged to any width, remembered per file — the cell takes back the
  camera and colouring the reader left it with. A click pins, Shift-click marks, a double-click
  goes; bookmarks are named on the model; the export includes a vector PDF of beads and sticks.

  The place under the pointer is always named in the cell's corner, including on the model itself —
  one locus there, where a contact from a map is a pair. The sequence box of every structure task is
  seeded from what the map already shows (the locus inside one sequence, every sequence on screen
  when it spans several, empty for the whole genome); a model computed again onto the same row
  replaces the one the cell draws, and removing it empties the cell however it arrived there. Two
  analysis tasks: **model versus map** (distance matrices, distance by separation beside the map's
  P(s), Spearman agreement per sequence) and **spatial tracks** (radial position, distance to a
  locus, local compaction, as synthetic tracks). The deck gains cells that are not maps (§16.11): a
  **tracks cell** drawing the session's tracks alone, and **the browser as lead**, so a deck of
  tracks and a structure needs no map at all — the lead's window ghosts what the maps are not
  looking at. Demo models ship for the E. coli and yeast maps under `demo/`.

- **Model from the map builds one bead per bin, with no ceiling (§25.6).** The map task that makes a
  structure from the contacts the view is holding — the whole loaded block, cis and trans, by
  ShRec3D (contacts as distances `c^(−1/α)`, uncounted pairs filled, classical MDS) with SMACOF
  refinement, each pair weighted by how often the map counted it (count, its square root, or uniform
  — count by default; `α` and the step count exposed, a sequence or typed range restricts it, a
  table reports the fit) — now builds a bead per bin at the resolution selected. The *bins per bead*
  control, and the silent pooling that used to cap a model at the raster's 4,096-cell ceiling, are
  both gone: a coarser model is a coarser rung, which reads far less, rather than the one task in the
  app whose answer came at the window's resolution instead of the reader's own choice.

  The bead ceiling is gone with it. Both time and memory are quadratic, so the cost estimate says so
  — beads and their width, seconds per hundred steps, gigabytes of matrices — and the reader
  decides; only an allocation the browser will not give is refused, as a named error rather than a
  dead tab. The run holds two dense matrices where it held six, each built once at its final size;
  every phase — each rectangle read, each of the eighty sweeps of the classical start, each
  refinement step — reports progress, so the bar moves and a cancel always lands. A typed locus is
  priced as the bins of that stretch; over 10,000 beads is refused with the way out.

  The result is a **row**, not a picture: every model the session holds — dropped, named by URL, or
  computed — is listed on the Structures card with *show in the deck*, a **bed3d** download, the
  provenance of a computed row, and *recompute* after a reload; the structure cell gains a **model**
  picker, remembered per file, and draws a model the moment it arrives.

- **Track aggregates along a pileup's two edges (§18.8).** The APA takes any number of bigWig or
  synthetic tracks and averages each over the **same windows** the pileup is taken from — the real
  ones, never the shifted controls, which are the denominator of the picture rather than the picture
  — drawing them as profiles above it and beside it. That is the figure most papers using an APA
  actually print: the aggregate contact map with the aggregate signal on its edges, which turns
  *these places touch* into *these places touch, and this is what is bound where they do*. Until now
  a reader had to run the 1D metaplot separately over anchors they re-derived by hand, and the two
  aggregates were over different windows unless every setting happened to agree. Each profile is
  normalised on its own — two tracks in two units have no common axis, and what a marginal promises
  is the *shape* along the window — and is resampled by the window's **own** grid edges, so a cell of
  the profile is the cell of the pileup above it by construction rather than by a second resampling
  that could land a domain boundary a column out. `MatrixOutput.margins` is the general mechanism;
  the figure counts the bands in the height it asks for, or the top one would be clipped away.

- **The loop spectrum: a called set's score against how far apart its anchors are (§18.8).** The plot
  neither of the two figures beside it can give, because both average the distance away — a pileup is
  a mean over windows at every separation the scan covered, and the score histogram counts scores with
  no regard to where they came from. So a set whose 30 kb calls are loops and whose 2 Mb calls are
  noise is a plausible dot under a clean unimodal peak. Against distance the two commonest ways a loop
  set is wrong are visible at a glance: scores that **fall away with separation** are a detector
  reporting the distance decay it failed to remove, and scores **piled against the minimum-distance
  cutoff** are calls made on the diagonal's own shoulder. A cloud of points with a median line through
  it in log-spaced bands — the points are where the calls are, spread included; the line is the trend,
  in bands rather than a fit because nothing claims the relationship has a shape, and a median because
  a tail is exactly what is being looked for. Returned by the chromosight detector, by the chromosight
  pileup and by the ordinary APA over a loop set, where the ordinate is each anchor's own P2LL.

- **An APA window is cut about the point of the feature the reader chooses (§18.8)** — *start*,
  *centre* or *end*, strand-aware, the same three the 1D metaplot has offered since it existed and
  spelled the same way. It took the midpoint and never said so, which on a gene set is a pileup at
  whatever is half way along a gene rather than the figure anybody draws, which is the one at the
  transcription start site — and a metaplot set to *start* and a pileup beside it were then aggregates
  of two different anchor sets under one caption. The chosen point is also what a *generated* pair's
  separation is measured between, or the range and the picture would disagree about which pairs they
  are of, and the axis label says which point it is: *bins from the centre* over a pileup of four
  thousand TSSs is a caption for a figure nobody drew.

- **Previous runs are kept, and there is a way back to them (§18.4).** Pressing Run used to replace a
  result in place, taking the figure, the numbers and the parameters that produced them with it — and
  nothing about a finished result makes it cheap to produce again: a pileup over forty thousand
  anchors is a minute of range requests. The runner keeps the last **eight** runs of each task **on
  each map**, and the drawer offers `older` / `newer` / `latest` over them with each run's clock time
  and, in its tooltip, *which parameter differs from the latest*. Everything downstream follows the
  run on screen — the framing line, **recompute**, the CLI command, the TSV and the vector export are
  all that run's, because a result is a record and stepping back to one means stepping back to all of
  it. Not persisted, for the reason the framing is a snapshot: a history restored against a file that
  has since been re-binned would be a list of figures that no longer describe anything.

- **Zoom, as four buttons beside the region box (§5.4).** The scroll wheel on the map zooms the
  *picture* — the same block, drawn larger or smaller — and past the edge of what was read it stops.
  This is the other thing a genome browser means by zooming: a different **range**, re-read, with
  the region string updated to say so. The four are `10×` and `3×` out and `3×` and `10×` in,
  widest first, so the row reads as one axis of scale with the window you are on in the middle of
  it, and each is the exact undo of the one opposite. Two sizes rather than one because a single
  step is always wrong twice — three presses to leave a gene, or one press past the locus. Every
  press moves about the window's own centre. Against an end of the sequence the window slides in
  rather than asking for a negative coordinate; once a press outward would cover the whole sequence
  it *is* the whole sequence, named as such; inward it stops at the file's own bin size; and on a
  declared circle it wraps past the origin rather than clamping. Each greys itself when there is
  nothing in its direction to go to, and they navigate through the ordinary road, so three presses
  and three presses of the back button are the same journey in reverse.

  Zooming out is also what finally made a window across a circular origin *reachable*: the panel
  refused to name one window where the axis showed a sequence's tail and then its head, so the
  button greyed itself on exactly the view zooming out is most interesting from. Two runs of one
  sequence is one window on a circle, and it is reported as the region a reader would type —
  flagged as wrapped, because the Bookmarks card cannot write one as a BED interval and now says so
  in those words rather than claiming the picture is not at one place.

- **A resolution the file does not store, on the fly (§3.4).** A `+` past the coarse end of the
  resolution picker asks for one, and what can be given is exactly what is a whole number of some
  stored rung's bins added up. That covers both things a reader wants and neither of which a
  published `.mcool` reliably has: a **coarser** picture than its coarsest rung — 10 kb from a file
  that stops at 4 kb — and one **between** two rungs, like 3 kb on a `1 / 2 / 5 / 10 kb` ladder,
  which is three 1 kb bins and not a number anybody would have run `zoomify` for. 2.5 kb on that
  same ladder cannot be given, because a contact is recorded in a bin rather than at a position
  inside one, and the dialog says so in those words as the number is typed rather than greying its
  own button: *not a whole number of bins of any resolution this file carries* tells you to type 2
  or 3. Where several rungs divide the target the **coarsest** is used — same picture, a twentieth of
  the stored pixels walked.

  It behaves as a resolution and not as a rendering. The grid is anchored to each **sequence's own
  start**, so the same base pair holds the same sum at every pan and every zoom, which is the grid a
  real coarse cooler has; the zoom-to-refine ladder takes it as a floor and never reads past it; the
  whole-genome view takes it as a floor too and its own plan still wins where the picture cannot
  hold that many cells; and it rides in the link beside `balance=`, because a 10 kb map and a 1 kb
  map of one window are different pictures. Which resolutions you have added is a fact about the
  file, kept per file and carried in an exported workspace beside the sequences you declared
  circular. An added rung wears a `*` in the picker — in the label, because the number is what gets
  quoted in a methods section and this one is not in the file — sorts where its number says, 3 kb
  before 5 kb, and carries a `×` the file's own rungs do not.

  One caveat, printed every time it is offered: **counts add up exactly and balanced values do
  not.** `cooler zoomify --balance` sums raw counts and then balances the coarse matrix at its own
  resolution; this applies the fine weights and adds the results, which is what every aggregation in
  this field does and is a good estimate rather than the same number.

- **An APA's edge profiles are one aggregate over both anchors of every pair (§18.8).** Which anchor
  of a loop is written first in a BEDPE is whichever sits further left on the sequence, and nothing
  else: it is not upstream in any biological sense, not the cause of the contact, not the end with
  the factor on it. Profiled apart — which is what the edges did — the top of the pileup was every
  pair's second anchor and its right side every pair's first, so the two lines differed by whatever
  that arbitrary ordering happened to sort, and a reader comparing them read a difference between
  the two ends of a loop that the file never claimed. Each window now contributes **both** of its
  anchors to **both** edges, which is one mean over twice as many anchors: better estimated as well
  as honest. Pooled a window at a time rather than by averaging the two finished profiles, since the
  accumulators count per cell and a cell one of them never saw would otherwise be weighted as though
  it had. A tickbox turns it off for the file where the ordering *is* the figure — a BEDPE whose
  left column is always the promoter, say — and it is offered only off the diagonal, where the two
  axes cut the same window from the same feature and the two profiles are already the same numbers.

- **A barChart lane takes a fixed value axis (§8.17).** Both readings the format had were *relative* —
  every chart against the file's tallest bar, or each against its own — so a GTEx lane and a
  knockdown's lane laid side by side are each scaled to their own maximum, and the one with the
  quieter tail draws the taller bars and looks like more expression. The lane now carries the same
  **limits** row a signal track has, meaning the same thing: `auto` is what it always did, and a typed
  pair is an axis the bars are drawn against. It overrides the per-chart switch rather than composing
  with it, reaches the collapsed glyph so a lane zoomed out does not quietly change what its heights
  mean, clamps at both ends, and states both of its ends in the line under the lane's name — which is
  what makes the comparison it exists for possible.

- **A window may be typed straight across a circular sequence's origin (§8.15).**
  `chrom:2,900,000-100,000` is now a legal region on a declared sequence: cooler refuses an end below
  its start, correctly, because on a line it is a typing mistake — and on a circle it is the 200 kb
  either side of the origin, which is where the most local contacts are and is the one window a linear
  reading cannot ask for at all. The refusal is lifted for exactly the sequences the reader has
  declared; every other range keeps cooler's own error, now with a sentence on it saying where the
  tick is, because a reader who typed one usually meant it. A bad range also stays inline over an
  intact region box rather than reaching the full-screen error page, which was a long way back from a
  missing comma.


- **The store grid: Roadmap shipped as a hub, a link to whoever made each shelf, and two doors named
  for what they do (§24.2, §24.10).**

  **Roadmap (UCSC hub)** is a sixth built-in store, reading WashU's hub over the 111 reference
  epigenomes. It is the first shipped store that is somebody else's hub rather than a file this
  project generates — no shard list, no `stores/` entry, no workflow, no front of its own, just a
  `hub.txt` URL and the same `fetchStore` every store URL already went through. Its rows are read on
  the gesture that opens it, so the tile costs no request.

  **Every store now links to the people who made it**, from an arrow beside the download in the
  drawer's head: RSG's team page, IGV's genome documentation, 4DN's portal, ENCODE's matrix, DNA
  Zoo, Roadmap's WashU portal, and UCSC's `hgHubConnect` on the hub door. A store is somebody else's
  data and the rows are a translation of their catalogue, carrying none of the licence, citation or
  caveats they wrote down; this is the whole of what the viewer does about that. It is drawn as soon
  as a store is opened, read or not — the reader whose catalogue just failed to load is exactly the
  one who wants the site behind it.

  **The two doors are named for the errand**: *A track hub* is now **Connect to a UCSC hub** — a
  hub is somebody else's shelf, read where it stands, which is what *connect* means everywhere else
  on the page — and *Your own store* is **Add a custom store**, a file this viewer takes a copy of.
  The first wears UCSC's logo, and so does every hub a reader remembers; Roadmap wears its own
  emblem over UCSC's colour. The second wears this viewer's own icon, the file behind it being the
  one format in the grid written *for* this viewer rather than translated into it.

  **The grid wraps.** It was one row that could not, which was right while there were five tiles;
  there are eight now and a reader can connect more, so it is equal columns that fill the width and
  spill onto the next line, with the last line's tiles the width of the ones above them.

  `scripts/make-store-logos.mjs` grew three things to carry the new marks. An **incremental run**,
  so adding a logo no longer means re-obtaining the four whose sources are not committed. A
  **bleed** fit for a mark that is already a tile — the app icon is a squircle plate with its own
  margin and shadow, and containing it on white drew a plate inside a plate. And a **crop**, for a
  logo too long to letterbox: Roadmap's is 958x208, which whole would have set its wordmark at about
  five pixels on the landing page, so what is taken is the square at its left end.

- **Five UCSC formats, and track hubs as stores (§8.18–§8.21, §24.10).** Everything below is one
  change with one shape: the formats UCSC's browser reads that this one did not, and the index most
  of the world's published data is actually behind.

  **`interact` and `bigInteract`, `longrange` and longTabix (§8.18).** UCSC's interaction formats,
  which are the only ones it has that are about the thing this application is about: two places
  joined. Both become a `PairSet` — what a bedpe becomes — so both arrive drawn, as arcs across the
  matrix and as their own lane in the 1D browser, with no renderer written for either. Trans
  interactions survive as ordinary off-diagonal arcs rather than as the labelled edge marker a single
  axis forces on UCSC.

  This is a **correctness fix and not only an addition**. Both formats are BED-shaped enough to reach
  the BED sniffer, whose last line is `return 'bed'`, so neither was refused: an `interact` with a
  fractional `value` — UCSC's own examples write `5.000000` — was drawn as one box spanning both
  anchors *and the gap between them*, and an `interact` whose `value` happened to be a whole number
  matched the bedpe rule and was read as one, putting the interaction's **name** in the second contig
  and its display **score** in the second start. Arcs, drawn confidently, between coordinates that
  were never in the file. A `longrange` was a BED4 whose names were the coordinates of the arcs it
  should have drawn. A `longrange`'s reciprocal lines — the format writes every interaction twice so
  that a tabix query from either end finds it — are folded, and the lane says how many it folded,
  rather than every loop being drawn twice and every count being wrong by a factor of two.

  **`genePred`, `genePredExt` and `refFlat` (§8.19).** How the gene models of half the assemblies in
  circulation are distributed, and the gap with a number on it: the IGV store this project publishes
  was dropping **29 of IGV's 63 tracks** because they are UCSC `genePred` tables in a `.txt.gz`, and
  those 29 are the gene models — the first track anybody wants beside a sequence. They are published
  now. The same ten columns start at column 0, 1 or 2 depending on whether the file is a `refFlat` and
  whether it carries a MySQL dump's `bin` index, and eleven columns is ambiguous between the two — so
  the offset is not guessed from the width but *found*, by keeping the one where the file agrees with
  itself: a strand where a strand goes, and two comma lists whose length is the exon count and whose
  blocks tile the transcript. A `bigGenePred` already drew correctly, its first twelve columns being
  a BED12; what its schema now buys is being a gene model rather than a peak set.

  **`bedMethyl` and `bigMethyl` (§8.20).** Base-resolution modification calls, as the quantitative
  track they are — percent modified per base, with the range, ceiling, autoscale and colour every
  bigWig lane has. Read as the BED9 they begin with, which is what happened before, they were a lane
  of grey boxes one base wide with the measurement never mentioned. A file holding two modifications
  over the same bases draws the more abundant one and **says which it did not draw**, because those
  are two measurements and averaging them would produce a number that is in no file. The
  metagenomic case is the one this was really added for: bacterial 6mA and 4mC are strain-specific
  and are used to bin contigs, which is what the MAG layer is for.

  **`.2bit` (§8.21).** UCSC's packed sequence format, read by range. One file rather than a FASTA and
  a `.fai` — so every way §8.8's index goes missing simply cannot arise — at two bits a base instead
  of eight, which is 800 MB for hg38 against 3.1 GB. The gaps are read from the N blocks and painted
  over the unpacked bases, because the bits under a centromere are not blank but a convincing run of
  thymine; the mask blocks are stepped over and never fetched, being eight megabytes a chromosome for
  a lowercase this viewer discards twice over. A long (version 1) `.2bit` is refused by name rather
  than misread as wrong residues. The CLI reads one the same way, through the same arithmetic.

  **UCSC track hubs, as stores (§24.10).** Paste a `hub.txt` and its genomes and tracks become a
  shelf: grouped by assembly, narrowed by the hub's own composite and super-track names, with *open
  with its tracks* on every assembly's heading. An **assembly hub** opens its own `.2bit` as the
  genome — which is why that format is in the same release, since without it every assembly hub opens
  as tracks over coordinates nothing can read — and a **db hub**, which carries no sequence, falls
  back to its `chromSizes` and then to the first bbi file in its own trackDb — any `big*` type, a
  bigBarChart and a bigMethyl being bigBeds with a particular autoSql and nothing else — whose header
  carries the lengths. It never reaches for a `chrom.sizes` nobody asked for.

  A hub is recognised from its **content** at the one function every store URL already goes through,
  so a hub works in `?store=`, in the Connect box, as a remembered tile and in a shared link, and
  none of those had to learn the word — while a JSON store served from a file called `hub.txt` still
  opens as a store. Composite and super-track stanzas, `include` files, `useOneFile on` hubs,
  continuation lines and the indentation subtracks are written with are all read. A track whose type
  this viewer cannot draw gets **no row** and is counted with its reason in the store's description,
  because a row that misdraws when it is pressed is worse than an absent one. It has its own tile on
  the landing page, beside the one for a store file.

  **The shelf is what the hub asks for.** A published hub is not a short list: EPFL's Breast Cancer
  Epigenomics hub declares some 440 bigWigs across nine composites and asks for twenty of them. So
  *open with its tracks* loads the twenty, not the 440 — `parent <name> off` and `visibility hide`
  are the hub's own answer to what a reader should arrive to, and a hidden composite hides its
  children whatever their own word says, which is UCSC's rule. The verb's tooltip counts what it will
  load, and the store's description says `440 tracks, 20 on by default` when the two differ. Every
  track keeps a **row of its own**, because off by default is not absent: the reader who came for one
  particular ChIP still opens it over their own map.

  **A hub to try it on ships with the demo.** `scripts/make_demo_hub.py` writes a real assembly
  hub over the yeast demo data — a `.2bit` of its genome, the loop calls as `longrange`, the six
  bigWigs as a composite and the contact map as `type hic` — so the whole path can be walked with no
  third-party host and no CORS question in the way:

  ```sh
  npm run dev   # then paste http://localhost:5173/demo/yeast/hub.txt into the *Add a UCSC hub* tile
  ```

  The `.2bit` that script writes is checked with `py2bit`, a wrapper around the C in kent's own
  tree, so what the reader is tested against is a file UCSC's own code has already read back base
  for base — which a fixture this repository wrote could never be. Two loose files sit beside the
  hub for the formats a hub cannot legitimately carry (UCSC's remote types are the `big*` ones plus
  `bam`, `cram`, `vcfTabix`, `hic` and `longTabix`): the same loop calls as `interact`, and the
  demo's GTF as a `genePredExt` table.

  **The IGV store gained the rows this unblocked.** Its generator was dropping IGV's `refgene`
  tracks and every `.2bit` because there was no reader for either; both are read now, so the 29 gene
  models are published, they carry `format: genepred` whatever UCSC called the file — so one tick of
  the Format facet finds `refGene`, `ncbiRefSeq`, `refFlat` and `knownGene` together — and hg38's
  genome row carries its gene track on the shelf where it used to carry nothing.

- **A whole chart inside one feature: barChart and bigBarChart (§8.17).** UCSC's format puts a
  *vector* on each row — `expCount` numbers, one per category — and gene expression across fifty-four
  GTEx tissues is what it was built for. A dropped `.barChart` or a bigBed written with the barChart
  schema now opens as a lane of charts: one bar per category inside the bases the feature covers,
  named and coloured from the `track` line where there is one, and numbered where there is not,
  because the names live in a hub a dropped file arrives without — and the legend says which of the
  two it is rather than presenting positions as names. It is a `FeatureSet` like a BED and a VCF, so
  packing, search, export, the feature card and a metaplot over its intervals are the code a peak set
  already uses.

  Two things needed deciding rather than defaulting. **Where there is no room for bars** — a feature
  narrower than a pixel per category — the glyph becomes one box in the colour of the category that
  dominates it, at that category's height, so a lane at chromosome zoom still says *which condition
  wins here* long after it has stopped being able to say *which ones*. And **what the heights are
  measured against**: one ceiling for the file makes two glyphs comparable and is the default, but
  expression is heavy-tailed and against one ceiling the lane is flat except for the genes nobody
  needed a chart to find — so `scale each chart` in the lane's card measures each chart against its
  own tallest bar, and every glyph becomes a shape. The ceiling is stated under the lane's label,
  because a glyph that small carries no axis. A click opens the whole chart, one row per category
  with its colour, its bar and its number.

  A barChart lane is also the one interval lane with no `colour by` picker and no arrowheads: its ink
  is its categories' and is not a choice, and a control that silently does nothing is worse than an
  absent one. The demo folder gains `Yeast_expression.barChart` — real gene coordinates, synthetic
  numbers, and the file says so on its first line.

- **DNA Zoo is a shipped store.** Its open bucket is walked the way any lab's bucket is — the
  `bucket` front end, every object this viewer has a route for, read straight from the listing with
  no portal in between — and published beside the other four by the weekly Stores workflow. Most of
  what is in a directory is not a file this viewer opens, so `make_store.py dnazoo` applies two
  rules on top of the generic walk. A `.hic` carries its own index, so a corner of a 3.6 GB map is
  the bytes it needs and size is no reason to leave one out; nothing else on that bucket has one —
  the FASTAs are plain gzip with no `.fai`, the GFFs have no `.tbi` — so opening one is a download of
  the whole file, and past `--max-unindexed` it is a trap rather than an offer. Protein and
  transcript FASTA route as `genome` on their suffix alone and are not one.

  Each species' `README.json` supplies the rest, and it is worth the request. *Asian small-clawed
  otter* is how anybody but its authors looks for `Aonyx_cinereus`, so the shelf folds under the
  species with the common name in the heading. The README also names both assemblies, which is why
  the **Assembly** column is read from it rather than off the file name: the chromosome-length map
  is `Aonyx_cinereus_HiC.hic` under one species and `wild_pepper_final_14chr_HiC.hic` under another,
  and a rule built on `_HiC` is wrong about both ends of that. A species whose README cannot be read
  keeps every file it has and loses those two columns.

  The tile is a lettermark for now: DNA Zoo's logo is published under terms nobody here has checked
  and the file has not been supplied, so it falls back to the coloured square the mark was always
  designed to fall back to.

- **`make_store.py bucket --folders` names a bucket's directory levels.** A bucket knows a file's
  name, its size and the directory it sits in, and nothing else — so the `bucket` front end has
  always written a store with no columns and the folder glued to the note, which on a bucket laid
  out one directory per species is a flat list of a catalogue that was never flat. `--folders
  Species,Assembly` turns those levels into columns the rail filters on, taken from each key's own
  path. It adds no knowledge: the directories were already in every key the walk reported, and what
  was missing was a word for them, which only somebody who knows the bucket can supply. A key
  shallower than the names it was given leaves the deeper ones empty rather than guessing. Omitted,
  nothing changes.

- **A store's catalogue can be taken away with you.** There was no way to read the JSON behind a
  shipped store: a built-in's URL is never shown on the page, RSG has none at all because it ships
  inside the bundle, and *copy link* copies a `?store=` link carrying an id rather than the file. A
  download now sits at the end of the store's own line in the drawer's head, and writes the
  catalogue **as the drawer has it** — every row before your filters, shards merged into the one
  file on screen, and every `uri` made absolute, so what lands opens on its own rather than
  resolving against wherever it was saved. It is absent, not greyed, while a store is still being
  read or could not be: a disabled button there would say the file exists and this build will not
  hand it over.


- **A pasted Drive link opens under the file's own name.** A share link becomes the Drive API's
  media address, which ends in an id and says nothing else, so the loading screen, the tab and the
  router all saw `1Vs9WgmiQj3CMSaDrXNBzzV3tp72GTLu6` where a folder pick would have said
  `SB112b^mapped_CalTech4^B0AGU2.mcool`. Drive is now asked what the id is called before the file is
  opened — one `files.get` with `fields=name`, on the same key or token the read carries, once per
  file for the page — and the answer names the loading screen, becomes an empty tab's name, and
  chooses the door by its suffix, so a pasted `.mcool` opens as a map and a pasted `.bw` as a
  browser without the bytes being asked first. A Drive that will not say — a private file this tab
  is not signed in for, a site built without a key, a network that did not answer — costs nothing
  and changes nothing: the open goes ahead under the id, as before (SPECS §24.9).

- **A BAM with no index opens, and draws its reads.** A BAM was read through its index and
  nothing else, and a file without one was refused by name with `samtools index` — the right
  answer for a file on a disk and the wrong one for the two hosts the store drawer offers most:
  neither 4DN's open-data bucket nor ENCODE's public bucket publishes an index beside *any* of
  its BAMs, so every BAM opened from either store answered *No index could be read* and drew
  nothing. A coordinate-sorted file is now searched instead: the first read at or after a
  position is found by binary search over the file's bytes, each probe a ranged read that inflates
  a block or two and recovers a record boundary inside, and the probes are kept for the next
  window. The row's summary says *reads located by search* and names the index it did not find; a
  window then draws exactly what an indexed file draws, to a block rather than to a record, and
  from 16 kb before its start (SPECS §8.13, docs/hosting.md). A file dropped from a disk without
  its `.bai` opens the same way.

- **A BAM whose reads are out of order is refused with the two places that show it.** Every BAM on
  4DN's bucket is a Hi-C pipeline's alignment output, in read-pair order for the pairs step that
  follows it, with no `@HD` line to say so. The search holds its probes to the order the file
  claims, and refuses one that fails — *the reads at byte 43,712,010 are on chr2:1,004,120 while
  those at byte 306,984,070, later in the file, are on chr1:9,512* — naming `samtools sort` and
  then `samtools index`, and saying that the `.pairs` or the contact map beside such a file is the
  one to open.

- **The site signs readers in to their own Drive and Dropbox.** The Google client id, the Google
  API key and the Dropbox app key were three boxes every reader had to fill, from a project of
  their own, before *sign in* would light up. The published site is now built with the lab's
  three, read by the deploy from the repository's `GOOGLE_CLIENT_ID`, `GOOGLE_API_KEY` and
  `DROPBOX_APP_KEY` variables — none a secret, all served in the page — so **Connect → Google
  Drive** and **Connect → Dropbox** offer their sign-in at once, and a reader reaches a private
  folder of their own with one press. The dialog says whose value it is using; one pasted by hand
  still wins, for a lab with a project of its own; and a build made without the variables is the
  build there was before (SPECS §24.7, docs/deploy.md).

- **A lane says what it is waiting for.** A sequence lane read by range sat blank while its window
  was on its way, and a BAM's row said *reading…* for as long as its thirty-megabyte index took.
  The worker now reports how far a read has got — a whole file downloading for a row, a window of
  an indexed sequence fetched by range — and the lane draws *fetching 1.2 of 4.0 MB* with a bar
  where its limits would go, on the browser and beside a map alike; the Tracks card draws the same
  words and bar under a row whose file is still coming. Where the host would not say how much is
  coming the bar sits half full rather than at nought.

- **A lane that will not draw at this zoom says so.** An indexed sequence over a window wider than
  4 Mb answers *GC under 4 Mb, letters at base resolution — zoom in* under its name, instead of
  nothing. The line is judged over the whole request: a whole-genome view of *bosTau9* is thirty
  chromosomes over it and two thousand scaffolds under it, and the scaffolds were being read one
  request apiece — a lane that stayed empty for minutes while it did.

- **ENCODE's genome and file-kind facets are multiple choice.** They were radios, so one shard was on
  screen at a time and the same dataset on two assemblies, or a dataset's signal beside its peaks,
  could not be seen in one list. Tick two genomes and both shards are read and shown together, the
  matrix crosses the union, a link carries the choice as two facets, a shard read once is kept, and
  a shard not written yet is a sentence beside the rows that were.

- **A large FASTA opens at once, through its index.** Opening IGV's *Galgal6* — a gigabyte of
  sequence — read the whole file into the annotations worker before the browser could appear, or
  refused it past 300 MB, because a FASTA was the one format held whole: every sequence in memory,
  which is what made every zoom draw GC content and every pan free. Over **64 MB** it is now read
  by its `.fai` instead (SPECS §8.8, `annotations/fai.ts`): the assembly is the index's first two
  columns, a window of residues is one ranged read at the byte the index puts it at, and nothing of
  the sequence is fetched until a lane asks for it — so the browser is on screen the moment a
  kilobyte of index has arrived, and the sequence loads beside it, a window at a time, in the
  worker that always held it. The index is `<url>.fai` unless named with `#index=` or dropped
  beside the file, on the terms every other sidecar already had; under 64 MB nothing changes, and a
  large FASTA with no index is read whole as before, or refused by a sentence naming
  `samtools faidx`. What an indexed sequence gives up is what needed the whole of it: its GC lane
  is blank over a window wider than 4 Mb, the motif search declines it in a note, and an alignment
  lane colours mismatches only from what the sequence lane has already drawn. `make_store.py`
  writes the index into every IGV genome's row and session, and a lane's summary says *read by range
  from its index* so a reader knows which of the two they have.

- **The store drawer is on the backslash key.** A panel at the window's edge on a punctuation key,
  as the console is on the backtick: `\` folds the stores out and back, is printed on the header
  button and listed with the command, and stays a backslash inside any box, the drawer's own search
  field included.

- **This chromosome is circular — and then the map slides round it.** A tickbox in
  the **Map** card, on any view that is a window on one sequence (SPECS §8.15). A `.cool`
  cannot say that a sequence joins its own ends, and nothing can infer it — a bright far
  corner is a circular chromosome, or a translocation, or an assembly error — so it is a
  declaration, kept per file and carried in an exported workspace.

  With it the window becomes **unwrapped**: it runs off either end of the sequence and
  comes back on at the other, so a square across the junction is up to four stored blocks,
  one of which is the far corner where the contacts joining the two ends of the molecule
  live. Panning past the end reads the same block width rotated round to where you now
  are — in the square view and under the turn alike, and with no limit but one lap, past
  which a bin would be drawn twice. Ticks, the coordinate readout, tracks, features and
  hand-drawn marks survive the join, because the block's axis carries the sequence twice
  and says which lap each half is on; a mark is now drawn at *every* place its locus lands
  rather than the first, or it would flicker in and out as you slid past the junction.

  And the numbers follow, automatically and with no per-task tickbox: the separation
  between two bins becomes the shorter of the two ways round, and the longest separation a
  sequence has becomes half of it. **P(s)** stops turning back up at the far end — that
  upturn is the two ends of the molecule wearing a chromosome-long separation, and every
  fit through it is a fit through an artefact — **diamond insulation** scores the bins at
  the junction it used to leave as gaps, and the directionality index, the HiC score and
  the scalogram wrap with them. What does *not* yet: compartments, chromosight and the O/E
  map divide by an expected curve at a linear separation, and a deck companion draws the
  sequence linearly. Both are stated at §8.15 rather than left to be found.

- **Three more readings of the near-diagonal, and a fourth normalisation for the 4C.** The catalogue
  (SPECS §18.8) gains the **directionality index** — Dixon et al.'s signed χ², the other answer to the
  question the diamond asks, with its window in bins like the diamond's and defaulting to 50, which is
  Dixon's 2 Mb at the 40 kb his paper worked at; the **HiC score**, the sum of every cell in a square window centred on each bin,
  which is the reading Bignaud et al. use where the question is how tightly a stretch is folded rather
  than where a domain ends; and the **scalogram** (Cournac et al. 2012, `HiContacts::scalogram()`), which
  is P(s) with one summation left undone — at every bin, the separations at which its contacts reach each
  of a set of quantiles. All three read a **band and never a square**, so a 2 Mb window on a mammalian
  chromosome is a run rather than a refusal.

  The 4C's *Normalisation* becomes one control with four answers — none, by coverage, by P(s), by both.
  Coverage is the other bias and a different one: the decay is a property of separation, coverage is a
  property of the target bin, and on a raw map a repeat-rich bin is a dip in every profile drawn against
  it whatever the anchor. The divisor is each bin's own total contact centred on one, so a raw profile
  stays in contacts and an O/E ratio stays centred on one. With trans it means the pixel walk can no
  longer stop at the anchor, and the estimate says the pass is the whole file rather than half of it.

- **The directionality index calls TAD borders and domains.** The same two overlays the diamond
  produces, and through the same kernel. A domain reads as a *shape* along the index — the 5′ half looks
  downstream, the 3′ half upstream — so a border is the negative-to-positive flip between two of them.
  Called flip by flip that is fragile: a track that stutters across zero has crossings a bin apart and
  only one is an edge, and the rules that pick it are the rules of prominence written out badly. So the
  index is **integrated** first. The running sum climbs through every downstream-biased block and falls
  through every upstream-biased one, which makes each border a local minimum and each stutter a dimple on
  the flank of the real trough — exactly what `callBoundaries` already distinguishes, for the diamond,
  with tests. One implementation decides what a called edge is; both overlays filter on the same column
  and tile the same way; and the call lands one bin past the minimum, which is the opening bin of the new
  domain rather than the closing bin of the old one.

  The curve is standardised by the median absolute index before it is integrated, so the prominence is in
  **bins of ordinary directional bias** rather than in χ². A χ² grows with how deep the library was
  sequenced, so a threshold in the index's own units is a different threshold on every file; this one is a
  property of the structure, and a value found on one map is worth typing into the next. Dixon's own HMM
  differs in one visible way, stated at §18.8 rather than left to be discovered: it leaves stretches it
  calls unorganised in no domain at all, where borders-between-borders tile.

- **Ribbons: a lane style for a set of quantiles (SPECS §18.12).** A `ribbon` fills the band between its
  own curve and the curve of the member below it in the same lane, so the scalogram's five quantiles draw
  as one nested shape rather than five lines and a legend. Four filled areas cannot express that — they
  paint over each other in the order they were drawn. Ribbons tile rather than overlay, so they are not
  dimmed; the lane's order is the nesting order; a band exists only where both its curves do; and only
  the top edge of each is stroked, since the lower one is the neighbour's. A `ProfileOutput` may now also
  suggest a **display scale**, which is what puts the scalogram on a log axis — its values are genomic
  separations, and on a linear axis all five bands live in the bottom tenth of the lane.

- **Genomic features are drawn as what they are: coloured by strand, pointing the way they run, and
  banded so the two strands are two places.** Every interval lane — a BED, a peak set, a bigBed, a
  gene model, a VCF — used to be one flat colour with the direction hidden in a tooltip, which meant
  a screenful of boxes said *where* and nothing else. Three changes, on all of them at once, because
  they are one renderer (§8.16):

  - **Strand is the default colouring**, in three colours: forward keeps the colour on the lane's own
    chip, reverse is that hue turned most of the way round, and a feature whose file carries no
    strand takes the grey this app already draws an `N` in and already gives a variant with no single
    base behind it. The two hues come from the reader's own colour rather than a fixed blue and red,
    so four peak sets on one screen are still told apart by the colours they were given — the same
    argument an alignment lane's categories already make. A file with *no* strand in it — a peak set,
    most BEDs — keeps its one colour rather than turning entirely grey, since a grey meaning "no
    strand" says nothing where nothing has one.
  - **A stranded feature is pointed.** The head is cut *out of* the leading end rather than drawn
    past it, so the glyph covers exactly the bases the feature does and what is clicked is still what
    is drawn; a long one carries chevrons through it as well, so a segment spanning the window says
    its direction at every point. Below six pixels there is no head, because a pentagon three pixels
    wide is a rectangle that has lost a pixel. A gene *with* exons keeps the chevrons on its spine and
    takes no head — a point on its last exon would be a point on a piece of the gene rather than on
    the gene.
  - **The rows are banded**: unstranded, then forward, then reverse, outward from the map. Two genes
    on the same bases and opposite strands used to be two boxes one above the other with the
    difference carried entirely by colour. The bands are read from the *file* rather than from the
    window, so panning never rearranges the lane, and whether they fit is asked of the lane's height
    rather than of the rows a *label* needs — so a segments lane at its default sixteen pixels, which
    is exactly where a stranded BED lands, bands into two rather than never banding at all. Below
    eight pixels a band would be a hairline, and the lane falls back to the packing it always had.

- **A drop-down on every interval lane, to colour the segments by any column the file carries.**
  `source`, `biotype`, `signal`, `-log10 q`, `QUAL`, `filter`, `score` — whatever the parsers wrote.
  The keys are read back out of the joined attribute string each feature carries (§8.3's decision,
  and this is what it costs), sampled across the whole file rather than its head, cached per set and
  bounded at twenty thousand rows — so a picker over a four-million-line annotation opens as fast as
  one over a BED with nine lines in it. A categorical column gets the same colour-vision-safe palette
  a metadata strip uses, handed out commonest-first with a twelfth-and-beyond `other` bucket; a
  numeric one gets a `viridis` ramp fitted to the file, never to the window — a colour that meant one
  thing before a pan and another after it is a legend that lies without saying so. The key sits in
  the card under the picker, built from the same function the renderer calls, and the chip on the
  lane's name becomes a colour that is actually in the lane.

  A choice whose column the open file does not have is **kept and marked** rather than quietly
  corrected, because the same session opened against the other half of an experiment should colour by
  `biotype` again the moment the GTF comes back. Nothing here refetches: a feature set is in memory
  whole and a field is a column of it, so a dozen answers cost one repaint between them.

  Alongside it, a **point strands** switch for the readers and the figures that want the plain
  rectangles back.

- **Public data stores: IGV's genomes, all of 4DN, all of ENCODE, and sessions with the tracks
  already on.** The two shipped portal stores listed contact maps and nothing else — 1,200 rows
  of 4DN and 200 of ENCODE — and the filter that did it was on the *experiment*, which needed
  editing every time a consortium published something new. The rule is now on the file: if this
  viewer has a route for the name, it gets a row. So the shelves are:

  - **IGV genomes** (new). The reference genomes IGV ships, read from the same
    `igv.org.genomes/genomes.json` the IGV desktop app and igv.js load their menu from, plus every
    annotation track published beside them. Each URL is probed with a ranged GET — the request the
    viewer itself makes — which records the size that table does not carry and settles whether the
    file opens without credentials. Two sets of rows fall out: IGV's 29 `refgene` tracks are UCSC
    `genePred` tables this viewer has no reader for, and six genomes' sequences are not public at
    all — `igv-genepattern-org` answers `403 AccessDenied` anonymously, which takes out IGV's own
    `hg38` and `hg19` (GRCh38 stays on the shelf through IGV's `hg38_1kg`, on the public
    `1000genomes` bucket). Both are named in the run's log rather than shipped as rows that fail
    when they are clicked.
  - **4DN open data**, ~25,700 rows where it was 1,200: the bigWigs, peaks, pairs, bedGraphs and
    BAMs as well as the maps.
  - **ENCODE**, ~210,000 rows across twelve shelves. ENCODE's manifest holds 1,209,805 released
    files this viewer can open; the default breadth keeps one per dataset, assembly and format —
    every dataset it has — and each row says how many files it stands for. `--breadth full` and
    `--breadth all` publish the other two answers.
  - **Preconfigured sessions**, three shelves of them. A row is a whole saved session: pick
    *IGV hg38* and the sequence and its gene track are on screen together; pick a 4DN experiment
    set and its richest contact map opens with the bigWigs and peak files of the same set on it.
    This needed no new code in the viewer — a store row could already be a workspace (§24.1) —
    only a generator that writes the files.

  The drawer offers all of it as four tiles rather than eighteen menu entries: the ENCODE shards
  are the *Genome* and *Files* facets of one ENCODE page, IGV's sessions are the button on each
  genome's card, and a portal's sessions are an action on a group of rows rather than a shelf of
  their own. A list draws a window of a thousand rows while the facets count over all of them —
  126,000 rows of eight cells is a million elements and a tab that stops on every keystroke.
  Nothing is fetched until a tile is pressed, which is unchanged and is why eighteen files cost
  what three did.

  `scripts/make_store.py` grew an `igv` front end and reads **two sources** per portal instead of
  one: a *spine* that says which files exist, from a place that cannot be incomplete (4DN's bucket
  listing, ENCODE's daily `encode_file_manifest.tsv`), and an *enrichment* that says what each one
  is of, from one lean portal search keyed by accession. The old portal-only 4DN query embedded the
  experiment *set's* processed files and not the per-experiment ones, so it was missing about nine
  files in ten and said nothing about it. `--portal require|optional|skip` decides what an
  unreachable portal means; `--sessions-dir` writes the sessions. `.github/workflows/stores.yml`
  publishes all of it, and two things about the `stores` branch changed with the volume: it is
  force-pushed as one orphan commit (100 MB a week as commits is five gigabytes a year for a store
  whose only interesting state is its tip), and *nothing changed* is finally a real answer —
  compared on a fingerprint of each file with its timestamps removed, rather than on bytes that
  could never match. SPECS §24.3 has the measurements and the reasoning; `docs/stores.md` is the
  operator's page.

- **Stores: a shelf of named datasets, and any lab can publish one.** A store is one JSON file
  beside the data (`kind: "metacooler.store"`, SPECS §24): maps, genome files and whole workspaces
  with columns to filter on — assembly, biosource, assay, lab — so a reader chooses without opening
  anything. The app draws each as a page of its own in the store drawer (under *Changed* below) and
  ships the lab's own — the four published figures, with the data files under them — beside the
  public ones, regenerated weekly from the portals by `.github/workflows/stores.yml` and published
  beside the app by the deploy. Paste a URL under *Your own store* to connect a lab's, or arrive on
  it with `?store=<url>` beside `?config=` and `?embed=`. A row may be a workspace, which is what a
  *pre-configured session* is; a row carries its size so the cost is on the table before the
  click. Nothing is fetched on load: a store is read when it is chosen.

  `scripts/make_store.py` writes one: `4dn` and `encode` from the portals' own search APIs (every
  processed file with an open-data URL, no experiment-type filter, so Micro-C is in), and `bucket`
  from a prefix on any S3-compatible store — the catalogue `docs/hosting.md` always promised. The
  motivation, the measurements and the comparison with juicebox.js are in
  `docs/remote-sources.md`: the unmodified viewer already opened a 2.2 GB 4DN `.mcool` in 7.8 s
  over 13 requests; what was missing was a name for it.

- **Links that were not yet the file now open as pasted.** A Dropbox share link is read from the
  content host; a Google Drive share link becomes the Drive API's ranged form (a public file needs
  the lab's API key, kept beside the bucket keys; a private one, the account below); `gs://` and
  `storage.cloud.google.com` become the GCS JSON-API form, which answers CORS for any origin; and
  `s3://bucket/key` resolves through a bucket scope that names the bucket, else to the
  virtual-hosted URL. The rewrite runs wherever a URL becomes a URI, so a shared link already
  carries the working form (`src/sources/rewrite.ts`).

- **Presigned S3 URLs, signed GCS URLs and Azure SAS links open**, until they expire. The `HEAD`
  probe that a single-method signature refused is skipped when the query carries a signature, and
  the one-byte range probe the reader already had takes its place. `docs/hosting.md` no longer
  says otherwise.

- **Sign in to Google to read private Drive files and GCS objects.** The lab supplies a client id
  registered for the app's origin, as it supplies a bucket key (**Connect → A Google account**);
  the token lives in this tab's memory, is never written down, and rides every request as a
  header; a `401` or `403` from a Google host offers *sign in* on the error screen instead of the
  CORS explanation, and retries the open once it succeeds. The dialog says the one thing a consent
  screen buries: `drive.readonly` is all of the reader's Drive, where a bucket scope is one prefix.
  Absent in the standalone build, which has no origin to register, and in the desktop build, whose
  `app://` origin Google will not register either; the API-key half stays in both. Nothing here
  could be exercised against Google from where it was written — `docs/hosting.md` ends with the
  five-step check to run once, and it is the one item of this release still to be confirmed by hand.

- **A Google Drive folder and a Dropbox, as connected folders.** Both join the Files column
  behind the same `ConnectedFolder` interface as a disk and a bucket (SPECS §24.9): one level at a
  time, a thousand entries, then *truncated*. A Drive folder — My Drive, or a folder named by link
  or id, shared drives included — is listed with the signed-in account, folders first, Google-native
  documents left out; a picked file opens at the same API address a pasted share link does, and
  the map takes the file's name. Dropbox is the one provider with an account and no key: the lab
  registers a scoped-access app, the reader signs in through PKCE with the code Dropbox shows and
  the reader pastes — no redirect, so it works on any origin, the desktop's included — and the
  whole Dropbox the app was granted is browsable; a picked file is a temporary link, unsigned and
  valid four hours, which is what a shared address then carries. Tokens live only in this tab; the
  refresh token Dropbox offers is refused. Neither could be exercised against its provider from
  where this was written; `docs/hosting.md` carries the manual check for each.

- **The README says what already works.** Object storage, not one vendor: R2, MinIO, Azure with a
  SAS, GCS through its JSON-API URL and the 4DN and ENCODE buckets all opened before this release;
  `docs/hosting.md` ends with the table, host by host.

- **A console, along the bottom, holding the commands your day was made of.**
  Every analysis run is now recorded the moment it runs, written as the
  `metacooler-run …` command that repeats it — the same line the drawer's **copy
  CLI command** button hands over, from the same provenance, so the two cannot
  drift. Press the terminal mark in the header (or `` ` ``) and the log comes up
  as a drawer over the bottom of the window: a shadow, a draggable top edge, and
  Escape to put it down. Nothing about it is modal — every shortcut keeps
  working behind it, and closing it stops nothing.

  **Run on all maps writes one line per map.** A batch over a deck of six is six
  runs against six files, and the drawer can only ever show you one of them, so
  five of those commands used to exist nowhere. Each row names the file it
  measured and how long it took, and a run that **failed** or was **stopped**
  keeps its line with the reason on it — which is exactly the run whose
  parameters you want back.

  Beside the runs: the files you opened, the tracks you loaded and every file
  the app wrote. Not navigation — a minute of panning would bury the rest.

  What copy and save hand over is a **script**, not a transcript: commands bare,
  everything else commented, days as headings. A day pasted into a file runs, in
  the order you ran it, with the afternoon around it left in as context. Each
  day heading carries its own copy button, because "the commands I ran on
  Tuesday" is the question this is for. **save** writes the same text as a
  `.sh`.

  The **output** toggle is the choice between a script and an archive: off, a
  row is its command; on, each row is preceded by the full provenance block —
  build, task and version, framing, every parameter — which is the header every
  exported file already opens with. It governs the clipboard as well as the
  screen. The caveats a command carries about what a shell cannot be told are
  never hidden by it.

  Three things the command writer had been getting wrong surfaced the moment a
  whole afternoon of runs was on one screen, and all three are fixed where they
  live — so **copy CLI command** in the drawer is fixed with them. A run in a
  **1D browser session** has no contact map, and the command opens one as its
  first argument: it used to name the bigWig that declared the assembly, which
  reads perfectly well and dies at the open, and is now refused by name with the
  button greyed to match. A parameter whose load *is* its own flag — `motif`
  calls its reference `sequence` — wrote `--sequence ref.fa --sequence ref.fa`
  and now writes it once. And a session framed against the assembly is named by
  its **file** rather than by its whole address, so a bucket URL no longer fills
  the drawer's heading and a console row.

  Kept in this browser for **seven days or five hundred lines**, whichever comes
  first, and nowhere else. A run the window walked out on comes back marked
  *interrupted* rather than as a failure nobody saw. **Forget everything** drops
  it, and the storage dialog names it on its own line rather than counting it
  among the settings — it is a list of the files you opened, and you should not
  have to press the button to find out it is there. An embed has no console at
  all.

- **Every pull request gets a preview on the site.** A branch of this repository opened as a
  pull request is built as a pinned copy and published at `…/pr/<number>/` beside the archived
  pushes, replaced on every push and removed when the pull request closes; the About dialog lists
  the open previews in a group of their own, and the pull request carries one comment with the
  address. The preview job writes the archive branch and asks the deploy to publish, so the site
  keeps one publisher (`docs/deploy.md`, "Pull requests get a preview").

- **Five new analysis tasks, and two existing ones grown a question they could
  not answer.** Every one of them is a measurement the app could not produce
  rather than a rearrangement of one it already draws, which is the line §18.9
  draws and the reason each is argued where it is built.

  **Reproducibility, across the maps on screen.** The deck opens N files under
  one navigation, blends two in a square and overlays their curves — and every
  one of those answers *do these look alike* with a picture. The question people
  actually have is *are these replicates*, and its answer is a number. HiCRep's
  stratum-adjusted correlation (Yang et al. 2017), ported: both maps smoothed
  with a 2D mean filter, each diagonal correlated **separately** — where the
  decay the two share is a constant and carries no variance — and the strata
  pooled by the Cochran–Mantel–Haenszel weight. Plain Pearson on two matrices
  comes out near 0.9 for two *unrelated* maps of the same assembly, which is why
  the stratifying is the method rather than a refinement of it. Reads a band
  rather than a square, so a mammalian chromosome is a few dozen bounded reads.
  Three outputs, and the third says more than the scalar does: the N×N
  coefficient matrix, the per-sequence table, and **correlation against
  separation**, which tells *these agree near the diagonal and not far from it*
  — a depth difference — from *these disagree everywhere*, which is two
  experiments. A map on a different bin grid is refused by name, because a
  stratum is a diagonal offset in bins and §16's lock is in base pairs on
  purpose.

  **Per-cell contact QC on an `.scool`.** That container's whole interaction is
  one decision — which cells to sum — and the Cells table could only rank them
  by `nnz` and `sum`, which is what the *writer* recorded and a statement about
  the sequencing rather than about the contacts. Depth is also the least
  interesting axis a single-cell library varies along: cells differ mostly by
  where in the cycle they were fixed, and a pseudo-bulk across phases smears
  exactly the structure somebody opened the file to see. Per cell, from its own
  pixels: contacts, cis fraction, and the share in each of four separation bands
  — Nagano et al. (2017)'s, whose near-against-mitotic scatter is the cell cycle
  drawn as a horseshoe. It costs what summing the same cells costs, to the read:
  the same reads in the same order, one accumulator per cell instead of one
  shared. The numbers land back **in the Cells table** as sortable columns,
  because the gesture they are for is the one that table already has — sort,
  tick a run of rows, sum them. No phase is assigned: the bands are a
  measurement with a citation and a cut through the horseshoe is a method with
  choices.

  **Cis and trans per sequence**, with the sequence × sequence square beside it.
  The first number any Hi-C paper quotes, per sequence rather than per bin, and
  the off-diagonal read against what the two sequences' own trans coverage
  predicts under indifference. Above 1 is a translocation, a fusion, a
  centromere cluster or a Rabl configuration. It is the inter-MAG network's own
  accumulation with the group being a contig rather than a genome — and it is
  **not** a translocation caller, for the reason §18.9 gives about any second
  caller.

  **Fraction of signal in features** — ChIP-seq's FRiP, over any loaded tracks
  and any interval set. The covered fraction sits beside it and the ratio of the
  two is the column to read: thirty per cent of the signal in thirty per cent of
  the genome is a track with no preference at all.

  **A shuffle null under interval overlap.** Jaccard, shared bases and features
  hit are all descriptive and none has a scale, so *how many of my loops sit on
  a boundary* — the question §18.8 gives as the task's whole reason — was not
  actually answerable. `bedtools shuffle`'s null: one set relocated at random
  within the sequences it already occupies, keeping its count and its lengths.
  Reported as a fold, a z and a permutation p on the tail the observation fell
  on, with Phipson and Smyth's `+1` so the p has a floor instead of coming out
  at zero.

  **Every pair of a feature set, and pileups split by separation.** APA gains a
  third anchor mode: rather than a loop set somebody produced, every pair of one
  feature set inside a separation range — which is the test a loaded BEDPE
  cannot be, since a BEDPE is already a claim about which pairs matter. And
  either off-diagonal mode may be split into log-spaced separation bands, each
  with its own pileup and its own control, because one pileup over 30 kb to 2 Mb
  is an average of a strong short-range contact and a weak long-range one.

  **The four pair orientations, beside P(s).** Read from the records during the
  import's own pass and at record resolution, because binning sums the four
  together and destroys the one thing they are for: the separation at which
  `++`, `+−`, `−+` and `−−` converge is the shortest one a library can be
  believed at, and it is usually *below* whatever grid the reader chose. A
  `.pairs` that was never imported can be named in the form and read for its
  records alone. §3.7's *nothing about strands is read* is narrowed in the open:
  its reason was **filtering**, no strand reaches a bin or a pixel or the written
  `.mcool`, and the pixels are identical whether the columns are there or not —
  which is asserted rather than claimed.

- **A lane can draw its values as colour, and multi-scale insulation does.**
  `heatmap` joins line, area and bars in the **style** picker: the value becomes
  a colour across the whole lane instead of a position in it, so it costs no
  height. A lane whose tracks *all* draw that way divides its own thickness
  between them and stacks them, keeping the height the reader set — two
  translucent lines in one lane are legible because ink adds, but two
  translucent colour maps are a third colour that means neither.

  Diamond insulation at several windows now arrives as exactly that: one group,
  overlaid, **widest window at the top**, sharpening downwards, so a boundary
  that survives every scale reads as a column through the stack. It used to
  arrive as four lanes of crossing curves on four autoscaled axes. A run with a
  single window is unchanged.

  The colours are read from the data unless you choose: values that straddle
  zero get a diverging map centred on the zero, values that do not get a ramp.
  The per-lane picker sits beside the style and appears only when the style is a
  heatmap.

  Two smaller things came with it. A stacked lane writes **a name per row**, in
  the row it names, rather than one line of four names across whichever row it
  lands on; and the **Synthetic tracks** card carries the style picker, which it
  had to — it is the only card that lists a computed row, so a style offered
  only on the Tracks card was one an insulation lane could never be given.

- **A comparison of two tracks is a synthetic track.** Combining two loaded
  bigWigs used to open a row on the **Tracks** card, among the files it was
  computed from — the one card with no exports on it, so there was no way to get
  a ratio out of the app at all. It lands on **Synthetic tracks** now, beside
  what the analysis panel computed, with the provenance line and the three
  exports every computed track carries: **bigWig**, bedGraph and TSV.

  The lane itself is unchanged and still lazy: it cuts at every boundary of
  either operand, so the step function it draws is exact at any zoom. A *file*
  has to be on some grid, so the export evaluates both operands onto the map's
  own bins — the same grid every other synthetic track is written on — and says
  so in its header, because a reader comparing the file against the lane should
  be told which of the two they are holding. Where a lane brings `x / 0` back
  onto its axis, the file writes no value: an infinity cannot go in a bigWig.

- **Each track's lane has a scale: linear or log₂.** Beside the drawing style,
  on the Tracks card and on Synthetic tracks. It is a display scale and nothing
  else — the numbers behind the lane, and every number that leaves it as a file,
  are untouched — and the logarithm is taken of the *pixel*, not of every
  interval under it, because a log axis draws `log(mean)` and not the geometric
  mean. A value at or below zero has no logarithm and is drawn as a gap, so log₂
  suits a ratio and not a difference.

### Changed

- **A pileup's axes are numbered in base pairs, not in bins (§18.8).** The APA, chromosight's
  pileup and the chromosight APA all drew a picture whose axes said *Bins from the centre* and
  carried no numbers at all. They now read *Distance from the centre* — or from the feature's start
  or end, whichever the window was cut about — with five labels along each axis: `-21 kb`,
  `-10.5 kb`, `0`, `+10.5 kb`, `+21 kb`. A count of bins is a number only a reader holding the
  resolution in their head can use, and a different number for the same window at every resolution.
  A scaled window keeps its own `0 → 1` labels, its axis being the feature rather than a distance.

- **The Structures card has no box to paste a URL into either (§5.11).** It arrived with the 3D
  card after the Tracks, Contact maps and deck rows were cleared of theirs, so it kept the one
  pattern every other card had lost: a drop zone with *or open one by URL* folded under it. The
  rule is the card's shape rather than a list of cards — what a card that asks for a file needs is
  the drop zone and nothing under it. A structure held at an address still opens by every road it
  did: the landing page's own box, a saved session, a `#uri` link, or the Files column.

- **A sequence is declared circular in the Chromosomes table, in a column of its own (§8.15).** It was
  a tickbox in the Map card, which was the right card for what the flag *changes* and the wrong place
  for what it *is*: a declaration about the assembly — which of these sequences is a plasmid, which is
  the mitochondrion — asked one sequence at a time, of whichever one happened to be on screen.
  Declaring three of them meant opening three maps, and there was nowhere at all to *read* which had
  been declared. The column sits **last**, after every column the file itself carries — it is the one
  column that is not in the file, a declaration the reader makes rather than a number somebody
  measured, so it goes where a reader's own additions go rather than interrupting the run of the
  file's own fields. The filter row's own tick narrows to the sequences that carry it, which is what makes the question answerable on a draft
  assembly with three declared contigs in a hundred thousand; and the **Sequences card in the General
  panel wears a `↻` beside each declared name**, so a reader at work is told the answer rather than
  offered a second place to click. A map already on screen adopts the change without being rebuilt, so
  the reader keeps the zoom they needed in order to be somewhere the question was worth asking from.

- **The resolution picker is a slider over labelled stops, at the far end of the top bar (§5.5).** It
  was a dropdown of raw bin counts — `1000`, `5000`, `50000` — sitting second in the trail, between
  the file name and the table. Three things were wrong with that. It read as a step of the trail,
  which a rung of a `zoomify` ladder is not: it is the same file drawn more or less finely, and the
  crumbs after it stay where they were. It was in bins, and `50000` is a number a reader has to divide
  before it means anything. And a dropdown hides the ladder, where a slider over stops shows how many
  rungs there are, which one you are on and which way is finer. The stops now say `1 kb`, `50 kb`,
  `1 Mb`; they are real radio inputs, so the arrow keys and a screen reader get the list; and the
  slider commits on release rather than per rung, since dragging across five rungs must not re-open
  the file five times. An mmetacool's entry picker is untouched and stays before the root, because
  switching to a different nested metacool genuinely does invalidate every crumb after it.

- **The landing page is one screen with three doors, not one long scroll with two.** **Load files**
  is a shallow drop target — *Drop genomic files here* / *or click to choose*, with an *or a URL* box
  under it — and the redundant *choose files* button beside it is gone, since it opened the same
  dialog a click on the target already does. **Mount a local or remote folder** is new: four buttons
  side by side, *choose a folder…* (the directory picker itself, one gesture, no dialog in front of
  it), *connect a bucket…*, *sign in to Google…*, *sign in to Dropbox…* — the last three opening the
  Connect dialog straight on the pane they name. These places used to be reachable only from the
  Files column's own plug, a page a reader arriving with a folder had not looked at yet; the **Files
  column now appears only while a place is connected** and disappears when the last one is, since a
  row of buttons on the landing page made an always-open, always-empty column redundant — the doors
  that remain to it are the landing page itself and *Open a local/remote folder* in the command
  palette. The desktop build shows three of the four buttons, a Google sign-in having no origin to
  register against `app://viewer`. **Connect to a store** is the third door, unchanged in kind.

  The masthead's tagline and the drop area's own paragraph are gone — between them a fifth of a
  laptop screen — and each of the three headings now leads with the icon that thing already wears
  elsewhere (a file, `folder-tree`, `library`), with 4em between the three sections so they read as
  three offers rather than one column of paragraphs. The page sits on a dotted ground — a sub-pixel
  dot every 10 px at half the border grey — the only patterned surface in the app, so arriving at and
  leaving the landing page are both legible. Each store tile's blurb is written for the roughly fifty
  characters its two lines actually hold, rather than truncated to them, and a remembered store shows
  the host of its URL (`builtin-stores.test.ts` holds the budget).

- **One button, everywhere.** Every `.btn` takes the same gesture on approach — the border and the
  word to the accent, a one-pixel lift, a shadow — which was the store tiles' hover and is now the
  rule rather than the one place in the app that had one. The quiet ones (a close cross, a link, a
  chip, a tab's ×) opt out of the lift, having no surface to raise. The landing page's row of places
  and the two sign-ins stop being `.btn-primary`: they stood directly above a row of store tiles
  offering the same gesture, and four blue blocks over eight grey squares read as a toolbar over a
  gallery — as well as claiming, against the doctrine, that one of the four was the answer. None of
  them is. They are tiles now, and `.btn-primary` is back to meaning the invited answer in a dialog.

- **The mark has a track down its left side and another under it**, which is where this application
  puts a track: the lanes grow towards the matrix from the bottom and the left edges. Both rise at
  the first bin of each of the three blocks and disagree in between, which is what having two of
  them is for.

  They are **slivers in the margin the plate already had** — a third of a pitch across, a fifth of a
  pitch clear of the map — and **one hue at two saturations**, not two hues. The first attempt gave
  each lane a whole row of an 8 × 8 grid and a colour of its own, and it cost more than it bought:
  three hues on one plate is a generic analytics icon and breaks the rule this application is built
  on, a solid run of seven cells outlasts a sparse diagonal at every downsample so at 24 px the
  decoration became the identity, and the extra row took an eighth off the map, which is the
  subject. Drawn this way the field keeps the size, the spacing and the palette it has always had;
  the one thing the lanes ask of it is half a lane's footprint of optical centring, so the mark
  rather than the map sits in the middle of the plate. Redrawn from `scripts/make-app-icons.py`, so
  the favicon, the install icon, the iOS icon, the dock icon and the custom-store tile are all the
  one drawing.

- **The greys are neutral, and the borders carry the contrast.** The whole ramp had a blue cast —
  `#c8cdd4`, `#98a1ac`, `#4a5058` are all blue-greys — and a blue-grey chrome around a blue accent
  leaves the accent nothing to be. They are neutral now, in both themes, and lighter in the light
  one: `--bg-sunken` is `#f5f6f8`, and what got darker instead is `--border` and `--border-strong`,
  which were pale enough that a card read as floating on nothing and a table's rules disappeared on
  a projector. A hairline that cannot be seen is a missing hairline; a fill that cannot be seen is
  just the page. Two elevation tokens with it, `--shadow-1` for *resting on the page* and
  `--shadow-2` for *lifted off it*.

- **The HiC score is the mean of the bin's own line across the near-diagonal, which is what the R the
  score comes from computes.** It was the *sum of every cell in a square window*, and neither the shape
  nor the missing division was right.

  **The shape.** The score is now `a[k, k + d]` for `|d| ≤ D − 1` — the bin's column, reaching `D − 1`
  bins each way — where it was every cell of a square centred on the bin. Drawn on a map that is a
  straight line through the diagonal: **half a crosshair**, one arm-pair, because the matrix is
  symmetric and taking both arms would count every off-diagonal contact twice against a main diagonal
  counted once. Every cell in it touches bin `k`. A square window does not have that property: it also
  counts the self-contact of `k − 1` and the corner joining `k − 1` to `k + 1`, cells that involve `k`
  in no way — and on a bacterial map at three diagonals those borrowed cells are most of the score, so
  consecutive bins shared half their cells and a single bright bin came out as a three-bin plateau. On
  `Bignaud2025_T7.mcool` a bin whose neighbours sit at 55% of it under the line reads 87% and 89% under
  the square.

  **The division.** It is a mean now: `N = 2D − 1`, the cells in the line. A sum grew with the number of
  diagonals and could only be compared against another run of the same size on the same map; a mean is
  contacts per cell and a lane labelled in contacts is readable as contacts. Multiplying by `N` returns
  the R script's own number exactly — which is how this is checked: against
  `Bignaud2025_T7.mcool::2000` at `NC_000913.3:3,442,000` the kernel returns **3.7433** × 1/N where that
  script returns 3.7433, and the same at every neighbouring bin.

  **The parameter is a count of diagonals**, counting the main one, replacing a window in base pairs.
  It defaults to **3** — the main diagonal and the one either side, five cells, two bins each way —
  which is the bacterial reading at the 2 kb resolution the score is computed on there, and is the R
  script's `num_diagonals = 2` under the other way of counting. P(s)'s minimum separation and the
  diamond's window went the same way and for the same reason: the near-diagonal is a fact about the grid
  rather than about the genome, and the same typed distance meant three diagonals at one resolution and
  one at the next. The runner says what the reach came to in base pairs on the file open and how many
  cells are behind each point of the track.

  The read is **shallower**: the band is `D − 1` deep where the square needed twice its own reach for
  its corners — two bins at the default, one strip on most files, no tiling.

  **A bin without a whole line through it now scores nothing.** Dividing a short sum by a full `N` fades
  both ends of every linear sequence towards zero, which reads as *this end of the chromosome is
  unstructured* — the artefact the diamond has always refused partial windows for, and one that arrives
  the moment the reading becomes a mean. A circular sequence has no end to run off and every bin on one
  is still scored. A cell the balancer dropped *inside* a whole line is a different thing and is
  unchanged: counted rather than guessed at, never scaled up, and `NaN` below `minValid`.

  The task's version is **3**, so a result carried in from a shared session is not silently compared
  against one computed here. `--window` is gone; the parameter is `--diagonals`, and an old command line
  naming the old one is refused rather than quietly reinterpreted.

  One thing worth knowing and not fixed here, because it is a property of the data rather than of this
  task: at three diagonals the **main diagonal is the bulk of the line**, it is where self-ligation
  lands, and on a balanced map it is the one place the weights were never fitted — cooler excludes
  `ignore_diags` diagonals from its own solve and then scales them anyway. On the E. coli map above, the
  bin under that peak carries a balancing weight 1.45× its neighbours', so its self-contact is scaled
  2.09× and the peak is in the weights rather than in the counts, where neither statistic peaks at all.
  `ignoreDiags = 1` cuts that cell out of the score, and the hint on the control now says why one might.

- **An explicitly planned pooled read is snapped to the sequence's own grid.** The reader anchors
  the cell grid to each sequence rather than to the window asked for, so two blocks of one region
  agree cell for cell — but it did that only for the plans it chose *itself*, and a request carrying
  its own `binsPerCell` skipped the step. That is why the zoom-to-refine module carried a standing
  note saying it must never send one: the cell values would have moved as the reader panned. Both
  paths snap now, which is what makes a declared resolution above a resolution rather than a
  rendering. A no-op for the two callers that sent an explicit plan before this — a whole-genome read
  and a selection both start at sequence boundaries.

- **Nine resolution rungs are chipped rather than six (§5.5).** A `zoomify` ladder that doubles from
  1 kb reaches a megabase in ten rungs and one on the 1–2–5 series reaches it in nine, so the old cap
  collapsed most real `.mcool`s to a bare slider — and collapsed an eight-rung one the moment
  somebody added a ninth, which is exactly the reader the `+` above is for. Nine stops is about
  three hundred pixels of short numbers, right-aligned into whatever the trail leaves.

- **Every dialog's body is inset from its panel, and no dialog has to remember it.** Each one names
  its own body class and each used to set its own padding — a rule spelled a dozen times, and the way
  that shape fails is not subtle: a dialog written without the declaration comes out with its text
  against the panel's border, looking broken, and nothing says what was forgotten. (The resolution
  dialog shipped exactly that.) The padding is stated once now, against the panel's own children, at
  a specificity that beats a body class. Three are flush on purpose and opt out by name, in one place
  where the exception list can be read whole: the command palette's search box and the feature
  card's footer each carry a border across the panel's whole width, and the stage (§18.13, §25) is a
  picture at the size of the window beside a column the reader drags the width of — where an inset
  would be measured into the drag, since the grip sizes the column from the modal's own right edge.

- **The region bar loses its back arrow and its map/tracks cycle button (§5.4).** Both were controls
  with a shorter road already beside them. Going back is the browser's own back, which this bar's
  navigation has fed since it existed. *Tracks only / map only / both* is the **eye beside the map**
  in the column that lists what is drawn — where every other thing on screen is shown and hidden,
  one row at a time, by the control that names it. A second way to do a thing is not a convenience
  when the first way is a row the reader is already looking at; it is another control to learn, in
  the bar that has to stay readable at a glance, and the bar has just gained four zoom buttons. The
  `v` key still walks the three states, because a key costs the bar nothing.

- **A barChart lane's ceiling is dragged like a track's (§8.17).** Giving the lane a fixed axis left
  the reader one way to move it — typing two numbers into the card — while every lane above and
  below it answered a drag across its body, and a ⌘-scroll over it, by moving its ceiling. A lane
  that answers that gesture with a pan, in a stack where nothing else does, is a lane the reader has
  to be told about. Both gestures now reach a chart, on the map's stacks and in the 1D browser, and
  they start from the axis already on screen — zero to the file's own tallest bar, the same number
  the typed field seeds from, so a notch and a drag on one lane cannot begin from two different
  places. What this cost is an invariant that had held since the kind predicates were written: *has
  a movable axis* and *is drawn as a profile* are two questions, and they were one function's worth
  of answer only for as long as nothing but a profile had an axis. A chart still gets no **row** of
  track controls — no autoscale group, no mode or flip switch — because it is not a measurement in
  anybody else's units.

- **An APA's half-width starts at 21 bins rather than 12, and *Anchor on* loses its paragraph
  (§18.8).** Twelve was narrow enough that a loop filled the picture: the corners a P2LL divides by
  were a couple of bins from the peak rather than background, and a reader had nowhere to watch the
  pileup sit back down to it. The paragraph above *Centre / Start / End* explained which end of a
  minus-strand gene is its 5′ end, over three options that carry a line each — three lines of the
  card spent saying what the options say, and the 1D metaplot has asked the same question with no
  such paragraph since it existed.

- **The three *or open one by URL* boxes, and the *from a connected place…* button that briefly
  replaced them, are both gone.** Each URL box was the worse half of the pair it stood in: a reader
  holding a URL can drop the link on the window or paste it into the landing page's own box, and a
  reader **without** one — the commonest state in all three places these stood, since the bigWigs
  beside a map are keys in a prefix and a repaired shared deck's `~` has no address a page could
  fetch by name (§11) — was being asked to produce something they have not got. What that reader
  needs is to be shown what is *there*: the Files column, open for exactly as long as a place is
  connected (§20), rather than a *from a connected place…* button that opened the same folder view
  in a dialog from under every such card — four doors to one room, each closing on the first pick,
  where the way people actually work through a directory is to open one, look, open the next, and
  keep going. The column itself is untouched, a drag out of it still lands anywhere a drop lands,
  and the drop areas' hints are cut to the formats each zone takes and nothing else.

- **The store tiles carry real marks, in one row.** RSG's tile is a contact map of its own — 100
  bins square in the viewer's own `default` ramp, with domains, compartments, loop peaks and the
  decay to paper every Hi-C map has, *RSG* rasterised onto the diagonal as bins like the rest of the
  picture (`npm run icons:rsg`, committed as an indexed PNG whose palette *is* the `default` ramp,
  held against `applyColormap('default')` by a test so it cannot drift out of step with the colours
  maps are drawn in; the letters sit behind the image, so a mark that fails to load is a lettermark
  rather than a hole) — where all four tiles once shared a coloured square with initials in it. The
  other three now carry their own logos too, IGV's, 4DN's and ENCODE's having since been given to
  this viewer to redistribute: each is fitted to a 160-pixel square (`npm run icons:stores`; ENCODE
  letterboxed, since its badge is half again as wide as tall and would otherwise crop the word
  *ENCODE* away; 4DN composited on white; IGV full bleed) and committed as a data URI, the standalone
  build emitting no `public/` for either set. The coloured grounds stay underneath every tile as what
  shows while an image loads or if one fails, deliberately nobody's brand.

  The row itself no longer wraps at most widths — the tiles share the width instead of spilling a
  lone extra tile onto its own line — and the thin coloured arc that showed through each mark's
  antialiased corners, reading as a border the tile does not have, is gone now that the fallback
  colour is dropped the moment an image sits in front of it.

- **The 4DN and ENCODE stores list a BAM only where its reads can be drawn.** A third of the 4DN
  store's rows were BAMs, and most of those were clicks that could only be refused: 2,271 were the
  alignment files of Hi-C-family assays (in situ Hi-C, Dilution Hi-C, Micro-C, Capture Hi-C,
  PLAC-seq, DNase Hi-C, ChIA-PET, MARGI, TCC, HiChIP), every one `bwa mem -SP5M` output in read-pair
  order with no `@HD` line, which the viewer refuses for want of a sort, and 6,309 were BAMs the
  portal describes nowhere — no assay, no biosource, no dataset, nothing to filter on. The generator
  now leaves both out, so *bam* in the Files facet is the 1,397 alignments of RNA-seq, ChIP-seq,
  CUT&RUN, Repli-seq, DamID and TSA-seq, which are sorted and draw; the `.pairs` and the contact
  map of every Hi-C set are the rows that were wanted from it, and they stay. ENCODE's alignment
  shards lose their Hi-C pipeline's files the same way — 471 rows of in situ, dilution and intact
  Hi-C, `@HD SO:unknown` — and nothing else: ENCODE's ChIA-PET alignments are ChIA-PIPE's and
  coordinate-sorted, and a BAM the portal did not describe keeps the cells its manifest row has.
  The rule is about what a BAM is — its reads — and not a list of assays: a new member of the
  family whose name says Hi-C arrives filtered, and a new linear assay arrives listed (SPECS
  §24.3, docs/stores.md).

- **The Connect dialog is four panes, each a title, a `?` and one button.** Every pane used to carry
  two or three paragraphs of explanation between its heading and its control — the Drive pane had a
  second heading of its own, a bucket pane a *public* / *needs a key* switch that asked the reader to
  classify a prefix before describing it — and the three provider panes (this machine, Google Drive,
  Dropbox) also carried boxes for the site's own client id, API key and app key. Those boxes and the
  storage behind them are gone: the three are the site's own registrations, built from
  `GOOGLE_CLIENT_ID`, `GOOGLE_API_KEY` and `DROPBOX_APP_KEY` at deploy (docs/deploy.md), so a reader
  is offered a sign-in and nothing to configure, a site built without a registration says so where
  the sign-in would be, and the About screen and stored settings carry nothing for them. What is left
  on each provider pane is one line — *Connect to your Google Drive*, *Connect to your Dropbox* — a
  `?` at the far right holding what the grant is, where the token lives and how long the browser
  keeps it (reachable by keyboard, read by a screen reader as the button's description), and one
  large sign-in button with the provider's mark on it; the Drive pane's folder box appears under the
  button once signed in and goes away on sign-out, and the Files panel names the tile **Google
  Drive** rather than a section that no longer exists. The bucket pane keeps a name, a URL and
  *Additional settings*: whether a scope is signed now follows from whether a key was typed into all
  three of region, key id and secret, rather than the reader declaring *public* or *needs a key*
  first, and its `?` carries the CORS policy and the `Range`/`Content-Range` pair a `.mcool` cannot
  be read without, as blocks to paste rather than prose to translate back into one. The Files
  column's own button and the dialog it opens are both named **Open a local/remote folder**, in
  place of *connect a place…* (SPECS §20, §24.7, §24.9).

- **IGV's genome cards are four across, tighter, and named without the bracket.** *Human
  (GRCh38/hg38)* is *Human* with `hg38` as its chip — the assembly was on the card twice — the
  whole name staying in the tooltip and in what the filter box searches; the grid is four
  columns at the drawer's default width, two when it is narrowed.

- **A store row is called what the drawer called it.** A 4DN map opened from the shelf was named by
  its accession — `4DNFI24F7GRY.mcool` — where the reader had picked *Hi-C on HFF cells, protocol
  variations*. The row's line now goes with the file: onto the map, onto the track, and onto the
  tab a row opens in a session of its own, through the same road a file named by a Drive folder
  takes.

- **The lab's figures and IGV's genomes are one shape of card.** The name and the card's one verb on
  the first line — the new-session mark, icon only — the chips under them, the one-line description
  where there is one, and *8 files* behind a fold listing every file the session is made of, each a
  store row with the two verbs. The *Figures* heading and the separate *Files* section are gone:
  every file is under the figure it belongs to, and the few no figure names sit under the cards in
  a fold of their own. IGV's cards lose the host line under the name.

- **Every file row carries the same two marks: add it here, or open it in a new session.** A store
  row had *add* as a word and *open* as a grey arrow, a folder row in the Files column had the
  arrow alone and *add* only in the tooltip, and which of the two a row offered depended on whether
  the tab was empty. Now every row — a store's, a folder's — has a `+` that joins the file to the
  session in front and a window with a `+` where its corner was that opens it as a session of its
  own, both icons, both always there, the words in the tooltips (SPECS §20.5, `ui/rowVerbs.ts`).
  The same mark stands beside *open* on a gallery card and *open with its tracks* on a group, and
  the tray under a portal gained *add to this session* beside *open together*. A workspace row has
  the second alone, being tabs and not a file.

- **Two verbs to open anything: load files, or connect to a store.** The landing page had grown a
  URL box, a *browse…*, a *private buckets…*, a dropdown of eighteen shelves and a list of
  examples, and the header a plug, a `+` and a *Buckets* card that overlapped all of them. Every
  one was one of two things under another name. The page now says the two (SPECS §24.2):
  **Load files** is the drop area and the URL box, and **Connect to a store** is a row of tiles —
  the lab's own figures, IGV's genomes, 4DN, ENCODE, every store the reader connected, and a `+`
  for one by URL.

  A tile opens the **store drawer**, a panel down the left in the family of the Analysis drawer
  and the console: resizable, put down by Escape or its header button, and back where it was left
  when it is reopened. Each store gets the page its data wants. The lab's store and IGV's are
  **galleries** — one card per figure or per genome, a line of context, one button that opens the
  whole pre-configured session, the files under a fold. 4DN and ENCODE are **portals**: a rail of
  facets (assay, biosource, lab, format…) whose counts follow every tick — OR within a facet, AND
  across them — a search box, a **matrix** that crosses any two facets and opens a cell, and a
  **tray** that collects rows to open together. What is open is in the address —
  `?store=4dn&assay=Hi-C&biosource=HFFc6&view=matrix` — so a narrowed store is a link, and
  `?store=<url>` opens a lab's own. Nothing is fetched until a tile is pressed.

  Around it, the doors are fewer and each says what it is. **Connect** (the Files column's
  *Open a local/remote folder*) is a row of providers — this machine, a bucket, Google Drive, Dropbox — with
  each provider's credentials on its own pane rather than a bucket card here and a Drive key there.
  The file crumb's *Open a file* opens one **Load** dialog with the store tiles behind it. Every URL box that
  once had a *browse bucket…* beside it has *from a connected place…* instead, which lists every
  place the window is connected to and not only buckets. The **Files** panel is the one listing of
  connected places. And `scripts/make_store.py` writes a *Group*, *Experiment set* or *Dataset*
  column into what it generates, which is what the galleries and the sessions are grouped by.

- **A map of several ticked genomes is divided and labelled by genome.** Ticking
  four MAGs in the genomes table asks for four blocks — their own maps on the
  diagonal and everything between them off it — and the picture came back ruled
  and named by *contig*, so the thing four ticks were spent on had two thousand
  hairlines across it and no line anywhere saying where one MAG ended and the
  next began. The whole-metagenome view has always refused exactly that wash; a
  selection of genomes is the same picture of a chosen few and now reads the
  same way.

  The rule it follows is the one the whole-file levels already state, one level
  down: **what was ticked is what the axis is divided and labelled by.** So
  ticking *contigs* is unchanged — there the names picked are the contigs, and
  coarsening to the genomes behind them would throw away the answer to "what did
  I pick" — and so is a single genome, whose own contigs are the only structure
  inside it. The genome of a contig is still on the tooltip in every one of
  those cases, as it was; what changed is only which of two run lists gets the
  ink.

  Where the axis is pooled — enough small contigs and a cell holds several — a
  cell is now kept **inside one genome**, the same guarantee the whole-metagenome
  scan already makes for its slots. Without it a boundary can land a cell late and the
  block it closes carries a sliver of the next MAG, which is precisely the kind
  of invented adjacency the pooling rules exist to prevent.

  **And clicking one of those labels opens that genome.** It used to open a
  *region* view of it — a legal destination, since a bare genome name is a range
  the parser takes (§5.4), and one screen short of where the gesture meant to go.
  The whole-file picker has always gone straight to the genome; both now
  dispatch on what the axis actually is rather than on which view is asking, so
  the two pictures that are divided by genome behave alike. A label on an axis of
  contigs opens a region, as it always has.

  A companion panel in a deck follows the lead here, because the decision is made
  on the read rather than in the view: `#genomes=` shows the same blocks in every
  map it is applied to.

- **A GTF's biotype is written into the feature's attributes with its key in front of it**
  (`biotype protein_coding`, where it was a bare `protein_coding`). An attribute with no key is a
  fact nothing can ask for — invisible to the new column picker — and the feature card behind a
  click gains a label it was missing anyway.

- **The number under a domain pileup is no longer P2LL.** Peak-to-lower-left
  measures a dot against the corner furthest from it, and the lower-left corner
  of a *domain* window is the upstream neighbour against the downstream one —
  two regions further apart than anything inside the domain — so the ratio is
  mostly the distance decay and reads well above 1 on a set with no boundaries
  in it at all. What is reported instead is **in / out**: the domain's own
  corner against the same block just across its boundary, which sits at very
  nearly the same separation, so what is left when you divide is whether contact
  stops at the edge. Above 1 is a domain. The per-feature table carries the same
  number per domain, and the loop pileups are unchanged — they still report
  P2LL, which is the right statistic for a dot.

- **Observed / expected is refused in the scaled mode, in the form rather than
  at Run.** One cell of a scaled pileup is fed by windows at a dozen different
  separations — that is what scaling *is* — so it has no one diagonal offset for
  a P(s) to be looked up at, and dividing by one anyway produced a plausible
  picture of nothing. The refusal names the alternative: the distance-matched
  control, which is drawn at the same separations by construction and is what
  the task defaults to.

- The scaled pileup's axes are labelled in units of the feature — `0` at its
  start and `1` at its end — with the flank the run used named beside them,
  instead of an unlabelled *Scaled position*.

- **A store or a hub can be pasted instead of fetched.** Both doors now carry a folded *or paste
  the hub* / *or paste the store* box, with an optional base URL for relative names. Two reasons,
  and the first is not convenience: a store is fetched by the **page**, so the host has to allow a
  cross-origin `GET`, and plenty never will — `genome.ucsc.edu` among them, which puts UCSC's own
  example hubs out of reach of every browser-only viewer. The file is public, the reader can see it
  in another tab, and the only thing in the way is a response header on somebody else's server.
  Pasting gets past that without routing anybody's traffic through a proxy this project would then
  be asking them to trust (C1). The second is writing one: a lab assembling its own shelf edits,
  pastes, sees what broke and edits again, and publishing a file to a bucket between each of those
  is a loop nobody runs twice.

  **One box and not three**, even for a hub, which is three files. `useOneFile on` is a hub in a
  single file — and a `hub.txt`, `genomes.txt` and `trackDb.txt` **concatenated** are the same
  thing, because the only keys the concatenation loses are the two saying where the next file is
  and the next file is already in the box. A text that is *only* a `hub.txt` is refused by name and
  told what to paste after it, rather than coming back as an empty shelf. Relative names are
  refused with the first of them quoted, so the base box is an obvious fix rather than a shelf
  whose rows fail one at a time when they are pressed. A pasted shelf has no address, so it is not
  put in the address bar and not offered for remembering: a store worth keeping is one with a URL.

  Each box carries a **fill in an example** button beside *open what is pasted*, and what it puts
  there is a hub and a store that actually **read** — over the published demo files, so the first
  press draws a shelf and the reader's first edit is to a thing that already worked rather than to a
  template whose state they cannot tell. The hub example is an **assembly hub**, naming the demo's
  own `.2bit` through `twoBitPath`: the rung of §24.10's ladder worth demonstrating, and the only
  way a hub carries a sequence of its own. It is a hub somebody wrote and checked against the bucket
  rather than one composed here, which is why `Yeast_reference.2bit` is published beside the FASTA
  and carries that name. It asks before replacing a box that is not empty, because
  that box is where somebody's half-written hub lives. A test pins every file the two examples name
  against the published set, since an example that 404s on its first press is worse than none.

  The CORS failure now names the box, because a reader staring at *Failed to fetch* has no reason
  to guess there is one — and where the host is a **UCSC** one it says what was measured on
  2026-09-16: neither `genome.ucsc.edu` nor `hgdownload.soe.ucsc.edu` sends the header, so UCSC's
  own example hubs and the whole of GenArk are out of reach of *any* browser-only viewer, this one,
  igv.js or otherwise. That is a UCSC hosting decision rather than a fault in the reader's URL, and
  saying so beats sending them to check a link that is perfectly correct. It also says that pasting
  such a hub's text gets past it for the hub and not for its `bigDataUrl`s, which are on the same
  hosts — the part that would otherwise be discovered one row at a time.

- **A store's own name replaces the door's on the drawer heading once it lands.** A door is named
  for the errand — *A track hub*, *Your own store* — which is right until one has been read, at
  which point the page is about a particular shelf and the heading says which, with the store's own
  description under it. Both doors, not only the new one.

- **Every task in the catalogue runs from the shell, so every run the console records is a real
  command.** `metacooler-run` refused four of them by name — the 1D metaplot, track correlation and
  FRiP, whose bigWig reader lived in the annotations worker alone, and reproducibility (HiCRep),
  whose second map the deck supplies — and any run made in a 1D browser session, which has no
  contact map to open as the first argument. The console (§23) recorded each of those as a sentence
  with the refusal under it, and the drawer's *copy CLI command* was greyed. Now `--tracks` opens a
  bigWig, a bedGraph, a wig or a FASTA read as GC content where it lies, and the runners are handed
  the same `sample` the worker answers; `--against` names the maps HiCRep compares with, mounted as
  the analysis worker mounts them; a track task with no file positional runs over the assembly the
  tracks declare, framed as the session frames it; `--track` names the file behind an id a replayed
  workspace recorded, and the tab's own track list says which is which. Two silent gaps went with
  them: `compartments --phaseSequence` had parsed the reference and then reported that it *could not
  be read*, because the per-bin GC vector the session ships was never computed in a shell; and
  `expected --stranded` could not read a named `.pairs` from disk, nor the orientation curves a
  `.pairs` given as the map had just counted. A composite (`magnetwork`) runs what it requires
  first, at its defaults, as the app does. And three facts of a *framing* the session sets from
  the picture, each an input to the arithmetic and none a parameter of any task, are now flags the
  console writes whenever they differ from the shell's defaults: `--value` for the score column a
  `.metacool` is drawn from, `--circular` for the sequences declared circular (§8.15), and `--cell`
  for the cells of an `.scool` that were ticked (§3.8). An imported `.pairs` writes its
  `--bin-size` too, since a contact list declares no resolution and the line died at the open
  without it (README, SPECS §23).
- **A `legend` overlay.** The key in the corner of the map — the score, the bin size and the two
  ends of the colour scale — has a toggle of its own in the Map card, on by default, beside the
  dividers and ticks it stands with. Off is for the figure whose caption already says it, and the
  caption now does: every export ends its detail line with *colour −3.13 to 0.385*, so a map
  without its key, or two maps side by side, are still read against their ranges.

- **The whole-genome gate names the cheaper rung.** Pressing *W* on a fine resolution used to read
  every stored pixel and say so afterwards; the ask-first screen now says in a line what it costs
  and, on a laddered file, offers *open at 250 kb instead* — the coarsest rung whose bins still fit
  in one drawn cell, which draws the same picture from a fraction of the pixels. A `.hic` declares
  no pixel count and was never gated at all; a file that states no count is now gated on its bin
  count instead (`WHOLE_VIEW_GATE_BINS`), so a chicken genome at 1 kb asks before it walks every
  block.

- **Compartments say when the resolution is wrong for them.** 4,642 bins on one sequence at 1 kb
  is under the correlation gate and six minutes of eigenvectors with the CPU meter reading idle.
  The line beside Run now says so in red, gives the rule of thumb — 250 kb on a mammalian genome,
  and past about 2,000 bins the correlation takes minutes — and names the rung of this file at
  which the widest sequence would fit (*open it at 5 kb (929 bins) or coarser*). The analysis
  context carries the file's resolution ladder for it.

- **Annotations and Analysis start folded.** Five open columns beside a square plot left the plot a
  thirty-pixel sliver on a laptop, with the *whole genome* button clipped off the chromosome table.
  A window that has never chosen now opens with the two columns a reader reaches for least on
  arrival folded to their tabs; a stored choice still wins, and the open state is written as one,
  so a reader who opens a column keeps it open (`ui/SidePanel.ts`, `defaultFolded`). The Files
  column folds itself, for this window only, once a file chosen or dropped on the landing page has
  opened — it is the one column that page shows, and it has done its job.

- **Restore adds to what is open.** The banner outlives the picker, so a reader who opened a file
  while it stood and then pressed *Restore* had the file they just opened replaced by the ones they
  had, with no message and no undo. A window holding anything now takes the remembered tabs *beside*
  it, the way a dropped workspace file always did; only an empty window is replaced.

- **The Export card exports the deck.** Its download button and the `S` key called the lead
  panel's own figure, so a reader with four maps side by side got the first cell of the
  arrangement — the mismatch ⌘C had already been cured of. Both now go through the deck when there
  is one: every panel at the card's dpi, laid out as on screen, as a PNG or as a one-page PDF; a deck
  of one map exports as that map, vector PDF and all.

- **The Tracks card says when the lanes are put away.** `V` cycles the map with its tracks, the
  tracks alone, and the map alone, and the third stop left the card listing eight files drawn
  nowhere — which read as the tracks having been lost, and was reported as the square map losing
  them. One line above the list now says where they are and that `V` brings them back.

- **The readout under the pointer says what and where.** `count 0.003` under a key reading
  *Balanced* was two names for one number, and `1.22 Mb × 1.23 Mb` named a ten-kilobase
  neighbourhood of a cell one kilobase wide, so two cells three bins apart printed the same string.
  The tooltip and the status line now use the score picker's own word and write the coordinate out
  in full — `NC_000913.3:1,215,000`. The analysis drawers' selects no longer shrink to their first
  four letters (*Chro*, *ever*, *Prob*).


### Fixed

- **A pileup's edge profiles were drawn from zero, which flattened them (§18.8).** A ChIP aggregate
  running from 45 at the baseline to 92 at the anchor — a doubling — came out as a line across the
  top of a band three lines tall with a small bump in it, while the same numbers as a metaplot curve
  two blocks down the drawer were a peak twice the height of its baseline. Two pictures of one
  quantity disagreeing about whether anything happened, and the arithmetic was right in both. Each
  profile is now drawn against **its own extent**, with the two edges of one track sharing a ruler —
  they are one measurement — and the range printed beside the track's name in the key, which is what
  keeps a self-scaled band honest about how much of an effect it is showing.

- **A pileup's edge profiles now leave as numbers, with the matrix they belong to (§18.8).** The
  TSV a reader exports carried the cells and not the lines drawn along them, which made the one
  thing in the figure with no numbers behind it. They are written as a second block under the
  matrix — contacts and signal are two units, and a spreadsheet reading them as one rectangle would
  average them together.

- **`metacooler-run apa --tracks` opened the file and then reported that it could not be read.** A
  parameter that takes *several* entries files each one under `key:entryId`, which is how the app's
  runner reads them back; the shell filed one vector under the bare key and read the parameter as a
  single string, so a pileup asked for at a command line came back with a note saying one of one
  tracks could not be read — about a file the command had just opened. The convention is now
  written down once and imported, rather than stated in two places.

- **A matrix figure's colormap control drew empty on exactly the figures that set one.** The slim
  strip offers six colours inline with the full list in the dialog, and a `select` whose value is
  not one of its options draws blank — so a saddle's `RdBu_r` or a pileup's `fall` made the control
  look broken. Whatever is in force is now offered alongside the six.

- **Fourteen rules in the stylesheet drew nothing, and looked like they meant to.** Six names —
  `--line`, `--muted`, `--fg`, `--fg-quiet`, `--bg-inset` and `--warn` — were read across the sheet
  and defined nowhere, neither in CSS nor from the code. An unresolvable `var()` is *invalid at
  computed-value time*, which does not skip the declaration: the property takes its inherited value
  if it inherits and its initial value if it does not. So `border: 1px solid var(--line)` came out
  `border-style: none` and drew **no border** — on the colour ramp beside an annotation, on the
  share dialog's link box, under the analysis drawer's map tabs and round a plot control's number
  box. `background: var(--line)` came out transparent, so the well behind a feature-count bar and
  the one-pixel divider in the plot controls were **invisible**. And `color: var(--muted)` inherited,
  so two labels meant to sit quietly under something else were drawn at **full strength**. Each of
  those looks, in a screenshot, exactly like a deliberate choice, which is why none was found.

  `--warn` is now a real token in both themes, and the three rules that wanted a warning colour stop
  inventing one each: `.pairs-warning` was written `var(--warn, var(--accent))` and therefore drew a
  warning in **link blue**, and the other two hard-coded ambers that never changed in the dark theme.
  `.input.is-bad` takes `--danger` like the `.input-region.is-bad` three thousand lines above it,
  instead of a red of its own that stayed dark on the dark theme's dark surface.

  **`test/unit/css-tokens.test.ts` is why there is not a fourth time.** It reads every `var()` in the
  sheet and fails, with the line number, on any name nothing defines — allowing only the sixteen
  properties the code writes with `setProperty`, and checking that allowance against the source so it
  cannot rot. It also holds the two halves of the dark palette to each other and the light palette to
  the dark one's set of names, which is how `--tab-rest` came to exist in four of the six blocks that
  carried a palette and in neither of the other two.

- **The palette is written once.** The light values were spelled out in full in four places —
  `:root`, `[data-theme='light']`, `.content` and `.analysis-figure` — and are now one selector list
  that names all four. Eighty-four declarations become sixteen, and the two boxes that stay light
  while the furniture goes dark can no longer drift from the theme they are a copy of. The dead
  `var()` fallbacks went with it: `var(--accent, …)` appeared with **three different** fallbacks for
  a token that is always defined, and fifteen font sizes bypassed the type scale for values that
  were a step under another name.

- **A bacterial GFF arrived as 87 features out of 5,870.** A 6.4 Mb *Pseudomonas aeruginosa* PAK
  annotation — 5,783 CDS, 74 tRNA, 12 rRNA, one tmRNA — opened as 87 anonymous boxes: every RNA in
  the file and not one of its proteins, each drawn with no name and no accession. The count is the
  diagnosis. 74 + 12 + 1 = 87, so what came through was exactly the rows whose feature type ends in
  the letters `rna`.

  The parser only knew the hierarchy GTF and an Ensembl GFF3 are built from — gene, transcript, and
  the exons and CDS underneath — and it keyed every row that was not a gene or a transcript by its
  `Parent`, because in that world such a row is a *fragment* and the parent is the thing being drawn.
  A row naming no parent could not be placed, and was skipped. **A bacterial annotation has no
  hierarchy in it at all**: Prokka, Bakta and DFAST write one row per feature, each with its own `ID`
  and `locus_tag` and not one `Parent` anywhere in the file, because a bacterial gene is a single
  uninterrupted CDS and the gene and mRNA rows Ensembl writes would each be a second copy of the same
  span. So all 5,783 CDS rows went looking for a transcript they had never named and were dropped,
  while the tRNAs and rRNAs matched the "is this a transcript" test on their type and came through on
  their own `ID`s. That the survivors were a plausible-looking 87 features rather than an error is why
  this read as a file that had loaded.

  A row that names no parent is now read as the whole feature it is. It is keyed on its own `ID` — so
  two rows sharing one, which is GFF3's way of writing a feature with a gap in it, are one glyph — and
  a row carrying no `ID` at all is drawn keyless rather than collected with every other such row into
  one feature stretching across the file. Where a file *does* say what a row belongs to, that still
  decides and nothing changes: a CDS with a `Parent` still folds into its transcript and is not drawn
  beside it.

  Three things that were being thrown away come with it, because 5,870 nameless boxes is not much
  better than 87. `locus_tag` now counts as an accession — it is assigned per gene by definition, and
  it is the only one a Prokka file writes — so the 2,643 `hypothetical protein` rows that carry no
  symbol are labelled `IMMMIJEE_00005` instead of nothing, and the search box can find them. A bare
  `gene` attribute now counts as a symbol, which is how NCBI and Prokka both spell one, so `dnaA`,
  `gyrB` and 3,139 others are drawn under their own names. And `product` joins `biotype` and `source`
  in the detail string: it is the whole of what a bacterial annotation has to say, the feature card
  had been showing `source Prodigal:002006` and stopping, and the colour picker (§8.16) can only
  offer a column that is written there.

  One row type had to be turned away deliberately as a result. NCBI opens every contig with a
  `region` spanning it end to end, and a GFF converted from GenBank writes `source` for the same
  thing; both name no parent, so both used to fall off the same end the CDS rows did. Drawn, each
  would be a box the width of the chromosome sitting on top of the genes.

- **A species with no `README.json` no longer fails the whole Stores run.** `--readme optional` is
  the default precisely because those files are hand-maintained across hundreds of species, and it
  promises that a species without one keeps every file it has and loses two columns. Against
  recorded fixtures it did exactly that; against the bucket it could not, and the first weekly run
  of the DNA Zoo store died on `Preliminary/` — a top-level directory that is not a species and
  never had a README. Nothing was published that week, so the shelves readers saw stayed as they
  were.

  The cause is one fetcher doing two jobs. A portal search is read by a function that treats `404`
  as *zero results* only when the body is JSON — 4DN's way of saying a facet matched nothing — and
  turns every other status into the end of the run. A bucket refuses a key that is not there with a
  `404` and an **XML** body, which landed in that function's "the endpoint has moved" case. Reading
  a document that may simply be absent is now its own function, and it answers *no document* to any
  status and to a body that is not a JSON object. Absence and outage are still told apart: a host
  that cannot be reached, or that stops talking part-way through three times over, still ends the
  run, because a store is only ever replaced by a run that succeeded. `--readme require` still fails
  on the first missing one, which is what it is for.

  A run where *no* directory yielded a README now says so in a line of its own. Every row is still
  published and the run still succeeds — but a bucket that answered for its objects and for none of
  its READMEs has more likely been rearranged than lost every one at once, and two silently empty
  columns are not a thing to find out about from the shelf.


- **A shared link opened the picker on the first visit in a fresh browser profile.** Not on the
  second, and not in a second tab, which is what made it read as a broken link rather than as what
  it was. The first load of the site registers the service worker; the worker calls
  `clients.claim()` as it activates, so it takes over the page that is still running; and the page
  reloaded, because a worker that has *replaced* another is serving a page built from the one it
  replaced. A worker installing for the first time has replaced nothing — the page came off the
  network a moment earlier and is already the newest build — but it fired the same
  `controllerchange` and got the same reload. `openSharedHash` decodes a session and then takes
  `#session=…` out of the address bar before the tab it describes has finished opening, so the
  reload landed on a bare URL and the session was gone. The first claim no longer reloads; an
  update still does, which is the case the reload was written for.

- **A store that did not answer with a store said it was not a saved workspace.** The store reader
  borrowed the *workspace* reader's wording for the one refusal both formats share, so a host
  answering with a page instead of the file — which is what a dev server does for a store the
  Stores workflow has not generated — produced `… is not a JSON file, so it is not a saved
  workspace`, naming a kind of file nobody in the drawer was trying to open. It now says it is not
  a store, and names the case that causes it.


- **Analysis tasks on a map imported from a `.pairs` failed at the mount.** §3.7
  says every §18 task reads an imported map through `PixelStore` exactly as it
  reads a cooler, and that was true of the reader worker and not of the analysis
  one: it opens the file for itself (§18.3), reached `MetaCooler.open` with a
  contact list, and was refused with *choose a bin size* — a dialog the reader
  had already filled in, on a map that was on screen and working. The binning
  now travels with the job, and the second mount re-reads the records once,
  behind the bar and the cancel the first pass had. The pairs road moved into
  `worker/open.ts`, which is where that module's own docstring argues the
  knowledge of *how many roads there are into a map* belongs — the HiC-Pro
  defect it was written for, a second time.

- **A curve output can draw as points.** Every other figure in the catalogue is
  a function of a separation, a position or a rank, so joining consecutive
  samples says something true about what lies between them. A cell-cycle scatter
  is two fractions measured on the same cell with no order along x, and a line
  through it would draw a path nothing travelled.


- **Diamond insulation's estimate counts the reads it makes.** It still said one
  dense square per sequence, which is what it read before the diagonal was
  tiled: four range requests for a chromosome that is now read as a run of
  squares along its diagonal — on mouse chr1 at 5 kb, a number two orders of
  magnitude under the truth, on the one screen a reader consults before starting
  something expensive. The estimate and the runner now share the arithmetic
  instead of each carrying a copy.

- **A lane too thin for two lines no longer runs its range into its name.** The
  range goes under the name where there is room for it and beside it where there
  is not, and beside it, it started exactly where the name ended: `80 kb` and
  `-1.46` read as one word. Rare while every lane was 90 pixels tall, ordinary
  once four heatmaps share one lane.

- **Both scans on the map read a diagonal instead of a square, and the fine
  resolutions they used to refuse now work.** Neither the insulation diamond nor
  the chromosight correlation has ever looked at a cell far from the diagonal —
  a diamond reaches `window` bins each side of the bin it scores, and a
  correlation runs inside a band `max_dist` wide — but both read the whole `n²`
  square to get at the band, and the ceiling that fell out of that had nothing
  to do with either computation:

  - **insulation** hit the 2 GiB limit on a single `Float32Array`, which is a
    limit of the tab and not of the machine. That is 23,170 bins: 116 Mb at
    5 kb, so mouse chr9 was refused and chr1 could not be run below 10 kb.
  - **loop calling** never reached the allocator. A hard-coded 8,192-bin cap
    skipped any longer sequence, which is 82 Mb at 10 kb and 41 Mb at 5 — so
    mouse chr18 was dropped at 10 kb and every mouse chromosome at 5 kb.

  Insulation now walks each sequence as overlapping squares with a halo the
  width of the widest diamond. The split that makes this a substitution rather
  than an approximation is between the **sums**, which are local to a bin, and
  the **score**, which is a log2 ratio against the mean over the whole sequence:
  each tile files the sums for the bins whose whole diamond it holds, and the
  score is taken once at the end. `diamondSums` is untouched and still goldened
  against cooltools; the answer is identical cell for cell, not close. Mouse
  chr1 at 1 kb — 195,471 bins, which is 153 GB as a square — now runs in 19
  seconds inside a 4 GB heap.

  Loop calling reads the band it was always going to scan. `chromosight.ts` had
  already banded every one of its own objects, saying so in as many words; the
  square read was the last `n²` thing in the module and the gate was the fence
  built around it. The gate is now a bound on the **band** — the scan distance
  times the sequence — so it scales with the setting that actually costs: the
  whole mouse genome scans at 5 kb, and what is still refused is a deep scan on
  a fine grid, refused by name with the two settings that fix it. Mouse chr1 at
  5 kb, a 6.1 GB square, takes 68 seconds.

  One thing genuinely needed the square and now comes from the pixel table
  instead: the detectability cut counts non-zero pixels per bin over a whole
  row, at every separation. It is counted once per run and only where the file
  carries no balancing weights — with them nothing is read for it at all.

- **A sequence a scan skips is named.** The cap's own documentation has always
  said a sequence past it is "skipped and named"; only the first half was true,
  so a run over a mammalian genome scanned whichever chromosomes happened to fit
  and reported a clean number for the rest. Worse, the message when *nothing*
  fitted said the sequences were not long enough, when the truth was the
  opposite.

- **`metacooler-run --sequences` binds.** The runners read that parameter with
  `Array.isArray` and fall back to *every sequence* for anything else; the shell
  passed a plain string, so `--sequences chr18` silently scanned all of them and
  reported a number from the wrong one. Affected loop calling and compartments.

- **The domain pileup — APA over a set of TADs, scaled — was laid out from the
  wrong end of the feature.** The scaled mode on a feature set is how you draw
  the picture that sits beside a loop APA in every Hi-C paper: call insulation
  boundaries, take the span from one to the next as a domain, and pile every
  domain up stretched to the same width with padding either side. It read the
  window as `[midpoint − flank, midpoint + length + flank]` — the right width,
  and half a domain to the right of where it belongs — so the body sat against
  the top-left corner of the picture with the whole flank on the far side. The
  window is now `[start − flank, end + flank]` on both axes, which puts the
  domain in the middle and its two boundaries on the cross through it.

  Nothing in the old figure said it was wrong, which is what makes this worth a
  paragraph rather than a line: a shifted domain pileup is still a square with
  bright and dark blocks in it, and the only way to catch it was to know where
  the corner peak should have been.

- **Every domain's boundary now lands on the same grid line.** A scaled window
  used to be stretched evenly onto the grid, so a 20 kb domain's edge fell on
  one column and a 200 kb domain's on another — averaging them softened both
  boundaries into a couple of columns of gradient, which in an aggregate looks
  exactly like a real boundary that is soft. The grid is now explicitly *flank,
  body, flank*: the body's two ends are pinned to their own columns for every
  domain whatever its length, and the flank each side is a fraction of that
  domain rather than a rounded number of bins.

- **A distance-matched control is shifted by a multiple of the window when the
  window is a scaled one.** Asked for in base pairs — the old control, and its
  100 kb floor — a control for a megabase-wide domain window was ninety per cent
  the same cells as the thing it was the denominator of, so the ratio came out
  at 1 everywhere and the domain washed out of the picture with nothing on
  screen to say why. The fixed mode still asks in base pairs, which is the right
  unit for a window a couple of dozen bins wide.

- A scaled window off the diagonal — a loop pileup whose window scales with the
  separation — is now symmetric about its anchor bin rather than a bin short on
  one side of it.

- **`metacooler-run` takes the `::/resolutions/<n>` address its own refusal
  tells you to write.** An `.mcool` is a collection of coolers, and opening one
  at its root is refused with a sentence naming the resolutions and an example
  ending in `::/resolutions/25000` — advice the shell could not then take,
  because the whole string went to `stat` and there is no such file. So there
  was no way into an `.mcool` from a command line at all. The `::` half is now
  split off for the filesystem and kept for the container, which is where the
  group is read from. Outputs are named `sample_25000.…` rather than `1000.…`,
  which is what `basename` of a group path had been giving them.

- The tick labels on a matrix output that are *positions* on a continuous axis
  rather than one-per-cell names no longer land over the first few columns of
  the exported TSV. They go in a `#` line saying what they are, and the columns
  keep their indices.


- **A contact map is never put on a track shelf.** A hub's `type hic` track has a row of its own
  that opens through the map door, and it was *also* going onto the genome row's shelf — so *open
  with its tracks* handed it to the annotation loader, which read the binary as text, sniffed it as
  a BED and reported that all 32,918 of its lines failed the contig/start/end test. A true sentence
  about the wrong question. A shelf is annotations, a contact map is not one, and the row that opens
  it as a map was there all along.

- **“Open with its tracks” loads them.** It opened the file and offered the tracks behind a button,
  which is the thing a reader who pressed those words had just pressed past. The heading verb now
  has a road of its own through the shell (`openWithTracks`) that marks the shelf as *asked for*,
  and a session with an asked-for shelf loads it instead of drawing the offer. Every other road to
  the same file — a row's own open verb, a `?store=` link, a dropped copy — keeps the offer, because
  opening a genome is not a request for eight more files. The mark is spent when it is read, so
  closing the tracks and reopening the same genome does not bring them all back.

- **The tracks published beside a genome are offered in the 1D browser.** The map path has offered
  its shelf since the demo map shipped with ten annotation files — one click, and a reader who
  brought no tracks has a picture — and the browser path never did. Nothing had noticed, because
  until now the only thing that registered a shelf was a store row whose file was a contact map.

  A track hub makes it the common case and makes it visible: an assembly hub's genome is its
  `.2bit` and its whole trackDb is the shelf that rides along, so *open with its tracks* on a hub's
  assembly heading opened the genome and dropped every track on the way. An IGV genome row carries
  the same shelf and was losing it the same way. The Tracks card now offers them in a browser
  session exactly as it does beside a map, through the same one question and the same gate — so a
  restored session, which is bringing its own tracks back, is still not offered them on top.

- **A 4DN `.hic` drew a blank map as *balanced* at 1 kb and 2 kb.** Juicer writes a `KR` entry for
  every chromosome whether or not the balancer converged, and where it did not the vector behind
  the entry is all `NaN` — the chicken maps carry one at 1 kb and 2 kb for every chromosome, beside
  a `VC_SQRT` and a `VC` that are whole. The reader chose its normalisation by name alone, per file,
  and never looked behind it, so every cell multiplied by `NaN` and the legend read 0 to 1. A
  chromosome whose preferred vector has no finite value in it now takes the next normalisation down
  the preference list (`hic/HicFile.ts`, `normVector`), and `normTypeFor` says which one it got.

- **Reading a single-cell container in small pieces looked hung.** The listing is a thousand
  synchronous range requests inside one h5wasm call, so the bar said *listing cells…* and nothing
  else for as long as it took — minutes on a slow link — and the open then went on to probe one
  dataset header per cell for a pixel count nobody was waiting for, another four thousand round
  trips. The requests now count themselves out loud (*listing cells · 512 reads — 8.0 MB*), and the
  per-cell count is skipped on that source: unknown is what it is, and the File card says so.

- **A file that is not HDF5 failed as `error - name not defined!`.** An HTML page saved under a
  `.mcool` name, a download that stopped short, a text matrix: h5wasm found no superblock and said
  so in its own words, which reached the screen as *something went wrong*. The container is now
  refused by its first bytes, in a sentence that names the file, and a failure h5wasm raises on a
  file that *is* HDF5 is said about that file and group rather than about nothing.

- **A contact map on Google Drive was downloaded whole.** A browser tells every host it accepts
  gzip, and Drive takes it up on an unranged `HEAD`: `Content-Encoding: gzip`, chunked, no length.
  The map door read that as a host that re-encodes what it serves — GitHub Pages does, and ranges
  through a gzip stream are garbage — and took the fallback for such a host, one `GET` of the whole
  file into memory, silently and whatever the size: 81 MB for the `.mcool` this was found on, and
  the same road for a 2 GB one. Drive answers every *ranged* request raw, so a `HEAD` that comes
  back re-encoded is now followed by one more, for `Range: bytes=0-`, and a 206 that is not
  re-encoded and states its length is read by range from there — the file's length, since the
  range is all of it. Pages re-encodes that too and is refused exactly as before, one request later
  (docs/hosting.md, docs/remote-sources.md).

- **A file picked from Google Drive took a long time to open, under a name that was its id.** A
  Drive file is addressed by an id, so nothing in its address says what it is, and the session took
  the contact-map door first: a `HEAD`, then HDF5 hunting for a superblock at doubling offsets — a
  megabyte chunk at each — through the whole of a bigWig, before the track door read the file's
  header three times over, four small requests each. Over the Drive API, where a request is the
  better part of a second, a 56 MB bigWig sat at *Opening 1pq7NDWo…?alt=media…* for most of a
  minute. The name a folder gives a file now decides the door where its address cannot, a bare
  address is asked what it is before the map door is tried, and the annotations worker reads a
  remote file in 256 KiB chunks it keeps, one handle per address — so the same open is three
  requests and 0.6 MB, and the loading screen and the tab say *ATAC_rep2_WBcel235.bw* (SPECS
  §24.9). A presigned URL's tab loses its signature the same way: a query string is the request,
  not the name.

- **Opening a 4DN BAM as a genome fetched the whole file.** 4DN's open-data bucket exposes `ETag`
  and nothing else to a page, so the browser could not see the `Content-Range` the file handle
  reads a size off, and the handle reported nought bytes. The bounded header read was then a read
  of nought bytes, "not a BAM", and the alignment file was fetched whole — gigabytes, behind
  *Reading 4DNFIV9TCZVO.bam* — to find out what its first block said. A size the handle cannot
  give is now asked for with a `HEAD`, whose `Content-Length` every page may read; a size nothing
  states is unknown rather than empty and the header is still read within its bound; and the
  browser opens from the header in three small requests, with the index's download drawn as a
  bar on the row while it is already on screen (SPECS §8.8).

- **A merged pull request's preview stayed in the About dialog's version picker.** Merging fires
  `pull_request: closed` — the run that deletes the preview — and `push` to `main` in the same
  instant, and both land in the `pages` concurrency group; GitHub keeps only the newest *pending*
  run in a group, so whenever something was already deploying, the removal was cancelled about a
  second after it queued and the review copy outlived its review. #49 and #50 were both lost that
  way, behind a deploy the Stores workflow had dispatched a minute earlier.

  The deploy now reconciles rather than trusting the event: before publishing, it asks GitHub about
  every preview in the manifest and drops the ones whose pull request is no longer open. That also
  covers a removal that failed outright, and one whose pull request closed while the workflow was
  broken. A pull request the API will not answer for is left alone — *I could not ask* must not read
  as *it closed*.

- **The 4DN shelf could not be generated at all.** Its first live run died on
  `IncompleteRead(43378383 bytes read, 39983032 more expected)`: the widened query asks the portal
  for every experiment set with all four of its file arrays embedded, which is an 83 MB response,
  and the socket closed half way through it — as a Python traceback, where every other failure in
  `make_store.py` is a sentence saying what to do. IGV and ENCODE published fine; nothing was
  published, because a run that loses one front end publishes none of them (the branch is replaced
  wholesale, so a missing store would delete last week's good copy of that shelf).

  4DN's search is now paged — 50 records a request, each retried on its own — and **ENCODE's is
  deliberately not**, which the next run proved the hard way: paged uniformly, ENCODE answered
  `&limit=500&from=0` with `403 Forbidden`, having answered the same query with `limit=all`
  perfectly the week before. The two portals want opposite things of one search, both answers are
  measured, and `--page-size` is there for the run that disagrees. A 403 on a page now names
  `--page-size 0` in its own message, since that is the fix and no status page will suggest it.

  Around that: every whole read is retried three times when a host agrees to answer and then stops
  talking. An HTTP *status* is still never retried, since 4DN answers a search matching nothing
  with a JSON-bodied 404 and retrying that would turn zero results into a failure. The paged walk
  stops on the portal's `total`, on a short page, or on a page that repeats what it has already
  sent — and that last one fails the run when it happens early, because a portal ignoring `from`
  would otherwise publish a catalogue that draws with empty cells in nine rows out of ten.

  The suite drove the generator only through recorded responses, which is how this shipped: the
  recorded path reads a file and the live path walks a portal. `--portal-base` now points a front
  end at a portal served by the test itself — out of process, since `spawnSync` blocks the one
  running the assertions — and the five ways a walk ends are each made to happen, including the cut
  off response that started this.

### Removed

- **The header's plug and `+`.** *Connect a place* and *Add a file to this tab* stood in the header
  beside the store drawer's toggle and were the Files column's own *Open a local/remote folder* and the file
  crumb's *Open a file* said a second time, one row up; a header with three doors to a file read as
  three different things. Both verbs stay in the command palette, and dropping a file still adds
  it. The hints that pointed at "the plug in the header" now point at the Files column.

- **The Buckets card, the bucket browser and the shelves dropdown.** The plug's *Buckets* card
  listed what the Files panel already lists and edited keys the provider pane now edits; the
  *browse bucket…* dialog behind four URL boxes browsed buckets and nothing else, where the window
  can be connected to a folder, a Drive or a Dropbox too; and the eighteen-entry dropdown of
  shelves, the landing page's URL box and its *private buckets…* button were the store tiles, the
  Load box and the plug under other names. The two 4DN maps that sat in the Demos store are on
  4DN's own page, where every 4DN map is. Earlier unreleased builds called a store a *hub*
  (`metacooler.hub`, `?hub=`, `make_hub.py`, the `hubs` branch); none of those names is read any
  more.

- **The `log₂ ratio` combine operation.** It was a scale wearing an operation's
  clothes: it put the same finding in two rows and left only one of them
  exportable as the quantity it measured — a bigWig of log₂ ratios is a file of
  a *picture*, and anything downstream that wanted the ratio had to undo it. The
  reason it existed is real and is answered above, on the lane's own axis. Two
  operations remain, a ratio and a difference, and either can be *drawn* as a
  logarithm.

- **The `Domains (CIDs)` task**, which was withheld from the panel on every file
  and is now redundant. Everything it did is reachable and in one place:
  insulation calls the boundaries, calls the domains between them, and an APA
  over those domains is the pileup. What it added over that was a composite
  whose three settings never reached the step they named — `AnalysisRunner.plan`
  walks a required task at *that task's* defaults — so its window, its region
  and its prominence changed nothing, and its estimate read a window labelled
  base pairs as a count of bins. A task nobody could run, whose settings did not
  work, duplicating two that do.

- **Diamond insulation calls the domains between its boundaries, and does it by
  default.** A second overlay beside the calls: the span from each boundary to
  the next, drawn as a segmentation the way the A/B compartment track is, and
  exportable as BED like any other called interval set. A boundary set is half
  an answer — everything downstream of insulation takes an *interval* rather
  than a point, and the scaled pileup over these is the domain APA — so what
  every reader was doing by hand (sort per sequence, pair the neighbours) is now
  a tickbox, and it is ticked.

  Three decisions in it. Consecutive domains **tile**: one ends where the next
  begins, so the lane reads as a segmentation rather than as boxes with gaps,
  and a domain's two corners sit on the bins the calls were actually made at,
  which is what a scaled pileup lines up on. Each carries the **weaker** of its
  two edges as its score, because a domain is only as well defined as its
  worse-supported side and reporting the stronger would let one good boundary
  vouch for a run of bad ones. And **two boundaries make a domain, one makes
  nothing**: the two ends of every sequence are left out rather than run to the
  telomere, which would assert an edge the data never placed.

  On the yeast demo: 710 boundaries across 16 sequences, and 694 domains — one
  fewer per sequence, which is what the arithmetic says it should be.

- `metacooler-run` writes a called interval set as **BED** beside its TSV, the
  way it already wrote bedGraph and bigWig beside a profile's. The drawer has
  carried a BED button since there were called intervals at all; a batch run got
  a TSV with a provenance header, which is readable and is not what bedtools
  takes.

## [0.12.0] - 2026-09-10

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

- **A deep scan of the source, and the thirty-one defects it confirmed.** Ten
  review passes over `src/` — the binary readers, the text parsers, rendering,
  the analysis tasks, session state, the network path, the UI, the deck, the
  workers, and documented-versus-actual behaviour — with every finding handed
  to a second reader whose brief was to *refute* it. Six claims died there.
  What survived is below, grouped by what it cost rather than by where it
  lived. Every one carries a test that fails without its fix.

  **Wrong answers, silently.** A version-9 `.hic` was walked with version 8's
  footer layout: v9 narrowed each per-chromosome scale factor from float64 to
  float32, and the walk still advanced twelve bytes per chromosome per vector
  instead of eight, overshooting the normalisation index. Depending on what the
  misplaced cursor met, the file either failed to open with a raw
  `RangeError` or opened with its balancing weights silently missing. The
  reason it shipped is the more interesting half: the fixture writer emitted an
  *empty* expected-value section, so no test ever executed the loop, and the
  `hic-straw` oracle reads v9 through a header pointer rather than by walking —
  so it agreed with us no matter what we did. The fixtures now write those
  sections populated, at each version's widths, and the oracle fixture zeroes
  that pointer to force both readers down the same path.

  A tabix-indexed `.gtf.gz` or `.vcf.gz` was refused outright. Byte spans from
  the index start at BGZF *block* boundaries, which are not line boundaries, so
  the first and last lines of every fetched span were record fragments handed
  straight to the parsers — twenty-two lines, none of them parseable, and a
  message blaming the file. The seams are trimmed now, with the two edge cases
  that make the obvious rule wrong handled explicitly: a span starting at byte
  0 begins on a real record, and a file whose last read reached EOF may
  legitimately end without a newline.

  A `drain()` sized its buffer by `Content-Length` while reading a body the
  host had gzipped in transit — so the declared length was the *compressed*
  size and the file was cut to a fraction of itself and returned as complete.
  A body arriving *shorter* than promised was likewise accepted in silence. Of
  everything here this is the one that most deserved finding: silent truncation
  of scientific data that nothing downstream can detect.

  A scaled-region metaplot mapped each window's base pairs uniformly across all
  of its columns, which is only correct when a feature happens to be exactly
  `body × step` long. Every other feature had its flanks compressed and its
  body stretched by a different amount, so an average over features that are
  genuinely aligned came out smeared. The mapping is piecewise now — flank,
  body, flank — and reference-point mode was verified bit-identical across four
  hundred randomised windows before and after.

  A BED domain vanished the moment you zoomed inside it: an `element` overlay
  was culled by its bottom-right corner rather than tested for overlap, so any
  feature larger than the view drew nowhere. A `border` mark was stroked
  *along* the diagonal, over the pixels it exists to point at. A gappedPeak's
  signal statistics were read from columns 7-9, which in BED12+3 are
  thickStart, thickEnd and itemRgb. A headed annotation table with twelve or
  more columns had two unrelated columns decoded as BED12 blocks — now settled
  by checking that the blocks actually *tile* the feature rather than by
  counting columns, which also catches the headerless case a header could not
  have saved. And a per-bin profile carried across a resolution change was
  exported against the grid the session is on *now* rather than the one its
  values were computed on.

  **Privacy.** "Forget everything" cleared the stores and then let the very next
  state change write the durable record straight back. And a share link, which
  carefully strips private local filenames from two of the three places they
  appear, carried the third: a lane's companion URI rode through untouched, so
  a link still spelled the sender's filename into the fragment.

  **Things that stopped working, or never did.** Closing the share dialog left
  `App.modal` pointing at it forever, and every command guarded by "no dialog is
  open" — the palette, the shortcut sheet, About — was dead for the rest of the
  tab. Clearing a number box set it to the minimum, because the guard tested
  `Number.isFinite(Number(''))` and `Number('')` is `0` — the comment beside it
  said exactly that and the code did it anyway; the same dead guard was in four
  places, including a mapping-quality floor where the wrong answer was quieter
  still, since `0` legally means "keep everything". A modal set
  `aria-modal="true"` and never trapped Tab, so a keyboard user walked out onto
  controls the backdrop was covering. Two notes shared one fixed corner, so a
  progress note covered the truncation warning that is specified to stay until
  dismissed — both are placed by a column now, which is also why the warning
  can outlive the job. Importing a workspace into a full window imported
  nothing and still overwrote the reader's overlay preferences and column
  layout. In a deck at chromosome level the lock compared spans in bin sizes
  rather than in sequence lengths, so two panels showing the identical
  chromosome list were told they could not be locked and the deck blamed the
  files; a companion still opening was reported as having one resolution, and
  the false line never cleared; and the deck's own map list ignored the names
  the reader had given. Every ordinary multi-chromosome `.pairs` import was
  labelled unsorted, because the sortedness test assumed a global ordering the
  declared `chr1-chr2-pos1-pos2` sort does not have — the repair pass it
  triggered was harmless but the label was not, and it is now raised only for
  disorder that ordering cannot explain. A `metacooler-run` that listed sixteen
  tasks could run twelve; `overlap` and `motif` now genuinely run, and
  `metaplot` and `trackcorr` are refused before a file is opened, because they
  need a bigWig reader the repo's own layering confines to the annotations
  worker.

  **Retention and lifecycle.** A `HeatmapView` destroyed while frozen kept
  re-scheduling `requestAnimationFrame` on a detached canvas for the life of the
  tab; the ladder that took the freeze never gave it back on teardown, leaving a
  panel frozen for a read that would never report; and a deck navigating to a
  table went on parenting the previous, already-destroyed map — a canvas with a
  full-resolution backing store behind it. The bin file of a private HiC-Pro
  pair was never signed, so the half carrying every coordinate came back 403
  while the half carrying the counts arrived. A Stop pressed while a task was
  in flight was read only *before* the step, so a run cancelled mid-step still
  finished, cached and adopted its result.

  Two smaller ones for completeness: an S3 bucket scope whose prefix contained
  an escaped character listed nothing, because the prefix was handed to S3
  still percent-encoded; and a dropped-feature count was reported once per
  ticked track rather than once.

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
