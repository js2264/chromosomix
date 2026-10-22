# Which build of the viewer a widget frames (SPECS §21.5): the widget is the
# viewer's embed, `?embed=1` on a build of the app, in an <iframe>.

# The site, which serves the newest release.
SITE <- "https://chromosomix.app/"

.version_pattern <- "^v?[0-9]+\\.[0-9]+\\.[0-9]+([-.+][0-9A-Za-z.-]+)?$"

# The first release whose frame takes files from R (`chromosomix:add`, SPECS
# §21.4). An older one draws the map the fragment names and nothing the widget
# adds.
TAKES_FILES <- numeric_version("0.17.0")

# The release a viewer's address names — the site's `/v/vX.Y.Z/` — or NULL for
# any other build, which says at run time whether it takes files.
release_of <- function(address) {
  found <- regmatches(address, regexec("/v/v([0-9]+\\.[0-9]+\\.[0-9]+)/?$", address))[[1]]
  if (length(found) == 0L) NULL else numeric_version(found[[2]])
}

viewer_cache <- function() {
  root <- Sys.getenv("CHROMOSOMIX_CACHE")
  if (!nzchar(root)) root <- tools::R_user_dir("chromosomix", which = "cache")
  file.path(root, "viewer")
}

#' Which build of the viewer a widget frames
#'
#' The widget is the viewer's own embed in an `<iframe>`, and `viewer` names the
#' build in it:
#'
#' * `NULL` — the option `chromosomix.viewer` where it is set, then the
#'   environment variable `CHROMOSOMIX_VIEWER`, then the newest build
#'   `install_viewer()` fetched, and the site, <https://chromosomix.app/>, where
#'   there is none of them;
#' * a version, `"0.16.0"` or `"v0.16.0"` — the release the site keeps for ever
#'   at `/v/<tag>/`, which is what a document that must draw the same picture
#'   next year names;
#' * an address — any `http(s)://` build, a lab's own copy of the npm package's
#'   `dist/` among them;
#' * a directory — a built `dist/` on this machine, served beside the data
#'   ([serve()]), so the app and the files are one origin and nothing is
#'   fetched from the network.
#'
#' `install_viewer()` fetches the npm package `chromosomix` once — the app built
#' to run from any path — and keeps it in the user's cache directory
#' ([tools::R_user_dir()], or `CHROMOSOMIX_CACHE`); every widget after uses it.
#' With files on this machine that is the build to prefer: the site reading
#' `http://127.0.0.1` works too, but Chrome asks the reader once to let the page
#' reach this machine.
#'
#' @param viewer `NULL`, a version, an address or a directory, as above.
#' @param version The npm version to fetch, or `"latest"`.
#' @return `resolve_viewer()`: the build's address, ending in `/`.
#'   `install_viewer()`: the build's directory. `installed_viewers()`: the
#'   directories of every build fetched, the newest version last.
#' @examples
#' resolve_viewer("0.16.0")
#' resolve_viewer("https://lab.example/viewer")
#' @export
resolve_viewer <- function(viewer = NULL) {
  if (is.null(viewer)) viewer <- getOption("chromosomix.viewer")
  if (is.null(viewer) && nzchar(Sys.getenv("CHROMOSOMIX_VIEWER"))) viewer <- Sys.getenv("CHROMOSOMIX_VIEWER")
  if (is.null(viewer)) {
    installed <- installed_viewers()
    if (length(installed) == 0L) return(SITE)
    viewer <- installed[[length(installed)]]
  }
  text <- as.character(viewer)
  if (grepl("^https?://", text)) return(if (endsWith(text, "/")) text else paste0(text, "/"))
  if (grepl(.version_pattern, text) && !file.exists(text)) {
    tag <- if (startsWith(text, "v")) text else paste0("v", text)
    return(sprintf("%sv/%s/", SITE, tag))
  }
  directory <- normalizePath(path.expand(text), winslash = "/", mustWork = FALSE)
  if (!file.exists(file.path(directory, "index.html"))) {
    stop(
      sprintf(
        "%s is not a build of the viewer: it has no index.html. Name a built dist/, an address, a version such as \"0.16.0\", or nothing for the site.",
        directory
      ),
      call. = FALSE
    )
  }
  paste0(public_base(file_server()$port), directory_path(directory))
}

#' @rdname resolve_viewer
#' @export
installed_viewers <- function() {
  cache <- viewer_cache()
  if (!dir.exists(cache)) return(character())
  found <- list.dirs(cache, recursive = FALSE)
  found <- found[file.exists(file.path(found, "index.html"))]
  if (length(found) == 0L) return(character())
  versions <- numeric_version(sub("^v", "", sub("[-+].*$", "", basename(found))), strict = FALSE)
  found[order(versions)]
}

#' @rdname resolve_viewer
#' @export
install_viewer <- function(version = "latest") {
  meta <- jsonlite::fromJSON(sprintf("https://registry.npmjs.org/chromosomix/%s", version))
  target <- file.path(viewer_cache(), meta$version)
  if (numeric_version(sub("[-+].*$", "", meta$version)) < TAKES_FILES) {
    warning(sprintf(
      "chromosomix %s from npm cannot take files from R: a widget with tracks needs %s or later.",
      meta$version, format(TAKES_FILES)
    ), call. = FALSE)
  }
  if (file.exists(file.path(target, "index.html"))) return(target)
  tarball <- tempfile(fileext = ".tgz")
  on.exit(unlink(tarball), add = TRUE)
  utils::download.file(meta$dist$tarball, tarball, mode = "wb", quiet = TRUE)
  # The built viewer only, and nothing that would land outside it.
  members <- utils::untar(tarball, list = TRUE)
  keep <- members[startsWith(members, "package/dist/") & !grepl("(^|/)\\.\\.(/|$)", members)]
  staging <- tempfile("chromosomix-")
  on.exit(unlink(staging, recursive = TRUE), add = TRUE)
  utils::untar(tarball, files = keep, exdir = staging)
  built <- file.path(staging, "package", "dist")
  if (!file.exists(file.path(built, "index.html"))) {
    stop(sprintf("chromosomix %s on npm has no dist/index.html.", meta$version), call. = FALSE)
  }
  dir.create(target, recursive = TRUE, showWarnings = FALSE)
  file.copy(list.files(built, full.names = TRUE, all.files = TRUE, no.. = TRUE), target, recursive = TRUE)
  target
}
