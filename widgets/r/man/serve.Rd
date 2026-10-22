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
the file's whole directory under a random token so its sidecars (\code{.bai},
\code{.fai}, \code{.tbi}, \code{.px2}) are read from beside it. Nothing outside a
directory a file was named in is served. \code{address()} is what every function
here calls on a file: an address (\code{https://}, \code{s3://}, \code{gs://}, a
Dropbox or Google Drive share) is kept as it is, and a local path is served.
}
\details{
The server answers while R is idle -- at the console, in RStudio, under Shiny.
A rendered R Markdown document that names local files draws them only while the
R session that rendered it is running; one that will be read elsewhere names its
files by address.

Behind RStudio Server the server is reached through RStudio's proxy (with the
rstudioapi package installed); \code{CHROMOSOMIX_PUBLIC_URL}, with \code{{port}}
where the port goes, names any other way in.
}
\examples{
address("https://data.example/yeast.mcool::/resolutions/1000")
\dontrun{
serve("~/data/sample.mcool")
}
}
