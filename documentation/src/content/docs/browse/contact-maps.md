---
title: "Reading a contact map"
description: "What the colours of a contact map mean, and how to choose what its cells hold and how they are drawn."
---

A contact map is a square of cells, one for each pair of bins, coloured by how often the two touch.
The region view draws one block of it: a sequence against itself, a window of one, or two sequences
against each other. Its heading names the window, and the line under the heading says how large the
block is and what one cell of it is worth: `1,532 × 1,532 bins · effective resolution: 1 kb`.

How the map is drawn is set on the **Map** card in the **Aesthetics** panel, from top to bottom:

- **picture**: undo every pan and zoom, the [45° turn](/browse/turn/), the
  [diagonal lock](/browse/navigating/#stay-on-the-diagonal), **O/E**, and, on a circular sequence,
  **arms** and **ori**;
- **compare**, while a second file is open in the lower triangle
  ([Comparing two maps](/browse/comparing/));
- **score**: what the cells hold;
- **smooth**: each cell averaged with its neighbours;
- **transform**, **colours** and **clip**: how a value becomes a colour;
- **overlays**: what is drawn over the cells.

Except for the overlays and the diagonal lock, these settings are part of the link, so whoever opens
it sees the same numbers drawn the same way.

<!-- screenshot: the Map card beside a balanced map of yeast chromosome IV -->

## The key

The key in the map's top-right corner names what the cells hold and the transform they are drawn in,
gives the size of one cell on the line under that, and ends with the two ends of the colour scale
and the ramp between them. Each of the two numbers is a button: click it to type a bound in its
place, and empty it to hand that end back to automatic. The key stands aside on a narrow map, and
**legend**, under **overlays**, hides it for a figure that has a key of its own.

## Resolution

**resolution**, at the far end of the bar above the map, lists the bin sizes the file stores — `1 kb`,
`5 kb`, `1 Mb` — as stops under a slider, or as a dropdown once there are more than nine. A finer
resolution is more, smaller cells and a larger read; the place on screen does not change.
<kbd>-</kbd> and <kbd>+</kbd> step one coarser and one finer. A file with several resolutions opens a
third of the way up its ladder from the finest, so that the first read is quick; pick the finest
when you want it.

The `+` after the stops asks for a resolution the file does not store. **Add a resolution** takes any
whole multiple of one of the file's bin sizes — 3 kb on a file of 1 kb bins — and sums the stored bins
as they are read: nothing is written and nothing extra is downloaded. An added resolution wears a `*`
(`3 kb*`) wherever it is named, and its `×` takes it off again; a file takes up to twelve. Counts add
up exactly, but balanced values are an estimate, since `cooler zoomify --balance` balances each
resolution on its own. A task run while an added resolution is drawn reads the map at that resolution
too.

A wide window may be drawn coarser than the resolution chosen, its bins summed into larger cells, and
the summary line says so; [Resolution and the zoom](/browse/navigating/#resolution-and-the-zoom)
explains how to read finer.
On the whole genome, the **level** select at the head of the **Sequences** card, in the **General**
panel, switches between `bin × bin` and `chromosome × chromosome`, one cell for each chromosome.

## What the cells hold

**score** says what the numbers in the cells are:

| Score | Each cell holds |
|---|---|
| **counts** | the contacts stored for that pair of bins |
| **balanced** | the counts with each bin's bias divided out, using the weights in the file — offered when the file has them |
| **VC**, **VC √**, **ICE** | a normalisation computed here, from the block on screen |
| **expected** | what the cell's distance from the diagonal predicts: the baseline an O/E divides by |
| **arm decay** | the same baseline taken along both arms of a circular sequence |
| **correlation** | the correlation between rows of the balanced O/E, on a file with weights |
| a column's name | a further column of the file's own pixel table |

A map whose file carries balancing weights opens **balanced**, on `log10`. One without opens on
**counts**, on `log1p`.

### Balanced or raw counts

Raw counts carry each bin's own bias in coverage, and balancing divides it out. **balanced** uses the
file's own weights: a cooler's are those `cooler balance` wrote, and a cell is its count times the
weights of its two bins, exactly as cooler computes it. A `.hic` brings its own normalisation —
SCALE where it has it, then KR, then the coverage ones — and the **File** card in the **General**
panel names the one in use on its **normalisation** row. A bin the balancer dropped has no weight;
its row and column are drawn as paper, not as zero.

**VC**, **VC √** and **ICE** normalise a file that has no weights, or that you want normalised
another way. They are computed from the block on screen, so on a window of a chromosome they are the
window's normalisation rather than the chromosome's. Each agrees with cooler and cooltools cell for
cell, to the precision the map is held in ([How the results are checked](/analyses/validation/)).
Juicer's KR is not offered: it reaches the same weights as ICE.

### Expected and correlation

**expected** draws the baseline itself: a band fading away from the diagonal, and one flat value for
each pair of different sequences. An O/E is only as good as this denominator, and far from the
diagonal it is a mean over few cells, so it is worth a look before trusting a ratio there. While it
is drawn **O/E** is greyed, since the expected divided by itself is 1 everywhere.

**correlation** is the picture compartments are read from: the correlation between every two rows of
the balanced O/E, for square blocks of up to 4,096 bins a side. It is computed in the background,
with the O/E drawn under a *correlating…* note until it lands. The
[Compartments](/analyses/compartments/) task calls compartments with the same arithmetic.

## Transform

**transform** turns a value into a position on the colour ramp: `log1p`, `log10`, `log2` or `none`.
Contacts fall by orders of magnitude away from the diagonal, so on a linear scale little but the
diagonal shows. `log1p` suits counts, `log10` suits balanced values, which are small fractions, and
`log2` suits ratios, putting twice and half the same distance either side of no change. Changing the
transform hands the clip back to automatic, since a bound is a number in the old transform's units.

## Colours

**colours** picks the ramp; a ✓ marks the ones that read safely with a colour-vision deficiency.

| Ramp | |
|---|---|
| `default` | white through yellow and red to black: what a map opens on |
| `afmhot_r`, `afmhot` | matplotlib's ramps of those names |
| `Reds` | white paper, then red to a dark maroon |
| `cividis` ✓, `viridis` ✓, `magma` ✓ | even in lightness, and colour-vision safe |
| `RdBu_r` | diverging, red for more and blue for less: what a ratio or an O/E opens on |
| `BuWtRd` | diverging, with more contrast and white at its middle |
| `seismic` | diverging: the ramp chromosight draws its pileups in, for figures laid beside them |

## Clipping the colour scale

**clip** sets where the ramp starts and where it saturates. Its two boxes are in the transform's
units, which the row's label names — **clip (log10)** — and the line under them gives the same range
in the units the readout uses, `auto · 0.000066 – 0.089 balanced`. Type a bound to fix it, and press
⇅ to go back to automatic. The two numbers on the key are the same two bounds and can be typed there
instead.

The automatic range is measured on the block that was read and stays put while you pan and zoom
inside it, so the colours do not shift under you. For counts it runs from 0 to the 99th percentile of
the non-zero values; for balanced values, from the 1st to the 99th percentile of the cells that hold a
contact.

## Observed over expected

**O/E**, in the **picture** row, or <kbd>e</kbd>, divides each cell by what its distance from the
diagonal predicts: the mean over every pair of bins that far apart, measured on this block, and one
value for each pair of different sequences. The decay with distance stops being the picture, and the
departures from it — domains, loops, compartments — become it. It works with any score; O/E of
balanced counts is the usual reading.

Switching it on puts the map on a scale made for a ratio: `log2`, a range symmetric about 1, and
`RdBu_r`, red for more contacts than expected and blue for fewer. Switching it off gives back the
transform, colours and clip you had. A cell where nothing was observed is drawn as paper rather than
as the strongest depletion on the ramp. Like the normalisations, the expected is measured on the block
on screen, so on a window it is that window's.

On a sequence declared circular, or whose origin has been set, two buttons join **O/E**. **arms**
divides by the decay along both arms of a bacterial chromosome — its secondary diagonal through the
origin as well as the main one — so what is left is its compartments. **ori**, on a circle, frames
the whole sequence with its origin in the middle, the arms running out to the corners; pressed again,
it frames the sequence from its first base. Circles and origins are declared in the **Chromosomes**
table ([Circular sequences](/browse/genome-browser/#circular-sequences)).

## Smoothing

**smooth** averages each cell with the cells around it, itself included: **3 × 3**, **5 × 5**,
**7 × 7**, or **adaptive**, whose window grows until it holds enough contacts — small near the
diagonal, where contacts are plentiful, and much wider far from it, where a fixed window would still
be almost empty. **adaptive** takes serpentine's criterion and keeps it a sliding window, so a smoothed
map pans without its pattern reshuffling. It turns the O/E on, since that is the picture it is made
for; you can turn the O/E off again.

Smoothing comes before anything is divided — before the O/E and, with two files, before their ratio —
so a zero cell with contacts all around it is no longer a hole. On a large block the adaptive window
is computed in the background, and past 16 million cells it falls back to 3 × 3, which the note under
the heading says.

## Drawing maps to one total

Two libraries sequenced to different depths cannot be compared by their colours: the deeper one is
brighter everywhere. The **contacts** box, at the far end of the bar after **resolution**, draws
every map in the tab to one number of contacts before it is shown or analysed. Type a total as a
methods section would write it — `10M`, `23,000,000`, `2.5e7`, `500k` — and press <kbd>Enter</kbd>.
The box's tooltip gives each map's own total; empty the box to read the files as stored.

- A map that holds more contacts is **subsampled**, as `cooltools random-sample --count N --exact`
  does it: exactly `N` of its contacts, every subset of that size equally likely.
- A map that holds fewer is **oversampled** through Boost-HiC: every contact it has, plus new ones
  drawn from a probability map built from it. That is an inference, and every place that names the
  map says which of the two it is.

The draw has a fixed seed, so one total is one map in every view, after a reload and on the
[command line](/cli/running/), as `--contacts`. Balanced values are rescaled with the draw, so a
subsampled map is not drawn fainter than its file. Every task reads the drawn map, and a saved
figure says so in its caption: *subsampled to 10,000,000 contacts (of 179,175,551)*.

With two maps or more on screen — a [deck](/browse/deck/), or a second file in the lower triangle —
two chevrons follow the box. One types the shallowest map's total, so that every map is subsampled to
it; the other types the deepest's, so that every map is oversampled to it. The total is in the link,
as `contacts=`, and stays with the file as you move from one sequence to another.

:::caution
Some maps cannot be drawn to a total, and the map says why in its place, with **read as stored** as
the way back: counts that are not whole numbers, a file that stores every contact twice, an `.scool`,
a value column other than the counts, and, for an oversample, a sequence of more than 3,000 bins —
where a coarser resolution is the way through.
:::

## What is drawn over the map

**overlays** switches what is drawn over the cells: **dividers** between sequences (<kbd>d</kbd>),
**breaks**, the same boundaries as ticks outside the plot (<kbd>m</kbd>), block **labels**
(<kbd>l</kbd>), base-pair **ticks** along the axes (<kbd>k</kbd>), the **legend**, the **crosshair**
(<kbd>x</kbd>) and the **tooltip** card that follows the pointer (<kbd>p</kbd>). They are your
preferences rather than part of the view: this browser keeps them, and a link does not carry them.

Tracks, loop calls and the marks you draw are placed beside and over the map too; see
[The genome browser](/browse/genome-browser/) and [Annotations and bookmarks](/browse/annotations/).

## Hovering a cell

Point at a cell and a card beside the pointer reads it: the sequence, or the two off the diagonal;
the two positions, counted from 1; how far apart they are; and what the cell holds, with the derived
value where there is one and the counts behind it. With a second file in the lower triangle it gives
both files' counts. The same reading is written on the status line at the foot of the window, which
keeps it after the pointer has moved on, and **tooltip** (<kbd>p</kbd>) puts the card away and leaves
the status line.

Over the map the pointer is a small ring, and the crosshair's lines stop short of it, so the cell
under it and its neighbours stay in view. Holding <kbd>Shift</kbd> snaps the reading onto the
diagonal.

Right-click a cell for:

- **Copy this**: the cells alone, as drawn, onto the clipboard as a PNG, with no axis, key or frame;
- **Mark this point**: a **Vertical line**, a **Horizontal line**, a **Crosshair** or an
  **Arrowhead** at the cell, added to the **Manual annotations** card;
- **Copy coordinates**: the cell's two positions, counted from 1 and without separators.

<!-- screenshot: the hover card over an off-diagonal cell of a balanced O/E map -->
