---
title: "Annotations and bookmarks"
description: "Draw your own lines, arrowheads and rectangles on the map, keep what an analysis found as tracks and called sets, draw the file's own columns as lanes, save places to come back to, and take all of it out of the app."
---

Everything you add to a map, beyond its contacts, is listed in the **Annotations** panel, the
column left of the map. It starts folded: press <kbd>2</kbd> or its button in the header to open it. Its
cards, from the top, are **Contact maps**, **Tracks**, **Structures**, **Manual annotations**,
**Metadata annotations** and **Bookmarks**. The last two start folded, and a card that the open file
cannot use is not shown at all.

Loading tracks from files is covered in [Tracks and features](/files/tracks/) and
[The genome browser](/browse/genome-browser/), and models on the **Structures** card in
[3D models beside the map](/browse/structures/). This page is about the marks you draw, the results
an analysis leaves, the file's own columns and bookmarks.

<!-- screenshot: the Annotations panel open beside a map, with two lines, an arrowhead and a rectangle drawn and listed on the Manual annotations card -->

## Your own marks

The **Manual annotations** card holds marks you draw yourself. Nothing on it comes from a file. There
are three kinds:

- a **line** marks one position, as a vertical rule, a horizontal one, or both (a crosshair);
- an **arrowhead** marks one cell of the map, a pair of positions, on or off the diagonal. It is the
  usual mark for a loop;
- a **rectangle** marks a block of contacts between two stretches: a domain on the diagonal, a
  corner peak off it, or a locus against a whole arm.

A line is a mark in one dimension. An arrowhead and a rectangle are marks in two.

### Adding a mark

The card has a form for each kind, headed **Lines**, **Arrowheads** and **Rectangles**. Each takes a
mark in one of two ways.

- **Type it** and press **add**, or Enter. Coordinates are 1-based and inclusive, as IGV and
  samtools write them, and you can paste them with commas, `kb` or `Mb`. A line takes one position
  and an axis: `vertical`, `horizontal` or `both`. An arrowhead takes a position for the rows and
  one for the columns, and a rectangle a stretch for each. Leave the second box empty for the same
  place on both axes.
- **Pick it on the map**: press **pick on map** (lines and arrowheads) or **draw on map**
  (rectangles), then click the map, or drag across it for a rectangle. Hold <kbd>Shift</kbd> while
  you drag to lock the rectangle to the diagonal. The mode stays on for as many marks as you want,
  until you press **done** or <kbd>Esc</kbd>.

You can also right-click the map: under **Mark this point** the menu offers **Vertical line**,
**Horizontal line**, **Crosshair** and **Arrowhead**, at the cell under the pointer. On a 3D model,
**Mark a bead**, **Mark a loop** and a Shift-click on a bead make marks too (see
[3D models beside the map](/browse/structures/)).

Beside the 1D browser the buttons read **pick on track** and **draw on track**. A track has one
axis, so what you place lands on the diagonal: a line becomes a crosshair, an arrowhead sits on the
diagonal, and a rectangle is the square on it. A map opened afterwards shows the same marks.

Each new mark takes the next colour of the palette.

### Where a mark is drawn

A mark is drawn on every picture at once: on each map, square or [turned](/browse/turn/), on the
lanes beside it, in a tracks cell, in the 1D browser and on a 3D model. On the tracks, a line is a
rule across every lane, an arrowhead is a small triangle at each of its two places, and a
rectangle's stretch is washed over every lane. A mark never sits on the pixel it is about: an
arrowhead stands off the cell it points at, so the cell stays visible.

### Moving, hiding and removing marks

Each row of the card shows the mark's place. Press it to edit the place in boxes like the forms'.
Enter, a click away, or a Tab past the row's last box moves the mark and keeps its colour and its
place in the list. Escape leaves it where it was. A box that does not read stays open with a red
edge.

Each row has an eye. Pressed, the mark leaves every picture and stays on the card, its eye shut, to
be pressed back. Over the rows, the **MARKS** heading says how many are hidden and has one eye for
all of them. <kbd>A</kbd> is that eye from the keyboard, and the command palette lists it as
**Manual annotations**, with `on` or `off` beside it.

- A **double-click** on a row's eye shows that mark alone. A second double-click brings back the
  others.
- What the eye over the list brings back is what it hid. A mark you hid on its own stays hidden.
- Every picture's right-click menu has a **Marks** group: **Hide this line**, **Hide this
  arrowhead** or **Hide this rectangle** for the marks under the pointer, then **Hide every mark**,
  or **Show the marks** once none is drawn.

A figure saved while a mark is hidden is saved without it. The × on a row removes that mark, and
**remove all** under the list clears every mark on this file.

### Saving and loading marks

The card's **Export** row writes the marks as a file. Choose **lines (BED)** or **arrowheads &
rectangles (BEDPE)**, then press the save button beside it. The file holds every mark of that kind,
hidden ones included.

Marks come back in through the **Import** section: drop a BED or a BEDPE anywhere on the card, or
click **Load marks** to choose one. Each row is read on its own merits:

- a BED row is a line, on the axis its name column says (`vertical`, `horizontal` or `both`), or a
  crosshair at the interval's start when the name is anything else;
- a BEDPE row is an arrowhead when both of its anchors are one base wide, as the export writes one,
  and a rectangle otherwise.

Each mark takes the next colour, since neither format carries one, and a mark already at the same
place is not added twice. A line under the zone reports what happened, such as
`marks.bed: 2 added, 1 skipped.` The same BED dropped on the map instead becomes a track.

## What an analysis leaves

A task in the [Analysis panel](/analyses/) leaves its results where you can draw and compare them:
as rows of the **Tracks** card. The drawer says so in one sentence when the run finishes, such as
*3 tracks added to the Tracks card in the Annotations panel, marked \*.*

### A computed track is a track

A result with one value per bin, such as an insulation score, an E1 or a coverage, becomes a track
like a loaded bigWig. It has the same colour, height, style, scale, limits, groups, edges and batch
settings, and it can be drawn in the 1D browser and coloured onto a 3D model. Three things tell it
apart:

- a `*` after its name. Its tooltip says it was computed here, by which task and from what view;
- a line under its name saying what made it;
- in its settings (the chevron, **Show this track's settings**), the exports and the view it was
  computed from. A computed track leaves as **bigWig**, **bedGraph** or **TSV**.

Run the task again and its rows get the new values in place, in the same lane and the same spot in
your arrangement.

Two loaded tracks can be combined the same way: tick both on the **Tracks** card and choose
**ratio** or **difference** under **combine…**. The new row is computed too, and marked `*`.

### A called set has two displays

Peaks, boundaries, domains, A and B compartments, loops: a set of intervals or pairs that a task
called arrives as **one row**. Its settings open on **display**, which puts it in one of two places:

- **1D track**: segments beside the map and in the 1D browser, each as wide as its call. For a set of
  pairs it reads **arcs (1D track)**: an arc joining the two ends of every pair;
- **map overlay**: on the map it was called from. A set of pairs is a ring round each pair. A set of
  places, such as boundaries or peaks, has a **look** beside the display, **point** (a dot on the
  diagonal) or **short diagonal marker** (a rule across the diagonal that leaves the diagonal itself
  uncovered). A set of stretches, such as domains or compartments, is drawn as the corner of each
  one's square along the diagonal.

Each task chooses where its sets open. A set read against a lane opens as a track right under that
lane: peaks under the coverage they were called on, boundaries under the insulation score, A and B
under E1. A set that is a picture of the map, such as domains or loops, opens on the map. So a run of
insulation that calls boundaries and the domains between them lands as three rows: the score, the
boundaries under it, and the domains on the map. In the 1D browser every called set is drawn as a
track, since there is no map for it to be on.

Each called interval carries a name in the BED's fourth column, numbered in genomic order, such as
`A` or `B`, `peak_12`, `domain_3` or `boundary_40`. A lane can be coloured by those names.

A called set leaves as **BED**, or **BEDPE** for pairs, and as **TSV**. A set of pairs also offers
**anchors**: both ends of every pair as a BED, each place once however many pairs share it, for a
motif scan or an overlap with peaks. A set of pairs you loaded from a file offers its anchors too.

### After a reload

The values of a computed row are not kept: they can be megabytes. Its recipe is: the task, its
parameters and the view it was computed from. After a reload the row keeps its colour, name, limits
and place, says *values not kept over the reload*, and offers **recompute**. A saved workspace and a
shared link carry the recipe the same way, so whoever opens them gets the analysis rather than a
number to take on trust.

Opening the same file at another resolution keeps the computed rows and their values, on the bins
they were computed on. Opening a different file leaves them behind.

## The file's own columns

Some files keep tables beside their contacts. A balanced cooler's bins table holds the weights it
was balanced with, and often more columns that other tools added. The **Metadata annotations** card
draws those columns as lanes. Choose one from its menu, where columns are grouped by the table they
come from, and press **add**. From then on it is a lane like any other.

- A column of numbers is drawn as bars. A column of labels is drawn as runs of colour with each
  category's name written in, from a fixed palette, with a legend.
- A column that differs on nearly every row is an identifier and is not offered.
- A column can be no finer than the view. On a view where one cell of the map is a whole sequence, a
  column of the bins table is listed but greyed, and a note under the menu says why. Where one cell
  covers several bins, it shows their mean (numbers) or their commonest value (labels).
- **TSV** writes the column as the file wrote it: one row per unit of its table, under `#` lines
  naming the file, the table and the column. A bins column is written for the bins read so far,
  those the picture covers, and the file says which.

A metadata row comes back after a reload ready to draw, since its data is in the map that is already
open. The card is hidden for a file that carries no such columns.

## Bookmarks

A bookmark is a place on the genome and the bin size it was found at. It does not keep the zoom, the
colour scale or which way the map was turned: those are how the picture was drawn, not where it is.

There are three ways to make one:

- press the bookmark button beside **go** in the map's title bar (**Bookmark this view — the place on
  screen, at this resolution**), or <kbd>B</kbd>, or **save this view** on the card. The card opens
  so you can see the new row;
- type a window or a single position into the card's **Save a place** box and press **add**. It reads
  coordinates as every locus box does, 1-based and inclusive, so a locus copied from IGV, UCSC or a
  paper lands where it says;
- under **Import**, press **regions from BED…**. Every interval in the file becomes a bookmark: the
  first three columns are the place and the fourth, if there is one, its name. A BED states no bin
  size, so these open at whatever resolution the map is at.

Each row shows the name if it has one, the place, and the resolution it was saved at. Click the row
to go there: the whole sequence opens, zoomed to the place, so you can pan to either side of it. The
× forgets one place and **remove all** forgets every place on this file. Saving a place that is
already there says so instead of adding it twice.

On a 3D model, bookmarks are written at their middle beads, with the sequence names.

## Taking annotations out

| What | Where | Formats |
| --- | --- | --- |
| Your marks | **Manual annotations**, **Export** | lines as BED; arrowheads and rectangles as BEDPE |
| A computed track | its row's settings, or the Analysis drawer | bigWig, bedGraph, TSV |
| A called set | its row's settings, or the Analysis drawer | BED, or BEDPE for pairs, and TSV. A set of pairs' anchors from its row |
| A loaded set of pairs | its row's settings | anchors, as BED |
| A metadata column | its row on **Metadata annotations** | TSV |
| A 3D model | its row on **Structures** | bed3d, PDB |

The bigWig is written by chromosomix itself, with no conversion step, for IGV, deepTools and
pyBigWig. A bedGraph has one line per bin that has a value: bins with none are left out, never
written as 0. A TSV opens with the task, its parameters and the view as `#` lines, which a bigWig has
no room for. Bookmarks have no export of their own: they travel in a saved workspace and a shared
link.

Every file goes through your system's save dialog, where the browser has one, and is listed in the
[console](/browse/console/). See [Figures and export](/browse/figures/).

## What is kept, and where

Every track, mark, bookmark and setting is remembered for its file in this tab. It survives a
reload, a change of resolution, a switch between the map and the tracks, and a deck opening and
closing. Two tabs on the same file share none of it.

The link in the address bar carries only what is being looked at, not these. A link made with
**Share this tab as a link**, and a saved workspace, carry them all; see
[Sessions, workspaces and links](/browse/sessions-and-links/).

After a reload, each row comes back as its kind allows:

- a track from an address is read again from there;
- a track from your disk keeps every setting and asks for the file again, with **re-open this file**,
  or **allow access** where this browser kept permission to read it. Dropping the same file again
  answers it, rather than adding a second row;
- a computed row comes back with **recompute**;
- a metadata row comes back ready.
