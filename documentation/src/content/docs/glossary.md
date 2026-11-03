---
title: "Glossary"
description: "The words you meet in chromosomix and in these pages, each with a short definition and a link to the page that explains it."
---

The words chromosomix uses on screen and these pages use about it, in alphabetical order. Where a
page explains a word at length, its entry links there.

## Aggregate peak analysis (APA)

The contact map piled up around a set of loops or features — every one of them cut out and averaged —
against a control, to show whether they are enriched as a group. See
[Aggregate peak analysis](/analyses/apa/).

## Allow access

The button a tab shows when Chrome or Edge remembers a local file it was reading and needs only your
permission to read it again, after a restart for instance. One press allows every file the browser
remembers. See [Sessions, workspaces and links](/browse/sessions-and-links/).

## Arms, origin and terminus

A bacterial chromosome's replication **origin**, set per file in the Chromosomes table or by the
*Origin and terminus* task, divides it into two **arms** that meet again at the **terminus**. Where
the arms are held side by side, the map has a second diagonal through the origin. See
[Origin and terminus](/analyses/oriter/) and [Inter-arm alignment](/analyses/interarm/).

## Assembly

A genome as a list of sequences and their lengths, with or without a contact map behind it — read from
a FASTA, a `.2bit`, a `chrom.sizes`, the header of a bigWig, a bigBed or a BAM, a cytoBand, or a map.
It is what the genome browser is built on. See [Reference sequences](/files/sequences/).

## Balancing

Correcting a contact map for how visible each bin is — how many contacts it makes in all — so that
its rows and columns can be compared. A file can carry its own weights, which the **balanced** score
reads; chromosomix can also compute VC, square-root VC and ICE itself. `balance=true` in a link. See
[Reading a contact map](/browse/contact-maps/).

## Batch

The box that opens above the list of the **Tracks** card when you tick two rows or more: a setting
changed there applies to every ticked row, and reads *mixed* where they differ. See
[Annotations and bookmarks](/browse/annotations/).

## Bin

A fixed stretch of a sequence, the unit a contact map's rows and columns are made of: at 5 kb, a
100 kb window is 20 bins across. A map's [resolution](#resolution) is its bin size.

## Bookmark

A saved place, kept with the resolution it was found at, on the **Bookmarks** card. See
[Annotations and bookmarks](/browse/annotations/).

## Bucket

An object store — Amazon S3, Cloudflare R2, Google Cloud Storage and their kin — that serves files by
byte range. A file on one opens by its address, and a prefix of one can be connected as a folder with
**connect a bucket…**, with a key if it is private. See [Hosting your data](/advanced/hosting/).

## Called set

The places a task found — boundaries, domains, peaks, A/B segments, sites, loops — as one row of the
**Tracks** card. It is drawn either as a 1D track beside the map or as an overlay on the map it was
called from, and a set of loops is a ring round each pair. See [How analyses run](/analyses/).

## Card

One of the titled boxes in a side panel: **Tracks**, **Contact maps**, **Bookmarks**, **Map** and the
rest. Drag a card by its heading to move it to another panel; **Put every card back in its own
panel**, in the command palette, undoes that. See [A tour of the window](/start/window/).

## Cell

One place in a [deck](#deck): a map, an empty cell waiting for a file, a structure cell drawing a 3D
model, or a tracks cell drawing the tab's tracks on their own. An empty cell takes a map, a track or a
structure dropped on it. See [Maps side by side](/browse/deck/).

## Circular sequence

A sequence you declare to join its own ends — a bacterial chromosome, a plasmid — by its tick in the
*circular* column of the Chromosomes table. A file's first opening ticks the sequences whose contacts
across the join look like a circle's. A window may then cross the join, and most tasks measure the
distance between two places the short way round.

## Command palette

<kbd>Ctrl</kbd>+<kbd>P</kbd> (<kbd>⌘</kbd>+<kbd>P</kbd> on a Mac): every command of the app by name,
with its key where it has one. <kbd>?</kbd> lists the keys. See
[Keyboard and command palette](/browse/keyboard/).

## Comparison

A second map drawn in the lower-left triangle of the same square, on one colour scale, so that the
difference is read across the diagonal — or the two maps' ratio or difference over the whole square.
The two must share a bin size and a list of sequences; a map that shares only coordinates goes beside
it in a [deck](#deck) instead. See [Comparing two maps](/browse/comparing/).

## Compartments

The checkerboard of a Hi-C map: the genome sorted into two kinds of chromatin, A and B, each in
contact with its own kind. The *Compartments* task finds them as the leading components of the
observed over expected — E1, whose sign, phased by genes, a track or GC content, says which is which —
with a saddle plot. See [Compartments](/analyses/compartments/).

## Connected folder

A place the window keeps and lists one level at a time in the **Files** panel: a folder on your
computer, a bucket prefix, a Google Drive folder or your Dropbox. A file in it opens with a click, or
drags onto a map, a cell or a card. In a browser tab a folder on your computer is connected for the
visit (*this visit*); an installed app keeps it. See [Opening files](/files/opening/).

## Console

What the window has done, written as the commands that would do it again: each analysis you run
becomes the `chromosomix` command that repeats it, beside the files opened and written. Opened with
<kbd>Ctrl</kbd>+<kbd>&#96;</kbd>, the key left of <kbd>1</kbd>, and kept in this browser for a week,
500 lines at most. See [The console](/browse/console/).

## Contacts box

The *contacts* box in the bar over the map draws every map of the tab as though it held that many
contacts: a map with more is subsampled exactly, one with fewer oversampled with Boost-HiC, so that
maps of different depths can be compared. Empty, every map is read as it is stored. `contacts=` in a
link. See [Comparing two maps](/browse/comparing/).

## Coordinates

A place in a genome is written two ways. What you read and type is 1-based and inclusive, digits
grouped — `IV:1,000,001-1,400,000`, as IGV and UCSC print it — and the command line takes the same. A
map's `region` in a link is cooler's form, 0-based and half-open with no separators —
`IV:1000000-1400000` — naming the same bases. See [Link keys](/reference/links/).

## Deck

Cells side by side in one tab, panned and zoomed together. The `+` down the map's right edge adds a
column of cells and the one along its bottom a row. Its maps may differ in resolution, and need share
only their coordinates. `maps=` in a link. See [Maps side by side](/browse/deck/).

## Desktop app

chromosomix as an application for macOS and Linux, from the
[releases page](https://github.com/js2264/chromosomix/releases): the same viewer, on your disk, which
can also read by range a host that compresses its files. See
[Web, desktop or one file](/start/where-to-run/).

## Detached

A track from a local file after a reload: its settings came back and its bytes could not, since no
browser reads a dropped file again without being handed it. Its row keeps its colours and offers to
read the file again. A computed track after a reload offers **recompute** instead. See
[Sessions, workspaces and links](/browse/sessions-and-links/).

## Domain

A square along the diagonal: a stretch of sequence in more contact with itself than with its
neighbours, often called a TAD. Insulation and the directionality index find the borders between
domains; *TAD annotation*, Juicer's Arrowhead, finds the domains, nested where they nest. See
[TAD annotation](/analyses/arrowhead/).

## Edge

Which of a map's four sides a track's lane is on: top, right, bottom or left. A file dropped on the
middle of a map instead is that map's alone — drawn on its face if it is an overlay, on its usual edge
if it is a track. See [Annotations and bookmarks](/browse/annotations/).

## Embed

The viewer inside another web page, as an `<iframe>` whose address carries `?embed=1`: one view of one
file, with no header and no tabs, and the Annotations and Aesthetics panels folded at its sides. See
[Embedding in a web page](/embed/web-page/).

## Eye, × and grip

The three controls on each row of the **Contact maps**, **Tracks** and **Structures** cards. The eye
shows or hides, keeping every setting; the × lets go; the grip drags the row up or down its card,
onto a cell, or onto a `+` edge to place it in a new cell there. See
[Maps side by side](/browse/deck/).

## Facet

On a store's page, one of its columns, down the side, with every value counted. Ticking values
narrows the rows: values ticked in one facet add up, ticks in two facets narrow each other, and the
count beside a value is what ticking it would add. See [Data stores](/files/stores/).

## Feature set

A track of intervals — peaks, genes, domains, any BED — that a task can take as its features: the
anchors of an APA, the starts of a metaplot. The star on a feature set's row of the **Tracks** card
picks the set the feature search reads, and the one a task takes unless you choose another. See
[Tracks and features](/files/tracks/).

## Framing and provenance

The **framing** is what a task runs on, taken when you press **run**: the window, the bin size, the
score, the balancing, the contacts total, the circles and origins. It is a snapshot — pan away and the
result stands, with an offer to compute it again. The **provenance** adds the task and its version,
every parameter, the file, the build and the time; it is shown with the result and written into every
export that can hold a comment. See [How analyses run](/analyses/).

## Genome browser

The 1D view: tracks along a sequence, with or without a contact map, at a locus you type or drag to. A
track or a reference opened on its own starts one over its assembly; `view=browser` in a link. See
[The genome browser](/browse/genome-browser/).

## Group

Tracks that belong together — a lane each, or overlaid in one — sharing one value axis, so that two
strands of one experiment are read against one ceiling; set to *each*, every member keeps its own
axis. On the **Groups** card. See [Annotations and bookmarks](/browse/annotations/).

## Ideogram

A chromosome drawn from a UCSC cytoBand file: its outline, pinched at the centromere and filled with
its stained bands. A band's name, such as `Xq28`, can be typed in the locus box. See
[Tracks and features](/files/tracks/).

## Insulation

How much contact crosses each bin along the diagonal, measured in a diamond-shaped window slid along
it. Its dips are the boundaries between domains, and the wider the window, the higher in the hierarchy
of domains the boundaries it finds. The task *Diamond insulation*. See
[Diamond insulation](/analyses/insulation/).

## Lane

One placement of a track: on one map, on one edge. A track can have several lanes — the same bigWig
under two maps — or none, loaded but not drawn. A lane is the same height on every map, so the maps
line up. See [Annotations and bookmarks](/browse/annotations/).

## Lead and companion

In a deck, the **lead** is the tab's own file — the first map, which names the tab and holds its
tables, its tracks and its comparison — and the **companions** are the maps beside it. The app calls
the lead *the first map*. See [Maps side by side](/browse/deck/).

## Level

What one row and column of the map stand for: a bin, or a whole sequence summed into one cell, which
shows how much each chromosome contacts every other. `level=contig` in a link. See
[Reading a contact map](/browse/contact-maps/).

## Lock and chain

What moves a deck's maps together. The lock follows places in base pairs, so maps at different
resolutions stay on the same place; the chain in each map's heading says whether that map follows,
and unchained, it moves on its own. See [Maps side by side](/browse/deck/).

## Locus

A window in the genome browser, written as genome browsers write one: `chrI:1,001-20,000`, 1-based
and inclusive. The locus box also finds a gene or a band by its name. See
[Moving around](/browse/navigating/).

## Loop

A dot off the diagonal: two places in more contact than their distance predicts, often at the corner
of a domain. *Loop calling* finds them as pixels enriched over their local background, and *Pattern
detection* (Chromosight) by matching a template. See [Loop calling](/analyses/loops/).

## Mark

An annotation you draw yourself — a line, an arrowhead or a rectangle on the map — typed as
coordinates or picked on the picture. Marks are on the **Manual annotations** card, and leave as BED
and BEDPE files. See [Annotations and bookmarks](/browse/annotations/).

## Metadata annotation

A column the open file already carries about its own sequences or bins — a balancing weight, for
one — drawn against the map like a track. On the **Metadata annotations** card. See
[Annotations and bookmarks](/browse/annotations/).

## O/E

Observed over expected: each cell divided by what its distance from the diagonal predicts, which
takes away the fall of contact with distance and leaves what is unusual. A switch beside the score
rather than a score of its own, usually read on balanced counts with a diverging colour map.
`oe=true` in a link. See [Reading a contact map](/browse/contact-maps/).

## P(s)

Contact probability as a function of genomic separation *s*: how contact frequency falls with
distance, the curve every Hi-C map shares and the expected that O/E divides by. The task *Contact
probability P(s)*. See [Contact probability P(s)](/analyses/expected/).

## Panel

One of the columns either side of the map: **General** (the file itself), **Annotations** (tracks,
marks and bookmarks), **Aesthetics** (scales, colours and layout) and **Analysis** (the tasks), with
**Files** beside them while a folder is connected. Each folds to a narrow strip and opens again. See
[A tour of the window](/start/window/).

## Pinned release

A release of the app kept for good at its own address, `https://chromosomix.app/v/<tag>/`, which
takes the same links and embeds as the root and goes on drawing the same picture. **About** lists the
builds that are published. See [Running your own copy](/advanced/self-hosting/).

## Refine on zoom

A preference, in the command palette: zooming in past what the block in hand can show reads the
window again at a finer resolution, one bounded read at a time. It is off by default, and zooming then
magnifies what was read. See [Moving around](/browse/navigating/).

## Resolution

A map's bin size: `5 kb`, `1 Mb`. An `.mcool` or a `.hic` stores several, and
`::/resolutions/<bin size>` names one in an address. A resolution the file does not store, made by
summing whole bins of one it does, is marked `*`: `3 kb*`. See [Contact maps](/files/contact-maps/).

## Score

What the numbers in a map's cells are: the raw counts, the balanced counts, VC, square-root VC or ICE
computed on the fly, the expected count at that distance, the correlation the compartments are read
from, or another column the file carries. `score=` in a link. See
[Reading a contact map](/browse/contact-maps/).

## Sequence

One chromosome, contig or plasmid. The app says *sequence* in its own words, and *chromosome* or
*contig* where it reports what a file calls one — the **Chromosomes** table of a map, for one. See
[Moving around](/browse/navigating/).

## Session

What a tab holds — one file, its views, its tracks, its marks and its settings — called a *tab* on
screen. These pages also call a tab written down a session: a **pre-configured session** in a store
opens a map with its tracks already placed, and the landing page's example sessions, under *Pick an
example session*, open a picture each. See [Sessions, workspaces and links](/browse/sessions-and-links/).

## Share link

A link to one tab, made by **Share this tab as a link**: the tab whole — its view, tracks, marks and
bookmarks — written after the `#`, which no server sees. **shorten with is.gd** makes a short one
through that service. See [Sessions, workspaces and links](/browse/sessions-and-links/).

## Single file

The whole viewer as one HTML file, `chromosomix-<tag>.html` on every release, which opens from a disk
with no server and no network, and reads local files only. See
[Web, desktop or one file](/start/where-to-run/).

## Splice junction

An intron that reads were seen to skip, with how many said so — from STAR's `SJ.out.tab`, a junctions
BED, leafcutter's `.junc` or a spliced BAM — drawn as a sashimi arc from one exon's end to the next
one's start, as tall as its count. See [Tracks and features](/files/tracks/).

## Star

Which map of a deck the **Analysis** panel reads, the **Map** card sets and the **File** card
describes. Press the filled star to star none: the Map card then sets every map at once, and the tasks
that read a map wait. A structure cell has a star of its own, and so does a feature set's row. See
[Maps side by side](/browse/deck/).

## Status bar

The strip along the bottom of the window. Its **read** gives the requests and bytes this tab's files
have cost, in total and for the last view. See [A tour of the window](/start/window/).

## Store

A catalogue of files somebody published, with columns to narrow by, drawn as a page in the store
drawer: one JSON file, or a UCSC track hub read as one. Built in are RSG lab data, IGV genomes, 4DN
open data, ENCODE, DNA Zoo and Roadmap; **Add a custom store** opens any other. See
[Data stores](/files/stores/) and [Your own data store](/advanced/data-store/).

## Store drawer

The panel down the left of the window where a store is browsed, opened by a store's tile on the
landing page, by the header's toggle or by <kbd>&#92;</kbd>. There is one for the whole window, so it
stays as you left it when you switch tabs. See [Data stores](/files/stores/).

## Structure and model

A **structure** is a 3D file of beads placed in space — g3d, `.3dg`, bed3d or PDB — listed on the
**Structures** card and drawn in a structure cell beside the map. A **model** is one set of its
coordinates, a **chain** the beads of one sequence, and a **bead** one row of the file. *Model from
the map* makes one from the contacts. See [3D models beside the map](/browse/structures/).

## Synthetic track

A task's result that became an ordinary track: a row of the **Tracks** card marked `*` after its name,
with its exports in its settings. So is the ratio or difference of two tracks. After a reload its
values are gone, and its row offers **recompute**. See [How analyses run](/analyses/).

## Tab

One session, in the strip under the header: one file and everything you did with it. <kbd>o</kbd>
opens a new one, <kbd>Ctrl</kbd>+<kbd>&lt;</kbd> and <kbd>Ctrl</kbd>+<kbd>&gt;</kbd> step between
them, and <kbd>F2</kbd> or a double-click renames one; up to twelve can be open. See
[A tour of the window](/start/window/).

## Task

One analysis in the **Analysis** panel, listed with its state on the **2D tasks**, **3D tasks** or
**1D tasks** card. Pressed, it opens in the Analysis drawer — its parameters, **run**, its progress and
its results — while the map stays live. A greyed task says what to load first. See
[How analyses run](/analyses/).

## Track

A 1D dataset you loaded — a bigWig, a BED, gene models, reads — with its name, colour and style,
listed on the **Tracks** card and drawn in one or more [lanes](#lane). See
[Tracks and features](/files/tracks/).

## Track hub

UCSC's format for a published shelf of tracks: a `hub.txt` naming a `genomes.txt`, which names a
`trackDb.txt` for each assembly. chromosomix reads one as a store, through **Connect to a UCSC hub**.
See [UCSC track hubs](/advanced/track-hubs/).

## Transform and colour scale

The **transform** is the scale a value is coloured on — `log1p`, `log10`, `log2` or none — and the
colour scale's bottom and top (`vmin`, `vmax`) clip it, set automatically unless you set them. The
**colour map** is the ramp itself; `RdBu_r`, `BuWtRd` and `seismic` are diverging, for a ratio or an
O/E. See [Reading a contact map](/browse/contact-maps/).

## Turn (the 45° view)

The map of one sequence rotated 45°: position along the bottom, distance from the diagonal up the
side. The turn is the deck's, so it turns every map at once; `flip=true` in a link. See
[The 45° view](/browse/turn/).

## Tutorial

The guided tutorial plays a first session on the live window, one step at a time, on 4DN's Hi-C of
K562 cells, greying everything but the control each step is about. It is offered on the landing page
under *New here?*, in **About**, and in the command palette as **Guided tutorial**. See
[The guided tutorial](/start/tutorial/).

## View

What a tab shows of its file: the **Chromosomes** table, the whole genome, a region, a selection of
sequences, the genome browser, or the cells of an `.scool`. `view=` in a link. See
[Link keys](/reference/links/).

## Virtual 4C

What one place touches: the contacts of an anchor with everything around it, as a track you can
export. The task *4C profile from an anchor*. See [4C profile from an anchor](/analyses/fourc/).

## Window

The browser tab, or the desktop app's window, that chromosomix runs in, with its header, its strip of
tabs, its panels, its console and its status bar. The theme, and each panel's width and fold, belong
to the window: the same whatever tab is in front. See [A tour of the window](/start/window/).

## Workspace

Every open tab in one file, a `.chromosomix.json`, written by **Save every tab as a file**
(<kbd>Ctrl</kbd>+<kbd>S</kbd>, <kbd>⌘</kbd>+<kbd>S</kbd> on a Mac). Dropped on the window, its tabs
open beside yours; published, it opens from `?config=<address>` or from a store's row. The browser
also keeps your last one and offers it back with **restore**. See
[Sessions, workspaces and links](/browse/sessions-and-links/).
