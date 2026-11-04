---
title: "3D models beside the map"
description: "Open a 3D chromatin model in a cell beside the map, read it against the maps and tracks in both directions, colour it by what the session knows, and export it as a figure, a bed3d or a PDB for PyMOL and ChimeraX."
---

A 3D model of chromatin, a file of beads placed in space, opens in a cell of its own beside the
contact map and the tracks, and stays linked to them. Point at a bead and the maps show where it is
on the genome. Point at the map and the model lights the beads. This page is about looking at a
model. The formats chromosomix reads are listed on [3D models](/files/structures/). Making a model
from the map and measuring one against it are analyses:
[Model from the map](/analyses/reconstruct3d/), [Model versus map](/analyses/structuremap/) and
[Spatial tracks](/analyses/spatialtracks/).

![A Micro-C map of the whole of yeast chromosome IV with its 3D model in a cell beside it, chromosome IV drawn in its colour and the other chromosomes ghosted; a bead at 1.105 Mb is hovered, the map draws a dashed line down and across at its place, and the status bar names the bead.](../../../assets/screens/browse/structures-bead-hover.webp)

## Opening a model

Any of these puts a model on screen:

- Drop a g3d, a `.3dg`, a bed3d or a PDB that chromosomix wrote onto the window while a map or the
  1D browser is open, or open it by its address (see [Opening files](/files/opening/)). It opens in
  a new cell beside what is already on screen.
- Drop it on the **Structures** card in the Annotations panel (<kbd>2</kbd>), whose zone reads
  **Load a structure**, or click the zone to choose a file.
- With maps side by side, press **add a cell…** in the deck's bar and then **add a 3D structure**,
  or drop a structure file on an empty cell.
- Run [Model from the map](/analyses/reconstruct3d/). The model it makes lands on the
  **Structures** card and opens in a cell straight away.

Every model that arrives gets its own cell and is drawn at once, including several dropped
together. A structure file dropped on an empty window opens a 1D browser of the genome its beads are
on, with the model taking the screen. **show the 1D browser** in the deck's bar puts the tracks back
beside it.

Each model is a row of the **Structures** card: a grip, its colour, its name, an eye and a ×, with
what it holds underneath, such as `2,412 beads · 5 kb · 16 sequences`. The `5 kb` is the spacing of
the beads, read from the file itself. It does not depend on the map's bin size, so the same model
opens the same way beside a 1 kb map and a 50 kb one. A phased model also counts its haplotypes. A
model made by a task names the task and the view it was made from.

## The cell

The model fills its cell. A legend in the top-left corner lists what your hand can do, and lights
the row that is live:

- **drag** turns the model. It turns without limit, over the top and on.
- **scroll** zooms.
- **⇧** and a drag moves the whole model. A drag with the right button does the same.
- **⌘** on a Mac, **Ctrl** elsewhere: hold it and click a bead to make that bead the centre of
  rotation. Tap the key on its own to show or hide the centre.
- **space**: hold it and scroll to bring the fog forward or push it back.

The arrow keys turn the model while its canvas has the focus, and a pinch zooms it. In a small cell
the legend shows only the live row until the pointer is on the picture.

The cell's corner has five buttons: **Mark a bead**, **Mark a loop**, **Measure**, a button that
frames what the maps are looking at, and **Enlarge the model, with every setting beside it**. The
enlarged view shows the model at the size of the window with the whole settings card in a sidebar.
Drag the grip between them to resize the sidebar, or hide it with the button in the stage's bottom
corner. A few single-letter keys work only there; see
[Keyboard and command palette](/browse/keyboard/).

The bar under the picture sets the cell's height. Drag it, nudge it with the arrow keys, or
double-click it to give the height back to the row. The cell's heading is the model's name: type a
new one there and the row is renamed everywhere it is named. The cell's × closes the cell and leaves
the model loaded.

A right-click that does not drag opens the cell's menu. **Copy this** puts the model alone on the
clipboard as a PNG, and the **Marks** group hides the marks on the bead under the pointer, or all
of them.

## Hover, both ways

Point at a bead, and every other picture shows its place:

- each map draws a dashed line down and across the heatmap there. On a turned map it is the dashed V
  that the place makes.
- the tracks beside each map show a tick at that place, and every tracks cell a guide line.
- the status bar names the bead, and so does the cell's own corner.

Point at a cell of a map, and the model answers: the bead at each end of that contact lights up and
a dashed chord joins them. Point at a track and the bead at that place lights. The ball on a lit
bead sits in front of what it marks and behind any part of the model nearer to you, as a ball at
that place would.

The pointer aims for you. Where it misses the fibre, the nearest bead within 14 pixels is taken,
and the cursor becomes a cross while a bead is being aimed at.

Two switches shared with the map govern this. **crosshair** turns the lit beads, the chord and the
halo on the hovered bead on and off, as it does the map's guide lines. **tooltip** turns off the
card that follows the pointer, which names the bead's sequence and position. The line in the cell's
corner and the status bar stay either way. Beside a map both switches are on the **Map** card. In
the enlarged view, and wherever no other card offers them, they are on the **shared** row of the
**3D structure** card.

## Clicking a bead

- A **click** pins the bead, which keeps its halo. The pin is what the two colourings *spatial
  distance to pinned bin* and *contacts with pinned bin* read from.
- A **Shift-click** puts a mark at the bead's place, which every map and track then draws.
- A **double-click** on a bead takes the maps there. A double-click on empty space puts the camera on
  what the maps are looking at.

Three buttons in the corner arm a mode. One is on at a time, it stays on until you press its button
again, and the top row of the legend names it while it runs. No key arms a mode, so a letter pressed
by accident cannot start one.

- **Mark a bead**: each click marks that bead's place on every map and track, as a line on both
  axes. On the model the bead is drawn twice its size, in the mark's colour.
- **Mark a loop**: click two beads, and an arrowhead, the map's own loop mark, is put on the contact
  between their places. On the model it is drawn as a chord. Esc lets go of the first bead.
- **Measure**: press on one bead, drag to another and let go. The card lists each measurement with
  both places, the distance in the model's units and the separation along the sequence (or *across
  sequences*), until its × removes it. The model shows it as dashed ink with the distance at its
  middle, and so does an exported figure.

The marks you make here are ordinary manual annotations; see
[Annotations and bookmarks](/browse/annotations/).

## The 3D structure card

The settings are the **3D structure** card of the Aesthetics panel (<kbd>3</kbd>), right after the
**Map** card. It is there whenever the deck has a structure cell. Its rows, in order:

| Row | What it sets |
| --- | --- |
| **compare with** | another model, superposed on this one (see below) |
| **in the frame of** | another model whose frame this one is turned into |
| **drawn as** | beads, sticks and a tube, in any combination. The tube alone is the default |
| **overlays** | the sequence names, a genomic ruler, the telomeres, and the centre of rotation with its axes |
| **colour by** | what the beads are coloured by (see below) |
| **colour scale** | the ramp, where the colouring has one |
| **bead radius**, **tube radius** | sliders, each with the number it is at beside it |
| **haplotype** | on a phased model, both homologues or one of them |
| **outside window** | what happens to beads outside the window the maps show: *ghost* (the default), *hide* or *show*, with the ghost opacity beside it |
| **loops as chords** | a set of pairs drawn as chords (see below) |
| **fog** | the fog for depth, on or off, and how far back it starts |
| **depth slab** | keeps only what lies within this fraction of the model's reach of the centre, front and back. All the way right is everything |
| **shared** | the legend, crosshair and tooltip switches that no other card in the column offers |
| **measurements** | the list of distances measured |
| **camera** | **front**, **top**, **side**, the turntable, turn together, and **replant the axes** |
| **frame** | **the window**, **everything**, and two mirrors |
| **export** | the figure: see [Exporting a model](#exporting-a-model) |

A chain with a missing bead is drawn with a dashed line across the gap, so it reads as one chain
with a hole rather than as two chains.

The ghost opacity is 0.1 by default. It is a real transparency: a ghosted bead keeps its colour and
lets what is behind it through, and at 0 it is gone. The slider is greyed while *outside window* is
*hide*, since nothing is ghosted then.

**overlays** has four switches. The **genomic ruler** puts a tick at a regular step along each
chain, labelled like `500 kb`. **Telomeres** puts a yellow bead at both ends of every chain: it
marks where each chain ends, and claims no more than that. The **centre and axes** are a ball at the
centre of rotation with an arm per axis (x red, y green, z blue). They are shown by default.
**replant the axes** lays the arms along the current view without moving the model, so every turn
after that is read against where you were looking. A ⌘-click or Ctrl-click on a bead moves the
centre there and replants the axes too.

The two mirrors reflect the model across the screen or up it. A model made from contacts is fixed
only up to reflection: two models of one map can come out as mirror images that no rotation brings
together. The reflection is applied to the model itself, so picking, measuring, the names and the
export all follow it.

## Colouring the model

**colour by** offers the model's own colourings first:

- **sequence**, the default.
- **linear position along the sequence**.
- **manual annotations**: your marks, a line colouring its bead and a rectangle its run of beads.
- **spatial distance to pinned bin**, in the model's units.
- **contacts with pinned bin**: the lead map's row through the pinned bead, on the map's own
  transform, range and colour map. It is a virtual 4C, read in space. A pair the map never counted
  is the bottom of the scale.

Then **haplotype** for a phased model, any further column of the model's own file (marked *from the
file*), the values of each loaded track at every bead (marked *· track*), and each set of features
(marked *· features*). A feature set whose features carry names, such as a compartment call's `A`
and `B`, is offered a second time as *· names*, the names as categories. With **compare with** set,
**displacement** colours each bead by how far it is from the same bead in the other model.

A track's values at each bead are read the way its lane reads them, on the lane's own limits, so a
bead and the lane beside the map agree at every value.

**colour scale** is offered only for a ramp. *the colouring's own*, the default, keeps a track's
beads on the lane's colour map and contacts on the map's. You can choose any colour map the app has
instead, and under a track also **white to the track's colour**.

### The key is a control

The key in the cell's corner lists what the colours mean, and you can act on it:

- under *sequence*, each sequence's swatch opens a colour picker. A click on its name ghosts that
  sequence, a double-click shows it alone, and a second double-click brings every sequence back.
- under *manual annotations*, each mark has a row with its own colour. Picking a colour here changes
  the mark everywhere. A click hides the mark from every picture, as its eye on the
  **Manual annotations** card does, and a double-click shows it alone.
- under a feature set's names, the key lists the names some bead is under. A colour picked for a
  name is that name's colour for the whole set, on its lane too.
- under a track, the two ends of the scale are numbers to type into. Enter commits, Escape leaves
  them alone, and Tab goes from the bottom to the top. What you type sets the lane's limits, so the
  lane beside the map changes with it. Once you have fixed the range, an arrow after it puts the
  track back on autoscale.

The map's **legend** switch hides the key here too.

## Chords and names

**loops as chords** draws a set of pairs, such as a BEDPE or the loops a task called, as chords
between the beads of their two anchors. It also offers **manual annotations**, so an arrowhead you
marked on the map, or in **Mark a loop**, is a chord on the model. Only the loops touching the
window are drawn, at most 600 of them. Once a set is chosen, a switch beside it shows or hides the
chords.

With the sequence names switched on under **overlays**, the names are written on the model, and so
are your bookmarks, each at its middle bead.

## Comparing two models

**compare with** superposes another model on this one. The beads the two share are matched by place
on the genome (and by haplotype where both are phased), and the other model is rotated, scaled and
moved onto this one by a similarity fit. It is drawn as a thin grey tube. The card says how many
beads matched and the root-mean-square distance between them (the RMSD), in model units. Fewer than
four shared beads is no fit, and the card says so.

**in the frame of** is the same fit read the other way: this model is turned into the other model's
frame, and the other is not drawn. Open the two models in two cells, set one *in the frame of* the
other, and switch on **turn together** in both: they then turn as one, side by side.

If two models of one map refuse to line up, mirror one of them first (**frame** row).

## Several models, several views

Each model has its own cell, and you can open as many cells as you like:

- The eye on a model's row opens a cell for it, or closes every cell drawing it.
- Drag the row's grip onto an empty cell or a `+` edge of the deck to draw the model there. Dropped
  on a cell that already draws a model, it swaps that cell's model in place.
- Two cells of the same model are two views of it, each with its own camera, height and turntable.
  Drawing style, colouring, mirrors and axes belong to the model, so every cell of it shares them.

**turn together**, the link switch on the **camera** row, ties cells together. Every cell with it on
shares the camera's two angles, so one drag turns them all, while each keeps its own centre and
zoom. The cell you switch it on in leads, and the others come round to it.

With two structure cells or more, each wears a star. The **3D structure** card sets the starred
cell, which it names under its title (`★` and the model's name). Press the lit star to star none:
the card then sets every structure cell at once and says so. The rows that only make sense for one
cell (**compare with**, **in the frame of**, the measurements and the export) are not offered then.
A model that opens later does not take the star.

## Scale and distance

A model has no physical unit. A model from a file is in the units its file was written in. A model
made here by [Model from the map](/analyses/reconstruct3d/) is centred and scaled to a
root-mean-square radius of one, since a contact map carries no unit either. Measurements, the RMSD
and *spatial distance to pinned bin* are all in the model's units. The genomic ruler, the bead
spacing under the row and the separation given with each measurement give the genome's scale along
each chain.

## Exporting a model

### A figure

The **export** row at the foot of the **3D structure** card saves the model as it is drawn: a
resolution, a format, a save button and a copy button.

- **PNG** is the picture as your graphics card lit it, at the resolution chosen beside it.
- **PDF (vector)** is a drawing of the same picture: beads, sticks and the tube as shaded paths, the
  names as text, at no resolution at all, so the resolution is not offered while it is chosen.

Both hold the same things: the dashes across gaps, the centre when it is shown, the ruler, your
marks, the telomeres, the measurements, the depth slab and the fog, all on white whatever the theme.
Both are framed by a thin rule at the cell's edge. The copy button puts a PNG on the clipboard. For
the model with no key, buttons or frame, use **Copy this** in the cell's right-click menu.

With maps beside it, the model is also a cell of the deck's figure. See
[Figures and export](/browse/figures/).

### The model itself: bed3d

The **Structures** card's row has **export** **bed3d**: the model as `chrom start end x y z`, with a
haplotype column for a phased model, six decimals, under a `#` line naming the model, what it was
made from and when. It is the format chromosomix reads, so the file opens again here and in
`g3dtools`. It is how a model made by a task leaves the app, and it holds a model of any size.

### PDB, for PyMOL and ChimeraX

**PDB** beside it writes the model for molecular viewers such as PyMOL and ChimeraX, drawn as the
fibre it is:

- one atom per bead, and no atom for a bead the model left unplaced;
- one chain per sequence and haplotype, in the order the cell draws them, so colouring by chain
  tells chromosomes, and homologues, apart. Residues are numbered from 1 along each chain, so a
  rainbow by residue runs from one end of a chromosome to the other;
- bonds between neighbouring beads only, with none across a gap and none between chains, so the
  viewer draws exactly the fibre;
- coordinates centred and scaled so that the usual step between neighbours suits PyMOL's spheres,
  sticks and cartoon. The file claims no physical unit.

The file's REMARK 250 lines say this in words, followed by the PyMOL commands that draw the model as
the cell does:

```text
set cartoon_trace_atoms, 1; set cartoon_tube_radius, <r>
as cartoon; util.cbc
```

or as beads:

```text
set sphere_scale, <s>; as spheres; util.cbc
```

The file gives `<r>` and `<s>` as numbers for that model. After the commands comes a table that
places every bead on the genome, which is what lets chromosomix read its own PDB back bead for bead.

:::caution[Keep the file chromosomix wrote]
PyMOL drops every REMARK line when it saves a file, the placement table with them, and chromosomix
cannot place a PDB on the genome without it. Open the PDB that chromosomix wrote, or its bed3d. A PDB
written by another program, such as pastis, is refused, because it does not say where its beads are
on the genome. Write its coordinates beside the bins they were modelled at, as a bed3d, instead.
:::

A PDB has room for at most 99,999 beads, 9,999 beads in one chain and 9,999 chains. Past any of
these the **PDB** button is greyed, with the reason in its tooltip. The bed3d still holds the model.

From the command line, `chromosomix reconstruct3d` with `--out` writes the bed3d and the PDB beside
its tables; see [Model from the map](/analyses/reconstruct3d/).

## What is kept

A model's settings are kept with its row: how it is drawn, its colouring and pin, its mirrors and
its axes. They come back after a reload, in a saved workspace and in a shared link. Each cell's
camera, height and **turn together** are remembered too, by the cell's place in the deck.

After a reload, a model read from your disk asks to be pointed at again, as every local file does.
Drop the file once more. A model made by a task comes back with its recipe and a **recompute**
button, since its coordinates are not kept. See
[Sessions, workspaces and links](/browse/sessions-and-links/).
