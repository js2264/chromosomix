# What the R session's file server answers (SPECS §21.5): one request at a
# time, handed straight to its handler, and once end to end from another R
# process — this one's event loop is busy running the test.

request <- function(path, method = "GET", range = NULL) {
  req <- new.env()
  req$REQUEST_METHOD <- method
  req$PATH_INFO <- path
  if (!is.null(range)) req$HTTP_RANGE <- range
  req
}

served <- function() {
  # Under the session's temporary directory, which goes with the session.
  dir <- tempfile("served-")
  dir.create(dir)
  writeBin(as.raw(0:99), file.path(dir, "a.bin"))
  writeBin(as.raw(1:5), file.path(dir, "a.bin.bai"))
  writeBin(as.raw(c(0x1f, 0x8b, 8, 0)), file.path(dir, "b.gz"))
  writeLines("<!doctype html>", file.path(dir, "index.html"))
  dir.create(file.path(dir, "sub"))
  roots <- new.env()
  assign("tok", normalizePath(dir, winslash = "/"), envir = roots)
  list(dir = dir, roots = roots)
}

# The bytes an answer sends: its body, or the file httpuv is handed to send.
sent <- function(out) {
  if (is.list(out$body)) readBin(out$body$file, raw(), file.size(out$body$file)) else out$body
}

test_that("a range is answered with exactly its bytes", {
  s <- served()
  out <- chromosomix:::answer_request(request("/tok/a.bin", range = "bytes=10-19"), s$roots)
  expect_equal(out$status, 206L)
  expect_equal(out$body, as.raw(10:19))
  expect_equal(out$headers[["Content-Range"]], "bytes 10-19/100")
  expect_equal(out$headers[["Access-Control-Allow-Origin"]], "*")
  expect_match(out$headers[["Access-Control-Expose-Headers"]], "Content-Range")
})

test_that("open and suffix ranges, and a whole file without one", {
  s <- served()
  open <- chromosomix:::answer_request(request("/tok/a.bin", range = "bytes=95-"), s$roots)
  expect_equal(open$body, as.raw(95:99))
  suffix <- chromosomix:::answer_request(request("/tok/a.bin", range = "bytes=-3"), s$roots)
  expect_equal(suffix$body, as.raw(97:99))
  past <- chromosomix:::answer_request(request("/tok/a.bin", range = "bytes=90-500"), s$roots)
  expect_equal(past$headers[["Content-Range"]], "bytes 90-99/100")
  whole <- chromosomix:::answer_request(request("/tok/a.bin"), s$roots)
  expect_equal(whole$status, 200L)
  expect_null(whole$headers[["Content-Range"]])
  # Handed to httpuv to send from the disk, not read into R.
  expect_equal(whole$body, list(file = file.path(normalizePath(s$dir, winslash = "/"), "a.bin"), owned = FALSE))
  expect_equal(sent(whole), as.raw(0:99))
})

test_that("a range that starts at or past the end is refused with 416", {
  s <- served()
  out <- chromosomix:::answer_request(request("/tok/a.bin", range = "bytes=100-"), s$roots)
  expect_equal(out$status, 416L)
  expect_equal(out$headers[["Content-Range"]], "bytes */100")
  expect_equal(chromosomix:::answer_request(request("/tok/a.bin", range = "bytes=150-160"), s$roots)$status, 416L)
  expect_equal(chromosomix:::answer_request(request("/tok/a.bin", range = "bytes=-0"), s$roots)$status, 416L)
})

test_that("a Range it does not read is ignored, and the whole file sent (RFC 9110)", {
  s <- served()
  for (range in c(
    "bytes=1-2,5-6", "bytes=-", "bytes=5-2", "items=0-9", "bytes 0-9", "bytes=a-9",
    paste0("bytes=", strrep("0", 20), "1-9")
  )) {
    out <- chromosomix:::answer_request(request("/tok/a.bin", range = range), s$roots)
    expect_equal(out$status, 200L, info = range)
    expect_null(out$headers[["Content-Range"]])
    expect_equal(sent(out), as.raw(0:99), info = range)
  }
  # Twenty digits are a number, and the unit is any case.
  long <- chromosomix:::answer_request(request("/tok/a.bin", range = sprintf("bytes=%020d-%020d", 10, 19)), s$roots)
  expect_equal(long$status, 206L)
  expect_equal(long$body, as.raw(10:19))
  expect_equal(chromosomix:::answer_request(request("/tok/a.bin", range = "Bytes=0-1"), s$roots)$status, 206L)
})

test_that("HEAD says the length and sends nothing, and only a range says it takes ranges", {
  s <- served()
  out <- chromosomix:::answer_request(request("/tok/a.bin", method = "HEAD"), s$roots)
  expect_equal(out$status, 200L)
  expect_equal(out$headers[["Content-Length"]], "100")
  expect_null(out$body)
  # A proxy that answers a HEAD with a length of 0 would pass it through.
  expect_null(out$headers[["Accept-Ranges"]])
  ranged <- chromosomix:::answer_request(request("/tok/a.bin", method = "HEAD", range = "bytes=0-0"), s$roots)
  expect_equal(ranged$status, 206L)
  expect_equal(ranged$headers[["Content-Range"]], "bytes 0-0/100")
  expect_equal(ranged$headers[["Accept-Ranges"]], "bytes")
  expect_equal(chromosomix:::answer_request(request("/tok/a.bin"), s$roots)$headers[["Accept-Ranges"]], "bytes")
})

test_that("a preflight is told the page may reach this machine", {
  s <- served()
  out <- chromosomix:::answer_request(request("/tok/a.bin", method = "OPTIONS"), s$roots)
  expect_equal(out$status, 204L)
  expect_equal(out$headers[["Access-Control-Allow-Private-Network"]], "true")
  expect_match(out$headers[["Access-Control-Allow-Headers"]], "Range")
})

test_that("a sidecar is read from beside its file, and a gzip is sent as its bytes", {
  s <- served()
  expect_equal(sent(chromosomix:::answer_request(request("/tok/a.bin.bai"), s$roots)), as.raw(1:5))
  gz <- chromosomix:::answer_request(request("/tok/b.gz"), s$roots)
  expect_equal(gz$headers[["Content-Type"]], "application/octet-stream")
  expect_null(gz$headers[["Content-Encoding"]])
})

test_that("a directory is its index, and nothing is served outside it or without its token", {
  s <- served()
  expect_equal(chromosomix:::answer_request(request("/tok/"), s$roots)$headers[["Content-Type"]], "text/html; charset=utf-8")
  outside <- file.path(dirname(s$dir), "secret.txt")
  writeLines("secret", outside)
  on.exit(unlink(outside), add = TRUE)
  expect_equal(chromosomix:::answer_request(request("/tok/../secret.txt"), s$roots)$status, 404L)
  expect_equal(chromosomix:::answer_request(request("/tok/%2e%2e/secret.txt"), s$roots)$status, 404L)
  expect_equal(chromosomix:::answer_request(request("/nope/a.bin"), s$roots)$status, 404L)
  expect_equal(chromosomix:::answer_request(request("/tok"), s$roots)$status, 404L)
  expect_equal(chromosomix:::answer_request(request("/tok/sub/missing"), s$roots)$status, 404L)
  expect_equal(chromosomix:::answer_request(request("/tok/a.bin", method = "POST"), s$roots)$status, 405L)
  expect_equal(chromosomix:::answer_request(request("/tok/..%2fsecret.txt"), s$roots)$status, 404L)
  expect_equal(chromosomix:::answer_request(request("/tok/..%5csecret.txt"), s$roots)$status, 404L)
})

test_that("no name that starts with a dot is served", {
  s <- served()
  writeLines("hidden", file.path(s$dir, ".hidden"))
  dir.create(file.path(s$dir, ".git"))
  writeLines("[core]", file.path(s$dir, ".git", "config"))
  dir.create(file.path(s$dir, "sub", ".ssh"))
  writeLines("key", file.path(s$dir, "sub", ".ssh", "id"))
  for (path in c("/tok/.hidden", "/tok/.git/config", "/tok/%2egit/config", "/tok/sub/.ssh/id", "/tok/./a.bin", "/tok/sub/../a.bin")) {
    expect_equal(chromosomix:::answer_request(request(path), s$roots)$status, 404L, info = path)
  }
  expect_error(serve(file.path(s$dir, ".hidden")), "starts with a dot")
})

test_that("a link is served by its own name, wherever it points", {
  skip_on_os("windows")
  s <- served()
  outside <- tempfile("outside-")
  dir.create(outside)
  writeLines("secret", file.path(outside, "secret.txt"))
  file.symlink(file.path(outside, "secret.txt"), file.path(s$dir, "link.txt"))
  file.symlink(outside, file.path(s$dir, "elsewhere"))
  # Whoever owns the directory made the link: it is followed.
  expect_equal(rawToChar(sent(chromosomix:::answer_request(request("/tok/link.txt"), s$roots))), "secret\n")
  expect_equal(chromosomix:::answer_request(request("/tok/elsewhere/secret.txt"), s$roots)$status, 200L)

  # A DataLad or git-annex file: a link into `.git/annex`, its index another
  # beside it. Both are read by the names the links have.
  annexed <- tempfile("annexed-")
  objects <- file.path(annexed, ".git", "annex", "objects")
  dir.create(file.path(objects, "a"), recursive = TRUE)
  dir.create(file.path(objects, "b"))
  writeBin(as.raw(1:9), file.path(objects, "a", "MD5E-s9--1.bam"))
  writeBin(as.raw(7:8), file.path(objects, "b", "MD5E-s2--2.bai"))
  file.symlink(file.path(".git", "annex", "objects", "a", "MD5E-s9--1.bam"), file.path(annexed, "reads.bam"))
  file.symlink(file.path(".git", "annex", "objects", "b", "MD5E-s2--2.bai"), file.path(annexed, "reads.bam.bai"))
  at <- chromosomix:::path_of(file.path(annexed, "reads.bam"))
  expect_match(at, "^/[0-9a-f]{32}/reads\\.bam$")
  roots <- chromosomix:::.files$roots
  expect_equal(get(sub("^/([^/]+)/.*$", "\\1", at), envir = roots), normalizePath(annexed, winslash = "/"))
  expect_equal(sent(chromosomix:::answer_request(request(at), roots)), as.raw(1:9))
  expect_equal(sent(chromosomix:::answer_request(request(paste0(at, ".bai")), roots)), as.raw(7:8))
  expect_equal(chromosomix:::answer_request(request(sub("reads\\.bam$", ".git/annex/objects/a/MD5E-s9--1.bam", at)), roots)$status, 404L)
})

test_that("a directory at the root of a disk is served", {
  s <- served()
  file <- normalizePath(file.path(s$dir, "a.bin"), winslash = "/")
  top <- sub("^((?:[A-Za-z]:)?/).*$", "\\1", file, perl = TRUE)
  rest <- substring(file, nchar(top) + 1L)
  skip_if(any(startsWith(strsplit(rest, "/", fixed = TRUE)[[1]], ".")), "the temporary directory is under a dot")
  roots <- new.env()
  assign("top", top, envir = roots)
  out <- chromosomix:::answer_request(request(paste0("/top/", rest), range = "bytes=0-3"), roots)
  expect_equal(out$status, 206L)
  expect_equal(out$body, as.raw(0:3))
})

test_that("a token is 128 bits, and a script's seed does not decide it", {
  set.seed(1)
  first <- chromosomix:::new_token()
  set.seed(1)
  second <- chromosomix:::new_token()
  expect_match(first, "^[0-9a-f]{32}$")
  expect_false(identical(first, second))
})

test_that("without a random source, two tokens drawn at once differ, and the script's stream is its own", {
  set.seed(1)
  first <- chromosomix:::seeded_bytes(16L)
  set.seed(1)
  second <- chromosomix:::seeded_bytes(16L)
  third <- chromosomix:::seeded_bytes(16L)
  expect_length(first, 16L)
  expect_false(identical(first, second))
  expect_false(identical(second, third))
  set.seed(2)
  expected <- stats::runif(3)
  set.seed(2)
  chromosomix:::seeded_bytes(16L)
  expect_equal(stats::runif(3), expected)
})

test_that("a token already given out is drawn again", {
  drawn <- c(strrep("a", 32), strrep("a", 32), strrep("b", 32))
  local_mocked_bindings(new_token = function() {
    token <- drawn[[1]]
    drawn <<- drawn[-1]
    token
  })
  one <- tempfile("one-")
  two <- tempfile("two-")
  expect_equal(chromosomix:::token_for(one), strrep("a", 32))
  expect_equal(chromosomix:::token_for(two), strrep("b", 32))
  expect_equal(chromosomix:::token_for(one), strrep("a", 32))
  roots <- chromosomix:::.files$roots
  rm(list = c(strrep("a", 32), strrep("b", 32)), envir = roots)
  rm(list = c(one, two), envir = chromosomix:::.files$tokens)
})

test_that("knitting, the first local file served says the page needs this session", {
  dir <- tempfile("knit-")
  dir.create(dir)
  on.exit(unlink(dir, recursive = TRUE), add = TRUE)
  writeLines("a", file.path(dir, "a.bed"))
  writeLines("b", file.path(dir, "b.bed"))
  old <- options(knitr.in.progress = TRUE)
  on.exit(options(old), add = TRUE)
  assign("warned", NULL, envir = chromosomix:::.files)
  expect_warning(address(file.path(dir, "a.bed")), "only while this R session runs")
  expect_no_warning(address(file.path(dir, "b.bed")))
  expect_no_warning(address("https://d.example/a.bed"))
  options(knitr.in.progress = NULL)
  assign("warned", NULL, envir = chromosomix:::.files)
  expect_no_warning(address(file.path(dir, "a.bed")))
})

test_that("the server reads a range end to end, from another process", {
  skip_if_not_installed("callr")
  dir <- tempfile("served-")
  dir.create(dir)
  on.exit(unlink(dir, recursive = TRUE), add = TRUE)
  writeBin(as.raw(0:255), file.path(dir, "sample.mcool"))
  ready <- file.path(dir, "address.txt")
  server <- callr::r_bg(
    function(file, ready) {
      at <- chromosomix::serve(file)
      writeLines(at, ready)
      repeat httpuv::service(100)
    },
    args = list(file = file.path(dir, "sample.mcool"), ready = ready),
    # Its own temporary directory in this one, which goes with it.
    env = c(callr::rcmd_safe_env(), TMPDIR = dir)
  )
  on.exit(server$kill(), add = TRUE)
  for (i in 1:100) if (file.exists(ready) && length(readLines(ready)) > 0) break else Sys.sleep(0.1)
  at <- readLines(ready)
  expect_match(at, "^http://127\\.0\\.0\\.1:[0-9]+/[0-9a-f]{32}/sample\\.mcool$")
  con <- url(at, open = "rb", method = "libcurl", headers = c(Range = "bytes=16-31"))
  on.exit(close(con), add = TRUE)
  expect_equal(readBin(con, raw(), 100), as.raw(16:31))
  # A whole file, sent by httpuv from the disk.
  whole <- url(at, open = "rb", method = "libcurl")
  on.exit(close(whole), add = TRUE)
  expect_equal(readBin(whole, raw(), 1000), as.raw(0:255))
  # A HEAD says how long it is, and not that it takes ranges.
  head <- tolower(curlGetHeaders(at))
  expect_true(any(grepl("^content-length: 256", head)))
  expect_false(any(grepl("^accept-ranges", head)))
})
