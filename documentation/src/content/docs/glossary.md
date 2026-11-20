---
title: "Glossary"
description: "The words you meet in chromosomix and in these pages, each with a short definition and a link to the page that explains it."
---

The words you meet on screen and in these pages. Where a page explains one at length, its entry
links there.

## Aggregate peak analysis (APA)

The map averaged around a set of loops or features, against a control, to show whether they are
enriched as a group. See [Aggregate peak analysis](/analyses/apa/).

## Allow access

The button a tab shows when Chrome or Edge remembers a local file but needs your permission to read
it again, after a restart say; one press allows them all. See
[Sessions, workspaces and links](/browse/sessions-and-links/).

## Arms, origin and terminus

A bacterial chromosome's replication **origin**, set in the Chromosomes table or by the *Origin and
terminus* task, splits it into two **arms** that meet at the **terminus**. See
[Origin and terminus](/analyses/oriter/) and [Inter-arm alignment](/analyses/interarm/).

## Assembly

A genome's sequences and their lengths, read from a FASTA, a `.2bit`, a `chrom.sizes`, a cytoBand, a
map, or the header of a bigWig, bigBed or BAM. See [Reference sequences](/files/sequences/).

## Balancing

Correcting a map for how visible each bin is (its total contacts), so its rows and columns compare.
**balanced** reads the file's own weights; VC,
square-root VC and ICE are computed in the page. `balance=true` in a link. See
[Reading a contact map](/browse/contact-maps/).

## Batch

The box above the **Tracks** card's list when two rows or more are ticked: its settings apply to all
of them, and read *mixed* where they differ. See [Annotations and bookmarks](/browse/annotations/).

## Bin

A fixed stretch of sequence, one row or column of a map. A map's [resolution](#resolution) is its
bin size.

## Bookmark

A saved place, with the resolution it was found at, on the **Bookmarks** card. See
[Annotations and bookmarks](/browse/annotations/).

## Bucket

An object store, such as Amazon S3, Cloudflare R2 or Google Cloud Storage, serving files by byte
range. **connect a bucket…** connects a prefix as a folder, with a key if it is private. See
[Hosting your data](/advanced/hosting/).

## Called set

What a task found — boundaries, domains, peaks, A/B segments, sites, loops — as one row of the
**Tracks** card, drawn beside the map or over it. See [How analyses run](/analyses/).

## Card

A titled box in a side panel, such as **Tracks** or **Map**. Drag it by its heading to another panel;
**Put every card back in its own panel**, in the command palette, undoes that. See
[A tour of the window](/start/window/).

## Cell

One place in a [deck](#deck): a map, a structure cell (a 3D model), a tracks cell (the tab's tracks
alone), or an empty cell, which takes a map, a track or a structure dropped on it. See
[Maps side by side](/browse/deck/).

## Circular sequence

A sequence whose ends join, such as a plasmid, ticked in the Chromosomes table's *circular* column;
a file's first opening ticks those that look circular. Windows may cross the join, and most tasks
measure distance the short way round.

## Command palette

<kbd>Ctrl</kbd>+<kbd>P</kbd> (<kbd>⌘</kbd>+<kbd>P</kbd> on a Mac): every command by name, with its
key. <kbd>?</kbd> lists the keys. See [Keyboard and command palette](/browse/keyboard/).

## Comparison

A second map in the lower-left triangle of the same square, on one colour scale, or the two maps'
ratio or difference. Both need the same bin size and sequences; otherwise use a [deck](#deck). See
[Comparing two maps](/browse/comparing/).

## Compartments

The checkerboard of a Hi-C map: chromatin of two kinds, A and B, each in contact with its own. The
*Compartments* task finds them as E1, its sign phased by genes, a track or GC content. See
[Compartments](/analyses/compartments/).

## Connected folder

A folder on your computer, a bucket prefix, a Google Drive folder or your Dropbox, listed in the
**Files** panel. In a browser tab a folder on your computer lasts the visit (*this visit*); an
installed app keeps it. See [Opening files](/files/opening/).

## Console

What the window has done, as the `chromosomix` commands that repeat it.
<kbd>Ctrl</kbd>+<kbd>&#96;</kbd>, the key left of <kbd>1</kbd>, opens it; this browser keeps a week
of it, 500 lines at most. See [The console](/browse/console/).

## Contacts box

The *contacts* box over the map draws every map in the tab at the number of contacts you type,
subsampled exactly if it has more and oversampled with Boost-HiC if fewer, to compare depths.
`contacts=` in a link. See [Comparing two maps](/browse/comparing/).

## Coordinates

What you read and type is 1-based and inclusive, as in IGV and UCSC, and the command line takes the
same: `IV:1,000,001-1,400,000`. A map's `region` in a link is cooler's 0-based, half-open
`IV:1000000-1400000`. See [Link keys](/reference/links/).

## Deck

Cells side by side in one tab, panned and zoomed together, opened by the `+` down the map's right
edge or along its bottom. Its maps need share only coordinates, and are drawn at the first map's
resolution, or the nearest each file has. `maps=` in a link. See [Maps side by side](/browse/deck/).

## Desktop app

chromosomix for macOS and Linux, from the
[releases page](https://github.com/js2264/chromosomix/releases): the same viewer on your disk, which
can also read a compressing host by range. See [Web, desktop or one file](/start/where-to-run/).

## Detached

A track from a local file after a reload: its settings are back but not its bytes, so its row offers
to read the file again. A computed track offers **recompute** instead. See
[Sessions, workspaces and links](/browse/sessions-and-links/).

## Domain

A square along the diagonal, often called a TAD: a stretch in more contact with itself than with its
neighbours. Insulation and the directionality index find its borders; *TAD annotation* finds the
domains, nested where they nest. See [TAD annotation](/analyses/arrowhead/).

## Edge

The side of a map a track's lane is on: top, right, bottom or left. A file dropped on the middle of a
map is that map's alone. See [Annotations and bookmarks](/browse/annotations/).

## Embed

The viewer in another web page, as an `<iframe>` with `?embed=1`: one view of one file, with no
header or tabs. See [Embedding in a web page](/embed/web-page/).

## Eye, × and grip

On each row of the **Contact maps**, **Tracks** and **Structures** cards, the eye shows or hides, the
× lets go, and the grip drags the row along the card, onto a cell or onto a `+` edge.
See [Maps side by side](/browse/deck/).

## Facet

One of a store's columns, down the side of its page, with every value counted. Ticks in one facet add
up; ticks in two narrow each other. See [Data stores](/files/stores/).

## Feature set

A track of intervals — peaks, genes, any BED — that a task can take as its features. The star on its
**Tracks** row makes it the set the feature search and the tasks read by default. See
[Tracks and features](/files/tracks/).

## Framing and provenance

The **framing** is what a task runs on — the window, bin size, score and the rest — taken when you
press **run**, so the result stands when you pan away. The **provenance** adds the task, its
parameters, the file, the build and the time, and goes into every export that can hold it. See
[How analyses run](/analyses/).

## Genome browser

The 1D view: tracks along a sequence, with or without a map. A track or a reference opened on its own
starts one. `view=browser` in a link. See [The genome browser](/browse/genome-browser/).

## Group

Tracks sharing one value axis, in a lane each or overlaid, so two strands of an experiment share a
ceiling; set to *each*, every member keeps its own. On the **Groups** card. See
[Annotations and bookmarks](/browse/annotations/).

## Ideogram

A chromosome drawn from a UCSC cytoBand file, with its bands. A band's name, such as `Xq28`, works in
the locus box. See [Tracks and features](/files/tracks/).

## Insulation

How much contact crosses each bin, in a diamond-shaped window slid along the diagonal. Its dips are
domain boundaries, higher in the hierarchy as the window widens. The task *Diamond insulation*. See
[Diamond insulation](/analyses/insulation/).

## Lane

One placement of a track, on one map and one edge; a track can have several, or none. See
[Annotations and bookmarks](/browse/annotations/).

## Lead and companion

In a deck, the **lead** (*the first map*, in the app) is the tab's own file, which names the tab and
holds its tables, tracks and comparison; the **companions** are the maps beside it. See
[Maps side by side](/browse/deck/).

## Level

What one row and column of the map stand for: a bin, or a whole sequence summed into one cell.
`level=contig` in a link. See [Reading a contact map](/browse/contact-maps/).

## Lock and chain

What moves a deck's maps together. The lock follows places in base pairs, across resolutions; a map's
chain says whether it follows. See [Maps side by side](/browse/deck/).

## Locus

A window in the genome browser, 1-based and inclusive: `chrI:1,001-20,000`. The locus box also finds
a gene or a band by name. See [Moving around](/browse/navigating/).

## Loop

A dot off the diagonal: two places in more contact than their distance predicts. *Loop calling* and
*Pattern detection* (Chromosight) find them. See [Loop calling](/analyses/loops/).

## Mark

A line, an arrowhead or a rectangle you draw on the map, typed as coordinates or picked, on the
**Manual annotations** card. Marks leave as BED and BEDPE files. See
[Annotations and bookmarks](/browse/annotations/).

## Metadata annotation

A column the file carries about its sequences or bins, such as a balancing weight, drawn like a
track. On the **Metadata annotations** card. See [Annotations and bookmarks](/browse/annotations/).

## O/E

Observed over expected: each cell divided by what its distance from the diagonal predicts, leaving
what is unusual. A switch beside the score, not a score. `oe=true` in a link. See
[Reading a contact map](/browse/contact-maps/).

## P(s)

Contact probability against genomic separation *s*: the fall of contact with distance that every Hi-C
map shares, and the expected O/E divides by. The task *Contact probability P(s)*. See
[Contact probability P(s)](/analyses/expected/).

## Panel

A column either side of the map: **General**, **Annotations**, **Aesthetics** and **Analysis**, with
**Files** while a folder is connected. See [A tour of the window](/start/window/).

## Pinned release

A release kept for good at `https://chromosomix.app/v/<tag>/`, which takes the same links and embeds
as the root and goes on drawing the same picture. **About** lists the published builds. See
[Running your own copy](/advanced/self-hosting/).

## Refine on zoom

The tick at the head of a map's resolution row, also in the command palette, on by default: a map is
read at about the size of the screen, and zooming in reads the stretch you pause on again at a finer
resolution, down to the finest the file stores, without the map ever stopping; the row follows,
greyed. Off, the map is drawn at the resolution you pick, coarser only where the window is too wide
for it; a link that names a resolution opens at it, unticked, whatever your own setting. See
[Moving around](/browse/navigating/#resolution-and-the-zoom).

## Resolution

A map's bin size, such as `5 kb`. An `.mcool` or a `.hic` stores several, named in an address by
`::/resolutions/<bin size>`; one summed from whole bins of a stored one is marked `*`: `3 kb*`. The
one picked in the row above the map is in the link as `resolution=`. See
[Contact maps](/files/contact-maps/).

## Score

What a map's cells hold: raw or balanced counts, VC, square-root VC or ICE, the expected count, the
correlation compartments are read from, or another column of the file. `score=` in a link. See
[Reading a contact map](/browse/contact-maps/).

## Sequence

One chromosome, contig or plasmid. The app says *sequence*, and *chromosome* or *contig* where it
reports a file's own word, as in the **Chromosomes** table. See [Moving around](/browse/navigating/).

## Session

What a tab holds — a file, its views, tracks, marks and settings — called a *tab* on screen; also
such a tab written down, as a store's **pre-configured session** or an example under
*Pick an example session*. See
[Sessions, workspaces and links](/browse/sessions-and-links/).

## Share link

A link to one tab from **Share this tab as a link**, holding the tab after the `#`, which no server
sees. **shorten with is.gd** shortens it through that service. See
[Sessions, workspaces and links](/browse/sessions-and-links/).

## Single file

The whole viewer as one HTML file, `chromosomix-<tag>.html`, on every release. It opens from a disk
with no network, and reads local files only. See [Web, desktop or one file](/start/where-to-run/).

## Splice junction

An intron reads were seen to skip, and how many — from STAR's `SJ.out.tab`, a junctions BED,
leafcutter's `.junc` or a spliced BAM — drawn as a sashimi arc as tall as its count. See
[Tracks and features](/files/tracks/).

## Star

Which map of a deck the **Analysis** panel reads, the **Map** card sets and the **File** card
describes. With none starred (press the filled star), the Map card sets every map and the tasks that
read a map wait. See [Maps side by side](/browse/deck/).

## Status bar

The strip at the foot of the window. Its **read** gives the requests and bytes this tab's files have
cost. See [A tour of the window](/start/window/).

## Store

A catalogue of published files, browsed in the store drawer: one JSON file, or a UCSC track hub.
Built in: Example datasets, IGV genomes, 4DN open data, ENCODE, DNA Zoo and Roadmap;
**Add a custom store** opens others. See [Data stores](/files/stores/) and
[Your own data store](/advanced/data-store/).

## Store drawer

The panel down the left where a store is browsed, opened by a store's tile on the landing page, the
header's toggle or <kbd>&#92;</kbd>. One serves every tab. See [Data stores](/files/stores/).

## Structure and model

A **structure** is a 3D file of beads (g3d, `.3dg`, bed3d or PDB) drawn in a structure cell; a
**model** is one set of its coordinates, a **chain** one sequence's beads, a **bead** one row.
*Model from the map* makes one from the contacts. See
[3D models beside the map](/browse/structures/).

## Synthetic track

A task's result, or the ratio or difference of two tracks, as a row of the **Tracks** card marked `*`.
After a reload its row offers **recompute**. See [How analyses run](/analyses/).

## Tab

One session, in the strip under the header: a file and what you did with it, twelve at most.
<kbd>o</kbd> opens one, <kbd>Ctrl</kbd>+<kbd>&lt;</kbd> and <kbd>Ctrl</kbd>+<kbd>&gt;</kbd> step
between them, and <kbd>F2</kbd> or a double-click renames one. See
[A tour of the window](/start/window/).

## Task

One analysis on the **Analysis** panel, under **2D tasks**, **3D tasks** or **1D tasks**. Pressed, it
opens in the Analysis drawer while the map stays live; a greyed task says what to load first. See
[How analyses run](/analyses/).

## Track

A 1D dataset you loaded — a bigWig, a BED, gene models, reads — on the **Tracks** card, drawn in one
or more [lanes](#lane). See [Tracks and features](/files/tracks/).

## Track hub

UCSC's format for publishing tracks: a `hub.txt` naming a `genomes.txt`, which names a
`trackDb.txt` for each assembly. **Connect to a UCSC hub** reads one as a store. See
[UCSC track hubs](/advanced/track-hubs/).

## Transform and colour scale

The **transform** (`log1p`, `log10`, `log2` or none) is the scale a value is coloured on, clipped at
`vmin` and `vmax`, automatic unless you set them. The **colour map** is the ramp; `RdBu_r`, `BuWtRd`
and `seismic` are diverging, for a ratio or an O/E. See
[Reading a contact map](/browse/contact-maps/).

## Turn (the 45° view)

One sequence's map rotated 45°, with distance from the diagonal up the side; it turns every map of the
deck. `flip=true` in a link. See [The 45° view](/browse/turn/).

## Tutorial

A first session played on the live window, step by step, on 4DN's Hi-C of K562. Start it under
*New here?* on the landing page, in **About**, or with **Guided tutorial** in the command palette. See
[The guided tutorial](/start/tutorial/).

## View

What a tab shows of its file: the **Chromosomes** table, the whole genome, a region, some sequences,
the genome browser, or an `.scool`'s cells. `view=` in a link. See [Link keys](/reference/links/).

## Virtual 4C

An anchor's contacts with everything around it, as a track; the task *4C profile from an anchor*.
See [4C profile from an anchor](/analyses/fourc/).

## Window

The browser tab or desktop app window chromosomix runs in. The theme and each panel's width and fold
belong to it, whatever tab is in front. See [A tour of the window](/start/window/).

## Workspace

Every open tab in one `.chromosomix.json`, from **Save every tab as a file**
(<kbd>Ctrl</kbd>+<kbd>S</kbd>, <kbd>⌘</kbd>+<kbd>S</kbd> on a Mac). Dropped on the window, its tabs
open beside yours; published, it opens from `?config=<address>` or a store's row. **restore** offers
your last one back. See [Sessions, workspaces and links](/browse/sessions-and-links/).
