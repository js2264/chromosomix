---
title: "Moving around"
description: "Pan and zoom a map, type a locus, go to a sequence or a gene, and step back to where you were."
---

There are two ways to move. Dragging and scrolling move the **picture**: the block of the map that
was read is drawn larger, smaller or further along, at no cost and without touching the address. The
locus box, the zoom buttons beside it, the crumbs and the keys that step from one sequence to the
next change the **range**: they read a new block, the address follows, and the back button undoes
each of them. The [genome browser](/browse/genome-browser/) works the same way along one axis.

## Pan and zoom

- **Drag** to pan.
- **Scroll** up or down to zoom about the pointer, or pinch on a trackpad.
- **Scroll sideways** (two fingers across a trackpad) to slide along the map, by its columns. On a
  Mac, hold <kbd>⌘</kbd> and two fingers move the map in any direction.
- **Double-click** to undo every pan and zoom. <kbd>0</kbd> does the same from anywhere in the
  window, and so does the first button of the **picture** row on the **Map** card, in the
  **Aesthetics** panel.

On a touch screen one finger pans, two fingers pinch, a tap opens what it lands on and a double tap
refits.

The drag and the wheel stop at the edges of the block that was read. To see past them, change the
range: type a wider window, press a zoom-out step, or click a cell (below).

![A Micro-C map of yeast chromosome IV from 1.0 to 1.4 Mb with the pointer over it, and under the key in its top-right corner the lines "⌥ + drag to zoom into a region", "⇧ + ⌥ + drag to zoom along the diagonal" and "click to see the whole of IV".](../../../assets/screens/browse/navigating-zoom-hint.webp)

## Zoom into a region

Hold <kbd>⌥ Option</kbd> (<kbd>Alt</kbd> on Windows and Linux) and drag a box across the map. A box
on the diagonal opens as a window of its own; one off the diagonal opens the block between its two
stretches, rows against columns. Add <kbd>Shift</kbd> to hold the box square on the diagonal.

Hold <kbd>Shift</kbd> alone and drag along either axis to zoom the picture to that stretch, on the
diagonal, wherever the map had been panned to. While <kbd>Shift</kbd> is down the readout and the
crosshair snap onto the diagonal, so you can see the stretch before you drag.

Both gestures also copy what they framed, counted from 1 and without separators, so it pastes
straight into samtools, bedtools, IGV or a locus box: `chrIV:500001-510000` for a stretch, and
`chrI:1-10000|chrII:40001-50000`, rows then columns, for a box. While the pointer is over the map, a
line under the key in its corner says what a drag will do.

A click is a way out as well as in. On a window of one sequence, a click on any cell opens the whole
of that sequence; the corner says so (*click to see the whole of IV*). On the whole genome, a click
opens the chromosome under the pointer, or, off the diagonal, the block between two chromosomes.

## Stay on the diagonal

Most of a contact map's signal lies along its diagonal. Press <kbd>Space</kbd>, or the diagonal
button in the **picture** row of the **Map** card, to slide the view onto the diagonal and hold it
there: a drag keeps to the line, the wheel zooms about the point of the diagonal nearest the pointer,
the arrow keys walk along it, a sideways scroll slides down it, and an <kbd>⌥ Option</kbd>-drag box
stays on it. Press again to let go.

The lock stays on as you move from one sequence to the next, holds every map of a
[deck](/browse/deck/) at once, and is remembered by this browser. It is greyed on a block the
diagonal does not cross, and on a [turned map](/browse/turn/), whose diagonal is already its bottom
edge.

## Type a place

The heading over a map names the window on screen, and the box beside it holds the same place in the
form IGV, UCSC and papers print it: `IV:1,000,001-1,400,000`, counting from 1, both ends included.
Type a place and press <kbd>Enter</kbd> or **go**; <kbd>/</kbd> puts the caret in the box from
anywhere in the window. Pressing <kbd>Enter</kbd> on what the box already shows changes nothing, so a
coordinate copied off the heading, the readout or another browser lands on the bases it names.

| Type | To open |
|---|---|
| `IV` | the whole sequence |
| `IV:1,000,001-1,400,000` | that window; the commas are optional, and `IV:1.2Mb-1.4Mb`, an en dash and Ensembl's `IV:1000001..1400000` are read too |
| `I:1-200,000 × II:1-200,000` | the block between two windows, rows then columns |
| a gene's name or accession | that gene, from the starred feature set (below) |
| a band, such as `Xq28` | that band, from a cytoBand you have loaded |

Between two windows, an `x` with a space either side, a `|`, or simply a space before the second
name works as well as `×`. A sequence may be written the way another tool spells it — `chr1` for a file
that says `1` — and is still found. A name the file does not have is refused, with the names of the
sequences it does have.

### Go to a gene

Load a gene model, or any set of named features, and the box searches it as you type, by name or by
accession, listing up to ten matches: a gene named exactly as you typed it first, then the genes whose
names begin so. Each match shows the feature's own span. Picking one frames the gene with a quarter of
its length either side, and a hundred bins either side of that are read as well, so zooming out finds
its neighbourhood rather than the edge of the block. One feature set is searched at a time: the one
whose star is filled on the **Tracks** card. Press another row's star to search that set instead.

![The locus box with RAD5 typed into it and nine genes listed under it, each with its accession and its span: RAD5 itself first, then RAD59, RAD57, RAD55 and the others whose names start so.](../../../assets/screens/browse/navigating-gene-search.webp)

A sequence's name still opens the sequence. Where genes begin with it, as IVY1 begins with `IV`, the
sequence heads the list and <kbd>Enter</kbd> opens it; the genes stay under it, a click away.

![The locus box with IV typed into it: its first row, in bold, is IV · the whole sequence, and under it the gene IVY1 with its accession and its span.](../../../assets/screens/browse/navigating-sequence-first.webp)

## Go to another sequence

- Press <kbd>&gt;</kbd> for the next sequence in the file's order and <kbd>&lt;</kbd> for the one
  before; on a QWERTY keyboard <kbd>.</kbd> and <kbd>,</kbd> do it without <kbd>Shift</kbd>. The
  `‹ ›` buttons beside the title do the same, and their tooltips name the sequence they open.
- Open the **Chromosomes** table, from the crumb after the file's name or with <kbd>c</kbd>, and
  click a row.
- In the **General** panel, the **Sequences** card lists every sequence with its length. Click a name
  to show the whole of it, or tick several to draw them against each other; **show the whole genome**
  takes the ticks away.
- Open the **Whole genome** from the arrow beside the **Chromosomes** crumb, or with <kbd>w</kbd>,
  and click a cell. Where the whole genome is a large read, it waits for a button that says what it
  will read.

## The Genome minimap

The **Genome minimap**, in the **General** panel, draws every sequence end to end with the part on
screen marked on it. Click a sequence's band to open it, or drag across the strip to open a window.
The line under the strip names where the view is, in the same form as the locus box. A block between
two sequences is marked in two places, since it is two places on one genome.

## Zoom and step by range

Four buttons beside the box change the window rather than the picture: `10×` and `3×` out, then `3×`
and `10×` in. Each press scales the window about its centre and reads it again, so what you were
looking at stays in the middle, and each is the exact undo of the one opposite. Zooming out slides in
against the end of a sequence and stops at the whole sequence; zooming in stops at one bin of the
map's resolution. A button greys when there is nothing left in its direction.

The two arrows straight after **go** move the window half its own width upstream or downstream, so
two presses are one window over. Every one of these buttons names, in its tooltip, the window it
would open, and every press is a step the back button undoes. On a block between two sequences they
are all greyed: a picture of two places has no single range to scale or move.

## Resolution and the zoom

The map is read at the resolution chosen in the bar ([Resolution](/browse/contact-maps/#resolution)),
and scrolling does not change it: the block is read once, and zooming in magnifies its cells. A wide
window may be read coarser than the resolution chosen, its bins summed into larger cells, so that a
whole chromosome can be drawn at all. The line under the heading always says what one cell is worth —
`4,033 × 4,033 bins · effective resolution: 3 kb` — so you can tell which you are looking at.

To see finer data, narrow the range: a smaller window is read at a finer grid, down to the bins of
the resolution chosen. Or turn on **Refine on zoom** in the command palette (<kbd>⌘ P</kbd>, or
<kbd>Ctrl P</kbd>): with it on, zooming in past what the block in hand can show reads the same window
again at a finer grid. The map holds still, with a spinner in its corner, until the new block lands,
and <kbd>Esc</kbd> calls the read off. It is one setting for the whole window, every map of a deck
included, and this browser remembers it.

## Crumbs, back and forward

The trail above the view says where you are and is the way back up: the file's name, which you click
to open another file; the **Chromosomes** table, with an arrow beside it that switches to the
**Whole genome**; the sequence; and the window. In the genome browser it reads the genome's name,
**Whole genome**, the sequence and the window. Click a crumb to go back to it. The far end of the
same bar holds the map's **resolution** and **contacts**, which are about the whole picture rather
than a step of the trail ([Reading a contact map](/browse/contact-maps/)).

**Go back** and **Go forward**, in the window's header, are the browser's own back and forward as
buttons. The chevron beside **Go back** lists the steps behind the one on screen — up to twenty,
nearest first, each named as its crumb would be (`IV:1,000,001-1,400,000`, `I × II`, *Whole
genome*), with the resolution, O/E or comparison it set beside it — and goes straight to the one you
pick.

A step is a crumb, a typed locus, a zoom or pan button, or a sequence stepped to. A drag, the wheel
and a pinch are not. The address names what you are looking at, not how far you have panned, so a
link you copy opens the window you opened rather than wherever you scrolled afterwards. In the genome
browser the window is part of the address, as `locus=`, kept up to date as you move in place of the
current step rather than as a new one.

:::tip
A link can open a whole sequence framed on one window of it, so whoever opens it can still pan to
either side: that is what `focus=` does ([Link keys](/reference/links/)), and how a bookmark opens
([Annotations and bookmarks](/browse/annotations/)).
:::

## From the keyboard

| Key | Does |
|---|---|
| <kbd>/</kbd> | puts the caret in the locus box |
| <kbd>&lt;</kbd> <kbd>&gt;</kbd> | the previous and the next sequence |
| <kbd>-</kbd> <kbd>+</kbd> | one resolution coarser or finer |
| <kbd>0</kbd> | undoes every pan and zoom; in the genome browser, the whole genome |
| <kbd>Space</kbd> | the diagonal lock |
| <kbd>c</kbd> <kbd>w</kbd> | the **Chromosomes** table, the **Whole genome** |
| <kbd>b</kbd> | bookmarks the view |
| <kbd>⌘ P</kbd> or <kbd>Ctrl P</kbd> | the command palette |
| <kbd>?</kbd> | every shortcut |

Once you have clicked the map it takes the keyboard too: the arrow keys pan, <kbd>Page Up</kbd> and
<kbd>Page Down</kbd> zoom about the centre, and <kbd>Home</kbd> refits. In the genome browser, once
you have clicked the tracks, the arrow keys pan and <kbd>-</kbd> and <kbd>+</kbd> zoom out and in by
a factor of three, like the `3×` buttons. [Keyboard and command palette](/browse/keyboard/) has the
whole list.
