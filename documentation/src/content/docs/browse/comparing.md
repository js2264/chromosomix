---
title: "Comparing two maps"
description: "Give the lower half of a map's square to a second file, or to a second reading of the same file, or reduce two maps to their ratio or difference."
---

A contact map is symmetric, so half of every square is a mirror of the other half and says nothing
new. chromosomix can give that half to something else: a second file, or a second reading of the
same file. The picture is then no longer symmetric, and the eye reads a broken symmetry far faster
than it compares two pictures side by side.

## Two files in one square

1. Open the first map.
2. In the **Annotations** panel, the **Contact maps** card now offers **Load a map into the lower
   triangle**. Drop a map file on it, drag a row onto it from the **Files** panel, or click it to
   choose a file.

The first file is drawn above the diagonal and the second below it. The line between them is the
matrix diagonal wherever you pan, so off the diagonal a block above the line is the first file alone,
and its mirror image below the line is the second. The diagonal itself stays with the first file.

<!-- screenshot: two yeast Micro-C maps in one square, G1 above the diagonal and G2/M below, with both rows on the Contact maps card -->

On the card each file has a row, `◥` for the upper triangle and `◣` for the lower. The second row's
eye takes the lower triangle out of the picture and keeps the file open; its **×** closes it and goes
back to one map. Closing the first file leaves the second as an ordinary map. **swap sides** puts the
other file above the diagonal. Either map can be given a name of its own on its row, and that name is
used wherever the map is named, the readout included.

The comparison is part of the link, as `uri2`, so a comparison of two files at public addresses is a
link you can send. It survives a change of resolution: the second file follows at the same bin size,
from its own resolutions, and the card says so where it has no such resolution.

### What the two files must share

The two triangles are one grid, so the files have to agree about it, and the card refuses a pair that
does not, saying why:

- **The same bin size.** One grid cannot hold two resolutions: open the matching resolution of the
  second file.
- **The same sequences, in the same order, at the same lengths.** Two spellings of one name, such as
  `chr1` and `1` or `chrM` and `MT`, are not a difference, and the second file may carry more
  sequences after the first file's last. One name at two lengths is a difference: it is what tells
  hg19 from hg38.

Maps that do not share a grid can still be compared [side by side](/browse/deck/).

### One scale for both

Both triangles are drawn on one colour scale, so one colour is one number on both sides of the line.
Two libraries of different depth then differ everywhere by their depth alone, so draw both to one
total first: the chevrons after the **contacts** box do it in one press
([Drawing maps to one total](/browse/contact-maps/#drawing-maps-to-one-total)).

Balanced values are each file's own, in each file's own unit. A cooler balanced by `cooler balance`
has rows that sum to one; a `.hic` balanced by Juicer's KR or SCALE has rows that sum to the
library's depth per bin, and drawn beside a balanced cooler it saturates. Compare such a pair by their O/E, each over
its own expected.

Wherever you point, the readout gives both files' counts for that cell.

## Ratio and difference

Past a certain similarity the eye cannot find a difference between two triangles. **compare**, which
appears on the **Map** card under the **picture** row once a second file is open, reduces the pair to
the difference itself:

| compare | Draws |
|---|---|
| **split** | each file in its own triangle, in its own counts |
| **ratio** | the first file divided by the second, over the whole square |
| **difference** | the first file minus the second, over the whole square |

A ratio opens on `log2` and a difference on a linear scale, both on a diverging ramp centred where
the two files agree — 1 for a ratio, 0 for a difference — so every cell that matches is the neutral
colour and only the disagreement is drawn. Going back to **split** gives the map its own scale back.
The link carries the choice as `op`.

<!-- screenshot: the log2 ratio of two Micro-C maps of chromosome IV on RdBu_r -->

Three things to know when reading one:

- **A ratio is made only where both files have contacts.** A cell empty in either has no ratio: it is
  drawn in the ramp's middle colour, and the readout says there is no value there. A difference keeps
  its zeros, since it can subtract them.
- **Depth shows up as a flat wash.** The raw counts of two libraries differ by roughly their depth,
  so the ratio of raw counts is about that one number everywhere. Draw both to one total, or compare
  balanced values.
- **A ratio is not divided by the expected.** The second map is already the baseline, and the decay
  with distance the two share divides out with it, so **O/E** is greyed while the ratio is drawn. It
  applies again under **split** and **difference**.

Smoothing is applied to each file before the two are combined, so a smoothed ratio is the ratio of two
smoothed maps. Zoomed out, where one pixel stands for many cells, a ratio or a difference is pooled
by how far each cell departs from no change, so neither direction fades from the picture.

## Two readings of one file

The lower triangle can also show the same file read another way: balanced counts above the diagonal
and their O/E below, raw counts against a smoothed map, a correlation against the counts it was made
from. The two are then one picture read against itself at every position.

1. On the **Map** card, under its title, there are two tabs: **◥ map**, the card as it always is, and
   **◣ lower**.
2. On **◣ lower**, switch **own reading** on.
3. Set the lower triangle's **score**, **smooth**, **O/E**, **transform**, **colours** and **clip**.

Switching it on changes nothing at first: the lower reading starts as a copy of the upper one, and
you move it from there. While it is on, a dot on the **◣ lower** tab tells you the lower triangle is
not a mirror. Switched off, the triangle is the mirror it always was, and its settings are kept for
the next time.

<!-- screenshot: balanced counts above the diagonal and their O/E below, with the two keys in the corner -->

Each reading has its own colour scale, measured on its own whole square, and its own key: the upper
one marked `◥` and the lower one `◣`. The numbers on both keys can be clicked and typed, as on any
map. The readout names the reading the pointer is over, and a saved figure carries both keys and a
second caption line for the lower reading.

Only the reading belongs to the lower triangle: the window, the resolution, the turn, the overlays
and the tracks are the map's. A lower score that needs other numbers from the file — another column,
or the counts where the upper triangle is balanced — reads the block a second time; one computed from
the same numbers costs nothing more.

A second reading is offered on a map of one file: a region, the whole genome, or a selection of
sequences. It is not offered beside a second file, which has its own claim on the lower triangle, nor
in a deck, where the **Map** card sets whichever map is starred. A link carries it as `lower=true`
with `score2`, `oe2`, `smooth2`, `transform2`, `colormap2`, `vmin2` and `vmax2`
([Link keys](/reference/links/)).

## One square or side by side

A file blended into this square has to share its grid; a file beside it, in a
[deck](/browse/deck/), has only to share its coordinates.

| | One square | Side by side |
|---|---|---|
| Bin sizes | must match | may differ |
| Sequence lists | must match, in order and length | each map uses its own |
| Colour scale | one for both | one for each map |
| How many maps | two | as many as the deck holds |

Use one square for the strongest comparison two maps allow — two conditions or two replicates at one
resolution, read position by position, or reduced to a ratio or a difference, which only one square
draws. Use side by side for maps that do not share a grid, for more than two, or to keep each map on
its own scale. A tab can hold both at once: a deck whose first map has a second file in its lower
triangle.

Two tracks can be compared the same way: tick both on the **Tracks** card and choose **combine…**,
then **ratio** or **difference** ([The genome browser](/browse/genome-browser/)). Turned by 45°, a
square of two maps becomes two bands either side of one axis ([The 45° view](/browse/turn/)).
