---
title: "Keyboard and command palette"
description: "The command palette, which runs every action in chromosomix by name, and every keyboard shortcut, grouped as the app's own shortcuts dialog lists them."
---

Every action in chromosomix is a command with a name, and the ones you reach for often have a key.
The command palette lists every command; the shortcuts dialog lists every key.

## The command palette

Press <kbd>Ctrl</kbd>+<kbd>P</kbd> (<kbd>⌘</kbd><kbd>P</kbd> on a Mac), even from a box you are typing
in, or click **Search commands…** in the header.

It lists every command, with what it does and its key, grouped as **App**, **File**, **Go**, **View**
and **Help**, and **Structure** for a 3D model. A command that cannot act right now is greyed, not
hidden. A switch is listed once, with `on` or `off` beside it, such as **Crosshair** `on`.

- **Type** to narrow the list, best matches first; letters in order are enough, so `wg` finds
  **Whole genome**.
- **Start with a group's name** to search within it: `file copy` finds
  **Copy this plot to the clipboard**.
- <kbd>↑</kbd> and <kbd>↓</kbd> choose, <kbd>Enter</kbd> or a click runs, and <kbd>Esc</kbd> closes.

Some commands have no key:

| Group | Commands with no key |
| --- | --- |
| File | **Add a file to this tab**, **Connect a local or remote folder** (**Connect a folder** in the single-file version), **Open a different file**, **Close this tab**, **Share this tab as a link**, **Add a map beside this one**, and in the 1D browser **Open a contact map on this genome** |
| View | **Shrink the tracks to the shortest of them**, **Legend**, **Refine on zoom**, **Put every card back in its own panel** |
| Help | **What this browser is remembering**, **Guided tutorial** (not in the single-file version), **About this viewer**, **Documentation**, **Source on GitHub** |
| Structure | **Mark a bead**, **Mark a loop**, **Measure** |

## The shortcuts dialog

Press <kbd>?</kbd>, or the keyboard button at the right of the header, for **Keyboard shortcuts**:
every key, in the palette's groups, as your computer writes it, then what the mouse and keys do
**On a contact map** and **On the genome browser**. It follows the tab in front, so a map and the 1D
browser list a few keys differently.

## How keys are read

- **Ctrl and ⌘.** The palette, saving and copying use <kbd>Ctrl</kbd> on Windows and Linux and
  <kbd>⌘</kbd> on a Mac. Moving between tabs and opening the console use Control everywhere, a Mac
  included.
- **Letters** work whatever their case, and with Caps Lock on.
- **`−` `+` `<` `>`** are read by the character they type, from either half of their key: on an
  English keyboard `,` and `.` step between sequences without Shift, and `=` and `_` change the
  resolution.
- **The digits and the key left of 1** are read by where they are. On a French keyboard the bare
  `&` `é` `"` `'` keys are <kbd>1</kbd> to <kbd>4</kbd>, and the keypad's digits work too.
- **A bare key never acts with Ctrl, ⌘ or Alt held**, AltGr included.
- **While you type in a box**, keys type. Only the chords with Ctrl or ⌘ still act: the palette,
  saving, moving between tabs and the console.
- **Ctrl+C and Space give way.** With text selected or the caret in a box, <kbd>Ctrl</kbd>+<kbd>C</kbd>
  copies the text. Space presses a focused button or tickbox rather than locking the diagonal.

A button's tooltip also prints the key that does the same.

## Every key

In the dialog's order and wording. ⌘ is for a Mac, Ctrl for everything else.

### App

| Key | Command | What it does |
| --- | --- | --- |
| <kbd>Ctrl</kbd>+<kbd>P</kbd> / <kbd>⌘</kbd><kbd>P</kbd> | **Search commands** | Opens the command palette |
| <kbd>?</kbd> | **Keyboard shortcuts** | Opens the shortcuts dialog |

### File

| Key | Command | What it does |
| --- | --- | --- |
| <kbd>&#92;</kbd> | **Stores** | The data stores, as a drawer down the left. Not in the single-file version |
| <kbd>O</kbd> | **New tab** | Another tab, with its own file and settings |
| <kbd>Ctrl</kbd>+<kbd>S</kbd> / <kbd>⌘</kbd><kbd>S</kbd> | **Save every tab as a file** | One file to drop back on the page |
| <kbd>F2</kbd> | **Rename this tab** | The name travels with the link |
| <kbd>S</kbd> | **Save this plot as a figure** | The Export card's button, in its format and resolution |
| <kbd>Ctrl</kbd>+<kbd>C</kbd> / <kbd>⌘</kbd><kbd>C</kbd> | **Copy this plot to the clipboard** | A PNG at the Export card's resolution. With maps side by side, **Copy the deck to the clipboard**: every panel as one PNG |

### Go

| Key | Command | What it does |
| --- | --- | --- |
| <kbd>Ctrl</kbd>+<kbd>&gt;</kbd> | **Next tab** | The tab after this one |
| <kbd>Ctrl</kbd>+<kbd>&lt;</kbd> | **Previous tab** | The tab before this one |
| <kbd>/</kbd> | **Find** | The caret in the region box on a map, the filter above a table, or the 1D browser's locus box, which takes a gene name too |
| <kbd>G</kbd> | **Cells table** | An `.scool`'s table of cells |
| <kbd>C</kbd> | **Chromosomes table** | The file's table of sequences. On a map |
| <kbd>W</kbd> | **Whole genome** | On a map, every sequence against every other, asking first when the block is large. In the 1D browser, every sequence end to end |
| <kbd>&lt;</kbd> | **Previous sequence** | The sequence before this one, in the file's order. The palette names it |
| <kbd>&gt;</kbd> | **Next sequence** | The sequence after this one |
| <kbd>B</kbd> | **Bookmark this view** | The place and resolution, on the Bookmarks card. On a map |

### View

| Key | Command | What it does |
| --- | --- | --- |
| <kbd>V</kbd> | **Read this genome as tracks** | The chromosomes end to end, the map kept open. The same key, then named **The map and its tracks** (or, in a 1D browser with a map behind it, **The contact map on its own**), goes back |
| <kbd>H</kbd> | **Stretch the tracks to fill the height** | One height for every track, filling the space |
| <kbd>Y</kbd> | **Autoscale every track** | Every value axis back to what is in view; a group as a group |
| <kbd>Space</kbd> | **Diagonal lock** | Every drag, scroll and box runs along the diagonal until pressed again. On a map |
| <kbd>0</kbd> | **Fit the view** | On a map, every pan and zoom undone, as a double click does. In the 1D browser, the whole genome |
| <kbd>E</kbd> | **Observed over expected** | Each cell over what its distance from the diagonal predicts: the Map card's O/E toggle. On a map |
| <kbd>−</kbd> | **Coarser resolution** | One rung on the resolution bar. On a map |
| <kbd>+</kbd> | **Finer resolution** | One rung on the resolution bar. On a map |
| <kbd>A</kbd> | **Manual annotations** | Your hand-drawn marks, on every map, track and model; on brings back the ones it hid |
| <kbd>N</kbd> | **Track text** | Track names, value ranges and feature names |
| <kbd>R</kbd> | **Track floor** | A rule along the bottom of every track lane |
| <kbd>F</kbd> | **Track fill** | The area under a track's line, filled |
| <kbd>I</kbd> | **Track outline** | A dark rule along the top of every track and round every feature's box |
| <kbd>U</kbd> | **Name column** | Track names beside the tracks, in a column or the map's corners, rather than over them |
| <kbd>X</kbd> | **Crosshair** | Guide lines through the cell under the pointer |
| <kbd>P</kbd> | **Tooltip** | The card that follows the pointer; the status line reads out either way |
| <kbd>D</kbd> | **Dividers** | Sequence boundaries, as lines across the map |
| <kbd>M</kbd> | **Breaks** | The same boundaries as ticks outside the plot |
| <kbd>L</kbd> | **Labels** | Block names in the gutters |
| <kbd>K</kbd> | **Ticks** | Base-pair coordinates along the axes, inside a block with a single contig |
| <kbd>1</kbd> | **General panel** | What the open file is, its genome, its metadata |
| the key left of <kbd>1</kbd> | **Files panel** | The folders you connected |
| <kbd>2</kbd> | **Annotations panel** | The tracks, structures, marks and bookmarks on this file |
| <kbd>3</kbd> | **Aesthetics panel** | How the picture is drawn: colours, scales, overlays, export |
| <kbd>4</kbd> | **Analysis panel** | What can be computed from this file |
| <kbd>Ctrl</kbd>+<kbd>backtick</kbd> | **Console** | Every run, open and export of this window, as commands that repeat them |
| <kbd>T</kbd> | **Cycle the theme** | System follows the machine; every press changes what is on screen |

### In an enlarged 3D model

Only while a 3D model is enlarged; elsewhere these letters keep the meanings above.

| Key | Command |
| --- | --- |
| <kbd>F</kbd> | **Frame what the maps are looking at** |
| <kbd>A</kbd> | **Show the whole model** |
| <kbd>1</kbd> | **Beads** |
| <kbd>2</kbd> | **Sticks** |
| <kbd>3</kbd> | **Tube** |
| <kbd>L</kbd> | **Sequence names** |
| <kbd>R</kbd> | **Turntable**: the model turns slowly by itself |

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
| drag a lane's far edge | Resize that track |
| drag across a lane | Raise or lower that track's ceiling |
| drag a lane's grip | Reorder it, or drop it round this map or another, on a + or an empty cell for a cell of its own, or on a tracks cell |
| drag a track's row from the panel | Reorder it, or drop it round any map, on a + or an empty cell |
| click a lane | Open that track's settings |
| click a feature in a lane | Open its card: names, attributes, exons |
| drop a file on an edge of the map | Load it as a track on that edge |

### On the genome browser

| Gesture | What it does |
| --- | --- |
| drag | Pan along the genome |
| drag on the chromosome bar | Select a span, both ends written out to the base |
| <kbd>Alt</kbd> + drag (<kbd>⌥</kbd> on a Mac) | The same selection, over the tracks |
| drag a track's lower edge | Make that track taller or shorter |
| drag the bar under the tracks | Make every track taller or shorter, in proportion |
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

The digit row folds and opens the side columns, in the order they stand: the key left of
<kbd>1</kbd> for **Files**, outermost on the left, then <kbd>1</kbd> **General**, <kbd>2</kbd>
**Annotations**, <kbd>3</kbd> **Aesthetics** and <kbd>4</kbd> **Analysis**, outermost on the right.
The key left of <kbd>1</kbd> is a backtick on an English keyboard, `²` on a French PC and `@` on a
French Mac. The Files column exists only once you have connected a folder; the Annotations and
Analysis columns start folded.

Drag a card by its heading into any open column; Escape during the drag puts it back. With the focus
on a card's heading, <kbd>Alt</kbd>+<kbd>↑</kbd> and <kbd>Alt</kbd>+<kbd>↓</kbd>
(<kbd>⌥</kbd><kbd>↑</kbd> and <kbd>⌥</kbd><kbd>↓</kbd>) move it one place.
**Put every card back in its own panel**, in the palette, undoes every move.

## Tab walks the fields of one kind

In a name or number edited where it is drawn, <kbd>Tab</kbd> keeps what you typed, as Enter does, and
moves to the next field of the same kind; <kbd>Shift</kbd>+<kbd>Tab</kbd> moves to the one before.
Past either end of the run, the caret is let go. It walks:

- a track's name, and the two ends of its range, beside a map and in the 1D browser;
- the two ends of a map's colour key, and of a 3D model's key;
- a tab's name;
- the heading of a cell of the deck, and a name on the **Tracks**, **Metadata annotations**,
  **Structures** or **Contact maps** card;
- the place of a mark on the **Manual annotations** card.

Beside a map, a run goes through the tracks under it, then clockwise round it; in the 1D browser,
down the tracks; on a deck, cell by cell as they stand. A range goes from its bottom to its top, then
to the next track's bottom.

A refused value keeps the caret. A bound you only tab through stays automatic. Only a bare Tab walks:
<kbd>Ctrl</kbd>+<kbd>Tab</kbd> is still your browser's.

## Other keys

- **A tab's name**: <kbd>F2</kbd> or a double-click to rename, <kbd>Enter</kbd> to keep the name,
  <kbd>Esc</kbd> to abandon it.
- **Dialogs** close with <kbd>Esc</kbd>, and so do the Analysis drawer, the stores drawer and the
  [console](/browse/console/).
- **Placing marks**: <kbd>Esc</kbd> stops placing them, as **done** does, and <kbd>Shift</kbd> while
  drawing a rectangle locks it to the diagonal ([Annotations and bookmarks](/browse/annotations/)).
- **A 3D model**: drag to turn, scroll to zoom, <kbd>Shift</kbd> and drag to move it, <kbd>⌘</kbd> or
  <kbd>Ctrl</kbd> and a click on a bead to turn about it (a tap alone shows or hides the centre),
  <kbd>Space</kbd> and scroll for the fog, the arrow keys to turn it once its canvas has the focus, and
  <kbd>Esc</kbd> to let go of a half-made loop or measurement
  ([3D models beside the map](/browse/structures/)).
- **A task's figure**: the wheel, a drag, <kbd>Shift</kbd> and the wheel, and <kbd>⌘</kbd> or
  <kbd>Ctrl</kbd> with a drag zoom and pan it ([Figures and export](/browse/figures/)).
