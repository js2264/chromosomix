# Files on this machine, served to the viewer by byte range (SPECS §21.5).
#
# The viewer reads a file by range, a megabyte at a time, from wherever it is
# addressed: it never downloads a map whole, and it reads a sidecar — a `.bai`,
# a `.fai`, a `.px2`, a `.tbi` — from beside the file it belongs to. A file on
# this disk has no address, so this gives it one: an httpuv server on
# 127.0.0.1, in this R session, answering `GET` and `HEAD` with the `Range` the
# viewer asks for, and nothing else. The same three decisions as the Python
# widget's server (`widgets/python/src/chromosomix/server.py`):
#
# - **A directory, not a file.** What is registered is the directory a file is
#   named in, under a random token, so its sidecars are where the viewer looks
#   for them without being named one by one. A path that climbs out of one is
#   refused, and so is any name that starts with a dot — `.git`, `.ssh`, `..` —
#   which no file the viewer asks for has. A link in the directory is followed
#   wherever it points: whoever owns the directory made it, and a DataLad or
#   git-annex file is a link into `.git/annex`, its `.bai` another beside it.
# - **Tokens, not paths.** The server is on the loopback interface, so only this
#   machine reaches it; the token — 128 bits from the system's random source,
#   not from R's generator, which a script's `set.seed()` makes predictable —
#   keeps another page in this machine's browser from reading the disk by
#   guessing.
# - **Answered for any origin.** Every answer allows a cross-origin read and
#   exposes `Content-Length` and `Content-Range`, and a preflight is told
#   `Access-Control-Allow-Private-Network`, because the viewer may be the public
#   site reading a file on 127.0.0.1. The token is the access control.
#
# httpuv answers on R's own event loop: a file is read while R is idle — at the
# console, in RStudio, under Shiny — and waits while a chunk is still running.
# Its static paths would answer from a thread of their own, but they ignore
# `Range` and send a file whole, which for a contact map is the one thing the
# viewer must not be sent. A whole file — asked for with no range — is handed
# to httpuv to send from the disk, without passing through R.

.files <- new.env(parent = emptyenv())

# Types a browser needs named rather than guessed: a module script, wasm, a
# manifest. A `.gz` is its own bytes and never a body to inflate in transit —
# the viewer reads a bgzipped file by range, and `Content-Encoding: gzip` would
# make every range a slice of a compressed stream — so it is sent as bytes.
.types <- c(
  js = "text/javascript",
  mjs = "text/javascript",
  wasm = "application/wasm",
  webmanifest = "application/manifest+json",
  json = "application/json",
  html = "text/html; charset=utf-8",
  css = "text/css",
  svg = "image/svg+xml",
  png = "image/png",
  ico = "image/x-icon",
  woff2 = "font/woff2",
  txt = "text/plain; charset=utf-8"
)

.cors <- list(
  "Access-Control-Allow-Origin" = "*",
  "Access-Control-Expose-Headers" = "Content-Length, Content-Range, Accept-Ranges",
  "Accept-Ranges" = "bytes"
)

type_of <- function(path) {
  ext <- tolower(tools::file_ext(path))
  if (ext %in% names(.types)) .types[[ext]] else "application/octet-stream"
}

# 128 bits from the system's random source, as hex: openssl's where it is
# installed, `/dev/urandom` where there is one.
new_token <- function() {
  bytes <- NULL
  if (requireNamespace("openssl", quietly = TRUE)) bytes <- as.vector(openssl::rand_bytes(16L), "raw")
  if (length(bytes) != 16L && file.exists("/dev/urandom")) bytes <- urandom(16L)
  if (length(bytes) != 16L) bytes <- seeded_bytes(16L)
  paste(sprintf("%02x", as.integer(bytes)), collapse = "")
}

urandom <- function(n) {
  con <- file("/dev/urandom", "rb", raw = TRUE)
  on.exit(close(con))
  readBin(con, raw(), n)
}

# Windows without openssl: R's generator, but under a seed of its own — the
# clock, the process and how many this session has drawn, so two drawn in one
# millisecond differ — so neither a script's `set.seed()` decides the token
# nor drawing it moves the script's stream.
seeded_bytes <- function(n) {
  drawn <- (if (is.null(.files$drawn)) 0 else .files$drawn) + 1
  .files$drawn <- drawn
  old <- if (exists(".Random.seed", globalenv(), inherits = FALSE)) get(".Random.seed", globalenv()) else NULL
  on.exit(if (is.null(old)) rm(".Random.seed", envir = globalenv()) else assign(".Random.seed", old, globalenv()))
  seed <- (floor(as.numeric(Sys.time()) * 1e3) + Sys.getpid() * 7919 + drawn * 104729) %% .Machine$integer.max
  set.seed(as.integer(seed))
  as.raw(sample.int(256L, n, replace = TRUE) - 1L)
}

refuse <- function(status, headers = list()) {
  list(status = as.integer(status), headers = c(.cors, headers), body = raw(0))
}

# The file a request names, or NULL: under a registered token, inside its
# directory, a directory's own `index.html` for the directory. Inside is a
# matter of the path as asked, before any link in it is followed: no segment
# that climbs out, nor any that starts with a dot. A link is then followed
# wherever it points.
resolve_request <- function(path_info, roots) {
  path <- tryCatch(utils::URLdecode(path_info), error = function(error) NULL)
  if (is.null(path)) return(NULL)
  m <- regmatches(path, regexec("^/([^/]+)/(.*)$", path))[[1]]
  if (length(m) == 0L) return(NULL)
  root <- get0(m[[2]], envir = roots, inherits = FALSE)
  if (is.null(root)) return(NULL)
  # Split at a backslash too, which is a separator on Windows.
  rest <- strsplit(m[[3]], "[/\\\\]")[[1]]
  if (any(startsWith(rest, "."))) return(NULL)
  # The root `/`, or a drive's `D:/`, already ends in one.
  prefix <- if (endsWith(root, "/")) root else paste0(root, "/")
  target <- paste0(prefix, paste(rest, collapse = "/"))
  if (!startsWith(target, prefix)) return(NULL)
  if (dir.exists(target)) target <- paste0(target, if (endsWith(target, "/")) "" else "/", "index.html")
  if (!file.exists(target) || dir.exists(target)) return(NULL)
  target
}

# The one range a `Range` header asks for, as RFC 9110 §14 reads it:
# `c(start, end)`; `NA` for a range that starts at or past the end, which is
# answered 416; or NULL for a header to ignore and answer with the whole file —
# another unit, several ranges, a start after its end, a number of more than 20
# digits, anything else it cannot read.
asked_range <- function(header, size) {
  m <- regmatches(header, regexec("^bytes=([0-9]{0,20})-([0-9]{0,20})$", trimws(header), ignore.case = TRUE))[[1]]
  if (length(m) == 0L || (m[[2]] == "" && m[[3]] == "")) return(NULL)
  if (m[[2]] == "") {
    # The last bytes: a suffix of the file, or all of it where it is shorter.
    start <- max(0, size - as.numeric(m[[3]]))
    end <- size - 1
  } else {
    start <- as.numeric(m[[2]])
    end <- size - 1
    if (m[[3]] != "") {
      if (as.numeric(m[[3]]) < start) return(NULL)
      end <- min(end, as.numeric(m[[3]]))
    }
  }
  if (start >= size) return(NA)
  c(start, end)
}

# One request, answered: the httpuv app's `call`, apart from the server so a
# test can hand it a request without a socket.
answer_request <- function(req, roots) {
  method <- req$REQUEST_METHOD
  if (identical(method, "OPTIONS")) {
    return(list(
      status = 204L,
      headers = c(.cors, list(
        "Access-Control-Allow-Methods" = "GET, HEAD, OPTIONS",
        "Access-Control-Allow-Headers" = "Range, Content-Type",
        # Chrome asks before a public page reads a private address.
        "Access-Control-Allow-Private-Network" = "true",
        "Access-Control-Max-Age" = "600"
      )),
      body = NULL
    ))
  }
  if (!method %in% c("GET", "HEAD")) return(refuse(405L, list(Allow = "GET, HEAD, OPTIONS")))
  path <- resolve_request(req$PATH_INFO, roots)
  if (is.null(path)) return(refuse(404L))

  size <- file.size(path)
  range <- if (is.null(req$HTTP_RANGE)) NULL else asked_range(req$HTTP_RANGE, size)
  if (identical(range, NA)) return(refuse(416L, list("Content-Range" = sprintf("bytes */%.0f", size))))
  headers <- c(.cors, list("Content-Type" = type_of(path), "Cache-Control" = "no-cache"))
  if (is.null(range)) {
    if (identical(method, "HEAD")) {
      # No `Accept-Ranges` on this one answer: a proxy in front of the server
      # — jupyter-server-proxy, RStudio Server's — can answer a HEAD with a
      # `Content-Length` of 0 and pass that header through, and a viewer that
      # believes the pair opens the map as an empty file. Without it the
      # viewer asks for one byte by range, whose `Content-Range` says the size.
      headers[["Accept-Ranges"]] <- NULL
      headers[["Content-Length"]] <- sprintf("%.0f", size)
      return(list(status = 200L, headers = headers, body = NULL))
    }
    # The whole file, sent by httpuv from the disk: never read into R, so no
    # larger than a file is.
    return(list(status = 200L, headers = headers, body = list(file = path, owned = FALSE)))
  }
  start <- range[[1]]
  end <- range[[2]]
  length <- end - start + 1
  headers[["Content-Range"]] <- sprintf("bytes %.0f-%.0f/%.0f", start, end, size)
  if (identical(method, "HEAD")) {
    headers[["Content-Length"]] <- sprintf("%.0f", length)
    return(list(status = 206L, headers = headers, body = NULL))
  }
  # A range is one raw vector, so at most what a raw vector holds. The viewer
  # asks for ranges a megabyte or so long.
  if (length > .Machine$integer.max) return(refuse(413L))
  con <- file(path, "rb")
  on.exit(close(con))
  if (start > 0) seek(con, start)
  list(status = 206L, headers = headers, body = readBin(con, raw(), n = as.integer(length)))
}

# The session's one server, started on the first file it is asked to serve.
file_server <- function() {
  if (is.null(.files$server)) {
    roots <- new.env(parent = emptyenv())
    port <- httpuv::randomPort(host = "127.0.0.1")
    server <- httpuv::startServer("127.0.0.1", port, list(call = function(req) answer_request(req, roots)))
    .files$roots <- roots
    .files$tokens <- new.env(parent = emptyenv())
    .files$port <- port
    .files$server <- server
  }
  .files
}

# The token a directory is served under, drawn the first time it is asked for.
token_for <- function(directory) {
  files <- file_server()
  token <- get0(directory, envir = files$tokens, inherits = FALSE)
  if (is.null(token)) {
    repeat {
      token <- new_token()
      if (!exists(token, envir = files$roots, inherits = FALSE)) break
    }
    assign(directory, token, envir = files$tokens)
    assign(token, directory, envir = files$roots)
  }
  token
}

# The server path a local file is read at, its directory registered — its
# sidecars with it. The directory is the one the file is named in and the file
# is served by the name it is given there, a link as itself: the sidecars
# beside a link are the ones the viewer is to read, wherever it points.
path_of <- function(file) {
  given <- path.expand(as.character(file))
  directory <- normalizePath(dirname(given), winslash = "/", mustWork = FALSE)
  name <- basename(given)
  target <- paste0(directory, if (endsWith(directory, "/")) "" else "/", name)
  if (!file.exists(target) || dir.exists(target)) {
    stop(sprintf("%s is not a file on this machine.", target), call. = FALSE)
  }
  if (startsWith(name, ".")) {
    stop(sprintf("%s starts with a dot, and no such name is served.", target), call. = FALSE)
  }
  warn_if_knitting()
  sprintf("/%s/%s", token_for(directory), utils::URLencode(name, reserved = TRUE))
}

# Said once a session: a page being knitted is read after its render has
# ended, and this server with it.
warn_if_knitting <- function() {
  if (!isTRUE(getOption("knitr.in.progress")) || isTRUE(.files$warned)) return(invisible(FALSE))
  .files$warned <- TRUE
  warning(
    "This page names files on this machine, which it draws only while this R session runs, and a Knit or ",
    "`quarto render` session ends as soon as the page is written: a page for others names its files by ",
    "address (https://, s3://, ...).",
    call. = FALSE
  )
  invisible(TRUE)
}

# The server path a whole directory is read under, with a trailing slash.
directory_path <- function(directory) {
  target <- normalizePath(path.expand(directory), winslash = "/", mustWork = FALSE)
  if (!dir.exists(target)) stop(sprintf("%s is not a directory on this machine.", target), call. = FALSE)
  warn_if_knitting()
  sprintf("/%s/", token_for(target))
}

# Where the browser reaches the server on `port`, which is not always where R
# does: 127.0.0.1 on a laptop; RStudio Server's own proxy to the port, which
# `rstudioapi::translateLocalUrl()` names; or `CHROMOSOMIX_PUBLIC_URL`, with
# `{port}` where the port goes, for any other way in.
public_base <- function(port) {
  named <- Sys.getenv("CHROMOSOMIX_PUBLIC_URL")
  if (nzchar(named)) return(sub("/+$", "", gsub("{port}", port, named, fixed = TRUE)))
  local <- sprintf("http://127.0.0.1:%d", port)
  if (identical(Sys.getenv("RSTUDIO_PROGRAM_MODE"), "server") &&
    requireNamespace("rstudioapi", quietly = TRUE) && rstudioapi::isAvailable()) {
    return(sub("/+$", "", rstudioapi::translateLocalUrl(paste0(local, "/"), absolute = TRUE)))
  }
  local
}

#' Serve a file on this machine to the viewer
#'
#' `serve()` gives a local file an address the viewer can read by byte range:
#' a server on `127.0.0.1` in this R session, started on first use, serving the
#' directory the file is named in under a random token so its sidecars (`.bai`,
#' `.fai`, `.tbi`, `.px2`) are read from beside it. Nothing outside that
#' directory is served but what a link in it points to — a DataLad or
#' git-annex file is such a link, and its sidecars are read from beside the
#' link — and no name that starts with a dot. `address()` is what every
#' function here calls on a file: an address (`https://`, `s3://`, `gs://`, a
#' Dropbox or Google Drive share) is kept as it is, and a local path is served.
#'
#' The server answers while R is idle — at the console, in RStudio, under
#' Shiny. A rendered R Markdown or Quarto page that names local files draws
#' them only while the R session that rendered it is running, and a Knit or
#' `quarto render` session ends as soon as the page is written: a page for
#' others names its files by address. Knitting, the first local file served
#' says so in a warning, once a session.
#'
#' Behind RStudio Server the server is reached through RStudio's proxy (with
#' the rstudioapi package installed); `CHROMOSOMIX_PUBLIC_URL`, with `{port}`
#' where the port goes, names any other way in. There only a viewer this
#' session serves — [install_viewer()]'s, or a built `dist/` — reads local
#' files: RStudio's proxy asks for its login, which the public site's
#' requests to it do not carry.
#'
#' @param file A path on this machine. With `address()`, an address or a path;
#'   a `::` after a container's path names a group inside it, as in the app
#'   (`"sample.mcool::/resolutions/5000"`), and is kept on the served address.
#' @return The address, a string.
#' @examples
#' address("https://data.example/yeast.mcool::/resolutions/1000")
#' \dontrun{
#' serve("~/data/sample.mcool")
#' }
#' @export
serve <- function(file) {
  files <- file_server()
  paste0(public_base(files$port), path_of(file))
}

#' @rdname serve
#' @export
address <- function(file) {
  text <- as.character(file)
  if (length(text) != 1L || is.na(text)) stop("A file is one address or one path.", call. = FALSE)
  if (grepl("^[A-Za-z][A-Za-z0-9+.-]*://", text)) return(text)
  at <- regexpr("::", text, fixed = TRUE)
  if (at < 0) return(serve(text))
  paste0(serve(substr(text, 1L, at - 1L)), substr(text, at, nchar(text)))
}
