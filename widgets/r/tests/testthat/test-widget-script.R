# What the widget's own script sends its frame (SPECS §21.4): run in Node, on
# a stand-in for the page, by `widget-script.cjs` beside this file — a frame
# drawn anew for every value, the origin the frame speaks from, a `goto` made
# a patch, patches in a row made one, and a proxy's request held until its
# widget is drawn.

test_that("the widget's script sends its frame what was asked, in order", {
  node <- Sys.which("node")
  skip_if(!nzchar(node), "no node on the PATH")
  script <- system.file("htmlwidgets", "chromosomix.js", package = "chromosomix")
  out <- suppressWarnings(system2(node, c(shQuote(test_path("widget-script.cjs")), shQuote(script)), stdout = TRUE, stderr = TRUE))
  failed <- !is.null(attr(out, "status"))
  if (failed) cat(out, sep = "\n")
  expect_false(failed)
  expect_true(any(grepl("^ok - ", out)))
  expect_false(any(grepl("^not ok", out)))
})
