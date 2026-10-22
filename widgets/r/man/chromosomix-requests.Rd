\name{chromosomix-requests}
\alias{chromosomix-requests}
\alias{chromosomix_goto}
\alias{chromosomix_navigate}
\alias{chromosomix_add}
\title{Move the viewer, and put more files in it}
\usage{
chromosomix_goto(view, where)

chromosomix_navigate(view, ...)

chromosomix_add(view, ...)
}
\arguments{
\item{view}{A widget from \code{\link{chromosomix}}, or a proxy from
\code{\link{chromosomixProxy}}.}
\item{where}{\code{"II:100000-200000"}, or a sequence, a start and an end.}
\item{...}{\code{chromosomix_navigate()}: keys of the view state and their
values, named, one value each as the address bar writes it
(\code{genomes = "a,b"}); \code{NULL} takes a key away. A \code{locus} or a
\code{region} may also be a sequence, a start and an end; \code{uri}, \code{uri2}
and each of the \code{|}-separated \code{maps} are files, as addresses or paths
(\code{\link{address}}). \code{chromosomix_add()}: files, as addresses or paths.}
}
\value{
\code{view}, so the requests chain.
}
\description{
Three requests, made of a widget before it is drawn -- piped onto
\code{\link{chromosomix}}, which is how a static R Markdown page moves its views
-- or of one on screen in Shiny, through \code{\link{chromosomixProxy}}. The frame
makes them in the order they were made, each once the one before it is done: a
locus asked for after tracks were added is the locus on those tracks.
}
\details{
\itemize{
\item \code{chromosomix_goto()} frames a region of the map -- or places the 1D
browser, when that is what the view shows.
\item \code{chromosomix_navigate()} lays a patch over the view: any key the app's
address bar carries.
\item \code{chromosomix_add()} puts files in the view as the header's \code{+}
does: a track among the tracks, another map or a 3D model beside the map, a
workspace.
}

A \code{goto} is made a patch as the frame's page takes it -- the map's
\code{region}, or the 1D browser's \code{locus}, by the view the frame last said
it shows -- and patches made one after another are laid on as one, the later
keys over the earlier, so a frame that loads again is sent where the view was
sent rather than every step on the way. An addition is never merged nor
dropped.
}
\examples{
\dontrun{
chromosomix(map, tracks = "ATAC.bw") |>
  chromosomix_goto("IV:1150000-1300000") |>
  chromosomix_navigate(transform = "log2", oe = TRUE) |>
  chromosomix_add("Yeast_structure.g3d.gz")
}
}
