# The chromosomix viewer in a Shiny app, driven from R (SPECS §21.5).
#
#   shiny::runApp(system.file("examples", "app.R", package = "chromosomix"))
#
# The map, its tracks and the controls beside it: a region typed and gone to,
# the scale and observed / expected, and the 3D model added beside the map —
# each through `chromosomixProxy()`, without drawing the view again. Under the
# controls, where the reader has taken the view, from `input$view_state`.
#
# The files are the repository's yeast demo, from its bucket; `CHROMOSOMIX_DEMO`
# names a directory of the same files on this disk, served from this session.
# The controls follow `input$view_state` too, so what the sidebar says is what
# the view shows, whoever changed it.

library(shiny)
library(chromosomix)

root <- Sys.getenv("CHROMOSOMIX_DEMO", "https://rsglab-data.s3.eu-west-3.amazonaws.com/demo/yeast")
data <- function(name) file.path(root, name)

ui <- fluidPage(
  titlePanel("chromosomix in Shiny"),
  sidebarLayout(
    sidebarPanel(
      width = 3,
      textInput("where", "Go to", "IV:1150000-1300000"),
      actionButton("go", "Go"),
      hr(),
      radioButtons("transform", "Scale", c("log10", "log2", "log1p", "none"), inline = TRUE),
      checkboxInput("oe", "Observed / expected"),
      actionButton("model", "Add the 3D model"),
      hr(),
      h4("Where the reader is"),
      verbatimTextOutput("state")
    ),
    mainPanel(
      width = 9,
      chromosomixOutput("view", height = "860px")
    )
  )
)

server <- function(input, output, session) {
  output$view <- renderChromosomix(
    chromosomix(
      data("Yeast_microC_G2M_1kb.cool"),
      region = "IV:1000000-1400000",
      tracks = data(c("Yeast_ATAC.bw", "Yeast_MNase.bw", "Yeast_annotations.gtf")),
      transform = "log10"
    )
  )
  view <- chromosomixProxy("view")
  observeEvent(input$go, chromosomix_goto(view, input$where))
  observeEvent(input$transform, chromosomix_navigate(view, transform = input$transform), ignoreInit = TRUE)
  observeEvent(input$oe, chromosomix_navigate(view, oe = input$oe), ignoreInit = TRUE)
  observeEvent(input$model, chromosomix_add(view, data("Yeast_structure.g3d.gz")))

  # The controls follow the viewer: observed / expected puts the map on a log2
  # scale, and the reader may change either in the viewer's own panels. A
  # control set to what the view already shows asks for nothing new.
  observeEvent(input$view_state, {
    state <- input$view_state
    if (!is.null(state$transform) && !identical(state$transform, input$transform)) {
      updateRadioButtons(session, "transform", selected = state$transform)
    }
    if (!identical(isTRUE(state$oe), input$oe)) updateCheckboxInput(session, "oe", value = isTRUE(state$oe))
  })

  # What the viewer said last, as the address bar would carry it.
  output$state <- renderText({
    state <- input$view_state
    if (is.null(state)) return("…")
    keys <- intersect(c("region", "locus", "transform", "oe", "maps", "view"), names(state))
    paste(sprintf("%-9s %s", keys, vapply(state[keys], function(value) paste(value, collapse = " "), "")), collapse = "\n")
  })
}

shinyApp(ui, server)
