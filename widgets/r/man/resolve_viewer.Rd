\name{resolve_viewer}
\alias{resolve_viewer}
\alias{installed_viewers}
\alias{install_viewer}
\title{Which build of the viewer a widget frames}
\usage{
resolve_viewer(viewer = NULL)

installed_viewers()

install_viewer(version = "latest")
}
\arguments{
\item{viewer}{\code{NULL}, a version, an address or a directory, as below.}
\item{version}{The npm version to fetch, or \code{"latest"}.}
}
\value{
\code{resolve_viewer()}: the build's address, ending in \code{/}.
\code{install_viewer()}: the build's directory. \code{installed_viewers()}: the
directories of every build fetched, the newest version last.
}
\description{
The widget is the viewer's own embed in an \code{<iframe>}, and \code{viewer}
names the build in it:
\itemize{
\item \code{NULL} -- the option \code{chromosomix.viewer} where it is set, then
the environment variable \code{CHROMOSOMIX_VIEWER}, then the newest build
\code{install_viewer()} fetched, and the site, \url{https://chromosomix.app/},
where there is none of them. While a page is knitted, the build
\code{install_viewer()} fetched is named by the release's permanent address on
the site, \code{/v/v<version>/}, instead of being served: the page is read after
the render's R session has ended, and its server with it;
\item a version, \code{"0.16.0"} or \code{"v0.16.0"} -- the release the site
keeps for ever at \code{/v/<tag>/}, which is what a document that must draw the
same picture next year names;
\item an address -- any \code{http(s)://} build, a lab's own copy of the npm
package's \code{dist/} among them;
\item a directory -- a built \code{dist/} on this machine, served beside the
data (\code{\link{serve}}), so the app and the files are one origin and nothing is
fetched from the network.
}
}
\details{
\code{install_viewer()} fetches the npm package \code{chromosomix} once -- the
app built to run from any path -- and keeps it in the user's cache directory
(\code{\link[tools]{R_user_dir}}, or \code{CHROMOSOMIX_CACHE}); every widget after
uses it. With files on this machine that is the build to prefer: the site
reading \code{http://127.0.0.1} works too, but Chrome asks the reader once to let
the page reach this machine. The tarball is checked against the sha512 npm gives
for it (\code{dist.integrity}) where the openssl package is installed -- base R
has no sha512 -- and put in place whole: unpacked apart, copied beside its place
and renamed into it, so a download or a copy cut short leaves nothing a widget
would frame.
}
\examples{
resolve_viewer("0.16.0")
resolve_viewer("https://lab.example/viewer")
}
