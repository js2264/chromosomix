---
title: "A tour of the window"
description: "What each part of the chromosomix window is for: the header and its command search, the tabs, the picture and its deck of cells, the four panels and the Files column, the console and the status bar."
---

The window has the same parts whatever you open. From the top: the **header**, the **tabs**, the
**trail** and the **heading** over the picture, the **picture** itself — a contact map, a genome
browser or a deck of cells — with the **panels** either side of it, the **console** along the bottom
when it is open, and the **status bar** at the foot.

<!-- screenshot: the whole window with a map and its tracks open, the General and Aesthetics panels unfolded, each part labelled -->

## The header

From left to right:

- **The brand**, the mark and **chromosomix**. It takes you to the landing page — in a new tab when
  the one in front holds something, so nothing you have open is lost.
- **The stores**, which opens the store drawer (<kbd>\\</kbd>), and **the Files column**, which is
  there only while you have connected a folder (below).
- **The four panels' buttons**: General, Annotations, Aesthetics and Analysis, each folding its
  panel away or bringing it back. A panel with nothing to show for what is open is absent, and so is
  its button.
- **+**, which adds a file to this tab: a second map comes up beside the one open, anything else is
  drawn on it as a track. On an empty tab it opens the file instead. It is the landing page's
  *Load files* box in a dialog, for a file to drop, choose or name by its URL.
- **Back** and **forward**, the browser's own, as buttons. The chevron beside back lists the steps
  behind you, each named as the trail names it, and goes straight to one.
- **Share this tab as a link**, **Save every tab as a file** (<kbd>Ctrl</kbd>+<kbd>S</kbd>,
  <kbd>⌘</kbd><kbd>S</kbd> on a Mac) and **the console** (<kbd>Ctrl</kbd>+<kbd>&#96;</kbd>): the three
  ways to take the work out of the window.
  [Sessions, workspaces and links](/browse/sessions-and-links/) says what the link and the file each
  keep.
- **Search commands…**, the command search (below).
- **About the window**: the theme (<kbd>T</kbd>), the keyboard shortcuts (<kbd>?</kbd>), this
  documentation (the open book), the source on GitHub, and *About this viewer* — what the app is, the guided tutorial, which build you are
  running, the notebooks that check it, and the licences of the projects it is built with.

A button that has a key names it in its tooltip. In a narrow window the header wraps onto two
lines.

### The command search

**Search commands…**, or <kbd>Ctrl</kbd>+<kbd>P</kbd> (<kbd>⌘</kbd><kbd>P</kbd> on a Mac), opens the
command palette: every action in the app, in five groups — App, File, Go, View and Help — each with
its key where it has one. Type a few letters of a command's name and press <kbd>Enter</kbd>. A command
that cannot act on what is open is listed greyed rather than hidden, and a setting that is on or off
wears its state beside its name.

Some things are only in the palette: *Refine on zoom*, which reads a window again at a finer grid when
you zoom past what was read; *Put every card back in its own panel*; and, under Help, *What this
browser is remembering*, the list of everything the app keeps in this browser, with a button that
forgets it all. The shortcuts dialog (<kbd>?</kbd>) prints the same commands, those with a key, and
the gestures on a map and in the genome browser. [Keyboard and command palette](/browse/keyboard/)
has them all.

## Tabs

Under the header, a tab for each file you have open — twelve at most. Each tab is a session of its
own: its file, its tracks, its marks, its settings. Two tabs on the same file share nothing.

- The **+** at the end of the row, or <kbd>O</kbd>, opens a new tab on the landing page.
  <kbd>Ctrl</kbd>+<kbd>&lt;</kbd> and <kbd>Ctrl</kbd>+<kbd>&gt;</kbd> step to the tab beside this one.
- A tab is named after its file. Double-click it, or press <kbd>F2</kbd>, to give it a name of your
  own; empty the box to give it back its file's name.
- Its × closes it, as a middle-click does. The last tab is emptied rather than closed.

The address bar names what the tab in front is showing; for a file on the web, that address is
already a link to the view. Close the browser and the window offers your tabs back next time, with
**restore**; it never reopens them unasked. A bar under the tabs carries what a tab found out about
its file — that a sequence reads as circular, say — until you dismiss it or the tab opens another
file.

## Over the picture: the trail and the heading

**The trail** says where you are and takes you back up: the file — click it to open another file in
its place — then the table or the whole genome, the sequence, and the window. At its far end are two
controls over the whole picture:

- **resolution**, the sizes of bin the file stores: a slider over labelled stops, or a dropdown on a
  file with more than nine. The **+** beside it adds a resolution the file does not store, made by
  adding up its own bins and marked with a `*`. <kbd>-</kbd> and <kbd>+</kbd> step coarser and finer.
- **contacts**, which draws every map in the tab to the number of contacts you type, `10M` say, to
  compare libraries at one depth.

**The heading** names what is on screen: the title, with `‹` and `›` for the previous and next
sequence (<kbd>&lt;</kbd> and <kbd>&gt;</kbd>); the locus box and **go**; two arrows that move the
window half its width; the zoom steps, `10×` and `3×` out, `3×` and `10×` in; and a bookmark of the
view (<kbd>B</kbd>). The line under it counts the bins on screen and says what one of them is
worth, its *effective resolution*: coarser than the file's when the window holds more bins than the
picture has room for. [Moving around](/browse/navigating/) covers all of it.

## The picture, and the deck of cells

A tab shows one of three pictures:

- **A contact map**, with tracks along any of its four edges and marks on it. See
  [Reading a contact map](/browse/contact-maps/).
- **The genome browser**: tracks, sequences and features along the genome, with no map. A tab opens
  as one when its first file is a track rather than a map. See
  [The genome browser](/browse/genome-browser/).
- **A deck**: several cells side by side, panned and zoomed together.

A deck is opened from the map itself. A **+** stands down its right-hand edge and another along its
bottom; each opens a column or a row of empty cells, and an empty cell takes a map, a track or a 3D
structure dropped on it. A contact map dropped on an open map opens beside it in the same way.

Each cell's heading carries a grip, to drag the cell onto another and swap the two; its name; a
**star**, which says whose settings the Map card shows and which map an analysis runs on; and a
**chain**, lit while the cell follows the others' navigation. The deck's own bar, above the grid,
holds **add a cell…** (a map from a file or a URL, the tab's 3D structure, or tracks alone),
**match all scales**, **match all resolutions**, how many cells across, the whole deck as one figure,
and, at its far end, **close deck**. [Maps side by side](/browse/deck/) has the rest.

<!-- screenshot: a deck of three cells — two maps and a 3D structure — with the deck's bar above them -->

The pictures keep their light colours in the dark theme, as they will have in a figure.

## The four panels

Two panels stand either side of the picture. Each is opened and folded by its button in the header,
by its key, or by the chevron in its own heading; a folded panel leaves a narrow strip with its name
on it, which opens it again.

| Panel | Key | Where | What it holds |
| --- | --- | --- | --- |
| **General** | <kbd>1</kbd> | left | the file itself |
| **Annotations** | <kbd>2</kbd> | left, against the picture | what is drawn on and beside it |
| **Aesthetics** | <kbd>3</kbd> | right, against the picture | how it is drawn |
| **Analysis** | <kbd>4</kbd> | right | what can be computed from it |

General and Aesthetics are open when you first arrive; Annotations and Analysis start folded, so a
laptop screen shows a map rather than four columns. The keys are matched by their place on the
keyboard, so they work on any layout.

### General

What the file is. The **File** card has its format, bin size, contacts and the rest; the
**Sequences** card lists its chromosomes, each with a tick — one ticked is that chromosome's map,
several are those chromosomes against each other, none is the whole genome; the **Genome minimap**
draws them with the view on screen marked; and **Metadata** holds whatever else the file stores.

### Annotations

Everything drawn on the picture or beside it, as rows you can work on. **Contact maps** lists the
maps of the tab. **Tracks** holds every track — loaded or computed — with **Load a track** at its top;
each row sets its colour, height, range and style, and four small squares place it on any edge of
the map. **Structures** lists the 3D models. **Manual annotations** holds the marks you draw — lines,
arrowheads and the like — and **Metadata annotations** the file's own columns; **Bookmarks** keeps
places to come back to. See [Annotations and bookmarks](/browse/annotations/).

### Aesthetics

How the picture is drawn. The **Map** card sets the score (counts, balanced and the normalisations),
the smoothing, O/E, the transform, the colours, the clip and the overlays; in a deck it is the
starred map's card, and says so under its title. The **Tracks** card sets how the tracks are drawn,
and **Export** saves the picture as a figure, a PDF or a PNG. See [Figures and export](/browse/figures/).

### Analysis

A list of tasks, in three groups: **2D tasks** read the map, **3D tasks** model it, **1D tasks** read
the tracks. Each row has a line saying what the task answers and its state: *never run*, *queued*,
*running*, *done*, *failed* or *cancelled*. A box over the list filters it by name or by what the task
is for. A row waiting on a file is greyed and says what to load. Hover the `?` at the end of a
row's first line for the published method the task reproduces and how it compared with it; the `?`
is green where it matched.

Pressing a row opens the **Analysis drawer** over the right of the window: the task's settings,
**run** (and **cancel** while it runs), its progress, and its results, with their exports. The drawer
is not a dialog: the map stays live behind it, every key keeps working, and <kbd>Esc</kbd> or its ×
puts it away without stopping the run. See [Analyses](/analyses/).

### Folding, resizing and moving

Drag a panel's inner edge to widen it; double-click that edge to give it back its width. Each card
folds by its heading, and can be dragged by its heading to another place, in its own panel or
another — the Export card next to the Tracks card, say. The palette's *Put every card back in its own
panel* undoes the moves. The panels' folds, widths and arrangement are remembered by this browser.

## The Files column

A fifth column, outermost on the left, lists the places you have connected — a folder on your
disk, a bucket, a Google Drive folder, a Dropbox — one level at a time. It appears once you connect
one, from the landing page or with *Connect a local or remote folder* in the command palette, and
its own **connect a local or remote folder** button connects more. It is the same in every tab. The
key left of <kbd>1</kbd> folds it.

Each file row has two buttons, **+** to add the file to the tab in front and a second to open it in
a tab of its own, and a row can be dragged onto the map, onto one of its edges or onto a cell. A
folder on your disk connected in a browser tab lasts the visit, and its row says *this visit*; the
desktop app, and the web app installed from Chrome or Edge, keep it across restarts
([Web, desktop or one file](/start/where-to-run/)). See [Opening files](/files/opening/).

## The store drawer

The stores' button in the header, or <kbd>\\</kbd>, opens the store drawer down the left of the
window, over the panels: one catalogue of published data at a time — the lab's figures, IGV's
genomes, 4DN, ENCODE, DNA Zoo, Roadmap, UCSC track hubs and any store you added — with a row of
small tiles at its top to switch between them. It stays up while you work beside it, and
<kbd>Esc</kbd> or its × puts it away. See [Data stores](/files/stores/).

## The console

The console opens along the bottom of the window, from its button in the header or with
<kbd>Ctrl</kbd> and the key left of <kbd>1</kbd> (<kbd>Ctrl</kbd>+<kbd>&#96;</kbd> on most keyboards,
Control on a Mac too). Every file opened, track loaded, analysis run and file written is a line in
it, as the `chromosomix` command that repeats it, grouped by day. **copy**, **save** and **clear** act
on the whole log, and **provenance** prints each run's full record above it.

The log is kept for a week, or five hundred lines, in this browser, and never sent anywhere. Like the
drawer, the console is not a dialog: the map behind it stays live, and <kbd>Esc</kbd> puts it away.
See [The console](/browse/console/).

## The status bar

At the foot of the window, from the left:

- the coordinates under the pointer, on the map or on a track;
- **read**, how much of the file has been read, with the requests behind it on hover;
- **validation**, a deeper check of the file's stored pixels, which says **never run** until you
  press it;
- **memory** and **cpu**, what this tab is costing your machine.

*read* and *validation* are there only while a file is open. Hover any of them for its detail.
