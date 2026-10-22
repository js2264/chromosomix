# What the widget hands its frame: the address, the view in it, and the
# requests after (SPECS §21.5).

local_no_viewer <- function(env = parent.frame()) {
  old <- options(chromosomix.viewer = NULL)
  oldenv <- Sys.getenv(c("CHROMOSOMIX_VIEWER", "CHROMOSOMIX_CACHE", "CHROMOSOMIX_PUBLIC_URL"), unset = NA)
  Sys.unsetenv(c("CHROMOSOMIX_VIEWER", "CHROMOSOMIX_PUBLIC_URL"))
  Sys.setenv(CHROMOSOMIX_CACHE = tempfile("no-cache-"))
  do.call(on.exit, list(substitute({
    options(old)
    for (name in names(oldenv)) if (is.na(oldenv[[name]])) Sys.unsetenv(name) else do.call(Sys.setenv, as.list(oldenv[name]))
  }, list(old = old, oldenv = oldenv)), add = TRUE), envir = env)
}

fragment <- function(widget) {
  body <- sub("^[^#]*#", "", widget$x$src)
  parts <- strsplit(strsplit(body, "&", fixed = TRUE)[[1]], "=", fixed = TRUE)
  stats::setNames(lapply(parts, function(p) utils::URLdecode(p[[2]])), vapply(parts, `[[`, "", 1))
}

test_that("it frames the site with the view in its fragment", {
  local_no_viewer()
  view <- chromosomix("https://data.example/yeast.cool", region = "IV:1000000-1400000", transform = "log10", balance = TRUE)
  expect_match(view$x$src, "^https://chromosomix\\.app/\\?embed=1#")
  expect_equal(fragment(view), list(
    uri = "https://data.example/yeast.cool", view = "region", region = "IV:1000000-1400000",
    transform = "log10", balance = "true"
  ))
  expect_length(view$x$files, 0L)
  expect_false(view$x$browser)
})

test_that("it writes the fragment in the app's key order and spelling", {
  expect_equal(
    chromosomix:::view_hash(list(transform = "log2", uri = "https://d.example/a.mcool::/resolutions/5000", vmax = 12.5)),
    "uri=https://d.example/a.mcool::/resolutions/5000&transform=log2&vmax=12.5"
  )
  expect_equal(
    chromosomix:::view_hash(list(uri = "a b.cool", maps = "b.cool|c.cool", locus = "I:1,000-2,000", contacts = 1e7)),
    "uri=a%20b.cool&maps=b.cool|c.cool&contacts=10000000&locus=I:1,000-2,000"
  )
})

test_that("a locus is a string, or a sequence, a start and an end written whole", {
  expect_equal(chromosomix:::locus_text("II:1-2"), "II:1-2")
  expect_equal(chromosomix:::locus_text(c("II", 100000, 200000)), "II:100000-200000")
  expect_equal(chromosomix:::locus_text(list("II", 1e5, 2e5)), "II:100000-200000")
  expect_error(chromosomix:::locus_text(c("II", 1)), "start and an end")
})

test_that("tracks go to the frame once the map is up, and with no map it opens on its picker", {
  local_no_viewer()
  view <- chromosomix("https://d.example/a.cool", tracks = c("https://d.example/ATAC.bw", "s3://bucket/genes.gtf"))
  expect_equal(as.character(view$x$files), c("https://d.example/ATAC.bw", "s3://bucket/genes.gtf"))
  browser <- chromosomix(tracks = "https://d.example/ATAC.bw")
  expect_equal(browser$x$src, "https://chromosomix.app/?embed=1")
  expect_true(browser$x$browser)
  # One file is still a list to the frame, not a string.
  expect_match(as.character(htmlwidgets:::toJSON(browser$x)), '"files":\\["https://d.example/ATAC.bw"\\]')
})

test_that("a local file is served from this session, its group kept", {
  dir <- tempfile("data-")
  dir.create(dir)
  on.exit(unlink(dir, recursive = TRUE), add = TRUE)
  writeBin(charToRaw("\x89HDF\r\n\x1a\n"), file.path(dir, "sample.mcool"))
  served <- address(paste0(file.path(dir, "sample.mcool"), "::/resolutions/5000"))
  expect_match(served, "^http://127\\.0\\.0\\.1:[0-9]+/[0-9a-f]{32}/sample\\.mcool::/resolutions/5000$")
  expect_error(address(file.path(dir, "nothing.cool")), "not a file")
})

test_that("a release is named by its permanent address, and a build by its own", {
  local_no_viewer()
  expect_equal(resolve_viewer("0.16.0"), "https://chromosomix.app/v/v0.16.0/")
  expect_equal(resolve_viewer("v0.16.0"), "https://chromosomix.app/v/v0.16.0/")
  expect_equal(resolve_viewer("https://lab.example/viewer"), "https://lab.example/viewer/")
  expect_equal(resolve_viewer(), "https://chromosomix.app/")
  old <- options(chromosomix.viewer = "0.15.0")
  on.exit(options(old), add = TRUE)
  expect_equal(resolve_viewer(), "https://chromosomix.app/v/v0.15.0/")
})

test_that("a local build is served beside the data", {
  local_no_viewer()
  dir <- tempfile("dist-")
  dir.create(dir)
  on.exit(unlink(dir, recursive = TRUE), add = TRUE)
  writeLines("<!doctype html>", file.path(dir, "index.html"))
  expect_match(resolve_viewer(dir), "^http://127\\.0\\.0\\.1:[0-9]+/[0-9a-f]{32}/$")
  expect_error(resolve_viewer(file.path(dir, "nothing-here")), "no index.html")
})

test_that("requests are laid on the widget in order, as the frame will make them", {
  local_no_viewer()
  view <- chromosomix("https://d.example/a.cool") |>
    chromosomix_goto(c("II", 100000, 200000)) |>
    chromosomix_navigate(transform = "log2", oe = TRUE, vmax = NULL) |>
    chromosomix_add("https://d.example/b.bw")
  expect_equal(view$x$requests, list(
    list(type = "goto", where = "II:100000-200000"),
    list(type = "navigate", state = list(transform = "log2", oe = "true", vmax = NULL)),
    list(type = "add", files = I("https://d.example/b.bw"))
  ))
  # A key taken away reaches the frame as null.
  expect_match(as.character(htmlwidgets:::toJSON(view$x)), '"vmax":null')
  expect_error(chromosomix_goto(list(), "I:1-2"), "widget from chromosomix")
  expect_error(chromosomix("https://d.example/a.cool", character(), NULL, NULL, "log10"), "named")
})

test_that("a proxy sends each request to its output, namespaced", {
  sent <- list()
  session <- list(
    ns = function(id) paste0("mod-", id),
    sendCustomMessage = function(type, message) sent[[length(sent) + 1L]] <<- list(type = type, message = message)
  )
  proxy <- chromosomixProxy("view", session = session)
  chromosomix_goto(proxy, "IV:1-2")
  chromosomix_add(proxy, "https://d.example/b.bw")
  expect_equal(sent[[1]], list(type = "chromosomix-request", message = list(id = "mod-view", request = list(type = "goto", where = "IV:1-2"))))
  expect_equal(sent[[2]]$message$request$files, I("https://d.example/b.bw"))
})

test_that("it warns when a release too old to take files is given some", {
  local_no_viewer()
  expect_warning(
    chromosomix("https://d.example/a.cool", tracks = "https://d.example/a.bw", viewer = "0.16.0"),
    "cannot take files"
  )
  view <- chromosomix("https://d.example/a.cool", viewer = "0.16.0")
  expect_warning(chromosomix_add(view, "https://d.example/b.bw"), "1 will not be added")
  # A release that takes them, or a build that names no release, says nothing here.
  expect_no_warning(chromosomix("https://d.example/a.cool", tracks = "https://d.example/a.bw", viewer = "0.17.0"))
  expect_no_warning(chromosomix("https://d.example/a.cool", tracks = "https://d.example/a.bw", viewer = "https://lab.example/v/"))
})
