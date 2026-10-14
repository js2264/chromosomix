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

- [The three shells](#the-three-shells) — window, session, tab, primed
- [Persistence](#persistence) — what is remembered where, workspaces, grants and connected folders
- [What is being looked at](#what-is-being-looked-at) — view state, views, focus, levels, locus
- [Files and addressing](#files-and-addressing) — cool, metacool, scool, pairs, entries, rungs, URIs, stores
- [Genomes and sequences](#genomes-and-sequences) — genome, contig, assembly, naming, bin space, circles, origins and arms
- [Maps on screen](#maps-on-screen) — lead, companion, deck, cell, star, the lock, eye and grip, the second file
- [Annotations](#annotations) — track, lane, placement, structure, model, method, card, kind, style, ideogram, junction, group, the batch, mark, bookmark
- [The picture](#the-picture) — score, O/E, transform, clip, drawn to a total, the turn, refine
- [Analysis](#analysis) — task, availability, the surfaces, framing, synthetic track, called set, port, figure spec and style, the stage dialog
- [Editing the reference](#editing-the-reference) — original, edit, piece, lens, breakpoint, corner, suggestion, the stage, the dot plot
- [Machinery](#machinery) — workers, sources, budgets, dev features, buckets, the console
- [Build targets](#build-targets) — web, desktop, standalone, pinned, package, CLI, embed
- [Overloaded words](#overloaded-words) — session, workspace, panel, tab, browser, entry, origin, cell, junction, reader, bin, metacooler
- [Doctrines](#doctrines) — the rules cited by number everywhere

---

## The three shells

Three things nest, and only the middle one is unusual.

### window

The browser tab the application is running in, and the object that owns its furniture: the header,
the tab strip, the five columns, the console, the status bar and the address bar. The class is `App`
(`src/app/App.ts`); prose calls it **the window** when the subject is layout, **the shell** when the
subject is what it does for a session, and **this browser tab** when the subject is what it costs the
machine (`src/ui/StatusBar.ts`).

There is deliberately no shorter noun. "Tab" is spoken for.

Four things are per window rather than per session, because they are preferences about this window
rather than facts about a file: the **theme**, the **fold** and **width** of each column, and where
the reader has **moved its cards** (`src/ui/cardLayout.ts`, §26.6).

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
| **UiMemory** | `sessionStorage`, key `sessionId\|path` | one file in one tab | tracks, marks, bookmarks, ticked sequences, table filters, circles and origins |
| **sessions** | `sessionStorage` | the window | which tabs exist, and which was active |
| **workspace** | IndexedDB | survives closing the browser | every tab as a full `SessionConfig` |
| **preferences** | `localStorage` | the browser profile | theme, column folds and widths, card arrangement, bucket keys, dismissals, the dev-features switch |

The dividing lines:

- the hash carries what is **shareable** — a link that silently carried "only rows where completeness
  > 90" would mislead whoever opened it;
- `sessionStorage` is for a **train of thought**, which belongs to the window it was had in;
- `localStorage` is for a **preference**, which does not.

[The console](#the-console)'s week of commands is in `localStorage` too, though it is a record rather
than a preference: what it is for is yesterday's commands, from a window that is gone (§23.5).

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
unpublished figure on screen for whoever sat down next (§11). Closing the offer is a real answer and
deletes the record, which the close button's own name says (`src/ui/RestoreCard.ts`).

A **saved** one is the mirror rule: *added, never substituted*. Dropping a workspace file appends its
tabs beside what is open, because six open tabs were the reader's and there is no undo. The one place
that replaces a window is the offer above, which has asked first.

### session config

A whole tab, written down (`src/state/SessionConfig.ts`): the view state, every track with its
colours, limits and groups, the manual marks, the bookmarks, the ticked sequences, the table filters,
the deck's arrangement, the analysis recipes, the circles and origins declared, the resolutions
added, and an edit of the reference. **Never a file on its own** — it is always one entry
inside a [workspace file](#workspace-file), which is what a config travels in on all three roads:

- a **saved file** — every open tab, written by *Save every tab as a file*;
- a **link** — a workspace of *one* tab, deflated and base64url-encoded into the fragment under
  `session=` (`src/state/shareLink.ts`). One tab because a link is *what is being looked at* (§5.5)
  and there is one of those on screen. The **fragment** specifically, because a fragment is not sent
  to the server, so the contents of somebody's session never reach the host;
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

A [workspace](#workspace) as bytes: `workspace-<stamp>.chromosomix.json`, `kind:
"chromosomix.workspace"`, holding every open tab as a [session config](#session-config) and naming the
active one by **index** (`src/state/workspace.ts`). Written by the save button in the header; drop it
back and its tabs are *added* beside whatever is open.

By index and never by session id, which is the one real difference from the durable record: a
sender's `s1` means nothing in a recipient's window and would collide with a tab they already have.
The record keeps its ids, because there they are live and are what puts a reader back in the window
they left.

The published demo catalogue is five of these, each a workspace of one tab and the metagenome's a
dev feature (§29): the figures of the lab's own store (`src/ui/examples.ts`).

### detached

The state a **local** file's track comes back in after a reload: the settings survived in session
storage, the bytes could not — no browser re-reads a dropped file without a fresh gesture — so the
row is shown with its colours and limits intact and a button to point at the file again. The same
word describes a whole session restored from a config that names a local file, and a
[synthetic track](#synthetic-track) after a reload: its values were never kept, its recipe was, and
it offers **recompute** where a file's row offers to re-open it (§18.5).

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
— nowhere — and every one is listed in the stored-data screen, swept by its *forget everything*,
and revoked one at a time by its × in the Files column (§20.6).

### durable *(of a folder)*

Whether a connected folder survives a reload, which depends on the browser and is stated on its row.
Chromium and the desktop build have `showDirectoryPicker`, so a directory is held as a
`FileSystemDirectoryHandle` in IndexedDB and the folder is genuinely connected — live, and still
there tomorrow. Firefox and Safari have no such thing: `<input webkitdirectory>` hands over a flat
`File[]`, from which the tree is rebuilt once. That is a **snapshot** — it does not update and it is
gone after a reload — and the row says *this visit* rather than letting the reader find out later. A
bucket is always durable, being a line in `localStorage`.

### public scope

A [bucket scope](#bucket-and-scope) with no credential: a URL prefix and nothing else, listed and read
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

One of ten kinds (`ViewKind`):

| Kind | What it is |
|---|---|
| `genomes` | the genomes table — the landing view of a metacool (§5.1) |
| `cells` | the cells table — the landing view of an `.scool` (§3.8) |
| `contigs` | the contigs table; called **Chromosomes** on a plain cooler |
| `genome` | one genome's own matrix (§5.2) |
| `pair` | the block between two genomes (§5.3) |
| `region` | one contig, or a contig × contig block (§5.4) |
| `whole` | the whole file as one bounded read — a cooler's *Whole genome* (§9) |
| `overview` | a metagenome's *Whole metagenome*, at any [level](#level); at `genome` it is the genome × genome scan — the one expensive operation, and gated (§7.3) |
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
where a value that view has no use for is translated to the one it lands on. It is asked by **one
control**, a `level` select at the head of the General column's Sequences, Genomes or Contigs card —
`bin × bin`, `contig × contig` (`chromosome × chromosome` on a cooler), `genome × genome` — and is
absent where a view has only one (§5.8, §7.3).

### locus

A window in a genome browser, written the way every genome browser writes one and the way the locus
box accepts one: `chrI:1,001-20,000`, 1-based inclusive. Absent means the whole genome.

---

## Files and addressing

| Term | What it is |
|---|---|
| **cool** / **mcool** | a cooler: one genome, fixed bins. An `.mcool` is a ladder of resolutions |
| **metacool** | the primary case — multi-genome, carrying a `/genomes` layer (§3.2); a dev feature (§29) |
| **mmetacool** | a *container* of complete metacools, and **not itself a valid cooler** (§3.4); a dev feature |
| **hic** | juicer's format, read as a cooler-class citizen (§3.6) |
| **scool** | one cooler per single cell over one shared bin space, drawn as the sum of the cells ticked (§3.8) |
| **pairs** | a list of contacts, **imported** — binned at a resolution the reader chooses — rather than opened (§3.7) |

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

Opening a container at its root is an error that lists what is inside; the app answers it by opening
one — a ladder's landing rung (§9), a collection's first entry — and offering the rest in the entry
picker (§3.4).

### rung

One level of a resolution ladder, as a bin size (`src/ui/refine.ts`). A sibling rung is a different
[bin space](#bin-space) entirely, which is why moving between them is a reopen rather than a
navigation. A rung the reader adds — a whole number of a stored rung's bins, summed as it is read —
is a **derived rung**, marked `*` (`3 kb*`) and never preferred over a stored one
(`src/metacooler/coarsen.ts`, §3.4).

### `__unbinned__`

The reserved **genome** name holding every contig that binning failed to assign to a MAG — a bin in
the metagenomic sense, not a matrix bin. Matched by name, never by index, and never displayable
(`UNBINNED_NAME`, `src/constants.ts`, §7.4).

### store

A shelf of named data somebody published: one JSON file (`kind: "chromosomix.store"`, §24) listing
maps, genome files and workspaces with columns to filter on, so a reader chooses without opening
anything. The app ships seven — the lab's own figures, its DNA Bacterial Zoo, IGV's genomes, 4DN,
ENCODE, DNA Zoo and the Roadmap hub (`src/ui/stores/registry.ts`) — and a reader connects any other
by URL. Each is a page in the **store drawer** (§24.2): a *gallery* of cards whose one button opens a
pre-configured session, a *genome gallery* of such cards, one a genome or a species, or a *portal* of
facets with a matrix across any two of them. A row becomes a `PickedFile` the moment it is pressed,
so a store is a door and not a source: what opens is the file the row names, on whatever bucket that
is. Nothing is fetched until its tile is pressed. Earlier builds called it a *hub*; that word now
means only a UCSC **track hub**, which is read as a store and is one (`src/state/hub.ts`, §24.10).

---

## Genomes and sequences

### genome

One organism in a metacool — a **MAG**, in metagenomic assembly terms. The `/genomes` table is the
landing view, and `hasGenomes` is the predicate that says a file has this layer at all. Everything
about the layer is a [dev feature](#dev-feature) (§29.3).

`hasGenomes` is load-bearing: a file with a genome layer gets **no deck** and **no second-file
split** (§5.7, §8.5), because two metagenomes are two independent assemblies and there is no
coordinate system for a second map to share. It does get tracks, which it was once refused: a
metagenome is *one* co-assembly binned afterwards, so its contig names are one namespace, and what a
track covers is reported in MAGs (§8.5).

### contig

One sequence. Called **Contigs** on a metacool and **Chromosomes** on a cooler, and the word is not
cosmetic: a cooler holds one genome's chromosomes, and calling them contigs asks the reader to
translate on every screen. In prose a stretch of DNA is a **sequence**; *chromosome* and *contig* are
for the surfaces that report what a file itself calls one (§26.4).

### assembly

A genome with no contact map behind it: a list of sequences and their lengths, from whatever named
them (`src/genome/assembly.ts`). It is the other starting point of the application — the one a
browser session is built on — and its **origin** records how far to trust its lengths: `sizes`,
`bigwig`, `bigbed`, `fasta`, `twobit`, `bam`, `vcf`, `cytoband`, `cooler`, or `features` (the
largest coordinate anything mentioned, and the only lower bound). The Genome card says it as
*lengths* (§5.8).

### naming, and a match

Two files of the same genome disagree about its names more often than they agree: `chr1`, `1`,
`chrI`, `01`. `src/genome/naming.ts` answers one question — does this name, in this file, mean the
same sequence as that name, in that one — under a rule worth knowing: **it never silently matches two
different sequences.** No match is a blank panel and a sentence saying why; a wrong match is somebody
else's chromosome drawn under your label, which nothing on screen would show. Length vetoes rather
than persuades, and an opaque assembler contig (`NODE_1_length_…`, `k141_9`) is matched by its
spelling and not otherwise (§5.9).

### bin space

The coordinate system the matrix is indexed on — absolute bin numbers across the whole file, as
against base pairs or per-contig offsets. The phrase appears throughout the reader and the renderer
and is the reason **"space" is not available as a name for anything else in this project.**

### circular

A sequence the reader has declared to join its own ends — a bacterial chromosome, a plasmid — since
no `.cool` can say so (`src/state/circular.ts`, §8.15). A fact about the assembly rather than the
window: kept per file and carried in a workspace, never in the view state, ticked in the *circular*
column of the Chromosomes table and worn as `↻` on the Sequences card. A file's first open **proposes** it:
each of its fifty longest sequences is scored as the contacts across the junction over those along
the diagonal at the same separation (`src/analysis/circularity.ts`), and one at 0.2 or above is
ticked — once per file, and only ever adding a tick, so an untick stands. Declared, a window may cross
the junction (`chrom:2,900,000-100,000`), read unwrapped and framed rather than panned round, and
the tasks that read a decay measure a separation the short way round — all but chromosight and the
observed/expected map, whose linear expected is a seam at the junction (§8.15).

### origin, arms, terminus

A sequence's replication **origin**, kept per file like its circle (`src/state/origins.ts`, §8.15):
shown 1-based in a column of the Chromosomes table, typed there by the reader or filled in by the
*Origin and terminus* task, which never overwrites a reader's. Every sequence has one — its first
base, shown greyed — until another is set. From it a bacterial chromosome is two **arms**
(replichores) that meet again at the **terminus**, and where they are held side by side the map has a
**secondary diagonal** through the origin, the **inter-arm** contacts (`src/analysis/arms.ts`). On a
map of one such sequence, **`ori`** frames the whole circle with the origin in the middle, **`arms`**
takes the O/E along both arms instead of along the diagonal alone (`arms=` in a link), and the score
picker's `arm decay` draws that baseline itself (§7.5).

---

## Maps on screen

Two different ways a second file can appear, and conflating them is the commonest mistake.

### lead and companion

A **deck** is *companions plus a lead* (§16, `src/panels/deck.ts`).

- The **lead** is the session's own file. It owns the breadcrumb, the tables, the tracks and the
  second-file split, and it is not in the companion list. Its `MapId` is the constant `lead`.
- A **companion** is a file and a worker and nothing else.

Exactly one file has to decide what the session is *of*, or the breadcrumb has no subject. On screen
the lead is **the first map**: *lead* is the code's word and this file's, and the reader never sees
it.

### deck

N [cells](#cell) side by side in a grid, drawn from the `maps=` key of the view state —
`|`-separated, because a comma is legal in a URI and a pipe is not. It is drawn by the two **`+`
edges**, down the map's right and along its bottom: each adds a column or a row of empty cells,
which are filled from a drop, a file chooser or a URL (§16.9). `MAX_PANELS` (64) is a backstop
against arithmetic rather than a policy: the real limit is bytes, since the per-map read budget is
this tab's budget divided by the number of maps, a cell that holds no file taking no share (§16.7).

### vacant

An empty cell — one a `+` drew and nothing has filled, or a link's memory of a *local* companion —
with no bytes behind it and a drop rectangle where its map would be. Both are written as `~` in a
link, so a shared deck keeps the count and the order of what was sent even where it cannot keep the
bytes (§11, §16.6); the session that drew them tells the two apart in words only (§16.9).

### cell

Any occupant of the deck (§16.11, §25): a map (the lead or a companion), a **vacancy**, a
**structure** cell drawing one of the session's 3D models, or a **tracks** cell drawing the session's
tracks alone. A deck holds as many of the last two as the reader opens, and one model may be in
several cells, each a view of its own with its own camera (§25.3). Only the maps are members of the
lock; the other two are told the lead's window as loci and never report one back. In a link: a URI,
`~`, `3d`, `tracks`.

### star

Which map of a deck the Analysis column reads (§18.1), the Aesthetics column's *Map* card sets and
the General column's *File* card describes (§16.5). It starts on the lead; a filled star pressed
leaves **no map starred**, in which state the card sets every map at once and no task can run
(§18.1). A structure cell has a star of its own, saying which cell the *3D structure* card sets — or,
with none filled, that it sets them all (§25.3). A feature set's row on the Tracks card has a third,
of another kind: which set the feature search reads, and the one a task's parameter defaults to
(§5.8, §18.2).

### lock, chain

What makes a deck's maps one navigation (`src/panels/lock.ts`, §16.3). Its currency is **base
pairs** rather than cells, so a 1 kb map and a 5 kb one follow each other honestly, the coarser
rounding outward to show at least what was asked for; and it has one owner — each map reports where
it is and the lock decides, so no two maps ever speak to each other. A map's **chain**, in its
heading, says whether it follows. Off the chain, a box drawn with ⌥ held on a companion reads that
window for that map alone, shown as a pill in its heading until it is given back.

### eye, ×, grip

Three controls on every row of the Contact maps, Tracks and Structures cards, and three acts (§16.9,
§25.2). The **eye** shows and hides and keeps everything: a map taken out of its cell stays on the
card, dimmed, and comes back as it was; a model's eye opens a cell of its own for it and takes that
cell away; a track's keeps its settings. The **×** lets go — except on a map's own cell, where it is
that map's eye. The **grip** drags a row up or down its card, onto a cell or onto a `+` edge, and a
lane's own grip carries the lane to another edge, another map or a cell of its own
(`src/ui/laneCarry.ts`).

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
several at once. A tracks cell has one edge, the bottom; the other three are greyed for it. The
middle of a map is a fifth drop target, *on this map*: a file let go there is that map's alone, an
overlay drawn on its face and a track on its usual edge (§8.1).

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

### centre, frame, mirror, in the frame of *(on a model)*

How a model is turned and read against another (`src/panels/StructurePanel.ts`,
`src/structure/align.ts`, §25.5). The **centre of rotation** is a ball at the camera's target with
an arm per axis — x red, y green, z blue — shown by default, and ⌘-click moves it. The arms carry a
**frame** the reader plants: *replant the axes* lays them along the current view, so every turn
after is read against where they were looking, and neither the model nor the centre moves. A
**mirror** reflects the model's built coordinates across the screen or up it, since a model made
from contacts is fixed only up to reflection. *In the frame of* another model turns this one into
that one's frame, superposed over the beads the two share, and does not draw the other — where
*compare with* draws both.

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

Which kind of row a track is (`AnnotationCard`, `src/annotations/types.ts`): `linear` (drawn beside
the map), `overlay` (drawn on it), `metadata` (columns the file already carries), `synthetic`
(computed), `structure` (3D models, loaded or computed, drawn by the deck's cell). A
[called set](#called-set-display-look) is `synthetic` while it is a 1D track and `overlay` while it is
on the map — its display moves it between the two (§18.7). No longer one card
on screen each: the **Tracks** card lists every `linear`, `overlay` and `synthetic` row in one list,
whose order is the lanes' order, and the other two have cards of their own, *Metadata annotations*
and *Structures* (§8.1, §18.5, §25.2). Each is absent — not disabled, not empty — on a file that
cannot carry it (§8.1, §8.5).

### kind

What a track *is*, as parsed (`AnnotationKind`): `gtf` (a gene model — a GTF, a GFF or a genePred),
`track` (a bigWig, bedGraph, wig or bedMethyl, resolved as a profile), `segments` (bed-like),
`pairs` (bedpe-like, and UCSC's interact and longrange), `sequence` (a FASTA or a `.2bit`),
`variants` (a VCF), `barchart`, `ideogram` (a cytoBand), `junctions`, `alignments` and `reads` (a
BAM's depth and its pile, two rows over one file), `structure` (a 3D model), `metadata` (a
numeric column of the file's own) and `classes` (a categorical one, drawn as runs of colour with a
legend rather than as a barplot of however the categories happen to be numbered).

Kind and card are independent: a [synthetic track](#synthetic-track) is `kind: 'track'` and
indistinguishable from a loaded bigWig from the renderer down. What makes it its own *card* is only
that its row is marked `*` and carries the exports and the *recompute* a loaded track has no use for.

### style *(of a lane)*, rows

How a profile is drawn, one of six (`TrackMode`, `src/annotations/types.ts`, §8.8): `area`, `line`,
`bar` and `points` draw a value as a position — `points` as a dot per value with nothing between, a
Manhattan plot's picture; `heatmap` draws it as a colour filling the lane, which costs no height; and
`ribbon` fills the band between its curve and the next track's in the same lane, so a set draws as
one nested shape. A lane of boxes spends its **rows** instead, among the three every genome browser
offers (`FeatureDisplay`, `src/annotations/fields.ts`, §8.16): **expanded**, the default, with room
for a name under each glyph; **squished**, rows eight pixels tall and no names; **collapsed**,
everything in one row.

### ideogram, band

A chromosome drawn from UCSC's **cytoBand**, `kind: 'ideogram'` (`src/annotations/cytoband.ts`,
`src/render/ideogram.ts`, §8.22): one outline per sequence — rounded at a telomere in view, pinched at
the centromere, narrowed along a stalk — filled with its **bands** in the Giemsa stain each names. A
band is an interval with an ISCN name, `Xq28`, which the locus box searches beside the genes and a
click names as a cytogeneticist would. A cytoBand whose bands tile every sequence declares the genome,
so the file alone opens a browser at exact lengths.

### splice junction, sashimi arc

An intron a read was seen to skip, with the count of reads that said so — `kind: 'junctions'`, from
STAR's `SJ.out.tab`, a two-block BED12 or leafcutter's `.junc` (`src/annotations/junctions.ts`,
§8.23). It is drawn as a **sashimi arc** from one exon's end to the next one's start, as tall as its
count against the lane's limits and labelled with it at its apex; a file with both strands draws
forward arcs above a middle baseline and reverse ones below. A spliced BAM's depth draws its own arcs,
from the introns its reads skip. Not the junction of a circle or of an edit: see
[junction](#junction).

### group

A set of tracks that belong side by side — a lane each, or overlaid in one — and by default share one
value axis, so two strands of the same experiment are read against one ceiling; set to `each`, the
group keeps its members together and gives each its own axis back (`src/annotations/groups.ts`).

### the batch

The box two or more ticked rows of the Tracks card open above the list (`src/ui/batchSettings.ts`,
§8.1): a row's settings over all of them, each control showing what the ticked rows share and
*mixed* where they differ, and a pick written to every ticked row it means something to and no
other. Not *run on all maps*, which runs one task once per map (§18.7).

### mark

A **manual annotation**: a line, an arrowhead or a rectangle the reader draws themselves, entered as
coordinates or picked on the map (`src/annotations/manual.ts`). This is the card that makes a figure,
and nothing in it comes from a file but its own marks read back: they leave as BED and BEDPE and come
in again the same way (§8.1). A mark never sits on the pixel it is about.

### metadata annotation

A column the open file already carries about its own genomes, sequences or bins — completeness,
contamination, a balancing weight — drawn against the map's own cells (§8.12). Discovered rather than
loaded, which made it, for a while, the one card a `.metacool` got (§8.5).

### bookmark

A saved **place**, with the resolution it was found at (§8.10). Not an annotation: it holds a
coordinate rather than a thing drawn at one, which is why it has a card of its own.

### derived

A source kind with no file behind it (`src/annotations/derived.ts`, §7.5): a row computed from two
other tracks by an operation, their ratio or their difference, holding no data of its own and
reading whatever the two it names have in hand at the moment it is drawn. An operand that is removed
takes the derived row with it, so it can fail to draw but cannot be wrong.

Distinct from a **computed** row, which is [an analysis result](#synthetic-track) and does carry
values; the two are both synthetic tracks, on the `synthetic` card and marked `*`. Both are distinct
from the **virtual 4C lane**, which no longer exists: shift-drag used to create a reading of the
picture belonging to no card and remembered nowhere, and the 4C *task* now answers the same question
from the file (§8.9).

---

## The picture

### score

What the numbers in the cells *are* — the one question the picture cannot answer about itself
(`src/ui/scores.ts`). A `/pixels` column (`count`, or any extra column the file carries), or one of
the normalisations: the file's own `balanced` weights, or VC, VC √ and ICE computed here. Or a
reading computed from the block: the `expected` an O/E divides by, drawn instead; on a view of one
circular sequence **`arm decay`**, the same taken along both arms, so both diagonals are in it
(§8.15); and the `correlation` the compartments are read from.

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

### drawn to a total, subsample, oversample

Every map of the tab read as though it held one number of contacts, typed in the breadcrumb's
*contacts* box and carried in the link as `contacts=` (`src/ui/ContactsBox.ts`, §6.5). A map that
holds more is **subsampled** — cooltools' `random-sample --count N --exact`, so the total is exactly
`N` — and one that holds fewer is **oversampled** through **Boost-HiC**, which is an inference where
a subsample is not (`src/metacooler/resample.ts`, `boost.ts`, `sampling.ts`). The draw is of the
whole file, never the window: a **census** of each sequence pair's contacts once per map, each pair's
share of the total, then each band of pixels from a fixed seed — so one total is one map in every
view, in both workers and in the shell (`--contacts`). Every picture and every task reads the drawn
map and says which it is; with two maps or more, two chevrons type the shallowest's total or the
deepest's. Empty, the box shows the map's own total in grey and every file is read as stored.

### the turn

The map rotated 45°: position along the bottom, distance from the diagonal up the side (§17,
`flip` in the view state). **Absent means square**, and only an explicit `true` is turned: a reader
who clicks a chromosome is asking to see it, not to have it rotated on the way in, so the turn is a
reading they ask for, like the O/E (§17.2). It is the deck's rather than one map's (§17.3). Ignored
quietly by any view whose block has no diagonal to measure from.

### refine

Reading finer data as you zoom: passing what the block in hand can show reads the window again at a
finer grid — one bounded read, the map held still while it happens, never below the file's own bins
(`src/ui/refine.ts`). Off by default, a preference turned on by the palette's *Refine on zoom*; the
alternative is one read per view and a zoom that magnifies it. On the editing stage the same idea
places a point: a suggestion's cut is placed again at the map's finer rungs, *refined at 1 kb*
(§27.5).

---

## Analysis

### task

Data, not a screen: an id, a title, the card it is listed on, a predicate saying which files it
applies to, a list of parameters, a list of outputs and a cost estimate (`src/analysis/tasks/`,
§18.2) — and, under the same id, a runner on the worker the descriptor names (`src/analysis/run/`).
**Adding a task is adding a descriptor**, never adding a screen — one generic renderer turns the
parameter list into controls.

### availability

The three answers a task gives about a file (`TaskAvailability`), and the distinction is *not* "can
this run now" but "can what the reader does next make it run":

- `ready` — run it;
- `waiting` — it applies here once the reader supplies something, so it is listed, greyed, and
  carries the sentence saying what to load. A greyed row with an instruction on it is the menu;
- `absent` — nothing the reader can do makes this meaningful here, so it is not listed at all.

### the three surfaces

- the **Analysis panel** — the fourth column: one row per task, a state each, and no controls, in
  four cards cut by the dimension the question is about — *2D tasks*, *3D tasks*, *1D tasks* and
  *Metagenome* (§18.8);
- the **Analysis drawer** — where the work happens: parameters, Run with the price beside it,
  progress, results, exports. Deliberately not a modal, because a modal takes the keyboard, dismisses
  on a stray click and answers Escape by destroying what is being read;
- the **Tracks card** — where a per-bin result lands, as a row marked `*` beside the loaded tracks;
  a model lands on the Structures card instead.

Which task is open is a **session** fact; the panel's fold is a **window** preference.

### framing, provenance

What a task runs on, captured when **Run** is pressed (`AnalysisFraming`, `src/analysis/types.ts`,
§18.4): the window as bin extents, the bin size, any pooling, the score column, the balancing, the
total the map is drawn to, and the circles and origins declared. A **snapshot**: the result is a
record, so a pan afterwards leaves it standing, with an offer to recompute. The **framing line** says
it in one string, and the **provenance** is the framing with everything else that made a result — the
task and its version, every parameter, the file, the build and the time — shown in the drawer and
written into every export that has a comment syntax. A task that reads no map has none to name.

### synthetic track

An analysis result that became an ordinary track — an entry in the store on the `synthetic`
[card](#card), a bin vector the annotation worker can sample, and a row of the Tracks card, marked `*`
after its name, with its exports in its settings. Nothing downstream of it knows it was computed
rather than loaded, which is the point: it gets renaming, height, style, limits, groups, colour,
edges, reordering, the batch, tooltips and the exported figure for free. A comparison of two tracks
(`derived`) is one too, and so is a [called set](#called-set-display-look) (§18.5).

### called set, display, look

A set of intervals or pairs a task found — boundaries, domains, peaks, A/B segments, sites, loops —
as **one** row of the Tracks card (§18.7). Its **display** says where it is drawn: as a *1D track* of
segments beside the map and in the 1D browser, or as a *map overlay* on the map it was called from —
one or the other, never both, and a set run again keeps it. On the map, a set of places (boundaries,
borders, sites, peaks) has a **look** the reader chooses, a *point* on the diagonal or a *short
diagonal marker* across it; a set of extents (domains, segments) is drawn as the *corners* of the
squares it claims along the diagonal; a loop set is a ring round each pair, and its 1D track is its
anchors. In the 1D browser every called set is a track. A set used to arrive as two rows, an overlay
and a lane, with a switch each; a session written then is folded into the one row on its way back in.

### port

A published method reproduced here, as opposed to one this app would have devised (§18.9): its
numbers are the reference's, held to a golden built from that software's **own output** rather than
from a reading of its paper, and kept where they look like oversights, because changing one changes
what the result means. Chromosight's detection (`analysis/chromosight.ts`), HiCRep, and the peak
caller — yapc (`analysis/yapc.ts`) with the IDR it thresholds by (`analysis/idr.ts`) — are ports, and
so is Boost-HiC, which a map is oversampled with (`metacooler/boost.ts`, §6.5). A *caller* has to be
one: a method that turns numbers into calls is only admitted with a published upstream and its
golden. The one stated exception is the reference editor's suggestions, the app's own method, held
instead to scrambled assemblies whose answer is known by construction (§27.11).

### figure spec vs figure style

The two halves every plot in the drawer is built from (`src/figures/spec.ts`, `src/figures/style.ts`,
§18.13). A **spec** is what the figure is *of* — numbers, names, axis titles, and the task's
suggestions about scale, window, mark and colour — and none of the reader's colours, line widths or
hidden series.
A **style** is everything the reader has decided: the mark, the axes, the colours, which series is
switched off, how a table is sorted. The split is what lets a figure be restyled without rewriting
what it is a figure of, and what lets the style be remembered per file, task and output while the
spec is rebuilt on every run.

### the stage dialog

A picture with its settings beside it, a grip between them and a way to put the settings away
(`ui/StageDialog.ts`). Invented for the enlarged 3D model (§25.3), and also what a figure's
*customise* button opens (§18.13) and what the reference is edited on (§27.3) — one shell with three
callers, not three implementations. What goes
on the stage is *moved* in and moved back, never copied, so the camera or the zoom the reader left
it at is what they come back to.

---

## Editing the reference

The vocabulary of §27, which is a dev feature (§29). It needed words of its own because the obvious
ones were taken: *source* is a byte source here, *score* is what a map's cells are, *layout* is a
file's shape and *block* is a read. So the file's assembly is the **original**, a suggestion's number
is its **confidence**, and a dot plot's line is a **streak**.

### original, and the edited assembly

The **original** is the assembly the opened file names — its sequences, as spelt, at their lengths.
The **edited assembly** is what the reader has made of it: **edited sequences**, each an ordered list
of pieces and gaps. A sequence that is exactly one whole original sequence, forward, keeps its name;
any other gets a new one (`IV_e1`), because §5.9's matcher would take `IV.1` for `IV`.

### edit, step, history

An **edit** is everything done to the original, kept as a **history** of **steps** — `cut`, `invert`,
`move`, `duplicate`, `join`, `split`, `aside` (set aside), `rotate`, `rename`, `reorder`, `place` (a
stretch set in the order as a sequence of its own, joined to nothing), `restore` (put back), `bring`
(a contig brought in, §27.10) and `layout` (an AGP or `.assembly` read back whole, §27.8) — each a pure
function of the edit before it, and each recording who made it (the reader, a suggestion, auto mode),
when, and the evidence a suggestion was accepted on (`EditStep`, `src/genome/edit.ts`). Undo and redo
move a cursor along the history. An edit is a fact about a **file**, kept where its circular
declarations are (§27.2).

### piece, gap

A **piece** is a stretch of one original sequence, forward or reversed, placed in an edited sequence;
a **gap** is a run of `N` between two pieces, as an AGP types it. A piece's ends may fall on any base.

### set aside

Taken out of the edited assembly and listed apart with a reason — *debris*, *contaminant*, *haplotig*
or *unplaced* — rather than deleted: nothing the reader removes is lost. An *unplaced* stretch is
still sequence of the assembly, which every export writes as a sequence of its own; the other three
an AGP names on a comment line (§27.8). Each row of the list has *put back*, one step that returns
the stretch as a sequence of its own, last, to be moved into place (§27.4).

### lens

The mapping between the original and the edited assembly, through which the whole session is drawn
(§27.2). **Edited → original is a function** (every edited base has one original base, or none in a
gap); **original → edited is a relation** (a base lands once, not at all, or twice). It is what makes
an edit a way of *looking at* a file rather than a change *to* it: the file is read exactly as it
would be without one.

### breakpoint, end, corner

A **breakpoint** is a place where the map says the reference is discontinuous. An **end** is a point
and a side — the sequence just left of it, or just right. A **corner** is a point off the diagonal
where two ends meet: the corner of a block of contacts that stops, and whichever of its four quadrants
is bright says which two ends belong together (§27.5). A corner is also a thing the pointer snaps to,
which is the point: the method's objects are the interface's.

### suggestion, confidence, junction score

A **suggestion** is an edit the app proposes, with its **evidence** and its **confidence** — *the
chance a curator would accept it*, a logistic model over its features, which review mode re-tunes from
the reader's answers. The **junction score** is the log-likelihood that two ends are adjacent against
their being apart — apart at the trans level when the question is whether a junction the reference
makes is refused, and at the window's own level when it is whether two ends meet, so a cluster that
lights a window evenly is not an adjacency. A suggestion's gain is the scores of the junctions it
makes less those it takes away, counted in **units** of one adjacency. A suggestion is an offer, never
a result: it enters the reference only when accepted, or when auto mode applies it and writes down
that it did.

### meeting, gap, exclusivity, focus

A **meeting** is whether two separate ends — two contigs' — belong together: the junction score's
likelihood with a **gap** the assembly left out between them and the share of the law that survived
beside it both fitted, over windows walked past the cells the balancer emptied, and counted in what a
clean adjacency of those two ends would score. **Exclusivity** is how far a join's two ends prefer
each other to anything else either could meet, since an end has one neighbour. A **focus** is the
place of a sequence the others' own such places cluster with — a centromere, in a genome whose
centromeres cluster; a join that would give one sequence two far apart makes a chromosome of **two
centromeres**, and counts against itself.

### telomere, gap of N *(when editing)*

What the assembly's own sequence says beside the map (§27.5). A **telomere** is a run of the
telomeric repeat at a sequence's end — `TTAGGG` and its kin, or a budding yeast's irregular `TG₁₋₃`:
a chromosome's end, which nothing follows, so an edit that would put one inside a sequence **buries**
it and counts against itself. A **gap of N** is a run of ten `N` or more, where the assembler stopped
being sure; a break the map finds beside one is placed at it, to the base. Not the **gap** of a
meeting, which is what the map measures between two contigs' ends, and which a join then writes as
`N`.

### a genome's edit, send, bring in *(on a metagenome)*

On a `.metacool` the stage edits **one genome at a time** (§27.10): its contigs alone, its edit kept
apart from every other genome's. A contig of it that meets another genome more is **sent** there — set
aside, marked with that genome; a contig of another genome, or of none, that meets this one most is
**brought in** — whole, as a contig of its own after the rest. The **contig → MAG table** is the
binning every genome's edit makes of the file's contigs.

### the stage

Where the reference is edited (`src/edit/EditStage.ts`, §27.3): the third caller of the
[stage dialog](#the-stage-dialog), whose map is the whole edited assembly — the stage's picture, a
pieces bar along two edges, the rail beside it, the lanes drawn through the lens, and a dot plot in
its corner where the session holds a second reference. Its sidebar is cards, *selection*,
*sequences*, *history*, *suggestions*, *export* and *picture*, with a *genome* card on a metagenome.
Its keys exist only while it is open, and Escape cancels but never closes it. Opened from the word on
the reference or the palette's *Edit the reference* — *Edit a genome* on a metagenome; closing it
leaves the session drawn through the edit (§27.7).

### manual, review, auto

The stage's three modes, and three answers to one question — **who presses accept** (§27.6). In
*manual* the suggestions are guides; in *review* they are a queue the reader answers; in *auto* the
task applies every one above a threshold. *Auto* from a shell, `chromosomix edit`, is specified
and not built: the command line has no such command yet.

### the stage's picture

The whole map, drawn once for the editing stage at up to 16,384 cells a side, one byte a cell, **in the
file's order** (§27.9) — so an edit redraws it through the lens without reading a byte. Its own thing,
finer than any map's (`RASTER_MAX_DIM` is 4,096), and dropped when the stage closes; the reader may
ask for 8,192, 4,096 or 2,048 cells instead, for a faster read (`src/metacooler/picture.ts`). A
picture and nothing else: every number a reader is shown is read from the file. Zoomed in past two
pixels a cell, the window on screen is read again from a finer rung, through the edit, and painted
over it on the picture's own scale — **closer than a cell**.

### pieces bar

The strip along the stage's top and left edges: every piece of the edited assembly as a block in its
**original sequence's hue**, chevrons pointing the way it reads, and each edited sequence's name over
it. A moved piece keeps its colour, so the bar says where each stretch came from. It is a handle as
well as a picture: a press selects a piece, or on a name a whole sequence; a drag moves it; a double
click turns it (§27.3).

### the word on the reference

The heading's *reference · as in the file*, or *edited · 7 steps*, lit: the tab's one statement of
whether what it draws is the file's sequences or an edit's (§27.3). A press opens the stage; the arrow
beside an edited one reverts to the file, which is one more undo.

### the rail

The column of labels beside the map on the stage, each suggestion's label — its number, its kind, its
confidence — at the height of what it concerns, with a leader to a bracket that spans it. Hovering a
label lights its marks on the map and hovering a mark lights its label: one highlight in two places.

### dot plot, anchor, streak

A **dot plot** is one sequence set against another on two axes, a FASTA or `.2bit` against another
or against itself, with no contact map at all (§28, `src/dotplot/`) — a dev feature of its own. An
**anchor** is one minimizer the two share — a position on each axis and a strand; a **streak** is
anchors chained along one diagonal, a line of the plot. Forward is drawn positive and reversed
negative, so an inversion is the colour a reordering is not. Streaks kept **one to one** are each
stretch at its best place on the other axis, a stronger streak having taken the rest — which is how a
repeat family's copies stop drawing a grid between two assemblies. On the stage a dot plot stands in
the map's corner against a second reference the session holds, its streaks moved through every edit
as it is made (§27.3).

---

## Machinery

### the three workers

Per session, and each owns one kind of I/O:

| Worker | Owns |
|---|---|
| **reader** (`src/worker/`) | all the matrix I/O a view does |
| **annotations** (`src/annotations/worker/`) | parsing and sampling tracks, and the tasks that read only tracks or sequences |
| **analysis** (`src/analysis/worker/`) | running tasks, on a second mount of the same file opened on the first task that needs it, so the map stays live (§18.3) |

The invariant: **only `src/h5/` imports h5wasm** (§6.1).

### byte source

One interface, two implementations, chosen at construction: a local `File`, or ranged HTTP
(`src/sources/LocalFileSource.ts`, `src/sources/RemoteRangeSource.ts`, §6.1). The LRU, the request
coalescing and the §12 accounting are properties of the *source* rather than of the format reading
it, which is what lets a `.hic` — a flat binary file, not HDF5 — get the same bounded, cached,
counted access.

### budget

A guess at what this tab may hold, from `navigator.deviceMemory` where it exists
(`src/metacooler/matrix.ts`, §9). It refuses a block that would not fit, and a deck divides it by the
number of maps, so reads get smaller as a deck grows. The reader is in a position to know better
than the guess, and can override it: the refusal offers *load anyway*.

### dev feature

A feature on `main` that a reader **does not see at all** until the *dev features* switch in *About*
is on (§29) — built, specified and tested like any other, and absent rather than greyed while the
switch is off, which is the one place §8.5's corrected form does not apply. The switch is a
preference, in `localStorage`, and turning it reloads the window, which keeps its tabs; the registry
of what is dev is one file (`src/state/devFeatures.ts`); making a feature public is deleting its
line. Today: `metacool` (everything `.metacool`), `edit` (the reference editor) and `dotplot`. A
session that carries one while the switch is off keeps it, unapplied (§29.4). Never in an embed; not
in the CLI, which shows everything.

### bucket and scope

A remote object store the app reads by range, and a prefix within one that an entry applies to. A
scope carries a key or carries none — see [public scope](#public-scope) — and matching is by **longest
prefix**, so a narrower scope inside a wider one wins and a public `demo/` can sit inside a signed
bucket without acquiring a signature. Keys live in `localStorage`, are listed in *What this browser
is remembering*, and can be cleared there. A scope is also a [connected folder](#connected-folder):
the same entry that decides which key signs a read is the one the Files panel browses.

### the console

What this window has done, written as the commands that would do it again (§23,
`src/state/actions.ts`, `src/ui/ConsolePanel.ts`): a line per **job** a runner ran — a batch over six
maps is six lines, each its own `chromosomix` command, a failure and a Stop included — and,
commented, the files opened, the tracks loaded and the files written. What it hands over is a shell
script; its **provenance** toggle puts each run's whole provenance block above its command, and is
off by default. Window furniture, opened with `` ` `` and outliving every tab; kept in `localStorage`
for seven days and 500 lines, and listed with what the browser is remembering; never in an embed.

---

## Build targets

| Target | What it is |
|---|---|
| **web** | the default: the site at `chromosomix.app` |
| **desktop** | the Electron build (`IS_DESKTOP`), with a native menu that ends in the same command list |
| **standalone** | the whole viewer as **one HTML file** (`IS_STANDALONE`). It has an opaque origin, so every remote read fails before a byte moves — the URL box is therefore *absent*, not disabled (§8.5, §19) |
| **pinned** | one archived commit of the site, served from `…/v/<commit>/`, which is what the version dropdown points at |
| **package** | the copy that goes to npm: the web build with a relative base, a built directory for anybody to serve rather than a library to import (§22) |
| **CLI** | `chromosomix`: the analysis panel, from a shell |

`web`, `desktop` and `standalone` are the values of `TARGET`; `pinned` and `package` are the web
build under another base URL — the package's `./`, so one published version serves from anywhere.

### embed

The web build mounted inside somebody else's page, not a build of its own (`src/embed.ts`, §21):
`?embed=1` draws one view of one file with no window around it — no header, tab strip, restore
offer, status bar or console, and two of the five columns, folded. What it shows is seeded by a
`#session=` or a view-state hash, else by `?config=<url>`, a published
[workspace file](#workspace-file). It pushes no history entry, remembers nothing of the window and
shows no dev feature; a page that will not depend on this site mounts the [package](#build-targets).

---

## Overloaded words

Twelve words carry more than one meaning. Where the second meaning is avoidable it is being retired;
where it is not, the qualifier is always present.

### session

1. **`Session`** — an in-app tab. The primary sense.
2. **`sessionStorage`** — the browser API, and the app's storage tier for a train of thought.
3. **a browser session** — the lifetime of the browsing context. Ending it is what the durable
   workspace exists for.
4. **a shared session** — one tab serialised into a link.

Sense 4 is a tab serialised; senses 3 and 4 are what the durable and saved
[workspaces](#workspace) exist for. There is **no such thing as a session file**: a `.chromosomix.json`
is a [workspace file](#workspace-file) and holds every tab. The demo catalogue entries are
**published workspaces**, each of one tab. And the reader never sees the word: every string on screen
says *tab* (§5.6, §26.4).

### workspace

1. **`Workspace`** — every open tab, as one object. The primary sense, and the user-facing one; the
   saved file and the durable record are both this.
2. **the Analysis drawer** — §18.1 calls the drawer "the workspace", and `src/analysis/workspace.ts`
   is named for it. *This is the collision to fix*: it means one file's analysis state, not the
   window's tabs.

The loose third sense — "a session with a lot of work in it", as in `shareLink.ts`'s size estimate —
is gone: that sentence now names the saved file, which is sense 1.

### panel

1. **a side panel** — one of the five columns (`SidePanel`, `src/ui/`).
2. **a map panel** — one cell of a deck, as the code names it (`MapPanel`, `StructurePanel`,
   `TracksPanel`, held by `PanelDeck`, `src/panels/`); the reader's word is *cell*.

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
3. **a `StoreEntry`** — one row of a [store](#store) (`src/state/store.ts`).

### origin

1. **a replication origin** — where a bacterial chromosome's two arms begin
   ([origin](#origin-arms-terminus), §8.15). The sense on screen.
2. **an assembly's `origin`** — what its lengths were read from (`AssemblyOrigin`,
   `src/genome/assembly.ts`), which the Genome card says as *lengths*.
3. **a web origin** — scheme, host and port: the standalone build's is opaque (§19), and a frame's
   requests carry the viewer's (§21).

### cell

1. **a deck's cell** — any occupant of the grid ([cell](#cell), §16.11), and the reader's word for it.
2. **a cell of the picture** — one drawn square of a map: a bin pair, several bins pooled where the
   view is wide (`binsPerCell`), a whole sequence above bin level.
3. **a cell of an `.scool`** — one single cell's map, summed with the others ticked (§3.8): the
   `cells` view and the `cells=` key.

### junction

1. **a circle's junction** — where its last base meets its first, whose contacts the first open
   scores to propose a [circle](#circular) (§8.15).
2. **a splice junction** — an intron a read skipped, drawn as a sashimi arc (§8.23).
3. **an edit's junction** — where two pieces of the edited assembly meet, and what the
   **junction score** weighs (§27.2, §27.5).

### reader

1. **the reader** — the person in front of the screen, which is what the word means in prose.
2. **the reader layer and its worker** — `src/worker/`, which owns a session's matrix I/O (§6,
   §18.3). The qualifier is *worker* or *layer*: *the reader's worker* is never the person's.

### bin

1. **a bin of the matrix** — a fixed-width stretch of a sequence, the unit of a map's axes, and what
   [bin space](#bin-space) counts in.
2. **a bin of an assembly** — a MAG, the output of *binning* a metagenome's contigs: the sense of
   `__unbinned__`, of the Binning QC card and of the contig → MAG table (§7.4, §27.10).

### metacooler

The app is **chromosomix**. Until the rename it was metacooler.js, with the mark *(meta)cooler*, and
the word has kept two senses, neither of them the app:

1. **metacooler** — a separate project: the Python package and CLI that write `.metacool` files
   (`metacooler create`, `metacooler show`, `metacooler.schema`). Every `metacooler` in prose, in an
   error's advice or in a test is this one. `METACOOLER_PYTHON` is the interpreter that has it
   installed, for the fixtures.
2. **`MetaCooler`** — the reader's class (`src/metacooler/MetaCooler.ts`), with
   `parseMetacoolerRange` and `MetaCoolerFormatError` beside it: named for sense 1 because they
   mirror its API name for name (§6), and they read every contact map — a `.cool`, a `.hic`, a
   `.pairs` — not only a metacool.

**metacool** is the format alone — `.metacool` and `.mmetacool`, a dev feature (§29) — and the
`metacooler-format` attributes are the format's own, written into every such file. The app's own
names are `chromosomix` — in code type, the command line (§23), which shares the app's name —
`.chromosomix.json`, `chromosomix.workspace`, `chromosomix.store` and the `chromosomix:` storage
keys; each was spelled `metacooler…` before the rename, and nothing reads the old spellings.

---

## Doctrines

The rules cited by section number throughout the source. They are the reason two unrelated parts of
the app behave alike.

**§8.5 — a control that cannot keep its promise is absent, not disabled.** A greyed control makes the
reader spend attention discovering why. Corrected once, by §18.1: absent only if *nothing the reader
does next* could make it work; if something could, list it, grey it, and say what to load. A greyed
row with an instruction on it is not an unkept promise — it is the menu. And excepted once, by §29.2:
a [dev feature](#dev-feature) switched off is absent although the reader could turn it on.

**§10 — every refusal names the file's actual state and the concrete fix**, under a title that names
its subject — *Nothing to share*, *Too many tabs*. The reader layer writes the sentence, because it
knows the actual value; the view supplies the heading, the advice and the way out.

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
