\name{serve}
\alias{serve}
\alias{address}
\title{Serve a file on this machine to the viewer}
\usage{
serve(file)

address(file)
}
\arguments{
\item{file}{A path on this machine. With \code{address()}, an address or a path;
a \code{::} after a container's path names a group inside it, as in the app
(\code{"sample.mcool::/resolutions/5000"}), and is kept on the served address.}
}
\value{
The address, a string.
}
\description{
\code{serve()} gives a local file an address the viewer can read by byte range:
a server on \code{127.0.0.1} in this R session, started on first use, serving
the directory the file is named in under a random token so its sidecars
(\code{.bai}, \code{.fai}, \code{.tbi}, \code{.px2}) are read from beside it.
\code{address()} is what every function here calls on a file: an address
(\code{https://}, \code{s3://}, \code{gs://}, a Dropbox or Google Drive share) is
kept as it is, and a local path is served.
}
\details{
Nothing outside that directory is served but what a link in it points to, and
no name that starts with a dot (\code{.git}, \code{.ssh}): a path that climbs
out of the directory is refused, and a link in it is followed wherever it
points, since whoever owns the directory made it. A file is served by the name
it is given, a link as itself, so a DataLad or git-annex file -- a link into
\code{.git/annex} -- has its \code{.bai} read from beside the link. A file
asked for whole is sent by httpuv from the disk, without passing through R; a
range is answered as RFC 9110 says, and a \code{Range} header it cannot read
(several ranges, another unit) is ignored and the whole file sent.

The server answers while R is idle -- at the console, in RStudio, under Shiny.
A rendered R Markdown or Quarto page that names local files draws them only
while the R session that rendered it is running, and a Knit or
\code{quarto render} session ends as soon as the page is written: a page for
others names its files by address. Knitting, the first local file served says so
in a warning, once a session; and a viewer fetched by
\code{\link{install_viewer}} is named by the release's permanent address on the
site rather than served (\code{\link{resolve_viewer}}).

Behind RStudio Server the server is reached through RStudio's proxy (with the
rstudioapi package installed); \code{CHROMOSOMIX_PUBLIC_URL}, with \code{{port}}
where the port goes, names any other way in. There only a viewer this session
serves -- \code{\link{install_viewer}}'s, or a built \code{dist/} -- reads local
files: RStudio's proxy asks for its login, which the public site's requests to it
do not carry.
}
\examples{
address("https://data.example/yeast.mcool::/resolutions/1000")
\dontrun{
serve("~/data/sample.mcool")
}
}
