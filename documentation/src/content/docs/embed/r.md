---
title: "R, Quarto and Shiny"
description: "Put the chromosomix viewer on an R Markdown or Quarto page, in the RStudio viewer or in a Shiny app with the R package, and move it from R."
---

The `chromosomix` R package puts the app on an R Markdown or Quarto page, in the RStudio viewer or in Shiny, moved from R.

## Install

```r
remotes::install_github("js2264/chromosomix", subdir = "widgets/r")
```

Or from a clone:

```r
install.packages("widgets/r", repos = NULL, type = "source")
```

It needs R 4.1 or later, with htmlwidgets, httpuv and jsonlite; shiny for an app, openssl to check a viewer it downloads, and rstudioapi behind RStudio Server.

## A map and its tracks

```r
library(chromosomix)

yeast <- "https://rsglab-data.s3.eu-west-3.amazonaws.com/demo/yeast"
chromosomix(
  file.path(yeast, "Yeast_microC_G2M_1kb.cool"),
  region = "IV:1000000-1400000",
  tracks = file.path(yeast, c("Yeast_ATAC.bw", "Yeast_annotations.gtf")),
  transform = "log10"
)
```

![An R Markdown page rendered to HTML, showing the chunk above and under it the widget: the viewer's bar, on two lines at this width, and the yeast Micro-C map of IV:1.0–1.4 Mb on a log10 scale, with its ATAC-seq track under it.](../../../assets/screens/embed/r-markdown-widget.webp)

| Argument | What it is |
| --- | --- |
| `map` | the contact map, an address or a path. `::` names a group inside it: `"sample.mcool::/resolutions/5000"`. `NULL` for a 1D browser of the tracks |
| `tracks` | files added in order once the view is drawn, as the header's **+** adds them: tracks, maps, 3D models, workspaces |
| `region` | where the map is framed: `"IV:1000000-1400000"`, counted from 0 as cooler counts, or a sequence, a start and an end |
| `locus` | where a 1D browser is placed: `"IV:400,001-460,000"`, 1-based |
| `...` | any other key of the view from [Link keys](/reference/links/), named: `transform`, `colormap`, `balance`, `vmin`, `vmax`, `oe`, `smooth`, `view`… |
| `viewer` | the build of the viewer in the frame ([below](#which-viewer)) |
| `width`, `height` | the widget's size, in CSS units or pixels; `"100%"` and 600 by default |
| `title`, `elementId` | the frame's title, for a screen reader, and an id for the widget's element |

A key takes one value, as a link writes it: `maps = "a.cool|b.cool"`, not a vector. A path under `uri`, `uri2` or `maps` is served like the map.

## Moving it before it is drawn

A rendered page has no R behind it, so lay requests on the widget. The frame makes them in order, each once the one before is done, and again when it reloads:

```r
chromosomix(file.path(yeast, "Yeast_microC_G2M_1kb.cool"), region = "IV:1000000-1400000") |>
  chromosomix_goto("IV:1150000-1300000") |>
  chromosomix_navigate(transform = "log2", oe = TRUE) |>
  chromosomix_add(file.path(yeast, "Yeast_structure.g3d.gz"))
```

- `chromosomix_goto()` frames a square on the diagonal, dropping any off-diagonal block or zoom, or moves the 1D browser's locus. It takes a string, or a sequence, a start and an end.
- `chromosomix_navigate()` changes only the keys you give; `NULL` removes a key.
- `chromosomix_add()` adds files as the header's **+** does; a 3D model opens in a cell of its own beside the map.

## A 1D browser

With no map, the first file becomes the view's: a bigWig opens a genome browser over its assembly, with the rest as its tracks. `locus` (or `region`) and the other keys are laid on once the tracks are in.

```r
chromosomix(
  tracks = file.path(yeast, c("Yeast_ATAC.bw", "Yeast_ChIP_Pol2-vs-input.bw", "Yeast_annotations.gtf")),
  height = 540
) |>
  chromosomix_goto("IV:400,001-460,000")
```

## In Shiny

```r
library(shiny)
library(chromosomix)

map <- "https://rsglab-data.s3.eu-west-3.amazonaws.com/demo/yeast/Yeast_microC_G2M_1kb.cool"

ui <- fluidPage(
  textInput("where", "Go to", "IV:1150000-1300000"),
  actionButton("go", "Go"),
  chromosomixOutput("view", height = "800px"),
  verbatimTextOutput("region")
)

server <- function(input, output, session) {
  output$view <- renderChromosomix(chromosomix(map, region = "IV:1000000-1400000"))
  observeEvent(input$go, chromosomix_goto(chromosomixProxy("view"), input$where))
  output$region <- renderText(input$view_state$region)
}

shinyApp(ui, server)
```

![The Shiny app above after a press on Go: the Go to box holding IV:1150000-1300000, the widget's map gone to IV:1,150,001-1,300,000, and under it the region the viewer reports back to R, IV:1150000-1300000.](../../../assets/screens/embed/r-shiny-app.webp)

- `chromosomixOutput()` places the widget (`"100%"` wide, `"600px"` high by default); `renderChromosomix()` draws it, as a new frame each time.
- `chromosomixProxy("view")` drives the widget on screen without redrawing it: pass it to `chromosomix_goto()`, `chromosomix_navigate()` or `chromosomix_add()` in place of a widget.
- The viewer reports back as inputs named after the output, here `view`:

| Input | What it is |
| --- | --- |
| `input$view_state` | where the view is: a list of the keys a link carries (`uri`, `view`, `region`, `locus`…), `NULL` on the landing page. It changes as the reader pans, zooms and changes the scale |
| `input$view_rendered` | the report of the last finished picture: what is drawn, at which resolution |
| `input$view_version` | the viewer's version, once its frame is up |
| `input$view_notice` | what the frame could not do — a viewer too old to take files |

A fuller app comes with the package: `shiny::runApp(system.file("examples", "app.R", package = "chromosomix"))`.

## Files on this machine

This R session serves a path to the viewer by byte range, from `127.0.0.1`, while R is idle. Nothing is uploaded.

- The file's folder is served, so sidecars beside it (`.bai`, `.fai`, `.tbi`, `.px2`) are found. Nothing else is served but what its links point to, and never a name starting with a dot.
- A link is followed, with its index read from beside the link, as DataLad and git-annex files need.
- `serve(file)` returns the address the viewer reads a local file at; `address(file)` keeps an address and serves a path.

:::caution[A rendered page draws local files only while R runs]
A Knit or a `quarto render` ends once the page is written, so a page for other people names its files by address: `https://`, `s3://`, `gs://`, a Dropbox or Google Drive share. Knitting warns at the first local file served.
:::

Behind RStudio Server, only a viewer this session serves (`install_viewer()`'s, or a built `dist/`) reads local files. `CHROMOSOMIX_PUBLIC_URL`, with `{port}` where the port goes, names any other way in.

## Which viewer

`viewer =`, or the option `chromosomix.viewer`, names the build in the frame:

| `viewer =` | The build |
| --- | --- |
| nothing | `CHROMOSOMIX_VIEWER` if it is set, else a build fetched by `install_viewer()`, else https://chromosomix.app/ |
| a version, `"0.17.0"` | that release, kept for good at `https://chromosomix.app/v/v0.17.0/`: what a page that must draw the same picture next year names |
| an address | any build, a lab's own copy of the viewer among them |
| a folder | a built `dist/` on this machine, served beside the data |

**Tracks need a viewer from 0.17.0 on.** An older build draws the map but nothing the widget adds, and says so above the frame (in Shiny, as `input$<id>_notice`); naming an older release warns at once.

**With files on this machine, prefer a build served beside them.** `install_viewer()` fetches the viewer from npm once (checked with openssl, if installed) and caches it in R's user cache directory, or `CHROMOSOMIX_CACHE`, so the page works offline. `install_viewer("0.19.0")` fetches a given release; a knitted page names it by its release's address on the site. Otherwise Chrome asks the reader once to let the site reach this machine.

## The examples

`system.file("examples", "demo.Rmd", package = "chromosomix")` is an R Markdown page of the yeast demo. The widget is an embed, which keeps and drops what [an embedded view](/embed/web-page/) does; the package's notes are in [its README](https://github.com/js2264/chromosomix/blob/main/widgets/r/README.md).
