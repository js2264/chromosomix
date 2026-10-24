\name{chromosomix}
\alias{chromosomix}
\title{The chromosomix viewer as an HTML widget}
\usage{
chromosomix(map = NULL, tracks = character(), region = NULL, locus = NULL, ...,
            viewer = NULL, title = "chromosomix", width = "100\%", height = 600,
            elementId = NULL)
}
\arguments{
\item{map}{The contact map the view opens on: \code{.cool}, \code{.mcool} (with
\code{::/resolutions/<bin>}), \code{.hic}, \code{.pairs}, \dots{} -- or \code{NULL}
for a 1D browser of the tracks alone, whose first file becomes the view's. With
no map, \code{locus} (or else \code{region}) and the view keywords are laid on as
a patch once the files are in, as \code{\link{chromosomix_navigate}} would.}
\item{tracks}{Files put in the view once it is drawn, in order, as the header's
\code{+} puts them: a track beside the map, another map beside it, a 3D model,
a workspace.}
\item{region}{Where the map is framed: \code{"IV:1000000-1400000"}, or a sequence,
a start and an end.}
\item{locus}{Where a 1D browser is placed, written the same way.}
\item{...}{Any other key of the view state as the app's address bar carries it,
named: \code{transform} (\code{"log10"}, \code{"log2"}, \code{"log1p"},
\code{"none"}), \code{colormap}, \code{balance}, \code{vmin}, \code{vmax},
\code{oe}, \code{smooth}, \code{view}, \dots{} One value each, written as the
address bar writes it -- \code{genomes = "a,b"}, not a vector -- and a number
with a point whatever \code{options(OutDec)} says. \code{uri}, \code{uri2} and
each of the \code{|}-separated \code{maps} are files, given as
\code{\link{address}} takes them.}
\item{viewer}{The build of the viewer in the frame; see \code{\link{resolve_viewer}}.}
\item{title}{The frame's title, for a screen reader.}
\item{width, height}{The widget's size: CSS units, or a number of pixels.}
\item{elementId}{An id for the widget's element.}
}
\value{
An htmlwidget. \code{\link{chromosomix_goto}}, \code{\link{chromosomix_navigate}} and
\code{\link{chromosomix_add}} lay requests on it before it is drawn.
}
\description{
The viewer itself -- a contact map with its tracks, a 1D genome browser, a 3D
model beside a map, with its side panels and its gestures -- in an R Markdown
document, a Quarto page, the RStudio viewer or a Shiny app. It is the viewer's
own embed in an \code{<iframe>}, driven over its message channel.
}
\details{
Files are addresses -- any the app opens: \code{https://}, \code{s3://},
\code{gs://}, a Dropbox or Google Drive share -- or paths on this machine, served
to the viewer by byte range from this R session (\code{\link{serve}}). A rendered
document that will be read elsewhere names its files by address.
}
\examples{
\dontrun{
yeast <- "https://rsglab-data.s3.eu-west-3.amazonaws.com/demo/yeast"
chromosomix(
  file.path(yeast, "Yeast_microC_G2M_1kb.cool"),
  region = "IV:1000000-1400000",
  tracks = file.path(yeast, c("Yeast_ATAC.bw", "Yeast_annotations.gtf")),
  transform = "log10"
)
}
}
\seealso{
\code{\link{chromosomixOutput}} and \code{\link{chromosomixProxy}} for Shiny.
}
