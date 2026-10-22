# chromosomix for R

The [chromosomix](https://chromosomix.app/) viewer as an htmlwidget: a contact map with its tracks,
a 1D genome browser or a 3D model on an R Markdown page, a Quarto page, the RStudio viewer or a
Shiny app — the app itself, its side panels and its gestures — driven from R, and in Shiny telling R
where the reader has taken it.

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

The package's examples walk through it on the repository's yeast demo:
`system.file("examples", "demo.Rmd", package = "chromosomix")`, an R Markdown page, and
`shiny::runApp(system.file("examples", "app.R", package = "chromosomix"))`, the same map in Shiny.

## Install

```r
# from a clone of the repository
install.packages("widgets/r", repos = NULL, type = "source")
# or
remotes::install_github("js2264/chromosomix", subdir = "widgets/r")
```

It needs htmlwidgets, httpuv and jsonlite. Nothing is uploaded: the viewer reads every file from where
it is, by byte range.

## Files

A file is an **address** — any the app opens: `https://`, `s3://`, `gs://`, a Dropbox or Google Drive
share — or a **path on this machine**, which this R session serves to the viewer by byte range from a
small server on `127.0.0.1` (`serve()`). A path's directory is what is served, under a random token, so
a file's sidecars — `.bai`, `.fai`, `.tbi`, `.px2` — are read from beside it as the app expects.
Nothing outside a directory you named a file in is served. A `::` after a container names a group in
it, as in the app: `"sample.mcool::/resolutions/5000"`.

The server answers while R is idle: at the console, in RStudio, under Shiny. **A rendered page that
names local files draws them only while the R session that rendered it runs**, so a page that will be
read elsewhere names its files by address. Behind RStudio Server the server is reached through
RStudio's own proxy (with rstudioapi installed); `CHROMOSOMIX_PUBLIC_URL` names any other way in, with
`{port}` where the port goes.

## Which viewer

`viewer =` — or the option `chromosomix.viewer` — names the build in the frame:

| `viewer =` | the build |
|---|---|
| nothing | `CHROMOSOMIX_VIEWER` if set, else a build fetched by `install_viewer()`, else https://chromosomix.app/ |
| `"0.17.0"` | that release, kept for ever at `https://chromosomix.app/v/v0.17.0/` — what a page that must draw the same picture next year names |
| an address | any build, a lab's own copy of the npm package's `dist/` among them |
| a directory | a built `dist/` on this machine, served beside the data |

**Tracks need a viewer from 0.17.0 on.** The frame takes the files a widget adds — its `tracks`, and
`chromosomix_add()` — through a message the viewer learned in 0.17.0. An older build draws the map and
nothing it adds, and says so above the frame (and, in Shiny, as `input$<id>_notice`); naming an older
release warns when the widget is made.

**With files on this machine, prefer a build served beside them.** `install_viewer()` fetches the npm
package once into R's user cache directory; every widget after uses it, so the app and the data are one
origin and the page works offline. The site in the frame reading `http://127.0.0.1` works too, but
Chrome asks the reader once to let the page reach this machine.

## Driving it

Laid on a widget before it is drawn, which is how a static page moves its views:

```r
chromosomix(map, tracks = c("ATAC.bw", "MNase.bw")) |>
  chromosomix_goto("IV:1150000-1300000") |>          # a region — or a locus, in the 1D browser
  chromosomix_navigate(transform = "log2", oe = TRUE) |> # any key the address bar carries; NULL removes one
  chromosomix_add("Yeast_structure.g3d.gz")            # the header's +: a track, a map, a 3D model
```

Or, in Shiny, of a widget on screen, through a proxy; what the viewer says comes back as inputs:

```r
output$view <- renderChromosomix(chromosomix(map, region = "IV:1000000-1400000"))
observeEvent(input$go, chromosomix_goto(chromosomixProxy("view"), input$where))
output$region <- renderText(input$view_state$region)   # also input$view_rendered, _version, _notice
```

Each request is made in order, once the one before it is done: a locus asked for after tracks were
added is the locus on those tracks.

## How it works

The widget is the viewer's embed (`?embed=1`, SPECS §21 in the repository) in an `<iframe>`. Its
`postMessage` channel carries `chromosomix:navigate`, `chromosomix:where` and `chromosomix:add` from the
page and `chromosomix:state` and `chromosomix:rendered` back; the view the widget opens on is in the
frame's fragment, as a link to the app carries it. The Jupyter widget in `widgets/python/` is the same
frame and the same conversation.

## Licence

GPL (>= 3), as chromosomix.
