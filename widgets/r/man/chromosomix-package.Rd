\name{chromosomix-package}
\alias{chromosomix-package}
\docType{package}
\title{The chromosomix Hi-C viewer as an HTML widget}
\description{
The chromosomix viewer (\url{https://chromosomix.app/}) -- a contact map with its
tracks, a 1D genome browser or a 3D model of a genome -- in an R Markdown
document, a Quarto page, the RStudio viewer or a Shiny app: \code{\link{chromosomix}}
draws one, \code{\link{chromosomix_goto}} and its siblings move it, and
\code{\link{chromosomixOutput}} puts it in Shiny, where it reports where the reader
has taken it. Files on this machine are served to it by byte range
(\code{\link{serve}}); nothing is uploaded.

The demo is \code{system.file("examples", package = "chromosomix")}: an R Markdown
page, \code{demo.Rmd}, and a Shiny app, \code{app.R}.
}
