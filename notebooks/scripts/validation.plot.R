#! /usr/local/bin/Rscript
library(tidyverse)
library(patchwork)
setwd("~/Documents/Koszul/__Bioinfo/repos/chromosomix/notebooks/")

# Every mark of every figure of chromosomix.app/validation: a figure is panels, a panel is marks
download.file("https://chromosomix.app/validation/validation.txt", "validation_results.tsv")
# Shorter axis titles and series names, for small panels
short <- c(
    "chromosomix prominence" = "chromosomix",
    "cooltools boundary strength" = "cooltools",
    "|Pearson r|, chromosomix vs cooltools" = "|Pearson r|",
    "mean balanced contact per bin pair" = "contact frequency",
    "cooltools less the diagonal" = "cooltools",
    "cooltools, pooled" = "cooltools",
    "Spearman ρ of pairwise distances" = "Spearman ρ",
    "chromosomix vs pastis, same seed" = "chromosomix–pastis",
    "pastis vs pastis" = "pastis–pastis",
    "|chromosomix / coolpuppy − 1|" = "relative difference",
    "chromosomix (two decimals)" = "chromosomix",
    "deepTools computeMatrix" = "deepTools",
    "Biopython GC_skew" = "Biopython",
    "pyBigWig, exact" = "pyBigWig",
    "yapc 0.1" = "yapc"
)
marks <- read_tsv("validation_results.tsv", guess_max = 1e6) |>
    mutate(across(c(x_axis, y_axis, series), \(a) coalesce(short[a], a)))

# The panels shown, in order, 1D tasks then 2D then 3D, with what the marks do not say: the axes
# drawn on a log scale (symlog for the directionality index, as the notebook draws them)
panels <- tribble(
    ~figure, ~panel, ~title, ~log,
    "fig-yapc", "b", "Peak calling (vs yapc)", "",
    "fig-frip", "a", "FRiP (vs pyBigWig)", "xy",
    "fig-metaplot", "c", "Metaplot (vs deepTools)", "xy",
    "fig-groupsignal", "b", "Signal by group (vs pyBigWig)", "",
    "fig-composition", "b", "GC skew (vs Biopython)", "",
    "fig-composition", "c", "GC content, chr11 (vs bioframe)", "",
    "fig-motif", "b", "Motif search, WGATAR (vs seqkit)", "",
    "fig-trackcorr", "b", "Track correlation (vs deepTools)", "",
    "fig-insulation", "b", "Diamond insulation (vs cooltools)", "",
    "fig-insulation", "c", "Diamond insulation, chr11", "",
    "fig-di", "a", "Directionality index (vs domaincaller)", "symlog",
    "fig-di", "b", "Directionality index, chr2", "",
    "fig-compartments", "a", "Compartments (vs cooltools)", "",
    "fig-compartments", "b", "Compartments, E1 along chr1", "",
    "fig-saddle", "c", "Saddle (vs cooltools)", "",
    "fig-coverage", "a", "Coverage (vs cooltools)", "xy",
    "fig-coverage", "c", "Coverage, chr11", "",
    "fig-ps", "b", "P(s), mouse 10 kb (vs cooltools)", "xy",
    "fig-loopcalling", "b", "Loop calling (vs cooltools)", "xy",
    "fig-hicrep", "a", "Reproducibility (vs hicrep)", "",
    "fig-virtual4c", "a", "Virtual 4C, Sox2 (vs cooltools)", "xy",
    "fig-apa", "b", "Aggregate peak analysis (vs coolpuppy)", "y",
    "fig-boost", "c", "Upsampling (vs Boost-HiC)", "xy",
    "fig-pastis", "b", "3D reconstruction (vs pastis)", ""
)
# What a panel adds to the rest: a legend inside it, in the room the data leave, or its own limits
inside <- function(corner) {
    theme(
        legend.position = "inside", legend.position.inside = 0.03 + 0.94 * corner, legend.justification = corner
    )
}
extras <- list(
    `fig-compartments a` = coord_cartesian(ylim = c(0.8, 1)),
    `fig-saddle c` = inside(c(0, 1)),
    `fig-pastis b` = inside(c(0, 0.6))
)

APP <- "#2a78d6"
REF <- "#eb6834"
INK2 <- "#52514e"
DENSITY <- c("#cde2fb", "#86b6ef", "#3987e5", "#1c5cab", "#0d366b")

# chromosomix against the panel's other series, value by value at the same x
versus <- function(d) {
    reference <- setdiff(na.omit(d$series), "chromosomix")[1]
    pairs <- d |>
        filter(mark == "point") |>
        pivot_wider(id_cols = x, names_from = series, values_from = y) |>
        transmute(x = .data[[reference]], y = chromosomix) |>
        drop_na()
    bind_rows(
        mutate(pairs, mark = "point"),
        tibble(mark = "line", series = "identity", x = range(pairs), y = range(pairs)),
        tibble(mark = "text", text = sprintf("%s values Pearson r = %.4f", scales::comma(nrow(pairs)), cor(pairs$x, pairs$y)))
    ) |>
        mutate(x_axis = reference, y_axis = "chromosomix")
}

# What a panel shows here rather than on the site
reshape <- function(d, figure) {
    switch(figure,
        # The site draws Sox2's profile along the chromosome, and both tools against the exact
        # window means; here, chromosomix against the reference
        `fig-virtual4c` = versus(d),
        `fig-trackcorr` = versus(d),
        `fig-apa` = d |>
            filter(str_detect(coalesce(series, text), "every loop")) |>
            mutate(series = NA, text = str_remove(text, ", every loop"), x_axis = "every loop"),
        `fig-ps` = mutate(d, x_axis = "separation (bp)"),
        # Fewer ticks, and shorter, for a small panel
        `fig-di` = filter(d, mark != "tick" | abs(coalesce(x, y)) != 0.01),
        `fig-compartments` = d |>
            filter(mark != "tick" | text %in% c(1, 5, 10, 15, "X"), !series %in% c("E2", "E3")) |>
            mutate(x = if_else(series %in% "E1", round(x), x), series = na_if(series, "E1")),
        `fig-pastis` = mutate(d, text = str_remove(text, " chromosomes"), x_axis = "chromosomes"),
        # The saddle's corners told apart by their symbol, not their colour
        `fig-saddle` = mutate(d,
            shape = case_when(series == "AB" ~ "AB", series %in% c("AA", "BB") ~ "AA, BB"),
            series = if_else(series %in% c("AA", "BB", "AB"), NA, series)
        ),
        # cooltools' coverage less its diagonal, as chromosomix counts it; no dropped bins
        `fig-coverage` = filter(d, !series %in% "cooltools, as written"),
        `fig-insulation` = filter(d, mark != "band"),
        d
    )
}

# Two colours: chromosomix's, and its reference's
colours <- function(series) {
    c(set_names(if_else(str_detect(series, "chromosomix"), APP, REF), series), identity = INK2, rule = INK2)
}

axis <- function(which, scale, ticks) {
    position <- if (which == "x") scale_x_continuous else scale_y_continuous
    transform <- switch(scale,
        log = "log10",
        symlog = scales::transform_pseudo_log(sigma = 0.01, base = 10),
        "identity"
    )
    if (nrow(ticks) == 0) {
        return(position(transform = transform))
    }
    # Categories, as the pastis or APA panels have, kept close together
    position(transform = transform, breaks = ticks[[which]], labels = ticks$text, expand = if (scale == "linear") expansion(add = 0.6) else waiver())
}

draw <- function(d, title, log, extra = NULL) {
    d <- mutate(d, key = if_else(mark == "rule" & is.na(series), "rule", series), shape = d[["shape"]] %||% NA_character_)
    the <- \(...) filter(d, mark %in% c(...))
    # A layer only where the panel has its marks, so that legends show only what is drawn
    when <- \(data, layer) if (nrow(data) > 0) layer
    name <- \(x) if (all(is.na(x))) NULL else first(na.omit(x))

    x_scale <- case_when(log == "symlog" ~ "symlog", str_detect(log, "x") ~ "log", .default = "linear")
    y_scale <- case_when(log == "symlog" ~ "symlog", str_detect(log, "y") ~ "log", .default = "linear")
    # chromosomix's curves dashed, over the reference's they may hide behind. At most 300 points a
    # curve: the lowest and the highest of every run of points, so that no peak is lost
    lines <- the("line", "step") |>
        mutate(ours = str_detect(key, "chromosomix|identity"), run = (row_number() - 1) %/% ceiling(n() / 150), .by = key) |>
        filter(row_number() %in% c(which.min(y), which.max(y)), .by = c(key, run))
    series <- setdiff(na.omit(unique(d$series)), "identity")
    shapes <- na.omit(unique(d$shape))
    # A legend only where colours say more than chromosomix against its reference, which the caption says
    legend <- length(series) > 2 || (length(series) > 0 && !"chromosomix" %in% series)
    text <- the("text")$text
    # Thousands of points binned in hexagons, as the site's other agreement panels are
    points <- the("point")
    dense <- nrow(points) > 2000
    if (dense) text <- sprintf("%s values Pearson r = %.4f", scales::comma(nrow(points)), cor(points$x, points$y))

    p <- ggplot(d, aes(x, y)) +
        when(the("hexagon"), geom_hex(aes(fill = value), data = the("hexagon"), stat = "identity")) +
        (if (dense) geom_hex(data = points, bins = 60) else when(points, geom_point(
            aes(colour = key, shape = shape),
            data = points, size = if (nrow(points) > 200) 0.8 else 1.3, alpha = 0.7
        ))) +
        when(filter(lines, mark == "line", !ours), geom_line(aes(colour = key), data = filter(lines, mark == "line", !ours), linewidth = 0.4)) +
        when(filter(lines, mark == "step", !ours), geom_step(aes(colour = key), data = filter(lines, mark == "step", !ours), linewidth = 0.4)) +
        when(filter(lines, mark == "line", ours), geom_line(aes(colour = key), data = filter(lines, mark == "line", ours), linewidth = 0.4, linetype = "22")) +
        when(filter(lines, mark == "step", ours), geom_step(aes(colour = key), data = filter(lines, mark == "step", ours), linewidth = 0.4, linetype = "22")) +
        when(filter(the("rule"), !is.na(x)), geom_vline(aes(xintercept = x, colour = key), data = filter(the("rule"), !is.na(x)), linetype = "dashed")) +
        when(filter(the("rule"), !is.na(y)), geom_hline(aes(yintercept = y, colour = key), data = filter(the("rule"), !is.na(y)), linetype = "dashed")) +
        axis("x", x_scale, filter(the("tick"), !is.na(x))) +
        axis("y", y_scale, filter(the("tick"), !is.na(y))) +
        # Series by colour, chromosomix or its reference; the saddle's corners by symbol
        scale_colour_manual(
            values = colours(series), breaks = series, na.value = APP,
            guide = if (legend) guide_legend(ncol = 1) else "none"
        ) +
        scale_shape_manual(values = c(`AA, BB` = 16, AB = 2), na.value = 16, breaks = shapes, guide = if (length(shapes)) guide_legend(ncol = 1, override.aes = list(colour = APP)) else "none") +
        labs(x = name(d$x_axis), y = name(d$y_axis), title = str_wrap(title, 34), colour = NULL, fill = NULL, shape = NULL) +
        # Every text at 7 pt, for a page printed at its size
        theme_bw(base_size = 7) +
        theme(
            axis.text = element_text(size = 7),
            panel.grid.minor = element_blank(),
            # The title over the panel, from where its x axis starts
            plot.title = element_text(size = 7, face = "bold", margin = margin(b = 3)),
            plot.title.position = "panel",
            plot.margin = margin(2, 4, 2, 2),
            legend.position = "bottom",
            legend.key.size = unit(8, "pt"),
            legend.text = element_text(size = 7),
            legend.margin = margin(0, 0, 0, 0),
            legend.box.spacing = unit(2, "pt"),
            # Nothing drawn but what shows: no backgrounds, no empty boxes
            plot.background = element_blank(),
            panel.background = element_blank(),
            legend.background = element_blank(),
            legend.key = element_blank()
        )
    if (any(d$mark == "hexagon") || dense) {
        p <- p + scale_fill_gradientn(colours = DENSITY, transform = "log10", guide = "none")
    }
    # The count and correlation of an agreement panel, in its top-left corner, whatever its scales
    if (length(text)) {
        p <- p + annotate("text",
            x = min(d$x, na.rm = TRUE), y = max(d$y, na.rm = TRUE), label = str_replace(text, " Pearson", "\nPearson"),
            hjust = 0, vjust = 1, size = 7 / .pt, colour = INK2
        )
    }
    p + extra
}

fig <- marks |>
    nest(.by = c(figure, panel)) |>
    inner_join(panels, by = c("figure", "panel")) |>
    mutate(
        data = map2(data, figure, reshape),
        plot = pmap(list(data, title, log, map(paste(figure, panel), \(k) extras[[k]])), draw),
        order = match(paste(figure, panel), paste(panels$figure, panels$panel))
    ) |>
    arrange(order) |>
    pull(plot) |>
    wrap_plots(ncol = 4) +
    plot_annotation(
        tag_levels = "a",
        theme = theme(plot.margin = margin(4, 4, 4, 4), plot.background = element_blank())
    ) &
    theme(plot.tag = element_text(face = "bold", size = 9, hjust = 0, vjust = 1), plot.tag.position = c(0, 1))

# No clipping masks anywhere, for a PDF that edits cleanly in Illustrator: neither the layout's
# cells nor any viewport clip
unclip <- function(g) {
    if (inherits(g, "gtable")) {
        g$layout$clip <- "off"
        g$grobs <- lapply(g$grobs, unclip)
    } else if (inherits(g, "gTree")) {
        g$children[] <- lapply(g$children, unclip)
    }
    if (inherits(g$vp, "viewport")) g$vp$clip <- NA
    g
}
cairo_pdf("validation_results.pdf", width = 8.27, height = 11.69)
grid::grid.draw(unclip(patchworkGrob(fig)))
dev.off()

# The tables are only read here, and downloaded again at every run
unlink("validation_results.tsv")
