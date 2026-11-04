---
title: "Keyboard and command palette"
description: "The command palette that runs every action in chromosomix by name, and every keyboard shortcut, grouped as the app's own shortcuts dialog lists them."
---

Every action in chromosomix is a command with a name, and most of the ones you reach for often have
a key. The command palette lists all of them and the shortcuts dialog lists every key. Both are
printed from the same list inside the app, so this page follows them.

## The command palette

Press <kbd>Ctrl</kbd>+<kbd>P</kbd> (<kbd>⌘</kbd><kbd>P</kbd> on a Mac), or click **Search
commands…** in the middle of the header. The palette works from a box being typed into as well.

It lists every command, grouped as **App**, **File**, **Go**, **View** and **Help**, with a 3D model's
commands under **Structure**. Each row has the command's name, a line saying what it does, and its
key where it has one. A command that cannot act right now is greyed rather than hidden, so the list
keeps its shape as you move around. A command that switches something on and off is listed once, by
its name, with `on` or `off` beside it, such as **Crosshair** `on`.

- **Type** to narrow the list. A name that starts with what you typed comes first, then one that
  contains it, then one whose letters appear in that order, the closest together first: `wg` finds
  **Whole genome**.
- **Start with a group's name** to search within it: `view` lists the View group's commands, and
  `file copy` finds **Copy this plot to the clipboard**.
- Use <kbd>↑</kbd> and <kbd>↓</kbd> to choose, <kbd>Enter</kbd> or a click to run, and
  <kbd>Esc</kbd> to close.

Some commands have no key and are reached only from the palette, or from a button:

| Group | Commands with no key |
| --- | --- |
| File | **Add a file to this tab**, **Connect a local or remote folder** (**Connect a folder** in the single-file version), **Open a different file**, **Close this tab**, **Share this tab as a link**, **Add a map beside this one**, and in the 1D browser **Open a contact map on this genome** |
| View | **Shrink the tracks to the shortest of them**, **Legend**, **Refine on zoom**, **Put every card back in its own panel** |
| Help | **What this browser is remembering**, **Guided tutorial** (not in the single-file version), **About this viewer**, **Documentation**, **Source on GitHub** |
| Structure | **Mark a bead**, **Mark a loop**, **Measure** |

## The shortcuts dialog

Press <kbd>?</kbd>, or the keyboard button at the right of the header, for **Keyboard shortcuts**.
It lists every command that has a key, in the palette's groups and order, with the keys written the
way your computer writes them. A key that cannot act now is greyed, as in the palette. Under the keys
are two tables of what the mouse and the keys do on the pictures themselves: **On a contact map** and
**On the genome browser**.

The dialog is printed from the tab in front. A map's tab lists the map's keys and the 1D browser
lists its own, so a few rows below differ between the two.

## How keys are read

- **Ctrl and ⌘.** The palette, saving and copying use <kbd>Ctrl</kbd> on Windows and Linux and
  <kbd>⌘</kbd> on a Mac. Moving between tabs and opening the console use Control on every computer,
  a Mac included.
- **Letters** work whatever their case, and with Caps Lock on.
- **`−` `+` `<` `>`** are read by the character they type, from either half of their key. On an
  English keyboard `,` and `.` step between sequences without Shift, and `=` and `_` change the
  resolution.
- **The digits and the key left of 1** are read by where they are. On a French keyboard the bare
  `&` `é` `"` `'` keys are <kbd>1</kbd> to <kbd>4</kbd>, and the keypad's digits work too.
- **A bare key never acts with Ctrl, ⌘ or Alt held**, AltGr included, so nothing is taken from your
  browser or your keyboard's third level.
- **While you type in a box**, keys type. Only the chords with Ctrl or ⌘ still act: the palette,
  saving, moving between tabs and the console.
- **Ctrl+C and Space give way.** With text selected or the caret in a box, <kbd>Ctrl</kbd>+<kbd>C</kbd>
  copies the text. Space presses a focused button or tickbox rather than locking the diagonal.

A key is also printed in the tooltip of the button that does the same thing.

## Every key

The tables follow the shortcuts dialog: its groups, its order, and each command's name as the app
writes it. ⌘ is for a Mac, Ctrl for everything else.

### App

| Key | Command | What it does |
| --- | --- | --- |
| <kbd>Ctrl</kbd>+<kbd>P</kbd> / <kbd>⌘</kbd><kbd>P</kbd> | **Search commands** | Opens the command palette |
| <kbd>?</kbd> | **Keyboard shortcuts** | Opens the shortcuts dialog |

### File

| Key | Command | What it does |
| --- | --- | --- |
| <kbd>&#92;</kbd> | **Stores** | Every data store this viewer ships with, and any you connected, as a drawer down the left. Not in the single-file version |
| <kbd>O</kbd> | **New tab** | Another tab, with its own file, tracks and settings |
| <kbd>Ctrl</kbd>+<kbd>S</kbd> / <kbd>⌘</kbd><kbd>S</kbd> | **Save every tab as a file** | Every tab, its tracks and its settings, as one file you can drop back on the page |
| <kbd>F2</kbd> | **Rename this tab** | Name the tab for its condition or its figure; the name travels with the link |
| <kbd>S</kbd> | **Save this plot as a figure** | The Export card decides the format and the resolution; this is its button |
| <kbd>Ctrl</kbd>+<kbd>C</kbd> / <kbd>⌘</kbd><kbd>C</kbd> | **Copy this plot to the clipboard** | The figure as a PNG, at the Export card's resolution, ready to paste. With maps side by side it is **Copy the deck to the clipboard**: every panel as one PNG, laid out as on screen |

### Go

| Key | Command | What it does |
| --- | --- | --- |
| <kbd>Ctrl</kbd>+<kbd>&gt;</kbd> | **Next tab** | The tab after this one |
| <kbd>Ctrl</kbd>+<kbd>&lt;</kbd> | **Previous tab** | The tab before this one |
| <kbd>/</kbd> | **Find** | Puts the caret in the view's one box: the region box on a map, the filter above a table, the locus box in the 1D browser, which also takes a gene name |
| <kbd>G</kbd> | **Cells table** | An `.scool`'s table of cells. Only for an `.scool` |
| <kbd>C</kbd> | **Chromosomes table** | The file's table of sequences. On a map |
| <kbd>W</kbd> | **Whole genome** | On a map, every sequence against every other: one bounded read, which asks first when the block is large. In the 1D browser, every sequence end to end |
| <kbd>&lt;</kbd> | **Previous sequence** | The sequence before this one, in the file's order. The palette names it |
| <kbd>&gt;</kbd> | **Next sequence** | The sequence after this one |
| <kbd>B</kbd> | **Bookmark this view** | The place on screen, at this resolution, kept on the Bookmarks card. On a map |

### View

| Key | Command | What it does |
| --- | --- | --- |
| <kbd>V</kbd> | **Read this genome as tracks** | Takes the matrix out of the picture and lays its chromosomes end to end; the map stays open, and the same key comes back to it. It then reads **The map and its tracks**, and in a 1D browser with a map behind it, **The contact map on its own** |
| <kbd>H</kbd> | **Stretch the tracks to fill the height** | One height for every track, the one that fills the space |
| <kbd>Y</kbd> | **Autoscale every track** | Hand every value axis back to what is in view; a group resolves as a group |
| <kbd>Space</kbd> | **Diagonal lock** | The view slid onto the diagonal and held there, every drag, scroll and box running along it, until the same key lets go. On a map |
| <kbd>0</kbd> | **Fit the view** | On a map, every pan and zoom undone, the block back to its canvas, as a double click on the plot does. In the 1D browser, the whole genome across |
| <kbd>E</kbd> | **Observed over expected** | Every cell divided by what its distance from the diagonal predicts: the O/E toggle on the Map card. On a map |
| <kbd>−</kbd> | **Coarser resolution** | One rung coarser on the resolution bar. On a map |
| <kbd>+</kbd> | **Finer resolution** | One rung finer on the resolution bar. On a map |
| <kbd>A</kbd> | **Manual annotations** | Every line, arrowhead and rectangle drawn by hand, on every map, track and model. Off hides them; on brings back the ones it hid |
| <kbd>N</kbd> | **Track text** | Track names, their value ranges and feature names. Off leaves the ink only |
| <kbd>R</kbd> | **Track floor** | A rule along the bottom edge of every track lane |
| <kbd>F</kbd> | **Track fill** | The area under a track's line, filled. Off leaves the line alone |
| <kbd>I</kbd> | **Track outline** | A dark rule along the top of every track and round every feature's box |
| <kbd>U</kbd> | **Name column** | Track names beside the tracks rather than over them: in a column before them, or in the map's corners |
| <kbd>X</kbd> | **Crosshair** | Guide lines through the cell under the pointer |
| <kbd>P</kbd> | **Tooltip** | The card that follows the pointer. Off, the same reading stays in the status line under the window |
| <kbd>D</kbd> | **Dividers** | Sequence boundaries, drawn as lines across the map |
| <kbd>M</kbd> | **Breaks** | The same boundaries as ticks outside the plot, where they cost no data |
| <kbd>L</kbd> | **Labels** | Block names in the gutters. Off gives the gutters back to the plot |
| <kbd>K</kbd> | **Ticks** | Base-pair coordinates along the axes, inside a block that has a single contig |
| <kbd>1</kbd> | **General panel** | A reference card about the open file: what it is, its genome, its metadata |
| the key left of <kbd>1</kbd> | **Files panel** | The folders you have connected, and what is in them |
| <kbd>2</kbd> | **Annotations panel** | The tracks, structures, marks and bookmarks on this file |
| <kbd>3</kbd> | **Aesthetics panel** | How the picture is drawn: colours, scales, overlays, export |
| <kbd>4</kbd> | **Analysis panel** | What can be computed from this file, as against what is drawn on it |
| <kbd>Ctrl</kbd>+<kbd>backtick</kbd> | **Console** | Every run, open and export this window has made, as commands that repeat them |
| <kbd>T</kbd> | **Cycle the theme** | System follows the machine; every press changes what is on screen |

The Help group has no keys.

### In an enlarged 3D model

These keys act only while a 3D model is enlarged, where the model fills the window. Beside a map
the same letters keep their meanings above. The palette lists these commands under **Structure**
either way, and the buttons that do the same print the key only while it is bound.

| Key | Command |
| --- | --- |
| <kbd>F</kbd> | **Frame what the maps are looking at** |
| <kbd>A</kbd> | **Show the whole model** |
| <kbd>1</kbd> | **Beads** |
| <kbd>2</kbd> | **Sticks** |
| <kbd>3</kbd> | **Tube** |
| <kbd>L</kbd> | **Sequence names** |
| <kbd>R</kbd> | **Turntable**: the model turns slowly by itself |

**Mark a bead**, **Mark a loop** and **Measure** have no key, so a letter pressed by accident cannot
arm them.

### On a contact map

| Gesture | What it does |
| --- | --- |
| drag | Pan |
| <kbd>Alt</kbd> + drag (<kbd>⌥</kbd> on a Mac) | Select a square and open it as a region, on the diagonal while it is locked |
| <kbd>Shift</kbd> + <kbd>Alt</kbd> + drag | The same, pinned to the diagonal from the nearest bin on it |
| <kbd>Shift</kbd> + drag | Zoom to the stretch it spans, on the diagonal, and copy its locus |
| double click | Fit the block back to the canvas |
| wheel | Zoom about the pointer |
| two fingers sideways | Slide sideways, down the diagonal while it is locked (Space) |
| <kbd>Win</kbd> + wheel (<kbd>⌘</kbd> on a Mac) | Slide the map up and down, and sideways with it |
| click | Open what the cell refers to |
| <kbd>←</kbd> <kbd>↑</kbd> <kbd>→</kbd> <kbd>↓</kbd> | Pan by a tenth of the view (half a view with Shift) |
| <kbd>Page Up</kbd> / <kbd>Page Down</kbd> | Zoom in and out about the centre |
| <kbd>Home</kbd> | Fit the block to the canvas |
| drag a lane's far edge | Make that track thicker or thinner |
| drag across a lane | Raise or lower that track's ceiling |
| drag a lane's grip | Reorder it; drop it on a rectangle round this map or another to move it there, on a + or an empty cell to give it a cell of its own, or on a tracks cell to draw it there |
| drag a track's row from the panel | Reorder it, or drop it on a rectangle round any map, a + or an empty cell to draw it there |
| click a lane | Open that track's settings |
| click a feature in a lane | Open its card: names, attributes, exons |
| drop a file on an edge of the map | Load it as a track on that edge |

### On the genome browser

| Gesture | What it does |
| --- | --- |
| drag | Pan along the genome |
| drag on the chromosome bar | Select a span, with both ends written out to the base |
| <kbd>Alt</kbd> + drag (<kbd>⌥</kbd> on a Mac) | The same selection, over the tracks |
| drag a track's lower edge | Make that track taller or shorter |
| drag the bar under the tracks | Make every track taller or shorter, each in proportion |
| drag a track's grip | Move it up or down the stack |
| double click | The whole genome |
| wheel | Zoom about the pointer |
| <kbd>Alt</kbd> + wheel over a track (<kbd>⌘</kbd> on a Mac) | Raise or lower that track's ceiling |
| click a chromosome's name | Go to that chromosome |
| click a feature | Open its card: names, attributes, exons, and a zoom |
| click a track's range | Type a limit |
| drop a file on the tracks | Load it; a .cool opens the map on this genome |
| <kbd>←</kbd> <kbd>→</kbd> | Pan by a fifth of the window |
| <kbd>+</kbd> / <kbd>−</kbd> | Zoom about the centre |

## Folding the panels

The digit row folds and opens the side columns, in the order they stand on screen:

| Key | Column |
| --- | --- |
| the key left of <kbd>1</kbd> | **Files**, outermost on the left |
| <kbd>1</kbd> | **General** |
| <kbd>2</kbd> | **Annotations** |
| <kbd>3</kbd> | **Aesthetics** |
| <kbd>4</kbd> | **Analysis**, outermost on the right |

So <kbd>4</kbd> folds the Analysis panel away and brings it back, and <kbd>0</kbd>, at the row's
other end, refits the picture. Each column wears its key beside its heading and on its folded tab.

The key left of <kbd>1</kbd> is a backtick on an English keyboard, `²` on a French PC and `@` on a
French Mac. Its badge prints what your keyboard has there, and its tooltips say *the key left of 1*.
The Files column only exists once you have connected a folder, so its key does nothing until then.
The Annotations and Analysis columns start folded.

Cards move too. Drag a card by its heading into any open column, and press Escape during the drag to
put it back. With the focus on a card's heading, <kbd>Alt</kbd>+<kbd>↑</kbd> and
<kbd>Alt</kbd>+<kbd>↓</kbd> (<kbd>⌥</kbd><kbd>↑</kbd> and <kbd>⌥</kbd><kbd>↓</kbd>) move it one place.
**Put every card back in its own panel**, in the palette, undoes every move.

## Tab walks the fields of one kind

Many names and numbers are edited where they are drawn, and they come in runs: the names of four
replicates, the ceilings of six tracks. In such a field, <kbd>Tab</kbd> keeps what you typed, as
Enter does, and moves the caret to the next field of the same kind. <kbd>Shift</kbd>+<kbd>Tab</kbd>
moves to the one before. Past either end of the run the caret is let go.

The fields that walk this way are:

- a track's name, and the two ends of its range, beside a map and in the 1D browser;
- the two ends of a map's colour key, and of a 3D model's key;
- a tab's name;
- the heading of a cell of the deck, and a name on the **Tracks**, **Metadata annotations**,
  **Structures** or **Contact maps** card;
- the place of a mark on the **Manual annotations** card.

A run goes the way your eye does. Beside a map it goes through the tracks under the map first, then
round the map clockwise: the tracks on its left, those above it, those on its right, each in the
order they are drawn. In the 1D browser it goes down the tracks. On a deck it goes from cell to cell
as they stand on the page. A range goes from its bottom to its top, and then on to the next track's
bottom.

A value that is refused keeps the caret. A bound you only tab through, without changing it, stays
automatic. Only a bare Tab walks: <kbd>Ctrl</kbd>+<kbd>Tab</kbd> is still your browser's.

## Other keys

- **A tab's name**: <kbd>F2</kbd> or a double-click to rename, <kbd>Enter</kbd> to keep the name,
  <kbd>Esc</kbd> to abandon it.
- **Dialogs** close with <kbd>Esc</kbd>, and so do the Analysis drawer, the stores drawer and the
  [console](/browse/console/).
- **Placing marks**: <kbd>Esc</kbd> stops placing them, as **done** does, and <kbd>Shift</kbd> while
  drawing a rectangle locks it to the diagonal. See [Annotations and bookmarks](/browse/annotations/).
- **A 3D model**: drag to turn, scroll to zoom, <kbd>Shift</kbd> and drag to move it,
  <kbd>⌘</kbd> or <kbd>Ctrl</kbd> and a click on a bead to turn about it, a tap of <kbd>⌘</kbd> or
  <kbd>Ctrl</kbd> alone to show or hide the centre, <kbd>Space</kbd> and scroll for the fog, the
  arrow keys to turn it once its canvas has the focus, and <kbd>Esc</kbd> to let go of a half-made
  loop or measurement. The cell's corner lists these. See
  [3D models beside the map](/browse/structures/).
- **A task's figure**: the wheel, a drag, <kbd>Shift</kbd> and the wheel, and <kbd>⌘</kbd> or
  <kbd>Ctrl</kbd> with a drag zoom and pan it. See [Figures and export](/browse/figures/).
