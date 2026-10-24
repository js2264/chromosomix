#' The viewer in a Shiny app
#'
#' `chromosomixOutput()` and `renderChromosomix()` put a [chromosomix()] widget
#' in a Shiny app. What the viewer says comes back as inputs named after the
#' output: `input$<id>_state` is where the view is — the app's view state, a
#' list, `NULL` on its picker — and changes as the reader pans, zooms and
#' changes the scale; `input$<id>_rendered` is the report of the last finished
#' picture (what is drawn, at what resolution); `input$<id>_version` the
#' viewer's version, once its frame is up.
#'
#' `chromosomixProxy()` drives a widget already on screen, without drawing it
#' again: [chromosomix_goto()], [chromosomix_navigate()] and
#' [chromosomix_add()] take it in place of a widget. A request through a proxy
#' is sent once the outputs of the flush it was made in are, so a widget drawn
#' in that flush is on the page first; one that reaches the page before its
#' widget is drawn is held, and made after the widget's own. Drawn again by
#' `renderChromosomix()`, the widget is a new frame, and only the new widget's
#' requests are made in it.
#'
#' @param outputId The output's id.
#' @param width,height Its size, in CSS units.
#' @param expr An expression that returns a [chromosomix()] widget.
#' @param env The environment `expr` is evaluated in.
#' @param quoted Whether `expr` is already quoted.
#' @param session The Shiny session the output is in.
#' @return `chromosomixOutput()`: the output's UI. `renderChromosomix()`: a
#'   render function. `chromosomixProxy()`: a proxy for the requests.
#' @examples
#' \dontrun{
#' library(shiny)
#' ui <- fluidPage(
#'   textInput("where", "Go to", "IV:1150000-1300000"),
#'   actionButton("go", "go"),
#'   chromosomixOutput("view", height = "800px"),
#'   verbatimTextOutput("region")
#' )
#' server <- function(input, output, session) {
#'   output$view <- renderChromosomix(chromosomix(map, region = "IV:1000000-1400000"))
#'   observeEvent(input$go, chromosomix_goto(chromosomixProxy("view"), input$where))
#'   output$region <- renderText(input$view_state$region)
#' }
#' shinyApp(ui, server)
#' }
#' @export
chromosomixOutput <- function(outputId, width = "100%", height = "600px") {
  htmlwidgets::shinyWidgetOutput(outputId, "chromosomix", width, height, package = "chromosomix")
}

#' @rdname chromosomixOutput
#' @export
renderChromosomix <- function(expr, env = parent.frame(), quoted = FALSE) {
  if (!quoted) expr <- substitute(expr)
  htmlwidgets::shinyRenderWidget(expr, chromosomixOutput, env, quoted = TRUE)
}

#' @rdname chromosomixOutput
#' @export
chromosomixProxy <- function(outputId, session = shiny::getDefaultReactiveDomain()) {
  if (is.null(session)) stop("chromosomixProxy() is called from a Shiny server function.", call. = FALSE)
  structure(list(id = session$ns(outputId), session = session), class = "chromosomix_proxy")
}

#' @export
print.chromosomix_proxy <- function(x, ...) {
  cat(sprintf("<chromosomix proxy for output %s>\n", x$id))
  invisible(x)
}
