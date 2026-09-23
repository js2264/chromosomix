# Glossary

Every word this project uses in a sense of its own, and the handful it uses in two.

It exists because the vocabulary is load-bearing. The code, the specification and the interface are
written to say the same thing with the same word — a *lane* is not a *track*, a *companion* is not a
*second file*, and a *session* is not a browser tab — and a reader who has the wrong model of one
term will misread every docblock that leans on it. Where a word genuinely carries two meanings, that
is recorded here rather than quietly tolerated: see [Overloaded words](#overloaded-words), which is
the section to read first if something has just surprised you.

The authority is the source. Each entry names the file that owns the concept, and where
[`SPECS.md`](SPECS.md) settles the design the section is cited as `§n.n`. Where this file and the
code disagree, the code is right and this file is a bug.

---

## Contents

- [The three shells](#the-three-shells) — window, session, tab
- [Persistence](#persistence) — what is remembered where, grants and connected folders
- [What is being looked at](#what-is-being-looked-at) — view state, views, levels
- [Files and addressing](#files-and-addressing) — cool, metacool, entries, URIs, stores
- [Genomes and sequences](#genomes-and-sequences) — genome, contig, assembly, naming
- [Maps on screen](#maps-on-screen) — lead, companion, deck, cell, star, the second file
- [Annotations](#annotations) — track, lane, placement, group, mark, bookmark, structure
- [The picture](#the-picture) — score, transform, clip, the turn, refine
- [Analysis](#analysis) — task, availability, result, synthetic track, figure spec and style
- [Machinery](#machinery) — workers, sources, budgets, grants, buckets
- [Build targets](#build-targets) — web, desktop, standalone, pinned, CLI
- [Overloaded words](#overloaded-words)
- [Doctrines](#doctrines) — the rules cited by number everywhere

---

## The three shells

Three things nest, and only the middle one is unusual.

### window

The browser tab the application is running in, and the object that owns its furniture: the header,
the tab strip, the four columns, the status bar and the address bar. The class is `App`
(`src/app/App.ts`); prose calls it **the window** when the subject is layout, **the shell** when the
subject is what it does for a session, and **this browser tab** when the subject is what it costs the
machine (`src/ui/StatusBar.ts`).

There is deliberately no shorter noun. "Tab" is spoken for.

Three things are per window rather than per session, because they are preferences about this window
rather than facts about a file: the **theme**, and the **fold** and **width** of each column.

### session

One file, its views, its tracks, its annotations and its settings — and a real object rather than a
label: its own reader worker, its own annotation worker, its own stores, its own DOM
(`src/app/Session.ts`, §5.6). Switching tabs re-parents that DOM rather than rebuilding it, so a map
comes back with its pixels, its zoom and its scroll intact and without a byte re-read.

At most `MAX_SESSIONS` (12) at once — a memory limit, not a rendering one, since each session that
has opened something holds a worker, an h5wasm instance and possibly a whole matrix. Ids are minted
per page load as `s1`, `s2`, … and reserved across a restore so a remembered `s3` and a fresh one
cannot collide.

**Two tabs on one file share nothing.** Per-session memory is keyed on the session id *and* the URI,
so a second view of the same map starts with no tracks, no filters and no marks.

A session is one of two shapes, and much of the interface gates on which:

- a **map session** — a contact matrix is open (`hasFile`);
- a **browser session** — a 1D genome browser over an [assembly](#assembly), with no matrix at all
  (`isBrowsing`, §5.8).

### tab

The affordance for a session, in the strip under the header (`src/app/TabStrip.ts`). *A tab is a
session*, which is a stronger claim than a browser tab makes about a page — hence the strip showing
the file as the label and the tab's state in the tooltip.

### primed

A tab that holds a view state and has read nothing. It is what a restored tab is until it is
clicked: the label and the address bar could be written from it, and no byte of the file behind it
has been touched. Clicking is what reads it. This is the whole of what makes remembering eight tabs
cheap.

---

## Persistence

Five tiers, each with a rule. The rules are the design, not an implementation detail.

| Tier | Store | Scope | Holds |
|---|---|---|---|
| **view state** | URL hash | the active tab only | what is *being looked at* (§5.5) |
| **UiMemory** | `sessionStorage`, key `sessionId\|path` | one file in one tab | tracks, marks, bookmarks, ticked sequences, table filters |
| **sessions** | `sessionStorage` | the window | which tabs exist, and which was active |
| **workspace** | IndexedDB | survives closing the browser | every tab as a full `SessionConfig` |
| **preferences** | `localStorage` | the browser profile | theme, column folds and widths, bucket keys, dismissals |

The dividing lines:

- the hash carries what is **shareable** — a link that silently carried "only rows where completeness
  > 90" would mislead whoever opened it;
- `sessionStorage` is for a **train of thought**, which belongs to the window it was had in;
- `localStorage` is for a **preference**, which does not.

`sessionStorage` always wins over the durable record. The IndexedDB copy is consulted in exactly one
case — there is no session storage at all, which is precisely "the browser was closed".

### workspace

Every open tab, as one object (`src/state/workspace.ts`). It is the whole application instance rather
than any one file, and it has three lives:

- the **live** workspace — this window and all its tabs, written on a debounce and flushed when the
  page goes away. `{ version, savedAt, sessions: [{ id, config }], active }`, in IndexedDB;
- a **saved** workspace — the same idea as a file, written by the header's save button. A different
  shape, and deliberately: see [workspace file](#workspace-file);
- a **published** workspace — a saved one that names remote data, so a manuscript's five figures can
  be five tabs somebody else opens. What the demo catalogue is.

The live one is **offered, never applied**. Silently reopening six files a week later would reverse
the decision the reader made by closing them, and on a shared machine it would put somebody's
unpublished figure on screen for whoever sat down next (§11). *Start fresh* is a real answer and
deletes the record.

A **saved** one is the mirror rule: *added, never substituted*. Dropping a workspace file appends its
tabs beside what is open, because six open tabs were the reader's and there is no undo. The one place
that replaces a window is the offer above, which has asked first.

### session config

A whole tab, written down (`src/state/SessionConfig.ts`): the view state, every track with its
colours, limits and groups, the manual marks, the bookmarks, the ticked sequences, the table filters,
the deck's arrangement, the analysis recipes. **Never a file on its own** — it is always one entry
inside a [workspace file](#workspace-file), which is what a config travels in on all three roads:

- a **saved file** — every open tab, written by *Save this workspace*;
- a **link** — a workspace of *one* tab, deflated and base64url-encoded into the fragment under `s=`
  (`src/state/shareLink.ts`). One tab because a link is *what is being looked at* (§5.5) and there is
  one of those on screen. The **fragment** specifically, because a fragment is not sent to the
  server, so the contents of somebody's session never reach the host;
- the **durable record** — one config per tab, in IndexedDB (see [workspace](#workspace)).

A config carries no `kind` of its own: the file around it names itself once, and a second name inside
every entry would be a claim with nothing to check it against.

A config is deliberately **portable**: `applyConfig` re-keys it into whatever tab imports it, so a
session saved from tab 3 opens in tab 7 without dragging tab 3's memory with it. Relative names
inside are resolved against the file's own URL (`resolveConfig`), which is what makes a dataset
folder a self-contained thing that can be copied to another bucket and still open — and the same
step *drops* the two names that could only ever have meant a file on the sender's own disk, a local
compared file and a local deck companion.

### workspace file

A [workspace](#workspace) as bytes: `workspace-<stamp>.metacooler.json`, `kind:
"metacooler.workspace"`, holding every open tab as a [session config](#session-config) and naming the
active one by **index** (`src/state/workspace.ts`). Written by the save button in the header; drop it
back and its tabs are *added* beside whatever is open.

By index and never by session id, which is the one real difference from the durable record: a
sender's `s1` means nothing in a recipient's window and would collide with a tab they already have.
The record keeps its ids, because there they are live and are what puts a reader back in the window
they left.

The published demo catalogue is three of these, each a workspace of one tab (`src/ui/examples.ts`).

### detached

The state a **local** file's track comes back in after a reload: the settings survived in session
storage, the bytes could not — no browser re-reads a dropped file without a fresh gesture — so the
row is shown with its colours and limits intact and a button to point at the file again. The same
word describes a whole session restored from a config that names a local file.

### grant

Permission to re-read a local file, kept across a reload (`src/state/handles.ts`). A
`FileSystemFileHandle` is a **capability**, not a path and not a copy: it cannot be read as text,
cannot be sent anywhere, and names nothing a server could act on. Keyed by the file rather than by the
tab, because two tabs on `rep1.cool` must share one grant.

### connected folder

A place the window keeps and browses, rather than a file it opened (§20, `src/browse/`). Four
things are one here: a **directory on the machine**, a **key prefix on a bucket**, a **Google Drive
folder** and a **Dropbox folder**, read through the same
interface — given a path, the sub-folders and the files; given a file, how to open it. Shown in the
**Files** panel, which is the one side column that is not about the file the session is of.

A connected folder is a wider grant than a [grant](#grant) above it: the page can see the *names* of
everything under it and read any of them without a further gesture. Where the bytes go is unchanged
— nowhere — and every one is listed and revocable in the stored-data screen.

### durable *(of a folder)*

Whether a connected folder survives a reload, which depends on the browser and is stated on its row.
Chromium and the desktop build have `showDirectoryPicker`, so a directory is held as a
`FileSystemDirectoryHandle` in IndexedDB and the folder is genuinely connected — live, and still
there tomorrow. Firefox and Safari have no such thing: `<input webkitdirectory>` hands over a flat
`File[]`, from which the tree is rebuilt once. That is a **snapshot** — it does not update and it is
gone after a reload — and the row says *this visit* rather than letting the reader find out later. A
bucket is always durable, being a line in `localStorage`.

### public scope

A [bucket scope](#bucket-scope) with no credential: a URL prefix and nothing else, listed and read
unsigned (§20.3). The rule is all three signing fields or none, so a half-filled row is dropped
rather than downgraded — falling back would turn a mistyped secret into a bucket that 403s on data
the reader believes they have a key for. Browsing one needs `s3:ListBucket` granted to `*` in the
bucket policy, which is a different grant from the `s3:GetObject` that makes the files downloadable
and which most published buckets do not have; that is a normal configuration rather than a fault.

---

## What is being looked at

### view state

The one object the URL hash is an encoding of (`ViewState` in `src/types.ts`, §5.5). It names the
file, the view, the place, and how the numbers are drawn — and deliberately **not** pan, zoom, table
filters or the loaded tracks, because a URL that rewrote itself on every wheel notch would make the
back button a scrollback.

### view

One of nine kinds (`ViewKind`):

| Kind | What it is |
|---|---|
| `genomes` | the genomes table — the landing view of a metacool (§5.1) |
| `contigs` | the contigs table; called **Chromosomes** on a plain cooler |
| `genome` | one genome's own matrix (§5.2) |
| `pair` | the block between two genomes (§5.3) |
| `region` | one contig, or a contig × contig block (§5.4) |
| `whole` | the whole file as one bounded read |
| `overview` | the genome × genome scan — the one expensive operation, and gated (§7.3) |
| `selection` | several ticked genomes or contigs at once |
| `browser` | the 1D genome browser, with or without a matrix (§5.8) |

### region vs focus

The distinction is felt rather than technical, and it is why bookmarks do not simply set `region`:

- `region=chrI:1200000-1260000` **cuts a block** at those coordinates. Panning stops at its edges;
  there is nothing outside them to see.
- `focus=chrI:1200000-1260000` names a **window over a block read whole**, so the picture opens on
  the locus and the rest of the chromosome is still there to pan into.

`focus` is a one-shot initial condition, applied when the block arrives and never written back, so
the link keeps pointing at the place it was made for.

### level

What one row of the matrix is: `bin`, `contig` or `genome`. One key rather than two, because it is
one question — what are the axes made of — and each view reads it through its own accessor, which is
where a value that view has no use for is translated to the one it lands on.

### locus

A window in a genome browser, written the way every genome browser writes one and the way the locus
box accepts one: `chrI:1,001-20,000`, 1-based inclusive. Absent means the whole genome.

---

## Files and addressing

| Term | What it is |
|---|---|
| **cool** / **mcool** | a cooler: one genome, fixed bins. An `.mcool` is a ladder of resolutions |
| **metacool** | the primary case — multi-genome, carrying a `/genomes` layer (§3.2) |
| **mmetacool** | a *container* of complete metacools, and **not itself a valid cooler** (§3.4) |
| **hic** | juicer's format, read as a cooler-class citizen (§3.6) |

### URI

`file::group`, exactly as `metacooler.uri.parse_uri` writes one (§3.5):

```
f.metacool                    → { path: "f.metacool",  group: "/" }
f.mmetacool::entries/rep1     → { path: "f.mmetacool", group: "/entries/rep1" }
f.mcool::resolutions/1000     → { path: "f.mcool",     group: "/resolutions/1000" }
```

The `::` half is which dataset *inside* the container. Everything keyed "per file" is keyed on the
path before `::`, because an `.mcool` at 1 kb and the same `.mcool` at 5 kb are one file.

### entry

One complete dataset inside a container — a nested metacool in an `.mmetacool`, a resolution in an
`.mcool`. The app infers which kind of collection it is holding from the names alone:

- **every name parses as a positive integer** → a `zoomify` **resolution ladder**; the entries drive
  the zoom control and the entry picker is hidden;
- **otherwise** → a **sample or replicate collection**; the entry picker chooses the dataset.

Opening a container at its root is an error that lists what is inside, which the picker turns into
buttons.

### rung

One level of a resolution ladder, as a bin size (`src/ui/refine.ts`). A sibling rung is a different
[bin space](#bin-space) entirely, which is why moving between them is a reopen rather than a
navigation.

### `__unbinned__`

The reserved contig name for pixels that belong to no bin. Never displayable (§7.4).

---

### store

A shelf of named data somebody published: one JSON file (`kind: "metacooler.store"`, §24) listing
maps, genome files and workspaces with columns to filter on, so a reader chooses without opening
anything. The app ships four — the lab's own figures, IGV's genomes, 4DN and ENCODE — and a reader
connects any other by URL. Each is a page in the **store drawer** (§24.2): a *gallery* of cards
whose one button opens a pre-configured session, or a *portal* of facets with a matrix across any
two of them. A row becomes a `PickedFile` the moment it is pressed, so a store is a door and not a
source: what opens is the file the row names, on whatever bucket that is. Nothing is fetched until
its tile is pressed. Earlier builds called it a *hub*; that word is gone.

## Genomes and sequences

### genome

One organism in a metacool — a **MAG**, in metagenomic assembly terms. The `/genomes` table is the
landing view, and `hasGenomes` is the predicate that says a file has this layer at all.

`hasGenomes` is load-bearing: a file with a genome layer gets **no annotations** (§8.5), **no deck**
(§16.8) and **no second-file split** (§5.7), because its axis is contigs from thousands of
independently assembled organisms and there is no coordinate system for a second thing to share.

### contig

One sequence. Called **Contigs** on a metacool and **Chromosomes** on a cooler, and the word is not
cosmetic: a cooler holds one genome's chromosomes, and calling them contigs asks the reader to
translate on every screen.

### assembly

A genome with no contact map behind it: a list of sequences and their lengths, from whatever named
them (`src/genome/assembly.ts`). It is the other starting point of the application — the one a
browser session is built on — and its **origin** records how far to trust its lengths: `sizes`,
`bigwig`, `bigbed`, `fasta`, `features` (the largest coordinate anything mentioned) or `cooler`.

### naming, and a match

Two files of the same genome disagree about its names more often than they agree: `chr1`, `1`,
`chrI`, `01`. `src/genome/naming.ts` answers one question — does this name, in this file, mean the
same sequence as that name, in that one — under a rule worth knowing: **it never silently matches two
different sequences.** No match is a blank panel and a sentence saying why; a wrong match is somebody
else's chromosome drawn under your label, which nothing on screen would show. Length vetoes rather
than persuades, and an opaque assembler contig (`NODE_1_length_…`, `k141_9`) is matched by its
spelling and not otherwise.

### bin space

The coordinate system the matrix is indexed on — absolute bin numbers across the whole file, as
against base pairs or per-contig offsets. The phrase appears throughout the reader and the renderer
and is the reason **"space" is not available as a name for anything else in this project.**

---

## Maps on screen

Two different ways a second file can appear, and conflating them is the commonest mistake.

### lead and companion

A **deck** is *companions plus a lead* (§16, `src/panels/deck.ts`).

- The **lead** is the session's own file. It owns the breadcrumb, the tables, the tracks and the
  second-file split, and it is not in the companion list. Its `MapId` is the constant `lead`.
- A **companion** is a file and a worker and nothing else.

Exactly one file has to decide what the session is *of*, or the breadcrumb has no subject.

### deck

N maps side by side in a grid, drawn from the `maps=` key of the view state — `|`-separated, because
a comma is legal in a URI and a pipe is not. `MAX_PANELS` (64) is a backstop against arithmetic
rather than a policy: the real limit is bytes, since the per-panel read budget is this tab's budget
divided by the panel count.

### vacant

An empty cell: a link's memory of a *local* companion, with no bytes behind it and a drop rectangle
where its map would be. Written as `~` in a link, so a shared deck keeps the count and the order of
what was sent even where it cannot keep the bytes (§11).

### cell

Any occupant of the deck (§16.11, §25): a map (the lead or a companion), a **vacancy**, a
**structure** cell drawing the session's 3D model, or a **tracks** cell drawing the session's tracks
alone. Only the maps are members of the lock; the other two are told the lead's window as loci and
never report one back. In a link: a URI, `~`, `3d`, `tracks`.

### star

Which map of a deck the Analysis column reads (§18.2) and the Aesthetics column's *Map* card sets
(§16.5). It starts on the lead; a filled star pressed leaves **no map starred**, in which state the
card sets every map at once and no task can run (§18.1). A structure cell has a star of its own,
saying which cell the *3D structure* card sets — or, with none filled, that it sets them all (§25.3).

### the second file, or compare

A different concept from a companion: a second cooler drawn into the **lower-left triangle of the
same square** (`uri2`, §5.7). A contact matrix is symmetric, so half of every square is a mirror
carrying no information; giving that half to another file makes the picture asymmetric, which is what
the eye reads a difference from.

The distinction in one line: **a file blended into this square has to share its grid; a file beside it
has only to share its coordinates.** So compare refuses a different bin size or a different chromosome
list, and a deck does not. A session can hold both at once.

---

## Annotations

### track vs lane

The sharpest distinction in the repo (`src/annotations/placement.ts`), and it exists because a deck
holds N maps and a track can be on any edge of any of them:

- a **track** is the *import* — the file, the data, the label, and the style that is true of it
  wherever it appears;
- a **lane** is *one placement* of that track — a map, an edge, and a sparse patch over the track's
  style.

A track with **no lanes** is imported and undrawn. That is a real state, and it is what makes "take
it off every map" not mean "throw it away".

Only two fields may differ per lane: `limits`, because a ceiling is a fact about one library's depth,
and `flip`, because which way a lane grows is a fact about the edge it is on. **Height deliberately
may not** — a deck reserves the same lane room on every panel so the maps line up to the pixel.

### placement and edge

Which of the map's four edges a lane sits on: `top`, `right`, `bottom`, `left`. A track may be on
several at once. A tracks cell has one edge, the bottom; the other three are greyed for it.

### structure, model, chain, bead

A **structure** is a file of beads with a place in space (g3d, bed3d, §25) and the row it makes in
the Structures card — a row that is also a feature set, since every bead is an interval, and that is
never a lane. A model can also be *made* from the map (§25.6). A **model** is one set of coordinates; a **chain** is the beads of one sequence and one
haplotype in genomic order; a **bead** is one row of the file, whose **width** is the spacing the
file was modelled at, inferred from its starts and independent of the map's bin size.

### telomere *(on a model)*

**Both ends of a chain**, marked on the 3D model with a yellow bead (§25.5). It is a *chain end* and
claims no more: strictly a telomere is the end of a chromosome and a model of part of one has chain
ends and no telomeres, but a model's own lengths are a lower bound and a lower bound cannot
establish an end — a rule that tried came out with five marks on a whole yeast genome where a reader
was looking for thirty-two. A chain of one bead gets one mark, and beads the file left unplaced are
skipped.

### ghosted

Drawn at the **ghost opacity** rather than whole (§25.5): what lies outside the deck's window, and
what the reader clicked away in the key. A real transparency — the bead keeps its hue and lets what
is behind it through — and at an opacity of **0** it is gone, drawn no more than a hidden bead is.

### method *(of a model made from the map)*

Which published reading of a contact count *Model from the map* uses (§25.6), and they are two
methods rather than two settings of one. **pastis-NB** (the default) treats a count as a *count*,
negative-binomially distributed with a mean of `β·d^(−α)`, and returns the coordinates that make the
counts most probable; a pair counted **zero** times is evidence that its beads are far apart, so
nothing is filled in, and a count's precision is carried by the likelihood rather than by a weight.
It is solved on the **raw** counts, with the file's balancing weights folded into the mean as
`bᵢ = 1/wᵢ`, because a balanced value is not a count and overdispersion is a statement about one.
**ShRec3D** treats a count as a *measurement of a distance*, `c^(−1/α)`, fills in the pairs the map
never counted so the matrix is complete, and places the beads by classical scaling and weighted
SMACOF. pastis-NB is started *from* the ShRec3D model, so the second is not a replacement for the
first.

### dispersion *(r)*

How much more variable a map's counts are than a Poisson's would be, as the `r` of a negative
binomial whose variance is `μ + μ²/r` (§25.6). Large `r` is no overdispersion at all — a Poisson,
and a run that finds it says so rather than implying a parameter it did not measure. pastis-NB fits
`r` **per genomic separation** rather than once for the map, because Hi-C counts scatter further
from their mean the further apart the two loci are; the effect on the model is that a pair's pull is
the Poisson's own, shrunk by `r/(r + μ)`.

### card

Which list a track is listed in (`AnnotationCard`): `linear` (drawn beside the map), `overlay`
(drawn on it), `metadata` (columns the file already carries), `synthetic` (computed), `structure`
(3D models, loaded or computed, drawn by the deck's cell). Each is absent —
not disabled, not empty — on a file that cannot carry it (§8.1, §8.5).

### kind

What a track *is*, as parsed (`AnnotationKind`): `gtf`, `track` (a bigWig, bedGraph or wig, resolved
as a profile), `segments` (bed-like), `pairs` (bedpe-like), `sequence` (a FASTA), `metadata` (a
numeric column of the file's own) and `classes` (a categorical one, drawn as runs of colour with a
legend rather than as a barplot of however the categories happen to be numbered).

Kind and card are independent: a [synthetic track](#synthetic-track) is `kind: 'track'` and
indistinguishable from a loaded bigWig from the renderer down. What makes it its own *card* is only
that it is grouped under one heading and carries an export row the loaded tracks have no use for.

### group

A set of tracks sharing one autoscale, so two strands of the same experiment are read against one
ceiling.

### mark

A **manual annotation**: a line, an arrowhead or a rectangle the reader draws themselves, entered as
coordinates or picked on the map. This is the card that makes a figure, and nothing in it comes from
a file. A mark never sits on the pixel it is about.

### metadata annotation

A column the open file already carries about its own genomes, sequences or bins — completeness,
contamination, a balancing weight — drawn against the map's own cells (§8.12). Discovered rather than
loaded, which makes it the one card a `.metacool` gets.

### bookmark

A saved **place**, with the resolution it was found at (§8.10). Not an annotation: it holds a
coordinate rather than a thing drawn at one, which is why it has a card of its own.

### derived

A source kind with no file behind it: a row computed from two other tracks by an operation, holding
no data of its own and reading whatever the two it names have in hand at the moment it is drawn. An
operand that is removed takes the derived row with it, so it can fail to draw but cannot be wrong.

Distinct from **synthetic**, which is [an analysis result](#synthetic-track) and does carry values.
Both are distinct from the **virtual 4C lane**, which no longer exists: shift-drag used to create a
reading of the picture belonging to no card and remembered nowhere, and the 4C *task* now answers the
same question from the file (§18.9).

---

## The picture

### score

What the numbers in the cells *are* — the one question the picture cannot answer about itself
(`src/ui/scores.ts`). A `/pixels` column (`count`, or any extra column the file carries), or one of
the normalisations: the file's own `balanced` weights, or VC, VC √ and ICE computed here.

Part of the shared view rather than a preference: two people looking at the same link have to be
looking at the same numbers.

### O/E

Observed over expected — each cell divided by what its genomic distance predicts. Deliberately **not**
one of the scores but a toggle beside them, because it does not answer "what number is in the cell",
it answers "compared to what", and it composes with every score (the standard reading is O/E *of*
balanced counts).

### transform and clip

The scale a value is drawn on (`log1p`, `log10`, `log2`, `none`) and the bounds of the colour ramp.
Absent bounds mean the automatic percentile rule (§7.1). `log2` is the viewer's own, for ratios,
because only a logarithm puts twice and half the same distance either side of neutral.

### the turn

The map rotated 45°: position along the bottom, distance from the diagonal up the side (§17,
`flip` in the view state). **Absent means turned** — a band along a genomic axis is what a contact map
is for, and the square is the thing a reader asks for. Ignored quietly by any view whose block has no
diagonal to measure from.

### refine

Reading finer data as you zoom: passing what the block in hand can show reads the window again at a
finer grid — one bounded read, the map held still while it happens, never below the file's own bins
(`src/ui/refine.ts`). Off by default; the alternative is one read per view and a zoom that magnifies
it.

---

## Analysis

### task

Data, not a screen: an id, a title, a predicate saying which files it applies to, a list of
parameters, a list of outputs, a cost estimate and a function (§18.2). **Adding a task is adding a
descriptor**, never adding a screen — one generic renderer turns the parameter list into controls.

### availability

The three answers a task gives about a file (`TaskAvailability`), and the distinction is *not* "can
this run now" but "can what the reader does next make it run":

- `ready` — run it;
- `waiting` — it applies here once the reader supplies something, so it is listed, greyed, and
  carries the sentence saying what to load. A greyed row with an instruction on it is the menu;
- `absent` — nothing the reader can do makes this meaningful here, so it is not listed at all.

### the three surfaces

- the **Analysis panel** — the fourth column: one row per task, a state each, and no controls;
- the **Analysis drawer** — where the work happens: parameters, Run with the price beside it,
  progress, results, exports. Deliberately not a modal, because a modal takes the keyboard, dismisses
  on a stray click and answers Escape by destroying what is being read;
- the **Synthetic tracks card** — where a per-bin result lands.

Which task is open is a **session** fact; the panel's fold is a **window** preference.

### synthetic track

An analysis result that became an ordinary track — an entry in the store, a bin vector the annotation
worker can sample, and a row with somewhere for its exports to go. Nothing downstream of it knows it
was computed rather than loaded, which is the point: it gets renaming, limits, colour, edges,
reordering, tooltips and the exported figure for free.

### figure spec vs figure style

The two halves every plot in the drawer is built from (§18.13). A **spec** is what the figure is
*of* — numbers, names, axis titles, and the task's suggestions about scale and window — and it
carries no colour, no line width and no hidden series. A **style** is everything the reader has
decided: the mark, the axes, the colours, which series is switched off, how a table is sorted. The
split is what lets a figure be restyled without rewriting what it is a figure of, and what lets the
style be remembered per file, task and output while the spec is rebuilt on every run.

### the stage dialog

A picture with its settings beside it, a grip between them and a way to put the settings away
(`ui/StageDialog.ts`). Invented for the enlarged 3D model (§25.3) and now also what a figure's
*customise* button opens (§18.13) — one shell with two callers, not two implementations. What goes
on the stage is *moved* in and moved back, never copied, so the camera or the zoom the reader left
it at is what they come back to.

---

## Machinery

### the three workers

Per session, and each owns one kind of I/O:

| Worker | Owns |
|---|---|
| **reader** (`src/worker/`) | all matrix I/O, and the only h5wasm instance |
| **annotations** (`src/annotations/worker/`) | parsing and sampling tracks |
| **analysis** (`src/analysis/worker/`) | running tasks, so the map stays live (§18.3) |

The invariant: **nothing downstream of `h5/` may import h5wasm or call `fetch`** (§6.1).

### byte source

One interface, two implementations, chosen at construction: a local `File`, or ranged HTTP. The LRU,
the request coalescing and the §12 accounting are properties of the *source* rather than of the format
reading it, which is what lets a `.hic` — a flat binary file, not HDF5 — get the same bounded, cached,
counted access.

### budget

A guess at what this tab may hold, from `navigator.deviceMemory` where it exists. It refuses a block
that would not fit, and a deck divides it by the panel count, so reads get smaller as a deck grows.
The reader is in a position to know better than the guess, and can override it.

### bucket and scope

A remote store the app reads by range, and a prefix within one that an entry applies to. A scope
carries a key or carries none — see [public scope](#public-scope) — and matching is by **longest
prefix**, so a narrower scope inside a wider one wins and a public `demo/` can sit inside a signed
bucket without acquiring a signature. Keys live in `localStorage`, are listed in *What this browser
is remembering*, and can be cleared there. A scope is also a [connected folder](#connected-folder):
the same entry that decides which key signs a read is the one the Files panel browses.

---

## Build targets

| Target | What it is |
|---|---|
| **web** | the default: the site at `js2264.github.io/metacooler.js/` |
| **desktop** | the Electron build (`IS_DESKTOP`), with a native menu that ends in the same command list |
| **standalone** | the whole viewer as **one HTML file** (`IS_STANDALONE`). It has an opaque origin, so every remote read fails before a byte moves — the URL box is therefore *absent*, not disabled (§8.5, §19) |
| **pinned** | one archived commit of the site, served from `…/v/<commit>/`, which is what the version dropdown points at |
| **CLI** | `metacooler-run`: the analysis panel, from a shell |

`web`, `desktop` and `standalone` are the values of `TARGET`; `pinned` is the web build under another
base URL.

---

## Overloaded words

Six words carry more than one meaning. Where the second meaning is avoidable it is being retired;
where it is not, the qualifier is always present.

### session

1. **`Session`** — an in-app tab. The primary sense.
2. **`sessionStorage`** — the browser API, and the app's storage tier for a train of thought.
3. **a browser session** — the lifetime of the browsing context. Ending it is what the durable
   workspace exists for.
4. **a shared session** — one tab serialised into a link.

Sense 4 is a tab serialised; senses 3 and 4 are what the durable and saved
[workspaces](#workspace) exist for. There is **no such thing as a session file**: a `.metacooler.json`
is a [workspace file](#workspace-file) and holds every tab. The demo catalogue entries are
**published workspaces**, each of one tab.

### workspace

1. **`Workspace`** — every open tab, as one object. The primary sense, and the user-facing one; the
   saved file and the durable record are both this.
2. **the Analysis drawer** — §18.1 calls the drawer "the workspace", and `src/analysis/workspace.ts`
   is named for it. *This is the collision to fix*: it means one file's analysis state, not the
   window's tabs.

The loose third sense — "a session with a lot of work in it", as in `shareLink.ts`'s size estimate —
is gone: that sentence now names the saved file, which is sense 1.

### panel

1. **a side panel** — one of the four columns (`SidePanel`, `src/ui/`).
2. **a map panel** — one cell of a deck (`MapPanel`, `PanelDeck`, `src/panels/`).

Both are permanent. The qualifier is load-bearing.

### tab

1. **a session's tab** — in the strip under the header.
2. **a browser tab** — the window.
3. **a panel tab** — the strip a *folded column* stands on its edge, turned a quarter turn.

### browser

1. **the 1D genome browser** — a session shape (§5.8).
2. **the web browser** — the thing the app runs in.

### entry

1. **an entry** — one dataset inside an `.mmetacool` or `.mcool`.
2. **an `AnnotationEntry`** — one track in the store.

---

## Doctrines

The rules cited by section number throughout the source. They are the reason two unrelated parts of
the app behave alike.

**§8.5 — a control that cannot keep its promise is absent, not disabled.** A greyed control makes the
reader spend attention discovering why. Corrected once, by §18.1: absent only if *nothing the reader
does next* could make it work; if something could, list it, grey it, and say what to load. A greyed
row with an instruction on it is not an unkept promise — it is the menu.

**§10 — every refusal names the file's actual state and the concrete fix.** The reader writes the
sentence, because it knows the actual value; the view supplies the heading, the advice and the way
out.

**§11 — nothing you open leaves this machine.** No upload, no account, no server: the file is read in
place, a few kilobytes at a time. Its consequence is felt constantly — a local file cannot be
re-opened by name, so it comes back [detached](#detached), and a link naming one is honest about what
the recipient will get.

**§5.5 — the hash carries what is being looked at.** Not how it is arranged, not what is filtered,
not where it is scrolled to.

**Add, do not replace.** A dropped file joins what is open in every case it can: a second cooler
comes up beside the first, a bigWig joins the tracks, a `chrom.sizes` answers a browser's guessed
lengths, and a dropped [workspace file](#workspace-file) appends its tabs beside the ones already
there. Replacing is a deliberate, separately named act — the picker, *Open a different file*, or a
new tab. The one thing that replaces a whole *window* is the restore offer on the first screen after
a browser restart, and it asks first.

**One command list.** `App.commands()` feeds the palette, the shortcuts dialog, the key handler and
the desktop menu. A menu click and a keystroke are the same thing arriving by a different road, so a
shortcut that works but is undocumented cannot exist.

**One name for one thing.** Which is what this file is for.
