\name{chromosomixOutput}
\alias{chromosomixOutput}
\alias{renderChromosomix}
\alias{chromosomixProxy}
\alias{print.chromosomix_proxy}
\title{The viewer in a Shiny app}
\usage{
chromosomixOutput(outputId, width = "100\%", height = "600px")

renderChromosomix(expr, env = parent.frame(), quoted = FALSE)

chromosomixProxy(outputId, session = shiny::getDefaultReactiveDomain())

\method{print}{chromosomix_proxy}(x, ...)
}
\arguments{
\item{outputId}{The output's id.}
\item{width, height}{Its size, in CSS units.}
\item{expr}{An expression that returns a \code{\link{chromosomix}} widget.}
\item{env}{The environment \code{expr} is evaluated in.}
\item{quoted}{Whether \code{expr} is already quoted.}
\item{session}{The Shiny session the output is in.}
\item{x}{A proxy.}
\item{...}{Unused.}
}
\value{
\code{chromosomixOutput()}: the output's UI. \code{renderChromosomix()}: a render
function. \code{chromosomixProxy()}: a proxy for the requests.
}
\description{
\code{chromosomixOutput()} and \code{renderChromosomix()} put a
\code{\link{chromosomix}} widget in a Shiny app. What the viewer says comes back as
inputs named after the output: \code{input$<id>_state} is where the view is --
the app's view state, a list, \code{NULL} on its picker -- and changes as the
reader pans, zooms and changes the scale; \code{input$<id>_rendered} is the report
of the last finished picture (what is drawn, at what resolution);
\code{input$<id>_version} the viewer's version, once its frame is up.

\code{chromosomixProxy()} drives a widget already on screen, without drawing it
again: \code{\link{chromosomix_goto}}, \code{\link{chromosomix_navigate}} and
\code{\link{chromosomix_add}} take it in place of a widget.
}
\examples{
\dontrun{
library(shiny)
ui <- fluidPage(
  textInput("where", "Go to", "IV:1150000-1300000"),
  actionButton("go", "go"),
  chromosomixOutput("view", height = "800px"),
  verbatimTextOutput("region")
)
server <- function(input, output, session) {
  output$view <- renderChromosomix(chromosomix(map, region = "IV:1000000-1400000"))
  observeEvent(input$go, chromosomix_goto(chromosomixProxy("view"), input$where))
  output$region <- renderText(input$view_state$region)
}
shinyApp(ui, server)
}
# The demo app beside this package's R Markdown demo:
# shiny::runApp(system.file("examples", "app.R", package = "chromosomix"))
}
