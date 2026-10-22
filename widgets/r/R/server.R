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
#   in, under a random token, so its sidecars are where the viewer looks for
#   them without being named one by one. Nothing outside a registered directory
#   is served, and a path that climbs out of one is refused.
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
# viewer must not be sent.

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

# 128 bits from the system's random source, as hex.
new_token <- function() {
  bytes <- NULL
  if (file.exists("/dev/urandom")) {
    con <- file("/dev/urandom", "rb", raw = TRUE)
    on.exit(close(con))
    bytes <- readBin(con, raw(), 16L)
  }
  if (length(bytes) != 16L) {
    # Windows: R's generator, but under a seed of its own, so neither a
    # script's `set.seed()` decides the token nor drawing it moves the script's
    # stream.
    old <- if (exists(".Random.seed", globalenv(), inherits = FALSE)) get(".Random.seed", globalenv()) else NULL
    on.exit(if (is.null(old)) rm(".Random.seed", envir = globalenv()) else assign(".Random.seed", old, globalenv()), add = TRUE)
    set.seed(as.integer((as.numeric(Sys.time()) * 1e3 + Sys.getpid()) %% .Machine$integer.max))
    bytes <- as.raw(sample.int(256L, 16L, replace = TRUE) - 1L)
  }
  paste(sprintf("%02x", as.integer(bytes)), collapse = "")
}

refuse <- function(status, headers = list()) {
  list(status = as.integer(status), headers = c(.cors, headers), body = raw(0))
}

# The file a request names, or NULL: under a registered token, inside its
# directory, a directory's own `index.html` for the directory.
resolve_request <- function(path_info, roots) {
  path <- utils::URLdecode(path_info)
  m <- regmatches(path, regexec("^/([^/]+)/(.*)$", path))[[1]]
  if (length(m) == 0L) return(NULL)
  root <- get0(m[[2]], envir = roots, inherits = FALSE)
  if (is.null(root)) return(NULL)
  rest <- strsplit(m[[3]], "/", fixed = TRUE)[[1]]
  if (any(rest %in% c("..", "."))) return(NULL)
  target <- if (length(rest) == 0L) root else file.path(root, paste(rest, collapse = "/"))
  if (dir.exists(target)) target <- file.path(target, "index.html")
  if (!file.exists(target) || dir.exists(target)) return(NULL)
  # And not out of it by a link either: the file as the disk resolves it.
  resolved <- normalizePath(target, winslash = "/", mustWork = TRUE)
  if (!startsWith(resolved, paste0(root, "/"))) return(NULL)
  resolved
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
  start <- 0
  end <- size - 1
  ranged <- req$HTTP_RANGE
  if (!is.null(ranged)) {
    asked <- trimws(ranged)
    m <- regmatches(asked, regexec("^bytes=([0-9]*)-([0-9]*)$", asked))[[1]]
    if (length(m) == 0L || (m[[2]] == "" && m[[3]] == "")) return(refuse(416L))
    if (m[[2]] == "") {
      start <- max(0, size - as.numeric(m[[3]]))
    } else {
      start <- as.numeric(m[[2]])
      if (m[[3]] != "") end <- min(size - 1, as.numeric(m[[3]]))
    }
    if (start >= size || start > end) {
      return(refuse(416L, list("Content-Range" = sprintf("bytes */%.0f", size))))
    }
  }
  length <- end - start + 1
  headers <- c(.cors, list("Content-Type" = type_of(path), "Cache-Control" = "no-cache"))
  if (!is.null(ranged)) headers[["Content-Range"]] <- sprintf("bytes %.0f-%.0f/%.0f", start, end, size)
  status <- if (is.null(ranged)) 200L else 206L
  if (identical(method, "HEAD")) {
    headers[["Content-Length"]] <- sprintf("%.0f", length)
    return(list(status = status, headers = headers, body = NULL))
  }
  # One raw vector is the answer, so one answer is at most what a raw vector
  # holds. The viewer asks a large file for ranges a megabyte or so long, and
  # only a small one whole.
  if (length > .Machine$integer.max) return(refuse(413L))
  con <- file(path, "rb")
  on.exit(close(con))
  if (start > 0) seek(con, start)
  list(status = status, headers = headers, body = readBin(con, raw(), n = as.integer(length)))
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
    token <- new_token()
    assign(directory, token, envir = files$tokens)
    assign(token, directory, envir = files$roots)
  }
  token
}

# The server path a local file is read at, its directory registered — its
# sidecars with it.
path_of <- function(file) {
  target <- normalizePath(path.expand(file), winslash = "/", mustWork = FALSE)
  if (!file.exists(target) || dir.exists(target)) {
    stop(sprintf("%s is not a file on this machine.", target), call. = FALSE)
  }
  sprintf("/%s/%s", token_for(dirname(target)), utils::URLencode(basename(target), reserved = TRUE))
}

# The server path a whole directory is read under, with a trailing slash.
directory_path <- function(directory) {
  target <- normalizePath(path.expand(directory), winslash = "/", mustWork = FALSE)
  if (!dir.exists(target)) stop(sprintf("%s is not a directory on this machine.", target), call. = FALSE)
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
#' file's whole directory under a random token so its sidecars (`.bai`, `.fai`,
#' `.tbi`, `.px2`) are read from beside it. Nothing outside a directory a file
#' was named in is served. `address()` is what every function here calls on a
#' file: an address (`https://`, `s3://`, `gs://`, a Dropbox or Google Drive
#' share) is kept as it is, and a local path is served.
#'
#' The server answers while R is idle — at the console, in RStudio, under
#' Shiny. A rendered R Markdown document that names local files draws them only
#' while the R session that rendered it is running; one that will be read
#' elsewhere names its files by address.
#'
#' Behind RStudio Server the server is reached through RStudio's proxy (with
#' the rstudioapi package installed); `CHROMOSOMIX_PUBLIC_URL`, with `{port}`
#' where the port goes, names any other way in.
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
