# The viewer as an htmlwidget (SPECS §21.5): the app's embed, `?embed=1` in an
# <iframe>, and its `postMessage` channel (§21.4) between the frame and R.
#
# What the frame opens on is its address: the map and every view keyword in the
# fragment, as the app's address bar writes them. The tracks — which the
# fragment has no word for — go to the frame as one `chromosomix:add` once it
# says it is ready. Moves and additions asked of it after that are requests:
# laid on the widget before it is drawn (`chromosomix(...) |> chromosomix_goto(...)`,
# which a static R Markdown page is made of), or sent through a Shiny proxy;
# either way the frame makes them in order, and all of them again when it
# reloads. What the viewer says back reaches R in Shiny, as inputs.

# The view state's keys, in the order the app writes them (`state/ViewState.ts`).
KEY_ORDER <- c(
  "uri", "uri2", "maps", "view", "genome", "genome2", "genomes", "region", "region2", "focus",
  "regions", "cells", "contacts", "locus", "level", "coarsen", "transform", "colormap", "vmin",
  "vmax", "balance", "score", "oe", "arms", "smooth", "op", "flip"
)

# A value as the fragment spells it: a switch as `true` or `false`, a number
# whole rather than in R's scientific notation.
value_text <- function(value) {
  if (is.logical(value)) return(if (isTRUE(value)) "true" else "false")
  if (is.numeric(value)) return(format(value, scientific = FALSE, trim = TRUE, digits = 15))
  as.character(value)
}

# Percent-escaped as the app writes its fragment: letters, digits, `-_.~` and
# the `/:,|` it leaves readable.
escape <- function(text) {
  bytes <- charToRaw(enc2utf8(text))
  safe <- bytes %in% charToRaw("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.~/:,|")
  out <- sprintf("%%%02X", as.integer(bytes))
  out[safe] <- vapply(bytes[safe], rawToChar, "")
  paste(out, collapse = "")
}

# A view state as the app writes it into the fragment: its keys in order.
view_hash <- function(state) {
  state <- state[!vapply(state, is.null, NA)]
  keys <- c(intersect(KEY_ORDER, names(state)), setdiff(names(state), KEY_ORDER))
  paste(sprintf("%s=%s", keys, vapply(keys, function(key) escape(value_text(state[[key]])), "")), collapse = "&")
}

# A locus as the address bar writes one: a string as given, a sequence, start
# and end as `seq:start-end`.
locus_text <- function(where) {
  if (is.character(where) && length(where) == 1L) return(where)
  if (length(where) == 3L) {
    parts <- as.list(where)
    whole <- function(value) format(as.numeric(value), scientific = FALSE, trim = TRUE)
    return(sprintf("%s:%s-%s", as.character(parts[[1]]), whole(parts[[2]]), whole(parts[[3]])))
  }
  stop("A locus is a string, such as \"II:100000-200000\", or a sequence, a start and an end.", call. = FALSE)
}

addresses <- function(files) {
  files <- unlist(files, use.names = FALSE)
  if (length(files) == 0L) return(character())
  vapply(files, address, "", USE.NAMES = FALSE)
}

#' The chromosomix viewer as an HTML widget
#'
#' The viewer itself — a contact map with its tracks, a 1D genome browser, a 3D
#' model beside a map, with its side panels and its gestures — in an R Markdown
#' document, a Quarto page, the RStudio viewer or a Shiny app. It is the
#' viewer's own embed in an `<iframe>`, driven over its message channel.
#'
#' Files are addresses — any the app opens: `https://`, `s3://`, `gs://`, a
#' Dropbox or Google Drive share — or paths on this machine, served to the
#' viewer by byte range from this R session ([serve()]). A rendered document
#' that will be read elsewhere names its files by address.
#'
#' @param map The contact map the view opens on: `.cool`, `.mcool` (with
#'   `::/resolutions/<bin>`), `.hic`, `.pairs`, … — or `NULL` for a 1D browser
#'   of the tracks alone, whose first file becomes the tab's.
#' @param tracks Files put in the view once it is drawn, in order, as the
#'   header's `+` puts them: a track beside the map, another map beside it, a 3D
#'   model, a workspace.
#' @param region Where the map is framed: `"IV:1000000-1400000"`, or a
#'   sequence, a start and an end.
#' @param locus Where a 1D browser is placed, written the same way.
#' @param ... Any other key of the view state as the app's address bar carries
#'   it: `transform` (`"log10"`, `"log2"`, `"log1p"`, `"none"`), `colormap`,
#'   `balance`, `vmin`, `vmax`, `oe`, `smooth`, `view`, ….
#' @param viewer The build of the viewer in the frame; see [resolve_viewer()].
#' @param title The frame's title, for a screen reader.
#' @param width,height The widget's size: CSS units, or a number of pixels.
#' @param elementId An id for the widget's element.
#' @return An htmlwidget. [chromosomix_goto()], [chromosomix_navigate()] and
#'   [chromosomix_add()] lay requests on it before it is drawn.
#' @seealso [chromosomixOutput()] and [chromosomixProxy()] for Shiny.
#' @examples
#' \dontrun{
#' yeast <- "https://rsglab-data.s3.eu-west-3.amazonaws.com/demo/yeast"
#' chromosomix(
#'   file.path(yeast, "Yeast_microC_G2M_1kb.cool"),
#'   region = "IV:1000000-1400000",
#'   tracks = file.path(yeast, c("Yeast_ATAC.bw", "Yeast_annotations.gtf")),
#'   transform = "log10"
#' )
#' }
#' @export
chromosomix <- function(map = NULL, tracks = character(), region = NULL, locus = NULL, ...,
                        viewer = NULL, title = "chromosomix", width = "100%", height = 600,
                        elementId = NULL) {
  view <- list(...)
  if (length(view) > 0L && (is.null(names(view)) || any(names(view) == ""))) {
    stop("Every view keyword is named, as the address bar names it: transform = \"log10\", oe = TRUE.", call. = FALSE)
  }
  base <- resolve_viewer(viewer)
  src <- paste0(base, "?embed=1")
  if (!is.null(map)) {
    state <- list(uri = address(map))
    if (!is.null(region)) {
      state$view <- "region"
      state$region <- locus_text(region)
    }
    if (!is.null(locus)) state$locus <- locus_text(locus)
    state[names(view)] <- view
    src <- paste0(src, "#", view_hash(state))
  }
  x <- list(
    src = src,
    files = I(addresses(tracks)),
    title = title,
    # What `chromosomix_goto()` moves until the viewer has said what it shows:
    # with no map, the 1D browser's locus.
    browser = is.null(map) || identical(view$view, "browser"),
    requests = list()
  )
  htmlwidgets::createWidget(
    "chromosomix", x,
    width = width, height = height, package = "chromosomix", elementId = elementId,
    sizingPolicy = htmlwidgets::sizingPolicy(
      defaultWidth = "100%", defaultHeight = height, padding = 0,
      viewer.fill = TRUE, browser.fill = TRUE,
      knitr.figure = FALSE, knitr.defaultWidth = "100%", knitr.defaultHeight = height
    )
  )
}

#' Move the viewer, and put more files in it
#'
#' Three requests, made of a widget before it is drawn — piped onto
#' [chromosomix()], which is how a static R Markdown page moves its views — or
#' of one on screen in Shiny, through [chromosomixProxy()]. The frame makes them
#' in the order they were made, each once the one before it is done: a locus
#' asked for after tracks were added is the locus on those tracks.
#'
#' * `chromosomix_goto()` frames a region of the map — or places the 1D
#'   browser, when that is what the view shows.
#' * `chromosomix_navigate()` lays a patch over the view: any key the app's
#'   address bar carries; `NULL` takes one away.
#' * `chromosomix_add()` puts files in the view as the header's `+` does: a track
#'   among the tracks, another map or a 3D model beside the map, a workspace.
#'
#' @param view A widget from [chromosomix()], or a proxy from
#'   [chromosomixProxy()].
#' @param where `"II:100000-200000"`, or a sequence, a start and an end.
#' @param ... `chromosomix_navigate()`: keys of the view state and their values,
#'   named. `chromosomix_add()`: files, as addresses or paths ([address()]).
#' @return `view`, so the requests chain.
#' @examples
#' \dontrun{
#' chromosomix(map, tracks = "ATAC.bw") |>
#'   chromosomix_goto("IV:1150000-1300000") |>
#'   chromosomix_navigate(transform = "log2", oe = TRUE) |>
#'   chromosomix_add("Yeast_structure.g3d.gz")
#' }
#' @name chromosomix-requests
NULL

#' @rdname chromosomix-requests
#' @export
chromosomix_goto <- function(view, where) {
  ask(view, list(type = "goto", where = locus_text(where)))
}

#' @rdname chromosomix-requests
#' @export
chromosomix_navigate <- function(view, ...) {
  patch <- list(...)
  if (length(patch) == 0L) return(view)
  if (is.null(names(patch)) || any(names(patch) == "")) stop("Every key is named: transform = \"log2\".", call. = FALSE)
  state <- lapply(patch, function(value) if (is.null(value)) NULL else value_text(value))
  ask(view, list(type = "navigate", state = state))
}

#' @rdname chromosomix-requests
#' @export
chromosomix_add <- function(view, ...) {
  files <- addresses(list(...))
  if (length(files) == 0L) return(view)
  ask(view, list(type = "add", files = I(files)))
}

ask <- function(view, request) {
  if (inherits(view, "chromosomix_proxy")) {
    view$session$sendCustomMessage("chromosomix-request", list(id = view$id, request = request))
    return(invisible(view))
  }
  if (inherits(view, "chromosomix") && inherits(view, "htmlwidget")) {
    view$x$requests <- c(view$x$requests, list(request))
    return(view)
  }
  stop("A request is made of a widget from chromosomix() or a proxy from chromosomixProxy().", call. = FALSE)
}
