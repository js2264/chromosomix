---
title: "A tour of the window"
description: "What each part of the chromosomix window is for: the header, the tabs, the picture and its deck of cells, the four panels, the Files column, the console and the status bar."
---

From the top: the **header**, the **tabs**, the **trail** and the **heading** over the **picture**,
with the **panels** either side, the **console** along the bottom when it is open, and the
**status bar** at the foot.

![The whole window on the yeast micro-C demo: the header, the tab, the trail ending in the resolution and contacts, the heading over the map, the map with its tracks under and beside it, the General panel open on the left and the Aesthetics panel on the right, the Annotations and Analysis panels folded to strips, and the status bar.](../../../assets/screens/start/window.webp)

## The header

From left to right:

- **The brand**, the mark and **chromosomix**: the landing page, in a new tab if this one holds
  something.
- **The stores**, which opens the store drawer (<kbd>\\</kbd>), and, while a folder is connected,
  **the Files column**.
- **The four panels' buttons**, absent with their panel when it has nothing to show.
- **+** adds a file to this tab: a second map beside the first, anything else as a track. In an empty
  tab it opens the file.
- **Back** and **forward**, the browser's own; the chevron beside back lists the steps behind you.
- **Share this tab as a link**, **Save every tab as a file** (<kbd>Ctrl</kbd>+<kbd>S</kbd>,
  <kbd>⌘</kbd><kbd>S</kbd> on a Mac) and **the console**
  ([Sessions, workspaces and links](/browse/sessions-and-links/)).
- **Search commands…**, the command palette (below).
- **About the window**: the theme (<kbd>T</kbd>), the keyboard shortcuts (<kbd>?</kbd>), this
  documentation, the source on GitHub, and *About this viewer*: the guided tutorial, the build, the
  notebooks that check it and the licences.

A button's tooltip names its key.

### The command search

**Search commands…**, or <kbd>Ctrl</kbd>+<kbd>P</kbd> (<kbd>⌘</kbd><kbd>P</kbd> on a Mac), finds any
action by name, with its key; one that cannot act on what is open is greyed. Here too is
*Refine on zoom*, which does what the tick at the head of a map's resolution row does: on by default,
it reads a map at about the size of the screen and finer as you zoom; a resolution you pick is drawn
whatever it says. Only here, under Help, is *What this browser is remembering*, with a button that forgets it all
([Keyboard and command palette](/browse/keyboard/)).

## Tabs

A tab per open file, twelve at most, each a session of its own: two tabs on the same file share
nothing. The **+** at the end of the row, or <kbd>O</kbd>, opens a new one;
<kbd>Ctrl</kbd>+<kbd>&lt;</kbd> and <kbd>Ctrl</kbd>+<kbd>&gt;</kbd> step between them; a double-click
or <kbd>F2</kbd> renames one; its × or a middle-click closes it, and the last is emptied instead.

For a file on the web, the address bar is a link to the view. After you close the browser, the
window offers your tabs back with **restore**. A bar under the tabs carries what a tab found out about
its file, such as a sequence that reads as circular, until you dismiss it.

## Over the picture: the trail and the heading

**The trail** — the file, the table or the whole genome, the sequence, the window — says where you
are and takes you back up; click the file to open another in its place. At its end, the
**resolution** row: **refine on zoom**, ticked so that the map is read at the screen's resolution and
finer as you zoom, and a slider and a box that follow it, or pick a bin size the file stores
(<kbd>-</kbd> and <kbd>+</kbd> step), and its **+** adds one summed from the file's bins, marked `*`.
**contacts** draws every map in the tab at the number of contacts you type, `10M` say, to compare
libraries at one depth.

**The heading** has the title, with `‹` and `›` for the previous and next sequence; the locus box
and **go**; arrows and zoom steps; and a bookmark of the view (<kbd>B</kbd>). The line under it gives
the *effective resolution*, the size of one cell as drawn: the screen's while *refine on zoom* picks
it, and coarser than the one picked when the window holds more bins than a block can
([Moving around](/browse/navigating/#resolution-and-the-zoom)).

## The picture, and the deck of cells

A tab shows **a contact map**, with tracks on its edges and marks on it
([Reading a contact map](/browse/contact-maps/)); **the genome browser**, tracks along the genome with
no map, which a tab opens as when its first file is a track
([The genome browser](/browse/genome-browser/)); or **a deck** of cells, panned and zoomed together.

The **+** down the map's right edge or along its bottom opens a column or a row of empty cells, for
a map, a track or a 3D structure; a map dropped on an open map opens beside it too. Each cell has a
grip to swap it, a **star** for the map the Map card sets and analyses run on, and a **chain**, lit
while it follows the others. The deck's bar has **add a cell…**, **match all scales**,
**match all resolutions**, the number of cells across, the deck as one figure and **close deck**
([Maps side by side](/browse/deck/)).

![A deck of three cells on the whole of yeast chromosome IV: a micro-C cooler and a Hi-C .hic side by side, the first starred and with its genes and ATAC lanes, and the yeast model beside them with chromosome IV lit and the rest ghosted, under the deck's bar from add a cell… to close deck.](../../../assets/screens/start/deck.webp)

The pictures keep their light colours in the dark theme, as in a figure.

## The four panels

Open or fold a panel with its header button, its key or the chevron in its heading; folded, it leaves
a strip with its name. General and Aesthetics start open. The keys go by their place on the keyboard,
so they work on any layout.

- **General** (<kbd>1</kbd>, left): the file itself. **File** gives its format, bin size and
  contacts; the ticks on **Sequences** show one chromosome, several against each other, or, with none,
  the whole genome; **Genome minimap** marks the view; **Metadata** holds the rest.
- **Annotations** (<kbd>2</kbd>, left, against the picture): what is drawn on and beside it —
  **Contact maps**, **Tracks** (with **Load a track**; each row sets colour, height, range, style and
  edge), **Structures**, **Manual annotations** (your marks), **Metadata annotations** (the file's own
  columns) and **Bookmarks** ([Annotations and bookmarks](/browse/annotations/)).
- **Aesthetics** (<kbd>3</kbd>, right, against the picture): how it is drawn. **Map** sets the score,
  smoothing, O/E, transform, colours, clip and overlays (in a deck, the starred map's); **Tracks** sets
  how tracks are drawn; **Export** saves a PDF or a PNG ([Figures and export](/browse/figures/)).
- **Analysis** (<kbd>4</kbd>, right): the tasks — **2D tasks** read the map, **3D tasks** model it,
  **1D tasks** read tracks — each with what it answers and its state. A greyed row says what to load;
  hover a row's `?` for the method the task reproduces and how it compared, green where it matched.
  The box above filters the list.

A task's row opens the **Analysis drawer**: settings, **run** (**cancel** while it runs), progress,
results and exports. It is not a dialog: the map stays live, and <kbd>Esc</kbd> or its × puts it away
without stopping the run ([Analyses](/analyses/)).

Drag a panel's inner edge to widen it; double-click the edge to reset it. A card folds by its heading
and drags by it to another place, in its panel or another; *Put every card back in its own panel*
undoes the moves. This browser remembers the layout.

## The Files column

Outermost on the left, the same in every tab, it lists the places you have connected — a folder on
your disk, a bucket, a Google Drive folder, a Dropbox — one level at a time. It appears once you
connect one; its **connect a local or remote folder** button connects more, and the key left of
<kbd>1</kbd> folds it.

A file's **+** adds it to the tab in front, a second button opens it in a tab of its own, and its row
drags onto the map, an edge or a cell. In a browser tab a folder on your disk lasts the visit
(*this visit*); the desktop app and the web app installed from Chrome or Edge keep it
([Web, desktop or one file](/start/where-to-run/)). See [Opening files](/files/opening/).

## The store drawer

The stores' button, or <kbd>\\</kbd>, opens it on the left, over the panels: one catalogue of
published data at a time, switched by the tiles at its top. It stays up while you work;
<kbd>Esc</kbd> or its × puts it away ([Data stores](/files/stores/)).

## The console

It opens along the bottom, from its header button or with <kbd>Ctrl</kbd> and the key left of
<kbd>1</kbd> (<kbd>Ctrl</kbd>+<kbd>&#96;</kbd> on most keyboards, Control on a Mac too). Every file
opened, track loaded, analysis run and file written is a line, as the `chromosomix` command that
repeats it. **copy**, **save** and **clear** act on the whole log; **provenance** prints each run's
full record. The log stays in this browser for a week, or 500 lines, and is never sent anywhere. The
map stays live while it is open; <kbd>Esc</kbd> puts it away ([The console](/browse/console/)).

## The status bar

From the left: the coordinates under the pointer; **read**, how much of the file has been read;
**validation**, a deeper check of the file's stored pixels, **never run** until you press it; and
**memory** and **cpu**, what this tab costs your machine. *read* and *validation* appear only while a
file is open; hover any of them for its detail.
