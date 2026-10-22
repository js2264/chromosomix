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
  expect_length(whole$body, 100L)
  expect_null(whole$headers[["Content-Range"]])
})

test_that("a range past the end, or one it cannot read, is refused with 416", {
  s <- served()
  out <- chromosomix:::answer_request(request("/tok/a.bin", range = "bytes=100-"), s$roots)
  expect_equal(out$status, 416L)
  expect_equal(out$headers[["Content-Range"]], "bytes */100")
  expect_equal(chromosomix:::answer_request(request("/tok/a.bin", range = "bytes=1-2,5-6"), s$roots)$status, 416L)
  expect_equal(chromosomix:::answer_request(request("/tok/a.bin", range = "bytes=-"), s$roots)$status, 416L)
})

test_that("HEAD says the length and sends nothing", {
  s <- served()
  out <- chromosomix:::answer_request(request("/tok/a.bin", method = "HEAD"), s$roots)
  expect_equal(out$status, 200L)
  expect_equal(out$headers[["Content-Length"]], "100")
  expect_null(out$body)
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
  expect_equal(chromosomix:::answer_request(request("/tok/a.bin.bai"), s$roots)$body, as.raw(1:5))
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
  if (.Platform$OS.type == "unix") {
    file.symlink(outside, file.path(s$dir, "link.txt"))
    expect_equal(chromosomix:::answer_request(request("/tok/link.txt"), s$roots)$status, 404L)
  }
})

test_that("a token is 128 bits, and a script's seed does not decide it", {
  set.seed(1)
  first <- chromosomix:::new_token()
  set.seed(1)
  second <- chromosomix:::new_token()
  expect_match(first, "^[0-9a-f]{32}$")
  expect_false(identical(first, second))
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
    args = list(file = file.path(dir, "sample.mcool"), ready = ready)
  )
  on.exit(server$kill(), add = TRUE)
  for (i in 1:100) if (file.exists(ready) && length(readLines(ready)) > 0) break else Sys.sleep(0.1)
  at <- readLines(ready)
  expect_match(at, "^http://127\\.0\\.0\\.1:[0-9]+/[0-9a-f]{32}/sample\\.mcool$")
  con <- url(at, open = "rb", method = "libcurl", headers = c(Range = "bytes=16-31"))
  on.exit(close(con), add = TRUE)
  expect_equal(readBin(con, raw(), 100), as.raw(16:31))
})
