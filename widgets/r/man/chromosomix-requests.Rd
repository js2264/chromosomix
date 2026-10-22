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
values, named; \code{NULL} takes a key away. \code{chromosomix_add()}: files, as
addresses or paths (\code{\link{address}}).}
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
}
\examples{
\dontrun{
chromosomix(map, tracks = "ATAC.bw") |>
  chromosomix_goto("IV:1150000-1300000") |>
  chromosomix_navigate(transform = "log2", oe = TRUE) |>
  chromosomix_add("Yeast_structure.g3d.gz")
}
}
