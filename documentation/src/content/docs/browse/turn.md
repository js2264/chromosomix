---
title: "The 45° view"
description: "Turn a map of one sequence by 45° so that position runs along the bottom and distance from the diagonal up the side, with the tracks lined up underneath."
---

A contact map's signal lies along its diagonal, and a square spends most of its area on the empty far
corners. Turning the map by 45° lays the diagonal along the bottom of a rectangle and gives the
picture to it. A domain becomes a triangle standing on the axis, a loop becomes a dot at the height of
its own span, and the axis along the bottom is genomic position — the axis every track is drawn
against, so a coverage profile underneath lines up with the picture rather than with one edge of it.

![A Micro-C map of yeast chromosome IV from 1.0 to 1.4 Mb turned by 45°, its diagonal along the bottom and separation up the side, with the sequence's GC, the genes, ATAC-seq and its peaks, and Pol II over input lined up under it.](../../../assets/screens/browse/turn-turned-map.webp "live: #uri=https://rsglab-data.s3.eu-west-3.amazonaws.com/demo/yeast/Yeast_microC_G2M_1kb.cool&view=region&region=IV:1000000-1400000&balance=true&transform=log10&flip=true")

## Turning a map

Press the turn button in the **picture** row of the **Map** card, in the **Aesthetics** panel. It
shows the shape a press will give you: a triangle while the map is square, a square once it is
turned. A link asks for a turned map with `flip=true`.

The turn needs a diagonal to measure from, so it is offered on one sequence against itself, at bin
level: a chromosome, or a window of one. Elsewhere — two sequences against each other, the whole
genome of a file with several sequences, a map with one cell per chromosome — the button is greyed. A
circular sequence framed across its origin, with **ori**, turns like any other.

A map opens square unless its link says otherwise. Once you turn it, it stays turned as you move
around the same file — another chromosome, a box drawn on the map — until you turn it back. In a
[deck](/browse/deck/) the turn belongs to the deck: pressing it on any map's card turns every map,
and every band is cut to reach as far from the diagonal as the first map's.

## Reading a turned map

A cell for two bins sits above their midpoint, at a height of half their separation, and nothing is
stretched: a base pair up the side is as long as one along the bottom, and a domain's two edges meet
at a right angle. The ruler up the side is labelled in **separation**, the distance between the two
loci, which is what the height is there to tell you: a contact between two places 100 kb apart is
read as 100 kb. Its ticks follow the same 1, 2, 5 steps as every other ruler in the app.

The two top corners of the rectangle are empty paper. Contacts there would join the window to places
beyond its ends, which were not read, and nothing pretends they are zeros.

The colour scale is the square map's, measured on the whole block, so turning a map does not change
its colours.

Pointing at the map draws an X centred on the contact: the two 45° lines along which one end of it
stays put, which near the axis read as a V. Two hairlines run down every track, one under each end of
the contact. Pointing at a track draws a V standing on the axis above it: every contact that place
takes part in, to its left and to its right.

## The size of the band

A turned map is a rectangle whose size you choose. Drag the bar along its top to make it taller or
shorter, and either end to make it wider or narrower; both ends move together, so it stays centred,
and the tracks under it follow. Double-click a handle for as much room as there is. It opens as wide
as the panel allows and a quarter as tall.

Zooming changes what is inside the rectangle, not its size. Zoom in and you are looking at a shorter
stretch of genome, so the distances that fit above it are shorter too. There is no panning up and
down: a band dragged off its diagonal would lose the axis it is measured from.

This browser keeps the size you chose, for every tab and after a reload, and every map of a deck
shares it, so a deck of bands is one shape.

## Two maps in one turned square

A square that holds two files, or two readings of one ([Comparing two maps](/browse/comparing/)),
turns into two bands mirrored about one shared axis. The first file grows up from the line and the
second down from it, so the same position is the same column in both, and the diagonal, which both
share, is drawn in both. Each band carries its map's name on its own side. The ruler up the side runs
outwards from the shared axis in both directions, so neither band is labelled with a negative distance,
and a pointer in the lower band reads the lower file. The rectangle gives each band half its height.

A ratio or a difference stays one band, since there is one field over the whole square.

## Tracks and marks

Every track is drawn in the stack under the band, whichever edge of the square map it was on: up the
side is a distance, not a place, so there is nothing to draw a track against there. A track on two
edges appears once. Nothing is moved — turn the map back and each track is where you put it.

Marks follow the pairs of places they name:

- a **line** becomes a V standing on the axis at its place, opening up through the band, and carries
  on straight down through the tracks;
- a **domain**, or a rectangle on the diagonal, becomes a triangle standing on the axis, its apex
  over its middle at the height of its span;
- a **loop** becomes one dot at the height of its span, and an **arrowhead** stands above the dot it
  names, pointing back down at it;
- a **rectangle** off the diagonal becomes a parallelogram leaning at 45°.

A call further from the diagonal than the band reaches is not drawn, rather than pinned to the top
edge at a depth the band is not showing.

## What a drag means

Only the axis along the bottom has coordinates on a turned map, so the gestures that open part of it
name a stretch of genome:

- a plain **drag** pans along the axis;
- <kbd>⌥ Option</kbd>-drag (<kbd>Alt</kbd> on Windows and Linux) selects a full-height band over a
  stretch and opens that stretch as a window of its own; the corner of the map says *⌥ + drag to zoom
  into a stretch*;
- <kbd>Shift</kbd>-drag names the same stretch, whichever way your hand moves, zooms to it and
  copies its coordinates.

While a key is held for one of these, the crosshair becomes one vertical line where the band would
begin, and the readout names the position along the bottom alone.

Drawing a rectangle with **draw on map** on the **Manual annotations** card is the exception, because
a mark is about the data rather than the picture. Both ends of the drag are taken back to the square,
so pressing over one contact and letting go over another names the rectangle those two contacts span,
which may be off the diagonal; it is drawn as the leaning shape it becomes. Hold <kbd>Shift</kbd> for
the square on the diagonal through the two places.

The diagonal lock is greyed while the map is turned: its diagonal is already the bottom edge.
