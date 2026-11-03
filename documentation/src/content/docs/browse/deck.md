---
title: "Maps side by side"
description: "Put several contact maps, stacks of tracks and 3D models side by side in one tab, moving together, each map on its own colour scale."
---

A deck is a grid of cells in one tab — contact maps, stacks of tracks, 3D models — side by side and
moving as one. Every map shows the same place, so four replicates, two conditions, or a Hi-C map
beside a Micro-C one are read against each other at a glance, each on its own colour scale. The maps
have to share coordinates but not a grid: they may be at different resolutions, in different file
formats, and spell their sequences differently.

<!-- screenshot: a 2 × 2 deck of yeast Micro-C maps at one locus, with a track under each -->

## Making a deck

Draw the shape first, then fill it. A `+` runs down the right edge of the map and another along its
bottom: the one beside it adds a column of cells, the one below a row, and your map stays in the
first cell. Each new cell is empty and reads *Drop a map, a track or a structure*:

- drop a contact map on it, or click it to choose one, and the map opens there;
- drop a track — a file, or a row dragged from the **Tracks** card — and it becomes a cell of tracks;
- drop a 3D structure, or a row of the **Structures** card, and it draws that model.

A file dropped on a `+` opens the cells and fills the nearest one in one movement. A contact map
dropped anywhere on an open map opens beside it, in the first empty cell or in a new one, and several
dropped at once fill a deck. Once there is a deck, **add a cell…** in its bar opens a row with
**choose a file…**, a box for a map's address with **add**, **add a 3D structure** and **add a tracks
cell**. The command palette's **Add a map beside this one** opens a map too.

The grid is always a rectangle, filled in reading order, and the **across** picker in the bar
(**2 across**, **3 across**, …) sets how many cells make a row. An empty cell is a real cell: it stays
where you drew it, and a link keeps it.

## Moving together

The maps of a deck share one navigation: a pan or a zoom on any of them, a locus typed in the box, a
zoom step or a step to another sequence moves them all. The heading — the title, the locus box, the
zoom steps and the summary line — stands above the grid rather than in the first cell, because it
answers one question for every map, and the summary ends with the number of maps: `· 3 maps`.
Pointing at one map marks the same place on the others.

The deck keeps the maps together in base pairs rather than in cells, so a 1 kb map and a 5 kb map
show the same stretch, the coarser one rounding outward to show at least what was asked for. A
window that runs off the end of a shorter sequence is slid back inside it at the same width rather
than cut short.

Each cell's heading has a chain, lit while that map follows the others. Press it to let the map move
on its own, and press it again to put it back in step. A map off the chain reads a window of its own:
draw a box on it with <kbd>⌥ Option</kbd> held (<kbd>Alt</kbd> on Windows and Linux), and that map
alone reads the window, as finely as its resolution allows. The window shows as a pill in the map's
heading, with a zoom-out button that widens it three times about what is on screen, and a **×** that
gives the map back to the deck's window.

The sequence picker beside each map's name opens a whole sequence. On any map but the first,
picking one takes that map off the chain onto the whole of that sequence, so a Micro-C map can stay
on IV while the Hi-C map beside it shows V. On the first map, the pick moves the whole deck, and so
does a box drawn on a map that is still on the chain.

## The star

Each map's heading carries a star, and one map is starred: the first, until you star another. The
starred map is the one

- the **Map** card in the **Aesthetics** panel sets, with a line under the card's title naming it;
- the **File** card in the **General** panel describes;
- the tasks in the **Analysis** panel run on ([How analyses run](/analyses/)).

Press the filled star to leave no map starred. The **Map** card then sets every map at once, and its
title line says so in a warning colour, *every map — all 4*. With no map starred, only the tasks that
read tracks alone can run.

## What is shared, and what is not

What is being looked at is shared; how each map is drawn is its own.

| | Shared | Each map's own |
|---|---|---|
| The region, the sequence or selection, the level | yes | |
| Pan and zoom | yes, unless the map is off the chain | |
| The [45° turn](/browse/turn/) | yes | |
| Resolution | | yes, starting at the first map's bin size where the file has it |
| Score, O/E, smoothing, arms | | yes, starting as the first map's |
| Transform, colours, clip | | yes, starting as the first map's |

A map put beside another opens on the first map's score, derivations and colour scale, so a deck
nobody has touched compares like with like. From then on each map's settings are its own, set on its
**Map** card while it is starred. A clip is a number of contacts, and two libraries of different
depth do not share one, so the clips stay apart. Two presses in the deck's bar put the maps on one
footing when you want it:

- **match all scales** copies the starred map's clip to every map, once;
- **match all resolutions** reads every map at the starred map's bin size; a file without that
  resolution stays where it is, and a line under its heading says so.

Both are greyed while no map is starred. Changing the first map's resolution in the bar changes the
deck's: every map follows, or says why it cannot. To put the libraries themselves at one depth, draw
every map to one total with the chevrons after the **contacts** box
([Drawing maps to one total](/browse/contact-maps/#drawing-maps-to-one-total)).

## When a map cannot follow

The maps are checked against each other once they have been read: two maps that found the same name
at two different lengths are showing two different places, whatever the name says. A map that fails
the check is still drawn, still readable and still exportable — only the lock is off, and a line
under its heading says why, rather than the deck claiming a navigation it does not have. The check
allows one cell of the coarser map for each sequence, since a sequence's last bin may be short.

A file with no sequence of that name is refused in its own cell, with the names it does have. On a
turned deck every band is cut to reach as far from the diagonal as the first map's, and a map whose
block does not reach that far cannot follow, and says that.

## Arranging the cells

Every cell is the same size, and every map is drawn at the same size and the same height: the room
the deepest stack of tracks takes on each edge, on whichever map, is kept on every map, so the
pictures line up to the pixel. A stack too wide for its cell scrolls sideways inside it rather than spilling
over its neighbour.

To rearrange, drag a cell by the grip before its name and drop it on another cell: the two exchange
places. The first map has a grip like any other; moving it changes where its picture stands, not
which file the tab is of.

The **Contact maps** card in the **Annotations** panel lists every map, in the order the grid holds
them. Each row has an **eye**, which takes the map out of its cell and keeps it on the card, dimmed,
to come back as it was; a **×**, which lets the map go; and a grip. Drag the row up or down the card to
move its map's cell, or onto a cell or a `+` edge to put the map there. Dragging the first map's row
onto an empty cell opens the same file again beside it — the plainest way to read one file at two
windows, or on two colour scales.

The **×** on a cell's own heading hides its map, as the eye does, rather than letting it go. The
first map's cell can be closed too: it is put away, still steering the deck, and a **show** button in
the deck's bar, naming it, puts it back where it stood.

**close deck**, at the far right of the bar, closes every cell but the first map's. The other maps
stay on the **Contact maps** card, hidden, and no track is lost: a track that was drawn only on the
closed maps moves onto the first map, at the edge it was on.

## Naming the maps

A map is labelled by its file name, which for four replicates is four labels differing in a digit.
Click a map's name — on the **Contact maps** card or on its cell's heading — and type a name of your
own. <kbd>Enter</kbd> keeps it, <kbd>Esc</kbd> abandons it, and an empty box gives the file name back;
<kbd>Tab</kbd> keeps it and moves to the next map's name, so a deck is named in one go.

The name is used everywhere the map is named: on the card, over its cell, on the two bands of a
turned comparison, in the readout, in the label of a ratio, in the caption of a saved figure, and in
what a task makes of the map — its tab in the **Analysis** panel, the lane it adds, its line in the
[console](/browse/console/). A name belongs to the file, so it survives a change of resolution, and
it travels in a saved workspace and in a shared link, for the maps the recipient can open.

## Cells that are not maps

- A **tracks cell** is a genome browser of the tab's own tracks, drawing only the tracks you put on
  it: drop a track file or a **Tracks** card row on it, or pick it in a track's **location**. It
  follows the maps and the maps follow it, but it has no locus box of its own — the one above the
  grid steers it — and in it <kbd>-</kbd> and <kbd>+</kbd> step the deck's resolution. Its heading
  is a name you can change, so two stacks read *G1* and *G2M*, and a bar under it sets its height.
  Its chain unhooks it from the maps.
- A **structure cell** draws a 3D model of the genome with a camera of its own; two cells of one
  model are two views of it ([3D models beside the map](/browse/structures/)).

Open one with **add a 3D structure** or **add a tracks cell**, in the row that **add a cell…** opens,
or by dropping a track or a structure on an empty cell or a `+`. A tab showing the genome browser can
open a deck as well; the cells beside it are tracks and structures, and a map dropped on it opens as a
tab of its own.

## A deck in a link

The deck is part of the address. `maps=` lists the cells beside the first map, in order, joined by
`|`: a map's address, `tracks` for a tracks cell, `3d` for a structure cell, and `~` for an empty
cell or for a file on your own disk, which no link can carry. The first map is `uri`
([Link keys](/reference/links/)). A deck of files at public addresses opens the same for whoever
follows the link; a local map arrives as an empty cell saying a map was here, so the count and the
order of the cells survive.

The deck stays with the file as you move around it — through the **Chromosomes** table to another
sequence, or to another resolution — and goes when you open a different file. How many cells make a
row, which maps are off the chain and each map's own settings are not in the address. They are kept
with the tab, in a saved workspace and in a link from **Share this tab as a link**
([Sessions, workspaces and links](/browse/sessions-and-links/)).

## What it costs

Each map is read on its own, and the memory one map alone may use is shared out between the maps:
in a deck of four, each map gets a quarter. A deck therefore never costs more than the single map it
replaced, and a window a map cannot afford at its own bins is drawn summed into coarser cells rather
than refused. Empty cells, tracks cells and structure cells take no share. A deck holds at most 64
cells, eight by eight; at the limit the `+` greys and says why.

The download and copy buttons in the deck's bar save the whole deck as one figure, laid out as it is
on screen — a PNG, or a PDF whose axes, tracks and labels stay editable — and <kbd>⌘ C</kbd>
(<kbd>Ctrl C</kbd>) copies it while a deck is open ([Figures and export](/browse/figures/)).
