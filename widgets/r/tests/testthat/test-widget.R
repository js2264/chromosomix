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

test_that("a proxy sends each request to its output, namespaced, once the outputs are sent", {
  sent <- list()
  flushed <- list()
  session <- list(
    ns = function(id) paste0("mod-", id),
    sendCustomMessage = function(type, message) sent[[length(sent) + 1L]] <<- list(type = type, message = message),
    onFlushed = function(callback, once = TRUE) {
      expect_true(once)
      flushed[[length(flushed) + 1L]] <<- callback
    }
  )
  proxy <- chromosomixProxy("view", session = session)
  chromosomix_goto(proxy, "IV:1-2")
  chromosomix_add(proxy, "https://d.example/b.bw")
  # Nothing before the flush: the widget it is for may be drawn in it.
  expect_length(sent, 0L)
  for (callback in flushed) callback()
  expect_equal(sent[[1]], list(type = "chromosomix-request", message = list(id = "mod-view", request = list(type = "goto", where = "IV:1-2"))))
  expect_equal(sent[[2]]$message$request$files, I("https://d.example/b.bw"))
})

test_that("with no map, the locus and the view keywords are a patch made after the files", {
  local_no_viewer()
  view <- chromosomix(tracks = "https://d.example/ATAC.bw", locus = c("IV", 400000, 460000), smooth = 2, region = "IV:1-2")
  expect_equal(view$x$src, "https://chromosomix.app/?embed=1")
  expect_equal(view$x$requests, list(list(type = "navigate", state = list(locus = "IV:400000-460000", smooth = "2"))))
  expect_true(view$x$browser)
  # A region, where no locus is given: the first file may be a map.
  framed <- chromosomix(tracks = "https://d.example/a.mcool", region = "IV:1-2")
  expect_equal(framed$x$requests, list(list(type = "navigate", state = list(view = "region", region = "IV:1-2"))))
  expect_false(framed$x$browser)
  # And the requests laid on after it come after it.
  moved <- chromosomix(tracks = "https://d.example/ATAC.bw", transform = "log2") |> chromosomix_goto("IV:5-6")
  expect_equal(vapply(moved$x$requests, `[[`, "", "type"), c("navigate", "goto"))
  expect_length(chromosomix(tracks = "https://d.example/ATAC.bw")$x$requests, 0L)
})

test_that("a key takes one value, as the address bar writes it", {
  local_no_viewer()
  expect_error(chromosomix("https://d.example/a.cool", genomes = c("a", "b")), "`genomes` is given 2 values.*genomes = \"a,b\"")
  expect_error(chromosomix(tracks = "https://d.example/a.bw", vmax = numeric()), "`vmax` is given 0 values")
  view <- chromosomix("https://d.example/a.cool")
  expect_error(chromosomix_navigate(view, transform = c("log2", "log10")), "`transform` is given 2 values")
  # A locus or a region as a sequence, a start and an end is one.
  view <- chromosomix_navigate(view, locus = c("II", 1, 2), region = list("II", 3, 4), vmax = NULL)
  expect_equal(view$x$requests[[1]]$state, list(locus = "II:1-2", region = "II:3-4", vmax = NULL))
})

test_that("a number is written with a point, whatever OutDec says", {
  local_no_viewer()
  old <- options(OutDec = ",")
  on.exit(options(old), add = TRUE)
  expect_equal(chromosomix:::value_text(12.5), "12.5")
  expect_equal(chromosomix:::locus_text(list("II", 100000.5, 2e5)), "II:100000.5-200000")
  expect_equal(fragment(chromosomix("https://d.example/a.cool", vmax = 2.5))$vmax, "2.5")
  view <- chromosomix_navigate(chromosomix("https://d.example/a.cool"), vmin = 0.25)
  expect_equal(view$x$requests[[1]]$state$vmin, "0.25")
})

test_that("uri, uri2 and the files of a deck are addresses, a local path served", {
  local_no_viewer()
  dir <- tempfile("deck-")
  dir.create(dir)
  on.exit(unlink(dir, recursive = TRUE), add = TRUE)
  writeBin(charToRaw("\x89HDF\r\n\x1a\n"), file.path(dir, "b.mcool"))
  writeBin(charToRaw("\x89HDF\r\n\x1a\n"), file.path(dir, "c.cool"))
  served <- "^http://127\\.0\\.0\\.1:[0-9]+/[0-9a-f]{32}/"
  view <- chromosomix(
    "https://d.example/a.cool",
    uri2 = file.path(dir, "c.cool"),
    maps = paste(paste0(file.path(dir, "b.mcool"), "::/resolutions/5000"), "3d", "https://d.example/x.cool", "~", "tracks", sep = "|")
  )
  hash <- fragment(view)
  expect_match(hash$uri2, paste0(served, "c\\.cool$"))
  maps <- strsplit(hash$maps, "|", fixed = TRUE)[[1]]
  expect_length(maps, 5L)
  expect_match(maps[[1]], paste0(served, "b\\.mcool::/resolutions/5000$"))
  expect_equal(maps[-1], c("3d", "https://d.example/x.cool", "~", "tracks"))
  moved <- chromosomix_navigate(view, uri = file.path(dir, "b.mcool"), maps = file.path(dir, "c.cool"), uri2 = NULL)
  state <- moved$x$requests[[1]]$state
  expect_match(state$uri, paste0(served, "b\\.mcool$"))
  expect_match(state$maps, paste0(served, "c\\.cool$"))
  expect_true("uri2" %in% names(state) && is.null(state$uri2))
  expect_error(chromosomix_navigate(view, uri2 = file.path(dir, "none.cool")), "not a file")
})

test_that("knitting, a fetched build is named by its permanent address rather than served", {
  local_no_viewer()
  cache <- Sys.getenv("CHROMOSOMIX_CACHE")
  build <- file.path(cache, "viewer", "0.17.0")
  dir.create(build, recursive = TRUE)
  writeLines("<!doctype html>", file.path(build, "index.html"))
  expect_match(resolve_viewer(), "^http://127\\.0\\.0\\.1:[0-9]+/[0-9a-f]{32}/$")
  old <- options(knitr.in.progress = TRUE)
  on.exit(options(old), add = TRUE)
  expect_equal(resolve_viewer(), "https://chromosomix.app/v/v0.17.0/")
  expect_match(chromosomix("https://d.example/a.cool")$x$src, "^https://chromosomix\\.app/v/v0\\.17\\.0/\\?embed=1#")
  # A build named is the build named.
  expect_equal(resolve_viewer("0.16.0"), "https://chromosomix.app/v/v0.16.0/")
  assign("warned", NULL, envir = chromosomix:::.files)
  expect_warning(served <- resolve_viewer(build), "only while this R session runs")
  expect_match(served, "^http://127\\.0\\.0\\.1:")
})

test_that("a fetched build is put in place whole, or not at all", {
  local_no_viewer()
  work <- tempfile("npm-")
  dir.create(file.path(work, "package", "dist", "assets"), recursive = TRUE)
  writeLines("<!doctype html>", file.path(work, "package", "dist", "index.html"))
  writeLines("console.log(1)", file.path(work, "package", "dist", "assets", "app.js"))
  writeLines("{}", file.path(work, "package", "package.json"))
  tarball <- file.path(work, "chromosomix.tgz")
  old <- setwd(work)
  utils::tar(tarball, c("package"), compression = "gzip", tar = "internal")
  setwd(old)
  target <- file.path(Sys.getenv("CHROMOSOMIX_CACHE"), "viewer", "0.17.0")

  # A digest that is not npm's: nothing is put in place.
  wrong <- function(file) as.raw(rep(0, 64))
  integrity <- paste0("sha512-", gsub("\n", "", jsonlite::base64_enc(as.raw(rep(1, 64))), fixed = TRUE))
  expect_error(chromosomix:::install_tarball(tarball, target, integrity, sha512 = wrong), "not the tarball npm describes")
  expect_false(dir.exists(target))
  expect_length(installed_viewers(), 0L)
  # No sha512 to check it with: it is installed unchecked.
  expect_equal(chromosomix:::install_tarball(tarball, target, integrity, sha512 = function(file) NULL), target)
  expect_true(file.exists(file.path(target, "assets", "app.js")))
  expect_equal(installed_viewers(), target)
  expect_length(list.files(dirname(target), all.files = TRUE, no.. = TRUE), 1L)

  # The digest npm gives, checked with the system's sha512sum.
  skip_if(!nzchar(Sys.which("sha512sum")), "no sha512sum")
  sha512sum <- function(file) {
    hex <- strsplit(system2("sha512sum", shQuote(file), stdout = TRUE), " ")[[1]][[1]]
    as.raw(strtoi(substring(hex, seq(1, 127, 2), seq(2, 128, 2)), 16L))
  }
  good <- paste0("sha512-", gsub("\n", "", jsonlite::base64_enc(sha512sum(tarball)), fixed = TRUE))
  expect_equal(nchar(good), 7L + 88L)
  expect_true(chromosomix:::intact(tarball, paste(good, "sha1-abc"), sha512 = sha512sum))
  expect_false(chromosomix:::intact(tarball, integrity, sha512 = sha512sum))
  expect_true(is.na(chromosomix:::intact(tarball, NULL, sha512 = sha512sum)))
  # One cut short before, with no index.html, is replaced.
  unlink(target, recursive = TRUE)
  dir.create(target)
  writeLines("half", file.path(target, "half.js"))
  expect_equal(chromosomix:::install_tarball(tarball, target, good, sha512 = sha512sum), target)
  expect_true(file.exists(file.path(target, "index.html")))
  expect_false(file.exists(file.path(target, "half.js")))
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
