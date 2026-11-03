---
title: "Figures and export"
description: "Save a map, the 1D browser, a deck, a 3D model or an analysis figure as a vector PDF or a PNG, restyle a task's figure before you export it, and take the numbers behind every figure as TSV, BED or bigWig."
---

Everything you can see in chromosomix can leave it as a figure: a map, the 1D browser, several maps
side by side, a 3D model, or a figure an analysis drew. Each figure is drawn again for the file
rather than captured from the screen, so labels and hairlines stay sharp at any resolution. Every
figure comes out on white, in the light theme's ink, even when you work in the dark theme. The
numbers behind it can leave too, as TSV, BED, bedGraph or bigWig.

## Saving a view

The **Export** card is the first card of the Aesthetics panel (<kbd>3</kbd>). Its row reads, from
the left: the resolution, the format, a save button and a copy button, then a **caption** switch.

- **PDF (vector)**, the default, is a drawing. On a map, the cells are one lossless image and
  everything round them, the axes, ticks, labels, tracks, key and caption, is paths and text that you
  can restyle in a vector editor such as Illustrator. The 1D browser's PDF is paths and text
  throughout. Text is set in Helvetica, so nothing needs embedding.
- **PNG** is the whole figure as pixels, at 96, 150, 300 or 600 dpi: 96 is what is on screen, 300
  (the default) is print. The resolution is not offered while PDF is chosen, since a PDF has none.

The figure is framed as the screen is, pan and zoom included, with the tracks beside the map and
the key in the map's corner. The map's **legend** switch removes the key.

Under the figure, a quiet **caption** says what it shows: the region on the first line, then the
file, the total it was drawn to where that is not the file's own, the bins, the score, the colour
range and the date. A 1D browser figure names its genome, its window and the date. Switch
**caption** off and the figure ends at its lowest track. The switch is one preference for the map,
the 1D browser and the deck.

The file is named after the region as the caption prints it, such as
`IV_1000001-1400000-<stamp>.pdf` for `IV:1,000,001-1,400,000`. A PNG's name also carries its
resolution.

Two keys reach the card from anywhere:

- <kbd>S</kbd> saves the figure, in the format and at the resolution the card is set to;
- <kbd>Ctrl</kbd>+<kbd>C</kbd> (<kbd>⌘</kbd><kbd>C</kbd> on a Mac) puts the figure on the clipboard as
  a PNG at the card's resolution, ready to paste into a slide. With text selected, or the caret in a
  box, the key copies the text instead.

The copy button always copies a PNG, whatever the format beside it says. While PDF is chosen, its
tooltip names the resolution it will use.

<!-- screenshot: the Export card of the Aesthetics panel, with PDF (vector) chosen and the caption switch on -->

## Where a file goes

Every export opens your system's save dialog, in your Downloads folder, with a name ready to change,
where the browser has one, as Chromium-based browsers do. Cancel it and nothing is written. Firefox
and Safari have no such dialog, so the file is a plain download under the suggested name. The card
then says which file it saved, and the [console](/browse/console/) records every file written.

## Several maps as one figure

With maps side by side (see [Maps side by side](/browse/deck/)), the whole deck is one figure:

- the deck's bar has a save button, **Save the whole deck as one figure, laid out as it is on
  screen**, which writes a PNG at 300 dpi, and a copy button that puts the same picture on the
  clipboard. <kbd>Ctrl</kbd>+<kbd>C</kbd> copies the deck too while it is up;
- the **Export** card, and <kbd>S</kbd>, save the deck in the card's own format and resolution,
  whenever a cell beside the first map has a picture of its own.

In the deck's PDF each cell is drawn as it would be on its own: a map's cells as its one image with
paths and text round them, and a tracks cell, the 1D browser or a 3D model as paths and text
throughout. Each cell keeps its own caption, key and frame, and an empty cell stays empty.

## Copy this: one object alone

Right-click the map, a lane, or a 3D model and choose **Copy this**. It puts that object alone on
the clipboard as a PNG, at the screen's own resolution: the map's cells with no axis, key, mark or
pointer, a lane with no name or range, or the model with no key, buttons or frame. White goes under
it. Use it to assemble a figure of your own in another program. A note in the corner says the size
copied.

## A 3D model

The **3D structure** card ends with the same export row. **PNG** is the picture as your graphics card
lit it; **PDF (vector)** draws the beads, sticks and tube as shaded paths and the names as text. The
model's own coordinates leave as a bed3d or a PDB, from its row on the **Structures** card. See
[Exporting a model](/browse/structures/#exporting-a-model).

## A task's figure

Every figure in the Analysis drawer is drawn from the numbers the task returned, its *spec*, and
your choices about how they look, its *style*. You can change the style freely: the numbers do not
move, and the export draws exactly what you see.

### The strip and the exports

A slim strip over each figure holds the controls you reach for most:

- over a curve, the **mark** (line, area, step, points, bars, histogram, box or violin), the two log
  axes, the **legend**, and **fit**, which puts both axes back to the whole of the data;
- over a matrix, its colour map;
- over a table, a box that filters its rows.

Above it, beside the figure's title, are its exports: **TSV** (and **bigWig** and **bedGraph** for a
track), **PNG**, a raster redrawn at 300 dpi, **PDF**, a true vector page you can restyle, recolour
and scale, and **Copy**, the PNG on the clipboard.

### Zooming the figure

- The wheel zooms the horizontal axis, and a drag pans it. With Shift held, the wheel zooms the
  vertical axis.
- Hold <kbd>⌘</kbd> (<kbd>Ctrl</kbd> elsewhere) and drag a box: the axes come back holding what was
  in it. A flick across the picture sets the horizontal axis alone, a flick down it the vertical
  axis, and a box both.
- A double-click puts both axes back to the windows the controls last set.

What you zoom to is what the PDF and the PNG draw, with the axes relabelled for it.

### Customise this figure

The sliders button beside the exports, **Customise this figure**, opens the figure at the size of
the window, with every control in a column beside it. Drag the column wider or hide it, as for an
enlarged 3D model. The column has a card per kind of setting:

- **chart**: the mark, the line width, the point size, smoothing, fill under the line, the band
  round each line where the task computed one, and a histogram's bins;
- **axes**: each axis's scale (linear or log), its name, its window from one number to another, and
  its grid;
- **series**: an eye to hide each series, a swatch to recolour it, **show all** and **reset
  colours**;
- **text**: a **title** printed on the figure itself, the **type size**, where the **legend** goes,
  and the **tooltip**;
- for a matrix, **colour**: its colour map and the values its scale runs between;
- for a table, **rows**: a filter, the column to sort by, which columns to show, and **plot**, which
  draws the table as a chart of two of its columns.

**reset** goes back to the figure the task returned. Your choices are remembered for that file, task
and figure, survive running the task again and a reload, and travel in a saved workspace. On paper,
a series you hid is left out of the legend, since there is nothing there to click to bring it back.

## What an export carries

A figure and a file each say where they came from:

- a map's or the 1D browser's figure carries its caption, if you leave it on;
- every PDF names the chromosomix version that wrote it in its document properties;
- every result keeps a record of its task and the task's version, every parameter, the view it was
  computed from, the file, the app's version and commit, and the time. **copy provenance** under a
  finished result puts that record on the clipboard, and **copy CLI command** the
  `chromosomix` command that repeats the run;
- a TSV and a bedGraph open with that record as `#` lines, such as `# file:`, `# task:`,
  `# framing:` and one `# param` line per parameter. A called set's BED opens with one `#` line
  naming the set, the view it was called from and when. A bigWig has nowhere to put the record, so
  save the TSV beside it;
- a model's bed3d opens with a `#` line naming the model, what it was made from and when, and its PDB
  with a TITLE saying the same.

The [map report](/analyses/mapreport/) can also leave as a single **HTML report**: every figure and
table of its run on one page, with its notes and provenance, each figure saveable from there as SVG
and its numbers as TSV.

## The numbers behind a figure

Every output of a task offers **TSV**: the same numbers as the figure, with the record above them,
so anyone reading the figure can check a value. Tracks, sets and marks also leave in the formats
other tools read:

| What | Formats |
| --- | --- |
| A track a task computed | bigWig, bedGraph, TSV |
| A set of intervals or pairs a task called | BED, or BEDPE for pairs, anchors, TSV |
| Your marks | BED for lines, BEDPE for arrowheads and rectangles |
| A column of the file's own tables | TSV |
| A 3D model | bed3d, PDB |

The bigWig is written by chromosomix itself, with no `bedGraphToBigWig` step. A bedGraph has one
line per bin that has a value, and leaves out the bins that have none rather than writing them as 0.
[Annotations and bookmarks](/browse/annotations/) says where each of these buttons is.
